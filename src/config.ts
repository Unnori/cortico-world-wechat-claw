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
  /** 段间等待口径：固定间隔，或在区间内随机。 */
  segmentDelayMode: 'fixed' | 'random';
  /** 固定间隔，秒。 */
  segmentDelayFixedSec: number;
  /** 随机间隔下限，秒。 */
  segmentDelayMinSec: number;
  /** 随机间隔上限，秒。 */
  segmentDelayMaxSec: number;
  /** 单次回复最多拆几条；超出就把剩下的合并进最后一条。 */
  segmentMaxParts: number;
  /** 一次发送累计等待上限，秒；到点就把剩下的一起发完。 */
  segmentMaxTotalSec: number;
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
  inboxDir: '',
  sendExtraDirs: '',
  ffmpegSource: 'auto',
  videoFrames: 4,
  imageMaxMb: 16,
  imageMaxEdge: 4096,
  imageMaxCount: 10,
  ffmpegProxyUrl: '',
  segmentEnabled: true,
  segmentDelayMode: 'fixed',
  segmentDelayFixedSec: 2,
  segmentDelayMinSec: 1,
  segmentDelayMaxSec: 4,
  segmentMaxParts: 12,
  segmentMaxTotalSec: 30,
};

export const WECHAT_CLAW_CONFIG_GROUP: ConfigGroup = {
  id: 'world:wechat-claw',
  owner: 'world:wechat-claw',
  schema: {
    type: 'object',
    title: '微信 ClawBot',
    description:
      '微信一对一私聊的接入方式与收件范围。绑定状态在「微信绑定」面板。\n'
      + '收到的文件落在桌宠工作区的收件目录里（默认 `wechat-inbox`），它能读、能改、也能发回来；\n'
      + '发出去的文件只能取自工作区，本机其他位置不会被发到微信。',
    properties: {
      'worlds.wechat-claw.inboxDir': {
        type: 'string',
        title: '收件目录',
        description:
          '收到的图片、文件、视频、语音存在这里。留空＝桌宠工作区下的 `wechat-inbox`（推荐，'
          + '这样桌宠读得到、改得了，也能原样发回去）。'
          + '相对路径按工作区解析；填绝对路径也可以，但放在工作区外面桌宠就读不到了。'
          + '目录和它下面的 images/files/videos/voices 会自动创建。修改后需重启。',
        'x-path': { kind: 'directory' },
        'x-hot': false,
      },
      'worlds.wechat-claw.sendExtraDirs': {
        type: 'string',
        title: '额外允许发送的目录',
        description:
          '留空即可。默认只有工作区（和上面的收件目录）里的文件能发到微信，避免把登录凭据之类的'
          + '本机文件发出去。确实要发工作区以外的文件时，把那些目录写在这里，一行一个'
          + '（分号或逗号也行）；相对路径按部署目录解析。每加一个目录，能发出去的东西就多一片，'
          + '请只写你自己放素材的目录。',
        'x-hot': true,
      },
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
        description:
          '打开后，对方发来的文件会下载到收件目录（默认工作区下的 `wechat-inbox/files`），'
          + '路径写进上下文，模型可自行读取、修改，也能用 `wechat_send_file` 发回去。',
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
        description:
          '0 表示不抽帧，最多 9 帧。抽出的帧会拼成一张图交给模型，不是分成多张。'
          + '这些都是代价，不是免费的：帧数越多，ffmpeg 解码和拼接越慢（9 帧明显比 4 帧慢），'
          + '每格画面也被压得越小，细节丢得越多。'
          + '4 帧够看清「视频在讲什么」，想追踪连续动作才往上加。',
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
      'worlds.wechat-claw.imageMaxMb': {
        type: 'number',
        title: '单图体积上限（MB）',
        description:
          '超过就先压缩；没有 ffmpeg 或压不下去就不附，正文会写明体积超了多少。'
          + '默认 16，比上游 32 MB 的硬限制更保守。',
        'x-hot': true,
      },
      'worlds.wechat-claw.imageMaxEdge': {
        type: 'number',
        title: '单图最长边上限（像素）',
        description:
          '超过就先缩小；缩不下去就不附，正文会写明实际尺寸。'
          + '默认 4096，比上游 8192 的硬限制更保守。',
        'x-hot': true,
      },
      'worlds.wechat-claw.imageMaxCount': {
        type: 'number',
        title: '单次最多附几张图',
        description:
          '一次事件投递里累计计算，包括图片消息和视频拼图。超出的不附，正文逐张写明是第几张超了。'
          + '默认 10，比上游 15 张的硬限制更保守。',
        'x-hot': true,
      },
      'worlds.wechat-claw.segmentEnabled': {
        type: 'boolean',
        title: '分段发送',
        description:
          '打开后一次回复拆成多条微信消息，像人一句一句说。'
          + '有换行就只按换行拆；没有换行才按句号；再没有才按！？…～。'
          + '中文句号会删掉（社交软件里带句号显得生硬），！？…～ 保留语气。修改后需重启。',
        'x-hot': false,
      },
      'worlds.wechat-claw.segmentDelayMode': {
        type: 'string',
        title: '间隔方式',
        description: '固定间隔，或在区间内随机取值。只在「分段发送」打开时有效。',
        enum: ['fixed', 'random'],
        'x-hot': true,
      },
      'worlds.wechat-claw.segmentDelayFixedSec': {
        type: 'number',
        title: '固定间隔（秒）',
        description: '每一段发完后等这么久。0 表示连着发完。',
        'x-hot': true,
      },
      'worlds.wechat-claw.segmentDelayMinSec': {
        type: 'number',
        title: '随机下限（秒）',
        description: '随机间隔的下界。和上限写反了会自动换过来。',
        'x-hot': true,
      },
      'worlds.wechat-claw.segmentDelayMaxSec': {
        type: 'number',
        title: '随机上限（秒）',
        description: '随机间隔的上界。',
        'x-hot': true,
      },
      'worlds.wechat-claw.segmentMaxParts': {
        type: 'number',
        title: '最多拆几段',
        description:
          '单次回复的上限。超出时把多出来的内容并进最后一段，避免模型输出几十行把这次发送拖很久。',
        'x-hot': true,
      },
      'worlds.wechat-claw.segmentMaxTotalSec': {
        type: 'number',
        title: '总等待上限（秒）',
        description:
          '一次发送里所有间隔加起来的上限。到点就把剩下的一起发完，回执会写明有截断。',
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
