/**
 * 长文本分段。
 *
 * 微信单条文本上限 4000 字，超了服务端不收。这里把长回复切成多条发，
 * 断开位置优先选段落，其次句子，最后才是硬切——避免把一句话拦腰截断。
 */

/** 句末标点：中文全角与英文半角都算。 */
const SENTENCE_END = /[。！？；…!?;\n]/;

/**
 * 把 `text` 切成每段不超过 `limit` 的若干段。
 * 不超限时原样返回单元素数组，调用方不必区分两种情况。
 */
export function splitText(text: string, limit: number): string[] {
  const max = Math.max(1, Math.floor(limit));
  if (text.length <= max) return [text];

  const parts: string[] = [];
  let rest = text;

  while (rest.length > max) {
    const window = rest.slice(0, max);
    // 段落优先：最后一个换行。
    let cut = window.lastIndexOf('\n');
    // 其次句子：窗口内最后一个句末标点。
    if (cut < max * 0.5) {
      for (let i = window.length - 1; i >= 0; i -= 1) {
        if (SENTENCE_END.test(window[i]!)) {
          cut = i + 1;
          break;
        }
      }
    }
    // 都不合适就硬切，但别切在代理对中间。
    if (cut < max * 0.3) cut = safeCut(rest, max);

    const piece = rest.slice(0, cut).trimEnd();
    if (piece) parts.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : [text];
}

/** 硬切时不要把一个 UTF-16 代理对切成两半。 */
function safeCut(text: string, index: number): number {
  const code = text.charCodeAt(index - 1);
  // 高代理位（0xD800-0xDBFF）后面本该跟低代理位；切在它后面会拆开一个字符。
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

/** 出站通道：微信按媒体种类分开显示，附件名和通道要对得上。 */
export type OutboundChannel = 'image' | 'video' | 'file';

/**
 * 按 MIME 决定走哪条通道。
 *
 * 通道由真实种类决定：`wechat_send_image` 拿到非图片、`wechat_send_file` 拿到图片或视频时，
 * 都按实际内容走，免得微信里显示成下载附件。调用方据返回值如实回执。
 */
export function pickChannel(mime: string): OutboundChannel {
  const base = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (base.startsWith('video/')) return 'video';
  if (base.startsWith('image/')) return 'image';
  return 'file';
}
