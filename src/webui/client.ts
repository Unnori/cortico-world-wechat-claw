/**
 * 「连接与工具」面板。
 *
 * 走内建 UI 原语（`ctx.ui`），不碰 document.body，不直连 /api/；数据一律经 `ctx.invoke`
 * 打到 World 的 `webUi().invoke`。
 *
 * 扫码流程：点「生成二维码」→ 显示二维码图片 → 手机扫码 → 需要时填验证码 → 绑定成功。
 * 状态每秒轮询一次，面板卸载时由 host 清理。
 */
import type { WebUiPanelContext, WebUiClientBundle } from 'cortico/web/shared/client-panel.ts';

import { mountFfmpeg } from './ffmpeg.ts';
import { mountTts } from './tts.ts';
import './webui.css';

/** 与 World 的 `#publicState()` 对应的字段。 */
interface BindingState {
  bound: boolean;
  connected: boolean;
  status: string;
  accountId: string;
  userId: string;
  lastMessageAt: string;
  /** 已按部署时区格式化好的本地时间；优先用它，别直接截 lastMessageAt。 */
  lastMessageLocal: string;
  lastError: string;
  qrDataUrl: string;
  qrUrl: string;
  loginError: string;
  verifyRequired: boolean;
}

const TEXT = {
  zh: {
    sheet: '微信绑定',
    desc: '用手机微信扫码接入一对一私聊。',
    loading: '正在读取微信状态…',
    generate: '生成二维码',
    refresh: '重新生成',
    cancel: '取消扫码',
    reconnect: '重新连接',
    unbind: '解绑',
    unbindConfirm: '解绑会清掉本机保存的微信凭据，之后要重新扫码才能收消息。微信里的那个对话不会消失。确定解绑？',
    unbindDone: '已解绑，本机不再收发微信消息。',
    verifyLabel: '手机微信显示的数字',
    verifyPlaceholder: '例如 123456',
    verifySubmit: '提交验证码',
    openLink: '二维码打不开？复制这个链接',
    account: '账号',
    unbound: '未绑定',
    binding: '等待扫码…',
    connected: '已连接',
    connecting: '连接中…',
    error: '连接异常',
    lastMessage: (at: string) => `最近一条微信消息：${at}`,
    noMessage: '还没收到过微信消息。',
    copy: '复制',
    copied: '链接已复制。',
  },
  en: {
    sheet: 'WeChat binding',
    desc: 'Scan with WeChat to connect a private chat.',
    loading: 'Reading WeChat status…',
    generate: 'Show QR code',
    refresh: 'New QR code',
    cancel: 'Cancel',
    reconnect: 'Reconnect',
    unbind: 'Unbind',
    unbindConfirm: 'Unbinding clears the WeChat credentials saved on this machine; you will need to scan again to receive messages. The chat in WeChat itself stays. Continue?',
    unbindDone: 'Unbound. This machine no longer sends or receives WeChat messages.',
    verifyLabel: 'The number shown in WeChat',
    verifyPlaceholder: 'for example 123456',
    verifySubmit: 'Submit',
    openLink: 'QR code not opening? Copy this link',
    account: 'Account',
    unbound: 'Unbound',
    binding: 'Waiting for the scan…',
    connected: 'Connected',
    connecting: 'Connecting…',
    error: 'Connection error',
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

  const sheet = ui.sheet({ title: t.sheet });
  sheet.el.classList.add('wechat-claw-console');
  ctx.root.append(sheet.el);

  const bindingRow = ui.h('div', 'wcc-binding-row');
  const facts = ui.h('div', 'wcc-binding-facts');
  const identity = ui.h('div', 'wcc-identity');
  const stateLine = ui.pill(t.loading);
  stateLine.setAttribute('role', 'status');
  const whoLine = ui.h('span', 'wcc-account');
  const messageLine = ui.h('div', 'wcc-detail', t.desc);
  const errorLine = ui.msgline('', true);
  errorLine.setAttribute('role', 'status');
  errorLine.style.display = 'none';
  identity.append(stateLine, whoLine);
  facts.append(identity, messageLine);

  // 二维码区：有图时显示图，没图时留空。
  const qrBox = ui.h('div', 'qrbox');
  const qrImage = ui.h('img', 'qr');
  qrImage.alt = t.sheet;
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
  const unbindButton = ui.button(t.unbind, { variant: 'danger', size: 'sm' });
  cancelButton.style.display = 'none';
  reconnectButton.style.display = 'none';
  unbindButton.style.display = 'none';
  actions.append(generateButton, cancelButton, reconnectButton, unbindButton);

  bindingRow.append(facts, actions);
  const services = ui.h('div', 'wcc-services');
  sheet.body.append(bindingRow, errorLine, qrBox, linkRow, verifyRow, services);

  let currentState: BindingState = {
    bound: false,
    connected: false,
    status: 'unbound',
    accountId: '',
    userId: '',
    lastMessageAt: '',
    lastMessageLocal: '',
    lastError: '',
    qrDataUrl: '',
    qrUrl: '',
    loginError: '',
    verifyRequired: false,
  };

  const paint = (next: BindingState): void => {
    currentState = next;

    // 状态行：一句话说清现在能不能收消息。
    const problem = next.loginError || (!next.connected ? next.lastError : '');
    const statusText = next.connected ? t.connected
      : problem ? t.error
        : next.status === 'binding' ? t.binding
          : next.bound ? t.connecting : t.unbound;
    if (stateLine.textContent !== statusText) stateLine.textContent = statusText;
    stateLine.classList.toggle('on', next.connected);
    stateLine.classList.toggle('off', !next.connected && !next.loginError && !next.lastError);

    whoLine.textContent = next.bound
      ? `${t.account}：${shortId(next.userId || next.accountId)}`
      : '';
    whoLine.style.display = next.bound ? '' : 'none';

    // 用服务端给的本地时间；没有就退回原始值，但不截 UTC 钟点。
    const stamp = next.lastMessageLocal || (next.lastMessageAt ? next.lastMessageAt.replace('T', ' ').slice(0, 19) : '');
    messageLine.textContent = next.bound ? (stamp ? t.lastMessage(stamp) : t.noMessage) : t.desc;
    if (errorLine.textContent !== problem) errorLine.textContent = problem;
    errorLine.style.display = problem ? '' : 'none';

    const showQr = Boolean(next.qrDataUrl) && !next.bound;
    qrBox.style.display = showQr ? '' : 'none';
    if (showQr && qrImage.src !== next.qrDataUrl) qrImage.src = next.qrDataUrl;

    const showLink = Boolean(next.qrUrl) && !next.bound;
    linkRow.style.display = showLink ? '' : 'none';

    verifyRow.style.display = next.verifyRequired ? '' : 'none';

    // 按钮：未绑定给「生成二维码」，扫码中给「取消」；已绑定给「重新连接」与「解绑」。
    const binding = next.status === 'binding' || Boolean(next.qrDataUrl);
    generateButton.textContent = binding ? t.refresh : t.generate;
    generateButton.style.display = next.bound ? 'none' : '';
    cancelButton.style.display = binding && !next.bound ? '' : 'none';
    reconnectButton.style.display = next.bound ? '' : 'none';
    unbindButton.style.display = next.bound ? '' : 'none';
  };

  const readState = async (): Promise<void> => {
    try {
      paint(await ctx.invoke<BindingState>('state'));
    } catch (err) {
      stateLine.textContent = t.error;
      stateLine.classList.remove('on', 'off');
      errorLine.textContent = err instanceof Error ? err.message : String(err);
      errorLine.style.display = '';
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

  // 解绑会清凭据，先确认一次；不可撤销，所以给 danger 样式的确认框。
  unbindButton.addEventListener('click', () => {
    void (async () => {
      const ok = await ui.confirm({ title: t.unbind, body: t.unbindConfirm, danger: true });
      if (!ok) return;
      unbindButton.disabled = true;
      try {
        paint(await ctx.invoke<BindingState>('unbind'));
        ui.toast(t.unbindDone, 'ok');
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), 'bad');
      } finally {
        unbindButton.disabled = false;
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

  await Promise.all([readState(), mountFfmpeg(ctx, services), mountTts(ctx, services)]);
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
  },
};

export default bundle;
