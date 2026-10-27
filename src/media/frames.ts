/**
 * 视频抽帧。
 *
 * 用 ffmpeg 按时间均匀取若干帧，缩放后存成 JPEG，交给模型当图片看。
 * ffmpeg 不存在时返回空数组并给出原因——调用方据此把「没抽帧」写进上下文，不假装看过视频。
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface FrameExtraction {
  /** 抽到的帧：本地路径与尺寸。 */
  frames: Array<{ path: string; bytes: number }>;
  /** 没抽成的原因；抽到了就是空串。 */
  reason: string;
}

export interface ExtractFramesOptions {
  ffmpegPath: string | null;
  videoPath: string;
  /** 帧放哪。 */
  outDir: string;
  /** 取几帧。 */
  count: number;
  /** 每帧最长边缩到多少像素。 */
  maxEdge: number;
  /** 单帧 JPEG 质量，2 最好 31 最差。 */
  quality?: number;
  /** 视频时长（秒）；不知道就传 0，由 ffmpeg 自己找关键帧。 */
  durationSec?: number;
  timeoutMs?: number;
}

/** 跑 ffmpeg，返回退出码；超时按失败处理并杀掉进程。 */
function runFfmpeg(args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
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
      resolve({ code: -1, stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出。 */
      }
      done(-1);
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      // 只留最后一段，够写失败原因就行。
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      stderr = err.message;
      done(-1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code ?? -1);
    });
  });
}

/**
 * 抽帧。失败时返回空数组与原因，不抛错。
 *
 * 用 `fps` 表达式按「总时长 / 帧数」采样，比 `-vf select` 的关键帧模式更可控：
 * 视频没有关键帧元数据时也能出帧。
 */
export async function extractFrames(opts: ExtractFramesOptions): Promise<FrameExtraction> {
  if (!opts.ffmpegPath) {
    return { frames: [], reason: '没有可用的 ffmpeg' };
  }
  const count = Math.max(1, Math.min(12, Math.floor(opts.count) || 4));
  const maxEdge = Math.max(64, Math.min(2048, Math.floor(opts.maxEdge) || 640));
  const quality = Math.max(2, Math.min(31, Math.floor(opts.quality ?? 4)));
  const timeoutMs = opts.timeoutMs ?? 60_000;

  try {
    await mkdir(opts.outDir, { recursive: true });
  } catch (err) {
    return { frames: [], reason: `建不了抽帧目录：${message(err)}` };
  }

  // 先清掉上一次的残留，免得把旧帧当成本次的。
  try {
    for (const name of await readdir(opts.outDir)) {
      if (name.startsWith('frame-')) await rm(join(opts.outDir, name), { force: true });
    }
  } catch {
    /* 目录本来就没有。 */
  }

  const duration = Number(opts.durationSec ?? 0);
  // 均匀采样：整个视频铺 count 个采样点。时长未知时退化成每秒一帧再截断。
  const filter = duration > 0
    ? `fps=${(count / duration).toFixed(6)},scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`
    : `fps=1,scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`;

  const outPattern = join(opts.outDir, 'frame-%03d.jpg');
  const args = [
    opts.ffmpegPath,
    '-hide_banner',
    '-loglevel', 'error',
    '-i', opts.videoPath,
    '-vf', filter,
    '-frames:v', String(count),
    '-q:v', String(quality),
    '-y',
    outPattern,
  ];

  const result = await runFfmpeg(args, timeoutMs);
  if (result.code !== 0) {
    return { frames: [], reason: `ffmpeg 退出码 ${result.code}${result.stderr ? `：${result.stderr.trim().slice(-300)}` : ''}` };
  }

  try {
    const names = (await readdir(opts.outDir))
      .filter((name) => /^frame-\d+\.jpg$/.test(name))
      .sort();
    if (!names.length) return { frames: [], reason: 'ffmpeg 没有产出帧' };

    const frames: Array<{ path: string; bytes: number }> = [];
    for (const name of names.slice(0, count)) {
      const path = join(opts.outDir, name);
      const bytes = await readFile(path).catch(() => null);
      if (bytes) frames.push({ path, bytes: bytes.length });
    }
    if (!frames.length) return { frames: [], reason: '抽出的帧读不出来' };
    return { frames, reason: '' };
  } catch (err) {
    return { frames: [], reason: `读不到抽帧结果：${message(err)}` };
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
