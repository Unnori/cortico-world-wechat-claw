/**
 * 微信 ClawBot World。
 *
 * 一个 iLink 一对一通道：扫码绑定、长轮询收消息、按类型回复文字/图片/文件。
 * 入站消息走 `wechat-claw.message` 事件，媒体作为附件随事件交给模型；
 * 出站工具把本地文件或宿主音频附件上传到微信 CDN 再发出去。
 *
 * 这个通道的限制是平台给的：只能一对一，只能回复最近发消息的人，`context_token` 约 24 小时后失效。
 * 没有群聊、好友列表、朋友圈，也不能主动发起会话。
 *
 * ## 文件落在哪、能发什么
 *
 * 收来的媒体直接落进**桌宠工作区的收件目录**（`paths.ts`），不是插件自己的数据目录：
 * 那里桌宠本来就伸得进去，于是「发给我看看」之后它能读、能改、还能发回来。
 *
 * 反过来，`wechat_send_image` / `wechat_send_file` 只接受**工作区（与收件目录、配置里额外
 * 放行的目录）内**的路径。这条边界是安全设计的核心：插件自己的配置与凭据（`<dataDir>/wechat-claw/`
 * 下的 `auth.json`、`context-tokens.json`）在工作区外面，所以即使模型被说服「把它自己的令牌发出去」，
 * 也拿不到那些字节。
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import QRCode from 'qrcode';

import pkg from '../package.json' with { type: 'json' };

import type {
  BlobInput,
  EventEnvelope,
  Logger,
  RunPhase,
  ToolCallContext,
  ToolDef,
  World,
  WorldHost,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';

import { ILinkApi, ILinkError, MAX_TEXT_CHARS, DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL, errorText, isAbort } from './protocol/api.ts';
import { MediaTransfer } from './protocol/media.ts';
import { closeNetworkRoute, createNetworkRoute, type NetworkRoute } from './protocol/network.ts';
import { fileMessage, imageMessage, progressMessage, textMessage, videoMessage, voiceMessage } from './protocol/outbound.ts';
import { audioMimeAliases, mimeForInbound, mimeFromFilename, OCTET_STREAM, WECHAT_OPUS_MIME } from './protocol/mime.ts';
import { clockText, messageTimeMs, renderInbound, renderQuotedMedia, sanitizeRaw, shortId, type InboundMedia, type RenderOptions } from './protocol/inbound.ts';
import { inboundItemShape, inboundMessageShape, inboundWireType } from './protocol/inbound-shape.ts';
import { MessageItemType, MessageType, UploadMediaType, TypingStatus, type WeixinMessage } from './protocol/types.ts';
import { ILinkDriver } from './driver.ts';
import { CredentialStore, MAX_REPLIES_PER_CONTEXT, type AuthRecord, type ReplyContext } from './store.ts';
import { pickChannel, splitText } from './text.ts';
import { fitImage, overCountNote, probeImage, type ImageLimits } from './media/imagefit.ts';
import { MAX_FRAMES } from './media/layout.ts';
import { segmentDelayMs, splitSegments } from './segment.ts';
import { prepareOutboundText } from './outbound-text.ts';
import { QuoteIndex, echoedMediaKind, partialQuote, quoteIds, quoteText, referenceIds, restoreArchivedQuote, type QuoteMedia } from './quotes.ts';
import { ensureFfmpeg, installFfmpeg, installedSize, removeFfmpeg, type FfmpegResolution, type InstallProgress } from './media/ffmpeg.ts';
import { extractFrameStrip } from './media/frames.ts';
import { audioToMp3, audioToSilk } from './media/outbound-voice.ts';
import { SILK_SAMPLE_RATE } from './media/voice.ts';
import { synthesizeMp3, TTS_MAX_CHARS, ttsSecretName, validateTtsSettings } from './media/tts.ts';
import { listTtsModels, listTtsVoices } from './media/tts-catalog.ts';
import { discoverLocalTts, listLocalTtsModels, localTtsVoices, type LocalTtsService } from './media/tts-local.ts';
import {
  checkSendable,
  derivedDir,
  ensureGitIgnored,
  parseDirList,
  resolveInboxDir,
  resolveWorkspaceDir,
} from './paths.ts';
import {
  MAX_SEGMENT_THRESHOLD,
  resolveInboundTrigger,
  wechatClawConfigGroups,
  wechatClawText,
  type TtsPanelState,
  type TtsProtocol,
  type TtsSettings,
  type WechatClawConfigSection,
} from './config.ts';

export const ID = 'wechat-claw';
export const EVENT_MESSAGE = 'wechat-claw.message';
export const EVENT_LINK = 'wechat-claw.link';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** 版本号只认 package.json；这里再抄一份会漂。 */
const PACKAGE_VERSION: string = pkg.version;
/** 发消息时上报的观测标识，形状是 UA 的 `Name/Version`。 */
const BOT_AGENT = `Cortico/6 (Coopanion; cortico-world-wechat-claw/${PACKAGE_VERSION})`;

interface ReplyTarget {
  to: string;
  auth: AuthRecord;
  context: ReplyContext;
}

type Incoming = { message: WeixinMessage; receivedAtMs: number; confirmedOwner: boolean };
type PictureBatch = { driver: ILinkDriver; from: string; entries: Incoming[]; deadline: number; timer?: ReturnType<typeof setTimeout> };
type WechatRun = { auth: AuthRecord; token: string; id: string; timer?: ReturnType<typeof setTimeout>;
  opened?: Promise<boolean>; closing?: boolean; sentStart?: boolean;
  endTyping?: () => void; typingDeadline?: ReturnType<typeof setTimeout>; pendingReplies: number; replyFinished?: boolean };

const MAX_WAITING_PICTURES = 8;
const PROGRESS_DELAY_MS = 2_000;
const TYPING_REFRESH_MS = 5_000;
const TYPING_IDLE_LIMIT_MS = 120_000;
const VERIFY_REQUIRED = 'need_verifycode';

function captionKind(message: WeixinMessage): 'images' | 'text' | 'other' {
  const items = message.item_list;
  if (!Array.isArray(items) || !items.length) return 'other';
  if (items.every(item => inboundWireType(item?.type) === MessageItemType.IMAGE && item.image_item?.media && !item.ref_msg)) return 'images';
  if (items.every(item => inboundWireType(item?.type) === MessageItemType.TEXT && typeof item.text_item?.text === 'string')
    && quoteText(message).trim() && !quoteText(message).trimStart().startsWith('/')) return 'text';
  return 'other';
}

class ReplySendError extends Error {}

const CONTEXT_EXHAUSTED = '当前入站消息的回复条数配额已用尽，请等对方发来下一条消息后再回复。';
const CONTEXT_REJECTED = '服务端拒绝了本次回复，此回复凭据已停用（可能已用尽回复配额或失效），请等对方发来下一条消息后再回复。';

function isPrepareFailure(error: unknown): boolean {
  return error instanceof ILinkError && error.ret === -2 && /\bprepare\s+failed\b/i.test(error.message);
}

function canFallbackAfterSend(error: ReplySendError): boolean {
  // sendmessage may already have accepted a request whose response was lost.
  // Retrying in that case could deliver twice and consume another reply slot.
  const rejection = error.cause;
  return rejection instanceof ILinkError && !isPrepareFailure(rejection) &&
    (rejection.ret !== undefined && rejection.ret !== 0 && rejection.ret !== -14 ||
      rejection.status !== undefined && [400, 403, 415, 422].includes(rejection.status));
}

type AttachmentBlob = Extract<BlobInput, { bytes: Uint8Array }>;

interface InboundAttachment {
  kind: string;
  name: string;
  mime: string;
  bytes: number;
  delivery: 'native' | 'frames' | 'omitted';
  quoted?: true;
  attachedMimes: string[];
  notes: string[];
}

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
  /**
   * 部署根目录（`WorldContext.botDir`）。
   *
   * 收件目录要从这里推：`WorldContext` 不给 `memoryDir`，工作区只能按
   * `config.json` 的 `paths.memory` 与目录存在性还原（见 `paths.ts`）。
   */
  botDir: string;
  dataDir: string;
  timezone: string;
  /**
   * 覆盖 iLink 基址，包括二维码登录用的固定地址。
   * 生产不传；测试把它指向本机假服务端，这样测的是真实请求构造。
   */
  endpoints?: { apiBaseUrl?: string; cdnBaseUrl?: string };
  ttsApiKey?: (name: string) => string;
  storeTtsApiKey?: (name: string, value: string) => void;
  persistTtsSettings?: (settings: TtsSettings) => void;
}

function ttsPanelService(protocol: unknown, address: unknown, defaults?: TtsSettings): { protocol: TtsProtocol; baseUrl: string } {
  const selected = protocol ?? defaults?.ttsProtocol ?? 'openai';
  if (selected !== 'openai' && selected !== 'gpt-sovits') throw new Error('TTS 服务类型无效。');
  const baseUrl = address ?? defaults?.ttsBaseUrl ?? '';
  if (typeof baseUrl !== 'string') throw new Error('TTS 服务地址无效。');
  return { protocol: selected, baseUrl: baseUrl.trim() };
}

/** 全部工具声明；`tools()` 与 `describe` 用同一份。 */
export const WECHAT_CLAW_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'wechat_send',
    tags: ['speak'],
    description: `Reply to the bound WeChat user. Send the full reply in one call; text over ${MAX_TEXT_CHARS} characters is split automatically.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1 },
      },
      required: ['text'],
    },
  },
  {
    name: 'wechat_send_image',
    tags: ['speak'],
    description: 'Reply with a local image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute image path in an allowed directory.' },
        caption: { type: 'string', description: 'Separate text sent before the image.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'wechat_send_file',
    tags: ['speak'],
    description: 'Reply with a local file. Videos and images use their native media types.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Absolute file path in an allowed directory.' },
        caption: { type: 'string', description: 'Separate text sent before the file.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'wechat_send_voice',
    tags: ['speak'],
    description: 'Reply with audio from a local path or a host blob. Sends MP3 by default.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', minLength: 1, description: 'Absolute WAV, MP3 or SILK v3 path in the workspace or inbox.' },
        blob: { type: 'string', minLength: 1, description: 'Audio log:/mem: handle or its [blob ...] receipt line.' },
        fallback_text: { type: 'string', maxLength: TTS_MAX_CHARS, description: 'Text to send on audio failure. Defaults to a failure notice.' },
      },
      oneOf: [{ required: ['path'] }, { required: ['blob'] }],
    },
  },
  {
    name: 'wechat_speak',
    tags: ['speak'],
    description: 'With TTS enabled, reply with synthesized speech. Falls back to the original text on audio failure.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', minLength: 1, maxLength: TTS_MAX_CHARS } },
      required: ['text'],
    },
  },
  {
    name: 'wechat_status',
    tags: ['read', 'snapshot'],
    description: 'Check WeChat connection, allowed send paths, active Provider input support and recent attachment results.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        mimes: { type: 'array', maxItems: 128, items: { type: 'string', minLength: 1 }, description: 'Exact MIME types to check, e.g. audio/wav or application/pdf.' },
      },
    },
  },
  {
    name: 'wechat_events',
    tags: ['read'],
    description: 'Read archived WeChat messages.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', description: 'Event kind or * glob, e.g. message/private.' },
        since: { type: 'string', description: 'Inclusive ISO 8601 start.' },
        until: { type: 'string', description: 'Inclusive ISO 8601 end.' },
        limit: { type: 'integer', description: 'Up to 100 messages, default 30.' },
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

function voiceBlobHandle(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const line = /^\[blob[ \t]+([^\]\r\n]+)\]/.exec(text);
  // Core appends MIME and an optional filename inside the brackets.
  const handle = line
    ? line[1]!.split(/[ \t]+(?=(?:audio|application|image|video|text)\/[\w.+-]+(?:[ \t]|$))/, 1)[0]!.trim()
    : text;
  if (!/^(?:log|mem):[^\u0000-\u001f\u007f]+$/.test(handle)) {
    throw new Error('blob 须为 log:、mem: 音频句柄，或工具回执里的 [blob …] 行。');
  }
  return handle;
}

export class WechatClawWorld implements World {
  readonly id = ID;

  readonly #cfg: WechatClawConfigSection;
  readonly #botDir: string;
  readonly #dataDir: string;
  readonly #timezone: string;
  /** 桌宠工作区；收件目录与「能发什么」都相对它。 */
  readonly #workspaceDir: string;
  /** 收件目录；在建实例时解析一次，改配置要重启。 */
  readonly #inboxDir: string;
  readonly #store: CredentialStore;
  readonly #quotes: QuoteIndex;
  readonly #apiBaseUrl: string = DEFAULT_BASE_URL;
  readonly #cdnBaseUrl: string = DEFAULT_CDN_BASE_URL;
  readonly #readTtsApiKey: (name: string) => string;
  readonly #storeTtsApiKey?: (name: string, value: string) => void;
  readonly #persistTtsSettings?: (settings: TtsSettings) => void;

  #ttsDiscovery?: Promise<LocalTtsService[]>;
  #host: WorldHost | null = null;
  #route: NetworkRoute | null = null;
  #api: ILinkApi | null = null;
  #media: MediaTransfer | null = null;
  #driver: ILinkDriver | null = null;
  #driverChanges = Promise.resolve();
  #auth: AuthRecord | null = null;

  #started = false;
  #startedAt = '';
  #lastError = '';
  #lastMessageAt = '';
  #contextCount = 0;
  #outbound = Promise.resolve();
  #inboundDispatch = Promise.resolve();
  #pictureBatch: PictureBatch | null = null;
  #wechatRunSources = new Map<string, { auth: AuthRecord; token: string }>();
  #wechatRun: WechatRun | null = null;
  #runState: RunPhase['state'] | undefined;
  /** 停止或解绑时，用它提前结束节奏等待。 */
  #sleepWake: (() => void) | null = null;
  #lastInboundTiming: { receivedAt: string; receiveDelayMs: number; queueMs: number; processingMs: number } | null = null;
  #lastInboundAttachments: InboundAttachment[] = [];
  #networkProblem = '';
  #ffmpeg: FfmpegResolution | null = null;
  /** ffmpeg 安装进度；null 表示没在装。 */
  #ffmpegInstall: (InstallProgress & { startedAt: number }) | null = null;
  #ffmpegInstallAbort: AbortController | null = null;
  /** 输入状态与正文分开排队，避免旧请求覆盖新一段的提示。 */
  #typingQueue = Promise.resolve();
  #typingTicket: { api: ILinkApi; to: string; contextToken: string; value: string } | null = null;

  #login: BindingState | null = null;
  #loginLoop: Promise<void> | null = null;
  #loginAbort: AbortController | null = null;

  constructor(opts: WechatClawWorldOptions) {
    this.#cfg = opts.cfg;
    this.#botDir = opts.botDir;
    this.#dataDir = opts.dataDir;
    this.#timezone = opts.timezone;
    // 解析一次就够：收件目录由配置与目录结构决定，改配置要重启（`inboxDir` 的 x-hot=false）。
    this.#workspaceDir = resolveWorkspaceDir(opts.botDir);
    this.#inboxDir = resolveInboxDir({
      workspaceDir: this.#workspaceDir,
      configured: opts.cfg.inboxDir,
    });
    this.#store = new CredentialStore(`${opts.dataDir}/${ID}`);
    this.#quotes = new QuoteIndex(this.#store.dir);
    this.#apiBaseUrl = opts.endpoints?.apiBaseUrl ?? DEFAULT_BASE_URL;
    this.#cdnBaseUrl = opts.endpoints?.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL;
    this.#readTtsApiKey = opts.ttsApiKey ?? (() => '');
    this.#storeTtsApiKey = opts.storeTtsApiKey;
    this.#persistTtsSettings = opts.persistTtsSettings;
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
      'wechat.inbox': this.#inboxDir,
      'wechat.workspace': this.#workspaceDir,
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
        case 'wechat_send': return await this.#queueReply(ctx, () => this.#toolSendText(args, ctx.signal));
        case 'wechat_send_image': return await this.#queueReply(ctx, () => this.#toolSendMedia(args, 'image'));
        case 'wechat_send_file': return await this.#queueReply(ctx, () => this.#toolSendMedia(args, 'file'));
        case 'wechat_send_voice': return await this.#queueReply(ctx, () => this.#toolSendVoice(args, ctx.signal));
        case 'wechat_speak': return await this.#queueReply(ctx, () => this.#toolSpeak(args, ctx.signal));
        case 'wechat_status': return this.#toolStatus(args);
        case 'wechat_events': return this.#toolEvents(args);
        default: return `[wechat] 未知工具：${name}`;
      }
    } catch (err) {
      ctx.log?.warn?.(`微信工具失败：${name}`, { error: errorText(err) });
      throw err;
    }
  }

  #queueReply(ctx: ToolCallContext, send: () => Promise<string>): Promise<string> {
    const scope = this.#wechatRun;
    if (scope) scope.pendingReplies += 1;
    return this.#queueSend(ctx, send).finally(() => {
      if (!scope || --scope.pendingReplies > 0) return;
      scope.replyFinished = true;
      this.#stopRunTyping(scope);
    });
  }

  /** 全部发送工具串行使用回复凭据，容量检查与发件不会被另一调用打断。 */
  #queueSend<T>(ctx: Pick<ToolCallContext, 'signal'>, send: () => Promise<T>): Promise<T> {
    const auth = this.#auth;
    const outbound = this.#outbound.then(() => {
      ctx.signal?.throwIfAborted();
      if (auth !== this.#auth) throw new Error('微信绑定已变更，请在收到新消息后再回复。');
      return send();
    });
    this.#outbound = outbound.then(() => {}, () => {});
    return outbound;
  }

  /**
   * 回复目标：**永远是绑定的微信本人**。
   *
   * 不用「最近一条消息的发送者」当目标——那样任何人只要能让一条消息进入收件流
   * （群聊成员、服务通知、陌生人），回复目标就会被改写成对方，文件和文字都会发错人。
   * 这个插件只服务一对一私聊，所以收件人钉死在绑定记录里。
   */
  async #replyTarget(): Promise<ReplyTarget> {
    const auth = this.#auth;
    if (!this.#started || !this.#driver || !auth?.token) {
      throw new Error('微信未连接：先在「微信绑定」面板扫码，并确认本 World 已启用。');
    }
    const to = auth.userId.trim();
    if (!to) {
      throw new Error('绑定记录里没有微信用户 ID，无法确定收件人。请在「微信绑定」面板解绑后重新扫码。');
    }
    const context = await this.#store.getReplyContext(to);
    if (!context) {
      throw new Error('这条会话没有可用的 context_token：等对方再发一条消息后再回复。');
    }
    if (context.rejected) throw new Error(CONTEXT_REJECTED);
    if (context.sent >= MAX_REPLIES_PER_CONTEXT) throw new Error(CONTEXT_EXHAUSTED);
    return { to, auth, context };
  }

  #ensureReplyCapacity(needed: number, remaining: number): void {
    if (needed <= remaining) return;
    throw new Error(`本次发送需要 ${needed} 条，当前入站消息只剩 ${remaining} 条回复额度。本次未发送，请缩短内容或等对方发来下一条消息。`);
  }

  async #recordReply(target: ReplyTarget, outcome: 'sent' | 'rejected'): Promise<void> {
    try {
      await this.#store.recordReply(target.to, target.context, outcome);
    } catch (err) {
      this.#host?.log?.warn?.('微信回复凭据状态未保存', { error: errorText(err) });
    }
    if (target.auth === this.#auth) this.#contextCount = await this.#store.countContextTokens();
  }

  #assertReplyActive(target: ReplyTarget): void {
    if (!this.#started || target.auth !== this.#auth || !this.#driver) {
      throw new Error('微信连接已停止或绑定已变更。');
    }
  }

  async #sendReply(target: ReplyTarget, message: WeixinMessage, sent: number, total: number, quoteMedia: QuoteMedia[] = []) {
    try {
      this.#assertReplyActive(target);
      const scope = this.#wechatRun;
      const runId = scope?.sentStart && scope.auth === target.auth && scope.token === target.context.token ? scope.id : undefined;
      const response = await this.#requireApi().sendMessage(runId ? { ...message, run_id: runId } : message);
      await this.#recordReply(target, 'sent');
      await this.#rememberQuote(target.auth, target.to, { ...message, message_id: response?.message_id }, quoteMedia);
      return response;
    } catch (err) {
      let reason = errorText(err);
      if (isPrepareFailure(err)) {
        await this.#recordReply(target, 'rejected');
        reason += `。${CONTEXT_REJECTED}`;
      }
      throw new ReplySendError(`微信回复已发 ${sent}/${total} 条。${reason}`, { cause: err });
    }
  }

  /**
   * 发一条文本。
   *
   * 分两层：先按语义拆（换行 / 句号 / 情绪标点），再对仍超长的段交给 `splitText` 硬切。
   * 逐条真发，条间按配置等待；累计等待到上限就把剩下的连着发完，并在回执里说明。
   * 全部发完才返回——回执报「已发送」时不骗人。
   */
  async #toolSendText(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const { text, boundaries } = prepareOutboundText(String(args.text ?? '').trim());
    if (!text) throw new Error('text 不能为空。');
    const target = await this.#replyTarget();
    const { to } = target;
    const contextToken = target.context.token;
    const remaining = MAX_REPLIES_PER_CONTEXT - target.context.sent;

    const { chunks, segmentationCancelled, waits } = this.#planChunks(text, boundaries, remaining);
    this.#ensureReplyCapacity(chunks.length, remaining);

    let sleptMs = 0;
    const maxTotalMs = Math.max(0, Number(this.#cfg.segmentMaxTotalSec) || 0) * 1000;
    let budgetCut = false;

    for (let i = 0; i < chunks.length; i += 1) {
      const waitMs = waits[i] ?? 0;
      if (waitMs > 0 && maxTotalMs > 0 && sleptMs + waitMs > maxTotalMs) {
        budgetCut = true;
      } else if (waitMs > 0 && !budgetCut) {
        await this.#waitBeforeReply(target, waitMs, signal);
        sleptMs += waitMs;
      }
      signal?.throwIfAborted();
      await this.#sendReply(target, textMessage({ to, text: chunks[i]!, contextToken }), i, chunks.length);
    }

    this.#host?.log?.info?.('微信已发送文本', {
      to: shortId(to),
      chars: text.length,
      parts: chunks.length,
      segmentationCancelled,
      sleptMs,
      budgetCut,
    });

    const bits: string[] = [];
    if (chunks.length > 1) bits.push(`分 ${chunks.length} 条`);
    if (segmentationCancelled) bits.push('受分段阈值或剩余回复额度限制，已取消语义分段并发送完整内容');
    if (budgetCut) bits.push('等待到上限，其余连着发完');
    if (sleptMs > 0) bits.push(`共等待 ${(sleptMs / 1000).toFixed(1)} 秒`);
    const suffix = bits.length ? `，${bits.join('，')}` : '';
    return `已发送到微信（${shortId(to)}）${suffix}，共 ${text.length} 字。`;
  }

  /**
   * 把一次回复规划成要发的内容。
   *
   * - 语义分段（`splitSegments`）
   * - 每段仍超 4000 字时交给 `splitText` 再切，保证发得出去
   * - 语义段数达到阈值时恢复原文，仅按微信字数上限分条
   * - 给出每段发送前该等多久（毫秒）
   *
   * 分段关闭时退化成原来的行为：只按长度切、不等。
   */
  #planChunks(text: string, boundaries: string, remaining: number): { chunks: string[]; waits: number[]; segmentationCancelled: boolean } {
    const enabled = this.#cfg.segmentEnabled !== false;
    if (enabled) {
      const parts = splitSegments(text, boundaries);
      const configured = Math.floor(Number(this.#cfg.segmentMaxParts));
      const threshold = configured > 0 ? Math.min(configured, MAX_SEGMENT_THRESHOLD) : MAX_SEGMENT_THRESHOLD;
      if (parts.length < threshold) {
        const planned = (parts.length ? parts : [text]).flatMap((part) => {
          const waitMs = segmentDelayMs(part, this.#cfg.segmentPace);
          return splitText(part, MAX_TEXT_CHARS, true).map((text) => ({ text, waitMs }));
        });
        if (planned.length === 1 || planned.length < remaining) {
          return { chunks: planned.map(p => p.text), waits: planned.map(p => p.waitMs), segmentationCancelled: false };
        }
      }
    }
    return { chunks: this.#splitToFit(text, remaining), waits: [], segmentationCancelled: enabled };
  }

  #splitToFit(text: string, remaining: number): string[] {
    const chunks = splitText(text, MAX_TEXT_CHARS, true);
    return chunks.length <= remaining ? chunks : splitText(text, MAX_TEXT_CHARS, true, false);
  }

  /** 只在这段节奏等待里开启提示；提前唤醒也会同时关闭。 */
  #waitBeforeReply(target: ReplyTarget, ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.#assertReplyActive(target);
    // Core 轮次已有统一提示。主动调用发送工具时仍保留分段等待提示。
    const endTyping = this.#wechatRun?.auth === target.auth ? undefined : this.#startTyping(target.to, target.context.token);
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        this.#sleepWake = null;
        endTyping?.();
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.#sleepWake = finish;
      signal?.addEventListener('abort', finish, { once: true });
    });
  }


  /**
   * 图片与文件共用一条上传路径，只有 media_type 和消息项不同。
   *
   * 视频按 MIME 走视频通道：`wechat_send_file` 拿到一个 .mp4 时，微信里应当显示成视频而不是附件。
   * 反过来 `wechat_send_image` 拿到非图片时按文件发，不让扩展名和通道对不上。
   *
   * **出去之前先过边界**：只有工作区（与收件目录、配置里额外放行的目录）里的文件能发。
   * 检查返回的是规范化后的真实路径，后面 `stat`/`readFile` 都用它——检查的和读的是同一个对象。
   */
  async #toolSendMedia(args: Record<string, unknown>, requested: 'image' | 'file'): Promise<string> {
    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) throw new Error('path 不能为空。');
    if (!isAbsolute(rawPath)) throw new Error(`path 必须是绝对路径：${rawPath}`);

    const roots = this.#sendRoots();
    const checked = checkSendable(rawPath, roots);
    if (!checked.ok) {
      if (checked.reason === 'missing') throw new Error(`找不到文件：${rawPath}`);
      throw new Error(
        `这个路径不在允许发送的范围里：${rawPath}\n`
        + '能发出去的只有这些目录里的文件：\n'
        + roots.map((root) => `- ${root}`).join('\n')
        + `\n\n收来的文件都在 ${this.#inboxDir} 里；要发别处的文件，先把它复制进工作区。`,
      );
    }
    const filePath = checked.path;
    const target = await this.#replyTarget();

    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new Error(`找不到文件：${rawPath}`);
    const maxBytes = this.#mediaByteLimit();
    if (info.size > maxBytes) {
      throw new Error(`文件超过上限（${Math.round(info.size / 1024 / 1024)} MB > ${Math.round(maxBytes / 1024 / 1024)} MB）。`);
    }

    const { to } = target;
    const contextToken = target.context.token;
    const caption = String(args.caption ?? '').trim();
    const remaining = MAX_REPLIES_PER_CONTEXT - target.context.sent;
    const chunks = caption ? this.#splitToFit(caption, remaining - 1) : [];
    const total = chunks.length + 1;
    this.#ensureReplyCapacity(total, remaining);
    const bytes = await readFile(filePath);
    this.#assertReplyActive(target);
    const media = this.#requireMedia();

    const mime = mimeFromFilename(filePath);
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
        : fileMessage({ to, fileName: basename(filePath), uploaded, contextToken });
    for (const [i, chunk] of chunks.entries()) {
      await this.#sendReply(target, textMessage({ to, text: chunk, contextToken }), i, total);
    }
    const response = await this.#sendReply(target, message, chunks.length, total, [{
      path: filePath, mime, bytes: bytes.length, kind: echoedMediaKind(message), label: basename(filePath), mtimeMs: info.mtimeMs,
    }]);

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
    return `已把${what}「${basename(filePath)}」发到微信（${shortId(to)}）${note}`
      + `${response?.message_id ? `，消息 #${response.message_id}` : ''}。`;
  }

  /**
   * 允许发到微信的目录：工作区、收件目录，加上配置里额外放行的。
   *
   * 每次都现算：`sendExtraDirs` 是热生效的，改完不必重启。
   */
  #sendRoots(): string[] {
    const roots = [this.#workspaceDir, this.#inboxDir];
    for (const dir of parseDirList(this.#cfg.sendExtraDirs, this.#botDir)) roots.push(dir);
    return [...new Set(roots.filter(Boolean))];
  }

  #toolStatus(args: Record<string, unknown>): string {
    const state = this.#publicState();
    if (args.mimes !== undefined && (!Array.isArray(args.mimes) || args.mimes.length > 128
      || args.mimes.some((mime) => typeof mime !== 'string' || !mime.trim()))) {
      throw new Error('mimes 必须是最多 128 项的 MIME 字符串数组。');
    }
    const mimes = [...new Set((args.mimes as string[] | undefined) ?? [
      'image/png', 'image/jpeg', 'audio/mpeg', 'audio/wav', 'audio/silk', 'video/mp4', 'application/pdf', 'text/plain',
      ...this.#lastInboundAttachments.map((item) => item.mime),
    ])];
    let model = '';
    let modelError: string | undefined;
    try { model = this.#host?.modelFacts.model() ?? ''; }
    catch (err) { modelError = errorText(err); }
    return JSON.stringify({
      bound: state.bound,
      connected: state.connected,
      status: state.status,
      networkMode: state.networkMode,
      networkProblem: state.networkProblem,
      accountId: state.accountId,
      userId: state.userId,
      lastMessageAt: state.lastMessageAt,
      lastInboundTiming: this.#lastInboundTiming,
      lastInboundAttachments: this.#lastInboundAttachments,
      inputSupport: {
        model,
        ...(modelError ? { error: modelError } : {}),
        mimes: Object.fromEntries(mimes.map((mime) => [mime, this.#mimeSupport(mime)])),
        receive: { images: this.#cfg.receiveImages !== false, files: this.#cfg.receiveFiles !== false,
          videos: this.#cfg.receiveVideos === true, voices: this.#cfg.receiveVoices !== false },
      },
      lastError: state.lastError,
      contextTokens: state.contextTokens,
      startedAt: state.startedAt,
      workspace: this.#workspaceDir,
      inbox: this.#inboxDir,
      sendRoots: this.#sendRoots(),
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
      /**
       * 面板显示用的本地时间。`lastMessageAt` 是 UTC ISO，直接截字符串会让操作者
       * 看到 UTC 钟点（比如北京时间 05:11 显示成 21:11），所以这里按部署时区格式化。
       */
      lastMessageLocal: this.#lastMessageAt
        ? `${this.#localStamp(Date.parse(this.#lastMessageAt))}`
        : '',
      lastError: login?.error || this.#lastError,
      contextTokens: this.#contextCount,
      startedAt: this.#startedAt,
      qrDataUrl: login?.qrDataUrl ?? '',
      qrUrl: login?.qrUrl ?? '',
      loginStatus: login?.status ?? '',
      loginError: login?.error ?? '',
      loginErrorCode: login?.errorCode ?? '',
      verifyRequired: login?.status.includes(VERIFY_REQUIRED) === true,
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

  #mediaByteLimit(): number {
    return Math.max(1, Number(this.#cfg.maxInboundMediaMb) || 20) * 1024 * 1024;
  }

  async #toolSendVoice(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if ((args.path === undefined) === (args.blob === undefined)) throw new Error('请只提供 path 或 blob 其中一项。');
    const fallback = String(args.fallback_text ?? '').trim() || '这段音频未能发出。';
    if (fallback.length > TTS_MAX_CHARS) throw new Error(`fallback_text 不能超过 ${TTS_MAX_CHARS} 字。`);
    if (args.blob !== undefined) {
      const handle = voiceBlobHandle(args.blob);
      const target = await this.#replyTarget();
      signal?.throwIfAborted();
      const blob = this.#host?.blob(handle);
      if (!blob) throw new Error('找不到该音频附件。请使用仍可用的 log: 或 mem: 句柄。');
      if (blob.bytes.byteLength > this.#mediaByteLimit()) throw new Error('音频附件超过单条媒体大小上限。');
      // Core may store audio formats without a known log extension as .bin.
      const mime = blob.mime === 'application/octet-stream' ? mimeForInbound(blob.bytes) : blob.mime;
      if (!mime.startsWith('audio/')) throw new Error('该附件不是音频。');
      const input = Buffer.from(blob.bytes.buffer, blob.bytes.byteOffset, blob.bytes.byteLength);
      return this.#withAudioFallback(target, fallback, signal, () => this.#sendVoice(input, '语音回复.mp3', target, signal));
    }

    const rawPath = String(args.path ?? '').trim();
    if (!isAbsolute(rawPath)) throw new Error('path 必须是工作区或微信收件目录内的绝对路径。');
    const checked = checkSendable(rawPath, [this.#workspaceDir, this.#inboxDir]);
    if (!checked.ok) {
      throw new Error(checked.reason === 'missing' ? '找不到音频文件。' : '音频文件不在工作区或微信收件目录内。');
    }
    const target = await this.#replyTarget();
    return this.#withAudioFallback(target, fallback, signal, () => this.#sendVoiceFile(checked.path, target, signal));
  }

  async #sendVoiceFile(path: string, target: ReplyTarget, signal?: AbortSignal): Promise<string> {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('音频路径须指向文件。');
    if (info.size > this.#mediaByteLimit()) throw new Error('音频文件超过单条媒体大小上限。');
    const input = await readFile(path, { signal });
    return this.#sendVoice(input, basename(path, extname(path)) + '.mp3', target, signal);
  }

  async #sendVoice(input: Buffer, fileName: string, target: ReplyTarget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    this.#assertReplyActive(target);
    const maxBytes = this.#mediaByteLimit();
    const { to, context: { token: contextToken } } = target;
    let filePrefix = '已发送';
    if (this.#cfg.nativeVoiceEnabled === true) {
      try {
        const { bytes, durationMs } = await audioToSilk(input, maxBytes, signal);
        signal?.throwIfAborted();
        this.#assertReplyActive(target);
        const uploaded = await this.#requireMedia().upload({ bytes, toUserId: to, mediaType: UploadMediaType.VOICE });
        signal?.throwIfAborted();
        await this.#sendReply(target, voiceMessage({
          to, contextToken, uploaded, sampleRate: SILK_SAMPLE_RATE, durationMs,
        }), 0, 1);
        return `微信接口已接收发给 ${shortId(to)} 的原生语音（${durationMs / 1000} 秒）。`;
      } catch (error) {
        if (error instanceof ReplySendError && !canFallbackAfterSend(error)) throw error;
        signal?.throwIfAborted();
        this.#assertReplyActive(target);
        this.#host?.log?.warn?.('微信语音改用 MP3 文件发送');
        filePrefix = '原生语音失败，已改发';
      }
    }

    const bytes = await audioToMp3(input, maxBytes, signal);
    signal?.throwIfAborted();
    this.#assertReplyActive(target);
    const uploaded = await this.#requireMedia().upload({ bytes, toUserId: to, mediaType: UploadMediaType.FILE });
    signal?.throwIfAborted();
    await this.#sendReply(target, fileMessage({ to, fileName, uploaded, contextToken }), 0, 1);
    return `${filePrefix} MP3 音频文件「${fileName}」到微信（${shortId(to)}）。`;
  }

  async #withAudioFallback(
    target: ReplyTarget,
    fallbackText: string,
    signal: AbortSignal | undefined,
    sendAudio: () => Promise<string>,
  ): Promise<string> {
    try {
      return await sendAudio();
    } catch (error) {
      if (error instanceof ReplySendError && !canFallbackAfterSend(error)) throw error;
      signal?.throwIfAborted();
      this.#assertReplyActive(target);
      const remaining = MAX_REPLIES_PER_CONTEXT - target.context.sent;
      const { text } = prepareOutboundText(fallbackText);
      const chunks = this.#splitToFit(text, remaining);
      const truncated = chunks.length > remaining;
      if (truncated) {
        chunks.length = remaining;
        chunks[remaining - 1] = splitText(chunks[remaining - 1]!, MAX_TEXT_CHARS - 1, true, false)[0]! + '…';
      }
      for (const [index, chunk] of chunks.entries()) {
        signal?.throwIfAborted();
        await this.#sendReply(target, textMessage({ to: target.to, contextToken: target.context.token, text: chunk }), index, chunks.length);
      }
      this.#host?.log?.warn?.('微信音频失败后已补发文字', { parts: chunks.length, truncated });
      const detail = truncated ? '（剩余额度有限，已截短）' : '';
      return `音频未能发送，已向微信（${shortId(target.to)}）补发文字${detail}。`;
    }
  }

  async #toolSpeak(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (this.#cfg.ttsEnabled !== true) throw new Error('微信 TTS 未启用，请先在「连接与工具」的 TTS 设置中打开。');
    const text = String(args.text ?? '').trim();
    if (!text || text.length > TTS_MAX_CHARS) throw new Error(`TTS 文本长度须为 1–${TTS_MAX_CHARS} 字。`);
    const target = await this.#replyTarget();
    return this.#withAudioFallback(target, text, signal, async () => {
      const mp3 = await synthesizeMp3(text, this.#cfg, this.#ttsApiKey(), this.#mediaByteLimit(), signal);
      signal?.throwIfAborted();
      this.#assertReplyActive(target);
      const dir = await mkdtemp(join(this.#dataDir, ID, 'tts-'));
      const path = join(dir, '语音回复.mp3');
      try {
        await writeFile(path, mp3, { flag: 'wx', mode: 0o600 });
        return await this.#sendVoiceFile(path, target, signal);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {
          this.#host?.log?.warn?.('微信 TTS 临时文件清理失败');
        });
      }
    });
  }

  // ---- 绑定 ----

  #ttsState(): TtsPanelState {
    return {
      ttsEnabled: this.#cfg.ttsEnabled === true,
      ttsProtocol: this.#cfg.ttsProtocol ?? 'openai',
      ttsBaseUrl: this.#cfg.ttsBaseUrl ?? '',
      ttsModel: this.#cfg.ttsModel ?? '',
      ttsVoice: this.#cfg.ttsVoice ?? '',
      ttsSpeed: this.#cfg.ttsSpeed ?? 1,
      keyConfigured: Boolean(this.#ttsApiKey()),
    };
  }

  #ttsApiKey(protocol = this.#cfg.ttsProtocol ?? 'openai', baseUrl = this.#cfg.ttsBaseUrl ?? ''): string {
    let name: string;
    try { name = ttsSecretName(protocol, baseUrl); }
    catch { return ''; }
    return this.#readTtsApiKey(name);
  }

  #discoverTts(draft: unknown): Promise<LocalTtsService[]> {
    this.#ttsDiscovery ??= discoverLocalTts(draft).finally(() => { this.#ttsDiscovery = undefined; });
    return this.#ttsDiscovery;
  }

  #invokePanel(panel: string, method: string, args: unknown[]): unknown {
    if (panel !== 'binding') throw new Error(`未知面板：${panel}`);
    switch (method) {
      case 'state': return this.#publicState();
      case 'start': return this.#startBinding();
      case 'verify': return this.#submitVerify(args[0]);
      case 'cancel': return this.#cancelBinding();
      case 'reconnect': return this.#reconnect();
      case 'unbind': return this.#unbind();
      case 'ffmpeg-state': return this.#ffmpegState();
      case 'ffmpeg-install': return this.#startFfmpegInstall();
      case 'ffmpeg-cancel': return this.#cancelFfmpegInstall();
      case 'ffmpeg-remove': return this.#removeFfmpeg();
      case 'tts-state': return this.#ttsState();
      case 'tts-discover': return this.#discoverTts(args[0]);
      case 'tts-key-state': {
        const { protocol, baseUrl } = ttsPanelService(args[0], args[1]);
        return { keyConfigured: Boolean(this.#ttsApiKey(protocol, baseUrl)) };
      }
      case 'tts-list-models': {
        const { protocol, baseUrl } = ttsPanelService(args[1], args[0]);
        const key = this.#ttsApiKey(protocol, baseUrl);
        return protocol === 'gpt-sovits' ? listLocalTtsModels(baseUrl, key) : listTtsModels(baseUrl, key);
      }
      case 'tts-list-voices': {
        const { protocol, baseUrl } = ttsPanelService(args[2], args[0]);
        return protocol === 'gpt-sovits' ? localTtsVoices() : listTtsVoices(baseUrl, args[1], this.#ttsApiKey(protocol, baseUrl));
      }
      case 'tts-save-settings': {
        const settings = validateTtsSettings(args[0]);
        if (!this.#persistTtsSettings) throw new Error('当前宿主未提供配置存储。');
        this.#persistTtsSettings(settings);
        return this.#ttsState();
      }
      case 'tts-save-key': {
        const key = typeof args[0] === 'string' ? args[0].trim() : '';
        if (!key || /\s/.test(key)) throw new Error('请输入有效的 TTS API Key。');
        if (!this.#storeTtsApiKey) throw new Error('当前宿主未提供凭据存储。');
        const { protocol, baseUrl } = ttsPanelService(args[1], args[2], this.#cfg);
        this.#storeTtsApiKey(ttsSecretName(protocol, baseUrl), key);
        return { keyConfigured: true };
      }
      default: throw new Error(`未知方法：${panel}.${method}`);
    }
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

  /**
   * 解绑：清掉本机保存的凭据与游标，停掉长轮询，回到未绑定状态。
   *
   * 只清本机。微信侧的绑定关系在手机微信里，这里碰不到，所以面板文案要说清楚：
   * 解绑后本机不再收消息，但微信里的那个 ClawBot 对话还在。
   */
  async #unbind(): Promise<unknown> {
    const hadToken = Boolean(this.#auth?.token);

    // 停掉轮询，避免解绑后还有请求带着旧令牌出去。
    const driver = this.#driver;
    this.#driver = null;
    this.#discardPictures();
    this.#wechatRunSources.clear();
    this.onTurnEnded();
    this.#sleepWake?.();
    if (driver) {
      try {
        await driver.stop();
      } catch {
        /* 停不下来也继续清凭据。 */
      }
    }

    // 绑定流程也一并取消。
    if (this.#login?.active) {
      this.#login.active = false;
      this.#loginAbort?.abort();
    }
    this.#login = null;
    this.#loginAbort = null;

    await this.#typingQueue;
    await this.#inboundDispatch;
    this.#typingTicket = null;
    this.#auth = null;
    this.#contextCount = 0;
    this.#lastMessageAt = '';
    this.#lastInboundTiming = null;
    this.#lastInboundAttachments = [];
    this.#lastError = '';

    await this.#store.clearSession().catch((err) => {
      this.#host?.log?.warn?.('清凭据失败', { error: errorText(err) });
    });

    this.#host?.log?.info?.(hadToken ? '微信已解绑' : '微信本来就没绑定，已清空本地状态');

    await this.#pushEvent({
      type: EVENT_LINK,
      ts: nowIso(this.#timezone),
      source: ID,
      origin: 'internal',
      text: hadToken ? '微信已解绑，本机不再收发消息。' : '微信本地状态已清空（原本未绑定）。',
      meta: { kind: 'link/unbound' },
    });

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
    login.baseUrl = this.#apiBaseUrl;
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
      if (login.status.includes(VERIFY_REQUIRED) && !login.verifyCode) {
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
      if (status.includes(VERIFY_REQUIRED)) {
        if (login.verifyCode) login.error = '验证码未通过，请重新输入手机微信上的数字。';
        login.verifyCode = '';
        continue;
      }

      switch (status) {
        case 'wait':
        case 'scaned':
          if (status === 'scaned') login.verifyCode = '';
          break;
        case 'scaned_but_redirect': {
          const host = String(response?.redirect_host ?? '').trim();
          if (host) login.baseUrl = `https://${host}`;
          break;
        }
        case 'expired':
        case 'verify_code_blocked': {
          login.verifyCode = '';
          login.refreshCount += 1;
          if (login.refreshCount > 3) {
            this.#failBinding(status === 'expired' ? 'expired' : 'verify_blocked', '二维码多次失效或验证码锁定，请重新开始绑定。');
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
    await this.#startDriver();
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
    if (!this.#login?.active || !this.#login.status.includes(VERIFY_REQUIRED)) throw new Error('当前扫码没有要求输入验证码。');
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
          value: state.lastMessageLocal ? state.lastMessageLocal.slice(5, 16).replace('-', '/') : '—',
          tone: state.lastMessageAt ? 'on' : 'off',
        },
        { label: t.badgeState, value: stateText, tone: state.connected ? 'on' : 'off' },
      ],
      panels: [{
        id: 'binding',
        title: t.panelTitle,
        getMethods: ['state', 'ffmpeg-state', 'tts-state'],
      }],
      invoke: (panel, method, args) => Promise.resolve(this.#invokePanel(panel, method, args ?? [])),
      config: wechatClawConfigGroups(language),
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
          { name: 'wechat.inbox', description: '收件目录的绝对路径（收到的图片、文件、视频、语音都在这里）。' },
          { name: 'wechat.workspace', description: '桌宠工作区的绝对路径。' },
        ],
      }],
    };
  }

  // ---- 生命周期 ----

  async start(host: WorldHost): Promise<void> {
    if (this.#started) return;
    this.#host = host;
    this.#startedAt = nowIso(this.#timezone);

    host.log.info(`微信收件目录：${this.#inboxDir}（工作区 ${this.#workspaceDir}）`);
    // Coo 的工作区是 Git 仓库，每次写文件都 `git add -A`；收到的视频不该进版本历史。
    if (ensureGitIgnored(this.#workspaceDir, this.#inboxDir)) {
      host.log.info(`已把收件目录写进工作区的 .gitignore：${this.#inboxDir}`);
    }

    this.#route = createNetworkRoute({
      mode: this.#cfg.networkMode,
      proxyUrl: this.#cfg.proxyUrl,
      forceIpv4: this.#cfg.forceIpv4,
    });
    this.#networkProblem = this.#route.problem ?? '';
    if (this.#networkProblem) host.log.warn(this.#networkProblem);

    this.#auth = await this.#store.loadAuth();
    this.#contextCount = await this.#store.countContextTokens().catch(() => 0);
    this.#lastMessageAt = '';
    if (this.#auth?.userId) {
      this.#lastMessageAt = await this.#store.loadLastMessageAt(this.#auth.userId);
      // 旧版未保存状态时，从当前绑定用户的归档消息恢复。
      if (!this.#lastMessageAt) {
        const archived = host.store.range({ source: ID, senderKey: this.#auth.userId, limit: 100 });
        const last = archived.filter((event) => event.type === EVENT_MESSAGE).at(-1);
        this.#lastMessageAt = parseIso(last?.ts) ?? '';
      }
    }
    await this.#rebuildClient();

    this.#started = true;
    if (this.#auth?.token) {
      await this.#startDriver();
    } else {
      host.log.info('微信尚未绑定，等待扫码');
    }

    // 查找 ffmpeg 不阻塞收信；这里只查找，不下载。
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

  /** 把毫秒时间按部署时区格式化成 `YYYY-MM-DD HH:MM:SS`，给面板与回执看。 */
  #localStamp(ms: number): string {
    const d = new Date(Number.isFinite(ms) ? ms : Date.now());
    try {
      const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: this.#timezone || undefined,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      }).format(d);
      return parts.replace(' ', ' ');
    } catch {
      // 时区名无效时退回本机时区，总比显示 UTC 强。
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
    if (this.#wechatRun) this.#stopRunTyping(this.#wechatRun);
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

  /**
   * 启动长轮询。
   *
   * 旧驱动必须先**真正停下**再起新的：两个驱动会各带自己的游标去问，服务端把消息推给其中
   * 一个、另一个把它写回旧游标，于是两边都以为「没新消息」。连续点几次重连正好触发这个。
   * 停止旧轮询，再放行已经接收但仍在等说明的图片；最后才启动新驱动。
   */
  #startDriver(): Promise<void> {
    const starting = this.#driverChanges.then(() => this.#replaceDriver());
    this.#driverChanges = starting.catch(() => {});
    return starting;
  }

  async #replaceDriver(): Promise<void> {
    const api = this.#api;
    const auth = this.#auth;
    if (!api || !auth?.token) return;

    const previous = this.#driver;
    if (previous) {
      try {
        await previous.stop();
      } catch (err) {
        this.#host?.log?.warn?.('旧驱动停止失败', { error: errorText(err) });
      }
      if (previous !== this.#driver) return;
      await this.#releasePictures();
      if (previous !== this.#driver) return;
    }
    if (!this.#started || auth !== this.#auth) return;

    // 回调要认「这条消息是不是当前驱动发来的」，所以先声明再赋值。
    let driver: ILinkDriver;
    driver = new ILinkDriver({
      api,
      store: this.#store,
      log: this.#host?.log ?? nullLoggerShim(),
      onMessage: (message, receivedAtMs): Promise<void> => this.#handleInbound(driver, message, receivedAtMs),
      onStatus: (status): void => this.#handleStatus(driver, status),
      onStalled: (): void => this.#handleStalled(driver),
    });
    this.#driver = driver;
    driver.start();

    void api.notifyStart().catch((err) => {
      this.#host?.log?.warn?.('上报启动失败（忽略）', { error: errorText(err) });
    });
  }

  /** 重连多次都没响应：重建客户端（新连接）再起驱动，并如实记一条。 */
  #handleStalled(driver: ILinkDriver): void {
    if (driver !== this.#driver) return;
    this.#host?.log?.warn?.('微信长轮询长时间没有响应，重建连接');
    this.#lastError = '长轮询长时间没有响应，已重建连接';
    void (async () => {
      try {
        await this.#rebuildClient();
        await this.#startDriver();
      } catch (err) {
        this.#host?.log?.warn?.('重建连接失败', { error: errorText(err) });
      }
    })();
  }

  async #restartDriver(): Promise<void> {
    await this.#rebuildClient();
    await this.#startDriver();
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
    this.#discardPictures();
    this.#wechatRunSources.clear();
    this.onTurnEnded();
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

  /**
   * 判断一条入站消息的发送者是不是绑定的微信本人。
   *
   * 正常绑定会带回 `ilink_user_id`，这里严格比对，不匹配就丢。
   * 极少数情况下服务端没给这个字段，则把**扫码绑定后第一条消息的发送者**认作本人并持久化
   * （首次信任：刚扫完码，第一个说话的就是操作者）。认领只发生一次，之后一律严格比对。
   */
  #acceptSender(from: string): boolean {
    const auth = this.#auth;
    const owner = String(auth?.userId ?? '').trim();

    if (owner) {
      if (from === owner) return true;
      this.#host?.log?.warn?.('丢弃非绑定用户发来的微信消息', { from: shortId(from) });
      return false;
    }

    // 没有绑定记录，或绑定没带 userId：无法确定本人。
    if (!auth?.token) {
      this.#host?.log?.warn?.('未绑定状态下收到微信消息，已丢弃', { from: shortId(from) });
      return false;
    }

    auth.userId = from;
    this.#host?.log?.warn?.('绑定记录缺少微信用户 ID，已把首个发送者认作本人', { userId: shortId(from) });
    void this.#store.saveAuth(auth).catch((err) => {
      this.#host?.log?.warn?.('保存微信用户 ID 失败', { error: errorText(err) });
    });
    return true;
  }

  #logInboundShape(reason: string, shape: Record<string, unknown>): void {
    this.#host?.log?.warn?.('未识别的微信入站结构', { reason, ...shape });
  }

  async #maybeReplyToCommand(auth: AuthRecord, from: string, msg: WeixinMessage, token: string, received: number, processing: number): Promise<boolean> {
    const items = msg.item_list;
    if (items?.length !== 1 || inboundWireType(items[0]?.type) !== MessageItemType.TEXT || items[0].ref_msg) return false;
    const text = quoteText(msg).trim();
    const command = text.match(/^\/(状态|status|echo)(?:\s+([\s\S]*))?$/i);
    if (!command || (command[1].toLowerCase() !== 'echo' && command[2])) return false;
    const echo = command[1].toLowerCase() === 'echo';
    const timing = `微信 → 扩展 ${Math.max(0, received - messageTimeMs(msg))} ms，排队 ${Math.max(0, processing - received)} ms`;
    try {
      await this.#queueSend({}, async () => {
        if (auth !== this.#auth || !token) return;
        const target = await this.#replyTarget();
        if (target.to !== from || target.context.token !== token) return;
        const state = this.#runState && { idle: '空闲', delivering: '投递消息', model: '等待模型', tools: '执行工具', backoff: '等待重试', handoff: '交接上下文' }[this.#runState];
        const prefix = echo ? (command[2]?.trim().slice(0, 1000) || '微信通道正常')
          : `微信通道正常（未调用模型）${state ? `\n桌宠：${state}` : ''}`;
        const line = `${prefix}\n${timing}，本地处理 ${Date.now() - processing} ms`;
        await this.#sendReply(target, textMessage({ to: from, text: line, contextToken: token }), 0, 1);
      });
    } catch {
      this.#host?.log?.warn?.('微信未能回复通道诊断指令');
    }
    await this.#pushEvent({ type: EVENT_MESSAGE, source: ID, origin: 'external', senderKey: from,
      ts: new Date(messageTimeMs(msg)).toISOString(), text: echo ? '/echo' : '/status', meta: { kind: 'message/diagnostic' } }, { deliver: false });
    return true;
  }

  async #rememberQuote(auth: AuthRecord, peer: string, message: WeixinMessage, media: QuoteMedia[]): Promise<void> {
    await this.#quotes.remember(auth.accountId, peer, quoteIds(message), quoteText(message), media).catch(() => {
      this.#host?.log?.warn?.('微信引用索引未保存，消息收发不受影响');
    });
  }

  async #resolveQuote(auth: AuthRecord, peer: string, message: WeixinMessage, summary: string, opts: RenderOptions) {
    const ref = Array.isArray(message.item_list) ? message.item_list.find(item => item?.ref_msg)?.ref_msg : undefined;
    if (!ref) return { text: summary, media: [] as InboundMedia[] };

    const ids = referenceIds(ref);
    const host = this.#host;
    const acceptsKind = { image: opts.downloadImages, file: opts.downloadFiles, video: opts.downloadVideo, voice: opts.downloadVoice };
    const accepts = (kind: InboundMedia['kind'], bytes: number) => acceptsKind[kind] && bytes <= opts.maxBytes;
    const notes: string[] = [];
    let original = '';
    let media: InboundMedia[] = [];
    try {
      let saved: Awaited<ReturnType<QuoteIndex['find']>>;
      for (const id of ids) {
        saved = await this.#quotes.find(auth.accountId, peer, id, this.#sendRoots());
        if (saved) break;
      }
      if (saved) {
        original = saved.text;
        media = saved.media.filter(item => accepts(item.kind, item.bytes));
        if (saved.missing) notes.push(`[${saved.missing} 个引用附件已删除或变更]`);
        if (saved.media.length > media.length) notes.push('[部分引用附件未附：接收设置关闭或超过体积限制]');
      } else if (host && ids.length) {
        const recent = host.store.range({ source: ID, senderKey: peer, limit: 500 }).slice().reverse();
        for (const id of ids) {
          const archived = recent.find(event => {
            const raw = event.meta?.raw as WeixinMessage | undefined;
            return event.type === EVENT_MESSAGE && event.senderKey === peer && event.source === ID && raw
              && (event.meta?.bindingAccount ?? raw.to_user_id) === auth.accountId
              && !event.meta?.imageCaptionBatch && quoteIds(raw).includes(id);
          });
          if (!archived) continue;
          const raw = archived.meta!.raw as WeixinMessage;
          original = quoteText(raw);
          const restored = await restoreArchivedQuote(archived, host, this.#inboxDir, accepts);
          media = restored.media;
          if (restored.unavailable) notes.push('[引用附件在 Core 归档中已不可用]');
          if (restored.excluded) notes.push('[部分引用附件未附：接收设置关闭或超过体积限制]');
          if (media.length && !notes.length) await this.#rememberQuote(auth, peer, raw, media);
          break;
        }
      }
    } catch {
      this.#logInboundShape('quote-lookup-failed', { hasServerId: ids.length > 0 });
    }

    const rawText = ref.message_item?.text_item?.text;
    const inlineText = typeof rawText === 'string' ? rawText.trim() : '';
    let text = original ? partialQuote(original, ref.partial_text) : inlineText || summary;
    if (!media.length) {
      const inline = await renderQuotedMedia(ref.message_item, opts);
      if (inline?.media.length) {
        text = [text, inline.text].filter(Boolean).join(' ');
        return { text, media: inline.media.map(item => ({ ...item, label: `[引用附件 ${basename(item.path)}]` })) };
      }
      if (inline?.text) notes.push(`引用附件：${inline.text}`);
      if (!notes.length && !original && !inlineText && ids.length) notes.push('[未找到被引用的消息或附件]');
      if (notes.length || (!original && text === '[引用消息]')) {
        this.#logInboundShape('quote-unavailable', { hasServerId: ids.length > 0, ...inboundItemShape(ref.message_item) });
      }
    }
    if (media.length && /^\[引用消息(?: #[0-9]+)?\]$/.test(text)) text = media.map(item => item.label).join(' ');
    return { text: [text, ...notes].filter(Boolean).join(' '), media };
  }

  #rememberWechatRunSource(auth: AuthRecord, token: string): string | undefined {
    if (!token || !this.#started) return;
    const key = randomUUID();
    this.#wechatRunSources.set(key, { auth, token });
    if (this.#wechatRunSources.size > 64) this.#wechatRunSources.delete(this.#wechatRunSources.keys().next().value!);
    return key;
  }

  onEventsSettled(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded'): void {
    let source: { auth: AuthRecord; token: string } | undefined;
    for (const event of events) {
      const key = event.meta?.wechatRunKey;
      if (event.source !== ID || typeof key !== 'string') continue;
      const candidate = this.#wechatRunSources.get(key);
      this.#wechatRunSources.delete(key);
      if (candidate?.auth === this.#auth && event.senderKey === this.#auth?.userId) source = candidate;
    }
    if (this.#started && source && outcome === 'delivered') {
      this.onTurnEnded();
      this.#wechatRun = { ...source, id: randomUUID(), pendingReplies: 0 };
    }
  }

  onRunPhase(phase: RunPhase): void {
    this.#runState = phase.state;
    const scope = this.#wechatRun;
    if (!scope) return;
    if (phase.state === 'idle' || phase.state === 'handoff' || phase.state === 'delivering') {
      this.onTurnEnded();
      return;
    }
    if (!scope.replyFinished) this.#touchRunTyping(scope);
    const working = this.#cfg.nativeProgressEnabled === true && phase.state === 'tools' && phase.running.some(name => !name.startsWith('wechat_'));
    if (!working) {
      clearTimeout(scope.timer);
      scope.timer = undefined;
      this.#closeProgressCard(scope);
      return;
    }
    if (scope.timer || scope.opened) return;
    scope.timer = setTimeout(() => {
      scope.timer = undefined;
      if (this.#wechatRun === scope) scope.opened = this.#sendProgress(scope, 'start');
    }, PROGRESS_DELAY_MS);
    scope.timer.unref?.();
  }

  #touchRunTyping(scope: WechatRun): void {
    if (!this.#started || !this.#driver || scope.auth !== this.#auth) return;
    scope.endTyping ??= this.#startTyping(scope.auth.userId, scope.token, true);
    clearTimeout(scope.typingDeadline);
    scope.typingDeadline = setTimeout(() => this.#stopRunTyping(scope), TYPING_IDLE_LIMIT_MS);
    scope.typingDeadline.unref?.();
  }

  #stopRunTyping(scope: WechatRun): void {
    clearTimeout(scope.typingDeadline);
    scope.typingDeadline = undefined;
    scope.endTyping?.();
    scope.endTyping = undefined;
  }

  onTurnEnded(): void {
    const scope = this.#wechatRun;
    this.#wechatRun = null;
    if (scope) {
      this.#stopRunTyping(scope);
      this.#closeProgressCard(scope);
    }
  }

  #closeProgressCard(scope: WechatRun): void {
    clearTimeout(scope.timer);
    scope.timer = undefined;
    if (!scope.opened || scope.closing) return;
    scope.closing = true;
    void scope.opened.then(started => { if (started) return this.#sendProgress(scope, 'end'); });
  }

  #sendProgress(scope: WechatRun, phase: 'start' | 'end'): Promise<boolean> {
    return this.#queueSend({}, async () => {
      if (!this.#started || !this.#driver || scope.auth !== this.#auth ||
        (phase === 'start' && (this.#wechatRun !== scope || scope.closing || this.#cfg.nativeProgressEnabled !== true))) return false;
      const to = scope.auth.userId;
      const context = await this.#store.getReplyContext(to);
      if (!context || context.rejected || context.token !== scope.token) return false;
      // A start plus its result must leave eight slots for the user's actual reply.
      const minimum = phase === 'start' ? MAX_SEGMENT_THRESHOLD + 2 : 2;
      if (MAX_REPLIES_PER_CONTEXT - context.sent < minimum) return false;
      if (phase === 'start' && (this.#wechatRun !== scope || scope.closing)) return false;
      const target = { to, auth: scope.auth, context };
      this.#assertReplyActive(target);
      const response = await this.#requireApi().sendMessage(progressMessage({ to, contextToken: scope.token, runId: scope.id, phase }));
      if (response?.ret !== 0 && !response?.message_id) throw new Error('进度卡响应为空');
      // A progress-only rejection must not invalidate the token needed for the actual reply.
      await this.#recordReply(target, 'sent');
      if (phase === 'start') scope.sentStart = true;
      return true;
    }).catch(() => {
      this.#host?.log?.warn?.('微信任务进度卡未发送，正文不受影响', { phase });
      return false;
    });
  }

  async #handleInbound(driver: ILinkDriver, message: WeixinMessage, receivedAtMs: number): Promise<void> {
    if (driver !== this.#driver || !this.#started) return;
    // 自己发出去的消息不回到自己这里。
    const from = typeof message?.from_user_id === 'string' ? message.from_user_id.trim() : '';
    if (message?.group_id) return;
    const type = inboundWireType(message?.message_type);
    if (type === MessageType.BOT) {
      if (from && from === this.#auth?.userId) this.#logInboundShape('unexpected-bot-message-from-owner', inboundMessageShape(message));
      return;
    }
    if (!from) {
      this.#logInboundShape('missing-sender', inboundMessageShape(message));
      return;
    }
    if (this.#auth?.accountId && from === this.#auth.accountId) return;

    // 只接受绑定本人发来的消息。别的人（群成员、服务通知、陌生人）一律丢弃：
    // 收件人已经钉死在 auth.userId，这里再放行，非本人的内容就会进入上下文，
    // 并且「回复」的语义会被引到错误的人身上。
    const confirmedOwner = from === this.#auth?.userId;
    if (!this.#acceptSender(from)) return;
    if (type !== MessageType.USER && type !== MessageType.NONE) {
      this.#logInboundShape('unexpected-message-type', inboundMessageShape(message));
    }

    const entry = { message, receivedAtMs, confirmedOwner };
    const windowMs = this.#cfg.receiveImages === false ? 0 : Math.min(5, Math.max(0, Number(this.#cfg.imageCaptionWindowSec) || 0)) * 1000;
    const kind = windowMs ? captionKind(message) : 'other';
    const pending = this.#pictureBatch;
    if (pending && (pending.driver !== driver || pending.from !== from || receivedAtMs > pending.deadline || kind === 'other')) {
      void this.#releasePictures();
    }
    if (kind === 'images') {
      const batch = this.#pictureBatch ?? { driver, from, entries: [], deadline: receivedAtMs + windowMs };
      if (!this.#pictureBatch) {
        this.#pictureBatch = batch;
        batch.timer = setTimeout(() => { if (this.#pictureBatch === batch) void this.#releasePictures(); },
          Math.max(0, batch.deadline - Date.now()));
        batch.timer.unref?.();
      }
      batch.entries.push(entry);
      if (batch.entries.length >= MAX_WAITING_PICTURES) await this.#releasePictures();
      return;
    }
    if (kind === 'text' && this.#pictureBatch) {
      this.#pictureBatch.entries.push(entry);
      await this.#releasePictures();
      return;
    }
    await this.#dispatchInbound(driver, from, [entry]);
  }

  #releasePictures(): Promise<void> {
    const batch = this.#pictureBatch;
    if (!batch) return this.#inboundDispatch;
    clearTimeout(batch.timer);
    this.#pictureBatch = null;
    return this.#dispatchInbound(batch.driver, batch.from, batch.entries);
  }

  #discardPictures(): void {
    clearTimeout(this.#pictureBatch?.timer);
    this.#pictureBatch = null;
  }

  #dispatchInbound(driver: ILinkDriver, from: string, entries: Incoming[]): Promise<void> {
    const delivery = this.#inboundDispatch.then(() => this.#deliverInbound(driver, from, entries));
    this.#inboundDispatch = delivery.catch(err => this.#host?.log?.warn?.('微信入站消息处理失败', { error: errorText(err) }));
    return this.#inboundDispatch;
  }

  async #deliverInbound(driver: ILinkDriver, from: string, entries: Incoming[]): Promise<void> {
    if (driver !== this.#driver || !this.#auth || !entries.length) return;
    const auth = this.#auth;
    const { message, receivedAtMs } = entries[entries.length - 1];

    const processingAtMs = Date.now();
    const atMs = Math.max(...entries.map(entry => messageTimeMs(entry.message)));
    const messageAt = new Date(atMs).toISOString();
    if (!this.#lastMessageAt || atMs > Date.parse(this.#lastMessageAt)) this.#lastMessageAt = messageAt;

    const contextToken = entries.map(entry => String(entry.message?.context_token ?? '').trim()).filter(Boolean).at(-1) ?? '';
    if (contextToken) {
      try {
        await this.#store.saveContextToken(from, contextToken);
      } catch (err) {
        this.#host?.log?.warn?.('context_token 没存下来', { error: errorText(err) });
      }
      this.#contextCount = await this.#store.countContextTokens();
    }

    try {
      await this.#store.saveLastMessageAt(from, this.#lastMessageAt);
    } catch (err) {
      this.#host?.log?.warn?.('最近消息时间未保存', { error: errorText(err) });
    }

    if (entries.length === 1 && entries[0].confirmedOwner &&
      await this.#maybeReplyToCommand(auth, from, message, contextToken, receivedAtMs, processingAtMs)) return;

    const maxBytes = this.#mediaByteLimit();
    const renderOptions: Parameters<typeof renderInbound>[1] = {
      media: this.#media,
      inboxDir: this.#inboxDir,
      downloadImages: this.#cfg.receiveImages !== false,
      downloadFiles: this.#cfg.receiveFiles !== false,
      downloadVoice: this.#cfg.receiveVoices !== false,
      downloadVideo: this.#cfg.receiveVideos === true,
      maxBytes,
      onUnexpected: (reason, shape) => this.#logInboundShape(reason, shape),
    };
    const parts: Awaited<ReturnType<typeof renderInbound>>[] = [];
    for (const entry of entries) {
      if (driver !== this.#driver || auth !== this.#auth) return;
      const part = await renderInbound(entry.message, renderOptions);
      parts.push(part);
      await this.#rememberQuote(auth, from, entry.message, part.media);
    }
    const last = parts[parts.length - 1];
    const rendered = parts.length === 1 ? last : {
      text: parts.map(part => part.text).filter(Boolean).join('\n'),
      media: parts.flatMap(part => part.media), transcript: last.transcript, quote: last.quote,
      raw: sanitizeRaw({ ...message, item_list: parts.flatMap(part => part.raw.item_list ?? []) }),
    };
    const quoted = await this.#resolveQuote(auth, from, message, last.quote, renderOptions);
    rendered.quote = quoted.text;
    const ownMediaCount = rendered.media.length;
    rendered.media = [...rendered.media, ...quoted.media];

    const blobs: AttachmentBlob[] = [];
    const host = this.#host;
    // 闸门里要写进正文的说明（压缩了哪张、哪张被丢掉、为什么）。
    const fitNotes: string[] = [];
    const attachments: InboundAttachment[] = [];
    // 一次投递累计附了几张图，用来卡上限。
    let imageCount = 0;
    const limits = this.#imageLimits();

    for (const item of rendered.media) {
      if (driver !== this.#driver || auth !== this.#auth) return;
      const before = blobs.length;
      const noteIndex = fitNotes.length;
      try {
        // 微信的文件通道也可能装着图片、音乐或视频，按实际 MIME 投递。
        if (item.mime.startsWith('image/')) {
          imageCount += 1;
          if (imageCount > limits.maxCount) {
            fitNotes.push(`[图片未附：${overCountNote(imageCount - 1, limits)}]`);
            continue;
          }
          await this.#attachImage(blobs, item, limits, fitNotes);
          continue;
        }
        if (item.mime === WECHAT_OPUS_MIME || (item.kind === 'voice' && item.mime === OCTET_STREAM)) {
          fitNotes.push(`${item.label} 未附：未取得可提交的标准音频。`);
          continue;
        }
        if (item.mime.startsWith('audio/')) {
          await this.#addBlob(blobs, item.path, item.mime, item.label, fitNotes);
          continue;
        }
        const support = this.#mimeSupport(item.mime);
        if (support.error) {
          fitNotes.push(`${item.label} 未附：附件能力查询失败（${item.mime}，${support.error}）。`);
        } else if (support.accepted) {
          await this.#addBlob(blobs, item.path, item.mime, item.label, fitNotes);
        } else if (item.mime.startsWith('video/')) {
          const note = await this.#attachFrames(blobs, item.path, this.#acceptsMime('image/jpeg', fitNotes), limits, fitNotes, (n) => {
            imageCount += n;
            return imageCount;
          });
          if (note) fitNotes.push(note);
          else if (!(Number(this.#cfg.videoFrames) > 0)) fitNotes.push('[视频未附：当前 Provider 不接受此视频格式，且已关闭抽帧]');
        } else {
          fitNotes.push(`${item.label} 未附：当前 Provider 不接受 ${item.mime} 输入。`);
        }
      } catch {
        fitNotes.push(`${item.label} 未附：处理附件时出错。`);
      } finally {
        const attachedMimes = blobs.slice(before).map((blob) => blob.mime);
        const quoted = attachments.length >= ownMediaCount;
        if (quoted && !attachedMimes.length) fitNotes.push(`[引用附件已存为 ${item.path}]`);
        const frames = (item.videoFrames || item.mime.startsWith('video/')) && attachedMimes[0]?.startsWith('image/');
        attachments.push({ kind: item.kind, name: basename(item.path), mime: item.mime, bytes: item.bytes,
          ...(quoted ? { quoted: true } : {}),
          delivery: attachedMimes.length ? (frames ? 'frames' : 'native') : 'omitted',
          attachedMimes, notes: fitNotes.slice(noteIndex) });
      }
    }

    if (driver !== this.#driver || auth !== this.#auth) return;
    this.#lastInboundAttachments = attachments;
    this.#lastInboundTiming = {
      receivedAt: new Date(receivedAtMs).toISOString(),
      receiveDelayMs: Math.max(0, receivedAtMs - atMs),
      queueMs: Math.max(0, processingAtMs - receivedAtMs),
      processingMs: Date.now() - processingAtMs,
    };
    host?.log?.info?.('微信入站消息已处理', { ...this.#lastInboundTiming, attachments: blobs.length });

    const prefix = `[微信 ${clockText(atMs, this.#timezone)} ${shortId(from)}]`;
    const quoteLine = rendered.quote ? `（回复 ${rendered.quote}）` : '';
    const base = rendered.text || '[空消息]';
    const body = fitNotes.length ? `${base}\n${fitNotes.join('\n')}` : base;
    const wechatRunKey = entries.every(entry => entry.confirmedOwner) ? this.#rememberWechatRunSource(auth, contextToken) : undefined;
    await this.#pushEvent({
      type: EVENT_MESSAGE,
      ts: messageAt,
      source: ID,
      origin: 'external',
      text: `${prefix}${quoteLine} ${body}`,
      senderKey: from,
      blobs: blobs.length ? blobs : undefined,
      meta: {
        kind: 'message/private',
        conv: { kind: 'private', id: from },
        bindingAccount: auth.accountId,
        raw: rendered.raw,
        ...(rendered.transcript ? { transcript: rendered.transcript } : {}),
        ...(rendered.quote ? { quote: rendered.quote } : {}),
        media: rendered.media.map((item, i) => ({ ...attachments[i], label: item.label })),
        ...(entries.length > 1 ? { imageCaptionBatch: entries.length } : {}),
        ...(wechatRunKey ? { wechatRunKey } : {}),
        timing: this.#lastInboundTiming,
      },
    }, { deliver: true, trigger: resolveInboundTrigger(this.#cfg.inboundTrigger) });
  }

  #mimeSupport(mime: string): { accepted: boolean; error?: string } {
    if (!this.#host?.modelFacts) return { accepted: false, error: 'World 未运行或宿主未提供模型能力查询。' };
    try {
      return { accepted: this.#host.modelFacts.accepts(mime) };
    } catch (err) {
      return { accepted: false, error: errorText(err) };
    }
  }

  #acceptsMime(mime: string, notes: string[]): boolean {
    const result = this.#mimeSupport(mime);
    if (result.error) notes.push(`[附件能力查询失败：${mime}，${result.error}]`);
    return result.accepted;
  }

  /** 读取失败或能力不支持时取消附件，并在事件正文告知原因。 */
  async #addBlob(blobs: AttachmentBlob[], path: string, mime: string, label: string, notes: string[]): Promise<void> {
    for (const candidate of [mime, ...audioMimeAliases(mime)]) {
      const support = this.#mimeSupport(candidate);
      if (support.error) {
        notes.push(`${label} 未附：附件能力查询失败（${candidate}，${support.error}）。`);
        return;
      }
      if (!support.accepted) continue;
      try {
        const bytes = await readFile(path);
        if (mime === 'audio/opus' && candidate === 'audio/ogg' && mimeForInbound(bytes) !== 'audio/opus') continue;
        blobs.push({ bytes: new Uint8Array(bytes), mime: candidate, name: basename(path), fallbackText: label });
      } catch (err) {
        notes.push(`${label} 未附：附件读取失败（${errorText(err)}）。`);
      }
      return;
    }
    notes.push(`${label} 未附：当前 Provider 不接受 ${mime} 输入。`);
  }

  /** 图片闸门的三个上限，从配置里取，带兜底值。 */
  #imageLimits(): ImageLimits {
    const mb = Number(this.#cfg.imageMaxMb);
    const edge = Number(this.#cfg.imageMaxEdge);
    const count = Number(this.#cfg.imageMaxCount);
    return {
      maxBytes: Math.max(1, Number.isFinite(mb) ? mb : 16) * 1024 * 1024,
      maxEdge: Math.max(256, Number.isFinite(edge) ? edge : 4096),
      maxCount: Math.max(1, Math.floor(Number.isFinite(count) ? count : 10)),
    };
  }

  /** 图片闸门的产物放哪；放在收件目录的派生层里，不和原件混在一起。 */
  #fitDir(): string {
    return derivedDir(this.#inboxDir, 'fitted');
  }

  /**
   * 附一张图片，超限的先压缩；压不了就不附，并在正文里写明哪一项超标。
   *
   * 先看元数据再决定读不读内容：32 MB 的图不该先整读进内存再判断。
   */
  async #attachImage(
    blobs: AttachmentBlob[],
    item: { path: string; mime: string; label: string; bytes?: number },
    limits: ImageLimits,
    notes: string[],
  ): Promise<void> {
    if (!this.#acceptsMime(item.mime, notes) && !this.#acceptsMime('image/jpeg', notes)) {
      notes.push(`${item.label} 未附：当前 Provider 不接受 ${item.mime} 输入。`);
      return;
    }
    const probe = await probeImage(item.path, item.mime);
    if (!probe) {
      notes.push(`[${item.label} 未附：文件读不出来]`);
      return;
    }

    const fitted = await fitImage({
      probe,
      limits,
      ffmpegPath: this.#ffmpeg?.path ?? null,
      outDir: this.#fitDir(),
    });

    if (!fitted.ok) {
      notes.push(`[${item.label} 未附：${fitted.reason}]`);
      return;
    }
    if (fitted.note) notes.push(`[${item.label} ${fitted.note}]`);

    await this.#addBlob(blobs, fitted.path, fitted.mime, item.label, notes);
  }

  /**
   * 抽帧并拼成一张图附上。
   *
   * 拼图也算一张图片，要走同一个数量额度。
   * 抽不出来时返回一句写进正文的说明——**不假装看过视频**。
   */
  async #attachFrames(
    blobs: AttachmentBlob[],
    videoPath: string,
    acceptsImages: boolean,
    limits: ImageLimits,
    notes: string[],
    bumpCount: (n: number) => number,
  ): Promise<string> {
    const wanted = Math.floor(Number(this.#cfg.videoFrames) ?? 0);
    if (!(wanted > 0)) return '';
    if (!acceptsImages) return '[视频帧未提供：当前模型不接受图片输入]';

    const ffmpegPath = this.#ffmpeg?.path ?? null;
    if (!ffmpegPath) {
      return `[视频帧未抽取：${this.#ffmpeg?.detail || '没有可用的 ffmpeg'}]`;
    }

    // 拼图也占一张图片额度；满了就别抽了，省得白跑一趟 ffmpeg。
    if (bumpCount(1) > limits.maxCount) {
      notes.push('[视频拼图未附：超出本次投递的图片数量上限]');
      return '';
    }

    const result = await extractFrameStrip({
      ffmpegPath,
      videoPath,
      outDir: derivedDir(this.#inboxDir, 'frames', Date.now().toString(36)),
      frames: Math.min(MAX_FRAMES, wanted),
    });

    if (!result.ok) return `[视频帧未抽取：${result.reason}]`;

    const { strip } = result;
    // 拼图本身也要过闸门：帧数多、分辨率高时可能超边或超体积。
    const fitted = await fitImage({
      probe: { path: strip.path, bytes: strip.bytes, mime: strip.mime },
      limits,
      ffmpegPath,
      outDir: this.#fitDir(),
    });
    if (!fitted.ok) {
      notes.push(`[视频拼图未附：${fitted.reason}]`);
      return '';
    }
    if (fitted.note) notes.push(`[视频拼图 ${fitted.note}]`);

    const before = blobs.length;
    await this.#addBlob(blobs, fitted.path, fitted.mime, '视频拼图', notes);
    if (blobs.length === before) return '';

    const sizeNote = strip.videoSize
      ? `原视频 ${strip.videoSize.width}×${strip.videoSize.height}，`
      : '原视频方向未识别，按横屏处理，';
    return `[视频拼图：${sizeNote}${result.note}]`;
  }

  #startTyping(to: string, contextToken: string, renew = false): () => void {
    const api = this.#api;
    if (!api) return () => {};
    const wait = new AbortController();
    const ended = new Promise<void>((resolve) => wait.signal.addEventListener('abort', () => resolve(), { once: true }));
    const stillWaiting = () => !wait.signal.aborted && api === this.#api;

    this.#typingQueue = this.#typingQueue.then(async () => {
      if (!stillWaiting()) return;
      let cached = this.#typingTicket;
      if (!cached || cached.api !== api || cached.to !== to || cached.contextToken !== contextToken) {
        try {
          const config = await api.getConfig({ ilinkUserId: to, contextToken, signal: wait.signal });
          const value = String(config?.typing_ticket ?? '').trim();
          if (!stillWaiting() || !value) return;
          cached = { api, to, contextToken, value };
          this.#typingTicket = cached;
        } catch (err) {
          if (!wait.signal.aborted) this.#logTypingFailure('ticket', err);
          return;
        }
      }
      const request = { ilink_user_id: to, typing_ticket: cached.value };
      let failures = 0;
      do {
        try {
          await api.sendTyping({ ...request, status: TypingStatus.TYPING });
          failures = 0;
        } catch (err) {
          this.#typingTicket = null;
          failures += 1;
          this.#logTypingFailure('start', err);
        }
        if (!renew || failures >= 2 || !stillWaiting()) break;
        await delay(TYPING_REFRESH_MS, undefined, { signal: wait.signal, ref: false }).catch(() => {});
      } while (stillWaiting());
      // 开启请求一旦发出，即使超时也可能已被微信处理。等它结束后再用同一张票取消。
      if (!renew) await ended;
      try {
        await api.sendTyping({ ...request, status: TypingStatus.CANCEL });
      } catch (err) {
        this.#typingTicket = null;
        this.#logTypingFailure('cancel', err);
      }
    });
    return () => wait.abort();
  }

  #logTypingFailure(action: 'ticket' | 'start' | 'cancel', err: unknown): void {
    // 网关响应正文可能含凭据；这里只记录阶段、超时和数字错误码。
    this.#host?.log?.warn?.('微信输入状态请求失败（不影响发消息）', {
      action,
      timeout: isAbort(err),
      ret: err instanceof ILinkError && Number.isFinite(err.ret) ? err.ret : undefined,
      status: err instanceof ILinkError ? err.status : undefined,
    });
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
    this.#wechatRunSources.clear();
    this.onTurnEnded();
    // 打断段间等待，否则关机要干等到间隔结束。
    this.#sleepWake?.();
    const login = this.#login;
    if (login?.active) login.active = false;
    this.#loginAbort?.abort();
    const loginLoop = this.#loginLoop;
    this.#loginLoop = null;
    if (loginLoop) await loginLoop.catch(() => {});

    await this.#typingQueue;
    this.#typingTicket = null;
    await this.#driverChanges;
    const api = this.#api;
    if (api && this.#auth?.token) {
      await api.notifyStop().catch((err) => {
        this.#host?.log?.warn?.('上报停止失败（忽略）', { error: errorText(err) });
      });
    }

    const driver = this.#driver;
    if (driver) await driver.stop();
    await this.#releasePictures();
    this.#driver = null;
    this.#runState = undefined;

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
