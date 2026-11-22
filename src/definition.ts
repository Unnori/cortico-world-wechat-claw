import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import type { DescribeText } from 'cortico/core/types.ts';

import { DEFAULT_INBOUND_TRIGGER, INBOUND_TRIGGER_OPTIONS, inboundTriggerOptions, WECHAT_CLAW_DEFAULTS, type WechatClawConfigSection } from './config.ts';
import { EVENT_LINK, EVENT_MESSAGE, WECHAT_CLAW_TOOL_DECLS, WechatClawWorld } from './world.ts';

const TOOL_SUMMARIES: Record<string, DescribeText> = {
  wechat_send: {
    zh: '回复绑定的微信用户。',
    en: 'Reply to the bound WeChat user.',
  },
  wechat_send_image: {
    zh: '把本地一张图片发到微信。',
    en: 'Send a local picture to WeChat.',
  },
  wechat_send_file: {
    zh: '把本地一个文件发到微信。',
    en: 'Send a local file to WeChat.',
  },
  wechat_status: {
    zh: '查看连接、附件状态与模型输入能力。',
    en: 'Check connection, attachments and model input support.',
  },
  wechat_send_voice: {
    zh: '发送本地音频或宿主音频附件，默认发 MP3 文件卡片。',
    en: 'Send local audio or a host audio blob, as an MP3 attachment by default.',
  },
  wechat_speak: {
    zh: '启用 TTS 时，将文字合成后发到微信，音频失败时补发原文。',
    en: 'When TTS is enabled, synthesize and send audio to WeChat, with the original text as a fallback.',
  },
  wechat_events: {
    zh: '按类型和时间查已归档的微信事件。',
    en: 'Read archived WeChat events by kind and time.',
  },
};

export const WECHAT_CLAW: WorldDefinition<WechatClawConfigSection> = {
  id: 'wechat-claw',
  label: '微信 ClawBot',
  defaults: () => ({ ...WECHAT_CLAW_DEFAULTS }),
  configOptions: (kind, language) => kind === INBOUND_TRIGGER_OPTIONS ? inboundTriggerOptions(language) : [],
  create: (ctx) => new WechatClawWorld({
    cfg: ctx.cfg,
    // 工作区要从部署根推：`WorldContext` 不给 memoryDir，见 paths.ts。
    botDir: ctx.botDir,
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
    ttsApiKey: (name) => ctx.secret(name),
    storeTtsApiKey: (name, value) => ctx.storeSecret(name, value),
    persistTtsSettings: (settings) => ctx.persist(settings),
  }),
  describe: {
    tools: describeTools(WECHAT_CLAW_TOOL_DECLS, TOOL_SUMMARIES),
    events: [
      {
        type: EVENT_MESSAGE,
        description: {
          zh: '一条微信私聊消息。默认合并后投递，投递方式可在配置页修改。正文包含媒体路径，Provider 支持的文件随消息附上。不支持原生视频时尝试抽帧。',
          en: 'A WeChat 1:1 message. Incoming messages are batched by default, and delivery can be configured. The message includes local media paths and attaches files accepted by the Provider. Video falls back to frames.',
        },
        trigger: DEFAULT_INBOUND_TRIGGER,
      },
      {
        type: EVENT_LINK,
        description: {
          zh: '绑定状态变化：绑定成功或会话过期。',
          en: 'The binding changed: bound, or the session expired.',
        },
      },
    ],
  },
};

export default WECHAT_CLAW;
