/**
 * 图片闸门与拼图布局。
 *
 * 重点是「超限怎么办」：能压就压、压不了就不附，并且**每种丢弃都带上能写进正文的原因**。
 * 静默吞掉会让用户以为消息丢了，这是这个模块存在的主要理由。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { fitImage, limitBreach, overCountNote, probeImage, type ImageLimits } from '../src/media/imagefit.ts';
import { MAX_FRAMES, parseVideoSize, tileLayout, tileOrderNote } from '../src/media/layout.ts';

const LIMITS: ImageLimits = { maxBytes: 16 * 1024 * 1024, maxEdge: 4096, maxCount: 10 };

let dir = '';
const ensureDir = (): string => {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'claw-fit-'));
  return dir;
};

/** 找本机真实 ffmpeg；没有就跳过需要它的用例。 */
function realFfmpeg(): string | null {
  const candidates = [process.env.WECHAT_CLAW_TEST_FFMPEG, 'ffmpeg'].filter(Boolean) as string[];
  for (const c of candidates) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore', windowsHide: true });
    if (r.status === 0) return c;
  }
  return null;
}

/** 用 ffmpeg 生成一张指定尺寸的 PNG。 */
function makePng(ffmpeg: string, path: string, w: number, h: number): boolean {
  const r = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=${w}x${h}:rate=1:duration=1`,
    '-frames:v', '1', '-y', path,
  ], { windowsHide: true });
  return r.status === 0 && existsSync(path);
}

describe('尺寸解析', () => {
  it('从 ffmpeg -i 的输出里读横屏尺寸', () => {
    const stderr = '  Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps';
    expect(parseVideoSize(stderr)).toEqual({ width: 1920, height: 1080 });
  });

  it('读竖屏尺寸', () => {
    expect(parseVideoSize('Stream #0:0(und): Video: h264, 720x1280')).toEqual({ width: 720, height: 1280 });
  });

  it('读不出来返回 null，不瞎猜', () => {
    expect(parseVideoSize('No such file or directory')).toBeNull();
    expect(parseVideoSize('')).toBeNull();
  });

  it('优先匹配 Video 流那一行，不撞别的数字', () => {
    const stderr = [
      'Input #0, mov, from ...',
      '  Duration: 00:00:08.00, start: 0.000000, bitrate: 1000 kb/s',
      '  Stream #0:0: Video: h264, yuv420p, 640x360, 10 fps',
    ].join('\n');
    expect(parseVideoSize(stderr)).toEqual({ width: 640, height: 360 });
  });
});

describe('拼图布局', () => {
  it('横屏 4 帧用 2×2 田字格', () => {
    const l = tileLayout(4, false);
    expect(l.cols).toBe(2);
    expect(l.rows).toBe(2);
  });

  it('横屏 6 帧用 3×2', () => {
    const l = tileLayout(6, false);
    expect(l.cols).toBe(3);
    expect(l.rows).toBe(2);
  });

  it('横屏 9 帧用 3×3', () => {
    const l = tileLayout(9, false);
    expect(l.cols).toBe(3);
    expect(l.rows).toBe(3);
  });

  it('竖屏一律横排，行数为 1', () => {
    for (const n of [2, 3, 4, 6, 9]) {
      const l = tileLayout(n, true);
      expect(l.rows).toBe(1);
      expect(l.cols).toBe(n);
    }
  });

  it('帧数被夹在 1..9', () => {
    expect(tileLayout(0, false).cols).toBe(1);
    expect(tileLayout(20, false).cols).toBe(Math.ceil(Math.sqrt(MAX_FRAMES)));
  });

  it('拼出来的宽度不超过 4096', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      for (const portrait of [true, false]) {
        const l = tileLayout(n, portrait);
        expect(l.cellEdge * l.cols).toBeLessThanOrEqual(4096);
      }
    }
  });

  it('顺序说明对得上布局', () => {
    expect(tileOrderNote(tileLayout(4, true))).toContain('从左到右');
    expect(tileOrderNote(tileLayout(4, false))).toContain('从左上到右下');
  });
});

describe('超限判定', () => {
  it('体积超了说体积', () => {
    const breach = limitBreach({ path: 'x', bytes: 20 * 1024 * 1024, mime: 'image/png' }, LIMITS);
    expect(breach).toContain('体积');
    expect(breach).toContain('MB');
  });

  it('单边超了说尺寸', () => {
    const breach = limitBreach({ path: 'x', bytes: 100, mime: 'image/png', width: 8000, height: 600 }, LIMITS);
    expect(breach).toContain('尺寸');
    expect(breach).toContain('8000×600');
    expect(breach).toContain('4096');
  });

  it('高度超了同样算', () => {
    const breach = limitBreach({ path: 'x', bytes: 100, mime: 'image/png', width: 600, height: 9000 }, LIMITS);
    expect(breach).toContain('9000');
  });

  it('都没超返回 null', () => {
    expect(limitBreach({ path: 'x', bytes: 1024, mime: 'image/png', width: 1920, height: 1080 }, LIMITS)).toBeNull();
  });

  it('读不出尺寸时只看体积', () => {
    expect(limitBreach({ path: 'x', bytes: 1024, mime: 'image/png' }, LIMITS)).toBeNull();
  });
});

describe('数量说明', () => {
  it('写明是第几张超了', () => {
    expect(overCountNote(10, LIMITS)).toContain('第 11 张');
    expect(overCountNote(10, LIMITS)).toContain('10 张');
  });
});

describe('过闸门', () => {
  it('没超的原样放行，不做任何处理', async () => {
    ensureDir();
    const path = join(dir, 'small.png');
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const probe = await probeImage(path, 'image/png');
    expect(probe).not.toBeNull();
    const fitted = await fitImage({ probe: probe!, limits: LIMITS, ffmpegPath: null, outDir: join(dir, 'out') });
    expect(fitted.ok).toBe(true);
    if (fitted.ok) expect(fitted.path).toBe(path);
  });

  it('超限且没有 ffmpeg：不附，并说明哪一项超标', async () => {
    ensureDir();
    const path = join(dir, 'big.png');
    // 造一个 20 MB 的文件（内容不重要，只看体积）。
    writeFileSync(path, Buffer.alloc(20 * 1024 * 1024, 1));
    const probe = await probeImage(path, 'image/png');
    const fitted = await fitImage({ probe: probe!, limits: LIMITS, ffmpegPath: null, outDir: join(dir, 'out') });
    expect(fitted.ok).toBe(false);
    if (!fitted.ok) {
      expect(fitted.reason).toContain('体积');
      expect(fitted.reason).toContain('没有 ffmpeg');
    }
  });

  it('真 ffmpeg：超边的大图被压到限制内', async () => {
    const ffmpeg = realFfmpeg();
    if (!ffmpeg) return;
    ensureDir();
    const src = join(dir, 'huge.png');
    if (!makePng(ffmpeg, src, 5000, 4000)) return;

    // 限制压到 512，确认输出确实变小了。
    const tight: ImageLimits = { maxBytes: 16 * 1024 * 1024, maxEdge: 512, maxCount: 10 };
    const probe = await probeImage(src, 'image/png');
    expect(probe?.width).toBe(5000);

    const fitted = await fitImage({ probe: probe!, limits: tight, ffmpegPath: ffmpeg, outDir: join(dir, 'fit') });
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    expect(fitted.mime).toBe('image/jpeg');
    expect(fitted.path).not.toBe(src);
    expect(existsSync(fitted.path)).toBe(true);
    // 压缩后的文件确实在限制内。
    expect(statSync(fitted.path).size).toBeLessThanOrEqual(tight.maxBytes);
    // 说明里写了原始超标原因。
    expect(fitted.note).toContain('尺寸');
  });

  it('产物目录不存在时也能压缩（会自动建目录）', async () => {
    const ffmpeg = realFfmpeg();
    if (!ffmpeg) return;
    ensureDir();
    const src = join(dir, 'wide.png');
    if (!makePng(ffmpeg, src, 3000, 1000)) return;

    // 故意传一个还没建的目录。
    const freshDir = join(dir, 'never-created', 'nested');
    const tight: ImageLimits = { maxBytes: 16 * 1024 * 1024, maxEdge: 512, maxCount: 10 };
    const probe = await probeImage(src, 'image/png');
    const fitted = await fitImage({ probe: probe!, limits: tight, ffmpegPath: ffmpeg, outDir: freshDir });
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    expect(existsSync(fitted.path)).toBe(true);
  });

  it('文件读不出来时返回 null，不抛错', async () => {
    ensureDir();
    const probe = await probeImage(join(dir, 'nope.png'), 'image/png');
    expect(probe).toBeNull();
  });

  it('损坏的 PNG 不被误判成超长图', async () => {
    // 只有 magic 加一段文字的假 PNG：`imageSize` 会把文字字节当成 IHDR 宽高，
    // 读出天文数字。如果不做合理性检查，这张 26 字节的小图会被当成长图丢掉。
    ensureDir();
    const path = join(dir, 'broken.png');
    writeFileSync(path, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fake image payload'),
    ]));
    const probe = await probeImage(path, 'image/png');
    expect(probe).not.toBeNull();
    // 尺寸读不出来，就不该有 width/height。
    expect(probe!.width).toBeUndefined();
    expect(probe!.height).toBeUndefined();
    // 闸门必须放行这张小图。
    const fitted = await fitImage({ probe: probe!, limits: LIMITS, ffmpegPath: null, outDir: join(dir, 'out') });
    expect(fitted.ok).toBe(true);
  });
});
