/**
 * 入站消息的可读化、媒体落地与脱敏。
 *
 * `context_token` 是回复凭据，绝不进事件 meta、日志或模型上下文。
 * 媒体按类型下载解密后落到部署数据目录，路径写进事件正文，字节作为附件交给模型
 * （模型不支持该 MIME 时 Core 只发 `fallbackText`）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { extensionForInbound, mimeFromFilename, sniffImageMime } from './mime.ts';
import type { MediaTransfer } from './media.ts';
import { MessageItemType, type MessageItem, type WeixinMessage } from './types.ts';

export interface InboundMedia {
  /** 落盘的本地绝对路径。 */
  path: string;
  mime: string;
  /** 进上下文的一句话，如 `[图片 640x480]`。 */
  label: string;
  kind: 'image' | 'file' | 'video' | 'voice';
  bytes: number;
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
  const ms = Number(msg?.create_time_ms);
  if (Number.isFinite(ms) && ms > 0) return ms;
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

/** 被引用消息的摘要；新版客户端只给 ID 时返回空串。 */
export function quoteSummary(item: MessageItem | undefined): string {
  const ref = item?.ref_msg;
  if (!ref) return '';
  const parts: string[] = [];
  if (ref.title?.trim()) parts.push(ref.title.trim());
  const inner = ref.message_item;
  if (inner) {
    if (inner.type === MessageItemType.TEXT) parts.push(String(inner.text_item?.text ?? '').trim());
    else if (inner.type === MessageItemType.IMAGE) parts.push('[图片]');
    else if (inner.type === MessageItemType.FILE) parts.push(`[文件 ${inner.file_item?.file_name ?? ''}]`.trim());
    else if (inner.type === MessageItemType.VIDEO) parts.push('[视频]');
    else if (inner.type === MessageItemType.VOICE) parts.push('[语音]');
  }
  const text = parts.filter(Boolean).join(' | ');
  if (text) return text;
  return ref.svr_id ? `[引用消息 #${ref.svr_id}]` : '[引用消息]';
}

/** 语音编码类型 → 说明。 */
function voiceEncodingName(encodeType: number | undefined): string {
  switch (Number(encodeType)) {
    case 1: return 'pcm';
    case 2: return 'adpcm';
    case 3: return 'feature';
    case 4: return 'speex';
    case 5: return 'amr';
    case 6: return 'silk';
    case 7: return 'mp3';
    case 8: return 'ogg-speex';
    default: return '未知编码';
  }
}

export interface RenderOptions {
  media: MediaTransfer | null;
  /** 媒体落盘目录，绝对路径。 */
  mediaDir: string;
  /** 每类媒体是否下载。关掉时只留占位文字。 */
  downloadImages: boolean;
  downloadFiles: boolean;
  downloadVoice: boolean;
  downloadVideo: boolean;
  /** 单条媒体字节上限；超过就只留占位。 */
  maxBytes: number;
}

/** 落盘并返回媒体描述；失败时返回一句说明，不抛错——一条消息不该因为附件失败整条丢掉。 */
async function saveMedia(params: {
  bytes: Buffer;
  mime: string;
  ext: string;
  dir: string;
  prefix: string;
}): Promise<string> {
  await mkdir(params.dir, { recursive: true });
  const name = `${params.prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${params.ext}`;
  const filePath = join(params.dir, name);
  await writeFile(filePath, params.bytes);
  return filePath;
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

  for (const item of items) {
    const type = Number(item?.type);
    if (type === MessageItemType.TEXT) {
      const text = String(item.text_item?.text ?? '');
      if (text.trim()) lines.push(text);
      continue;
    }
    if (type === MessageItemType.VOICE) {
      const voice = item.voice_item;
      if (voice?.text?.trim()) {
        transcript = voice.text.trim();
        lines.push(`[语音转写] ${transcript}`);
      }
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
      const enc = voiceEncodingName(voice?.encode_type);
      lines.push(`[语音 ${secondsText}，${enc} 编码，已存为 ${fetched.path}]`);
      media.push({ ...fetched, kind: 'voice', label: `[语音 ${secondsText}]` });
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
      const dims = item.image_item?.thumb_width && item.image_item?.thumb_height
        ? ` ${item.image_item.thumb_width}x${item.image_item.thumb_height}`
        : '';
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
      continue;
    }
    if (type) lines.push(`[不支持的消息类型 ${type}]`);
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
  | { ok: true; path: string; mime: string; bytes: number }
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
      });
      const mime = sniffImageMime(bytes) || 'image/jpeg';
      const path = await saveMedia({
        bytes,
        mime,
        ext: extensionForInbound(mime, bytes),
        dir: join(opts.mediaDir, 'images'),
        prefix: 'wx-image',
      });
      return { ok: true, path, mime, bytes: bytes.length };
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
      });
      const name = String(file?.file_name ?? '');
      const mime = mimeFromFilename(name || 'file.bin');
      const path = await saveMedia({
        bytes,
        mime,
        ext: extensionForInbound(mime, bytes),
        dir: join(opts.mediaDir, 'files'),
        prefix: 'wx-file',
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
      });
      const path = await saveMedia({
        bytes,
        mime: 'video/mp4',
        ext: '.mp4',
        dir: join(opts.mediaDir, 'videos'),
        prefix: 'wx-video',
      });
      return { ok: true, path, mime: 'video/mp4', bytes: bytes.length };
    }
    const voice = item.voice_item;
    const ref = voice?.media;
    if (!ref) return { ok: false, reason: 'no-ref' };
    const { bytes } = await opts.media.download({
      encryptedQueryParam: ref.encrypt_query_param,
      fullUrl: ref.full_url,
      aesKeyBase64: ref.aes_key,
      maxBytes: opts.maxBytes,
    });
    const path = await saveMedia({
      bytes,
      mime: 'audio/silk',
      ext: '.silk',
      dir: join(opts.mediaDir, 'voices'),
      prefix: 'wx-voice',
    });
    return { ok: true, path, mime: 'audio/silk', bytes: bytes.length };
  } catch (err) {
    // 超限与取回失败要分开：前者是配置决定的，后者是网络或服务端问题。
    const tooLarge = err instanceof Error && /超过上限/.test(err.message);
    return { ok: false, reason: tooLarge ? 'too-large' : 'failed' };
  }
}
