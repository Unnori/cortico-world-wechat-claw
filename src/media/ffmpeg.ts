/**
 * ffmpeg 的取得方式。
 *
 * 视频抽帧需要 ffmpeg，但不把 70+ MB 的可执行文件塞进扩展包，也绝不悄悄下载：
 * **只有操作者在面板上点「下载 ffmpeg」才会联网**，启用 World、切配置都不触发下载。
 *
 * 安装位置固定在扩展自己的数据目录 `<dataDir>/wechat-claw/bin/`，不改系统 PATH——
 * 悄悄改全局环境变量会影响其他程序，卸载扩展后还会留下垃圾。
 *
 * 下载源是 `ffmpeg-static` 发布在 GitHub Releases 上的静态构建（gzip 压缩的单个可执行文件），
 * 与 npm 上 `ffmpeg-static` 包用的是同一批产物。校验方式是下载后跑一次 `-version`，
 * 跑不通就删掉——不靠文件名或大小猜。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

/** 静态构建的发布版本；与 ffmpeg-static 一致。 */
const RELEASE_TAG = 'b6.0';

/** 解析时允许的来源；`download` 不再是可选值，下载只能由面板按钮显式触发。 */
export type FfmpegSource = 'auto' | 'path' | 'off';

export type FfmpegOrigin = 'path' | 'downloaded' | 'none';

export interface FfmpegResolution {
  /** 可执行的绝对路径；没有可用的就是 null。 */
  path: string | null;
  /** 从哪来的。 */
  origin: FfmpegOrigin;
  /** 给人看的一句话：为什么没有、或者用了哪一份。 */
  detail: string;
  /** 版本号首行，例如 `ffmpeg version 6.0-...`；拿不到就是空串。 */
  version: string;
}

/** 按平台与架构拼出发布文件名；不支持的组合返回 null。 */
export function ffmpegAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const table: Record<string, Record<string, string>> = {
    win32: { x64: 'ffmpeg-win32-x64.gz', ia32: 'ffmpeg-win32-ia32.gz', arm64: 'ffmpeg-win32-arm64.gz' },
    darwin: { x64: 'ffmpeg-darwin-x64.gz', arm64: 'ffmpeg-darwin-arm64.gz' },
    linux: { x64: 'ffmpeg-linux-x64.gz', arm64: 'ffmpeg-linux-arm64.gz', ia32: 'ffmpeg-linux-ia32.gz' },
  };
  return table[platform]?.[arch] ?? null;
}

export function ffmpegDownloadUrl(asset: string): string {
  return `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE_TAG}/${asset}`;
}

/** 可执行文件名。 */
function exeName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/** 已安装的那份在哪。 */
export function cachedFfmpegPath(binDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(binDir, exeName(platform));
}

/** 跑一次命令并收集输出首行；超时或非零退出返回空串。 */
function runVersion(command: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    const done = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(command, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      done('');
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出。 */
      }
      done('');
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      // 只要首行，够展示就行。
      if (out.length < 200) out += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      done('');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? (out.split('\n')[0] ?? '').trim() : '');
    });
  });
}

/** 这份二进制能不能用。 */
export async function probeFfmpeg(command: string, timeoutMs = 8000): Promise<boolean> {
  return (await runVersion(command, timeoutMs)) !== '';
}

/** 在 PATH 里找 ffmpeg。找不到或跑不通都返回 null。 */
export async function findOnPath(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const name = exeName(platform);
  const raw = process.env.PATH ?? '';
  const dirs = raw.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    if (await probeFfmpeg(candidate)) return candidate;
  }
  return null;
}

export interface EnsureFfmpegOptions {
  source: FfmpegSource;
  /** 已安装的那份在 `binDir` 下。 */
  binDir: string;
  platform?: NodeJS.Platform;
}

/**
 * 按配置解析出可用的 ffmpeg。**不下载**。
 *
 * 拿不到就返回 `origin: 'none'` 并写清原因，调用方据此降级为「不抽帧」。
 */
export async function ensureFfmpeg(opts: EnsureFfmpegOptions): Promise<FfmpegResolution> {
  const platform = opts.platform ?? process.platform;

  if (opts.source === 'off') {
    return { path: null, origin: 'none', detail: '视频抽帧已关闭', version: '' };
  }

  if (opts.source === 'path') {
    const found = await findOnPath(platform);
    if (!found) return { path: null, origin: 'none', detail: '系统 PATH 里没有可用的 ffmpeg', version: '' };
    return { path: found, origin: 'path', detail: '使用系统 PATH 里的 ffmpeg', version: await runVersion(found) };
  }

  // auto：PATH 优先，其次已安装的那份。
  const found = await findOnPath(platform);
  if (found) {
    return { path: found, origin: 'path', detail: '使用系统 PATH 里的 ffmpeg', version: await runVersion(found) };
  }
  const cached = cachedFfmpegPath(opts.binDir, platform);
  if (existsSync(cached)) {
    const version = await runVersion(cached);
    if (version) return { path: cached, origin: 'downloaded', detail: '使用扩展下载的 ffmpeg', version };
    return { path: null, origin: 'none', detail: '已下载的 ffmpeg 无法运行，请在面板重新下载', version: '' };
  }
  return { path: null, origin: 'none', detail: 'PATH 里没有 ffmpeg，也没有下载过', version: '' };
}

/** 下载进度。 */
export interface InstallProgress {
  phase: 'downloading' | 'verifying' | 'done' | 'failed';
  detail: string;
  /** 已下载字节。 */
  received: number;
  /** 总字节；服务端没给就是 0。 */
  total: number;
  /** 0-100；总量未知时是 null。 */
  percent: number | null;
}

export interface InstallFfmpegOptions {
  binDir: string;
  /** 下载进度与结果都走这里。 */
  onProgress: (progress: InstallProgress) => void;
  log?: { info(msg: string): void; warn(msg: string): void };
  /** 注入点：测试替换掉真实下载。 */
  fetchImpl?: typeof globalThis.fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  signal?: AbortSignal;
}

/**
 * 下载并安装 ffmpeg 到 `binDir`。**只能由操作者显式触发**。
 *
 * 先写临时文件再 rename，断电不会留下半个 exe；解压后跑一次 `-version` 才算成功，
 * 跑不通就删掉并如实报告。
 */
export async function installFfmpeg(opts: InstallFfmpegOptions): Promise<FfmpegResolution> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const target = cachedFfmpegPath(opts.binDir, platform);
  const asset = ffmpegAssetName(platform, arch);
  const fail = (detail: string): FfmpegResolution => {
    opts.onProgress({ phase: 'failed', detail, received: 0, total: 0, percent: null });
    return { path: null, origin: 'none', detail, version: '' };
  };

  if (!asset) return fail(`没有适配 ${platform}/${arch} 的 ffmpeg 构建`);

  const url = ffmpegDownloadUrl(asset);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  try {
    await mkdir(opts.binDir, { recursive: true });
  } catch (err) {
    return fail(`建不了安装目录：${message(err)}`);
  }

  const temporary = `${target}.${Date.now().toString(36)}.tmp`;
  opts.log?.info(`开始下载 ffmpeg：${asset}`);
  opts.onProgress({ phase: 'downloading', detail: '正在下载 ffmpeg', received: 0, total: 0, percent: null });

  try {
    const response = await fetchImpl(url, { redirect: 'follow', ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!response.ok || !response.body) {
      return fail(`下载 ffmpeg 失败：HTTP ${response.status}`);
    }
    const total = Number(response.headers.get('content-length') ?? '0') || 0;
    let received = 0;
    let lastReport = 0;

    // 边下边计数，但别为每个 chunk 都回调一次。
    const counter = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        received += chunk.length;
        const now = Date.now();
        if (now - lastReport >= 200) {
          lastReport = now;
          opts.onProgress({
            phase: 'downloading',
            detail: '正在下载 ffmpeg',
            received,
            total,
            percent: total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : null,
          });
        }
        callback(null, chunk);
      },
    });

    const gz = createGunzip();
    const source = Readable.fromWeb(response.body as never);
    await pipeline(source, counter, gz, createWriteStream(temporary));

    const info = await stat(temporary).catch(() => null);
    if (!info || info.size < 1024 * 1024) {
      await rm(temporary, { force: true });
      return fail('下载到的文件太小，可能是错误页');
    }
    try {
      await chmod(temporary, 0o755);
    } catch {
      /* Windows 不需要执行位。 */
    }
    await rename(temporary, target);
  } catch (err) {
    await rm(temporary, { force: true });
    if (opts.signal?.aborted) return fail('下载已取消');
    return fail(`下载 ffmpeg 失败：${message(err)}`);
  }

  opts.onProgress({ phase: 'verifying', detail: '正在校验 ffmpeg', received: 0, total: 0, percent: null });
  const version = await runVersion(target);
  if (!version) {
    await rm(target, { force: true });
    return fail('下载的 ffmpeg 无法运行，已删除');
  }

  opts.log?.info(`ffmpeg 已就绪：${target}`);
  opts.onProgress({ phase: 'done', detail: '已安装并校验通过', received: 0, total: 0, percent: 100 });
  return { path: target, origin: 'downloaded', detail: '已安装并校验通过', version };
}

/** 删掉已安装的那份。没有也不报错。 */
export async function removeFfmpeg(binDir: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const target = cachedFfmpegPath(binDir, platform);
  if (!existsSync(target)) return false;
  await rm(target, { force: true });
  return true;
}

/** 已安装的那份占多少字节；没装返回 0。 */
export async function installedSize(binDir: string, platform: NodeJS.Platform = process.platform): Promise<number> {
  const target = cachedFfmpegPath(binDir, platform);
  const info = await stat(target).catch(() => null);
  return info?.size ?? 0;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
