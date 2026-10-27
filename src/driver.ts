/**
 * iLink 长轮询驱动。
 *
 * 一条循环持续拉 getupdates，把每条消息交给回调；发送走独立的 sendmessage。
 * 这里只管连接：重连退避、游标推进、会话过期（errcode -14）与令牌暂停都在这一层，
 * 上层只看到「连上了 / 断了 / 过期了 / 收到一条」。
 *
 * 令牌失效（-14）后暂停一小时再试，这是官方通道的约定：短时间内重复用旧令牌请求会被拒得更久。
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

export interface DriverStatus {
  connected: boolean;
  /** 会话失效，必须重新扫码。 */
  expired: boolean;
  error: string;
  /** 令牌失效后的冷却截止时刻（毫秒）。 */
  pausedUntilMs?: number;
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
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ILinkDriver {
  readonly #api: ILinkApi;
  readonly #store: CredentialStore;
  readonly #log: Logger;
  readonly #onMessage: DriverOptions['onMessage'];
  readonly #onStatus: DriverOptions['onStatus'];
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaxMs: number;

  #pollTimeoutMs: number;
  #loop: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #wake: (() => void) | null = null;
  #stopped = true;

  connected = false;
  running = false;

  constructor(opts: DriverOptions) {
    this.#api = opts.api;
    this.#store = opts.store;
    this.#log = opts.log;
    this.#onMessage = opts.onMessage;
    this.#onStatus = opts.onStatus;
    this.#pollTimeoutMs = opts.pollTimeoutMs ?? 35_000;
    this.#reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
    this.#reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
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

        if (typeof response?.get_updates_buf === 'string' && response.get_updates_buf) {
          syncBuf = response.get_updates_buf;
          try {
            await this.#store.saveSyncBuf(syncBuf);
          } catch (err) {
            this.#log.warn('同步游标没存下来', { error: errorText(err) });
          }
        }
        const suggested = Number(response?.longpolling_timeout_ms);
        if (Number.isFinite(suggested) && suggested > 0) {
          this.#pollTimeoutMs = Math.min(Math.max(suggested, 5_000), 60_000);
        }

        backoff = this.#reconnectBaseMs;
        if (!this.connected) {
          this.connected = true;
          this.#emit({ connected: true, expired: false, error: '' });
        }

        for (const message of Array.isArray(response?.msgs) ? response.msgs : []) {
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
        this.#emit({ connected: false, expired: false, error: errorText(err) });
        this.#log.warn('轮询失败，准备重连', { error: errorText(err), backoffMs: backoff });
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
