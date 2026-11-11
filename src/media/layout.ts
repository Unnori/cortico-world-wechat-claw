/**
 * 帧数与拼图布局的推导。
 *
 * 用户自己决定抽几帧，布局跟着帧数走。这里只做纯计算：给定帧数和画面方向，
 * 算出 `tile` 的行列、单帧最长边，以及拼完会不会超标。
 *
 * 为什么布局要跟着帧数变：帧数多时用长条会拼出超宽图，网格更省面积。
 */

/** 一次视频拼图最多支持几帧。再多解码与拼接会明显变慢。 */
export const MAX_FRAMES = 9;

/** 拼图整体最长边的安全上限（与 DeepSeek 的单边限制留出余量）。 */
const SAFE_EDGE = 4096;

/** 一种布局：几列几行，以及单帧最长边。 */
export interface TileLayout {
  /** 列数。 */
  cols: number;
  /** 行数。 */
  rows: number;
  /** 单帧最长边像素。 */
  cellEdge: number;
  /** 拼完之后的估算尺寸，给日志与正文用。 */
  width: number;
  height: number;
}

/**
 * 按帧数与画面方向选布局。
 *
 * - 竖屏（高大于宽）优先横排，保持每个画面本身的长宽比：
 *   4 帧用 4×1，9 帧用 9×1。
 * - 横屏/方形用网格，尽量接近正方形：
 *   4 帧 2×2、6 帧 3×2、9 帧 3×3。
 *
 * 帧数不是完全平方数时，`tile` 会补黑格，这里不额外处理。
 */
export function tileLayout(frames: number, portrait: boolean): TileLayout {
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(frames) || 1));

  if (portrait) {
    // 竖屏横排：每个格子保持竖条形状，拼出来是一条长横图。
    const cellEdge = cellEdgeForRow(count, SAFE_EDGE, 720);
    return {
      cols: count,
      rows: 1,
      cellEdge,
      width: cellEdge * count,
      height: Math.round(cellEdge * 1.5),
    };
  }

  // 横屏网格：列优先取接近 sqrt 的值。
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellEdge = cellEdgeForGrid(cols, rows, SAFE_EDGE, 720);
  return {
    cols,
    rows,
    cellEdge,
    width: cellEdge * cols,
    height: Math.round((cellEdge * 9) / 16) * rows,
  };
}

/**
 * 横排时单帧能有多宽：总宽不超过安全边，同时给高度留余量。
 *
 * `maxHeight` 是单帧高度上限，用来避免竖屏拼出过于细长的条。
 */
function cellEdgeForRow(count: number, safeEdge: number, maxHeight: number): number {
  const byWidth = Math.floor(safeEdge / count);
  return Math.max(96, Math.min(byWidth, maxHeight));
}

/** 网格时单帧能有多大：宽高都不超过安全边。 */
function cellEdgeForGrid(cols: number, rows: number, safeEdge: number, maxHeight: number): number {
  const byWidth = Math.floor(safeEdge / cols);
  const byHeight = Math.floor((safeEdge * 16) / 9 / rows);
  return Math.max(96, Math.min(byWidth, byHeight, maxHeight));
}

/** 拼图在正文里的顺序说明。 */
export function tileOrderNote(layout: TileLayout): string {
  const { cols, rows } = layout;
  if (rows === 1) return `横向 ${cols} 格，从左到右按时间顺序`;
  if (cols === 1) return `纵向 ${rows} 格，从上到下按时间顺序`;
  return `${cols}列×${rows}行，从左上到右下按时间顺序`;
}

/**
 * 从 `ffmpeg -i` 的输出里读画面尺寸。
 *
 * ffmpeg-static 不带 ffprobe，只能用 stderr 里的 `Stream ... 1920x1080` 这行。
 * 读不出来返回 null，调用方按横向处理。
 */
export function parseVideoSize(stderr: string): { width: number; height: number } | null {
  // 优先找 Video 流那一行，避免撞上别的数字。
  const videoLine = stderr.split(/\r?\n/).find((line) => /Stream #\d+:\d+.*: Video:/.test(line)) ?? stderr;
  const match = /(\d{2,5})x(\d{2,5})/.exec(videoLine);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}
