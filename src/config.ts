import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * `config.json` 的 `worlds.wechat-claw` 段。
 *
 * 这里不放任何凭据：`bot_token`、同步游标、`context_token` 都在部署数据目录的
 * `wechat-claw/` 下，由 `store.ts` 管理。
 */
export interface WechatClawConfigSection {
  enabled: boolean;
  /** inherit = 跟随 Coopanion 的代理；direct = 直连；proxy = 用 proxyUrl。 */
  networkMode: 'inherit' | 'direct' | 'proxy';
  proxyUrl: string;
  /** direct/proxy 下强制 IPv4；系统 IPv6 路由坏掉时打开。 */
  forceIpv4: boolean;
  /** 收图时是否下载并交给模型看。 */
  receiveImages: boolean;
  /** 收文件时是否下载。 */
  receiveFiles: boolean;
  /** 收视频时是否下载。 */
  receiveVideos: boolean;
  /** 收语音时是否下载（微信语音是 SILK，落盘后由模型自行判断能否处理）。 */
  receiveVoices: boolean;
  /** 单条入站媒体上限，MB。超过只留占位，不下载。 */
  maxInboundMediaMb: number;
  /**
   * ffmpeg 从哪来。视频抽帧需要它，但不把它打进包里：
   * `auto` 先找 PATH 再用面板装的那份；`path` 只用 PATH；`off` 不抽帧。
   * 下载不由这个值触发，只能由面板按钮显式开始。
   */
  ffmpegSource: 'auto' | 'path' | 'off';
  /** 每条视频抽几帧。0 表示不抽。 */
  videoFrames: number;
  /** 每帧最长边像素。 */
  videoFrameMaxEdge: number;
  /** 下载 ffmpeg 用的代理；留空表示直连（不继承只给模型用的那条代理）。 */
  ffmpegProxyUrl: string;
}

export const WECHAT_CLAW_DEFAULTS: WechatClawConfigSection = {
  enabled: false,
  networkMode: 'inherit',
  proxyUrl: '',
  forceIpv4: false,
  receiveImages: true,
  receiveFiles: true,
  receiveVideos: false,
  receiveVoices: true,
  maxInboundMediaMb: 20,
  ffmpegSource: 'auto',
  videoFrames: 4,
  videoFrameMaxEdge: 640,
  ffmpegProxyUrl: '',
};

export const WECHAT_CLAW_CONFIG_GROUP: ConfigGroup = {
  id: 'world:wechat-claw',
  owner: 'world:wechat-claw',
  schema: {
    type: 'object',
    title: '微信 ClawBot',
    description:
      '微信一对一私聊的接入方式与收件范围。绑定状态在「微信绑定」面板。\n'
      + '⚠ 安全提示：启用后模型能把本机任意文件发到微信，包括它自己的登录令牌，'
      + '发送前不会向你确认。只在你信任这个微信账号、并清楚可能被发出去什么时启用。',
    properties: {
      'worlds.wechat-claw.networkMode': {
        type: 'string',
        title: '网络出口',
        description:
          'inherit：跟随 Coopanion 的代理；direct：直连，绕过代理；proxy：用下面的代理地址。微信域名走模型代理时连不上就改这里。修改后需重启。',
        enum: ['inherit', 'direct', 'proxy'],
        'x-hot': false,
      },
      'worlds.wechat-claw.proxyUrl': {
        type: 'string',
        title: '代理地址',
        description: 'proxy 模式使用，例如 http://127.0.0.1:7890。只支持 HTTP/HTTPS 代理。修改后需重启。',
        'x-hot': false,
      },
      'worlds.wechat-claw.forceIpv4': {
        type: 'boolean',
        title: '优先 IPv4',
        description: 'direct/proxy 模式下强制 IPv4。连接一直超时且系统 IPv6 路由不可用时打开。修改后需重启。',
        'x-hot': false,
      },
      'worlds.wechat-claw.receiveImages': {
        type: 'boolean',
        title: '收图片',
        description: '打开后，对方发来的图片会下载到本地，并在模型支持图片时作为附件交给它。',
        'x-hot': true,
      },
      'worlds.wechat-claw.receiveFiles': {
        type: 'boolean',
        title: '收文件',
        description: '打开后，对方发来的文件会下载到本地，路径写进上下文，模型可自行读取。',
        'x-hot': true,
      },
      'worlds.wechat-claw.receiveVideos': {
        type: 'boolean',
        title: '收视频',
        description: '打开后，对方发来的视频会下载到本地。视频体积大，默认关闭。',
        'x-hot': true,
      },
      'worlds.wechat-claw.receiveVoices': {
        type: 'boolean',
        title: '收语音',
        description: '打开后，对方发来的语音会下载到本地。微信优先给出服务端转写文本，语音本身是 SILK 编码。',
        'x-hot': true,
      },
      'worlds.wechat-claw.maxInboundMediaMb': {
        type: 'number',
        title: '单条媒体上限（MB）',
        description: '超过这个大小的附件不下载，只留一句占位说明。',
        'x-hot': true,
      },
      'worlds.wechat-claw.ffmpegSource': {
        type: 'string',
        title: 'ffmpeg 来源',
        description:
          '视频抽帧要用 ffmpeg。auto：先找系统 PATH，找不到再用「ffmpeg」面板里装的那份；'
          + 'path：只用 PATH 里的；off：不抽帧。这里不会触发下载——要装就去面板点按钮。'
          + '拿不到 ffmpeg 时不会假装看过视频，正文会写明没抽帧。修改后需重启。',
        enum: ['auto', 'path', 'off'],
        'x-hot': false,
      },
      'worlds.wechat-claw.videoFrames': {
        type: 'number',
        title: '每条视频抽几帧',
        description: '0 表示不抽帧。帧越多越费 token；4 帧够看清视频在讲什么。',
        'x-hot': true,
      },
      'worlds.wechat-claw.ffmpegProxyUrl': {
        type: 'string',
        title: '下载 ffmpeg 用的代理',
        description:
          '留空表示直连。ffmpeg 的源在 GitHub，和微信域名不同：Coopanion 注进环境变量的代理只服务模型端点，'
          + '拿它连 GitHub 会失败，所以这里单独配。国内直连不通时填 http://127.0.0.1:7890 之类。修改后需重启。',
        'x-hot': false,
      },
      'worlds.wechat-claw.videoFrameMaxEdge': {
        type: 'number',
        title: '每帧最长边（像素）',
        description: '抽出的帧会缩到这个尺寸再交给模型。越小越省 token，也越看不清细节。',
        'x-hot': true,
      },
    },
  },
};

/** 给 WebUI 的文案；界面语言只影响这里，不影响发给模型的文本。 */
export function wechatClawText(language: string = 'zh') {
  const zh = {
    label: '微信 ClawBot',
    lamp: '微信',
    panelTitle: '微信绑定',
    panelDesc: '用手机微信扫码，把这个微信号接进来。只支持一对一私聊。',
    ffmpegPanelTitle: 'ffmpeg',
    ffmpegPanelDesc: '视频抽帧要 ffmpeg。点「下载」才会联网；装在这里，不改系统环境变量。',
    promptTitle: '微信 ClawBot · 环境提示词',
    promptDesc: '这个 World 进 system 前缀的那一段。',
    statusConnected: '已连接',
    statusUnbound: '未绑定',
    statusBinding: '绑定中',
    statusConnecting: '连接中',
    statusError: '连接异常',
    hintReady: (who: string) => (who ? `微信：${who}` : '微信：已连接'),
    hintUnbound: '在「微信绑定」面板扫码',
    badgeAccount: '账号',
    badgeLast: '最近消息',
    badgeState: '状态',
  };
  const en = {
    label: 'WeChat ClawBot',
    lamp: 'WeChat',
    panelTitle: 'WeChat binding',
    panelDesc: 'Scan with WeChat to bind this contact. One-to-one private chat only.',
    ffmpegPanelTitle: 'ffmpeg',
    ffmpegPanelDesc: 'Video frames need ffmpeg. Nothing is downloaded until you press Download; it installs here and leaves PATH alone.',
    promptTitle: 'WeChat ClawBot environment prompt',
    promptDesc: 'The section this World contributes to the system prefix.',
    statusConnected: 'connected',
    statusUnbound: 'not bound',
    statusBinding: 'binding',
    statusConnecting: 'connecting',
    statusError: 'error',
    hintReady: (who: string) => (who ? `WeChat: ${who}` : 'WeChat: connected'),
    hintUnbound: 'Scan in the WeChat binding panel',
    badgeAccount: 'Account',
    badgeLast: 'Last message',
    badgeState: 'State',
  };
  return language === 'en' ? en : zh;
}
