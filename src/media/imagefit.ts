/**
 * 图片投递前的闸门。
 *
 * 上游 Provider 对图片有硬限制（DeepSeek：单边 ≤8192、单图 ≤32 MB、连续 ≤15 张）。
 * 超过就整条请求被拒，用户看到的是 HTTP 400 和「发送了不支持的图片」。
 * 所以这里在**交给模型之前**先拦一道，并且**说清为什么拦**——静默吞掉会让用户以为消息丢了。
 *
 * ## 两条路径
 *
 * - **没装 ffmpeg**：只能判断，不能压缩。超限的图不附，正文写明哪一项超标。
 * - **装了 ffmpeg**：超限的先缩到最长边上限，再转 JPEG 控质量；仍超标就逐级降质；
 *   再不行才放弃，同样写明原因。
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { imageSize } from '../protocol/mime.ts';

/** 我们的安全线：单图体积、单边尺寸、单次投递最多几张。都比上游限制更严。 */
export interface ImageLimits {
  /** 单图体积上限，字节。 */
  maxBytes: number;
  /** 单图最长边上限，像素。 */
  maxEdge: number;
  /** 一次事件投递最多附几张图。 */
  maxCount: number;
}

/** 一张图过闸门的结果。 */
export type FitResult =
  | { ok: true; path: string; mime: string; note?: string }
  | { ok: false; reason: string };

/** 逐级降质用的 JPEG 质量；越往后越糊、越小。 */
const QUALITY_STEPS = [3, 6, 9];

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 跑一次 ffmpeg，收集 stderr 尾部用于诊断。 */
function runFfmpeg(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, stderr: stderr.slice(-400) });
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      stderr = message(err);
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出。 */
      }
      stderr += '\n（超时）';
      done(false);
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      stderr += message(err);
      done(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

/** 尺寸的合理上限：超过这个值基本可以断定头部解析错了，不是真图。 */
const SANE_EDGE = 100_000;

/** 人类可读的字节数。 */
function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * 读出来的尺寸可信吗。
 *
 * 损坏的 PNG／被截断的文件会让 `imageSize` 从无意义的字节里读出天文数字
 * （实测伪造的 PNG 能读成 17 亿像素）。拿这种尺寸去判定「超限」，会把一张
 * 实际只有几十字节的小图当成长图丢掉。所以这里做一次合理性检查：
 * 非正、超过 `SANE_EDGE`、或者像素总数离谱，都当读不出来。
 */
function saneSize(width: number, height: number): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  if (width > SANE_EDGE || height > SANE_EDGE) return null;
  // 100 亿像素的图不存在；这个量级只可能是解析错。
  if (width * height > 1e10) return null;
  return { width, height };
}

/** 读一份图片的元数据；读不出尺寸时 `width`/`height` 为 undefined。 */
export interface ImageProbe {
  path: string;
  bytes: number;
  mime: string;
  width?: number;
  height?: number;
}

/**
 * 先看元数据，再决定要不要读内容。
 *
 * 体积从文件系统拿，尺寸只读文件头（`imageSize` 只解析 SOF/IHDR 之类的头部，
 * 不会把整张图读进内存）。这样 32 MB 的图也不会先把内存占满。
 */
export async function probeImage(path: string, mime: string): Promise<ImageProbe | null> {
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  const probe: ImageProbe = { path, bytes: info.size, mime };

  // 尺寸只对图片有意义；读头部的很小一段就够。
  if (mime.startsWith('image/')) {
    const { open } = await import('node:fs/promises');
    const handle = await open(path, 'r').catch(() => null);
    if (handle) {
      try {
        // 头部通常在前 64 KB 内（WebP/JPEG 最多再往后一点）。
        const buffer = Buffer.alloc(Math.min(info.size, 96 * 1024));
        await handle.read(buffer, 0, buffer.length, 0);
        const size = imageSize(buffer);
        const sane = size ? saneSize(size.width, size.height) : null;
        if (sane) {
          probe.width = sane.width;
          probe.height = sane.height;
        }
      } finally {
        await handle.close().catch(() => {});
      }
    }
  }
  return probe;
}

/** 判断一张图超了哪一条；都没超返回 null。 */
export function limitBreach(probe: ImageProbe, limits: ImageLimits): string | null {
  if (probe.bytes > limits.maxBytes) {
    return `体积 ${humanBytes(probe.bytes)}，超过 ${humanBytes(limits.maxBytes)} 上限`;
  }
  const { width, height } = probe;
  if (width && height) {
    const longest = Math.max(width, height);
    if (longest > limits.maxEdge) {
      return `尺寸 ${width}×${height}，最长边超过 ${limits.maxEdge} 像素`;
    }
  }
  return null;
}

/**
 * 把超限的图压到限制内。
 *
 * 先缩到最长边，再按 `QUALITY_STEPS` 逐级降质；每一级都重新查体积。
 * 全部失败返回 `null`，由调用方决定怎么写说明。
 */
async function shrink(
  ffmpegPath: string,
  probe: ImageProbe,
  limits: ImageLimits,
  outDir: string,
): Promise<{ path: string; mime: string; bytes: number } | null> {
  // 产物目录必须先建好，否则 ffmpeg 写不进去，三次降质都会失败。
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(outDir, { recursive: true });
  } catch {
    /* 建不了就让下面的 runFfmpeg 失败，返回 null。 */
  }

  // basename 的第二个参数只接受字符串后缀，不接正则，所以先剥扩展名。
  const stem = basename(probe.path).replace(/\.([^.]+)$/, '');
  const target = join(outDir, `${stem}-fit-${Date.now().toString(36)}.jpg`);
  // 缩放进 JPEG：`-2` 保证高宽为偶数，避免某些编码器报参数错。
  const scaleFilter = `scale='min(${limits.maxEdge},iw)':'min(${limits.maxEdge},ih)':force_original_aspect_ratio=decrease`;

  for (const quality of QUALITY_STEPS) {
    const result = await runFfmpeg(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', probe.path,
      '-vf', scaleFilter,
      '-q:v', String(quality),
      '-y', target,
    ], 20_000);
    if (!result.ok) continue;
    const info = await stat(target).catch(() => null);
    if (!info) continue;
    if (info.size <= limits.maxBytes) {
      return { path: target, mime: 'image/jpeg', bytes: info.size };
    }
  }

  // 全部降质都还超标：把这份垃圾清掉，别留在磁盘里。
  await rmQuiet(target);
  return null;
}

async function rmQuiet(path: string): Promise<void> {
  try {
    const { rm } = await import('node:fs/promises');
    await rm(path, { force: true });
  } catch {
    /* 删不掉就算了。 */
  }
}

/**
 * 让一张图过闸门。
 *
 * 返回 `ok: true` 时给出**实际可以附上的**路径（可能已经是压缩后的新文件）。
 * 返回 `ok: false` 时 `reason` 会直接写进正文，让用户知道哪一项超标。
 */
export async function fitImage(params: {
  probe: ImageProbe;
  limits: ImageLimits;
  /** 有值才能压缩；null 表示用户没装 ffmpeg。 */
  ffmpegPath: string | null;
  /** 压缩产物放哪。 */
  outDir: string;
}): Promise<FitResult> {
  const breach = limitBreach(params.probe, params.limits);
  if (!breach) return { ok: true, path: params.probe.path, mime: params.probe.mime };

  if (!params.ffmpegPath) {
    return { ok: false, reason: `${breach}，且没有 ffmpeg 可压缩` };
  }

  const shrunk = await shrink(params.ffmpegPath, params.probe, params.limits, params.outDir);
  if (!shrunk) {
    return { ok: false, reason: `${breach}，压缩后仍超标` };
  }

  // 说明里写清原始超标项与压缩结果。体积变大时如实说变大——
  // PNG 转 JPEG 在纯色图上确实可能更大，藏起来会让操作者困惑。
  const saved = params.probe.bytes - shrunk.bytes;
  const change = saved >= 0 ? `省 ${humanBytes(saved)}` : `体积增至 ${humanBytes(shrunk.bytes)}`;
  return {
    ok: true,
    path: shrunk.path,
    mime: shrunk.mime,
    note: `${breach}，已压缩为 ${humanBytes(shrunk.bytes)}（${change}）`,
  };
}

/** 超出数量额度的说明。 */
export function overCountNote(index: number, limits: ImageLimits): string {
  return `超出本次投递 ${limits.maxCount} 张的上限，这是第 ${index + 1} 张`;
}
