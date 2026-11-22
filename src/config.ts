import type { ConfigGroup, TriggerMode } from 'cortico/core/types.ts';

export const DEFAULT_INBOUND_TRIGGER = 'debounce';
export const INBOUND_TRIGGER_OPTIONS = 'wechat-claw-inbound-trigger';

const INBOUND_TRIGGERS = {
  debounce: { zh: '合并后投递（默认）', en: 'Batch incoming messages (default)' },
  flush: { zh: '立即投递', en: 'Deliver immediately' },
  preempt: { zh: '抢占尚未输出的回复', en: 'Preempt a reply before output' },
  interrupt: { zh: '打断当前轮', en: 'Interrupt the current turn' },
  piggyback: { zh: '随下一批投递', en: 'Wait for the next batch' },
} satisfies Record<TriggerMode, { zh: string; en: string }>;

export function inboundTriggerOptions(language: string) {
  return Object.entries(INBOUND_TRIGGERS).map(([value, labels]) => ({
    value,
    label: language.startsWith('zh') ? labels.zh : labels.en,
  }));
}

export function resolveInboundTrigger(value: unknown): TriggerMode {
  return typeof value === 'string' && Object.hasOwn(INBOUND_TRIGGERS, value)
    ? value as TriggerMode
    : DEFAULT_INBOUND_TRIGGER;
}

/**
 * `config.json` 的 `worlds.wechat-claw` 段。
 *
 * 这里不放任何凭据：`bot_token`、同步游标、`context_token` 都在部署数据目录的
 * `wechat-claw/` 下，由 `store.ts` 管理。
 */
export interface WechatClawConfigSection extends TtsSettings {
  enabled: boolean;
  /** inherit = 跟随 Coopanion 的代理；direct = 直连；proxy = 用 proxyUrl。 */
  networkMode: 'inherit' | 'direct' | 'proxy';
  proxyUrl: string;
  /** direct/proxy 下强制 IPv4；系统 IPv6 路由坏掉时打开。 */
  forceIpv4: boolean;
  /** 微信私聊消息在 Core 中的投递方式，提交事件时读取。 */
  inboundTrigger: TriggerMode;
  /** 收图时是否下载并交给模型看。 */
  receiveImages: boolean;
  /** 收文件时是否下载。 */
  receiveFiles: boolean;
  /** 收视频时是否下载。 */
  receiveVideos: boolean;
  /** 收语音时是否下载并将 SILK 转成 WAV。 */
  receiveVoices: boolean;
  /** 单条入站媒体上限，MB。超过只留占位，不下载。 */
  maxInboundMediaMb: number;
  /**
   * 收来的文件落在哪。留空 = 桌宠工作区下的 `wechat-inbox`。
   *
   * 相对路径按工作区解析；写绝对路径也能用，但桌宠就读不到了——所以默认值刻意选在工作区里。
   * 改完要重启（启动时解析一次）。
   */
  inboxDir: string;
  /**
   * 额外允许发到微信的目录，一行一个（也可用分号或逗号分隔）。
   *
   * 留空时**只有工作区和收件目录**里的文件能发出去。填了才会多放行这些目录；
   * 相对路径按部署目录解析。这是放开安全边界，不是日常必填项。
   */
  sendExtraDirs: string;
  /**
   * ffmpeg 从哪来。视频抽帧需要它，但不把它打进包里：
   * `auto` 先找 PATH 再用面板装的那份；`path` 只用 PATH；`off` 不抽帧。
   * 下载不由这个值触发，只能由面板按钮显式开始。
   */
  ffmpegSource: 'auto' | 'path' | 'off';
  /** 每条视频抽几帧（1..9），抽完拼成一张图。0 表示不抽。 */
  videoFrames: number;
  /** 单图体积上限，MB。超了先压缩，压不下去就不附。 */
  imageMaxMb: number;
  /** 单图最长边上限，像素。 */
  imageMaxEdge: number;
  /** 一次事件投递最多附几张图。 */
  imageMaxCount: number;
  /** 下载 ffmpeg 用的代理；留空表示直连（不继承只给模型用的那条代理）。 */
  ffmpegProxyUrl: string;
  /**
   * 按语义分段发送。打开后一次回复会拆成多条微信消息，像人一句一句说。
   *
   * 有换行就只按换行拆；没有换行才按句号；再没有才按 `！？…～`。
   * 中文句号删掉（社交软件里带句号显得生硬），情绪标点保留。
   */
  segmentEnabled: boolean;
  /** 按字数计算等待时长的倍率；0 表示不等待。 */
  segmentPace: number;
  /** 语义段数达到此值就取消语义分段，0 或旧值高于上限时使用 8。 */
  segmentMaxParts: number;
  /** 一次发送累计等待上限，秒；到点就把剩下的一起发完。 */
  segmentMaxTotalSec: number;
  nativeVoiceEnabled: boolean;
}

export type TtsProtocol = 'openai' | 'gpt-sovits';

export interface TtsSettings {
  ttsEnabled: boolean;
  ttsProtocol: TtsProtocol;
  ttsBaseUrl: string;
  ttsModel: string;
  ttsVoice: string;
  ttsSpeed: number;
}

export interface TtsPanelState extends TtsSettings {
  keyConfigured: boolean;
}

export const TTS_SPEED_MIN = 0.25;
export const TTS_SPEED_MAX = 4;

export const MAX_SEGMENT_THRESHOLD = 8;

export const WECHAT_CLAW_DEFAULTS: WechatClawConfigSection = {
  enabled: false,
  networkMode: 'inherit',
  proxyUrl: '',
  forceIpv4: false,
  inboundTrigger: DEFAULT_INBOUND_TRIGGER,
  receiveImages: true,
  receiveFiles: true,
  receiveVideos: false,
  receiveVoices: true,
  maxInboundMediaMb: 20,
  inboxDir: '',
  sendExtraDirs: '',
  ffmpegSource: 'auto',
  videoFrames: 4,
  imageMaxMb: 16,
  imageMaxEdge: 4096,
  imageMaxCount: 10,
  ffmpegProxyUrl: '',
  segmentEnabled: true,
  segmentPace: 1,
  segmentMaxParts: MAX_SEGMENT_THRESHOLD,
  segmentMaxTotalSec: 30,
  nativeVoiceEnabled: false,
  ttsEnabled: false,
  ttsProtocol: 'openai',
  ttsBaseUrl: '',
  ttsModel: '',
  ttsVoice: '',
  ttsSpeed: 1,
};

const CONFIG_FIELDS = {
  inboxDir: {
    type: 'string',
    title: '收件目录',
    description: '留空时使用工作区下的 wechat-inbox。相对路径以工作区为基准。',
    'x-path': { kind: 'directory' },
    'x-hot': false,
  },
  sendExtraDirs: {
    type: 'string',
    title: '额外允许发送的目录',
    description: '留空时仅允许工作区和收件目录。仅添加存放可发送文件的目录，一行一个。相对路径以部署目录为基准。',
    'x-hot': true,
  },
  networkMode: {
    type: 'string',
    title: '网络出口',
    description: 'inherit 跟随宿主，direct 直连，proxy 使用下方代理。',
    enum: ['inherit', 'direct', 'proxy'],
    'x-hot': false,
  },
  proxyUrl: {
    type: 'string',
    title: '代理地址',
    description: '仅在 proxy 模式生效，支持 HTTP 和 HTTPS 代理。',
    'x-hot': false,
  },
  forceIpv4: {
    type: 'boolean',
    title: '优先 IPv4',
    description: '在 direct 或 proxy 模式下强制使用 IPv4。IPv6 路由异常时可打开。',
    'x-hot': false,
  },
  inboundTrigger: {
    type: 'string',
    title: '微信消息投递方式',
    description: '立即投递结束合批等待。抢占只取消尚未输出且没有工具正在执行的请求。打断立即停止当前轮。随下一批投递等待其他事件唤醒。',
    enum: Object.keys(INBOUND_TRIGGERS),
    'x-options': INBOUND_TRIGGER_OPTIONS,
    'x-hot': true,
  },
  receiveImages: {
    type: 'boolean',
    title: '收图片',
    description: '下载图片。当前模型支持时附在消息中。',
    'x-hot': true,
  },
  receiveFiles: {
    type: 'boolean',
    title: '收文件',
    description: '下载文件并提供本地路径。当前模型支持的文件类型会作为附件一并投递。',
    'x-hot': true,
  },
  receiveVideos: {
    type: 'boolean',
    title: '收视频',
    description: '下载微信视频。当前模型支持时附上原视频，否则尝试抽帧。',
    'x-hot': true,
  },
  receiveVoices: {
    type: 'boolean',
    title: '收语音',
    description: '下载语音并将 SILK 转成 WAV。当前模型支持时附上音频，转码失败时保留原件。',
    'x-hot': true,
  },
  maxInboundMediaMb: {
    type: 'number',
    title: '单条媒体上限（MB）',
    description: '限制接收和发送的单个媒体文件。生成的 WAV 超限时保留原始 SILK。',
    'x-hot': true,
  },
  ffmpegSource: {
    type: 'string',
    title: 'FFmpeg 来源',
    description: 'auto 优先用系统 PATH，其次用本地副本。path 仅用系统 PATH，off 停用。可在「连接与工具」下载。',
    enum: ['auto', 'path', 'off'],
    'x-hot': false,
  },
  videoFrames: {
    type: 'number',
    title: '每条视频的抽帧数',
    description: '抽出的帧拼成一张图。0 关闭，最多 9 帧。',
    'x-hot': true,
  },
  ffmpegProxyUrl: {
    type: 'string',
    title: 'FFmpeg 下载代理',
    description: '仅用于下载 FFmpeg。留空使用直连。',
    'x-hot': false,
  },
  imageMaxMb: {
    type: 'number',
    title: '单图体积上限（MB）',
    description: '超出后尝试压缩。仍超限时在正文说明。',
    'x-hot': true,
  },
  imageMaxEdge: {
    type: 'number',
    title: '单图最长边上限（像素）',
    description: '超出后尝试缩小。仍超限时在正文说明。',
    'x-hot': true,
  },
  imageMaxCount: {
    type: 'number',
    title: '单次最多附几张图',
    description: '每次投递的图片上限，包含视频拼图。',
    'x-hot': true,
  },
  segmentEnabled: {
    type: 'boolean',
    title: '分段发送',
    description: '优先按换行拆分，其次按句号和语气标点拆分。',
    'x-hot': false,
  },
  segmentPace: {
    type: 'number',
    title: '聊天节奏',
    description: '按消息长度安排停顿。1 为默认，越大越慢，0 不等待。',
    minimum: 0,
    maximum: 10,
    multipleOf: 0.1,
    'x-hot': true,
  },
  segmentMaxParts: {
    type: 'number',
    title: '分段阈值',
    description:
      `语义段数达到此值时恢复完整原文，仍按微信单条 4000 字上限发送。最大 ${MAX_SEGMENT_THRESHOLD}，0 使用默认值。`,
    minimum: 0,
    maximum: MAX_SEGMENT_THRESHOLD,
    'x-hot': true,
  },
  segmentMaxTotalSec: {
    type: 'number',
    title: '总等待上限（秒）',
    description: '达到总停顿上限后连续发完。0 表示不限。',
    'x-hot': true,
  },
  nativeVoiceEnabled: {
    type: 'boolean',
    title: '试用微信原生语音条',
    description: '默认发 MP3 文件卡片。开启后尝试发原生语音条，显示效果以手机端为准。',
    'x-hot': true,
  },
} satisfies Record<Exclude<keyof WechatClawConfigSection, 'enabled' | keyof TtsSettings>, ConfigGroup['schema']['properties'][string]>;

const CONFIG_GROUPS = [
  {
    id: 'world:wechat-claw',
    zh: '消息投递与回复',
    en: 'Messages and replies',
    fields: ['inboundTrigger', 'segmentEnabled', 'segmentPace', 'segmentMaxParts', 'segmentMaxTotalSec', 'nativeVoiceEnabled'],
  },
  {
    id: 'world:wechat-claw:attachments',
    zh: '附件收发',
    en: 'Attachments',
    fields: ['receiveImages', 'receiveVideos', 'receiveVoices', 'receiveFiles', 'maxInboundMediaMb', 'inboxDir', 'sendExtraDirs'],
  },
  {
    id: 'world:wechat-claw:visual-media',
    zh: '图片与视频',
    en: 'Images and video',
    fields: ['imageMaxMb', 'imageMaxEdge', 'imageMaxCount', 'videoFrames', 'ffmpegSource', 'ffmpegProxyUrl'],
  },
  {
    id: 'world:wechat-claw:network',
    zh: '微信网络',
    en: 'WeChat network',
    fields: ['networkMode', 'proxyUrl', 'forceIpv4'],
  },
] as const satisfies readonly { id: string; zh: string; en: string; fields: readonly (keyof typeof CONFIG_FIELDS)[] }[];

export function wechatClawConfigGroups(language: string): ConfigGroup[] {
  return CONFIG_GROUPS.map(group => ({
    id: group.id,
    owner: 'world:wechat-claw',
    schema: {
      type: 'object',
      title: language.startsWith('zh') ? group.zh : group.en,
      properties: Object.fromEntries(group.fields.map(key => ['worlds.wechat-claw.' + key, CONFIG_FIELDS[key]])),
    },
  }));
}

/** 给 WebUI 的文案；界面语言只影响这里，不影响发给模型的文本。 */
export function wechatClawText(language: string = 'zh') {
  const zh = {
    label: '微信 ClawBot',
    lamp: '微信',
    panelTitle: '连接与工具',
    promptTitle: '微信 ClawBot · 环境提示词',
    promptDesc: '这个 World 进 system 前缀的那一段。',
    statusConnected: '已连接',
    statusUnbound: '未绑定',
    statusBinding: '绑定中',
    statusConnecting: '连接中',
    statusError: '连接异常',
    hintReady: (who: string) => (who ? `微信：${who}` : '微信：已连接'),
    hintUnbound: '在「连接与工具」中扫码绑定微信',
    badgeAccount: '账号',
    badgeLast: '最近消息',
    badgeState: '状态',
  };
  const en = {
    label: 'WeChat ClawBot',
    lamp: 'WeChat',
    panelTitle: 'Connection and tools',
    promptTitle: 'WeChat ClawBot environment prompt',
    promptDesc: 'The section this World contributes to the system prefix.',
    statusConnected: 'connected',
    statusUnbound: 'not bound',
    statusBinding: 'binding',
    statusConnecting: 'connecting',
    statusError: 'error',
    hintReady: (who: string) => (who ? `WeChat: ${who}` : 'WeChat: connected'),
    hintUnbound: 'Scan to bind WeChat under Connection and tools',
    badgeAccount: 'Account',
    badgeLast: 'Last message',
    badgeState: 'State',
  };
  return language === 'en' ? en : zh;
}
