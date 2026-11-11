/**
 * 本地路径边界：桌宠工作区、微信收件目录，以及「能把什么发出去」。
 *
 * 三件事都在这里定，理由各不相同：
 *
 * - **工作区在哪。** World 拿不到 `memoryDir`——`WorldContext` 只给 `botDir`、`packageDir`、
 *   `dataDir`、`repoRoot`（Cortico 0.2.x）。所以这里按框架自己的解析顺序还原：
 *   `loadDeployment` 把 `memoryDir` 算成 `paths.memory`（相对部署目录或绝对路径），
 *   而 Coopanion 的 Coo 把 `paths.memory` 写死成 `workspace`。于是顺序是
 *   `config.json` 的 `paths.memory` → 探测 `<botDir>/workspace` → 探测 `<botDir>/memory`。
 * - **收件目录在哪。** 默认 `<工作区>/wechat-inbox`：收到的图片、文件、视频、语音落在工作区里，
 *   桌宠读得到、改得了、也发得回来；同时是独立的一层目录，不会和工作区根目录的文件混在一起。
 * - **能不能发。** 只有工作区（和收件目录、配置里额外放行的目录）里的文件可以发到微信。
 *   判断前先把路径规范化（`realpath`），所以 `..` 与符号链接都绕不出去。
 */
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

/** 收件目录的默认名字；`inboxDir` 留空时用它。 */
export const INBOX_DIR_NAME = 'wechat-inbox';

/** 派生文件的落地目录（压缩后的图、视频拼图）；放在收件目录内部，免得和原件混在一起。 */
export const DERIVED_DIR_NAME = '.derived';

/** 探测工作区时按顺序试的目录名：Coopanion 的 Coo 用 `workspace`，Cortico 默认 `memory`。 */
const WORKSPACE_CANDIDATES = ['workspace', 'memory'] as const;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 读部署 `config.json` 里的 `paths.memory`；没有、读不动或类型不对都算没有。 */
function configuredMemoryPath(botDir: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(botDir, 'config.json'), 'utf8')) as {
      paths?: { memory?: unknown };
    } | null;
    const value = raw?.paths?.memory;
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 桌宠的工作区（Cortico 叫 Memory 目录，Coopanion 里就是 Coo 那个 `workspace`）。
 *
 * 先信 `config.json` 的 `paths.memory`（和框架一致），再按目录是否已存在探测。
 * 都不成立时返回 `<botDir>/workspace`——Coopanion 是本包的主要宿主，用它的约定；
 * 目录不存在时由第一次落盘顺手创建，`inbox` 报告里会写明实际路径。
 */
export function resolveWorkspaceDir(botDir: string): string {
  const root = resolve(botDir);
  const configured = configuredMemoryPath(root);
  if (configured) return isAbsolute(configured) ? configured : resolve(root, configured);
  for (const name of WORKSPACE_CANDIDATES) {
    const candidate = join(root, name);
    if (isDirectory(candidate)) return candidate;
  }
  return join(root, WORKSPACE_CANDIDATES[0]);
}

/**
 * 收件目录。配置留空时用 `<工作区>/wechat-inbox`。
 *
 * 相对路径按**工作区**解析——「收来的东西放进工作区里的哪一层」是这里唯一要回答的问题；
 * 想放到工作区外面就写绝对路径（那也就等于放弃「桌宠读得到」这个好处，配置描述里会说明）。
 */
export function resolveInboxDir(opts: {
  workspaceDir: string;
  configured?: string;
}): string {
  const value = String(opts.configured ?? '').trim();
  if (!value) return join(opts.workspaceDir, INBOX_DIR_NAME);
  return isAbsolute(value) ? resolve(value) : resolve(opts.workspaceDir, value);
}

/** 派生文件（压缩后的图、拼图）的目录。 */
export function derivedDir(inboxDir: string, ...parts: string[]): string {
  return join(inboxDir, DERIVED_DIR_NAME, ...parts);
}

/**
 * 把「多个目录」的配置文本拆开：按行、分号或逗号分隔，相对路径按 `baseDir` 解析。
 *
 * Windows 路径里有 `:` 和 `\`，所以只用这三类分隔符，不碰冒号。
 */
export function parseDirList(text: unknown, baseDir: string): string[] {
  const raw = typeof text === 'string' ? text : '';
  const out: string[] = [];
  for (const piece of raw.split(/[\r\n;；,，]+/)) {
    const value = piece.trim().replace(/^["']|["']$/g, '');
    if (!value) continue;
    out.push(isAbsolute(value) ? resolve(value) : resolve(baseDir, value));
  }
  return [...new Set(out)];
}

/** 解析掉符号链接、`.`/`..` 之后的真实路径；不存在的路径退到解析父目录。 */
export function canonicalPath(target: string): string {
  const abs = resolve(target);
  try {
    return realpathSync.native(abs);
  } catch {
    /* 还不存在，退到父目录。 */
  }
  try {
    return join(realpathSync.native(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

/** `target` 是否就在 `root` 里（含 root 本身）。不区分大小写由 `relative` 在 Windows 上处理。 */
export function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (!rel) return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** 发送边界检查的结果；`path` 是规范化后的真实路径，调用方应当拿它去读文件。 */
export type SendableCheck = { ok: true; path: string } | { ok: false; reason: 'outside' | 'missing'; path: string };

/**
 * 判断一个本地路径能不能发到微信。
 *
 * 通过时返回**规范化后的路径**，调用方应当用它去 `stat`/`readFile`：这样「检查的」和
 * 「读的」是同一个对象，不给检查与读取之间的替换留窗口。
 */
export function checkSendable(rawPath: string, roots: readonly string[]): SendableCheck {
  const target = canonicalPath(rawPath);
  if (!existsSync(target)) return { ok: false, reason: 'missing', path: target };
  const canonicalRoots = roots.filter(Boolean).map((root) => canonicalPath(root));
  const inside = canonicalRoots.some((root) => isInsideRoot(root, target));
  return inside ? { ok: true, path: target } : { ok: false, reason: 'outside', path: target };
}

/** Windows 保留名：`CON`、`NUL`、`COM1`… 不能当文件名。 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 把外来文件名变成能落盘的名字：去掉目录部分、控制字符和 Windows 禁止的符号，
 * 收短长度，避开保留名。清理后什么都不剩时用 `fallback`。
 *
 * 微信给的文件名来自对方，不能直接当路径用——`..`、`C:`、斜杠都得在这里挡掉。
 */
export function safeFileName(raw: string, fallback = 'file'): string {
  let name = String(raw ?? '').replace(/\\/g, '/');
  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);
  name = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');

  if (!name) return fallback;

  const ext = extname(name).slice(0, 16);
  let stem = ext ? name.slice(0, name.length - ext.length) : name;
  if (RESERVED_NAMES.test(stem)) stem = `_${stem}`;
  if (!stem) stem = fallback;
  // 长文件名在 Windows 上会撞 MAX_PATH；留 60 个字符给主干，可读性够用。
  return `${stem.slice(0, 60)}${ext}`;
}

/** 本地时间戳 `YYYYMMDD-HHMMSS`，用在文件名里。 */
export function fileStamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 落盘用的文件名：原文名在前、时间戳在后，`报告-20261108-144219.pdf`。
 *
 * 原文名优先是有意的——桌宠按名字就能认出「这是对方发来的那个东西」；时间戳保住
 * 同名文件的可排序与可区分。原文名没带扩展名时用 `fallbackExt`（微信给的文件常常没有）。
 */
export function datedFileName(
  original: string | null | undefined,
  fallbackStem: string,
  fallbackExt = '',
): string {
  const clean = original ? safeFileName(original, '') : '';
  let ext = clean ? extname(clean) : '';
  let stem = clean ? clean.slice(0, clean.length - ext.length) : '';
  if (!stem) stem = fallbackStem;
  if (!ext) ext = fallbackExt;
  return `${stem}-${fileStamp()}${ext}`;
}

/** 同一目录下换一个不冲突的名字：`a.pdf` → `a-2.pdf` → `a-3.pdf`。 */
export function uniqueFileName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'file';
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${stem}-${fileStamp()}${ext}`;
}

/**
 * 让工作区的 Git 忽略收件目录。
 *
 * Coo 的工作区是一个 Git 仓库，每写一次文件就 `git add -A` 提交一次；收到的视频动辄十几 MB，
 * 不忽略的话历史会被撑爆。只在 `.gitignore` **已经存在**时追加（说明这个工作区确实在版本管理），
 * 而且幂等：已经有这一行就什么都不做。
 *
 * 返回是否真的改了文件，供调用方写日志。
 */
export function ensureGitIgnored(workspaceDir: string, inboxDir: string): boolean {
  const rel = relative(workspaceDir, inboxDir).replace(/\\/g, '/').replace(/\/+$/, '');
  // 收件目录不在工作区里、或就是工作区本身时，没有可写的忽略项。
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  const pattern = `${rel}/`;
  const file = join(workspaceDir, '.gitignore');
  let current: string;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const entries = current.split(/\r?\n/).map((line) => line.trim());
  if (entries.includes(pattern) || entries.includes(rel)) return false;
  const head = current.endsWith('\n') || current === '' ? current : `${current}\n`;
  try {
    writeFileSync(file, `${head}# 微信 ClawBot 收件目录（图片、视频等二进制内容不进版本历史）\n${pattern}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
