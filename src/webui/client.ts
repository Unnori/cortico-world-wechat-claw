/**
 * 「微信绑定」面板。
 *
 * 走内建 UI 原语（`ctx.ui`），不碰 document.body，不直连 /api/；数据一律经 `ctx.invoke`
 * 打到 World 的 `webUi().invoke`。
 *
 * 扫码流程：点「生成二维码」→ 显示二维码图片 → 手机扫码 → 需要时填验证码 → 绑定成功。
 * 状态每秒轮询一次，面板卸载时由 host 清理。
 */
import type { WebUiPanelContext, WebUiClientBundle } from 'cortico/web/shared/client-panel.ts';

import { mountFfmpeg } from './ffmpeg.ts';

/** 与 World 的 `#publicState()` 对应的字段。 */
interface BindingState {
  bound: boolean;
  connected: boolean;
  status: string;
  accountId: string;
  userId: string;
  lastMessageAt: string;
  lastError: string;
  contextTokens: number;
  qrDataUrl: string;
  qrUrl: string;
  loginStatus: string;
  loginError: string;
  verifyRequired: boolean;
}

const TEXT = {
  zh: {
    sheet: '微信绑定',
    desc: '用手机微信扫码，把这个微信号接到桌宠。只支持一对一私聊。',
    generate: '生成二维码',
    refresh: '重新生成',
    cancel: '取消扫码',
    reconnect: '重新连接',
    verifyLabel: '手机微信显示的数字',
    verifyPlaceholder: '例如 123456',
    verifySubmit: '提交验证码',
    openLink: '二维码打不开？复制这个链接',
    account: '已绑定',
    unbound: '还没绑定微信。',
    binding: '等待扫码…',
    connected: '已连接',
    connecting: '连接中…',
    error: '连接异常',
    tokenCount: (n: number) => `持有 ${n} 条会话令牌`,
    lastMessage: (at: string) => `最近一条微信消息：${at}`,
    noMessage: '还没收到过微信消息。',
    copy: '复制',
    copied: '链接已复制。',
  },
  en: {
    sheet: 'WeChat binding',
    desc: 'Scan with WeChat to bind this contact. One-to-one private chat only.',
    generate: 'Show QR code',
    refresh: 'New QR code',
    cancel: 'Cancel',
    reconnect: 'Reconnect',
    verifyLabel: 'The number shown in WeChat',
    verifyPlaceholder: 'for example 123456',
    verifySubmit: 'Submit',
    openLink: 'QR code not opening? Copy this link',
    account: 'Bound',
    unbound: 'WeChat is not bound yet.',
    binding: 'Waiting for the scan…',
    connected: 'Connected',
    connecting: 'Connecting…',
    error: 'Connection error',
    tokenCount: (n: number) => `${n} session token(s) held`,
    lastMessage: (at: string) => `Last WeChat message: ${at}`,
    noMessage: 'No WeChat message yet.',
    copy: 'Copy',
    copied: 'Link copied.',
  },
};

type Text = (typeof TEXT)['zh'];

function text(language: string): Text {
  return language === 'zh' || language === 'zh-Hant' ? TEXT.zh : TEXT.en;
}

async function mountBinding(ctx: WebUiPanelContext): Promise<void> {
  const t = text(ctx.language);
  const ui = ctx.ui;

  const sheet = ui.sheet({ title: t.sheet, desc: t.desc });
  ctx.root.append(sheet.el);

  const stateLine = ui.msgline();
  const whoLine = ui.msgline();
  const tokenLine = ui.msgline();
  const messageLine = ui.msgline();

  // 二维码区：有图时显示图，没图时留空。
  const qrBox = ui.h('div', 'qrbox');
  const qrImage = ui.h('img', 'qr');
  qrImage.alt = t.sheet;
  qrImage.style.maxWidth = '280px';
  qrBox.append(qrImage);
  qrBox.style.display = 'none';

  const linkRow = ui.rowbar();
  linkRow.style.display = 'none';
  const linkLabel = ui.h('span', 'dim', t.openLink);
  const linkCopy = ui.copyButton(() => currentState.qrUrl ?? '', { label: t.copy, okText: t.copied });
  linkRow.append(linkLabel, linkCopy);

  // 验证码区：只在服务端要求时出现。
  const verifyRow = ui.rowbar();
  verifyRow.style.display = 'none';
  const verifyInput = ui.input({ type: 'text', placeholder: t.verifyPlaceholder });
  const verifyButton = ui.button(t.verifySubmit, { variant: 'primary', size: 'sm' });
  verifyRow.append(ui.field(t.verifyLabel, verifyInput), verifyButton);

  const actions = ui.actions();
  const generateButton = ui.button(t.generate, { variant: 'primary' });
  const cancelButton = ui.button(t.cancel, { size: 'sm' });
  const reconnectButton = ui.button(t.reconnect, { size: 'sm' });
  cancelButton.style.display = 'none';
  reconnectButton.style.display = 'none';
  actions.append(generateButton, cancelButton, reconnectButton);

  sheet.body.append(stateLine, whoLine, tokenLine, messageLine, qrBox, linkRow, verifyRow, actions);

  let currentState: BindingState = {
    bound: false,
    connected: false,
    status: 'unbound',
    accountId: '',
    userId: '',
    lastMessageAt: '',
    lastError: '',
    contextTokens: 0,
    qrDataUrl: '',
    qrUrl: '',
    loginStatus: '',
    loginError: '',
    verifyRequired: false,
  };

  const paint = (next: BindingState): void => {
    currentState = next;

    // 状态行：一句话说清现在能不能收消息。
    const statusText = next.connected
      ? t.connected
      : next.loginStatus && next.loginStatus !== 'unbound' && next.status === 'binding'
        ? t.binding
        : next.bound
          ? t.connecting
          : next.lastError
            ? t.error
            : t.unbound;
    stateLine.textContent = statusText;
    stateLine.classList.toggle('bad', Boolean(next.lastError) && !next.connected);

    whoLine.textContent = next.bound
      ? `${t.account}：${shortId(next.userId || next.accountId)}`
      : '';
    whoLine.style.display = next.bound ? '' : 'none';

    tokenLine.textContent = next.bound ? t.tokenCount(next.contextTokens) : '';
    tokenLine.style.display = next.bound ? '' : 'none';

    messageLine.textContent = next.lastMessageAt
      ? t.lastMessage(next.lastMessageAt.replace('T', ' ').slice(0, 19))
      : (next.bound ? t.noMessage : '');
    messageLine.style.display = next.bound ? '' : 'none';

    // 错误：优先显示扫码期的具体原因。
    if (next.loginError) {
      stateLine.textContent = next.loginError;
      stateLine.classList.add('bad');
    } else if (next.lastError && !next.connected) {
      stateLine.textContent = `${t.error}：${next.lastError}`;
      stateLine.classList.add('bad');
    }

    const showQr = Boolean(next.qrDataUrl) && !next.bound;
    qrBox.style.display = showQr ? '' : 'none';
    if (showQr && qrImage.src !== next.qrDataUrl) qrImage.src = next.qrDataUrl;

    const showLink = Boolean(next.qrUrl) && !next.bound;
    linkRow.style.display = showLink ? '' : 'none';

    verifyRow.style.display = next.verifyRequired ? '' : 'none';

    // 按钮：未绑定给「生成二维码」，扫码中给「取消」；已绑定给「重新连接」。
    const binding = next.status === 'binding' || Boolean(next.qrDataUrl);
    generateButton.textContent = binding ? t.refresh : t.generate;
    generateButton.style.display = next.bound ? 'none' : '';
    cancelButton.style.display = binding && !next.bound ? '' : 'none';
    reconnectButton.style.display = next.bound ? '' : 'none';
  };

  const readState = async (): Promise<void> => {
    try {
      paint(await ctx.invoke<BindingState>('state'));
    } catch (err) {
      stateLine.textContent = `${t.error}：${err instanceof Error ? err.message : String(err)}`;
      stateLine.classList.add('bad');
    }
  };

  generateButton.addEventListener('click', () => {
    void (async () => {
      generateButton.disabled = true;
      try {
        paint(await ctx.invoke<BindingState>('start'));
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      } finally {
        generateButton.disabled = false;
      }
    })();
  });

  cancelButton.addEventListener('click', () => {
    void (async () => {
      try {
        paint(await ctx.invoke<BindingState>('cancel'));
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    })();
  });

  reconnectButton.addEventListener('click', () => {
    void (async () => {
      try {
        paint(await ctx.invoke<BindingState>('reconnect'));
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    })();
  });

  const submitVerify = (): void => {
    const code = verifyInput.value.trim();
    if (!code) return;
    void (async () => {
      try {
        paint(await ctx.invoke<BindingState>('verify', [code]));
        verifyInput.value = '';
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      }
    })();
  };
  verifyButton.addEventListener('click', submitVerify);
  verifyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitVerify();
  });

  // 扫码期间状态变化快，一秒一次；绑定后也保持轮询，好让连接状态跟着变。
  ctx.interval(() => {
    void readState();
  }, 1000);

  await readState();
}

function shortId(value: string): string {
  const id = String(value ?? '');
  if (!id) return '';
  const local = id.includes('@') ? id.slice(0, id.indexOf('@')) : id;
  return local.length > 12 ? `${local.slice(0, 10)}…` : local;
}

const bundle: WebUiClientBundle = {
  panels: {
    binding: { mount: mountBinding },
    ffmpeg: { mount: mountFfmpeg },
  },
};

export default bundle;
