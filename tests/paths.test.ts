/**
 * 路径边界：工作区怎么认出来、收件目录落在哪、什么文件能发出去。
 *
 * 这一层的每一条都直接对应一个安全结论，所以不用 mock：真临时目录、真 `config.json`、
 * 真符号链接（建不出来就跳过那一条）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkSendable,
  datedFileName,
  derivedDir,
  ensureGitIgnored,
  isInsideRoot,
  parseDirList,
  resolveInboxDir,
  resolveWorkspaceDir,
  safeFileName,
  uniqueFileName,
} from '../src/paths.ts';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wechat-paths-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('认工作区', () => {
  it('config.json 里的 paths.memory 优先，相对部署目录解析', () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ paths: { memory: 'my-memory' } }));
    mkdirSync(join(root, 'workspace'));
    // 配置优先于目录探测。
    expect(resolveWorkspaceDir(root)).toBe(join(root, 'my-memory'));
  });

  it('paths.memory 是绝对路径时照用', () => {
    const absolute = join(root, 'elsewhere');
    writeFileSync(join(root, 'config.json'), JSON.stringify({ paths: { memory: absolute } }));
    expect(resolveWorkspaceDir(root)).toBe(absolute);
  });

  it('没有配置时探测 <botDir>/workspace（Coopanion/Coo 的约定）', () => {
    mkdirSync(join(root, 'workspace'));
    mkdirSync(join(root, 'memory'));
    expect(resolveWorkspaceDir(root)).toBe(join(root, 'workspace'));
  });

  it('只有 memory 时用 memory（Cortico 默认）', () => {
    mkdirSync(join(root, 'memory'));
    expect(resolveWorkspaceDir(root)).toBe(join(root, 'memory'));
  });

  it('两个都没有时落到 <botDir>/workspace，不瞎猜', () => {
    expect(resolveWorkspaceDir(root)).toBe(join(root, 'workspace'));
  });

  it('config.json 坏了不影响认目录', () => {
    writeFileSync(join(root, 'config.json'), '{ 不是 JSON');
    mkdirSync(join(root, 'workspace'));
    expect(resolveWorkspaceDir(root)).toBe(join(root, 'workspace'));
  });
});

describe('收件目录', () => {
  it('默认在 工作区/wechat-inbox', () => {
    expect(resolveInboxDir({ workspaceDir: join(root, 'workspace') }))
      .toBe(join(root, 'workspace', 'wechat-inbox'));
  });

  it('相对路径按工作区解析', () => {
    expect(resolveInboxDir({ workspaceDir: join(root, 'workspace'), configured: 'inbox2' }))
      .toBe(join(root, 'workspace', 'inbox2'));
  });

  it('绝对路径照用', () => {
    const absolute = join(root, 'outside-inbox');
    expect(resolveInboxDir({ workspaceDir: join(root, 'workspace'), configured: absolute }))
      .toBe(absolute);
  });

  it('派生文件放在收件目录内部的 .derived 下', () => {
    expect(derivedDir(join(root, 'inbox'), 'fitted'))
      .toBe(join(root, 'inbox', '.derived', 'fitted'));
  });
});

describe('文件名', () => {
  it('去掉路径部分，挡住目录穿越', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
    expect(safeFileName('/absolute/path/报告.pdf')).toBe('报告.pdf');
  });

  it('挡掉 Windows 禁止的符号与控制字符', () => {
    expect(safeFileName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(safeFileName('bad\u0000name.txt')).toBe('badname.txt');
  });

  it('保留名加下划线，前后点与空格剪掉', () => {
    expect(safeFileName('CON')).toBe('_CON');
    expect(safeFileName('  .hidden.  ')).toBe('hidden');
  });

  it('清理后空了就用兜底名', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('///', 'wx-file')).toBe('wx-file');
  });

  it('过长的主干被截短，扩展名留着', () => {
    const long = `${'あ'.repeat(200)}.png`;
    const out = safeFileName(long);
    expect(out.endsWith('.png')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(64);
  });

  it('落盘名保留原文名，后面接时间戳', () => {
    const name = datedFileName('报告.pdf', 'wx-file');
    expect(name).toMatch(/^报告-\d{8}-\d{6}\.pdf$/);
  });

  it('原文名没有扩展名时用兜底扩展名', () => {
    expect(datedFileName('名字', 'wx-file', '.silk')).toMatch(/^名字-\d{8}-\d{6}\.silk$/);
  });

  it('没有原文名时用兜底主干', () => {
    expect(datedFileName(null, 'wx-image', '.png')).toMatch(/^wx-image-\d{8}-\d{6}\.png$/);
  });

  it('撞名时退到 -2、-3', () => {
    mkdirSync(join(root, 'files'));
    writeFileSync(join(root, 'files', 'a.txt'), 'x');
    expect(uniqueFileName(join(root, 'files'), 'a.txt')).toBe('a-2.txt');
    writeFileSync(join(root, 'files', 'a-2.txt'), 'x');
    expect(uniqueFileName(join(root, 'files'), 'a.txt')).toBe('a-3.txt');
  });
});

describe('发送边界', () => {
  it('工作区里的文件通过，返回的是真实路径', () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const file = join(workspace, 'a.txt');
    writeFileSync(file, 'x');
    const result = checkSendable(file, [workspace]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(file);
  });

  it('工作区外面的文件被拒绝', () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'x');
    const result = checkSendable(outside, [workspace]);
    expect(result).toEqual({ ok: false, reason: 'outside', path: outside });
  });

  it('用 .. 也绕不出去', () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const outside = join(root, 'secret.txt');
    writeFileSync(outside, 'x');
    // 形如 <workspace>/../secret.txt
    const sneaky = join(workspace, '..', 'secret.txt');
    expect(checkSendable(sneaky, [workspace]).ok).toBe(false);
  });

  it('文件不存在时先报缺失，不谎报成越界', () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const result = checkSendable(join(workspace, 'nope.txt'), [workspace]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing');
  });

  it('符号链接指到工作区外面时被拒绝', () => {
    const workspace = join(root, 'workspace');
    const outsideDir = join(root, 'outside');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const secret = join(outsideDir, 'secret.txt');
    writeFileSync(secret, 'x');
    const link = join(workspace, 'link.txt');
    try {
      symlinkSync(secret, link, 'file');
    } catch {
      // Windows 上没开发者模式/权限时建不了符号链接，跳过这一条。
      return;
    }
    expect(checkSendable(link, [workspace]).ok).toBe(false);
  });

  it('前缀相同但不是子目录的路径不算在里面', () => {
    // <root>/workspace-evil 不属于 <root>/workspace
    expect(isInsideRoot(join(root, 'workspace'), join(root, 'workspace-evil', 'a.txt'))).toBe(false);
    expect(isInsideRoot(join(root, 'workspace'), join(root, 'workspace'))).toBe(true);
    expect(isInsideRoot(join(root, 'workspace'), join(root, 'workspace', 'a', 'b.txt'))).toBe(true);
  });

  it('多个放行目录里命中任意一个就算通过', () => {
    const extra = join(root, '素材');
    mkdirSync(extra, { recursive: true });
    const file = join(extra, 'clip.bin');
    writeFileSync(file, 'x');
    expect(checkSendable(file, [join(root, 'workspace'), extra]).ok).toBe(true);
  });
});

describe('额外的放行目录配置', () => {
  it('按行、分号、逗号拆开，相对路径按部署目录解析', () => {
    const dirs = parseDirList('a\r\nb;c，d', root);
    expect(dirs).toEqual([
      join(root, 'a'),
      join(root, 'b'),
      join(root, 'c'),
      join(root, 'd'),
    ]);
  });

  it('空值与重复项被丢掉', () => {
    expect(parseDirList('', root)).toEqual([]);
    expect(parseDirList('  ;\n ', root)).toEqual([]);
    expect(parseDirList('a;a', root)).toEqual([join(root, 'a')]);
  });

  it('留引号的写法也能用', () => {
    expect(parseDirList('"素材"', root)).toEqual([join(root, '素材')]);
  });
});

describe('工作区 Git 忽略', () => {
  it('没有 .gitignore 时不新建', () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    expect(ensureGitIgnored(workspace, join(workspace, 'wechat-inbox'))).toBe(false);
  });

  it('有 .gitignore 时追加一行，且只追加一次', () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const file = join(workspace, '.gitignore');
    writeFileSync(file, '*.tmp-*\nblobs/\n', 'utf8');

    expect(ensureGitIgnored(workspace, join(workspace, 'wechat-inbox'))).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('wechat-inbox/');
    expect(text).toContain('blobs/'); // 原有内容不动

    // 幂等：第二次什么都不做。
    expect(ensureGitIgnored(workspace, join(workspace, 'wechat-inbox'))).toBe(false);
  });

  it('收件目录在工作区外面时什么都不写', () => {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const file = join(workspace, '.gitignore');
    writeFileSync(file, 'blobs/\n', 'utf8');
    expect(ensureGitIgnored(workspace, join(root, 'outside-inbox'))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('blobs/\n');
  });
});
