/**
 * 按扩展名判 MIME、反向取扩展名，以及读图片文件头的像素尺寸。
 *
 * 微信按 MIME 决定一条媒体走图片、视频还是文件通道（见 `sendMedia`），
 * 所以这张表决定「发出去是一张图还是一个附件」。
 */
import { extname } from 'node:path';

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
};

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

export const OCTET_STREAM = 'application/octet-stream';

/** 文件名 → MIME；不认识的扩展名按二进制。 */
export function mimeFromFilename(filename: string): string {
  return EXT_TO_MIME[extname(String(filename ?? '')).toLowerCase()] ?? OCTET_STREAM;
}

/** MIME → 扩展名；不认识时 `.bin`。 */
export function extensionFromMime(mime: string): string {
  const base = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[base] ?? '.bin';
}

/** 按魔数猜图片类型，兜住入站图片没有文件名的情况。 */
export function sniffImageMime(bytes: Uint8Array): string {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return '';
}

/** 入站媒体落盘时用的扩展名：先按 MIME，再按魔数。 */
export function extensionForInbound(mime: string, bytes: Uint8Array): string {
  if (mime && mime !== OCTET_STREAM) return extensionFromMime(mime);
  return extensionFromMime(sniffImageMime(bytes) || OCTET_STREAM);
}

/** 读图片文件头里的像素尺寸；格式认不出或数据不够时返回 null。 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const be16 = (i: number): number => (b[i]! << 8) | b[i + 1]!;
  const be32 = (i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  const le16 = (i: number): number => b[i]! | (b[i + 1]! << 8);
  const le32 = (i: number): number => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: be32(16), height: be32(20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: le16(6), height: le16(8) };
  }
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return webpSize(b, le16, le32);
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    return { width: le32(18), height: Math.abs(le32(22) | 0) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  return null;
}

/** JPEG 的尺寸在 SOF 段里；逐段走到 SOF 为止，跳过填充字节与独立的 RSTn。 */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    // 到了扫描数据或文件尾还没见到 SOF，说明这个文件没有可读的尺寸。
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    if (length < 2) return null;
    // SOF0–SOF15 里 C4(DHT)、C8(JPG)、CC(DAC) 不是帧头。
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    i += 2 + length;
  }
  return null;
}

/** WebP 三种子格式各有一套宽高编码。 */
function webpSize(
  b: Uint8Array,
  le16: (i: number) => number,
  le32: (i: number) => number,
): { width: number; height: number } | null {
  const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (chunk === 'VP8X') {
    return {
      width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)),
      height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)),
    };
  }
  if (chunk === 'VP8 ') {
    // 关键帧起始码 9D 01 2A 之后是 14 位宽、14 位高。
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = le32(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}
