// ../../extensions/cortico-world-wechat-claw/src/webui/ffmpeg.ts
var TEXT = {
  zh: {
    sheet: "ffmpeg",
    desc: "\u89C6\u9891\u62BD\u5E27\u8981 ffmpeg\u3002\u70B9\u300C\u4E0B\u8F7D\u300D\u624D\u4F1A\u8054\u7F51\uFF1B\u88C5\u5728\u672C\u6269\u5C55\u7684\u6570\u636E\u76EE\u5F55\u91CC\uFF0C\u4E0D\u6539\u7CFB\u7EDF\u73AF\u5883\u53D8\u91CF\u3002",
    download: "\u4E0B\u8F7D ffmpeg",
    cancel: "\u53D6\u6D88\u4E0B\u8F7D",
    remove: "\u5220\u9664\u5DF2\u4E0B\u8F7D\u7684",
    copyPath: "\u590D\u5236\u8DEF\u5F84",
    copied: "\u8DEF\u5F84\u5DF2\u590D\u5236\u3002",
    ready: "\u53EF\u7528",
    notReady: "\u4E0D\u53EF\u7528",
    fromPath: "\u7528\u7CFB\u7EDF PATH \u91CC\u7684\u90A3\u4EFD",
    fromDownloaded: "\u7528\u672C\u6269\u5C55\u4E0B\u8F7D\u7684\u90A3\u4EFD",
    none: "\u6CA1\u6709\u53EF\u7528\u7684 ffmpeg",
    installed: (mb) => `\u5DF2\u4E0B\u8F7D\uFF1A${mb} MB`,
    notInstalled: "\u5C1A\u672A\u4E0B\u8F7D",
    version: (v) => `\u7248\u672C\uFF1A${v}`,
    noFrames: "\u62BD\u5E27\u73B0\u5728\u662F\u5173\u7684\uFF08\u300C\u6BCF\u6761\u89C6\u9891\u62BD\u51E0\u5E27\u300D\u4E3A 0\uFF09\uFF0C\u88C5\u4E86\u4E5F\u4E0D\u4F1A\u7528\u3002",
    autoHint: "\u6765\u6E90\u8BBE\u4E3A auto\uFF1A\u5148\u627E PATH\uFF0C\u627E\u4E0D\u5230\u624D\u7528\u8FD9\u91CC\u4E0B\u8F7D\u7684\u90A3\u4EFD\u3002",
    pathHint: "\u6765\u6E90\u8BBE\u4E3A path\uFF1A\u53EA\u7528\u7CFB\u7EDF PATH \u91CC\u7684\uFF0C\u8FD9\u91CC\u4E0B\u8F7D\u7684\u90A3\u4EFD\u4E0D\u4F1A\u88AB\u4F7F\u7528\u3002",
    offHint: "\u6765\u6E90\u8BBE\u4E3A off\uFF1A\u4E0D\u62BD\u5E27\uFF0C\u88C5\u4E86\u4E5F\u4E0D\u4F1A\u7528\u3002",
    confirmRemove: "\u5220\u9664\u5DF2\u4E0B\u8F7D\u7684 ffmpeg\uFF1F\u4E4B\u540E\u53EF\u4EE5\u518D\u70B9\u4E0B\u8F7D\u3002"
  },
  en: {
    sheet: "ffmpeg",
    desc: "Video frames need ffmpeg. Nothing is downloaded until you press Download; it installs in this extension's data directory and leaves PATH alone.",
    download: "Download ffmpeg",
    cancel: "Cancel download",
    remove: "Remove downloaded copy",
    copyPath: "Copy path",
    copied: "Path copied.",
    ready: "ready",
    notReady: "not available",
    fromPath: "using the one on PATH",
    fromDownloaded: "using the copy downloaded here",
    none: "no usable ffmpeg",
    installed: (mb) => `Downloaded: ${mb} MB`,
    notInstalled: "Not downloaded",
    version: (v) => `Version: ${v}`,
    noFrames: "Frame extraction is off (frames per video is 0), so an installed copy would not be used.",
    autoHint: "Source is auto: PATH first, then the copy downloaded here.",
    pathHint: "Source is path: only PATH is used, so a copy downloaded here is ignored.",
    offHint: "Source is off: no frames are extracted, so an installed copy is ignored.",
    confirmRemove: "Remove the downloaded ffmpeg? You can download it again later."
  }
};
function text(language) {
  return language === "zh" || language === "zh-Hant" ? TEXT.zh : TEXT.en;
}
function formatMb(bytes) {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) : (bytes / 1024).toFixed(0);
}
async function mountFfmpeg(ctx) {
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
  const downloadButton = ui.button(t.download, { variant: "primary" });
  const cancelButton = ui.button(t.cancel, { size: "sm" });
  const removeButton = ui.button(t.remove, { variant: "danger", size: "sm" });
  const copyButton = ui.copyButton("", { label: t.copyPath, okText: t.copied });
  cancelButton.style.display = "none";
  actions.append(downloadButton, cancelButton, removeButton, copyButton);
  sheet.body.append(statusLine, versionLine, sizeLine, hintLine, progressLine, actions);
  let state = {
    source: "auto",
    ready: false,
    origin: "none",
    detail: "",
    version: "",
    installedBytes: 0,
    installed: false,
    installing: false,
    progress: null,
    framesWanted: 4
  };
  const paint = (next) => {
    state = next;
    statusLine.textContent = next.ready ? `${t.ready}\uFF1A${next.origin === "path" ? t.fromPath : t.fromDownloaded}` : `${t.notReady}\uFF1A${next.detail || t.none}`;
    statusLine.classList.toggle("bad", !next.ready);
    versionLine.textContent = next.version ? t.version(next.version) : "";
    versionLine.style.display = next.version ? "" : "none";
    sizeLine.textContent = next.installed ? t.installed(formatMb(next.installedBytes)) : t.notInstalled;
    sizeLine.classList.toggle("dim", !next.installed);
    const hint = next.source === "path" ? t.pathHint : next.source === "off" ? t.offHint : next.framesWanted > 0 ? t.autoHint : t.noFrames;
    hintLine.textContent = hint;
    hintLine.classList.toggle("bad", next.framesWanted <= 0 || next.source !== "auto");
    if (next.installing && next.progress) {
      const p = next.progress;
      const mb = p.total > 0 ? `${formatMb(p.received)} / ${formatMb(p.total)} MB` : `${formatMb(p.received)} MB`;
      progressLine.textContent = p.phase === "verifying" ? p.detail : `${p.detail} ${mb}${p.percent !== null ? `\uFF08${p.percent}%\uFF09` : ""}`;
      progressLine.style.display = "";
    } else if (next.progress && next.progress.phase === "failed") {
      progressLine.textContent = next.progress.detail;
      progressLine.classList.add("bad");
      progressLine.style.display = "";
    } else {
      progressLine.style.display = "none";
      progressLine.classList.remove("bad");
    }
    downloadButton.style.display = next.installing ? "none" : "";
    downloadButton.textContent = next.installed ? t.download : t.download;
    cancelButton.style.display = next.installing ? "" : "none";
    removeButton.style.display = next.installed && !next.installing ? "" : "none";
    copyButton.style.display = next.installed && !next.installing ? "" : "none";
  };
  const readState = async () => {
    try {
      paint(await ctx.invoke("state"));
    } catch (err) {
      statusLine.textContent = err instanceof Error ? err.message : String(err);
      statusLine.classList.add("bad");
    }
  };
  downloadButton.addEventListener("click", () => {
    void (async () => {
      downloadButton.disabled = true;
      try {
        await ctx.invoke("install");
        await readState();
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), "bad");
      } finally {
        downloadButton.disabled = false;
      }
    })();
  });
  cancelButton.addEventListener("click", () => {
    void (async () => {
      try {
        await ctx.invoke("cancel");
        await readState();
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), "bad");
      }
    })();
  });
  removeButton.addEventListener("click", () => {
    void (async () => {
      const ok = await ui.confirm({ title: t.remove, body: t.confirmRemove, danger: true });
      if (!ok) return;
      try {
        await ctx.invoke("remove");
        await readState();
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), "bad");
      }
    })();
  });
  ctx.interval(() => {
    if (state.installing) void readState();
  }, 1e3);
  await readState();
}

// ../../extensions/cortico-world-wechat-claw/src/webui/client.ts
var TEXT2 = {
  zh: {
    sheet: "\u5FAE\u4FE1\u7ED1\u5B9A",
    desc: "\u7528\u624B\u673A\u5FAE\u4FE1\u626B\u7801\uFF0C\u628A\u8FD9\u4E2A\u5FAE\u4FE1\u53F7\u63A5\u5230\u684C\u5BA0\u3002\u53EA\u652F\u6301\u4E00\u5BF9\u4E00\u79C1\u804A\u3002",
    generate: "\u751F\u6210\u4E8C\u7EF4\u7801",
    refresh: "\u91CD\u65B0\u751F\u6210",
    cancel: "\u53D6\u6D88\u626B\u7801",
    reconnect: "\u91CD\u65B0\u8FDE\u63A5",
    unbind: "\u89E3\u7ED1",
    unbindConfirm: "\u89E3\u7ED1\u4F1A\u6E05\u6389\u672C\u673A\u4FDD\u5B58\u7684\u5FAE\u4FE1\u51ED\u636E\uFF0C\u4E4B\u540E\u8981\u91CD\u65B0\u626B\u7801\u624D\u80FD\u6536\u6D88\u606F\u3002\u5FAE\u4FE1\u91CC\u7684\u90A3\u4E2A\u5BF9\u8BDD\u4E0D\u4F1A\u6D88\u5931\u3002\u786E\u5B9A\u89E3\u7ED1\uFF1F",
    unbindDone: "\u5DF2\u89E3\u7ED1\uFF0C\u672C\u673A\u4E0D\u518D\u6536\u53D1\u5FAE\u4FE1\u6D88\u606F\u3002",
    verifyLabel: "\u624B\u673A\u5FAE\u4FE1\u663E\u793A\u7684\u6570\u5B57",
    verifyPlaceholder: "\u4F8B\u5982 123456",
    verifySubmit: "\u63D0\u4EA4\u9A8C\u8BC1\u7801",
    openLink: "\u4E8C\u7EF4\u7801\u6253\u4E0D\u5F00\uFF1F\u590D\u5236\u8FD9\u4E2A\u94FE\u63A5",
    account: "\u5DF2\u7ED1\u5B9A",
    unbound: "\u8FD8\u6CA1\u7ED1\u5B9A\u5FAE\u4FE1\u3002",
    binding: "\u7B49\u5F85\u626B\u7801\u2026",
    connected: "\u5DF2\u8FDE\u63A5",
    connecting: "\u8FDE\u63A5\u4E2D\u2026",
    error: "\u8FDE\u63A5\u5F02\u5E38",
    tokenCount: (n) => `\u6301\u6709 ${n} \u6761\u4F1A\u8BDD\u4EE4\u724C`,
    lastMessage: (at) => `\u6700\u8FD1\u4E00\u6761\u5FAE\u4FE1\u6D88\u606F\uFF1A${at}`,
    noMessage: "\u8FD8\u6CA1\u6536\u5230\u8FC7\u5FAE\u4FE1\u6D88\u606F\u3002",
    copy: "\u590D\u5236",
    copied: "\u94FE\u63A5\u5DF2\u590D\u5236\u3002"
  },
  en: {
    sheet: "WeChat binding",
    desc: "Scan with WeChat to bind this contact. One-to-one private chat only.",
    generate: "Show QR code",
    refresh: "New QR code",
    cancel: "Cancel",
    reconnect: "Reconnect",
    unbind: "Unbind",
    unbindConfirm: "Unbinding clears the WeChat credentials saved on this machine; you will need to scan again to receive messages. The chat in WeChat itself stays. Continue?",
    unbindDone: "Unbound. This machine no longer sends or receives WeChat messages.",
    verifyLabel: "The number shown in WeChat",
    verifyPlaceholder: "for example 123456",
    verifySubmit: "Submit",
    openLink: "QR code not opening? Copy this link",
    account: "Bound",
    unbound: "WeChat is not bound yet.",
    binding: "Waiting for the scan\u2026",
    connected: "Connected",
    connecting: "Connecting\u2026",
    error: "Connection error",
    tokenCount: (n) => `${n} session token(s) held`,
    lastMessage: (at) => `Last WeChat message: ${at}`,
    noMessage: "No WeChat message yet.",
    copy: "Copy",
    copied: "Link copied."
  }
};
function text2(language) {
  return language === "zh" || language === "zh-Hant" ? TEXT2.zh : TEXT2.en;
}
async function mountBinding(ctx) {
  const t = text2(ctx.language);
  const ui = ctx.ui;
  const sheet = ui.sheet({ title: t.sheet, desc: t.desc });
  ctx.root.append(sheet.el);
  const stateLine = ui.msgline();
  const whoLine = ui.msgline();
  const tokenLine = ui.msgline();
  const messageLine = ui.msgline();
  const qrBox = ui.h("div", "qrbox");
  const qrImage = ui.h("img", "qr");
  qrImage.alt = t.sheet;
  qrImage.style.maxWidth = "280px";
  qrBox.append(qrImage);
  qrBox.style.display = "none";
  const linkRow = ui.rowbar();
  linkRow.style.display = "none";
  const linkLabel = ui.h("span", "dim", t.openLink);
  const linkCopy = ui.copyButton(() => currentState.qrUrl ?? "", { label: t.copy, okText: t.copied });
  linkRow.append(linkLabel, linkCopy);
  const verifyRow = ui.rowbar();
  verifyRow.style.display = "none";
  const verifyInput = ui.input({ type: "text", placeholder: t.verifyPlaceholder });
  const verifyButton = ui.button(t.verifySubmit, { variant: "primary", size: "sm" });
  verifyRow.append(ui.field(t.verifyLabel, verifyInput), verifyButton);
  const actions = ui.actions();
  const generateButton = ui.button(t.generate, { variant: "primary" });
  const cancelButton = ui.button(t.cancel, { size: "sm" });
  const reconnectButton = ui.button(t.reconnect, { size: "sm" });
  const unbindButton = ui.button(t.unbind, { variant: "danger", size: "sm" });
  cancelButton.style.display = "none";
  reconnectButton.style.display = "none";
  unbindButton.style.display = "none";
  actions.append(generateButton, cancelButton, reconnectButton, unbindButton);
  sheet.body.append(stateLine, whoLine, tokenLine, messageLine, qrBox, linkRow, verifyRow, actions);
  let currentState = {
    bound: false,
    connected: false,
    status: "unbound",
    accountId: "",
    userId: "",
    lastMessageAt: "",
    lastMessageLocal: "",
    lastError: "",
    contextTokens: 0,
    qrDataUrl: "",
    qrUrl: "",
    loginStatus: "",
    loginError: "",
    verifyRequired: false
  };
  const paint = (next) => {
    currentState = next;
    const statusText = next.connected ? t.connected : next.loginStatus && next.loginStatus !== "unbound" && next.status === "binding" ? t.binding : next.bound ? t.connecting : next.lastError ? t.error : t.unbound;
    stateLine.textContent = statusText;
    stateLine.classList.toggle("bad", Boolean(next.lastError) && !next.connected);
    whoLine.textContent = next.bound ? `${t.account}\uFF1A${shortId(next.userId || next.accountId)}` : "";
    whoLine.style.display = next.bound ? "" : "none";
    tokenLine.textContent = next.bound ? t.tokenCount(next.contextTokens) : "";
    tokenLine.style.display = next.bound ? "" : "none";
    const stamp = next.lastMessageLocal || (next.lastMessageAt ? next.lastMessageAt.replace("T", " ").slice(0, 19) : "");
    messageLine.textContent = stamp ? t.lastMessage(stamp) : next.bound ? t.noMessage : "";
    messageLine.style.display = next.bound ? "" : "none";
    if (next.loginError) {
      stateLine.textContent = next.loginError;
      stateLine.classList.add("bad");
    } else if (next.lastError && !next.connected) {
      stateLine.textContent = `${t.error}\uFF1A${next.lastError}`;
      stateLine.classList.add("bad");
    }
    const showQr = Boolean(next.qrDataUrl) && !next.bound;
    qrBox.style.display = showQr ? "" : "none";
    if (showQr && qrImage.src !== next.qrDataUrl) qrImage.src = next.qrDataUrl;
    const showLink = Boolean(next.qrUrl) && !next.bound;
    linkRow.style.display = showLink ? "" : "none";
    verifyRow.style.display = next.verifyRequired ? "" : "none";
    const binding = next.status === "binding" || Boolean(next.qrDataUrl);
    generateButton.textContent = binding ? t.refresh : t.generate;
    generateButton.style.display = next.bound ? "none" : "";
    cancelButton.style.display = binding && !next.bound ? "" : "none";
    reconnectButton.style.display = next.bound ? "" : "none";
    unbindButton.style.display = next.bound ? "" : "none";
  };
  const readState = async () => {
    try {
      paint(await ctx.invoke("state"));
    } catch (err) {
      stateLine.textContent = `${t.error}\uFF1A${err instanceof Error ? err.message : String(err)}`;
      stateLine.classList.add("bad");
    }
  };
  generateButton.addEventListener("click", () => {
    void (async () => {
      generateButton.disabled = true;
      try {
        paint(await ctx.invoke("start"));
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), "bad");
      } finally {
        generateButton.disabled = false;
      }
    })();
  });
  cancelButton.addEventListener("click", () => {
    void (async () => {
      try {
        paint(await ctx.invoke("cancel"));
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), "bad");
      }
    })();
  });
  reconnectButton.addEventListener("click", () => {
    void (async () => {
      try {
        paint(await ctx.invoke("reconnect"));
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), "bad");
      }
    })();
  });
  unbindButton.addEventListener("click", () => {
    void (async () => {
      const ok = await ui.confirm({ title: t.unbind, body: t.unbindConfirm, danger: true });
      if (!ok) return;
      unbindButton.disabled = true;
      try {
        paint(await ctx.invoke("unbind"));
        ui.toast(t.unbindDone, "ok");
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), "bad");
      } finally {
        unbindButton.disabled = false;
      }
    })();
  });
  const submitVerify = () => {
    const code = verifyInput.value.trim();
    if (!code) return;
    void (async () => {
      try {
        paint(await ctx.invoke("verify", [code]));
        verifyInput.value = "";
      } catch (err) {
        ui.toast(err instanceof Error ? err.message : String(err), "bad");
      }
    })();
  };
  verifyButton.addEventListener("click", submitVerify);
  verifyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitVerify();
  });
  ctx.interval(() => {
    void readState();
  }, 1e3);
  await readState();
}
function shortId(value) {
  const id = String(value ?? "");
  if (!id) return "";
  const local = id.includes("@") ? id.slice(0, id.indexOf("@")) : id;
  return local.length > 12 ? `${local.slice(0, 10)}\u2026` : local;
}
var bundle = {
  panels: {
    binding: { mount: mountBinding },
    ffmpeg: { mount: mountFfmpeg }
  }
};
var client_default = bundle;
export {
  client_default as default
};
