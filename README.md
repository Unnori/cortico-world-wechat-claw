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
| 视频 | 占位 | 可选下载（默认关）；抽帧可用时附几帧画面，不可用时正文写明没抽帧 |
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
| `ffmpegSource` | `auto` | 视频抽帧用哪份 ffmpeg：`auto` 先 PATH 再用面板装的那份、`path` 只用 PATH、`off` 不抽帧 |
| `videoFrames` | `4` | 每条视频抽几帧，0 表示不抽 |
| `videoFrameMaxEdge` | `640` | 每帧最长边像素 |
| `ffmpegProxyUrl` | 空 | 下载 ffmpeg 用的代理；留空直连（不继承只给模型用的那条代理） |

`bot_token`、同步游标和 `context_token` 都在 `<dataDir>/wechat-claw/`，不进配置、不进日志、不进事件 `meta.raw`。

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

## 网络

Coopanion 启动 Core 时会把系统代理写进 `HTTP_PROXY`/`HTTPS_PROXY`，那条代理是给模型端点用的。
微信域名走同一条代理时常常连不上，表现为 `UND_ERR_CONNECT_TIMEOUT`。

三种出口：

- `inherit`（默认）：跟随 Coopanion 的代理。
- `direct`：扩展自己建直连，绕过代理；适合代理只给模型用的情况。
- `proxy`：用 `proxyUrl` 指定的代理；适合必须走代理才能访问腾讯域名的情况。

网络设置改完要重启 Coopanion。「微信绑定」面板与 `wechat_status` 会显示当前生效的出口。

## 媒体怎么走

出站（Coo 发图/发文件）：读本地文件 → 申请上传参数（明文大小与 MD5）→ AES-128-ECB 加密 →
POST 密文到微信 CDN → 从响应头 `x-encrypted-param` 取下载参数 → 发一条图片或文件消息。
说明文字作为独立文本消息先发，与官方发送端一致。

入站（对方发图/发文件）：用 `media.aes_key`（或图片的 `aeskey` 明文十六进制）解密 →
落到 `<dataDir>/wechat-claw/inbox/{images,files,videos,voices}/` → 路径写进事件正文 →
模型接受该 MIME 时字节作为附件随事件到达。

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
```

## 许可

本包代码 MIT。非官方扩展：与腾讯、微信 ClawBot、Coopanion / Cortico 的作者无关。
