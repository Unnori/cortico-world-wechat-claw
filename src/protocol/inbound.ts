/**
 * 入站消息的可读化、媒体落地与脱敏。
 *
 * `context_token` 是回复凭据，绝不进事件 meta、日志或模型上下文。
 * 媒体按类型下载解密后落到**桌宠工作区里的收件目录**（见 `paths.ts`），路径写进事件正文，
 * World 按实际 MIME 查询 Provider；受支持的字节作为事件附件交给 Core，其余保留路径与原因。
 *
 * 落盘位置与文件名都是给桌宠看的：目录按类型分，文件名保留对方给的原文名，
 * 后面接一个本地时间戳。这样它读得到、改得了，也能原样发回去。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { datedFileName, uniqueFileName } from '../paths.ts';
import { extensionForInbound, imageSize, mimeForInbound, OCTET_STREAM, sniffImageMime, WECHAT_OPUS_MIME } from './mime.ts';
import { silkToWav } from '../media/voice.ts';
import { wechatOpusToOgg } from '../media/wechat-opus.ts';
import type { MediaTransfer } from './media.ts';
import { MessageItemType, type MessageItem, type WeixinMessage } from './types.ts';
import { inboundItemShape, inboundMessageShape, inboundWireType } from './inbound-shape.ts';

const KNOWN_ITEM_TYPES = new Set<number>(Object.values(MessageItemType).filter(type => type !== MessageItemType.NONE));

export interface InboundMedia {
  /** 落盘的本地绝对路径。 */
  path: string;
  mime: string;
  /** 进上下文的一句话，如 `[图片 640x480]`。 */
  label: string;
  kind: 'image' | 'file' | 'video' | 'voice';
  bytes: number;
  /** 图片的真实像素尺寸；读不出文件头时缺省。 */
  width?: number;
  height?: number;
  /** 已归档的视频抽帧图，仍按图片输入投递。 */
  videoFrames?: true;
}

/** 一条入站消息渲染后的结果。 */
export interface RenderedInbound {
  /** 进事件的正文（不含发送者前缀）。 */
  text: string;
  media: InboundMedia[];
  /** 语音转文字、服务端已给的转写。 */
  transcript: string;
  /** 被引用消息的摘要。 */
  quote: string;
  /** 去掉了 context_token 的原始消息，供 `meta.raw`。 */
  raw: WeixinMessage;
}

export function shortId(value: unknown): string {
  const id = String(value ?? '');
  if (!id) return '';
  const local = id.includes('@') ? id.slice(0, id.indexOf('@')) : id;
  return local.length > 10 ? `${local.slice(0, 8)}…` : local;
}

export function messageTimeMs(msg: WeixinMessage): number {
  const raw = msg?.create_time_ms;
  const ms = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : 0;
  if (Number.isFinite(ms) && ms > 0 && ms <= 8.64e15) return ms;
  return Date.now();
}

/** 本地时钟，用于事件正文的前缀。 */
export function clockText(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      ...(timezone ? { timeZone: timezone } : {}),
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 19);
  }
}

/** 复制一份用于 meta.raw，去掉 context_token。 */
export function sanitizeRaw(msg: WeixinMessage): WeixinMessage {
  const copy = structuredClone(msg);
  delete copy.context_token;
  return copy;
}

/** 被引用消息的摘要；只给 ID 时保留占位，等 World 查询历史。 */
export function quoteSummary(item: MessageItem | undefined): string {
  const ref = item?.ref_msg;
  if (!ref) return '';
  const parts: string[] = [];
  if (typeof ref.title === 'string' && ref.title.trim()) parts.push(ref.title.trim());
  const inner = ref.message_item;
  if (inner) {
    const type = inboundWireType(inner.type);
    if (type === MessageItemType.TEXT) parts.push(String(inner.text_item?.text ?? '').trim());
    else if (type === MessageItemType.IMAGE) parts.push('[图片]');
    else if (type === MessageItemType.FILE) parts.push(`[文件 ${inner.file_item?.file_name ?? ''}]`.trim());
    else if (type === MessageItemType.VIDEO) parts.push('[视频]');
    else if (type === MessageItemType.VOICE) parts.push('[语音]');
  }
  const text = parts.filter(Boolean).join(' | ');
  if (text) return text;
  return ref.svr_id ? `[引用消息 #${ref.svr_id}]` : '[引用消息]';
}

/** iLink VoiceItem.encode_type. Feature data has no playable audio MIME. */
const VOICE_ENCODINGS: Partial<Record<number, { name: string; mime: string }>> = {
  1: { name: 'PCM', mime: 'audio/pcm' },
  2: { name: 'ADPCM', mime: 'audio/adpcm' },
  3: { name: 'feature', mime: OCTET_STREAM },
  4: { name: 'Speex', mime: 'audio/speex' },
  5: { name: 'AMR', mime: 'audio/amr' },
  6: { name: 'SILK', mime: 'audio/silk' },
  7: { name: 'MP3', mime: 'audio/mpeg' },
  8: { name: 'Ogg Speex', mime: 'audio/ogg' },
};

export interface RenderOptions {
  media: MediaTransfer | null;
  onUnexpected?: (reason: string, shape: Record<string, unknown>) => void;
  /** 收件目录，绝对路径。媒体按类型落到它下面的 images/files/videos/voices。 */
  inboxDir: string;
  /** 每类媒体是否下载。关掉时只留占位文字。 */
  downloadImages: boolean;
  downloadFiles: boolean;
  downloadVoice: boolean;
  downloadVideo: boolean;
  /** 单条媒体字节上限；超过就只留占位。 */
  maxBytes: number;
  cdnOnly?: boolean;
}

/**
 * 落盘并返回文件路径；失败时抛错，由上层折成一句说明。
 *
 * 名字先按「原文名 + 时间戳」生成，撞名再退到 `-2`、`-3`；写入用 `wx` 独占标志，
 * 万一在查重和写入之间被别人占了名字，就换一个再写，不覆盖已有文件。
 */
export async function saveMedia(params: {
  bytes: Uint8Array;
  dir: string;
  name: string;
}): Promise<string> {
  await mkdir(params.dir, { recursive: true });
  let name = uniqueFileName(params.dir, params.name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const filePath = join(params.dir, name);
    try {
      await writeFile(filePath, params.bytes, { flag: 'wx' });
      return filePath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      name = uniqueFileName(params.dir, params.name);
    }
  }
  throw new Error(`收件目录里放不下 ${params.name}`);
}

/** Quotes may contain downloadable media even without a server message ID. */
export function renderQuotedMedia(item: MessageItem | undefined, opts: RenderOptions): Promise<RenderedInbound> | undefined {
  if (item && [item.image_item, item.file_item, item.video_item, item.voice_item].some(part =>
    part?.media && (part.media.encrypt_query_param || part.media.full_url))) {
    return renderInbound({ item_list: [item] }, { ...opts, cdnOnly: true });
  }
}

/** 取不到附件时给模型的一句话，按原因区分。 */
function missText(
  outcome: { ok: false; reason: 'too-large' | 'no-ref' | 'failed' },
  what: string,
  limitBytes: number,
): string {
  if (outcome.reason === 'too-large') {
    return `[${what} 超过 ${Math.round(limitBytes / 1024 / 1024)} MB 上限，未下载]`;
  }
  if (outcome.reason === 'no-ref') return `[${what} 没有下载参数，未能取回]`;
  return `[${what}，附件未能取回]`;
}

const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * 把一条入站消息渲染成事件正文，并把媒体下载解密到本地。
 * 每类媒体独立失败：取不回就留一句说明（超限、缺参数、下载失败分别措辞），其余内容照常进上下文。
 */
export async function renderInbound(
  msg: WeixinMessage,
  opts: RenderOptions,
): Promise<RenderedInbound> {
  const items = Array.isArray(msg.item_list) ? msg.item_list : [];
  const media: InboundMedia[] = [];
  const lines: string[] = [];
  let transcript = '';

  if (!items.length) {
    opts.onUnexpected?.('missing-or-empty-item-list', inboundMessageShape(msg));
  }
  for (const [index, item] of items.entries()) {
    const reportedType = inboundWireType(item?.type);
    const text = typeof item?.text_item?.text === 'string' ? item.text_item.text : '';
    const voiceText = typeof item?.voice_item?.text === 'string' ? item.voice_item.text.trim() : '';
    let type = reportedType;
    const report = (reason: string): void => {
      opts.onUnexpected?.(reason, { index, ...inboundItemShape(item) });
    };
    // A transcription can carry the documented text or voice body without a
    // matching discriminator. Do not infer media or internal tool calls.
    if (type === undefined || !KNOWN_ITEM_TYPES.has(type) ||
      type === MessageItemType.TEXT && !text.trim() ||
      type === MessageItemType.VOICE && !voiceText && !item?.voice_item?.media) {
      if (text.trim()) type = MessageItemType.TEXT;
      else if (voiceText) type = MessageItemType.VOICE;
      if (type !== reportedType) report('recovered-item-type');
    }
    if (type === MessageItemType.TEXT) {
      if (text.trim()) lines.push(text);
      else report('empty-text-item');
      continue;
    }
    if (type === MessageItemType.VOICE) {
      const voice = item.voice_item;
      if (voiceText) {
        transcript = voiceText;
        lines.push(`[语音转写] ${transcript}`);
        if (reportedType !== MessageItemType.VOICE || !voice?.media) continue;
      }
      if (!voice?.media) report('voice-item-without-media');
      const seconds = Number(voice?.playtime ?? 0);
      const secondsText = seconds > 0 ? `${(seconds / 1000).toFixed(1)} 秒` : '时长未知';
      if (!opts.downloadVoice) {
        lines.push(`[语音 ${secondsText}，未下载]`);
        continue;
      }
      const fetched = await fetchItem(item, opts, 'voice');
      if (!fetched.ok) {
        lines.push(missText(fetched, `语音 ${secondsText}`, opts.maxBytes));
        continue;
      }
      const declared = VOICE_ENCODINGS[Number(voice?.encode_type)];
      const enc = fetched.mime === OCTET_STREAM ? declared?.name ?? '未知'
        : fetched.mime === declared?.mime ? declared.name : fetched.mime;
      const { voiceConversion, ...file } = fetched;
      const format = voiceConversion ?? `${enc} 编码`;
      lines.push(`[语音 ${secondsText}，${format}，已存为 ${file.path}]`);
      media.push({ ...file, kind: 'voice', label: `[语音 ${secondsText}]` });
      continue;
    }
    if (type === MessageItemType.IMAGE) {
      if (!opts.downloadImages) {
        lines.push('[图片，未下载]');
        continue;
      }
      const fetched = await fetchItem(item, opts, 'image');
      if (!fetched.ok) {
        lines.push(missText(fetched, '图片', opts.maxBytes));
        continue;
      }
      // 尺寸取落盘文件本身。`image_item.thumb_width` 是缩略图尺寸（微信普遍给 210 宽），
      // 拿它当图片尺寸会让上下文里的数字比真图小一个数量级。
      const dims = fetched.width && fetched.height ? ` ${fetched.width}x${fetched.height}` : '';
      lines.push(`[图片${dims}，${sizeText(fetched.bytes)}，已存为 ${fetched.path}]`);
      media.push({ ...fetched, kind: 'image', label: `[图片${dims}]` });
      continue;
    }
    if (type === MessageItemType.FILE) {
      const name = String(item.file_item?.file_name ?? '').trim() || '未命名文件';
      if (!opts.downloadFiles) {
        lines.push(`[文件 ${name}，未下载]`);
        continue;
      }
      const fetched = await fetchItem(item, opts, 'file');
      if (!fetched.ok) {
        lines.push(missText(fetched, `文件 ${name}`, opts.maxBytes));
        continue;
      }
      lines.push(`[文件 ${name}，${sizeText(fetched.bytes)}，已存为 ${fetched.path}]`);
      media.push({ ...fetched, kind: 'file', label: `[文件 ${name}]` });
      continue;
    }
    if (type === MessageItemType.VIDEO) {
      if (!opts.downloadVideo) {
        lines.push('[视频，未下载]');
        continue;
      }
      const fetched = await fetchItem(item, opts, 'video');
      if (!fetched.ok) {
        lines.push(missText(fetched, '视频', opts.maxBytes));
        continue;
      }
      const length = Number(item.video_item?.play_length ?? 0);
      const lengthText = length > 0 ? ` ${(length / 1000).toFixed(1)} 秒` : '';
      lines.push(`[视频${lengthText}，${sizeText(fetched.bytes)}，已存为 ${fetched.path}]`);
      media.push({ ...fetched, kind: 'video', label: `[视频${lengthText}]` });
      continue;
    }
    if (type === MessageItemType.TOOL_CALL_START || type === MessageItemType.TOOL_CALL_RESULT) {
      report('skipped-tool-item');
      continue;
    }
    report('unsupported-item-type');
    if (type !== undefined && type !== 0) lines.push(`[不支持的消息类型 ${type}]`);
  }

  return {
    text: lines.join('\n').trim(),
    media,
    transcript,
    quote: quoteSummary(items.find((item) => item?.ref_msg)),
    raw: sanitizeRaw(msg),
  };
}

/** 媒体取回的结果：成功给路径，失败给一句能区分原因的话。 */
type FetchOutcome =
  | { ok: true; path: string; mime: string; bytes: number; width?: number; height?: number; voiceConversion?: string }
  | { ok: false; reason: 'too-large' | 'no-ref' | 'failed' };

/** 取一个媒体项的字节并按类型落盘。 */
async function fetchItem(
  item: MessageItem,
  opts: RenderOptions,
  kind: 'image' | 'file' | 'video' | 'voice',
): Promise<FetchOutcome> {
  if (!opts.media) return { ok: false, reason: 'failed' };
  try {
    if (kind === 'image') {
      const img = item.image_item;
      const ref = img?.media;
      if (!ref) return { ok: false, reason: 'no-ref' };
      const { bytes } = await opts.media.download({
        encryptedQueryParam: ref.encrypt_query_param,
        fullUrl: ref.full_url,
        aesKeyBase64: ref.aes_key,
        aesKeyHex: img?.aeskey,
        maxBytes: opts.maxBytes,
        cdnOnly: opts.cdnOnly,
      });
      const mime = sniffImageMime(bytes) || 'image/jpeg';
      const path = await saveMedia({
        bytes,
        dir: join(opts.inboxDir, 'images'),
        name: datedFileName(null, 'wx-image', extensionForInbound(mime, bytes)),
      });
      const size = imageSize(bytes);
      return {
        ok: true,
        path,
        mime,
        bytes: bytes.length,
        ...(size ? { width: size.width, height: size.height } : {}),
      };
    }
    if (kind === 'file') {
      const file = item.file_item;
      const ref = file?.media;
      if (!ref) return { ok: false, reason: 'no-ref' };
      const { bytes } = await opts.media.download({
        encryptedQueryParam: ref.encrypt_query_param,
        fullUrl: ref.full_url,
        aesKeyBase64: ref.aes_key,
        maxBytes: opts.maxBytes,
        cdnOnly: opts.cdnOnly,
      });
      const name = String(file?.file_name ?? '');
      const mime = mimeForInbound(bytes, name);
      const path = await saveMedia({
        bytes,
        dir: join(opts.inboxDir, 'files'),
        name: datedFileName(name, 'wx-file', extensionForInbound(mime, bytes)),
      });
      return { ok: true, path, mime, bytes: bytes.length };
    }
    if (kind === 'video') {
      const video = item.video_item;
      const ref = video?.media;
      if (!ref) return { ok: false, reason: 'no-ref' };
      const { bytes } = await opts.media.download({
        encryptedQueryParam: ref.encrypt_query_param,
        fullUrl: ref.full_url,
        aesKeyBase64: ref.aes_key,
        maxBytes: opts.maxBytes,
        cdnOnly: opts.cdnOnly,
      });
      const mime = mimeForInbound(bytes, '', 'video/mp4');
      const path = await saveMedia({
        bytes,
        dir: join(opts.inboxDir, 'videos'),
        name: datedFileName(null, 'wx-video', extensionForInbound(mime, bytes)),
      });
      return { ok: true, path, mime, bytes: bytes.length };
    }
    const voice = item.voice_item;
    const ref = voice?.media;
    if (!ref) return { ok: false, reason: 'no-ref' };
    const { bytes } = await opts.media.download({
      encryptedQueryParam: ref.encrypt_query_param,
      fullUrl: ref.full_url,
      aesKeyBase64: ref.aes_key,
      maxBytes: opts.maxBytes,
      cdnOnly: opts.cdnOnly,
    });
    const dir = join(opts.inboxDir, 'voices');
    let voiceConversion: string | undefined;
    // Tencent's codec ID is only a hint. Conversion needs the matching header.
    const actual = mimeForInbound(bytes, '', undefined, 'voice');
    const mime = actual === OCTET_STREAM ? VOICE_ENCODINGS[Number(voice?.encode_type)]?.mime ?? OCTET_STREAM : actual;
    if (actual === 'audio/silk') {
      try {
        const wav = await silkToWav(bytes, opts.maxBytes);
        const path = await saveMedia({ bytes: wav, dir, name: datedFileName(null, 'wx-voice', '.wav') });
        return { ok: true, path, mime: 'audio/wav', bytes: wav.length, voiceConversion: '已转为 WAV' };
      } catch {
        voiceConversion = 'SILK 转码失败，保留原音频';
      }
    } else if (actual === WECHAT_OPUS_MIME) {
      try {
        const opus = wechatOpusToOgg(bytes, opts.maxBytes);
        const path = await saveMedia({ bytes: opus, dir, name: datedFileName(null, 'wx-voice', '.opus') });
        return { ok: true, path, mime: 'audio/opus', bytes: opus.length, voiceConversion: '已封装为 Ogg Opus' };
      } catch {
        voiceConversion = '微信 Opus 封装失败，保留原音频';
      }
    }
    const path = await saveMedia({
      bytes,
      dir,
      name: datedFileName(null, 'wx-voice', extensionForInbound(mime, bytes)),
    });
    return { ok: true, path, mime, bytes: bytes.length, voiceConversion };
  } catch (err) {
    // 超限与取回失败要分开：前者是配置决定的，后者是网络或服务端问题。
    const tooLarge = err instanceof Error && /超过上限/.test(err.message);
    return { ok: false, reason: tooLarge ? 'too-large' : 'failed' };
  }
}
