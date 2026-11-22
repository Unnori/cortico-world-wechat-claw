/**
 * 「连接与工具」中的 FFmpeg 区域。
 *
 * 视频抽帧要 ffmpeg，但装不装由操作者决定：**只有点「下载」才联网**，启用 World、改配置都不触发。
 * 装在扩展自己的数据目录，不改系统 PATH。
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
    sheet: 'FFmpeg',
    desc: '用于视频抽帧和图片压缩。下载到本扩展的数据目录。',
    download: '下载',
    downloadAgain: '重新下载',
    cancel: '取消下载',
    remove: '删除本地副本',
    ready: '可用',
    fromPath: '来自系统 PATH',
    fromDownloaded: '使用本地副本',
    none: '没有可用的 ffmpeg',
    installed: (mb: string) => `已下载：${mb} MB`,
    version: (v: string) => `版本：${v}`,
    noFrames: '视频抽帧已关闭。',
    pathHint: '当前配置仅使用系统 PATH。',
    offHint: '当前配置已停用 FFmpeg。',
    confirmRemove: '删除已下载的 ffmpeg？之后可以再点下载。',
  },
  en: {
    sheet: 'FFmpeg',
    desc: 'Extracts video frames and compresses images. Installs in the extension data directory.',
    download: 'Download',
    downloadAgain: 'Download again',
    cancel: 'Cancel download',
    remove: 'Remove downloaded copy',
    ready: 'ready',
    fromPath: 'from system PATH',
    fromDownloaded: 'using the local copy',
    none: 'no usable ffmpeg',
    installed: (mb: string) => `Downloaded: ${mb} MB`,
    version: (v: string) => `Version: ${v}`,
    noFrames: 'Video frame extraction is off.',
    pathHint: 'Settings allow only the system PATH.',
    offHint: 'FFmpeg is disabled in settings.',
    confirmRemove: 'Remove the downloaded ffmpeg? You can download it again later.',
  },
};

type Text = (typeof TEXT)['zh'];

function text(language: string): Text {
  return language === 'zh' || language === 'zh-Hant' ? TEXT.zh : TEXT.en;
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

async function mountFfmpeg(ctx: WebUiPanelContext, parent: HTMLElement): Promise<void> {
  const t = text(ctx.language);
  const ui = ctx.ui;

  const section = ui.h('section', 'wcc-service');
  parent.append(section);

  const statusLine = ui.msgline();
  statusLine.setAttribute('role', 'status');
  const versionLine = ui.h('div', 'wcc-detail');
  const sizeLine = ui.h('div', 'wcc-detail');
  const hintLine = ui.h('div', 'wcc-detail');
  const progressLine = ui.msgline();
  const progress = ui.h('progress', 'wcc-progress');
  progress.max = 100;
  progress.setAttribute('aria-label', t.download);
  progress.style.display = 'none';

  const actions = ui.actions();
  const downloadButton = ui.button(t.download, { variant: 'primary' });
  const cancelButton = ui.button(t.cancel, { size: 'sm' });
  const removeButton = ui.button(t.remove, { variant: 'danger', size: 'sm' });
  cancelButton.style.display = 'none';
  removeButton.style.display = 'none';
  actions.append(downloadButton, cancelButton, removeButton);

  section.append(ui.section(t.sheet, t.desc), statusLine, versionLine, sizeLine, hintLine, progress, progressLine, actions);

  let state: FfmpegState = {
    source: 'auto', ready: false, origin: 'none', detail: '', version: '',
    installedBytes: 0, installed: false, installing: false, progress: null, framesWanted: 4,
  };

  const paint = (next: FfmpegState): void => {
    state = next;

    // 一句话说清现在能不能抽帧。
    statusLine.textContent = next.ready
      ? `${t.ready}：${next.origin === 'path' ? t.fromPath : t.fromDownloaded}`
      : next.detail || t.none;
    statusLine.classList.remove('bad');

    versionLine.textContent = next.version ? t.version(next.version.replace(/\s+Copyright.*$/i, '')) : '';
    versionLine.style.display = next.version ? '' : 'none';

    sizeLine.textContent = next.installed ? t.installed(formatMb(next.installedBytes)) : '';
    sizeLine.style.display = next.installed ? '' : 'none';

    // 说明这个来源下装了会不会用，免得白下载。
    const hint = next.source === 'path' ? t.pathHint
      : next.source === 'off' ? t.offHint
        : next.framesWanted > 0 ? '' : t.noFrames;
    hintLine.textContent = hint;
    hintLine.style.display = hint ? '' : 'none';
    progressLine.classList.toggle('bad', next.progress?.phase === 'failed');

    progress.style.display = next.installing ? '' : 'none';
    if (next.progress?.percent != null) progress.value = next.progress.percent;
    else progress.removeAttribute('value');
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
      progressLine.style.display = '';
    } else {
      progressLine.style.display = 'none';
    }

    downloadButton.style.display = next.installing ? 'none' : '';
    downloadButton.textContent = next.installed ? t.downloadAgain : t.download;
    cancelButton.style.display = next.installing ? '' : 'none';
    // 只有真的装了才给删除。
    removeButton.style.display = next.installed && !next.installing ? '' : 'none';
  };

  const readState = async (): Promise<void> => {
    try {
      paint(await ctx.invoke<FfmpegState>('ffmpeg-state'));
    } catch (err) {
      statusLine.textContent = err instanceof Error ? err.message : String(err);
      statusLine.classList.add('bad');
    }
  };

  downloadButton.addEventListener('click', () => {
    void (async () => {
      downloadButton.disabled = true;
      try {
        await ctx.invoke('ffmpeg-install');
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
        await ctx.invoke('ffmpeg-cancel');
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
        await ctx.invoke('ffmpeg-remove');
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
