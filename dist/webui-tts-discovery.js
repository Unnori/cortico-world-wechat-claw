// src/webui/ffmpeg.ts
var TEXT = {
  zh: {
    sheet: "FFmpeg",
    desc: "\u7528\u4E8E\u89C6\u9891\u62BD\u5E27\u548C\u56FE\u7247\u538B\u7F29\u3002\u4E0B\u8F7D\u5230\u672C\u6269\u5C55\u7684\u6570\u636E\u76EE\u5F55\u3002",
    download: "\u4E0B\u8F7D",
    downloadAgain: "\u91CD\u65B0\u4E0B\u8F7D",
    cancel: "\u53D6\u6D88\u4E0B\u8F7D",
    remove: "\u5220\u9664\u672C\u5730\u526F\u672C",
    ready: "\u53EF\u7528",
    fromPath: "\u6765\u81EA\u7CFB\u7EDF PATH",
    fromDownloaded: "\u4F7F\u7528\u672C\u5730\u526F\u672C",
    none: "\u6CA1\u6709\u53EF\u7528\u7684 ffmpeg",
    installed: (mb) => `\u5DF2\u4E0B\u8F7D\uFF1A${mb} MB`,
    version: (v) => `\u7248\u672C\uFF1A${v}`,
    noFrames: "\u89C6\u9891\u62BD\u5E27\u5DF2\u5173\u95ED\u3002",
    pathHint: "\u5F53\u524D\u914D\u7F6E\u4EC5\u4F7F\u7528\u7CFB\u7EDF PATH\u3002",
    offHint: "\u5F53\u524D\u914D\u7F6E\u5DF2\u505C\u7528 FFmpeg\u3002",
    confirmRemove: "\u5220\u9664\u5DF2\u4E0B\u8F7D\u7684 ffmpeg\uFF1F\u4E4B\u540E\u53EF\u4EE5\u518D\u70B9\u4E0B\u8F7D\u3002"
  },
  en: {
    sheet: "FFmpeg",
    desc: "Extracts video frames and compresses images. Installs in the extension data directory.",
    download: "Download",
    downloadAgain: "Download again",
    cancel: "Cancel download",
    remove: "Remove downloaded copy",
    ready: "ready",
    fromPath: "from system PATH",
    fromDownloaded: "using the local copy",
    none: "no usable ffmpeg",
    installed: (mb) => `Downloaded: ${mb} MB`,
    version: (v) => `Version: ${v}`,
    noFrames: "Video frame extraction is off.",
    pathHint: "Settings allow only the system PATH.",
    offHint: "FFmpeg is disabled in settings.",
    confirmRemove: "Remove the downloaded ffmpeg? You can download it again later."
  }
};
function text(language) {
  return language === "zh" || language === "zh-Hant" ? TEXT.zh : TEXT.en;
}
function formatMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}
async function mountFfmpeg(ctx, parent) {
  const t = text(ctx.language);
  const ui = ctx.ui;
  const section = ui.h("section", "wcc-service");
  parent.append(section);
  const statusLine = ui.msgline();
  statusLine.setAttribute("role", "status");
  const versionLine = ui.h("div", "wcc-detail");
  const sizeLine = ui.h("div", "wcc-detail");
  const hintLine = ui.h("div", "wcc-detail");
  const progressLine = ui.msgline();
  const progress = ui.h("progress", "wcc-progress");
  progress.max = 100;
  progress.setAttribute("aria-label", t.download);
  progress.style.display = "none";
  const actions = ui.actions();
  const downloadButton = ui.button(t.download, { variant: "primary" });
  const cancelButton = ui.button(t.cancel, { size: "sm" });
  const removeButton = ui.button(t.remove, { variant: "danger", size: "sm" });
  cancelButton.style.display = "none";
  removeButton.style.display = "none";
  actions.append(downloadButton, cancelButton, removeButton);
  section.append(ui.section(t.sheet, t.desc), statusLine, versionLine, sizeLine, hintLine, progress, progressLine, actions);
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
    statusLine.textContent = next.ready ? `${t.ready}\uFF1A${next.origin === "path" ? t.fromPath : t.fromDownloaded}` : next.detail || t.none;
    statusLine.classList.remove("bad");
    versionLine.textContent = next.version ? t.version(next.version.replace(/\s+Copyright.*$/i, "")) : "";
    versionLine.style.display = next.version ? "" : "none";
    sizeLine.textContent = next.installed ? t.installed(formatMb(next.installedBytes)) : "";
    sizeLine.style.display = next.installed ? "" : "none";
    const hint = next.source === "path" ? t.pathHint : next.source === "off" ? t.offHint : next.framesWanted > 0 ? "" : t.noFrames;
    hintLine.textContent = hint;
    hintLine.style.display = hint ? "" : "none";
    progressLine.classList.toggle("bad", next.progress?.phase === "failed");
    progress.style.display = next.installing ? "" : "none";
    if (next.progress?.percent != null) progress.value = next.progress.percent;
    else progress.removeAttribute("value");
    if (next.installing && next.progress) {
      const p = next.progress;
      const mb = p.total > 0 ? `${formatMb(p.received)} / ${formatMb(p.total)} MB` : `${formatMb(p.received)} MB`;
      progressLine.textContent = p.phase === "verifying" ? p.detail : `${p.detail} ${mb}${p.percent !== null ? `\uFF08${p.percent}%\uFF09` : ""}`;
      progressLine.style.display = "";
    } else if (next.progress && next.progress.phase === "failed") {
      progressLine.textContent = next.progress.detail;
      progressLine.style.display = "";
    } else {
      progressLine.style.display = "none";
    }
    downloadButton.style.display = next.installing ? "none" : "";
    downloadButton.textContent = next.installed ? t.downloadAgain : t.download;
    cancelButton.style.display = next.installing ? "" : "none";
    removeButton.style.display = next.installed && !next.installing ? "" : "none";
  };
  const readState = async () => {
    try {
      paint(await ctx.invoke("ffmpeg-state"));
    } catch (err) {
      statusLine.textContent = err instanceof Error ? err.message : String(err);
      statusLine.classList.add("bad");
    }
  };
  downloadButton.addEventListener("click", () => {
    void (async () => {
      downloadButton.disabled = true;
      try {
        await ctx.invoke("ffmpeg-install");
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
        await ctx.invoke("ffmpeg-cancel");
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
        await ctx.invoke("ffmpeg-remove");
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

// src/config.ts
var INBOUND_TRIGGER_OPTIONS = "wechat-claw-inbound-trigger";
var INBOUND_TRIGGERS = {
  debounce: { zh: "\u5408\u5E76\u540E\u6295\u9012\uFF08\u9ED8\u8BA4\uFF09", en: "Batch incoming messages (default)" },
  flush: { zh: "\u7ACB\u5373\u6295\u9012", en: "Deliver immediately" },
  preempt: { zh: "\u62A2\u5360\u5C1A\u672A\u8F93\u51FA\u7684\u56DE\u590D", en: "Preempt a reply before output" },
  interrupt: { zh: "\u6253\u65AD\u5F53\u524D\u8F6E", en: "Interrupt the current turn" },
  piggyback: { zh: "\u968F\u4E0B\u4E00\u6279\u6295\u9012", en: "Wait for the next batch" }
};
var TTS_SPEED_MIN = 0.25;
var TTS_SPEED_MAX = 4;
var MAX_SEGMENT_THRESHOLD = 8;
var CONFIG_FIELDS = {
  inboxDir: {
    type: "string",
    title: "\u6536\u4EF6\u76EE\u5F55",
    description: "\u7559\u7A7A\u65F6\u4F7F\u7528\u5DE5\u4F5C\u533A\u4E0B\u7684 wechat-inbox\u3002\u76F8\u5BF9\u8DEF\u5F84\u4EE5\u5DE5\u4F5C\u533A\u4E3A\u57FA\u51C6\u3002",
    "x-path": { kind: "directory" },
    "x-hot": false
  },
  sendExtraDirs: {
    type: "string",
    title: "\u989D\u5916\u5141\u8BB8\u53D1\u9001\u7684\u76EE\u5F55",
    description: "\u7559\u7A7A\u65F6\u4EC5\u5141\u8BB8\u5DE5\u4F5C\u533A\u548C\u6536\u4EF6\u76EE\u5F55\u3002\u4EC5\u6DFB\u52A0\u5B58\u653E\u53EF\u53D1\u9001\u6587\u4EF6\u7684\u76EE\u5F55\uFF0C\u4E00\u884C\u4E00\u4E2A\u3002\u76F8\u5BF9\u8DEF\u5F84\u4EE5\u90E8\u7F72\u76EE\u5F55\u4E3A\u57FA\u51C6\u3002",
    "x-hot": true
  },
  networkMode: {
    type: "string",
    title: "\u7F51\u7EDC\u51FA\u53E3",
    description: "inherit \u8DDF\u968F\u5BBF\u4E3B\uFF0Cdirect \u76F4\u8FDE\uFF0Cproxy \u4F7F\u7528\u4E0B\u65B9\u4EE3\u7406\u3002",
    enum: ["inherit", "direct", "proxy"],
    "x-hot": false
  },
  proxyUrl: {
    type: "string",
    title: "\u4EE3\u7406\u5730\u5740",
    description: "\u4EC5\u5728 proxy \u6A21\u5F0F\u751F\u6548\uFF0C\u652F\u6301 HTTP \u548C HTTPS \u4EE3\u7406\u3002",
    "x-hot": false
  },
  forceIpv4: {
    type: "boolean",
    title: "\u4F18\u5148 IPv4",
    description: "\u5728 direct \u6216 proxy \u6A21\u5F0F\u4E0B\u5F3A\u5236\u4F7F\u7528 IPv4\u3002IPv6 \u8DEF\u7531\u5F02\u5E38\u65F6\u53EF\u6253\u5F00\u3002",
    "x-hot": false
  },
  inboundTrigger: {
    type: "string",
    title: "\u5FAE\u4FE1\u6D88\u606F\u6295\u9012\u65B9\u5F0F",
    description: "\u7ACB\u5373\u6295\u9012\u7ED3\u675F\u5408\u6279\u7B49\u5F85\u3002\u62A2\u5360\u53EA\u53D6\u6D88\u5C1A\u672A\u8F93\u51FA\u4E14\u6CA1\u6709\u5DE5\u5177\u6B63\u5728\u6267\u884C\u7684\u8BF7\u6C42\u3002\u6253\u65AD\u7ACB\u5373\u505C\u6B62\u5F53\u524D\u8F6E\u3002\u968F\u4E0B\u4E00\u6279\u6295\u9012\u7B49\u5F85\u5176\u4ED6\u4E8B\u4EF6\u5524\u9192\u3002",
    enum: Object.keys(INBOUND_TRIGGERS),
    "x-options": INBOUND_TRIGGER_OPTIONS,
    "x-hot": true
  },
  receiveImages: {
    type: "boolean",
    title: "\u6536\u56FE\u7247",
    description: "\u4E0B\u8F7D\u56FE\u7247\u3002\u5F53\u524D\u6A21\u578B\u652F\u6301\u65F6\u9644\u5728\u6D88\u606F\u4E2D\u3002",
    "x-hot": true
  },
  receiveFiles: {
    type: "boolean",
    title: "\u6536\u6587\u4EF6",
    description: "\u4E0B\u8F7D\u6587\u4EF6\u5E76\u63D0\u4F9B\u672C\u5730\u8DEF\u5F84\u3002\u5F53\u524D\u6A21\u578B\u652F\u6301\u7684\u6587\u4EF6\u7C7B\u578B\u4F1A\u4F5C\u4E3A\u9644\u4EF6\u4E00\u5E76\u6295\u9012\u3002",
    "x-hot": true
  },
  receiveVideos: {
    type: "boolean",
    title: "\u6536\u89C6\u9891",
    description: "\u4E0B\u8F7D\u5FAE\u4FE1\u89C6\u9891\u3002\u5F53\u524D\u6A21\u578B\u652F\u6301\u65F6\u9644\u4E0A\u539F\u89C6\u9891\uFF0C\u5426\u5219\u5C1D\u8BD5\u62BD\u5E27\u3002",
    "x-hot": true
  },
  receiveVoices: {
    type: "boolean",
    title: "\u6536\u8BED\u97F3",
    description: "\u4E0B\u8F7D\u8BED\u97F3\u5E76\u5C06 SILK \u8F6C\u6210 WAV\u3002\u5F53\u524D\u6A21\u578B\u652F\u6301\u65F6\u9644\u4E0A\u97F3\u9891\uFF0C\u8F6C\u7801\u5931\u8D25\u65F6\u4FDD\u7559\u539F\u4EF6\u3002",
    "x-hot": true
  },
  maxInboundMediaMb: {
    type: "number",
    title: "\u5355\u6761\u5A92\u4F53\u4E0A\u9650\uFF08MB\uFF09",
    description: "\u9650\u5236\u63A5\u6536\u548C\u53D1\u9001\u7684\u5355\u4E2A\u5A92\u4F53\u6587\u4EF6\u3002\u751F\u6210\u7684 WAV \u8D85\u9650\u65F6\u4FDD\u7559\u539F\u59CB SILK\u3002",
    "x-hot": true
  },
  ffmpegSource: {
    type: "string",
    title: "FFmpeg \u6765\u6E90",
    description: "auto \u4F18\u5148\u7528\u7CFB\u7EDF PATH\uFF0C\u5176\u6B21\u7528\u672C\u5730\u526F\u672C\u3002path \u4EC5\u7528\u7CFB\u7EDF PATH\uFF0Coff \u505C\u7528\u3002\u53EF\u5728\u300C\u8FDE\u63A5\u4E0E\u5DE5\u5177\u300D\u4E0B\u8F7D\u3002",
    enum: ["auto", "path", "off"],
    "x-hot": false
  },
  videoFrames: {
    type: "number",
    title: "\u6BCF\u6761\u89C6\u9891\u7684\u62BD\u5E27\u6570",
    description: "\u62BD\u51FA\u7684\u5E27\u62FC\u6210\u4E00\u5F20\u56FE\u30020 \u5173\u95ED\uFF0C\u6700\u591A 9 \u5E27\u3002",
    "x-hot": true
  },
  ffmpegProxyUrl: {
    type: "string",
    title: "FFmpeg \u4E0B\u8F7D\u4EE3\u7406",
    description: "\u4EC5\u7528\u4E8E\u4E0B\u8F7D FFmpeg\u3002\u7559\u7A7A\u4F7F\u7528\u76F4\u8FDE\u3002",
    "x-hot": false
  },
  imageMaxMb: {
    type: "number",
    title: "\u5355\u56FE\u4F53\u79EF\u4E0A\u9650\uFF08MB\uFF09",
    description: "\u8D85\u51FA\u540E\u5C1D\u8BD5\u538B\u7F29\u3002\u4ECD\u8D85\u9650\u65F6\u5728\u6B63\u6587\u8BF4\u660E\u3002",
    "x-hot": true
  },
  imageMaxEdge: {
    type: "number",
    title: "\u5355\u56FE\u6700\u957F\u8FB9\u4E0A\u9650\uFF08\u50CF\u7D20\uFF09",
    description: "\u8D85\u51FA\u540E\u5C1D\u8BD5\u7F29\u5C0F\u3002\u4ECD\u8D85\u9650\u65F6\u5728\u6B63\u6587\u8BF4\u660E\u3002",
    "x-hot": true
  },
  imageMaxCount: {
    type: "number",
    title: "\u5355\u6B21\u6700\u591A\u9644\u51E0\u5F20\u56FE",
    description: "\u6BCF\u6B21\u6295\u9012\u7684\u56FE\u7247\u4E0A\u9650\uFF0C\u5305\u542B\u89C6\u9891\u62FC\u56FE\u3002",
    "x-hot": true
  },
  segmentEnabled: {
    type: "boolean",
    title: "\u5206\u6BB5\u53D1\u9001",
    description: "\u4F18\u5148\u6309\u6362\u884C\u62C6\u5206\uFF0C\u5176\u6B21\u6309\u53E5\u53F7\u548C\u8BED\u6C14\u6807\u70B9\u62C6\u5206\u3002",
    "x-hot": false
  },
  segmentPace: {
    type: "number",
    title: "\u804A\u5929\u8282\u594F",
    description: "\u6309\u6D88\u606F\u957F\u5EA6\u5B89\u6392\u505C\u987F\u30021 \u4E3A\u9ED8\u8BA4\uFF0C\u8D8A\u5927\u8D8A\u6162\uFF0C0 \u4E0D\u7B49\u5F85\u3002",
    minimum: 0,
    maximum: 10,
    multipleOf: 0.1,
    "x-hot": true
  },
  segmentMaxParts: {
    type: "number",
    title: "\u5206\u6BB5\u9608\u503C",
    description: `\u8BED\u4E49\u6BB5\u6570\u8FBE\u5230\u6B64\u503C\u65F6\u6062\u590D\u5B8C\u6574\u539F\u6587\uFF0C\u4ECD\u6309\u5FAE\u4FE1\u5355\u6761 4000 \u5B57\u4E0A\u9650\u53D1\u9001\u3002\u6700\u5927 ${MAX_SEGMENT_THRESHOLD}\uFF0C0 \u4F7F\u7528\u9ED8\u8BA4\u503C\u3002`,
    minimum: 0,
    maximum: MAX_SEGMENT_THRESHOLD,
    "x-hot": true
  },
  segmentMaxTotalSec: {
    type: "number",
    title: "\u603B\u7B49\u5F85\u4E0A\u9650\uFF08\u79D2\uFF09",
    description: "\u8FBE\u5230\u603B\u505C\u987F\u4E0A\u9650\u540E\u8FDE\u7EED\u53D1\u5B8C\u30020 \u8868\u793A\u4E0D\u9650\u3002",
    "x-hot": true
  },
  nativeVoiceEnabled: {
    type: "boolean",
    title: "\u8BD5\u7528\u5FAE\u4FE1\u539F\u751F\u8BED\u97F3\u6761",
    description: "\u9ED8\u8BA4\u53D1 MP3 \u6587\u4EF6\u5361\u7247\u3002\u5F00\u542F\u540E\u5C1D\u8BD5\u53D1\u539F\u751F\u8BED\u97F3\u6761\uFF0C\u663E\u793A\u6548\u679C\u4EE5\u624B\u673A\u7AEF\u4E3A\u51C6\u3002",
    "x-hot": true
  }
};

// src/webui/tts.ts
function strings(language) {
  return language.startsWith("zh") ? {
    title: "TTS \u8BBE\u7F6E",
    description: "\u5C06\u684C\u5BA0\u7684\u6587\u5B57\u5408\u6210\u4E3A\u8BED\u97F3\u5E76\u53D1\u5230\u5FAE\u4FE1\u3002",
    enabled: "\u542F\u7528 TTS",
    on: "\u5DF2\u542F\u7528",
    off: "\u672A\u542F\u7528",
    loading: "\u6B63\u5728\u8BFB\u53D6\u8BBE\u7F6E\u2026",
    loadFailed: "\u65E0\u6CD5\u8BFB\u53D6 TTS \u8BBE\u7F6E",
    serviceUrl: "\u670D\u52A1\u5730\u5740",
    protocol: "\u670D\u52A1\u7C7B\u578B",
    openai: "OpenAI \u517C\u5BB9",
    discover: "\u53D1\u73B0\u672C\u673A\u4E0E\u5C40\u57DF\u7F51\u670D\u52A1",
    discovering: "\u6B63\u5728\u67E5\u627E GPT-SoVITS\u2026",
    discoverEmpty: "\u672A\u627E\u5230\u53EF\u76F4\u8FDE\u7684 GPT-SoVITS\u3002\u8BF7\u786E\u8BA4\u8BED\u97F3\u63A5\u53E3\u5DF2\u5F00\u542F\uFF0C\u4E5F\u53EF\u624B\u52A8\u586B\u5199\u5730\u5740\u3002",
    discoverFailed: "\u6682\u65F6\u65E0\u6CD5\u67E5\u627E\u8BED\u97F3\u670D\u52A1\u3002",
    selectService: "\u9009\u62E9\u53D1\u73B0\u7684 GPT-SoVITS \u670D\u52A1",
    serviceSelected: "\u5DF2\u586B\u5165\u670D\u52A1\u914D\u7F6E\uFF0C\u4FDD\u5B58\u540E\u751F\u6548\u3002",
    currentVoice: "\u7559\u7A7A\u4F7F\u7528\u670D\u52A1\u5F53\u524D\u97F3\u8272",
    model: "\u6A21\u578B",
    voice: "\u58F0\u97F3",
    speed: "\u8BED\u901F",
    fetchModels: "\u83B7\u53D6\u6A21\u578B",
    fetchVoices: "\u83B7\u53D6\u97F3\u8272",
    chooseModel: "\u9009\u62E9\u6A21\u578B",
    chooseVoice: "\u9009\u62E9\u97F3\u8272",
    listLoading: "\u6B63\u5728\u83B7\u53D6\u2026",
    listEmpty: "\u6CA1\u6709\u53EF\u7528\u9009\u9879\uFF0C\u53EF\u624B\u52A8\u586B\u5199\u3002",
    preset: "\u9884\u7F6E",
    custom: "\u81EA\u5B9A\u4E49",
    save: "\u4FDD\u5B58\u8BBE\u7F6E",
    saved: "\u8BBE\u7F6E\u5DF2\u751F\u6548",
    keySaved: "\u5DF2\u4FDD\u5B58\u5BC6\u94A5",
    keyMissing: "\u672A\u8BBE\u7F6E\u5BC6\u94A5",
    keyHint: "\u670D\u52A1\u9700\u8981\u9274\u6743\u65F6\u586B\u5199\u3002\u8F93\u5165\u65B0\u5BC6\u94A5\u53EF\u66FF\u6362\u73B0\u6709\u5BC6\u94A5\u3002",
    saveKey: "\u4FDD\u5B58\u5BC6\u94A5",
    keyFailed: "\u5BC6\u94A5\u4FDD\u5B58\u5931\u8D25"
  } : {
    title: "TTS settings",
    description: "Turn the pet\u2019s text into speech and send it to WeChat.",
    enabled: "Enable TTS",
    on: "Enabled",
    off: "Disabled",
    loading: "Reading settings\u2026",
    loadFailed: "Could not read TTS settings",
    serviceUrl: "Service URL",
    protocol: "Service type",
    openai: "OpenAI compatible",
    discover: "Find local and LAN services",
    discovering: "Looking for GPT-SoVITS\u2026",
    discoverEmpty: "No reachable GPT-SoVITS service found. Check that its voice API is enabled, or enter its URL manually.",
    discoverFailed: "Could not look for voice services.",
    selectService: "Select a discovered GPT-SoVITS service",
    serviceSelected: "Service details filled in. Save settings to apply them.",
    currentVoice: "Leave blank to use the service\u2019s current voice",
    model: "Model",
    voice: "Voice",
    speed: "Speed",
    fetchModels: "Fetch models",
    fetchVoices: "Fetch voices",
    chooseModel: "Select a model",
    chooseVoice: "Select a voice",
    listLoading: "Loading options\u2026",
    listEmpty: "No options found. You can enter a value manually.",
    preset: "Preset",
    custom: "Custom",
    save: "Save settings",
    saved: "Settings applied",
    keySaved: "Key saved",
    keyMissing: "No key configured",
    keyHint: "Enter a key if your service requires one. A new key replaces the saved key.",
    saveKey: "Save key",
    keyFailed: "Could not save the key"
  };
}
function catalogField(ctx, t, field) {
  const { ui, signal } = ctx;
  const { label, input } = field;
  const box = ui.h("div", "wcc-tts-lookup");
  const button = ui.button(field.button, { size: "sm" });
  const select = ui.select();
  select.hidden = true;
  select.setAttribute("aria-label", field.placeholder);
  const status = ui.msgline();
  status.setAttribute("role", "status");
  box.append(ui.field(label, input), button, select, status);
  let revision = 0;
  const clear = () => {
    revision++;
    select.hidden = true;
    select.replaceChildren();
    status.classList.remove("bad");
    status.textContent = "";
  };
  select.addEventListener("change", () => {
    if (!select.value) return;
    input.value = select.value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, { signal });
  input.addEventListener("input", () => {
    const matches = Array.from(select.options).some((option) => option.value === input.value);
    select.value = matches ? input.value : "";
  }, { signal });
  button.addEventListener("click", () => {
    clear();
    const request = revision;
    button.disabled = true;
    status.textContent = t.listLoading;
    void field.load().then((result) => {
      if (request !== revision || signal.aborted) return;
      const placeholder = ui.h("option", "", field.placeholder);
      placeholder.value = "";
      select.append(placeholder);
      for (const choice of result.choices) {
        const text3 = choice.source ? choice.label + " \xB7 " + t[choice.source] : choice.label;
        const option = ui.h("option", "", text3);
        option.value = choice.value;
        select.append(option);
      }
      select.hidden = result.choices.length === 0;
      select.value = input.value;
      if (select.selectedIndex < 0) select.value = "";
      status.textContent = result.note ?? (select.hidden ? t.listEmpty : "");
    }, (error) => {
      if (request !== revision || signal.aborted) return;
      status.classList.add("bad");
      status.textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      button.disabled = false;
    });
  }, { signal });
  return { box, clear };
}
function ttsForm(ctx, t, state, onChange) {
  const { ui, signal } = ctx;
  const body = ui.h("div", "wcc-tts-drawer");
  const settings = ui.h("form", "wcc-tts-form");
  const enabled = ui.checkbox(t.enabled, { checked: state.ttsEnabled });
  const protocol = ui.select();
  for (const [value, label] of [["openai", t.openai], ["gpt-sovits", "GPT-SoVITS"]]) {
    const option = ui.h("option", "", label);
    option.value = value;
    protocol.append(option);
  }
  protocol.value = state.ttsProtocol;
  const selectedProtocol = () => protocol.value;
  const url = ui.input({ value: state.ttsBaseUrl });
  url.type = "url";
  const model = ui.input({ value: state.ttsModel });
  const voice = ui.input({ value: state.ttsVoice });
  const speed = ui.input({ type: "number", value: String(state.ttsSpeed) });
  speed.min = String(TTS_SPEED_MIN);
  speed.max = String(TTS_SPEED_MAX);
  speed.step = "any";
  speed.required = true;
  const modelField = catalogField(ctx, t, {
    label: t.model,
    button: t.fetchModels,
    placeholder: t.chooseModel,
    input: model,
    load: () => ctx.invoke("tts-list-models", [url.value, selectedProtocol()])
  });
  const voiceField = catalogField(ctx, t, {
    label: t.voice,
    button: t.fetchVoices,
    placeholder: t.chooseVoice,
    input: voice,
    load: () => ctx.invoke("tts-list-voices", [url.value, model.value, selectedProtocol()])
  });
  let voiceModel = model.value.trim();
  model.addEventListener("input", () => {
    const next = model.value.trim();
    if (next === voiceModel) return;
    voiceModel = next;
    voice.value = "";
    voiceField.clear();
  }, { signal });
  const serviceFields = ui.h("div", "wcc-tts-service");
  const discover = ui.button(t.discover, { size: "sm" });
  const services = ui.select();
  services.hidden = true;
  services.setAttribute("aria-label", t.selectService);
  const discoveryStatus = ui.msgline();
  discoveryStatus.setAttribute("role", "status");
  const discoveryActions = ui.rowbar();
  discoveryActions.classList.add("wcc-tts-discovery-actions");
  discoveryActions.append(discover, services);
  serviceFields.append(ui.field(t.protocol, protocol), ui.field(t.serviceUrl, url), discoveryActions, discoveryStatus);
  const fields = ui.h("div", "wcc-tts-fields");
  fields.append(modelField.box, voiceField.box, ui.field(t.speed, speed));
  const save = ui.button(t.save, { variant: "primary" });
  save.type = "submit";
  const settingsStatus = ui.msgline();
  settingsStatus.setAttribute("role", "status");
  const actions = ui.rowbar();
  actions.append(save, settingsStatus);
  settings.append(enabled.el, serviceFields, fields, actions);
  const credentials = ui.h("form", "wcc-tts-key");
  const key = ui.input({ type: "password" });
  key.autocomplete = "new-password";
  const saveKey = ui.button(t.saveKey);
  saveKey.type = "submit";
  saveKey.disabled = true;
  const keyStatus = ui.msgline(state.keyConfigured ? t.keySaved : t.keyMissing);
  keyStatus.setAttribute("role", "status");
  const keyRow = ui.rowbar();
  keyRow.append(ui.field("API Key", key), saveKey);
  credentials.append(keyRow, ui.h("div", "sectiondesc", t.keyHint), keyStatus);
  body.append(settings, credentials);
  let keyRevision = 0;
  let serviceRevision = 0;
  const updateKeyState = async () => {
    const revision = ++keyRevision;
    keyStatus.classList.remove("bad");
    keyStatus.textContent = "";
    try {
      const { keyConfigured } = await ctx.invoke("tts-key-state", [selectedProtocol(), url.value]);
      if (!signal.aborted && revision === keyRevision) keyStatus.textContent = keyConfigured ? t.keySaved : t.keyMissing;
    } catch {
    }
  };
  const updateServiceFields = () => {
    const local = selectedProtocol() === "gpt-sovits";
    url.placeholder = local ? "http://127.0.0.1:9880" : "https://example.com/v1";
    voice.placeholder = local ? t.currentVoice : "";
  };
  const serviceChanged = () => {
    modelField.clear();
    voiceField.clear();
    keyRevision++;
    key.value = "";
    saveKey.disabled = true;
    keyStatus.textContent = "";
    keyStatus.classList.remove("bad");
    settingsStatus.textContent = "";
    updateServiceFields();
  };
  const clearDiscovery = () => {
    serviceRevision++;
    services.hidden = true;
    services.replaceChildren();
    discoveryStatus.textContent = "";
  };
  const applyService = (service) => {
    const sameService = selectedProtocol() === "gpt-sovits" && url.value.trim() === service.baseUrl;
    protocol.value = "gpt-sovits";
    url.value = service.baseUrl;
    model.value = voiceModel = service.model;
    if (!sameService) voice.value = "";
    serviceChanged();
    void updateKeyState();
    discoveryStatus.textContent = t.serviceSelected;
  };
  updateServiceFields();
  protocol.addEventListener("change", () => {
    model.value = voiceModel = voice.value = "";
    clearDiscovery();
    serviceChanged();
    void updateKeyState();
  }, { signal });
  url.addEventListener("input", () => {
    clearDiscovery();
    serviceChanged();
  }, { signal });
  url.addEventListener("change", () => {
    void updateKeyState();
  }, { signal });
  let discovered = [];
  services.addEventListener("change", () => {
    const choice = discovered.find((service) => service.baseUrl === services.value);
    if (choice && !save.disabled) applyService(choice);
  }, { signal });
  discover.addEventListener("click", () => {
    if (save.disabled) return;
    clearDiscovery();
    const revision = serviceRevision;
    discover.disabled = true;
    discoveryStatus.textContent = t.discovering;
    void ctx.invoke("tts-discover", [url.value]).then((results) => {
      if (signal.aborted || revision !== serviceRevision) return;
      discovered = results;
      if (!results.length) {
        discoveryStatus.textContent = t.discoverEmpty;
        return;
      }
      if (results.length === 1) {
        applyService(results[0]);
        return;
      }
      const placeholder = ui.h("option", "", t.selectService);
      placeholder.value = "";
      services.append(placeholder);
      for (const service of results) {
        const option = ui.h("option", "", service.baseUrl);
        option.value = service.baseUrl;
        services.append(option);
      }
      services.hidden = false;
      discoveryStatus.textContent = "";
    }, () => {
      if (!signal.aborted && revision === serviceRevision) discoveryStatus.textContent = t.discoverFailed;
    }).finally(() => {
      discover.disabled = false;
    });
  }, { signal });
  settings.addEventListener("submit", (event) => {
    event.preventDefault();
    if (save.disabled) return;
    if (discover.disabled) clearDiscovery();
    const patch = {
      ttsEnabled: enabled.checked,
      ttsProtocol: selectedProtocol(),
      ttsBaseUrl: url.value,
      ttsModel: model.value,
      ttsVoice: voice.value,
      ttsSpeed: speed.valueAsNumber
    };
    const pending = ui.disable(save, enabled.input, protocol, url, model, voice, speed, services);
    settingsStatus.textContent = "";
    void ctx.invoke("tts-save-settings", [patch]).then((next) => {
      onChange(next);
      discoveryStatus.textContent = "";
      settingsStatus.classList.remove("bad");
      settingsStatus.textContent = t.saved;
    }, (error) => {
      settingsStatus.classList.add("bad");
      settingsStatus.textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => pending.dispose());
  }, { signal });
  key.addEventListener("input", () => {
    saveKey.disabled = !key.value.trim();
  }, { signal });
  credentials.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = key.value.trim();
    if (!value || saveKey.disabled) return;
    const pending = ui.disable(saveKey, key);
    const revision = ++keyRevision;
    void ctx.invoke("tts-save-key", [value, selectedProtocol(), url.value]).then(() => {
      if (signal.aborted || revision !== keyRevision) return;
      key.value = "";
      keyStatus.classList.remove("bad");
      keyStatus.textContent = t.keySaved;
    }, () => {
      if (signal.aborted || revision !== keyRevision) return;
      keyStatus.classList.add("bad");
      keyStatus.textContent = t.keyFailed;
    }).finally(() => {
      pending.dispose();
      saveKey.disabled = !key.value.trim();
    });
  }, { signal });
  return body;
}
async function mountTts(ctx, parent) {
  const { ui, signal } = ctx;
  const t = strings(ctx.language);
  const section = ui.h("section", "wcc-service");
  const status = ui.msgline(t.loading);
  status.setAttribute("role", "status");
  const actions = ui.actions();
  const configure = ui.button(t.title, { variant: "primary" });
  actions.append(configure);
  section.append(ui.section("TTS", t.description), status, actions);
  parent.append(section);
  const paint = (state) => {
    status.classList.remove("bad");
    status.classList.toggle("wcc-tts-off", !state.ttsEnabled);
    status.textContent = state.ttsEnabled && state.ttsModel ? `${t.on}\uFF1A${state.ttsModel}` : state.ttsEnabled ? t.on : t.off;
  };
  const load = async () => {
    try {
      const next = await ctx.invoke("tts-state");
      paint(next);
      return next;
    } catch {
      status.classList.add("bad");
      status.textContent = t.loadFailed;
      return null;
    }
  };
  configure.addEventListener("click", () => {
    configure.disabled = true;
    void load().then((state) => {
      if (state && !signal.aborted) ui.drawer(t.title, ttsForm(ctx, t, state, paint));
    }).finally(() => {
      configure.disabled = false;
    });
  }, { signal });
  await load();
}

// src/webui/client.ts
var TEXT2 = {
  zh: {
    sheet: "\u5FAE\u4FE1\u7ED1\u5B9A",
    desc: "\u7528\u624B\u673A\u5FAE\u4FE1\u626B\u7801\u63A5\u5165\u4E00\u5BF9\u4E00\u79C1\u804A\u3002",
    loading: "\u6B63\u5728\u8BFB\u53D6\u5FAE\u4FE1\u72B6\u6001\u2026",
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
    account: "\u8D26\u53F7",
    unbound: "\u672A\u7ED1\u5B9A",
    binding: "\u7B49\u5F85\u626B\u7801\u2026",
    connected: "\u5DF2\u8FDE\u63A5",
    connecting: "\u8FDE\u63A5\u4E2D\u2026",
    error: "\u8FDE\u63A5\u5F02\u5E38",
    lastMessage: (at) => `\u6700\u8FD1\u4E00\u6761\u5FAE\u4FE1\u6D88\u606F\uFF1A${at}`,
    noMessage: "\u8FD8\u6CA1\u6536\u5230\u8FC7\u5FAE\u4FE1\u6D88\u606F\u3002",
    copy: "\u590D\u5236",
    copied: "\u94FE\u63A5\u5DF2\u590D\u5236\u3002"
  },
  en: {
    sheet: "WeChat binding",
    desc: "Scan with WeChat to connect a private chat.",
    loading: "Reading WeChat status\u2026",
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
    account: "Account",
    unbound: "Unbound",
    binding: "Waiting for the scan\u2026",
    connected: "Connected",
    connecting: "Connecting\u2026",
    error: "Connection error",
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
  const sheet = ui.sheet({ title: t.sheet });
  sheet.el.classList.add("wechat-claw-console");
  ctx.root.append(sheet.el);
  const bindingRow = ui.h("div", "wcc-binding-row");
  const facts = ui.h("div", "wcc-binding-facts");
  const identity = ui.h("div", "wcc-identity");
  const stateLine = ui.pill(t.loading);
  stateLine.setAttribute("role", "status");
  const whoLine = ui.h("span", "wcc-account");
  const messageLine = ui.h("div", "wcc-detail", t.desc);
  const errorLine = ui.msgline("", true);
  errorLine.setAttribute("role", "status");
  errorLine.style.display = "none";
  identity.append(stateLine, whoLine);
  facts.append(identity, messageLine);
  const qrBox = ui.h("div", "qrbox");
  const qrImage = ui.h("img", "qr");
  qrImage.alt = t.sheet;
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
  bindingRow.append(facts, actions);
  const services = ui.h("div", "wcc-services");
  sheet.body.append(bindingRow, errorLine, qrBox, linkRow, verifyRow, services);
  let currentState = {
    bound: false,
    connected: false,
    status: "unbound",
    accountId: "",
    userId: "",
    lastMessageAt: "",
    lastMessageLocal: "",
    lastError: "",
    qrDataUrl: "",
    qrUrl: "",
    loginError: "",
    verifyRequired: false
  };
  const paint = (next) => {
    currentState = next;
    const problem = next.loginError || (!next.connected ? next.lastError : "");
    const statusText = next.connected ? t.connected : problem ? t.error : next.status === "binding" ? t.binding : next.bound ? t.connecting : t.unbound;
    if (stateLine.textContent !== statusText) stateLine.textContent = statusText;
    stateLine.classList.toggle("on", next.connected);
    stateLine.classList.toggle("off", !next.connected && !next.loginError && !next.lastError);
    whoLine.textContent = next.bound ? `${t.account}\uFF1A${shortId(next.userId || next.accountId)}` : "";
    whoLine.style.display = next.bound ? "" : "none";
    const stamp = next.lastMessageLocal || (next.lastMessageAt ? next.lastMessageAt.replace("T", " ").slice(0, 19) : "");
    messageLine.textContent = next.bound ? stamp ? t.lastMessage(stamp) : t.noMessage : t.desc;
    if (errorLine.textContent !== problem) errorLine.textContent = problem;
    errorLine.style.display = problem ? "" : "none";
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
      stateLine.textContent = t.error;
      stateLine.classList.remove("on", "off");
      errorLine.textContent = err instanceof Error ? err.message : String(err);
      errorLine.style.display = "";
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
  await Promise.all([readState(), mountFfmpeg(ctx, services), mountTts(ctx, services)]);
}
function shortId(value) {
  const id = String(value ?? "");
  if (!id) return "";
  const local = id.includes("@") ? id.slice(0, id.indexOf("@")) : id;
  return local.length > 12 ? `${local.slice(0, 10)}\u2026` : local;
}
var bundle = {
  panels: {
    binding: { mount: mountBinding }
  }
};
var client_default = bundle;
export {
  client_default as default
};
