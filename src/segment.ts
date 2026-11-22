/**
 * 语义分段：把桌宠一次回复切成多条微信消息。
 *
 * 微信里一句一条才像人在说话。这里按「语义」拆，长度上限交给 `splitText`。
 *
 * ## 四种情况，只按一种分隔符拆
 *
 * ```
 * ① 含 \n                       → 只按 \n 拆
 * ② 无 \n，但有 。／．／.        → 只按句号拆
 * ③ 无 \n 无句号，但有 ！？…～   → 只按这些拆
 * ④ 都没有                      → 不分段
 * ```
 *
 * **段内不再二次拆。** 一处文本里同时有换行和句号时（例如「三层：\n…第一。\n…」），
 * 按换行拆完就结束；若再按句号拆一次，会多出空段、节奏也乱。
 *
 * ## 删谁不删谁
 *
 * - `\n`、`。`(U+3002)、`．`(U+FF0E) 删掉：中文社交软件里句号显得生硬，换行是版式。
 * - 单个 `.`(U+002E) **只在后面跟空白或位于结尾时**才算句号，删掉。否则 `3.14`、
 *   `docs.nonebot.dev`、`report.2026.11.md` 会被切坏。
 * - `！？!?…～~` 与连续 ASCII 点组成的省略号只拆不删；连续语气符号整体保留。
 *
 * ## 哪条规则同时命中
 *
 * 优先级从上往下：只要出现 `\n` 就用换行；只要有中文句号就用句号；
 * 只剩情绪标点才用它。混排时不会两个都用，这正是「只按一次算」的含义。
 */

/** 中文句号与全角句点：无条件当分隔符，且删掉。 */
const HARD_STOPS = new Set(['。', '．']);

/** 情绪标点：只拆不删。 */
const SOFT_STOPS = new Set(['！', '？', '!', '?', '…', '～', '~']);

/** 语气符号后的装饰、emoji 组成字符及右括号/右引号，不吸收下一句的左括号或货币符号。 */
const SOFT_SUFFIX = /[\p{So}\p{M}\p{Emoji_Modifier}\p{Pe}\p{Pf}\u200d\u{e0020}-\u{e007f}]/u;

/** 空白字符（用来判断 ASCII 句点后面是不是断句）。 */
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * 判断位置 `i` 的 ASCII 句点算不算句号。
 *
 * 单点后面是空白或已到结尾才算；连续点属于省略号，不能删掉最后一位。
 */
function isAsciiStop(text: string, i: number): boolean {
  return text[i - 1] !== '.' && isSpace(text[i + 1]);
}

/** 语气标点的长度；连续点整体计数，保护 ../ 与 ..\\ 这类路径片段。 */
function softStopLength(text: string, i: number): number {
  if (SOFT_STOPS.has(text[i]!)) return 1;
  if (text[i] !== '.' || text[i - 1] === '.' || text[i + 1] !== '.') return 0;
  let end = i + 2;
  while (text[end] === '.') end += 1;
  if (/[/\\]/.test(text[i - 1] ?? '') || /[/\\]/.test(text[end] ?? '')) return 0;
  return end - i;
}

/** 只在整串符号之后切一次；符号间的空白保留，末尾的空白留给分段时清理。 */
function softClusterEnd(text: string, start: number, length: number): number {
  let end = start + length;
  while (end < text.length) {
    let next = end;
    while (next < text.length && /[^\S\r\n]/.test(text[next]!)) next += 1;
    if (next === text.length) break;
    const ch = String.fromCodePoint(text.codePointAt(next)!);
    const size = softStopLength(text, next) || (SOFT_SUFFIX.test(ch) ? ch.length : 0);
    if (!size) break;
    end = next + size;
  }
  return end;
}

/** 一个切点：分隔符起点、终点，以及切完要不要把它留在前一段里。 */
interface CutPoint {
  /** 分隔符起点。 */
  start: number;
  /** 分隔符终点（不含）。 */
  end: number;
  /**
   * 切完之后，分隔符本身留在前一段末尾（`keep`），还是删掉。
   *
   * `。`／换行删掉；`！？…～` 保留语气，留在前段里。
   */
  keep: boolean;
}

/** 找出所有切点，按位置升序。 */
function findCuts(text: string, kind: 'newline' | 'stop' | 'soft'): CutPoint[] {
  const cuts: CutPoint[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (kind === 'newline') {
      // 换行是版式，不留在正文里。
      if (ch === '\n') cuts.push({ start: i, end: i + 1, keep: false });
      continue;
    }
    if (kind === 'stop') {
      // 句号删掉：社交软件里带着它显得生硬。
      if (HARD_STOPS.has(ch)) {
        cuts.push({ start: i, end: i + 1, keep: false });
        continue;
      }
      if (ch === '.' && isAsciiStop(text, i)) cuts.push({ start: i, end: i + 1, keep: false });
      continue;
    }
    // kind === 'soft'：只拆不删，标点留在前一段。
    const length = softStopLength(text, i);
    if (length) {
      const end = softClusterEnd(text, i, length);
      cuts.push({ start: i, end, keep: true });
      i = end - 1;
    }
  }
  return cuts;
}

/** 有没有可用的分隔符，以及该用哪一种。 */
function pickKind(text: string): 'newline' | 'stop' | 'soft' | null {
  if (text.includes('\n')) return 'newline';
  if (findCuts(text, 'stop').length > 0) return 'stop';
  if (findCuts(text, 'soft').length > 0) return 'soft';
  return null;
}

/**
 * 去掉一段末尾的句号。
 *
 * 换行模式下，句号紧邻换行而落在段内（`说完了。\n接着讲`）。操作者要的是「句号也去掉」，
 * 所以每段取完后剥掉尾部连续的 `。`／`．`／`.`。
 *
 * **只剥段尾**：`插件成熟度第一。文档齐全。` 里的第一个句号必须留着，否则句子粘在一起。
 * ASCII 连续点是省略号，整串保留；只有单个句点会被剥掉。
 */
function trimStopTail(piece: string): string {
  let out = piece;
  while (out) {
    const last = out[out.length - 1]!;
    if (!HARD_STOPS.has(last) && last !== '.') break;
    if (last === '.' && out[out.length - 2] === '.') break;
    out = out.slice(0, -1);
  }
  return out.trimEnd();
}

/**
 * 按语义把 `text` 拆成若干段。
 *
 * 返回值已去掉分隔符、去掉首尾空白、丢弃空段。不含分隔符时返回单元素数组，
 * 调用方不必区分「拆了」和「没拆」。
 *
 * 这里**只管语义**，不管单条长度上限：结果里某段仍超过微信的 4000 字时，
 * 由调用方交给 `splitText` 再切。
 */
export function splitSegments(text: string, boundaries = text): string[] {
  const source = String(text ?? '');
  const kind = pickKind(boundaries);
  if (!kind) {
    const only = source.trim();
    return only ? [only] : [];
  }

  const cuts = findCuts(boundaries, kind);
  const parts: string[] = [];
  let cursor = 0;

  for (const cut of cuts) {
    // `keep` 为真时把分隔符留在前一段末尾（`！？…～` 的语气不能丢）。
    const end = cut.keep ? cut.end : cut.start;
    let piece = source.slice(cursor, end).trim();
    // 换行模式下，紧邻换行的句号落在段尾，按操作者要求一并去掉。
    if (kind === 'newline') piece = trimUnprotectedTail(piece, boundaries.slice(cursor, end));
    if (piece) parts.push(piece);
    cursor = cut.end;
  }

  let tail = source.slice(cursor).trim();
  if (kind === 'newline') tail = trimUnprotectedTail(tail, boundaries.slice(cursor));
  if (tail) parts.push(tail);

  return parts;
}

function trimUnprotectedTail(piece: string, boundaries: string): string {
  const visible = boundaries.trimEnd();
  const removed = visible.length - trimStopTail(visible).length;
  return removed ? piece.slice(0, -removed).trimEnd() : piece;
}

/** 每条消息发送前的停顿；特长段视作未能断句，直接发送。 */
export function segmentDelayMs(text: string, pace = 1): number {
  const length = Array.from(text).length;
  const value = Number(pace);
  const scale = Number.isFinite(value) ? Math.min(10, Math.max(0, value)) : 1;
  if (length <= 20 || length > 300) return 0;
  return Math.round((length <= 80 ? 600 : 1400) * scale);
}
