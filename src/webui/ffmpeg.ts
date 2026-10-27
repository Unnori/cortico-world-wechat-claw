/**
 * 「ffmpeg」面板。
 *
 * 视频抽帧要 ffmpeg，但装不装由操作者决定：**只有点「下载」才联网**，启用 World、改配置都不触发。
 * 装在扩展自己的数据目录，不改系统 PATH——所以这里给一个「复制路径」，想手动加 PATH 的人自己粘。
 */
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

/** 与 World 的 `#ffmpegState()` 对应。 */
interface FfmpegState {
  source: string;
  ready: boolean;
  origin: 'path' | 'downloaded' | 'none';
  detail: string;
  version: string;
  installedBytes: number;
  installed: boolean;
  installing: boolean;
  progress: { phase: string; detail: string; received: number; total: number; percent: number | null } | null;
  framesWanted: number;
}

const TEXT = {
  zh: {
    sheet: 'ffmpeg',
    desc: '视频抽帧要 ffmpeg。点「下载」才会联网；装在本扩展的数据目录里，不改系统环境变量。',
    download: '下载 ffmpeg',
    cancel: '取消下载',
    remove: '删除已下载的',
    copyPath: '复制路径',
    copied: '路径已复制。',
    ready: '可用',
    notReady: '不可用',
    fromPath: '用系统 PATH 里的那份',
    fromDownloaded: '用本扩展下载的那份',
    none: '没有可用的 ffmpeg',
    installed: (mb: string) => `已下载：${mb} MB`,
    notInstalled: '尚未下载',
    version: (v: string) => `版本：${v}`,
    noFrames: '抽帧现在是关的（「每条视频抽几帧」为 0），装了也不会用。',
    autoHint: '来源设为 auto：先找 PATH，找不到才用这里下载的那份。',
    pathHint: '来源设为 path：只用系统 PATH 里的，这里下载的那份不会被使用。',
    offHint: '来源设为 off：不抽帧，装了也不会用。',
    confirmRemove: '删除已下载的 ffmpeg？之后可以再点下载。',
  },
  en: {
    sheet: 'ffmpeg',
    desc: 'Video frames need ffmpeg. Nothing is downloaded until you press Download; it installs in this extension\'s data directory and leaves PATH alone.',
    download: 'Download ffmpeg',
    cancel: 'Cancel download',
    remove: 'Remove downloaded copy',
    copyPath: 'Copy path',
    copied: 'Path copied.',
    ready: 'ready',
    notReady: 'not available',
    fromPath: 'using the one on PATH',
    fromDownloaded: 'using the copy downloaded here',
    none: 'no usable ffmpeg',
    installed: (mb: string) => `Downloaded: ${mb} MB`,
    notInstalled: 'Not downloaded',
    version: (v: string) => `Version: ${v}`,
    noFrames: 'Frame extraction is off (frames per video is 0), so an installed copy would not be used.',
    autoHint: 'Source is auto: PATH first, then the copy downloaded here.',
    pathHint: 'Source is path: only PATH is used, so a copy downloaded here is ignored.',
    offHint: 'Source is off: no frames are extracted, so an installed copy is ignored.',
    confirmRemove: 'Remove the downloaded ffmpeg? You can download it again later.',
  },
};

type Text = (typeof TEXT)['zh'];

function text(language: string): Text {
  return language === 'zh' || language === 'zh-Hant' ? TEXT.zh : TEXT.en;
}

function formatMb(bytes: number): string {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) : (bytes / 1024).toFixed(0);
}

async function mountFfmpeg(ctx: WebUiPanelContext): Promise<void> {
  const t = text(ctx.language);
  const ui = ctx.ui;

  const sheet = ui.sheet({ title: t.sheet, desc: t.desc });
  ctx.root.append(sheet.el);

  const statusLine = ui.msgline();
  const versionLine = ui.msgline();
  const sizeLine = ui.msgline();
  const hintLine = ui.msgline();
  const progressLine = ui.msgline();

  const actions = ui.actions();
  const downloadButton = ui.button(t.download, { variant: 'primary' });
  const cancelButton = ui.button(t.cancel, { size: 'sm' });
  const removeButton = ui.button(t.remove, { variant: 'danger', size: 'sm' });
  const copyButton = ui.copyButton('', { label: t.copyPath, okText: t.copied });
  cancelButton.style.display = 'none';
  actions.append(downloadButton, cancelButton, removeButton, copyButton);

  sheet.body.append(statusLine, versionLine, sizeLine, hintLine, progressLine, actions);

  let state: FfmpegState = {
    source: 'auto', ready: false, origin: 'none', detail: '', version: '',
    installedBytes: 0, installed: false, installing: false, progress: null, framesWanted: 4,
  };

  const paint = (next: FfmpegState): void => {
    state = next;

    // 一句话说清现在能不能抽帧。
    statusLine.textContent = next.ready
      ? `${t.ready}：${next.origin === 'path' ? t.fromPath : t.fromDownloaded}`
      : `${t.notReady}：${next.detail || t.none}`;
    statusLine.classList.toggle('bad', !next.ready);

    versionLine.textContent = next.version ? t.version(next.version) : '';
    versionLine.style.display = next.version ? '' : 'none';

    sizeLine.textContent = next.installed ? t.installed(formatMb(next.installedBytes)) : t.notInstalled;
    sizeLine.classList.toggle('dim', !next.installed);

    // 说明这个来源下装了会不会用，免得白下载。
    const hint = next.source === 'path' ? t.pathHint
      : next.source === 'off' ? t.offHint
        : next.framesWanted > 0 ? t.autoHint : t.noFrames;
    hintLine.textContent = hint;
    hintLine.classList.toggle('bad', next.framesWanted <= 0 || next.source !== 'auto');

    if (next.installing && next.progress) {
      const p = next.progress;
      const mb = p.total > 0
        ? `${formatMb(p.received)} / ${formatMb(p.total)} MB`
        : `${formatMb(p.received)} MB`;
      progressLine.textContent = p.phase === 'verifying'
        ? p.detail
        : `${p.detail} ${mb}${p.percent !== null ? `（${p.percent}%）` : ''}`;
      progressLine.style.display = '';
    } else if (next.progress && next.progress.phase === 'failed') {
      progressLine.textContent = next.progress.detail;
      progressLine.classList.add('bad');
      progressLine.style.display = '';
    } else {
      progressLine.style.display = 'none';
      progressLine.classList.remove('bad');
    }

    downloadButton.style.display = next.installing ? 'none' : '';
    downloadButton.textContent = next.installed ? t.download : t.download;
    cancelButton.style.display = next.installing ? '' : 'none';
    // 只有真的装了才给删除。
    removeButton.style.display = next.installed && !next.installing ? '' : 'none';
    copyButton.style.display = next.installed && !next.installing ? '' : 'none';
  };

  const readState = async (): Promise<void> => {
    try {
      paint(await ctx.invoke<FfmpegState>('state'));
    } catch (err) {
      statusLine.textContent = err instanceof Error ? err.message : String(err);
      statusLine.classList.add('bad');
    }
  };

  downloadButton.addEventListener('click', () => {
    void (async () => {
      downloadButton.disabled = true;
      try {
        await ctx.invoke('install');
        await readState();
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      } finally {
        downloadButton.disabled = false;
      }
    })();
  });

  cancelButton.addEventListener('click', () => {
    void (async () => {
      try {
        await ctx.invoke('cancel');
        await readState();
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    })();
  });

  removeButton.addEventListener('click', () => {
    void (async () => {
      const ok = await ui.confirm({ title: t.remove, body: t.confirmRemove, danger: true });
      if (!ok) return;
      try {
        await ctx.invoke('remove');
        await readState();
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    })();
  });

  // 下载期间一秒一次，平时靠按钮回执刷新。
  ctx.interval(() => {
    if (state.installing) void readState();
  }, 1000);

  await readState();
}

export { mountFfmpeg };
