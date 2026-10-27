/**
 * ffmpeg 的解析与显式安装。
 *
 * 核心不变式：**解析永不下载**，只有 `installFfmpeg`（面板按钮）才会联网。
 * 下载用注入的 fetch 打桩，但解压、写盘、`-version` 校验、抽帧都走真实实现。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

import {
  cachedFfmpegPath,
  ensureFfmpeg,
  ffmpegAssetName,
  ffmpegDownloadUrl,
  installFfmpeg,
  installedSize,
  probeFfmpeg,
  removeFfmpeg,
} from '../src/media/ffmpeg.ts';
import { extractFrames } from '../src/media/frames.ts';

let scratchDir = '';

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'claw-ffmpeg-'));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

/** 一个不联网的 fetch，被调用就记一笔。 */
function trapFetch(): { impl: typeof globalThis.fetch; called: () => boolean } {
  let called = false;
  const impl = (async () => {
    called = true;
    throw new Error('不该联网');
  }) as unknown as typeof globalThis.fetch;
  return { impl, called: () => called };
}

/** 找一个本机真实 ffmpeg；没有就返回 null，相关用例跳过。 */
function realFfmpeg(): string | null {
  const candidates = [process.env.WECHAT_CLAW_TEST_FFMPEG, 'ffmpeg'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-version'], { stdio: 'ignore', windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  return null;
}

describe('ffmpeg 发布资源', () => {
  it('按平台与架构拼出文件名', () => {
    expect(ffmpegAssetName('win32', 'x64')).toBe('ffmpeg-win32-x64.gz');
    expect(ffmpegAssetName('win32', 'arm64')).toBe('ffmpeg-win32-arm64.gz');
    expect(ffmpegAssetName('darwin', 'arm64')).toBe('ffmpeg-darwin-arm64.gz');
    expect(ffmpegAssetName('linux', 'x64')).toBe('ffmpeg-linux-x64.gz');
  });

  it('不支持的组合返回 null，不瞎猜地址', () => {
    expect(ffmpegAssetName('win32', 'mips')).toBeNull();
    expect(ffmpegAssetName('freebsd' as NodeJS.Platform, 'x64')).toBeNull();
  });

  it('下载地址指向 ffmpeg-static 的发布', () => {
    const url = ffmpegDownloadUrl('ffmpeg-win32-x64.gz');
    expect(url).toContain('eugeneware/ffmpeg-static/releases/download');
    expect(url.endsWith('ffmpeg-win32-x64.gz')).toBe(true);
  });
});

describe('ensureFfmpeg 永不下载', () => {
  it('off 直接给「已关闭」，不碰磁盘', async () => {
    const result = await ensureFfmpeg({ source: 'off', binDir: join(scratchDir, 'bin') });
    expect(result.path).toBeNull();
    expect(result.origin).toBe('none');
    expect(result.detail).toContain('关闭');
    expect(existsSync(join(scratchDir, 'bin'))).toBe(false);
  });

  it('path 模式下 PATH 里没有就如实报告', async () => {
    const saved = process.env.PATH;
    process.env.PATH = join(scratchDir, 'empty-path');
    try {
      const result = await ensureFfmpeg({ source: 'path', binDir: join(scratchDir, 'bin') });
      expect(result.path).toBeNull();
      expect(result.detail).toContain('PATH');
    } finally {
      process.env.PATH = saved;
    }
  });

  it('auto 模式下什么都没有时降级，不抛错也不联网', async () => {
    const saved = process.env.PATH;
    process.env.PATH = join(scratchDir, 'empty-path');
    try {
      const result = await ensureFfmpeg({ source: 'auto', binDir: join(scratchDir, 'bin') });
      expect(result.path).toBeNull();
      expect(result.origin).toBe('none');
      // 解析阶段不该建目录，更不该下载。
      expect(existsSync(join(scratchDir, 'bin'))).toBe(false);
    } finally {
      process.env.PATH = saved;
    }
  });

  it('已安装的那份坏了时提示重新下载', async () => {
    const binDir = join(scratchDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(cachedFfmpegPath(binDir), Buffer.from('not an executable'));
    const saved = process.env.PATH;
    process.env.PATH = join(scratchDir, 'empty-path');
    try {
      const result = await ensureFfmpeg({ source: 'auto', binDir });
      expect(result.path).toBeNull();
      expect(result.detail).toContain('重新下载');
    } finally {
      process.env.PATH = saved;
    }
  });

  it('auto 优先用 PATH 里的，即使已装了一份', async () => {
    const ffmpeg = realFfmpeg();
    if (!ffmpeg) return;
    const binDir = join(scratchDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    // 放一个坏文件在「已安装」位置，若实现优先用它就会失败。
    writeFileSync(cachedFfmpegPath(binDir), Buffer.from('broken'));
    const saved = process.env.PATH;
    process.env.PATH = `${join(ffmpeg, '..')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;
    try {
      const result = await ensureFfmpeg({ source: 'auto', binDir });
      expect(result.origin).toBe('path');
      expect(result.version).toContain('ffmpeg version');
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('installFfmpeg 由按钮触发', () => {
  it('拿不到压缩包时给出 HTTP 原因，不留残文件', async () => {
    const binDir = join(scratchDir, 'bin');
    const phases: string[] = [];
    const result = await installFfmpeg({
      binDir,
      onProgress: (p) => phases.push(p.phase),
      fetchImpl: (async () => new Response('nope', { status: 502 })) as unknown as typeof globalThis.fetch,
    });
    expect(result.path).toBeNull();
    expect(result.detail).toContain('502');
    expect(phases).toContain('failed');
    const leftovers = existsSync(binDir) ? readdirSync(binDir) : [];
    expect(leftovers).toEqual([]);
  });

  it('内容太小被判为错误页并删除', async () => {
    const binDir = join(scratchDir, 'bin');
    const tiny = gzipSync(Buffer.from('not really ffmpeg'));
    const result = await installFfmpeg({
      binDir,
      onProgress: () => {},
      fetchImpl: (async () => new Response(tiny, { status: 200 })) as unknown as typeof globalThis.fetch,
    });
    expect(result.path).toBeNull();
    expect(result.detail).toMatch(/太小|无法运行/);
    expect(readdirSync(binDir).filter((n) => n.includes('ffmpeg'))).toEqual([]);
  });

  it('不支持的平台给出明确原因，不去下载', async () => {
    let called = false;
    const result = await installFfmpeg({
      binDir: join(scratchDir, 'bin'),
      onProgress: () => {},
      platform: 'aix' as NodeJS.Platform,
      arch: 'x64',
      fetchImpl: (async () => {
        called = true;
        return new Response('');
      }) as unknown as typeof globalThis.fetch,
    });
    expect(called).toBe(false);
    expect(result.path).toBeNull();
    expect(result.detail).toContain('aix');
  });

  it('取消后不留残文件', async () => {
    const binDir = join(scratchDir, 'bin');
    const controller = new AbortController();
    controller.abort();
    const result = await installFfmpeg({
      binDir,
      onProgress: () => {},
      signal: controller.signal,
      fetchImpl: (async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }) as unknown as typeof globalThis.fetch,
    });
    expect(result.path).toBeNull();
    expect(result.detail).toContain('取消');
    expect(existsSync(binDir) ? readdirSync(binDir).filter((n) => n.includes('ffmpeg')) : []).toEqual([]);
  });

  it('进度里带已下载字节与百分比', async () => {
    const binDir = join(scratchDir, 'bin');
    const seen: Array<{ received: number; total: number; percent: number | null }> = [];
    const tiny = gzipSync(Buffer.from('x'));
    await installFfmpeg({
      binDir,
      onProgress: (p) => {
        if (p.phase === 'downloading') seen.push({ received: p.received, total: p.total, percent: p.percent });
      },
      fetchImpl: (async () => new Response(tiny, {
        status: 200,
        headers: { 'content-length': String(tiny.length) },
      })) as unknown as typeof globalThis.fetch,
    });
    // 至少报告过一次下载进度；总量来自 content-length。
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]!.total).toBe(tiny.length);
  });
});

describe('已安装那份的管理', () => {
  it('没装时 installedSize 是 0，remove 返回 false', async () => {
    const binDir = join(scratchDir, 'bin');
    expect(await installedSize(binDir)).toBe(0);
    expect(await removeFfmpeg(binDir)).toBe(false);
  });

  it('装了能查到大小，删掉之后归零', async () => {
    const binDir = join(scratchDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(cachedFfmpegPath(binDir), Buffer.alloc(2048));
    expect(await installedSize(binDir)).toBe(2048);
    expect(await removeFfmpeg(binDir)).toBe(true);
    expect(await installedSize(binDir)).toBe(0);
  });

  it('缓存的路径按平台给出正确的可执行名', () => {
    expect(cachedFfmpegPath('C:/bin', 'win32')).toMatch(/ffmpeg\.exe$/);
    expect(cachedFfmpegPath('/usr/bin', 'linux')).toMatch(/ffmpeg$/);
  });
});

describe('probeFfmpeg', () => {
  it('不存在的命令返回 false，不抛错', async () => {
    expect(await probeFfmpeg(join(scratchDir, 'no-such-binary'))).toBe(false);
  });

  it('能跑且接受 -version 的命令返回 true', async () => {
    const ffmpeg = realFfmpeg();
    if (!ffmpeg) return;
    expect(await probeFfmpeg(ffmpeg)).toBe(true);
  });

  it('能跑但不认 -version 的命令返回 false', async () => {
    expect(await probeFfmpeg(process.execPath)).toBe(false);
  });
});

describe('extractFrames', () => {
  it('没有 ffmpeg 时返回空帧与原因，不抛错', async () => {
    const result = await extractFrames({
      ffmpegPath: null,
      videoPath: join(scratchDir, 'x.mp4'),
      outDir: join(scratchDir, 'frames'),
      count: 4,
      maxEdge: 640,
    });
    expect(result.frames).toEqual([]);
    expect(result.reason).toContain('ffmpeg');
  });

  it('视频文件不存在时如实失败', async () => {
    const ffmpeg = realFfmpeg();
    if (!ffmpeg) return;
    const result = await extractFrames({
      ffmpegPath: ffmpeg,
      videoPath: join(scratchDir, 'missing.mp4'),
      outDir: join(scratchDir, 'frames'),
      count: 2,
      maxEdge: 320,
    });
    expect(result.frames).toEqual([]);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('真 ffmpeg：从测试视频抽出请求的帧数，且是有效 JPEG', async () => {
    const ffmpeg = realFfmpeg();
    if (!ffmpeg) return;

    const videoPath = join(scratchDir, 'clip.mp4');
    const made = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=4:size=160x120:rate=10',
      '-pix_fmt', 'yuv420p', '-y', videoPath,
    ], { windowsHide: true });
    if (made.status !== 0) return;

    const result = await extractFrames({
      ffmpegPath: ffmpeg,
      videoPath,
      outDir: join(scratchDir, 'frames'),
      count: 3,
      maxEdge: 320,
      durationSec: 4,
    });
    expect(result.reason).toBe('');
    expect(result.frames).toHaveLength(3);
    for (const frame of result.frames) {
      expect(frame.bytes).toBeGreaterThan(500);
      const head = createReadStream(frame.path);
      const first = await new Promise<Buffer>((resolve) => {
        head.once('data', (chunk) => {
          resolve(Buffer.from(chunk as Buffer).subarray(0, 3));
          head.destroy();
        });
      });
      expect([...first]).toEqual([0xff, 0xd8, 0xff]);
    }
  });

  it('上一次的残帧不会被当成本次结果', async () => {
    const outDir = join(scratchDir, 'frames');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'frame-001.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x00]));

    const result = await extractFrames({
      ffmpegPath: null,
      videoPath: join(scratchDir, 'x.mp4'),
      outDir,
      count: 2,
      maxEdge: 320,
    });
    expect(result.frames).toEqual([]);
  });
});
