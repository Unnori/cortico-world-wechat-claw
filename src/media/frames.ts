/**
 * 视频抽帧 → 拼成一张图。
 *
 * 直接把「抽帧 + 缩放 + 拼接」交给 ffmpeg 一条命令完成：它一次解码、按 `tile` 摆好网格，
 * 比先存 N 张再拼快得多，也不会在磁盘上留下中间文件。
 *
 * ## 为什么拼成一张
 *
 * 每张独立画面都是一次图片输入。4 帧独立发就是 4 份 token；拼成一张只有 1 份，
 * 而且模型看到的是时间相邻的画面，比散图更容易判断「发生了什么变化」。
 *
 * ## 布局
 *
 * 帧数由用户自定义（最多 9），布局跟着帧数走、方向跟着视频走：
 * 竖屏横排、横屏网格。空格由 `tile` 自动补黑。详见 `layout.ts`。
 *
 * ## 失败就说清楚
 *
 * 没有 ffmpeg、读不到分辨率、ffmpeg 退出码非零，都返回原因字符串，
 * 调用方把它写进正文——**不假装看过视频**。
 */
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_FRAMES, parseVideoSize, tileLayout, tileOrderNote } from './layout.ts';

export interface FrameStrip {
  /** 拼好的那张图的本地路径。 */
  path: string;
  /** 字节数。 */
  bytes: number;
  /** 图片 MIME。 */
  mime: string;
  /** 帧数、行列与顺序说明；写进正文让模型知道怎么读这张图。 */
  frames: number;
  cols: number;
  rows: number;
  /** 视频原本的尺寸；读不到时为 null。 */
  videoSize: { width: number; height: number } | null;
  /** 顺序说明，例如「2列×2行，从左上到右下按时间顺序」。 */
  orderNote: string;
}

export interface ExtractStripOptions {
  ffmpegPath: string | null;
  videoPath: string;
  /** 拼图放哪。 */
  outDir: string;
  /** 抽几帧，1..9。 */
  frames: number;
  /** 不知道时长时传 0，由 ffmpeg 自己按关键帧挑。 */
  durationSec?: number;
  timeoutMs?: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 跑 ffmpeg，返回退出码与 stderr。 */
function run(args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const done = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stderr });
    };
    let child;
    try {
      child = spawn(args[0]!, args.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      done(-1);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出。 */
      }
      stderr += '\n（超时）';
      done(-1);
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      stderr = message(err);
      done(-1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code ?? -1);
    });
  });
}

/**
 * 读视频尺寸。
 *
 * ffmpeg-static 不带 ffprobe，只能 `ffmpeg -i` 然后从 stderr 里解析 `1920x1080`。
 * 这条命令故意失败（没有输出参数），所以退出码非零是正常的，只看 stderr。
 */
async function probeVideo(ffmpegPath: string, videoPath: string, timeoutMs: number): Promise<{ width: number; height: number } | null> {
  const result = await run([
    ffmpegPath, '-hide_banner', '-i', videoPath,
  ], Math.min(timeoutMs, 15_000));
  return parseVideoSize(result.stderr);
}

/**
 * 抽帧并拼成一张图。
 *
 * 失败时返回 `{ ok: false, reason }`，绝不抛错。
 */
export async function extractFrameStrip(
  opts: ExtractStripOptions,
): Promise<{ ok: true; strip: FrameStrip; note: string } | { ok: false; reason: string }> {
  if (!opts.ffmpegPath) return { ok: false, reason: '没有可用的 ffmpeg' };

  const wanted = Math.max(1, Math.min(MAX_FRAMES, Math.floor(opts.frames) || 4));
  const timeoutMs = opts.timeoutMs ?? 30_000;

  try {
    await mkdir(opts.outDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `建不了抽帧目录：${message(err)}` };
  }

  const size = await probeVideo(opts.ffmpegPath, opts.videoPath, timeoutMs);
  const portrait = size ? size.height > size.width : false;
  const layout = tileLayout(wanted, portrait);

  const duration = Number(opts.durationSec ?? 0);
  // 采样：时长已知就按「帧数/时长」铺满全程；未知时每秒一帧再截断。
  const fps = duration > 0 ? `${wanted}/${duration}` : '1';
  const filter = [
    `fps=${fps}`,
    `scale='min(${layout.cellEdge},iw)':'min(${layout.cellEdge},ih)':force_original_aspect_ratio=decrease`,
    `tile=${layout.cols}x${layout.rows}`,
  ].join(',');

  const target = join(opts.outDir, `strip-${Date.now().toString(36)}.jpg`);
  const result = await run([
    opts.ffmpegPath,
    '-hide_banner', '-loglevel', 'error',
    '-i', opts.videoPath,
    '-vf', filter,
    '-frames:v', '1',
    '-q:v', '3',
    '-y', target,
  ], timeoutMs);

  if (result.code !== 0) {
    return { ok: false, reason: `ffmpeg 退出码 ${result.code}${result.stderr ? `：${result.stderr.trim().slice(-200)}` : ''}` };
  }

  const info = await stat(target).catch(() => null);
  if (!info || info.size === 0) return { ok: false, reason: 'ffmpeg 没有产出拼图' };

  const orderNote = tileOrderNote(layout);
  const scaleNote = `每格约 ${layout.cellEdge}px，整图约 ${layout.width}×${layout.height}`;
  return {
    ok: true,
    strip: {
      path: target,
      bytes: info.size,
      mime: 'image/jpeg',
      frames: wanted,
      cols: layout.cols,
      rows: layout.rows,
      videoSize: size,
      orderNote,
    },
    note: `拼图 ${layout.cols}×${layout.rows}（${wanted} 帧，${orderNote}；${scaleNote}）`,
  };
}
