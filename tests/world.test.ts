/**
 * World 层：工具回执、事件形状、入站媒体落地、出站上传、绑定面板与状态。
 *
 * 用真端口、真文件、真事件宿主；只有模型是假的（这里根本不调模型）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { EventEnvelope, ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';

import { WECHAT_CLAW } from '../src/definition.ts';
import { WECHAT_CLAW_DEFAULTS, type WechatClawConfigSection } from '../src/config.ts';
import { WechatClawWorld, EVENT_MESSAGE } from '../src/world.ts';
import { encryptForTest, startFakeServer, type FakeServer } from './helpers/fake-server.ts';

/** 记录推送事件的假宿主；blob 与模型能力按需配置。 */
class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  acceptImages = true;
  log = nullLogger();

  async pushEvent(
    event: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery' | 'blobs'> & {
      origin?: 'internal' | 'external';
      blobs?: unknown[];
    },
    opts?: { deliver?: boolean; trigger?: string },
  ): Promise<EventEnvelope> {
    const full = { ...event, cursor: this.events.length + 1, blobs: event.blobs } as unknown as EventEnvelope;
    this.events.push(full);
    void opts;
    return full;
  }

  pushDeferred(): void {}

  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];

  blob = (): { bytes: Uint8Array; mime: string } | null => null;

  modelFacts = {
    model: () => 'test-model',
    accepts: (mime: string) => (mime.startsWith('image/') ? this.acceptImages : false),
    contextWindow: () => 128000,
  };

  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }

  reportUsage(): void {}
}

const call = {} as ToolCallContext;

/** 直接构造 World，把地址指向假服务端；绕开 create() 是为了不依赖官方域名。 */
function makeWorld(opts: {
  cfg: WechatClawConfigSection;
  dataDir: string;
  server: FakeServer;
}): WechatClawWorld {
  return new WechatClawWorld({
    cfg: opts.cfg,
    dataDir: opts.dataDir,
    timezone: 'Asia/Shanghai',
    endpoints: { apiBaseUrl: opts.server.baseUrl, cdnBaseUrl: opts.server.cdnBaseUrl },
  });
}

let scratchDir = '';
let server: FakeServer | null = null;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'wechat-claw-'));
});

afterEach(async () => {
  if (server) await server.close();
  server = null;
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('定义与声明', () => {
  it('默认配置禁用，且与 schema 声明的每个键都有默认值', () => {
    const defaults = WECHAT_CLAW.defaults();
    expect(defaults.enabled).toBe(false);
    const group = WECHAT_CLAW_DEFAULTS;
    expect(Object.keys(group).sort()).toEqual(Object.keys(defaults).sort());
  });

  it('工具名带 wechat_ 前缀，且自描述与 tools() 一致', () => {
    const world = WECHAT_CLAW.create({
      id: 'wechat-claw',
      cfg: { ...WECHAT_CLAW_DEFAULTS },
      timezone: 'Asia/Shanghai',
      botName: 'Coo',
      botDir: scratchDir,
      packageDir: scratchDir,
      dataDir: scratchDir,
      repoRoot: scratchDir,
      secret: () => '',
      storeSecret: () => {},
      persist: () => {},
      restart: async () => {},
    } as never);
    const names = world.tools().map((tool) => tool.name);
    expect(names.every((name) => name.startsWith('wechat_'))).toBe(true);
    const described = (WECHAT_CLAW.describe?.tools ?? []).map((tool) => tool.name);
    expect(described.sort()).toEqual(names.sort());
  });

  it('环境提示词里的占位符都有值，渲染后不残留', async () => {
    const world = new WechatClawWorld({
      cfg: { ...WECHAT_CLAW_DEFAULTS },
      dataDir: scratchDir,
      timezone: 'Asia/Shanghai',
    });
    const vars = world.envPromptVars();
    const template = readFileSync(
      new URL('../src/ENV_PROMPT.md', import.meta.url),
      'utf8',
    );
    const used = [...template.matchAll(/\{\{\s*([\w.]+)\s*(\|[^}]*)?\}\}/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(Object.hasOwn(vars, name)).toBe(true);
    }
    // 每个占位符都配了缺省文案，空值不会留下残句。
    for (const match of template.matchAll(/\{\{\s*([\w.]+)\s*(\|[^}]*)?\}\}/g)) {
      expect(match[2], `${match[1]} 缺少 | 缺省文案`).toBeTruthy();
    }
  });
});

describe('出站工具', () => {
  it('未绑定时发文本给出可执行的提示，而不是抛原始错误', async () => {
    const world = new WechatClawWorld({
      cfg: { ...WECHAT_CLAW_DEFAULTS },
      dataDir: scratchDir,
      timezone: 'Asia/Shanghai',
    });
    const send = world.tools().find((tool) => tool.name === 'wechat_send')!;
    await expect(send.handler({ text: 'hi' }, call)).rejects.toThrow(/未连接|扫码/);
  });

  it('超长文本自动分段发送，不整条丢掉', async () => {
    const srv = await startFakeServer();
    server = srv;
    const world = makeWorld({ cfg: { ...WECHAT_CLAW_DEFAULTS }, dataDir: scratchDir, server: srv });
    const authDir = join(scratchDir, 'wechat-claw');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({
      token: 'bot-token-123', baseUrl: srv.baseUrl, accountId: 'bot-account@im.bot',
      userId: 'wx-user@im.wechat', savedAt: new Date().toISOString(),
    }));
    writeFileSync(join(authDir, 'context-tokens.json'), JSON.stringify({ 'wx-user@im.wechat': 'ctx-1' }));
    const host = new FakeHost();
    await world.start(host);
    await waitFor(() => world.envPromptVars()['wechat.state'] === '已连接', 5000);

    const send = world.tools().find((tool) => tool.name === 'wechat_send')!;
    // 9000 字，需要切成三段。
    const long = '这是一句话。'.repeat(1500);
    const receipt = await send.handler({ text: long }, call);
    expect(String(receipt)).toContain('分 3 条');

    const textMessages = srv.sent
      .map((msg) => (msg.item_list as Array<{ type?: number; text_item?: { text?: string } }>)[0])
      .filter((item) => item?.type === 1);
    expect(textMessages.length).toBe(3);
    for (const item of textMessages) {
      expect(String(item.text_item?.text ?? '').length).toBeLessThanOrEqual(4000);
    }
    // 三段拼回去就是原文。
    expect(textMessages.map((item) => item.text_item?.text).join('')).toBe(long);
    await world.stop();
  });
});

describe('入站消息', () => {
  /** 起一个已绑定的 World，并把一条消息推进队列，等它落到事件里。 */
  async function receive(
    message: Record<string, unknown>,
    opts: { cfg?: Partial<WechatClawConfigSection>; acceptImages?: boolean } = {},
  ): Promise<{ world: WechatClawWorld; host: FakeHost; server: FakeServer }> {
    const srv = await startFakeServer();
    server = srv;
    const cfg: WechatClawConfigSection = { ...WECHAT_CLAW_DEFAULTS, ...opts.cfg };
    const world = makeWorld({ cfg, dataDir: scratchDir, server: srv });

    // 先绑定：直接把凭据写进数据目录，省掉扫码交互。
    const authDir = join(scratchDir, 'wechat-claw');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({
      token: 'bot-token-123',
      baseUrl: srv.baseUrl,
      accountId: 'bot-account@im.bot',
      userId: 'wx-user@im.wechat',
      savedAt: new Date().toISOString(),
    }));
    writeFileSync(join(authDir, 'context-tokens.json'), JSON.stringify({ 'wx-user@im.wechat': 'ctx-1' }));

    const host = new FakeHost();
    host.acceptImages = opts.acceptImages ?? true;
    await world.start(host);

    srv.queue.push({ ...message, context_token: 'ctx-2' });
    // 等轮询把这条消息处理完。
    await waitFor(() => host.events.some((event) => event.type === EVENT_MESSAGE), 5000);
    return { world, host, server: srv };
  }

  it('文本消息渲染成带发送者与时间的正文，并带 meta.raw 且不含 context_token', async () => {
    const { world, host } = await receive({
      from_user_id: 'wx-user@im.wechat',
      message_type: 1,
      create_time_ms: Date.parse('2026-10-27T04:00:00.000Z'),
      item_list: [{ type: 1, text_item: { text: '今天下雨' } }],
    });
    const event = host.events.find((e) => e.type === EVENT_MESSAGE)!;
    expect(event.text).toContain('今天下雨');
    expect(event.text).toContain('wx-user');
    expect(event.origin).toBe('external');
    expect(event.source).toBe('wechat-claw');
    const raw = JSON.stringify(event.meta?.raw ?? {});
    expect(raw).not.toContain('ctx-2');
    expect(event.meta?.kind).toBe('message/private');
    await world.stop();
  });

  it('入站图片落盘、正文写路径，模型支持图片时作为附件到达', async () => {
    const srv = await startFakeServer();
    server = srv;
    const key = randomBytes(16);
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fake image payload'),
    ]);
    srv.uploads.set('img-1', { ciphertext: encryptForTest(pngBytes, key), key });

    const world = makeWorld({ cfg: { ...WECHAT_CLAW_DEFAULTS }, dataDir: scratchDir, server: srv });
    const authDir = join(scratchDir, 'wechat-claw');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({
      token: 'bot-token-123', baseUrl: srv.baseUrl, accountId: 'bot-account@im.bot',
      userId: 'wx-user@im.wechat', savedAt: new Date().toISOString(),
    }));
    writeFileSync(join(authDir, 'context-tokens.json'), JSON.stringify({ 'wx-user@im.wechat': 'ctx-1' }));

    const host = new FakeHost();
    await world.start(host);
    srv.queue.push({
      from_user_id: 'wx-user@im.wechat',
      message_type: 1,
      context_token: 'ctx-2',
      item_list: [{
        type: 2,
        image_item: {
          media: { encrypt_query_param: 'download-param-img-1', aes_key: Buffer.from(key.toString('hex'), 'utf8').toString('base64') },
          mid_size: pngBytes.length,
        },
      }],
    });
    await waitFor(() => host.events.some((e) => e.type === EVENT_MESSAGE), 5000);

    const event = host.events.find((e) => e.type === EVENT_MESSAGE)!;
    expect(event.text).toContain('[图片');
    // 正文里给出了本地路径，且文件真的存在。
    const pathMatch = event.text.match(/已存为 ([^\]]+?)\]/);
    expect(pathMatch).toBeTruthy();
    expect(existsSync(pathMatch![1])).toBe(true);
    expect(readFileSync(pathMatch![1]).equals(pngBytes)).toBe(true);
    // 附件随事件到达，MIME 是图片。
    const blobs = (event as unknown as { blobs?: Array<{ mime: string }> }).blobs ?? [];
    expect(blobs.some((blob) => blob.mime.startsWith('image/'))).toBe(true);
    await world.stop();
  });

  it('入站文件落盘并写进正文，正文带原文件名与大小', async () => {
    const srv = await startFakeServer();
    server = srv;
    const key = randomBytes(16);
    const pdfBytes = Buffer.from('%PDF-1.4 fake', 'utf8');
    srv.uploads.set('file-1', { ciphertext: encryptForTest(pdfBytes, key), key });

    const world = makeWorld({ cfg: { ...WECHAT_CLAW_DEFAULTS }, dataDir: scratchDir, server: srv });
    const authDir = join(scratchDir, 'wechat-claw');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({
      token: 'bot-token-123', baseUrl: srv.baseUrl, accountId: 'bot-account@im.bot',
      userId: 'wx-user@im.wechat', savedAt: new Date().toISOString(),
    }));
    writeFileSync(join(authDir, 'context-tokens.json'), JSON.stringify({ 'wx-user@im.wechat': 'ctx-1' }));

    const host = new FakeHost();
    await world.start(host);
    srv.queue.push({
      from_user_id: 'wx-user@im.wechat',
      message_type: 1,
      context_token: 'ctx-2',
      item_list: [{
        type: 4,
        file_item: {
          media: { encrypt_query_param: 'download-param-file-1', aes_key: Buffer.from(key.toString('hex'), 'utf8').toString('base64') },
          file_name: '报告.pdf',
          len: String(pdfBytes.length),
        },
      }],
    });
    await waitFor(() => host.events.some((e) => e.type === EVENT_MESSAGE), 5000);

    const event = host.events.find((e) => e.type === EVENT_MESSAGE)!;
    expect(event.text).toContain('报告.pdf');
    const pathMatch = event.text.match(/已存为 ([^\]]+?)\]/);
    expect(pathMatch).toBeTruthy();
    expect(readFileSync(pathMatch![1]).equals(pdfBytes)).toBe(true);
    await world.stop();
  });

  it('启用 World 不会联网下载 ffmpeg，只有面板按钮才会', async () => {
    const srv = await startFakeServer();
    server = srv;
    const world = makeWorld({
      cfg: { ...WECHAT_CLAW_DEFAULTS, ffmpegSource: 'auto' },
      dataDir: scratchDir,
      server: srv,
    });
    const host = new FakeHost();
    await world.start(host);
    // 给解析留出时间，确认它不会去下 ffmpeg。
    await new Promise((resolve) => setTimeout(resolve, 300));

    const binDir = join(scratchDir, 'wechat-claw', 'bin');
    // 启动阶段不该建 bin 目录，更不该有 ffmpeg。
    expect(existsSync(join(binDir, 'ffmpeg.exe'))).toBe(false);

    // 面板状态能读到：没装、不可用、也没在装。
    const invoke = world.webUi('zh').invoke!;
    const state = await invoke('ffmpeg', 'state', []) as Record<string, unknown>;
    expect(state.installed).toBe(false);
    expect(state.installing).toBe(false);
    expect(state.ready).toBe(false);
    await world.stop();
  });

  it('ffmpeg 面板声明在 webUi 里，且能取消没有进行中的下载', async () => {
    const srv = await startFakeServer();
    server = srv;
    const world = makeWorld({ cfg: { ...WECHAT_CLAW_DEFAULTS }, dataDir: scratchDir, server: srv });
    const decl = world.webUi('zh');
    expect(decl.panels?.map((p) => p.id).sort()).toEqual(['binding', 'ffmpeg']);
    const ffmpegPanel = decl.panels!.find((p) => p.id === 'ffmpeg')!;
    expect(ffmpegPanel.getMethods).toContain('state');

    const host = new FakeHost();
    await world.start(host);
    const invoke = world.webUi('zh').invoke!;
    const result = await invoke('ffmpeg', 'cancel', []) as Record<string, unknown>;
    expect(result.cancelled).toBe(false);
    await world.stop();
  });
  it('没有 ffmpeg 时，视频消息写明未抽帧而不是假装看过', async () => {
    const srv = await startFakeServer();
    server = srv;
    const key = randomBytes(16);
    const videoBytes = Buffer.from('fake mp4 payload', 'utf8');
    srv.uploads.set('vid-1', { ciphertext: encryptForTest(videoBytes, key), key });

    // 收视频打开，但 ffmpegSource=off，确保拿不到 ffmpeg。
    const world = makeWorld({
      cfg: { ...WECHAT_CLAW_DEFAULTS, receiveVideos: true, ffmpegSource: 'off' },
      dataDir: scratchDir,
      server: srv,
    });
    const authDir = join(scratchDir, 'wechat-claw');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({
      token: 'bot-token-123', baseUrl: srv.baseUrl, accountId: 'bot-account@im.bot',
      userId: 'wx-user@im.wechat', savedAt: new Date().toISOString(),
    }));
    writeFileSync(join(authDir, 'context-tokens.json'), JSON.stringify({ 'wx-user@im.wechat': 'ctx-1' }));

    const host = new FakeHost();
    await world.start(host);
    srv.queue.push({
      from_user_id: 'wx-user@im.wechat',
      message_type: 1,
      context_token: 'ctx-2',
      item_list: [{
        type: 5,
        video_item: {
          media: { encrypt_query_param: 'download-param-vid-1', aes_key: Buffer.from(key.toString('hex'), 'utf8').toString('base64') },
          video_size: videoBytes.length,
        },
      }],
    });
    await waitFor(() => host.events.some((e) => e.type === EVENT_MESSAGE), 5000);

    const event = host.events.find((e) => e.type === EVENT_MESSAGE)!;
    // 视频本身落盘了。
    const pathMatch = event.text.match(/已存为 ([^\]]+?)\]/);
    expect(pathMatch).toBeTruthy();
    expect(readFileSync(pathMatch![1]).equals(videoBytes)).toBe(true);
    // 但明确说了没抽帧，不假装看过。
    expect(event.text).toContain('视频帧未');
    await world.stop();
  });
  it('关掉收图时不下载，只留占位', async () => {
    const { world, host } = await receive(
      {
        from_user_id: 'wx-user@im.wechat',
        message_type: 1,
        item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'x' } } }],
      },
      { cfg: { receiveImages: false } },
    );
    const event = host.events.find((e) => e.type === EVENT_MESSAGE)!;
    expect(event.text).toContain('未下载');
    await world.stop();
  });

  it('语音带服务端转写时正文直接给文字', async () => {
    const { world, host } = await receive({
      from_user_id: 'wx-user@im.wechat',
      message_type: 1,
      item_list: [{ type: 3, voice_item: { text: '明天见', playtime: 2000, encode_type: 6 } }],
    });
    const event = host.events.find((e) => e.type === EVENT_MESSAGE)!;
    expect(event.text).toContain('明天见');
    expect(event.meta?.transcript).toBe('明天见');
    await world.stop();
  });

  it('自己发出的消息（message_type 2）不会回到自己这里', async () => {
    const srv = await startFakeServer();
    server = srv;
    const world = makeWorld({ cfg: { ...WECHAT_CLAW_DEFAULTS }, dataDir: scratchDir, server: srv });
    const authDir = join(scratchDir, 'wechat-claw');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({
      token: 'bot-token-123', baseUrl: srv.baseUrl, accountId: 'bot-account@im.bot',
      userId: 'wx-user@im.wechat', savedAt: new Date().toISOString(),
    }));
    const host = new FakeHost();
    await world.start(host);
    srv.queue.push({
      from_user_id: 'wx-user@im.wechat',
      message_type: 2,
      item_list: [{ type: 1, text_item: { text: '自己发的' } }],
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(host.events.filter((e) => e.type === EVENT_MESSAGE)).toHaveLength(0);
    await world.stop();
  });
});

describe('状态与事件查询', () => {
  it('wechat_status 报绑定与连接状态', async () => {
    const srv = await startFakeServer();
    server = srv;
    const world = makeWorld({ cfg: { ...WECHAT_CLAW_DEFAULTS }, dataDir: scratchDir, server: srv });
    const authDir = join(scratchDir, 'wechat-claw');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({
      token: 'bot-token-123', baseUrl: srv.baseUrl, accountId: 'bot-account@im.bot',
      userId: 'wx-user@im.wechat', savedAt: new Date().toISOString(),
    }));
    writeFileSync(join(authDir, 'context-tokens.json'), JSON.stringify({ 'wx-user@im.wechat': 'ctx-1' }));
    const host = new FakeHost();
    await world.start(host);
    // 等长轮询真的连上：envPromptVars 报「已连接」说明第一轮 getupdates 已经成功。
    await waitFor(() => world.envPromptVars()['wechat.state'] === '已连接', 5000);

    const statusTool = world.tools().find((tool) => tool.name === 'wechat_status')!;
    const result = JSON.parse(String(await statusTool.handler({}, call))) as Record<string, unknown>;
    expect(result.bound).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.accountId).toBe('bot-account@im.bot');
    expect(result.contextTokens).toBe(1);
    await world.stop();
  });
});

/** 轮询等待一个条件成立。 */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待超时');
}
