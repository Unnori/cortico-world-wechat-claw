/**
 * iLink HTTP 客户端。
 *
 * 一次调用对应一个 CGI；鉴权、公共头、超时、uint64 ID 的无损解析都在这里，
 * 上层只看解析后的对象。协议依据：官方 `@tencent-weixin/openclaw-weixin` 2.4.10
 * 的 `src/api/api.ts` 与 `docs/protocol_zh_CN.md`。
 *
 * 与官方实现的两处差别，都是为了让长轮询在桌面端更稳：
 * - 长轮询超时统一折算成空响应返回，调用方只看到「这轮没有新消息」，不必区分取消与超时；
 * - 网络出口可显式选择，绕开 Coopanion 注进环境变量的模型代理（见 `network.ts`）。
 */
import { randomBytes } from 'node:crypto';

import { asCompatFetch, type CompatFetch, type FetchInit } from './fetch.ts';

import type {
  BaseInfo,
  GetConfigResp,
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  QrStatusResp,
  SendMessageResp,
  SendTypingReq,
  WeixinMessage,
} from './types.ts';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/**
 * 客户端协议版本，按 `0x00MMNNPP` 编码（major<<16 | minor<<8 | patch）。
 * 对齐官方通道 2.4.10：132106。服务端按它校验协议形状。
 */
export const ILINK_APP_CLIENT_VERSION = 132106;
/** 官方通道的应用 ID。 */
export const ILINK_APP_ID = 'bot';
/** 单条文本上限，与官方 `textChunkLimit` 一致。 */
export const MAX_TEXT_CHARS = 4000;

const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const LONG_POLL_TIMEOUT_MS = 35_000;
/** 官方扫码状态轮询的超时。 */
export const QR_POLL_TIMEOUT_MS = 35_000;

export class ILinkError extends Error {
  readonly status?: number;
  readonly ret?: number;
  readonly errcode?: number;

  constructor(message: string, detail: { status?: number; ret?: number; errcode?: number } = {}) {
    super(message);
    this.name = 'ILinkError';
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.ret !== undefined) this.ret = detail.ret;
    if (detail.errcode !== undefined) this.errcode = detail.errcode;
  }
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 取消与超时都是长轮询的正常出口。 */
export function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** 网络层错误的分类，只用于诊断文案，不改变重试策略。 */
export function classifyFetchError(err: unknown): string {
  if (isAbort(err)) return '请求超时';
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  const code = String(cause?.code ?? '');
  const all = `${code} ${errorText(err)}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(all)) return '域名解析失败';
  if (/ECONNREFUSED/i.test(all)) return '连接被拒绝';
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(all)) return '连接超时';
  if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY/i.test(all)) return 'TLS 握手失败';
  return '网络请求失败';
}

const ensureTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value : `${value}/`;

/** `X-WECHAT-UIN`：随机 uint32 的十进制字符串再 base64。 */
function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}

/**
 * 把 uint64 消息 ID 先变成 JSON 字符串再解析。
 *
 * 19 位的 ID 直接 `JSON.parse` 会丢精度，而回复、引用都靠它对齐。这里只改对象键，
 * 字符串值里的同样字样不动。
 */
export function parseILinkJson<T>(raw: string): T {
  const QUOTED = new Set(['message_id', 'msg_id', 'svr_id']);
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '"') {
      out += raw[i++];
      continue;
    }
    const start = i;
    i += 1;
    let escaped = false;
    while (i < raw.length) {
      const ch = raw[i++];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') break;
    }
    const token = raw.slice(start, i);
    out += token;

    let cursor = i;
    while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
    if (raw[cursor] !== ':') continue;

    let key: unknown;
    try {
      key = JSON.parse(token);
    } catch {
      continue;
    }
    if (typeof key !== 'string' || !QUOTED.has(key)) continue;

    out += raw.slice(i, cursor + 1);
    cursor += 1;
    while (/\s/.test(raw[cursor] ?? '')) out += raw[cursor++];
    const numberStart = cursor;
    if (raw[cursor] === '-') cursor += 1;
    while (/\d/.test(raw[cursor] ?? '')) cursor += 1;
    const digits = cursor - numberStart;
    if (digits > 0 && !(digits === 1 && raw[numberStart] === '-')) {
      out += `"${raw.slice(numberStart, cursor)}"`;
      i = cursor;
    } else {
      i = numberStart;
    }
  }
  return JSON.parse(out) as T;
}

/** 一次请求需要的东西：地址、可选令牌、可选出口。 */
export interface ILinkRequestContext {
  baseUrl: string;
  token?: string;
  fetchImpl?: CompatFetch;
  /** undici 的 dispatcher；不传就用宿主 fetch 自己的出口。 */
  dispatcher?: unknown;
}

interface RawRequestOptions extends ILinkRequestContext {
  endpoint: string;
  method: 'GET' | 'POST';
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 是否带 Bot 鉴权头与 base_info（二维码相关请求不带）。 */
  authenticated: boolean;
  label: string;
}

/** 一次 iLink 请求的公共实现。 */
export class ILinkApi {
  readonly baseUrl: string;
  readonly token: string;
  readonly channelVersion: string;
  readonly botAgent: string;
  /** 二维码登录用的固定地址；默认官方地址，测试可指向本机假服务端。 */
  readonly loginBaseUrl: string;
  readonly #fetchImpl: CompatFetch;
  readonly #dispatcher?: unknown;

  constructor(opts: ILinkRequestContext & { channelVersion: string; botAgent: string; loginBaseUrl?: string }) {
    this.baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.loginBaseUrl = String(opts.loginBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.token = String(opts.token ?? '').trim();
    this.channelVersion = opts.channelVersion;
    this.botAgent = opts.botAgent;
    this.#fetchImpl = opts.fetchImpl ?? asCompatFetch(globalThis.fetch);
    this.#dispatcher = opts.dispatcher;
  }

  baseInfo(): BaseInfo {
    return { channel_version: this.channelVersion, bot_agent: this.botAgent };
  }

  #headers(authenticated: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    };
    if (authenticated) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = randomWechatUin();
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  async #request<T>(opts: RawRequestOptions): Promise<T> {
    const url = new URL(opts.endpoint, ensureTrailingSlash(opts.baseUrl));
    const where = `${url.host}${url.pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, opts.timeoutMs));
    const signal = opts.signal
      ? AbortSignal.any([controller.signal, opts.signal])
      : controller.signal;
    const init: FetchInit = {
      method: opts.method,
      headers: this.#headers(opts.authenticated),
      signal,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (this.#dispatcher) init.dispatcher = this.#dispatcher;

    let response: Response;
    try {
      response = await this.#fetchImpl(url.toString(), init);
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new ILinkError(`${opts.label}：${classifyFetchError(err)}（${where}）`);
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    if (!response.ok) {
      const detail = raw ? `：${raw.slice(0, 200)}` : '';
      throw new ILinkError(`${opts.label}：HTTP ${response.status}${detail}`, {
        status: response.status,
      });
    }
    if (!raw) return {} as T;
    try {
      return parseILinkJson<T>(raw);
    } catch {
      throw new ILinkError(`${opts.label}：响应不是 JSON`);
    }
  }

  /** 取登录二维码。`localTokenList` 是本地已有的 bot_token，用于识别「已绑定过」。 */
  async fetchQrCode(localTokenList: string[] = []): Promise<{ qrcode: string; qrUrl: string }> {
    const data = await this.#request<{ qrcode?: string; qrcode_img_content?: string }>({
      baseUrl: this.loginBaseUrl,
      endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3',
      method: 'POST',
      body: { local_token_list: localTokenList.slice(0, 10) },
      timeoutMs: 20_000,
      authenticated: false,
      fetchImpl: this.#fetchImpl,
      dispatcher: this.#dispatcher,
      label: '获取二维码',
    });
    const qrcode = String(data?.qrcode ?? '').trim();
    const qrUrl = String(data?.qrcode_img_content ?? '').trim();
    if (!qrcode || !qrUrl) throw new ILinkError('二维码响应缺少 qrcode 或 qrcode_img_content');
    return { qrcode, qrUrl };
  }

  /** 长轮询扫码状态。超时按 `wait` 返回，让调用方继续等。 */
  async pollQrStatus(params: {
    qrcode: string;
    verifyCode?: string;
    baseUrl?: string;
    signal?: AbortSignal;
  }): Promise<QrStatusResp> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
    if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
    try {
      return await this.#request<QrStatusResp>({
        baseUrl: params.baseUrl ?? this.loginBaseUrl,
        endpoint,
        method: 'GET',
        timeoutMs: QR_POLL_TIMEOUT_MS,
        signal: params.signal,
        authenticated: false,
        fetchImpl: this.#fetchImpl,
        dispatcher: this.#dispatcher,
        label: '扫码状态',
      });
    } catch (err) {
      if (isAbort(err)) return { status: 'wait' };
      throw err;
    }
  }

  /** 长轮询收消息。超时返回空批次。 */
  async getUpdates(params: {
    syncBuf?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<GetUpdatesResp> {
    const syncBuf = params.syncBuf ?? '';
    try {
      return await this.#request<GetUpdatesResp>({
        baseUrl: this.baseUrl,
        token: this.token,
        endpoint: 'ilink/bot/getupdates',
        method: 'POST',
        body: { get_updates_buf: syncBuf, base_info: this.baseInfo() },
        timeoutMs: params.timeoutMs ?? LONG_POLL_TIMEOUT_MS,
        signal: params.signal,
        authenticated: true,
        fetchImpl: this.#fetchImpl,
        dispatcher: this.#dispatcher,
        label: '收取消息',
      });
    } catch (err) {
      if (isAbort(err)) return { ret: 0, msgs: [], get_updates_buf: syncBuf };
      throw err;
    }
  }

  /** 发一条消息。`msg.item_list` 由调用方按类型拼。 */
  async sendMessage(msg: WeixinMessage): Promise<SendMessageResp> {
    const data = await this.#request<SendMessageResp>({
      baseUrl: this.baseUrl,
      token: this.token,
      endpoint: 'ilink/bot/sendmessage',
      method: 'POST',
      body: { msg, base_info: this.baseInfo() },
      timeoutMs: API_TIMEOUT_MS,
      authenticated: true,
      fetchImpl: this.#fetchImpl,
      dispatcher: this.#dispatcher,
      label: '发送消息',
    });
    if (data?.ret !== undefined && data.ret !== 0) {
      throw new ILinkError(`发送消息失败：ret=${data.ret}${data.errmsg ? ` ${data.errmsg}` : ''}`, {
        ret: data.ret,
      });
    }
    return data;
  }

  /** 申请媒体上传参数。 */
  async getUploadUrl(req: GetUploadUrlReq): Promise<GetUploadUrlResp> {
    return this.#request<GetUploadUrlResp>({
      baseUrl: this.baseUrl,
      token: this.token,
      endpoint: 'ilink/bot/getuploadurl',
      method: 'POST',
      body: { ...req, base_info: this.baseInfo() },
      timeoutMs: API_TIMEOUT_MS,
      authenticated: true,
      fetchImpl: this.#fetchImpl,
      dispatcher: this.#dispatcher,
      label: '申请上传地址',
    });
  }

  /** 取账号配置（含 typing ticket）。 */
  async getConfig(params: { ilinkUserId: string; contextToken?: string }): Promise<GetConfigResp> {
    return this.#request<GetConfigResp>({
      baseUrl: this.baseUrl,
      token: this.token,
      endpoint: 'ilink/bot/getconfig',
      method: 'POST',
      body: {
        ilink_user_id: params.ilinkUserId,
        context_token: params.contextToken,
        base_info: this.baseInfo(),
      },
      timeoutMs: CONFIG_TIMEOUT_MS,
      authenticated: true,
      fetchImpl: this.#fetchImpl,
      dispatcher: this.#dispatcher,
      label: '读取配置',
    });
  }

  /** 输入状态。失败只影响提示，不影响收发。 */
  async sendTyping(req: SendTypingReq): Promise<void> {
    await this.#request<unknown>({
      baseUrl: this.baseUrl,
      token: this.token,
      endpoint: 'ilink/bot/sendtyping',
      method: 'POST',
      body: { ...req, base_info: this.baseInfo() },
      timeoutMs: CONFIG_TIMEOUT_MS,
      authenticated: true,
      fetchImpl: this.#fetchImpl,
      dispatcher: this.#dispatcher,
      label: '发送输入状态',
    });
  }

  /** 通知服务端本客户端启动；失败不影响挂载。 */
  async notifyStart(): Promise<void> {
    await this.#request<unknown>({
      baseUrl: this.baseUrl,
      token: this.token,
      endpoint: 'ilink/bot/msg/notifystart',
      method: 'POST',
      body: { base_info: this.baseInfo() },
      timeoutMs: CONFIG_TIMEOUT_MS,
      authenticated: true,
      fetchImpl: this.#fetchImpl,
      dispatcher: this.#dispatcher,
      label: '上报启动',
    });
  }

  /** 通知服务端本客户端停止；失败不影响卸载。 */
  async notifyStop(): Promise<void> {
    await this.#request<unknown>({
      baseUrl: this.baseUrl,
      token: this.token,
      endpoint: 'ilink/bot/msg/notifystop',
      method: 'POST',
      body: { base_info: this.baseInfo() },
      timeoutMs: CONFIG_TIMEOUT_MS,
      authenticated: true,
      fetchImpl: this.#fetchImpl,
      dispatcher: this.#dispatcher,
      label: '上报停止',
    });
  }
}
