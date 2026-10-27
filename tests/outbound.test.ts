/**
 * 端到端：Coo 发一张图、发一个文件，对方能在微信里收到。
 *
 * 断言到服务端收到的消息项与 CDN 上的密文为止——这是「微信里真的能收到」的最近可验证边界。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { EventEnvelope, ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';

import { WECHAT_CLAW_DEFAULTS } from '../src/config.ts';
import { WechatClawWorld } from '../src/world.ts';
import { decryptForTest, startFakeServer, type FakeServer } from './helpers/fake-server.ts';

class QuietHost implements WorldHost {
  events: EventEnvelope[] = [];
  log = nullLogger();
  async pushEvent(event: unknown): Promise<EventEnvelope> {
    const full = { ...(event as object), cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    return full;
  }
  pushDeferred(): void {}
  store = { get: () => undefined, latestCursor: () => 0, range: () => [], around: () => [], grep: () => [] } as unknown as WorldHost['store'];
  blob = (): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = { model: () => 'test', accepts: () => true, contextWindow: () => 128000 };
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  reportUsage(): void {}
}

const call = {} as ToolCallContext;
let scratchDir = '';
let server: FakeServer | null = null;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'wechat-out-'));
});

afterEach(async () => {
  if (server) await server.close();
  server = null;
  rmSync(scratchDir, { recursive: true, force: true });
});

/** 起一个「已绑定且收到过一条消息」的 World，这样回复目标与 context_token 都在。 */
async function boundWorld(): Promise<{ world: WechatClawWorld; server: FakeServer }> {
  const srv = await startFakeServer();
  server = srv;
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

  const world = new WechatClawWorld({
    cfg: { ...WECHAT_CLAW_DEFAULTS },
    dataDir: scratchDir,
    timezone: 'Asia/Shanghai',
    endpoints: { apiBaseUrl: srv.baseUrl, cdnBaseUrl: srv.cdnBaseUrl },
  });
  const host = new QuietHost();
  await world.start(host);

  // 推一条入站消息，让 World 记住「最近发消息的人」。
  srv.queue.push({
    from_user_id: 'wx-user@im.wechat',
    message_type: 1,
    context_token: 'ctx-2',
    item_list: [{ type: 1, text_item: { text: '在吗' } }],
  });
  await waitFor(() => host.events.length > 0, 5000);
  return { world, server: srv };
}

describe('出站媒体', () => {
  it('发图片：申请上传、加密上传、再发一条图片消息', async () => {
    const { world, server: srv } = await boundWorld();
    const pngPath = join(scratchDir, '画.png');
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('picture payload for wechat'),
    ]);
    writeFileSync(pngPath, pngBytes);

    const sendImage = world.tools().find((tool) => tool.name === 'wechat_send_image')!;
    const receipt = await sendImage.handler({ path: pngPath }, call);
    expect(String(receipt)).toContain('已把图片');

    // 申请上传参数时报的是图片类型与明文大小。
    const uploadRequest = srv.requests.find((r) => r.path === '/ilink/bot/getuploadurl');
    const uploadBody = JSON.parse(uploadRequest?.body ?? '{}') as Record<string, unknown>;
    expect(uploadBody.media_type).toBe(1);
    expect(uploadBody.rawsize).toBe(pngBytes.length);
    expect(uploadBody.to_user_id).toBe('wx-user@im.wechat');

    // 发出去的是一条图片项，带 CDN 下载参数与密钥。
    const imageMsg = srv.sent.find((msg) => {
      const items = (msg.item_list ?? []) as Array<{ type?: number }>;
      return items.some((item) => item.type === 2);
    });
    expect(imageMsg).toBeDefined();
    const item = (imageMsg!.item_list as Array<Record<string, any>>)[0];
    expect(item.image_item.media.encrypt_query_param).toMatch(/^download-param-/);
    expect(item.image_item.media.aes_key).toBeTruthy();
    expect(item.image_item.mid_size).toBeGreaterThan(pngBytes.length);
    expect(imageMsg!.context_token).toBe('ctx-2');

    // CDN 上存的是密文，用消息里给的密钥能解回原图。
    const filekey = String(item.image_item.media.encrypt_query_param).replace('download-param-', '');
    const stored = srv.uploads.get(filekey);
    expect(stored).toBeDefined();
    const key = Buffer.from(String(item.image_item.media.aes_key), 'base64').toString('ascii');
    expect(decryptForTest(stored!.ciphertext, Buffer.from(key, 'hex')).equals(pngBytes)).toBe(true);

    await world.stop();
  });

  it('发文件：media_type 是文件，消息项带原文件名与明文长度', async () => {
    const { world, server: srv } = await boundWorld();
    const filePath = join(scratchDir, '报告.pdf');
    const pdfBytes = Buffer.from('%PDF-1.4 content', 'utf8');
    writeFileSync(filePath, pdfBytes);

    const sendFile = world.tools().find((tool) => tool.name === 'wechat_send_file')!;
    const receipt = await sendFile.handler({ path: filePath }, call);
    expect(String(receipt)).toContain('已把文件');
    expect(String(receipt)).toContain('报告.pdf');

    const uploadRequest = srv.requests.find((r) => r.path === '/ilink/bot/getuploadurl');
    const uploadBody = JSON.parse(uploadRequest?.body ?? '{}') as Record<string, unknown>;
    expect(uploadBody.media_type).toBe(3);

    const fileMsg = srv.sent.find((msg) => {
      const items = (msg.item_list ?? []) as Array<{ type?: number }>;
      return items.some((item) => item.type === 4);
    });
    expect(fileMsg).toBeDefined();
    const item = (fileMsg!.item_list as Array<Record<string, any>>)[0];
    expect(item.file_item.file_name).toBe('报告.pdf');
    expect(item.file_item.len).toBe(String(pdfBytes.length));

    await world.stop();
  });

  it('带说明文字时先发一条文本，再发媒体', async () => {
    const { world, server: srv } = await boundWorld();
    const pngPath = join(scratchDir, 'a.png');
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const sendImage = world.tools().find((tool) => tool.name === 'wechat_send_image')!;
    await sendImage.handler({ path: pngPath, caption: '看这张' }, call);

    const types = srv.sent.map((msg) => (msg.item_list as Array<{ type?: number }>)[0]?.type);
    expect(types).toContain(1);
    expect(types).toContain(2);
    // 文本在图片之前。
    expect(types.indexOf(1)).toBeLessThan(types.indexOf(2));

    await world.stop();
  });

  it('发视频：media_type 是视频，消息项是视频而不是文件', async () => {
    const { world, server: srv } = await boundWorld();
    const videoPath = join(scratchDir, '片段.mp4');
    writeFileSync(videoPath, Buffer.from('fake mp4 bytes', 'utf8'));

    const sendFile = world.tools().find((tool) => tool.name === 'wechat_send_file')!;
    const receipt = await sendFile.handler({ path: videoPath }, call);
    // 回执如实说发的是视频。
    expect(String(receipt)).toContain('视频');

    const uploadRequest = srv.requests.find((r) => r.path === '/ilink/bot/getuploadurl');
    const uploadBody = JSON.parse(uploadRequest?.body ?? '{}') as Record<string, unknown>;
    expect(uploadBody.media_type).toBe(2);

    const videoMsg = srv.sent.find((msg) => {
      const items = (msg.item_list ?? []) as Array<{ type?: number }>;
      return items.some((item) => item.type === 5);
    });
    expect(videoMsg).toBeDefined();
    const item = (videoMsg!.item_list as Array<Record<string, any>>)[0];
    expect(item.type).toBe(5);
    expect(item.video_item.video_size).toBeGreaterThan(0);

    await world.stop();
  });

  it('用发图片的工具发非图片时，按文件通道走并如实回执', async () => {
    const { world, server: srv } = await boundWorld();
    const txtPath = join(scratchDir, '说明.txt');
    writeFileSync(txtPath, Buffer.from('just text', 'utf8'));

    const sendImage = world.tools().find((tool) => tool.name === 'wechat_send_image')!;
    const receipt = await sendImage.handler({ path: txtPath }, call);
    expect(String(receipt)).toContain('文件');
    expect(String(receipt)).toContain('按文件类型走的是文件通道');

    const uploadRequest = srv.requests.find((r) => r.path === '/ilink/bot/getuploadurl');
    const uploadBody = JSON.parse(uploadRequest?.body ?? '{}') as Record<string, unknown>;
    expect(uploadBody.media_type).toBe(3);

    await world.stop();
  });
  it('相对路径被拒绝，并说明要绝对路径', async () => {
    const { world } = await boundWorld();
    const sendImage = world.tools().find((tool) => tool.name === 'wechat_send_image')!;
    await expect(sendImage.handler({ path: 'relative/a.png' }, call)).rejects.toThrow(/绝对路径/);
    await world.stop();
  });

  it('文件不存在时给出明确回执，不抛原始 ENOENT', async () => {
    const { world } = await boundWorld();
    const sendFile = world.tools().find((tool) => tool.name === 'wechat_send_file')!;
    await expect(sendFile.handler({ path: join(scratchDir, 'nope.pdf') }, call))
      .rejects.toThrow(/找不到文件/);
    await world.stop();
  });

  it('上限以内的二进制文件正常发送', async () => {
    const { world } = await boundWorld();
    const binPath = join(scratchDir, 'data.bin');
    writeFileSync(binPath, randomBytes(1024));
    const sendFile = world.tools().find((tool) => tool.name === 'wechat_send_file')!;
    const receipt = await sendFile.handler({ path: binPath }, call);
    expect(String(receipt)).toContain('已把文件');
    await world.stop();
  });
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待超时');
}
