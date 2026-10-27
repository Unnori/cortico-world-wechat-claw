import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import type { DescribeText } from 'cortico/core/types.ts';

import { WECHAT_CLAW_DEFAULTS, type WechatClawConfigSection } from './config.ts';
import { EVENT_LINK, EVENT_MESSAGE, WECHAT_CLAW_TOOL_DECLS, WechatClawWorld } from './world.ts';

const TOOL_SUMMARIES: Record<string, DescribeText> = {
  wechat_send: {
    zh: '回复最近一条微信消息；只能发给刚发消息的人。',
    en: 'Reply to the latest WeChat message; sends only to the person who just wrote.',
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
    zh: '查看微信连接、账号、最近消息与错误。',
    en: 'Show the WeChat connection, account, last message and errors.',
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
  create: (ctx) => new WechatClawWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
  }),
  describe: {
    tools: describeTools(WECHAT_CLAW_TOOL_DECLS, TOOL_SUMMARIES),
    events: [
      {
        type: EVENT_MESSAGE,
        description: {
          zh: '一条微信私聊消息；正文是一行可读文本，媒体路径写在正文里，图片与语音作为附件随事件到达。',
          en: 'A WeChat 1:1 message; the text is one readable line, media paths are inline, and pictures or voices arrive as attachments.',
        },
        trigger: 'debounce',
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
