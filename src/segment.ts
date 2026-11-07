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
 * - `.`(U+002E) **只在后面跟空白或位于结尾时**才算句号，删掉。否则 `3.14`、
 *   `docs.nonebot.dev`、`report.2026.11.md` 会被切坏。
 * - `！？!?…～~` 只拆不删：它们带情绪，删了语气就变平。
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

/** 空白字符（用来判断 ASCII 句点后面是不是断句）。 */
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * 判断位置 `i` 的 ASCII 句点算不算句号。
 *
 * 只有「后面是空白或已到结尾」才算。这样 `3.14`、`a.txt`、`example.com` 不会被拆。
 */
function isAsciiStop(text: string, i: number): boolean {
  return isSpace(text[i + 1]);
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
    if (SOFT_STOPS.has(ch)) {
      // 成对的「！？」算一处，别拆两个空段。
      const next = text[i + 1];
      if (next && SOFT_STOPS.has(next) && ch + next === '！？') {
        cuts.push({ start: i, end: i + 2, keep: true });
        i += 1;
        continue;
      }
      cuts.push({ start: i, end: i + 1, keep: true });
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
 * 按语义把 `text` 拆成若干段。
 *
 * 返回值已去掉分隔符、去掉首尾空白、丢弃空段。不含分隔符时返回单元素数组，
 * 调用方不必区分「拆了」和「没拆」。
 *
 * 这里**只管语义**，不管单条长度上限：结果里某段仍超过微信的 4000 字时，
 * 由调用方交给 `splitText` 再切。
 */
export function splitSegments(text: string): string[] {
  const source = String(text ?? '');
  const kind = pickKind(source);
  if (!kind) {
    const only = source.trim();
    return only ? [only] : [];
  }

  const cuts = findCuts(source, kind);
  const parts: string[] = [];
  let cursor = 0;

  for (const cut of cuts) {
    // `keep` 为真时把分隔符留在前一段末尾（`！？…～` 的语气不能丢）。
    const piece = source.slice(cursor, cut.keep ? cut.end : cut.start).trim();
    if (piece) parts.push(piece);
    cursor = cut.end;
  }
  const tail = source.slice(cursor).trim();
  if (tail) parts.push(tail);

  return parts;
}

/** 分段延时的两种口径。 */
export type SegmentDelay = { mode: 'fixed'; seconds: number } | { mode: 'random'; min: number; max: number };

/**
 * 从配置段里取出延时口径。
 *
 * 数值容错：负数归零、`NaN` 归零；随机区间写反了由 `segmentDelayMs` 换回来。
 */
export function segmentDelayOf(cfg: {
  segmentDelayMode?: string;
  segmentDelayFixedSec?: number;
  segmentDelayMinSec?: number;
  segmentDelayMaxSec?: number;
}): SegmentDelay {
  if (cfg.segmentDelayMode === 'random') {
    return {
      mode: 'random',
      min: numOr0(cfg.segmentDelayMinSec),
      max: numOr0(cfg.segmentDelayMaxSec),
    };
  }
  return { mode: 'fixed', seconds: numOr0(cfg.segmentDelayFixedSec) };
}

const numOr0 = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * 算第 `index` 段发完之后该等多久（毫秒）。
 *
 * `index` 从 0 开始；最后一段之后不需要等待，调用方自己判断。
 * 这里只做**纯计算**，不 sleep，方便测试与调用方控制总时长。
 *
 * 随机口径用 `random` 注入，默认 `Math.random`。
 */
export function segmentDelayMs(delay: SegmentDelay, index: number, random: () => number = Math.random): number {
  void index;
  if (delay.mode === 'fixed') {
    return Math.max(0, Math.round(delay.seconds * 1000));
  }
  const lo = Math.min(delay.min, delay.max);
  const hi = Math.max(delay.min, delay.max);
  const span = Math.max(0, hi - lo);
  const pick = lo + span * Math.min(Math.max(random(), 0), 1);
  return Math.max(0, Math.round(pick * 1000));
}
