/**
 * 微信 ClawBot World。
 *
 * 一个 iLink 一对一通道：扫码绑定、长轮询收消息、按类型回复文字/图片/文件。
 * 入站消息走 `wechat-claw.message` 事件，媒体作为附件随事件交给模型；
 * 出站工具把本地路径上传到微信 CDN 再发出去。
 *
 * 这个通道的限制是平台给的：只能一对一，只能回复最近发消息的人，`context_token` 约 24 小时后失效。
 * 没有群聊、好友列表、朋友圈，也不能主动发起会话。
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import QRCode from 'qrcode';

import type {
  BlobInput,
  Logger,
  ToolCallContext,
  ToolDef,
  World,
  WorldHost,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';

import { ILinkApi, MAX_TEXT_CHARS, DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL, errorText } from './protocol/api.ts';
import { MediaTransfer } from './protocol/media.ts';
import { closeNetworkRoute, createNetworkRoute, type NetworkRoute } from './protocol/network.ts';
import { fileMessage, imageMessage, textMessage, videoMessage } from './protocol/outbound.ts';
import { mimeFromFilename } from './protocol/mime.ts';
import { clockText, messageTimeMs, renderInbound, shortId } from './protocol/inbound.ts';
import { UploadMediaType, TypingStatus, type WeixinMessage } from './protocol/types.ts';
import { ILinkDriver } from './driver.ts';
import { CredentialStore, type AuthRecord } from './store.ts';
import { pickChannel, splitText } from './text.ts';
import { ensureFfmpeg, installFfmpeg, installedSize, removeFfmpeg, type FfmpegResolution, type InstallProgress } from './media/ffmpeg.ts';
import { extractFrames } from './media/frames.ts';
import {
  WECHAT_CLAW_CONFIG_GROUP,
  wechatClawText,
  type WechatClawConfigSection,
} from './config.ts';

export const ID = 'wechat-claw';
export const EVENT_MESSAGE = 'wechat-claw.message';
export const EVENT_LINK = 'wechat-claw.link';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const PACKAGE_VERSION = '0.1.0';
/** 发消息时上报的观测标识，形状是 UA 的 `Name/Version`。 */
const BOT_AGENT = `Cortico/6 (Coopanion; cortico-world-wechat-claw/${PACKAGE_VERSION})`;

/** 绑定流程的界面状态。 */
interface BindingState {
  active: boolean;
  status: string;
  qrcode: string;
  qrUrl: string;
  qrDataUrl: string;
  startedAt: number;
  verifyCode: string;
  error: string;
  errorCode: string;
  refreshCount: number;
  baseUrl: string;
}

export interface WechatClawWorldOptions {
  /** `worlds.wechat-claw` 的活引用。 */
  cfg: WechatClawConfigSection;
  dataDir: string;
  timezone: string;
  /**
   * 覆盖 iLink 基址，包括二维码登录用的固定地址。
   * 生产不传；测试把它指向本机假服务端，这样测的是真实请求构造。
   */
  endpoints?: { apiBaseUrl?: string; cdnBaseUrl?: string };
}

/** 全部工具声明；`tools()` 与 `describe` 用同一份。 */
export const WECHAT_CLAW_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'wechat_send',
    tags: ['speak'],
    description:
      'Send a WeChat reply to the person whose inbound message arrived most recently. '
      + 'The channel is one-to-one and reply-only: a context token from that message must still be valid. '
      + `Text longer than ${MAX_TEXT_CHARS} characters is split into consecutive messages, so write the whole reply at once.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1, description: 'Reply text.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'wechat_send_image',
    tags: ['speak'],
    description:
      'Send a picture to the person whose inbound message arrived most recently. '
      + 'Takes an absolute local file path; the file is uploaded to the WeChat CDN and delivered as a picture. '
      + 'A path whose content is not an image is delivered as a file instead, and the receipt says so. '
      + 'Optional caption is sent as a separate text message first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute path of a local picture file.' },
        caption: { type: 'string', description: 'Optional text sent before the picture.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'wechat_send_file',
    tags: ['speak'],
    description:
      'Send a file attachment to the person whose inbound message arrived most recently. '
      + 'Takes an absolute local file path; the file is uploaded to the WeChat CDN and delivered as a downloadable file. '
      + 'Video files are delivered as videos, not as attachments. '
      + 'Optional caption is sent as a separate text message first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute path of a local file.' },
        caption: { type: 'string', description: 'Optional text sent before the file.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'wechat_status',
    tags: ['read', 'snapshot'],
    description:
      'Report the WeChat ClawBot connection: bound account, whether the long poll is connected, '
      + 'the last inbound message time, the last error and how many context tokens are held.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'wechat_events',
    tags: ['read'],
    description:
      'Read archived WeChat events by kind and time. kind accepts * as a wildcard. '
      + 'Raw payloads never include context tokens.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', description: 'Event kind or glob, for example message/private.' },
        since: { type: 'string', description: 'ISO 8601 lower bound, inclusive.' },
        until: { type: 'string', description: 'ISO 8601 upper bound, inclusive.' },
        limit: { type: 'integer', description: 'Maximum events to return, 1-100, default 30.' },
      },
    },
  },
];

const kindMatcher = (pattern: string): ((kind: string) => boolean) => {
  const value = String(pattern ?? '').trim();
  if (!value) return () => true;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${value.split('*').map(escape).join('.*')}$`, 'i');
  return (kind: string) => re.test(kind);
};

const parseIso = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

export class WechatClawWorld implements World {
  readonly id = ID;

  readonly #cfg: WechatClawConfigSection;
  readonly #dataDir: string;
  readonly #timezone: string;
  readonly #store: CredentialStore;
  readonly #apiBaseUrl: string = DEFAULT_BASE_URL;
  readonly #cdnBaseUrl: string = DEFAULT_CDN_BASE_URL;

  #host: WorldHost | null = null;
  #route: NetworkRoute | null = null;
  #api: ILinkApi | null = null;
  #media: MediaTransfer | null = null;
  #driver: ILinkDriver | null = null;
  #auth: AuthRecord | null = null;

  #started = false;
  #startedAt = '';
  #lastError = '';
  #lastUserId = '';
  #lastMessageAt = '';
  #contextCount = 0;
  #networkProblem = '';
  #ffmpeg: FfmpegResolution | null = null;
  /** ffmpeg 安装进度；null 表示没在装。 */
  #ffmpegInstall: (InstallProgress & { startedAt: number }) | null = null;
  #ffmpegInstallAbort: AbortController | null = null;
  #typingTickets = new Map<string, string>();

  #login: BindingState | null = null;
  #loginLoop: Promise<void> | null = null;
  #loginAbort: AbortController | null = null;

  constructor(opts: WechatClawWorldOptions) {
    this.#cfg = opts.cfg;
    this.#dataDir = opts.dataDir;
    this.#timezone = opts.timezone;
    this.#store = new CredentialStore(`${opts.dataDir}/${ID}`);
    this.#apiBaseUrl = opts.endpoints?.apiBaseUrl ?? DEFAULT_BASE_URL;
    this.#cdnBaseUrl = opts.endpoints?.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL;
  }

  /** 只报值；文案在 ENV_PROMPT.md 里。每轮前缀重建都会调用，所以只读内存。 */
  envPromptVars(): Record<string, string> {
    const bound = Boolean(this.#auth?.token);
    const connected = this.#driver?.connected === true;
    const who = shortId(this.#auth?.userId || this.#auth?.accountId);
    const state = this.#login?.active
      ? '绑定中'
      : !bound
        ? '未绑定'
        : connected
          ? '已连接'
          : '连接中';
    return {
      'wechat.state': state,
      'wechat.account': bound ? who : '',
      'wechat.lastMessageAt': this.#lastMessageAt
        ? clockText(Date.parse(this.#lastMessageAt), this.#timezone)
        : '',
      'wechat.lastError': this.#lastError,
    };
  }

  tools(): ToolDef[] {
    return WECHAT_CLAW_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: (args: Record<string, unknown>, ctx: ToolCallContext) =>
        this.#runTool(decl.name, args ?? {}, ctx),
    }));
  }

  async #runTool(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
    try {
      switch (name) {
        case 'wechat_send': return await this.#toolSendText(args);
        case 'wechat_send_image': return await this.#toolSendMedia(args, 'image');
        case 'wechat_send_file': return await this.#toolSendMedia(args, 'file');
        case 'wechat_status': return this.#toolStatus();
        case 'wechat_events': return this.#toolEvents(args);
        default: return `[wechat] 未知工具：${name}`;
      }
    } catch (err) {
      ctx.log?.warn?.(`微信工具失败：${name}`, { error: errorText(err) });
      throw err;
    }
  }

  /** 回复目标：最近一条入站消息的发送者，没有就用绑定账号本人。 */
  #replyTarget(): { to: string; contextToken: string } {
    if (!this.#driver || !this.#auth?.token) {
      throw new Error('微信未连接：先在「微信绑定」面板扫码，并确认本 World 已启用。');
    }
    const to = this.#lastUserId || this.#auth.userId;
    if (!to) throw new Error('还没有收到过微信消息，等对方先说话。');
    return { to, contextToken: '' };
  }

  async #requireContextToken(to: string): Promise<string> {
    const token = await this.#store.getContextToken(to);
    if (!token) {
      throw new Error('这条会话没有可用的 context_token：等对方再发一条消息后再回复。');
    }
    return token;
  }

  async #toolSendText(args: Record<string, unknown>): Promise<string> {
    const text = String(args.text ?? '').trim();
    if (!text) throw new Error('text 不能为空。');
    const { to } = this.#replyTarget();
    const contextToken = await this.#requireContextToken(to);
    const api = this.#requireApi();

    const chunks = splitText(text, MAX_TEXT_CHARS);
    for (const chunk of chunks) {
      await api.sendMessage(textMessage({ to, text: chunk, contextToken }));
    }
    this.#host?.log?.info?.('微信已发送文本', { to: shortId(to), chars: text.length, parts: chunks.length });
    const parts = chunks.length > 1 ? `，分 ${chunks.length} 条` : '';
    return `已发送到微信（${shortId(to)}）${parts}，共 ${text.length} 字。`;
  }

  /**
   * 图片与文件共用一条上传路径，只有 media_type 和消息项不同。
   *
   * 视频按 MIME 走视频通道：`wechat_send_file` 拿到一个 .mp4 时，微信里应当显示成视频而不是附件。
   * 反过来 `wechat_send_image` 拿到非图片时按文件发，不让扩展名和通道对不上。
   */
  async #toolSendMedia(args: Record<string, unknown>, requested: 'image' | 'file'): Promise<string> {
    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) throw new Error('path 不能为空。');
    if (!isAbsolute(rawPath)) throw new Error(`path 必须是绝对路径：${rawPath}`);
    const info = await stat(rawPath).catch(() => null);
    if (!info?.isFile()) throw new Error(`找不到文件：${rawPath}`);
    const maxBytes = Math.max(1, Number(this.#cfg.maxInboundMediaMb) || 20) * 1024 * 1024;
    if (info.size > maxBytes) {
      throw new Error(`文件超过上限（${Math.round(info.size / 1024 / 1024)} MB > ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
    }

    const { to } = this.#replyTarget();
    const contextToken = await this.#requireContextToken(to);
    const api = this.#requireApi();
    const media = this.#requireMedia();
    const bytes = await readFile(rawPath);

    const caption = String(args.caption ?? '').trim();
    if (caption) {
      const chunks = splitText(caption, MAX_TEXT_CHARS);
      for (const chunk of chunks) {
        await api.sendMessage(textMessage({ to, text: chunk, contextToken }));
      }
    }

    const mime = mimeFromFilename(rawPath);
    const channel = pickChannel(mime);
    const uploaded = await media.upload({
      bytes,
      toUserId: to,
      mediaType: channel === 'image'
        ? UploadMediaType.IMAGE
        : channel === 'video' ? UploadMediaType.VIDEO : UploadMediaType.FILE,
    });
    const message = channel === 'image'
      ? imageMessage({ to, uploaded, contextToken })
      : channel === 'video'
        ? videoMessage({ to, uploaded, contextToken })
        : fileMessage({ to, fileName: basename(rawPath), uploaded, contextToken });
    const response = await api.sendMessage(message);

    this.#host?.log?.info?.('微信已发送媒体', {
      to: shortId(to),
      requested,
      channel,
      bytes: uploaded.rawSize,
      mime,
    });
    const what = channel === 'image' ? '图片' : channel === 'video' ? '视频' : '文件';
    // 工具点名与实际通道不一致时说清楚，免得模型以为发了图片其实发的是附件。
    const note = requested !== channel ? `（按文件类型走的是${what}通道）` : '';
    return `已把${what}「${basename(rawPath)}」发到微信（${shortId(to)}）${note}`
      + `${response?.message_id ? `，消息 #${response.message_id}` : ''}。`;
  }

  #toolStatus(): string {
    const state = this.#publicState();
    return JSON.stringify({
      bound: state.bound,
      connected: state.connected,
      status: state.status,
      networkMode: state.networkMode,
      networkProblem: state.networkProblem,
      accountId: state.accountId,
      userId: state.userId,
      lastMessageAt: state.lastMessageAt,
      lastError: state.lastError,
      contextTokens: state.contextTokens,
      startedAt: state.startedAt,
    }, null, 2);
  }

  #toolEvents(args: Record<string, unknown>): string {
    const host = this.#host;
    if (!host?.store) throw new Error('World 未运行，读不到事件库。');
    const kind = String(args.kind ?? '').trim();
    const since = parseIso(args.since);
    const until = parseIso(args.until);
    if (typeof args.since === 'string' && args.since.trim() && !since) {
      throw new Error(`since「${args.since}」不是 ISO 8601 时间。`);
    }
    if (typeof args.until === 'string' && args.until.trim() && !until) {
      throw new Error(`until「${args.until}」不是 ISO 8601 时间。`);
    }
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 30));
    const match = kindMatcher(kind);
    const query: Record<string, unknown> = { source: ID, limit: 2000 };
    if (since) query.fromTs = since;
    if (until) query.toTs = until;
    const events = host.store
      .range(query as Parameters<WorldHost['store']['range']>[0])
      .filter((event) => event.type === EVENT_MESSAGE)
      .filter((event) => match(String(event.meta?.kind ?? '')))
      .slice(-limit)
      .map((event) => ({
        ts: event.ts,
        kind: event.meta?.kind ?? '',
        text: event.text,
      }));
    return JSON.stringify({ count: events.length, events }, null, 2);
  }

  /** 面板与状态灯共用的只读快照。 */
  #publicState() {
    const auth = this.#auth;
    const login = this.#login;
    const bound = Boolean(auth?.token);
    const connected = this.#driver?.connected === true;
    const status = login?.active
      ? 'binding'
      : bound
        ? (connected ? 'connected' : 'connecting')
        : (login?.error || this.#lastError ? 'error' : 'unbound');
    return {
      bound,
      connected,
      running: this.#driver?.running === true,
      started: this.#started,
      status,
      networkMode: this.#route?.mode ?? 'inherit',
      networkProblem: this.#networkProblem,
      accountId: auth?.accountId ?? '',
      userId: auth?.userId ?? '',
      lastMessageAt: this.#lastMessageAt,
      lastError: login?.error || this.#lastError,
      contextTokens: this.#contextCount,
      startedAt: this.#startedAt,
      qrDataUrl: login?.qrDataUrl ?? '',
      qrUrl: login?.qrUrl ?? '',
      loginStatus: login?.status ?? '',
      loginError: login?.error ?? '',
      loginErrorCode: login?.errorCode ?? '',
      verifyRequired: login?.status === 'need_verifycode',
    };
  }

  #requireApi(): ILinkApi {
    if (!this.#api) throw new Error('微信客户端未就绪：本 World 还没启用。');
    return this.#api;
  }

  #requireMedia(): MediaTransfer {
    if (!this.#media) throw new Error('微信媒体通道未就绪：本 World 还没启用。');
    return this.#media;
  }

  // ---- 绑定 ----

  #invokePanel(panel: string, method: string, args: unknown[]): unknown {
    if (panel === 'binding') {
      switch (method) {
        case 'state': return this.#publicState();
        case 'start': return this.#startBinding();
        case 'verify': return this.#submitVerify(args?.[0]);
        case 'cancel': return this.#cancelBinding();
        case 'reconnect': return this.#reconnect();
        default: throw new Error(`未知方法：${panel}.${method}`);
      }
    }
    if (panel === 'ffmpeg') {
      switch (method) {
        case 'state': return this.#ffmpegState();
        case 'install': return this.#startFfmpegInstall();
        case 'cancel': return this.#cancelFfmpegInstall();
        case 'remove': return this.#removeFfmpeg();
        default: throw new Error(`未知方法：${panel}.${method}`);
      }
    }
    throw new Error(`未知面板：${panel}`);
  }

  /** 「ffmpeg」面板的状态：装没装、能不能用、正在装到哪一步。 */
  async #ffmpegState(): Promise<Record<string, unknown>> {
    const binDir = this.#binDir();
    const [size, installed] = await Promise.all([
      installedSize(binDir).catch(() => 0),
      this.#ffmpeg ?? ensureFfmpeg({ source: this.#cfg.ffmpegSource, binDir }),
    ]);
    const effective = this.#ffmpeg ?? installed;
    return {
      /** 当前实际会用哪一份。 */
      source: this.#cfg.ffmpegSource,
      ready: Boolean(effective?.path),
      origin: effective?.origin ?? 'none',
      detail: effective?.detail ?? '',
      version: effective?.version ?? '',
      /** 面板自己装的那份占多少字节；0 表示没装。 */
      installedBytes: size,
      installed: size > 0,
      installing: this.#ffmpegInstall?.phase === 'downloading' || this.#ffmpegInstall?.phase === 'verifying',
      progress: this.#ffmpegInstall,
      /** 抽帧开关与参数，面板据此说明「装了也不抽」。 */
      framesWanted: Math.floor(Number(this.#cfg.videoFrames) ?? 0),
    };
  }

  /** 开始下载。只有操作者点按钮才会走到这里。 */
  #startFfmpegInstall(): Record<string, unknown> {
    if (this.#ffmpegInstall && (this.#ffmpegInstall.phase === 'downloading' || this.#ffmpegInstall.phase === 'verifying')) {
      return { started: false, detail: '已经在下载了' };
    }
    const controller = new AbortController();
    this.#ffmpegInstallAbort = controller;
    this.#ffmpegInstall = { phase: 'downloading', detail: '准备下载', received: 0, total: 0, percent: null, startedAt: Date.now() };

    void (async () => {
      try {
        const result = await installFfmpeg({
          binDir: this.#binDir(),
          signal: controller.signal,
          // 下载源是 GitHub，和微信域名不是一回事：Coopanion 注进环境变量的代理只服务模型端点，
          // 拿它去连 GitHub 会直接 fetch failed。这里按配置另建一条出口。
          fetchImpl: this.#downloadFetch(),
          log: {
            info: (msg: string) => this.#host?.log?.info?.(msg),
            warn: (msg: string) => this.#host?.log?.warn?.(msg),
          },
          onProgress: (progress) => {
            this.#ffmpegInstall = { ...progress, startedAt: this.#ffmpegInstall?.startedAt ?? Date.now() };
          },
        });
        // 装完立刻按当前配置重新解析，面板与抽帧都看到新状态。
        await this.#resolveFfmpeg();
        if (!result.path && this.#ffmpegInstall?.phase !== 'failed') {
          this.#ffmpegInstall = { phase: 'failed', detail: result.detail, received: 0, total: 0, percent: null, startedAt: Date.now() };
        }
      } catch (err) {
        this.#ffmpegInstall = {
          phase: 'failed', detail: errorText(err), received: 0, total: 0, percent: null, startedAt: Date.now(),
        };
      } finally {
        this.#ffmpegInstallAbort = null;
      }
    })();

    return { started: true, detail: '开始下载' };
  }

  #cancelFfmpegInstall(): Record<string, unknown> {
    const controller = this.#ffmpegInstallAbort;
    if (!controller) return { cancelled: false, detail: '没有进行中的下载' };
    controller.abort();
    this.#ffmpegInstall = { phase: 'failed', detail: '下载已取消', received: 0, total: 0, percent: null, startedAt: Date.now() };
    return { cancelled: true, detail: '已取消' };
  }

  /** 删掉面板装的那份。删完重新解析，可能回落到 PATH 里的。 */
  async #removeFfmpeg(): Promise<Record<string, unknown>> {
    if (this.#ffmpegInstall && (this.#ffmpegInstall.phase === 'downloading' || this.#ffmpegInstall.phase === 'verifying')) {
      throw new Error('正在下载，先取消再删。');
    }
    const removed = await removeFfmpeg(this.#binDir());
    this.#ffmpegInstall = null;
    await this.#resolveFfmpeg();
    return { removed, detail: removed ? '已删除' : '本来就没装' };
  }

  async #reconnect(): Promise<unknown> {
    if (!this.#auth?.token) throw new Error('还没绑定微信，先扫码。');
    this.#lastError = '';
    await this.#restartDriver();
    this.#host?.log?.info?.('微信手动重连');
    return this.#publicState();
  }

  async #startBinding(): Promise<unknown> {
    if (this.#auth?.token) return this.#publicState();
    if (this.#login?.active) return this.#publicState();
    if (!this.#started) throw new Error('World 还没启动，先在 World 总览里启用它。');

    this.#login = {
      active: true,
      status: 'requesting',
      qrcode: '',
      qrUrl: '',
      qrDataUrl: '',
      startedAt: Date.now(),
      verifyCode: '',
      error: '',
      errorCode: '',
      refreshCount: 0,
      baseUrl: DEFAULT_BASE_URL,
    };
    this.#loginAbort = new AbortController();
    this.#loginLoop = this.#runBinding().catch((err) => {
      if (!this.#login?.active) return;
      this.#failBinding('poll_failed', `扫码轮询失败：${errorText(err)}`);
      this.#host?.log?.warn?.('微信扫码轮询失败', { error: errorText(err) });
    });
    return this.#publicState();
  }

  async #runBinding(): Promise<void> {
    try {
      await this.#newQr();
    } catch (err) {
      if (!this.#login?.active) return;
      this.#failBinding('qr_failed', `生成二维码失败：${errorText(err)}`);
      return;
    }
    if (!this.#login?.active) return;
    await this.#pollBinding();
  }

  async #newQr(): Promise<void> {
    const login = this.#login;
    if (!login?.active) return;
    login.status = 'requesting';
    const api = this.#requireApi();
    const qr = await api.fetchQrCode(this.#auth?.token ? [this.#auth.token] : []);
    if (!login.active) return;
    login.status = 'rendering';
    const qrDataUrl = await QRCode.toDataURL(qr.qrUrl, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
    if (!login.active) return;
    login.qrcode = qr.qrcode;
    login.qrUrl = qr.qrUrl;
    login.qrDataUrl = qrDataUrl;
    login.status = 'wait';
    login.error = '';
    login.errorCode = '';
    login.verifyCode = '';
    login.startedAt = Date.now();
  }

  async #pollBinding(): Promise<void> {
    const login = this.#login;
    const api = this.#requireApi();
    while (login?.active) {
      // 需要验证码时停下，等操作者在面板里填。
      if (login.status === 'need_verifycode' && !login.verifyCode) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }

      let response;
      try {
        response = await api.pollQrStatus({
          qrcode: login.qrcode,
          verifyCode: login.verifyCode,
          baseUrl: login.baseUrl,
          signal: this.#loginAbort?.signal,
        });
        login.error = '';
        login.errorCode = '';
      } catch (err) {
        if (!login.active) return;
        login.error = `扫码状态暂时连不上：${errorText(err)}`;
        login.errorCode = 'poll_retry';
        if (Date.now() - login.startedAt > 5 * 60_000) {
          this.#failBinding('poll_failed', `扫码等待超时：${errorText(err)}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        continue;
      }
      if (!login.active) return;

      const status = String(response?.status ?? 'wait');
      login.status = status;

      switch (status) {
        case 'wait':
        case 'scaned':
        case 'need_verifycode':
          if (status === 'scaned') login.verifyCode = '';
          break;
        case 'scaned_but_redirect': {
          const host = String(response?.redirect_host ?? '').trim();
          if (host) login.baseUrl = `https://${host}`;
          break;
        }
        case 'expired': {
          login.refreshCount += 1;
          if (login.refreshCount > 3) {
            this.#failBinding('expired', '二维码多次失效，请重新生成。');
            return;
          }
          try {
            await this.#newQr();
          } catch (err) {
            this.#failBinding('qr_failed', `刷新二维码失败：${errorText(err)}`);
            return;
          }
          break;
        }
        case 'verify_code_blocked':
          this.#failBinding('verify_blocked', '验证码错误次数过多，请稍后再试。');
          return;
        case 'binded_redirect':
          if (response?.bot_token && response?.ilink_bot_id) {
            await this.#finishBinding(response);
            return;
          }
          this.#failBinding(
            'already_bound',
            '这个微信已经绑定了另一个客户端；先在微信里解绑，或继续使用原客户端。',
          );
          return;
        case 'confirmed':
          await this.#finishBinding(response);
          return;
        default:
          break;
      }

      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  #failBinding(code: string, message: string): void {
    const login = this.#login;
    if (!login) return;
    login.active = false;
    login.status = 'error';
    login.errorCode = code;
    login.error = message;
    login.qrDataUrl = '';
    login.qrUrl = '';
    this.#lastError = message;
    this.#loginAbort?.abort();
  }

  async #finishBinding(response: { bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string }): Promise<void> {
    const token = String(response?.bot_token ?? '').trim();
    const accountId = String(response?.ilink_bot_id ?? '').trim();
    const userId = String(response?.ilink_user_id ?? '').trim();
    if (!token || !accountId) {
      this.#failBinding('confirmed_incomplete', '微信确认了登录，但没有返回 bot_token 或 ilink_bot_id。');
      return;
    }
    const baseUrl = String(response?.baseurl ?? '').trim() || this.#login?.baseUrl || DEFAULT_BASE_URL;

    const auth: AuthRecord = {
      token,
      baseUrl,
      accountId,
      userId,
      savedAt: new Date().toISOString(),
    };
    await this.#store.saveAuth(auth);
    await this.#store.saveSyncBuf('');

    this.#auth = auth;
    this.#lastError = '';
    this.#contextCount = 0;
    if (this.#login) {
      this.#login.active = false;
      this.#login.status = 'connected';
      this.#login.error = '';
      this.#login.errorCode = '';
      this.#login.qrDataUrl = '';
      this.#login.qrUrl = '';
      this.#login.verifyCode = '';
    }
    await this.#rebuildClient();
    this.#startDriver();
    this.#host?.log?.info?.('微信绑定成功', { accountId, userId: shortId(userId) });
    await this.#pushEvent({
      type: EVENT_LINK,
      ts: nowIso(this.#timezone),
      source: ID,
      origin: 'internal',
      text: `微信已绑定（${shortId(userId || accountId)}）。`,
      meta: { kind: 'link/bound', accountId },
    });
  }

  #submitVerify(code: unknown): unknown {
    if (!this.#login?.active) throw new Error('当前没有进行中的扫码。');
    const value = String(code ?? '').trim();
    if (!/^\d{1,8}$/.test(value)) throw new Error('请填手机微信上显示的数字验证码。');
    this.#login.verifyCode = value;
    return this.#publicState();
  }

  #cancelBinding(): unknown {
    const login = this.#login;
    if (login?.active) {
      login.active = false;
      login.status = 'unbound';
      login.error = '';
      login.errorCode = '';
      login.qrDataUrl = '';
      login.qrUrl = '';
      this.#loginAbort?.abort();
    }
    return this.#publicState();
  }

  // ---- WebUI ----

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = wechatClawText(language);
    const state = this.#publicState();
    const who = shortId(state.userId || state.accountId);
    const stateText = state.status === 'connected'
      ? t.statusConnected
      : state.status === 'binding'
        ? t.statusBinding
        : state.status === 'connecting'
          ? t.statusConnecting
          : state.status === 'error'
            ? t.statusError
            : t.statusUnbound;
    return {
      label: t.label,
      lamps: [{
        label: t.lamp,
        state: state.connected ? 'online' : (state.bound ? 'loading' : (state.status === 'error' ? 'error' : 'offline')),
        hint: state.connected
          ? t.hintReady(who)
          : (state.lastError || t.hintUnbound),
      }],
      badges: [
        { label: t.badgeAccount, value: state.bound ? (who || '—') : '—', tone: state.bound ? 'on' : 'off' },
        {
          label: t.badgeLast,
          value: state.lastMessageAt ? state.lastMessageAt.slice(11, 19) : '—',
          tone: state.lastMessageAt ? 'on' : 'off',
        },
        { label: t.badgeState, value: stateText, tone: state.connected ? 'on' : 'off' },
      ],
      panels: [{
        id: 'binding',
        title: t.panelTitle,
        description: t.panelDesc,
        getMethods: ['state'],
      }, {
        id: 'ffmpeg',
        title: t.ffmpegPanelTitle,
        description: t.ffmpegPanelDesc,
        getMethods: ['state'],
      }],
      invoke: (panel, method, args) => Promise.resolve(this.#invokePanel(panel, method, args ?? [])),
      config: [WECHAT_CLAW_CONFIG_GROUP],
      promptDocs: [{
        key: `worlds.${ID}.envPrompt`,
        title: t.promptTitle,
        description: t.promptDesc,
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'wechat.state', description: '绑定与连接状态。' },
          { name: 'wechat.account', description: '绑定的微信用户。' },
          { name: 'wechat.lastMessageAt', description: '最近一条入站消息的时间。' },
          { name: 'wechat.lastError', description: '最近一次连接错误。' },
        ],
      }],
    };
  }

  // ---- 生命周期 ----

  async start(host: WorldHost): Promise<void> {
    if (this.#started) return;
    this.#host = host;
    this.#startedAt = nowIso(this.#timezone);

    this.#route = createNetworkRoute({
      mode: this.#cfg.networkMode,
      proxyUrl: this.#cfg.proxyUrl,
      forceIpv4: this.#cfg.forceIpv4,
    });
    this.#networkProblem = this.#route.problem ?? '';
    if (this.#networkProblem) host.log.warn(this.#networkProblem);

    this.#auth = await this.#store.loadAuth();
    this.#contextCount = await this.#store.countContextTokens().catch(() => 0);
    await this.#rebuildClient();

    this.#started = true;
    if (this.#auth?.token) {
      this.#startDriver();
    } else {
      host.log.info('微信尚未绑定，等待扫码');
    }

    // ffmpeg 可能要下载几十 MB，不挡住启动；解析好之前收到的视频会写明没抽帧。
    void this.#resolveFfmpeg();
  }

  /** 按配置解析 ffmpeg。**只查找，不下载**；失败只记日志，不影响收发消息。 */
  async #resolveFfmpeg(): Promise<void> {
    const log = this.#host?.log;
    try {
      this.#ffmpeg = await ensureFfmpeg({
        source: this.#cfg.ffmpegSource,
        binDir: this.#binDir(),
      });
    } catch (err) {
      this.#ffmpeg = { path: null, origin: 'none', detail: `解析 ffmpeg 失败：${errorText(err)}`, version: '' };
    }
    if (this.#ffmpeg.path) {
      log?.info?.(`视频抽帧可用（${this.#ffmpeg.detail}）`);
    } else {
      log?.info?.(`视频抽帧不可用：${this.#ffmpeg.detail}`);
    }
  }

  #binDir(): string {
    return `${this.#dataDir}/${ID}/bin`;
  }

  /**
   * 下载 ffmpeg 用的出口。
   *
   * 与微信收发分开配置：微信域名在国内直连最稳，而 ffmpeg 的源在 GitHub。
   * `ffmpegProxyUrl` 非空时走它；否则直连——不继承只给模型端点用的那条代理。
   */
  #downloadFetch(): typeof globalThis.fetch | undefined {
    const proxyUrl = String(this.#cfg.ffmpegProxyUrl ?? '').trim();
    if (!proxyUrl) {
      // 直连：用 undici 的 Agent，绕开 HTTP(S)_PROXY 环境变量。
      const route = createNetworkRoute({ mode: 'direct', forceIpv4: this.#cfg.forceIpv4 });
      return route.fetchImpl as typeof globalThis.fetch;
    }
    const route = createNetworkRoute({ mode: 'proxy', proxyUrl, forceIpv4: this.#cfg.forceIpv4 });
    return route.fetchImpl as typeof globalThis.fetch;
  }

  /** 按当前路由与凭据重建 API 与媒体通道。 */
  async #rebuildClient(): Promise<void> {
    const route = this.#route ?? createNetworkRoute({ mode: 'inherit' });
    const token = this.#auth?.token ?? '';
    this.#api = new ILinkApi({
      baseUrl: this.#auth?.baseUrl || this.#apiBaseUrl,
      token,
      loginBaseUrl: this.#apiBaseUrl,
      fetchImpl: route.fetchImpl,
      dispatcher: route.dispatcher,
      channelVersion: PACKAGE_VERSION,
      botAgent: BOT_AGENT,
    });
    this.#media = new MediaTransfer({
      api: this.#api,
      cdnBaseUrl: this.#cdnBaseUrl,
      fetchImpl: route.fetchImpl,
      dispatcher: route.dispatcher,
    });
  }

  #startDriver(): void {
    const api = this.#api;
    const auth = this.#auth;
    if (!api || !auth?.token) return;
    const previous = this.#driver;
    this.#driver = null;
    if (previous) void previous.stop();

    // 回调要认「这条消息是不是当前驱动发来的」，所以先声明再赋值。
    let driver: ILinkDriver;
    driver = new ILinkDriver({
      api,
      store: this.#store,
      log: this.#host?.log ?? nullLoggerShim(),
      onMessage: (message): Promise<void> => this.#handleInbound(driver, message),
      onStatus: (status): void => this.#handleStatus(driver, status),
    });
    this.#driver = driver;
    driver.start();

    void api.notifyStart().catch((err) => {
      this.#host?.log?.warn?.('上报启动失败（忽略）', { error: errorText(err) });
    });
  }

  async #restartDriver(): Promise<void> {
    await this.#rebuildClient();
    this.#startDriver();
  }

  #handleStatus(driver: ILinkDriver, status: { connected: boolean; expired: boolean; error: string }): void {
    if (driver !== this.#driver) return;
    if (status.connected) {
      this.#lastError = '';
      return;
    }
    if (status.expired) {
      void this.#handleExpired(driver);
      return;
    }
    this.#lastError = status.error || '连接断开';
  }

  /** 会话过期：清掉凭据，让操作者重新扫码。 */
  async #handleExpired(driver: ILinkDriver): Promise<void> {
    if (driver !== this.#driver) return;
    this.#lastError = '微信会话已过期，请重新扫码绑定。';
    this.#driver = null;
    this.#auth = null;
    this.#contextCount = 0;
    void driver.stop();
    await this.#store.clearSession().catch((err) => {
      this.#host?.log?.warn?.('清理过期会话失败', { error: errorText(err) });
    });
    await this.#pushEvent({
      type: EVENT_LINK,
      ts: nowIso(this.#timezone),
      source: ID,
      origin: 'internal',
      text: '微信会话已过期，需要重新扫码。',
      meta: { kind: 'link/expired' },
    });
  }

  async #handleInbound(driver: ILinkDriver, message: WeixinMessage): Promise<void> {
    if (driver !== this.#driver) return;
    // 自己发出去的消息不回到自己这里。
    if (Number(message?.message_type) === 2) return;
    const from = String(message?.from_user_id ?? '').trim();
    if (!from) return;
    if (this.#auth?.accountId && from === this.#auth.accountId) return;

    const contextToken = String(message?.context_token ?? '').trim();
    if (contextToken) {
      try {
        this.#contextCount = await this.#store.saveContextToken(from, contextToken);
      } catch (err) {
        this.#host?.log?.warn?.('context_token 没存下来', { error: errorText(err) });
      }
    }

    const atMs = messageTimeMs(message);
    this.#lastUserId = from;
    this.#lastMessageAt = new Date(atMs).toISOString();

    const maxBytes = Math.max(1, Number(this.#cfg.maxInboundMediaMb) || 20) * 1024 * 1024;
    const rendered = await renderInbound(message, {
      media: this.#media,
      mediaDir: `${this.#dataDir}/${ID}/inbox`,
      downloadImages: this.#cfg.receiveImages !== false,
      downloadFiles: this.#cfg.receiveFiles !== false,
      downloadVoice: this.#cfg.receiveVoices !== false,
      downloadVideo: this.#cfg.receiveVideos === true,
      maxBytes,
    });

    const blobs: BlobInput[] = [];
    const host = this.#host;
    const acceptsImages = host?.modelFacts?.accepts?.('image/png') ?? false;
    // 语音只按模型实际支持的 MIME 附；不支持音频就别把 SILK 字节塞进去。
    const acceptsAudio = host?.modelFacts?.accepts?.('audio/silk') ?? false;
    const videoNotes: string[] = [];

    for (const item of rendered.media) {
      if (item.kind === 'image') {
        if (!acceptsImages) continue;
        await this.#addBlob(blobs, item.path, item.mime, item.label);
        continue;
      }
      if (item.kind === 'voice') {
        if (!acceptsAudio) continue;
        await this.#addBlob(blobs, item.path, 'audio/silk', item.label);
        continue;
      }
      if (item.kind === 'video') {
        const note = await this.#attachFrames(blobs, item.path, acceptsImages);
        if (note) videoNotes.push(note);
      }
    }

    const prefix = `[微信 ${clockText(atMs, this.#timezone)} ${shortId(from)}]`;
    const quoteLine = rendered.quote ? `（回复 ${rendered.quote}）` : '';
    const base = rendered.text || '[空消息]';
    const body = videoNotes.length ? `${base}\n${videoNotes.join('\n')}` : base;
    await this.#pushEvent({
      type: EVENT_MESSAGE,
      ts: this.#lastMessageAt,
      source: ID,
      origin: 'external',
      text: `${prefix}${quoteLine} ${body}`,
      senderKey: from,
      blobs: blobs.length ? blobs : undefined,
      meta: {
        kind: 'message/private',
        conv: { kind: 'private', id: from },
        raw: rendered.raw,
        ...(rendered.transcript ? { transcript: rendered.transcript } : {}),
        ...(rendered.quote ? { quote: rendered.quote } : {}),
        media: rendered.media.map((item) => ({ kind: item.kind, mime: item.mime, bytes: item.bytes, label: item.label })),
      },
    }, { deliver: true, trigger: 'debounce' });

    // 输入状态是锦上添花：拿不到 ticket 就跳过。
    void this.#signalTyping(from, contextToken);
  }

  /** 把一个本地文件读成附件；读不出来就跳过，正文里已经有路径。 */
  async #addBlob(blobs: BlobInput[], path: string, mime: string, label: string): Promise<void> {
    try {
      const bytes = await readFile(path);
      blobs.push({ bytes: new Uint8Array(bytes), mime, name: basename(path), fallbackText: label });
    } catch {
      /* 附件读不出来不影响投递。 */
    }
  }

  /**
   * 抽帧并作为图片附件加入。返回一句要写进正文的说明；抽到了也返回说明，
   * 让模型知道这些图来自视频、以及时间位置。
   */
  async #attachFrames(blobs: BlobInput[], videoPath: string, acceptsImages: boolean): Promise<string> {
    const wanted = Math.floor(Number(this.#cfg.videoFrames) ?? 0);
    if (!(wanted > 0)) return '';
    if (!acceptsImages) return '[视频帧未提供：当前模型不接受图片输入]';

    const ffmpegPath = this.#ffmpeg?.path ?? null;
    if (!ffmpegPath) {
      return `[视频帧未抽取：${this.#ffmpeg?.detail || '没有可用的 ffmpeg'}]`;
    }

    const result = await extractFrames({
      ffmpegPath,
      videoPath,
      outDir: `${this.#dataDir}/${ID}/inbox/frames/${Date.now().toString(36)}`,
      count: wanted,
      maxEdge: Number(this.#cfg.videoFrameMaxEdge) || 640,
    });
    if (!result.frames.length) {
      return `[视频帧未抽取：${result.reason || 'ffmpeg 没有产出帧'}]`;
    }
    for (const [index, frame] of result.frames.entries()) {
      await this.#addBlob(blobs, frame.path, 'image/jpeg', `[视频第 ${index + 1} 帧]`);
    }
    return `[视频帧：已抽取 ${result.frames.length} 帧，按时间顺序附在本条消息里]`;
  }

  async #signalTyping(userId: string, contextToken: string): Promise<void> {
    const api = this.#api;
    if (!api) return;
    try {
      let ticket = this.#typingTickets.get(userId) ?? '';
      if (!ticket) {
        const config = await api.getConfig({ ilinkUserId: userId, contextToken });
        if (Number(config?.ret ?? 0) !== 0) return;
        ticket = String(config?.typing_ticket ?? '').trim();
        if (!ticket) return;
        this.#typingTickets.set(userId, ticket);
      }
      await api.sendTyping({ ilink_user_id: userId, typing_ticket: ticket, status: TypingStatus.TYPING });
    } catch {
      /* 输入状态失败不影响消息。 */
    }
  }

  async #pushEvent(
    event: Parameters<WorldHost['pushEvent']>[0],
    opts?: Parameters<WorldHost['pushEvent']>[1],
  ): Promise<void> {
    const host = this.#host;
    if (!host?.pushEvent) return;
    await host.pushEvent(event, opts);
  }

  async stop(): Promise<void> {
    this.#started = false;
    const login = this.#login;
    if (login?.active) login.active = false;
    this.#loginAbort?.abort();
    const loginLoop = this.#loginLoop;
    this.#loginLoop = null;
    if (loginLoop) await loginLoop.catch(() => {});

    const api = this.#api;
    if (api && this.#auth?.token) {
      await api.notifyStop().catch((err) => {
        this.#host?.log?.warn?.('上报停止失败（忽略）', { error: errorText(err) });
      });
    }

    const driver = this.#driver;
    this.#driver = null;
    if (driver) await driver.stop();

    const route = this.#route;
    this.#route = null;
    await closeNetworkRoute(route);

    this.#api = null;
    this.#media = null;
    this.#host = null;
  }
}

/** 宿主还没给 logger 时的空实现，避免启动早期取不到日志。 */
function nullLoggerShim(): Logger {
  const logger: Logger = {
    trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
    child: () => logger,
  };
  return logger;
}

