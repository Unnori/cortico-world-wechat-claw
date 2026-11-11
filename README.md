<!-- Owner: src/definition.ts, src/world.ts -->
# 微信 ClawBot · cortico-world-wechat-claw

通过微信 ClawBot（iLink）和 Coopanion 桌宠一对一聊天。**文字、图片、文件双向收发。**

这是独立开发的实现，不复用 `cortico-world-clawbot` 的代码。协议形状对齐腾讯官方
[`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
2.4.10 与它的[后端协议文档](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)。

## 和现成 Claw 插件的差别

| | 现成 `cortico-world-clawbot` 0.1.0 | 这个扩展 |
|---|---|---|
| 文本收发 | 支持 | 支持 |
| 收图片 | 只显示 `[图片]` 占位 | 下载解密到本地，路径进上下文，模型支持图片时作为附件到达 |
| 发图片 | 不支持 | `wechat_send_image`：加密上传到微信 CDN 再发 |
| 收文件 | 只显示 `[文件 名字]` 占位 | 下载解密到本地，路径进上下文 |
| 发文件 | 不支持 | `wechat_send_file`：同上，带原文件名与明文长度 |
| 语音 | 占位 | 优先用服务端转写文本；语音文件本身落盘 |
| 长文本 | 超 4000 字被拒 | 自动切成多条发送，优先在段落与句号处断开 |
| 出站视频 | 不支持 | 按 MIME 走视频通道，微信里显示成视频而不是附件 |
| 入站超限 | 无区分 | 超限、缺参数、下载失败三种原因分别措辞 |
| 视频 | 占位 | 可选下载（默认关）；抽帧可用时把若干帧拼成一张图附上，不可用时正文写明没抽帧 |
| 网络出口 | inherit / direct / proxy | 相同，且把「配置要的出口做不到」如实报出来 |
| 令牌失效 | 直接断开并清凭据 | 按官方约定暂停一小时后重试，只有 HTTP 401/403 才判定会话过期 |
| 绑定面板 | 有 | 有，走内建 UI 原语，带二维码、扫码状态、验证码输入 |

## 工具

| 工具 | 作用 |
|---|---|
| `wechat_send` | 回复最近一条微信消息；只能发给刚发消息的人，单条上限 4000 字 |
| `wechat_send_image` | 把本地一张图发到微信，可带一句说明 |
| `wechat_send_file` | 把本地一个文件发到微信，可带一句说明 |
| `wechat_status` | 连接、账号、最近消息、错误、持有多少条会话令牌 |
| `wechat_events` | 按类型和时间查已归档的微信事件 |

| 事件 | 作用 |
|---|---|
| `wechat-claw.message` | 一条微信私聊消息；媒体路径在正文里，图片与语音作为附件随事件到达 |
| `wechat-claw.link` | 绑定成功或会话过期 |

## 安装

设置 → 扩展 → 安装本地扩展，选这个目录；重启 Coopanion。然后在 World 页启用「微信 ClawBot」。

```bash
cd %APPDATA%\Coopanion\extensions
corepack pnpm add "<这个包所在的绝对路径>"
```

装好不等于启用：配置段默认 `enabled: false`，要去 World 总览激活。

## 绑定

1. 打开「微信绑定」面板，点「生成二维码」。
2. 用手机微信扫码；二维码打不开时复制面板里的链接。
3. 手机要求输入数字时，在面板的验证码框里填写并提交。

绑定成功后重启不需要重新扫码，直到会话过期。一个微信号只能绑定一个 ClawBot 客户端；换号或解绑请在微信里操作。

## 配置

配置段是 `worlds.wechat-claw`。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否挂载本 World；打开后尝试用已保存的凭据连接 |
| `networkMode` | `inherit` | `inherit` 跟随 Coopanion 的代理；`direct` 直连；`proxy` 用 `proxyUrl` |
| `proxyUrl` | 空 | `proxy` 模式的 HTTP/HTTPS 代理，例如 `http://127.0.0.1:7890` |
| `forceIpv4` | `false` | `direct`/`proxy` 下强制 IPv4 |
| `receiveImages` | `true` | 收图时下载并交给模型 |
| `receiveFiles` | `true` | 收文件时下载 |
| `receiveVideos` | `false` | 收视频时下载（体积大，默认关） |
| `receiveVoices` | `true` | 收语音时下载 |
| `maxInboundMediaMb` | `20` | 单条入站媒体上限，超过只留占位；也是出站媒体的上限 |
| `inboxDir` | 空 | 收件目录。留空＝桌宠工作区下的 `wechat-inbox`；相对路径按工作区解析。改完要重启 |
| `sendExtraDirs` | 空 | 额外允许发到微信的目录，一行一个（分号、逗号也行）。留空时只有工作区（与收件目录）能发 |
| `ffmpegSource` | `auto` | 视频抽帧用哪份 ffmpeg：`auto` 先 PATH 再用面板装的那份、`path` 只用 PATH、`off` 不抽帧 |
| `videoFrames` | `4` | 每条视频抽几帧（上限 9），抽完拼成一张图；0 表示不抽 |
| `imageMaxMb` | `16` | 单图体积上限，超了先压缩，压不了就不附 |
| `imageMaxEdge` | `4096` | 单图最长边上限，超了先缩小 |
| `imageMaxCount` | `10` | 一次事件投递最多附几张图 |
| `ffmpegProxyUrl` | 空 | 下载 ffmpeg 用的代理；留空直连（不继承只给模型用的那条代理） |
| `segmentEnabled` | `true` | 分段发送：一次回复拆成多条微信消息 |
| `segmentDelayMode` | `fixed` | `fixed` 固定间隔；`random` 在 `segmentDelayMinSec`~`segmentDelayMaxSec` 之间随机 |
| `segmentDelayFixedSec` | `2` | 固定间隔，秒 |
| `segmentDelayMinSec` | `1` | 随机间隔下限，秒 |
| `segmentDelayMaxSec` | `4` | 随机间隔上限，秒 |
| `segmentMaxParts` | `12` | 单次最多拆几段，超出并进最后一段 |
| `segmentMaxTotalSec` | `30` | 累计等待上限，到点不再等但剩下的照常发完 |

`bot_token`、同步游标和 `context_token` 都在 `<dataDir>/wechat-claw/`，不进配置、不进日志、不进事件 `meta.raw`。
**它们在工作区外面，所以发不出去**——`wechat_send_image` / `wechat_send_file` 只接受工作区内的路径（见下）。

## 收来的文件落在哪

收到的图片、文件、视频、语音直接落进**桌宠工作区的收件目录**：

```
<工作区>/wechat-inbox/
├── images/     wx-image-20261108-144219.png
├── files/      报告-20261108-144219.pdf     ← 原文名在前，时间戳在后
├── videos/     wx-video-20261108-144219.mp4
├── voices/     wx-voice-20261108-144219.silk
└── .derived/   压缩后的图、视频拼图（中间产物）
```

工作区是哪个目录，按框架自己的解析顺序猜：`config.json` 的 `paths.memory` 优先，其次探测
`<部署目录>/workspace`（Coopanion 的 Coo 用这个），再退到 `memory`。`wechat_status` 会如实报出
实际用的 `workspace`、`inbox` 和允许发送的目录，`wechat-claw` 的环境提示词里也写着收件目录的绝对路径。

放在这里而不是插件自己的数据目录，是因为**桌宠要伸手去够**：它读得到、改得了、也能原样发回去。
文件名保留对方给的原文名，撞名时退到 `-2`、`-3`，从不覆盖已有文件。

工作区如果是一个 Git 仓库（Coopanion 的 Coo 就是），启动时会把 `wechat-inbox/` 追加进工作区的
`.gitignore`——十几 MB 的视频进版本历史没有意义。**只在 `.gitignore` 已存在时追加**，且幂等。

## 发出去只能取工作区里的文件

这是本扩展的安全边界：`wechat_send_image` 和 `wechat_send_file` 只接受**工作区、收件目录，
以及 `sendExtraDirs` 里额外放行的目录**内的路径。

理由很实在：模型能被说服。把本机任意路径交给它，等于把 `auth.json`、`context-tokens.json`、
浏览器 cookie 一起交出去。现在这些文件在工作区外面，边界一挡就拿不到了。

- 判断前先做 `realpath`，所以 `..` 和符号链接都绕不出去。
- 拒绝时回执会列出允许的目录和收件目录，模型照着调整路径即可，不需要反复试错。
- 确实要发工作区以外的素材，把目录写进 `sendExtraDirs`；每加一个，能发出去的东西就多一片。

收来的文件在工作区里，所以「收到 → 改 → 发回」这条路是通的，不需要额外放行任何目录。

## 分段发送

微信里一次吐一大段不像人说话。打开分段发送后，一次回复会拆成几条，一条一条发，条与条之间停顿。

**拆分只算一次**，不会拆两次：

| 文本里有 | 按什么拆 | 分隔符 |
|---|---|---|
| 换行 `\n` | 只按换行 | 删掉 |
| 没有换行，有句号 `。．.` | 只按句号 | 删掉 |
| 都没有，有 `！？!?…～~` | 只按这些 | **保留** |
| 都没有 | 整条发 | —— |

换行和句号同时出现时（「三层：\n第一。\n第二。」），按换行拆完就结束，**不会再多拆一次**；
但紧挨换行的段尾句号会一并去掉，所以发出去是「第一」「第二」，段内的句号保留。

**为什么删句号**：微信里带句号显得生硬，像在写公文，真人不这么打字。`！？…～` 留着，因为那是语气。

**ASCII `.` 有额外保护**：只在后面跟空白或位于结尾时才当句号。所以 `3.14`、`docs.nonebot.dev`、`report.2026.11.md` 不会被切坏。

**两道上限**：单次最多 `segmentMaxParts` 段，多的并进最后一段；累计等待超过 `segmentMaxTotalSec` 就不再多等，但**剩下的照常发完**（不会因为等不起而漏发）。

不想要就在配置页关掉「分段发送」。

## 视频抽帧

视频抽帧要 ffmpeg，但扩展不把它打进包里，**也绝不悄悄下载**。

### 装 ffmpeg

在「ffmpeg」面板上点「下载 ffmpeg」才会联网。启用 World、改配置、切 `ffmpegSource` 都不触发下载。

- 从 `ffmpeg-static` 的 GitHub Releases 下静态构建：压缩包约 27 MB，解压后约 77 MB。
- 装在 `<dataDir>/wechat-claw/bin/`，**不改系统 PATH**——悄悄改全局环境变量会影响其他程序，卸载扩展后还会留下垃圾。
  想手动加 PATH 的话，面板上有「复制路径」。
- 下载完跑一次 `ffmpeg -version` 才算成功，跑不通就删掉并如实报告，不靠文件名或大小猜。
- 面板能看进度、取消、删除已下载的那份。

### 用哪一份

`ffmpegSource` 决定：

- `auto`（默认）：先找系统 PATH，找不到就用面板装的那份。
- `path`：只用 PATH 里的，面板装的那份不会被使用。
- `off`：不抽帧。

### 下载走哪条网络

ffmpeg 的源在 GitHub，和微信域名不是一回事。Coopanion 注进环境变量的代理只服务模型端点，
拿它连 GitHub 会直接失败，所以下载单独配出口：`ffmpegProxyUrl` 留空表示直连，填了就那个代理。

**没有可用 ffmpeg 时不会假装看过视频**：正文会写明 `[视频帧未抽取：…]`，模型据此不去描述画面。

### 拼图而不是散图

抽出的帧会**拼成一张图**，不是发好几张。4 份图片输入变成 1 份，token 省四分之三；模型看到的也是
时间相邻的画面，更容易判断「中间发生了什么变化」。

布局按帧数和视频方向自动推导：

| 视频方向 | 4 帧 | 6 帧 | 9 帧 |
|---|---|---|---|
| 横屏 | 2×2 田字格 | 3×2 | 3×3 |
| 竖屏 | 4×1 横排 | 6×1 | 9×1 |

正文会写明顺序（例如「2列×2行，从左上到右下按时间顺序」）、原视频分辨率、每格实际尺寸——
模型据此知道画面被压到多小、细节还剩多少。

**帧数越多代价越大**：ffmpeg 解码与拼接更慢（9 帧明显比 4 帧慢），每格画面也被压得越小、细节丢得越多。
4 帧够看清「视频在讲什么」，想追踪连续动作才往上加。上限 9 帧。

## 图片与视频的投递闸门

上游 Provider 对图片有硬限制（DeepSeek：单边 ≤8192、单图 ≤32 MB、连续 ≤15 张）。
超过就整条请求被拒，用户看到的是 HTTP 400 和「发送了不支持的图片」。所以这里在交给模型之前先拦一道。

安全线比上游更严：**16 MB / 4096 像素 / 单次 10 张**。

| 情况 | 处理 |
|---|---|
| 都在范围内 | 原样附上 |
| 超限且**已装 ffmpeg** | 缩到最长边 4096，再按 JPEG 质量 3→6→9 逐级降质，每级重查体积 |
| 超限且**没装 ffmpeg** | 不附 |
| 压不下去 | 不附 |
| 超出数量额度 | 不附 |

**丢弃一定说明原因**，绝不静默吞掉——否则用户会以为消息丢了：

```
[图片未附：体积 23.4 MB，超过 16 MB 上限]
[图片未附：尺寸 8192×6144，最长边超过 4096 像素]
[图片未附：超出本次投递 10 张的上限，这是第 11 张]
[图片未附：体积 23.4 MB，超过 16 MB 上限，且没有 ffmpeg 可压缩]
[图片未附：尺寸 6000×4000，最长边超过 4096 像素，压缩后仍超标]
```

压成功了也会写：`[图片 尺寸 6000×4000，最长边超过 4096 像素，已压缩为 284 KB]`。

数量额度**一次事件投递里累计**，图片消息和视频拼图一起算。

## 网络

Coopanion 启动 Core 时会把系统代理写进 `HTTP_PROXY`/`HTTPS_PROXY`，那条代理是给模型端点用的。
微信域名走同一条代理时常常连不上，表现为 `UND_ERR_CONNECT_TIMEOUT`。

三种出口：

- `inherit`（默认）：跟随 Coopanion 的代理。
- `direct`：扩展自己建直连，绕过代理；适合代理只给模型用的情况。
- `proxy`：用 `proxyUrl` 指定的代理；适合必须走代理才能访问腾讯域名的情况。

网络设置改完要重启 Coopanion。「微信绑定」面板与 `wechat_status` 会显示当前生效的出口。

## 媒体怎么走

出站（Coo 发图/发文件）：**先过路径边界**（只许工作区）→ 读本地文件 → 申请上传参数（明文大小与 MD5）→
AES-128-ECB 加密 → POST 密文到微信 CDN → 从响应头 `x-encrypted-param` 取下载参数 → 发一条图片或文件消息。
说明文字作为独立文本消息先发，与官方发送端一致。

入站（对方发图/发文件）：用 `media.aes_key`（或图片的 `aeskey` 明文十六进制）解密 →
落到 `<工作区>/wechat-inbox/{images,files,videos,voices}/`（原文名 + 时间戳）→ 路径写进事件正文 →
模型接受该 MIME 时字节作为附件随事件到达。

正文里的图片尺寸读自落盘文件本身（JPEG 的 SOF 段、PNG 的 IHDR 等）。微信消息里的
`thumb_width` / `thumb_height` 是缩略图尺寸，普遍只有 210 像素宽，和真图差一个数量级，
所以不用它。

## 限制

- 只支持 1v1 私聊；没有群聊、好友列表、朋友圈、转账或红包。
- 只能回复，不能主动发起会话。回复需要对方最近一条消息的 `context_token`，约 24 小时后失效。
- 单条文本上限 4000 字；更长的回复由扩展自动分条，断行优先落在段落与句号上。
- 微信语音是 SILK 编码，本扩展只落盘不解码；语音转文字用服务端给的 `voice_item.text`。没有转写时模型只知道时长。
- 视频抽帧需要 ffmpeg；没有可用 ffmpeg 时不抽帧，正文会写明。不做音频转写。
- 微信 ClawBot 是腾讯面向 OpenClaw 的官方通道，不是面向任意第三方 agent 的公开 SDK。条款、灰度范围、额度与接口都可能变化；发布前请核对当前条款。这个扩展不是腾讯或 Coopanion 的官方扩展。

## 开发

```powershell
corepack pnpm install
corepack pnpm typecheck
corepack pnpm exec tsc -p tsconfig.web.json --noEmit
corepack pnpm test
corepack pnpm build          # 打 dist/webui.js
```

测试用本机真端口的假 iLink 服务端，覆盖请求形状、uint64 ID 无损解析、AES 往返、
入站媒体落盘、出站上传后 CDN 上的密文可解回原文。没有 mock 掉 HTTP。

发布前在 Cortico 检出根下跑：

```bash
pnpm describe:extension <包目录>
pnpm check:extension <包目录>
```

## 目录结构

```
cortico-world-wechat-claw/
├── package.json
├── describe.json          # describe:extension 生成
├── src/
│   ├── media/
│   │   ├── ffmpeg.ts    # 解析 PATH / 面板显式下载安装，跑 -version 校验
│   │   └── frames.ts    # 调 ffmpeg 均匀抽帧
│   ├── protocol/
│   │   ├── types.ts       # 线上形状（字段名与枚举）
│   │   ├── api.ts         # 鉴权、公共头、长轮询、发消息、申请上传
│   │   ├── crypto.ts      # AES-128-ECB 与两种 aes_key 编码
│   │   ├── media.ts       # CDN 上传与下载解密
│   │   ├── inbound.ts     # 入站可读化与媒体落盘
│   │   ├── outbound.ts    # 出站消息项构造
│   │   ├── mime.ts        # 扩展名 ↔ MIME、魔数识别
│   │   ├── network.ts     # 三种网络出口
│   │   └── fetch.ts       # undici 与宿主 fetch 的类型适配
│   ├── driver.ts          # 长轮询、重连退避、令牌失效暂停
│   ├── store.ts           # 凭据与游标
│   ├── paths.ts           # 工作区 / 收件目录 / 文件名 / 发送边界
│   ├── world.ts           # 工具、事件、绑定面板
│   ├── config.ts          # 配置段与文案
│   ├── definition.ts      # WorldDefinition 与自描述
│   ├── index.ts
│   ├── ENV_PROMPT.md
│   └── webui/
│       ├── client.ts     # 面板入口（绑定 + ffmpeg）
│       └── ffmpeg.ts     # ffmpeg 下载面板
├── dist/webui.js          # 面板产物
├── scripts/build-webui.mjs
└── tests/
    ├── paths.test.ts      # 工作区探测、文件名清理、发送边界
    └── …                  # 协议、驱动、出站、入站、分段
```

## 许可

本包代码 MIT。非官方扩展：与腾讯、微信 ClawBot、Coopanion / Cortico 的作者无关。
