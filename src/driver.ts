/**
 * iLink 长轮询驱动。
 *
 * 一条循环持续拉 getupdates，把每条消息交给回调；发送走独立的 sendmessage。
 * 这里只管连接：重连退避、游标推进、会话过期（errcode -14）与令牌暂停都在这一层，
 * 上层只看到「连上了 / 断了 / 过期了 / 收到一条」。
 *
 * 令牌失效（-14）后暂停一小时再试，这是官方通道的约定：短时间内重复用旧令牌请求会被拒得更久。
 *
 * ## 两条容易出事的路径
 *
 * **长轮询超时是正常路径。** 服务端 hold 住请求，到点没消息就断开；`getUpdates` 把超时
 * 折算成空批次返回。这不能算「连接成功」——否则界面一直显示已连接，而实际可能早就收不到了。
 * 所以 `connected` 只在**真正拿到响应**（哪怕空）时置真，并且每轮都刷新 `lastPollAt`。
 *
 * **游标必须能被清空。** 服务端偶尔会返回空 `get_updates_buf`（重置信号）。早先的实现用
 * `if (buf)` 判断，空串会被忽略，于是永远带着旧游标去问，服务端认为「你还在那个位置之前」，
 * 从此再也推不出新消息——现象就是「能发不能收」。这里区分「字段缺失」（保留旧游标）与
 * 「字段是空串」（真的重置）。
 */
import type { ILinkApi } from './protocol/api.ts';
import { ILinkError, errorText } from './protocol/api.ts';
import type { CredentialStore } from './store.ts';
import type { Logger } from 'cortico/core/types.ts';
import type { WeixinMessage } from './protocol/types.ts';

/** 令牌失效的错误码。 */
export const STALE_TOKEN_ERRCODE = -14;
/** 令牌失效后的暂停时长。 */
export const STALE_TOKEN_PAUSE_MS = 60 * 60 * 1000;
/** 连续这么多轮拿不到任何响应，就判定链路已死并强制重建。 */
export const DEAD_AFTER_SILENT_ROUNDS = 3;

export interface DriverStatus {
  connected: boolean;
  /** 会话失效，必须重新扫码。 */
  expired: boolean;
  error: string;
  /** 令牌失效后的冷却截止时刻（毫秒）。 */
  pausedUntilMs?: number;
  /** 最近一次真正拿到响应（含空批次）的时刻，毫秒。 */
  lastPollAtMs?: number;
}

export interface DriverOptions {
  api: ILinkApi;
  store: CredentialStore;
  log: Logger;
  onMessage: (message: WeixinMessage) => void | Promise<void>;
  onStatus: (status: DriverStatus) => void;
  pollTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /**
   * 连续多少轮「既没消息也没响应」就重建连接。
   * 0 表示不检查；默认 3 轮，约两分钟没有任何服务端响应就认为链路已死。
   */
  deadAfterSilentRounds?: number;
  /** 要求上层重建客户端（重连无望时的最后手段）。 */
  onStalled?: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ILinkDriver {
  readonly #api: ILinkApi;
  readonly #store: CredentialStore;
  readonly #log: Logger;
  readonly #onMessage: DriverOptions['onMessage'];
  readonly #onStatus: DriverOptions['onStatus'];
  readonly #onStalled?: () => void;
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaxMs: number;
  readonly #deadAfterSilentRounds: number;

  #pollTimeoutMs: number;
  #loop: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #wake: (() => void) | null = null;
  #stopped = true;

  connected = false;
  running = false;
  lastPollAtMs = 0;
  /** 连续多少轮拿不到服务端响应。 */
  silentRounds = 0;

  constructor(opts: DriverOptions) {
    this.#api = opts.api;
    this.#store = opts.store;
    this.#log = opts.log;
    this.#onMessage = opts.onMessage;
    this.#onStatus = opts.onStatus;
    this.#onStalled = opts.onStalled;
    this.#pollTimeoutMs = opts.pollTimeoutMs ?? 35_000;
    this.#reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
    this.#reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
    this.#deadAfterSilentRounds = opts.deadAfterSilentRounds ?? DEAD_AFTER_SILENT_ROUNDS;
  }

  start(): void {
    if (this.running) return;
    this.#stopped = false;
    this.running = true;
    this.#loop = this.#run().finally(() => {
      this.running = false;
      this.connected = false;
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#wake?.();
    this.#wake = null;
    this.#abort?.abort();
    const loop = this.#loop;
    this.#loop = null;
    if (loop) await loop.catch(() => {});
    this.running = false;
    this.connected = false;
  }

  async #run(): Promise<void> {
    let syncBuf = '';
    try {
      syncBuf = await this.#store.loadSyncBuf();
      if (syncBuf) this.#log.info(`从已保存的游标继续（${syncBuf.length} 字节）`);
    } catch (err) {
      this.#log.warn('读不到同步游标，从空游标开始', { error: errorText(err) });
    }

    let backoff = this.#reconnectBaseMs;
    while (!this.#stopped) {
      const controller = new AbortController();
      this.#abort = controller;
      try {
        const response = await this.#api.getUpdates({
          syncBuf,
          timeoutMs: this.#pollTimeoutMs,
          signal: controller.signal,
        });
        if (this.#stopped) return;

        const errcode = Number(response?.errcode ?? 0);
        const ret = Number(response?.ret ?? 0);
        if (errcode === STALE_TOKEN_ERRCODE || ret === STALE_TOKEN_ERRCODE) {
          this.connected = false;
          this.#emit({
            connected: false,
            expired: false,
            error: '微信令牌失效，暂停一小时后再试',
            pausedUntilMs: Date.now() + STALE_TOKEN_PAUSE_MS,
          });
          this.#log.warn('微信令牌失效，暂停一小时后重试');
          await this.#sleep(STALE_TOKEN_PAUSE_MS);
          backoff = this.#reconnectBaseMs;
          continue;
        }
        if (ret !== 0 || (errcode !== 0 && errcode !== undefined)) {
          throw new ILinkError(
            `getupdates ret=${ret}${response?.errmsg ? ` ${response.errmsg}` : ''}`,
            { ret, errcode },
          );
        }

        // 游标：区分「字段缺失」与「字段为空串」。后者是服务端要求重置，必须照做，
        // 否则会一直带着旧游标问，永远拿不到新消息。
        const buf = response?.get_updates_buf;
        if (typeof buf === 'string') {
          if (buf !== syncBuf) {
            syncBuf = buf;
            try {
              await this.#store.saveSyncBuf(syncBuf);
            } catch (err) {
              this.#log.warn('同步游标没存下来', { error: errorText(err) });
            }
          }
        }

        const suggested = Number(response?.longpolling_timeout_ms);
        if (Number.isFinite(suggested) && suggested > 0) {
          this.#pollTimeoutMs = Math.min(Math.max(suggested, 5_000), 60_000);
        }

        // 真正拿到了响应（哪怕没有消息）：链路是活的。
        backoff = this.#reconnectBaseMs;
        this.silentRounds = 0;
        this.lastPollAtMs = Date.now();
        if (!this.connected) {
          this.connected = true;
          this.#emit({ connected: true, expired: false, error: '', lastPollAtMs: this.lastPollAtMs });
        }

        const messages = Array.isArray(response?.msgs) ? response.msgs : [];
        if (messages.length) {
          this.#log.info(`收到 ${messages.length} 条微信消息`);
        }
        for (const message of messages) {
          if (this.#stopped) break;
          try {
            await this.#onMessage(message);
          } catch (err) {
            this.#log.warn('入站消息处理失败', { error: errorText(err) });
          }
        }
      } catch (err) {
        if (this.#stopped) return;
        if (err instanceof ILinkError && (err.status === 401 || err.status === 403)) {
          this.connected = false;
          this.#emit({ connected: false, expired: true, error: `HTTP ${err.status}` });
          return;
        }
        this.connected = false;
        this.silentRounds += 1;
        this.#emit({ connected: false, expired: false, error: errorText(err), lastPollAtMs: this.lastPollAtMs });
        this.#log.warn('轮询失败，准备重连', { error: errorText(err), backoffMs: backoff, silentRounds: this.silentRounds });

        // 连续多轮连不上：光靠退避重试没用了，让上层重建客户端（新的 dispatcher / 新连接）。
        if (this.#deadAfterSilentRounds > 0 && this.silentRounds >= this.#deadAfterSilentRounds) {
          this.#log.warn(`连续 ${this.silentRounds} 轮没有响应，请求重建连接`);
          this.silentRounds = 0;
          this.#onStalled?.();
          return;
        }

        await this.#sleep(backoff);
        backoff = Math.min(backoff * 2, this.#reconnectMaxMs);
      }
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
    });
  }

  #emit(status: DriverStatus): void {
    try {
      this.#onStatus(status);
    } catch (err) {
      this.#log.warn('连接状态回调失败', { error: errorText(err) });
    }
  }
}

/** 供测试与外部判断：这次失败是不是令牌失效。 */
export function isStaleToken(err: unknown): boolean {
  return err instanceof ILinkError
    && (err.errcode === STALE_TOKEN_ERRCODE || err.ret === STALE_TOKEN_ERRCODE);
}

export { sleep };
