/**
 * 协议层：请求形状、uint64 ID、加解密与 MIME 判定。
 * 断言的是线上形状——服务端按这些字段名与编码工作，改错一个就收发不通。
 */
import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

import { ILinkApi, parseILinkJson, ILINK_APP_ID, ILINK_APP_CLIENT_VERSION } from '../src/protocol/api.ts';
import { asCompatFetch } from '../src/protocol/fetch.ts';
import {
  aesEcbPaddedSize,
  decryptAesEcb,
  encodeAesKeyHex,
  encryptAesEcb,
  parseAesKey,
} from '../src/protocol/crypto.ts';
import { extensionFromMime, imageSize, mimeFromFilename, sniffImageMime } from '../src/protocol/mime.ts';
import { fileMessage, imageMessage, textMessage } from '../src/protocol/outbound.ts';
import { MediaTransfer } from '../src/protocol/media.ts';
import { startFakeServer } from './helpers/fake-server.ts';

const makeApi = (baseUrl: string, token = 'bot-token-123'): ILinkApi =>
  new ILinkApi({
    baseUrl,
    token,
    // 哨兵值：证明请求带的就是配置进来的那个版本，不是别处抄来的常量。
    channelVersion: '9.9.9-test',
    botAgent: 'Cortico/6 (test)',
    // 二维码登录默认走官方固定地址；测试指到本机假服务端。
    loginBaseUrl: baseUrl,
  });

describe('parseILinkJson', () => {
  it('把 19 位消息 ID 保留成字符串，不丢精度', () => {
    const parsed = parseILinkJson<{ message_id: string }>('{"message_id":9007199254740993}');
    expect(parsed.message_id).toBe('9007199254740993');
    expect(typeof parsed.message_id).toBe('string');
  });

  it('字符串值里出现同样字样时不动它', () => {
    const parsed = parseILinkJson<{ text: string; msg_id: string }>(
      '{"text":"message_id:123","msg_id":1234567890123456789}',
    );
    expect(parsed.text).toBe('message_id:123');
    expect(parsed.msg_id).toBe('1234567890123456789');
  });

  it('嵌套对象里的 ID 一样处理', () => {
    const parsed = parseILinkJson<{ msgs: Array<{ item_list: Array<{ msg_id: string }> }> }>(
      '{"msgs":[{"item_list":[{"msg_id":42}]}]}',
    );
    expect(parsed.msgs[0].item_list[0].msg_id).toBe('42');
  });
});

describe('CDN 加密', () => {
  it('PKCS#7 填充后的长度按 16 字节向上取整', () => {
    expect(aesEcbPaddedSize(0)).toBe(16);
    expect(aesEcbPaddedSize(15)).toBe(16);
    expect(aesEcbPaddedSize(16)).toBe(32);
    expect(aesEcbPaddedSize(1000)).toBe(1008);
  });

  it('加密再解密回到原文', () => {
    const key = randomBytes(16);
    const plaintext = Buffer.from('微信 ClawBot 图片内容', 'utf8');
    const ciphertext = encryptAesEcb(plaintext, key);
    expect(ciphertext.length).toBe(aesEcbPaddedSize(plaintext.length));
    expect(decryptAesEcb(ciphertext, key).equals(plaintext)).toBe(true);
  });

  it('两种 aes_key 编码都认：16 字节原始密钥与 32 位十六进制', () => {
    const key = randomBytes(16);
    const rawBase64 = key.toString('base64');
    expect(parseAesKey(rawBase64).equals(key)).toBe(true);

    const hexBase64 = Buffer.from(key.toString('hex'), 'utf8').toString('base64');
    expect(parseAesKey(hexBase64).equals(key)).toBe(true);
  });

  it('长度不对时报错，不用错密钥解出垃圾', () => {
    expect(() => parseAesKey(Buffer.from('short').toString('base64'))).toThrow(/aes_key/);
  });

  it('出站密钥按「十六进制字符串再 base64」编码', () => {
    const key = randomBytes(16);
    const encoded = encodeAesKeyHex(key.toString('hex'));
    expect(Buffer.from(encoded, 'base64').toString('ascii')).toBe(key.toString('hex'));
  });
});

describe('MIME 判定', () => {
  it('扩展名决定图片走图片通道，其余走文件通道', () => {
    expect(mimeFromFilename('a.PNG')).toBe('image/png');
    expect(mimeFromFilename('a.jpg')).toBe('image/jpeg');
    expect(mimeFromFilename('a.pdf')).toBe('application/pdf');
    expect(mimeFromFilename('a.unknown')).toBe('application/octet-stream');
  });

  it('没有扩展名时按魔数认图片', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('plain'))).toBe('');
  });

  it('MIME 反向取扩展名', () => {
    expect(extensionFromMime('image/png')).toBe('.png');
    expect(extensionFromMime('image/png; charset=x')).toBe('.png');
    expect(extensionFromMime('application/x-nope')).toBe('.bin');
  });
});

describe('出站消息构造', () => {
  it('文本项带 context_token，message_type 是 BOT，state 是 FINISH', () => {
    const msg = textMessage({ to: 'wx-user', text: '你好', contextToken: 'ctx-1' });
    expect(msg.to_user_id).toBe('wx-user');
    expect(msg.message_type).toBe(2);
    expect(msg.message_state).toBe(2);
    expect(msg.context_token).toBe('ctx-1');
    expect(msg.item_list?.[0]).toEqual({ type: 1, text_item: { text: '你好' } });
  });

  it('图片项把密文长度写进 mid_size，密钥用十六进制 base64', () => {
    const key = randomBytes(16);
    const msg = imageMessage({
      to: 'wx-user',
      uploaded: {
        filekey: 'k', downloadQueryParam: 'p', aesKeyHex: key.toString('hex'), rawSize: 10, cipherSize: 16,
      },
    });
    const item = msg.item_list?.[0];
    expect(item?.type).toBe(2);
    expect(item?.image_item?.mid_size).toBe(16);
    expect(Buffer.from(String(item?.image_item?.media?.aes_key), 'base64').toString('ascii'))
      .toBe(key.toString('hex'));
  });

  it('文件项的 len 是明文字节数的十进制字符串', () => {
    const msg = fileMessage({
      to: 'wx-user',
      fileName: '报告.pdf',
      uploaded: {
        filekey: 'k', downloadQueryParam: 'p', aesKeyHex: '00'.repeat(16), rawSize: 2048, cipherSize: 2064,
      },
    });
    const item = msg.item_list?.[0];
    expect(item?.type).toBe(4);
    expect(item?.file_item?.file_name).toBe('报告.pdf');
    expect(item?.file_item?.len).toBe('2048');
  });
});

describe('ILinkApi 对真端口的请求', () => {
  it('取二维码走 POST 且不带鉴权头', async () => {
    const server = await startFakeServer();
    try {
      const api = makeApi(server.baseUrl);
      const qr = await api.fetchQrCode([]);
      expect(qr.qrcode).toBe('qr-token');
      const request = server.requests.find((r) => r.path === '/ilink/bot/get_bot_qrcode');
      expect(request?.method).toBe('POST');
      expect(request?.headers['authorization']).toBeUndefined();
      expect(request?.headers['ilink-app-id']).toBe(ILINK_APP_ID);
      expect(request?.headers['ilink-app-clientversion']).toBe(String(ILINK_APP_CLIENT_VERSION));
    } finally {
      await server.close();
    }
  });

  it('发消息带 Bearer 令牌、base_info 与 X-WECHAT-UIN', async () => {
    const server = await startFakeServer();
    try {
      const api = makeApi(server.baseUrl);
      const response = await api.sendMessage(textMessage({ to: 'wx-user', text: 'hi' }));
      expect(response.message_id).toBe('9007199254740993');
      const request = server.requests.find((r) => r.path === '/ilink/bot/sendmessage');
      expect(request?.headers.authorization).toBe('Bearer bot-token-123');
      expect(request?.headers.authorizationtype).toBe('ilink_bot_token');
      expect(typeof request?.headers['x-wechat-uin']).toBe('string');
      const body = JSON.parse(request?.body ?? '{}') as { base_info?: { channel_version?: string } };
      expect(body.base_info?.channel_version).toBe('9.9.9-test');
    } finally {
      await server.close();
    }
  });

  it('sendmessage 返回非零 ret 时抛出，回执带 ret', async () => {
    const server = await startFakeServer();
    try {
      const api = makeApi(server.baseUrl);
      server.nextSendRet = -3;
      await expect(api.sendMessage(textMessage({ to: 'wx-user', text: 'hi' })))
        .rejects.toThrow(/ret=-3/);
    } finally {
      await server.close();
    }
  });

  it('长轮询返回消息与游标', async () => {
    const server = await startFakeServer({
      batches: [[{ from_user_id: 'wx-user', message_type: 1, item_list: [{ type: 1, text_item: { text: '在吗' } }] }]],
    });
    try {
      const api = makeApi(server.baseUrl);
      const response = await api.getUpdates({ syncBuf: '' });
      expect(response.msgs).toHaveLength(1);
      expect(response.get_updates_buf).toBe('buf-1');
      expect(response.longpolling_timeout_ms).toBe(5000);
    } finally {
      await server.close();
    }
  });
});

describe('MediaTransfer 上传与下载', () => {
  it('上传后能把密文按同一把密钥解回明文', async () => {
    const server = await startFakeServer();
    try {
      const api = makeApi(server.baseUrl);
      const media = new MediaTransfer({
        api,
        cdnBaseUrl: server.cdnBaseUrl,
        fetchImpl: asCompatFetch(globalThis.fetch),
      });
      const plaintext = Buffer.from('fake png bytes', 'utf8');
      const uploaded = await media.upload({
        bytes: plaintext,
        toUserId: 'wx-user',
        mediaType: 1,
      });

      expect(uploaded.rawSize).toBe(plaintext.length);
      expect(uploaded.cipherSize).toBe(aesEcbPaddedSize(plaintext.length));

      // 申请上传参数时报的是明文 MD5 与填充后大小。
      const uploadRequest = server.requests.find((r) => r.path === '/ilink/bot/getuploadurl');
      const uploadBody = JSON.parse(uploadRequest?.body ?? '{}') as Record<string, unknown>;
      expect(uploadBody.rawfilemd5).toBe(createHash('md5').update(plaintext).digest('hex'));
      expect(uploadBody.filesize).toBe(aesEcbPaddedSize(plaintext.length));
      expect(uploadBody.no_need_thumb).toBe(true);

      // 存进 CDN 的是密文，用同一把密钥能解回原文。
      const stored = server.uploads.get(uploaded.filekey);
      expect(stored).toBeDefined();
      expect(decryptAesEcb(stored!.ciphertext, stored!.key).equals(plaintext)).toBe(true);
      expect(stored!.ciphertext.equals(plaintext)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('下载按 query 参数取密文并解密', async () => {
    const server = await startFakeServer();
    try {
      const key = randomBytes(16);
      const plaintext = Buffer.from('inbound image', 'utf8');
      server.uploads.set('fk-1', { ciphertext: encryptAesEcb(plaintext, key), key });

      const api = makeApi(server.baseUrl);
      const media = new MediaTransfer({ api, cdnBaseUrl: server.cdnBaseUrl, fetchImpl: asCompatFetch(globalThis.fetch) });
      const result = await media.download({
        encryptedQueryParam: 'download-param-fk-1',
        aesKeyBase64: Buffer.from(key.toString('hex'), 'utf8').toString('base64'),
      });
      expect(result.decrypted).toBe(true);
      expect(result.bytes.equals(plaintext)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('入站图片优先用明文十六进制密钥', async () => {
    const server = await startFakeServer();
    try {
      const key = randomBytes(16);
      const plaintext = Buffer.from('png-by-magic', 'utf8');
      server.uploads.set('fk-2', { ciphertext: encryptAesEcb(plaintext, key), key });
      const api = makeApi(server.baseUrl);
      const media = new MediaTransfer({ api, cdnBaseUrl: server.cdnBaseUrl, fetchImpl: asCompatFetch(globalThis.fetch) });
      const result = await media.download({
        encryptedQueryParam: 'download-param-fk-2',
        aesKeyHex: key.toString('hex'),
      });
      expect(result.bytes.equals(plaintext)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('没有密钥时按明文取回，不假装解密过', async () => {
    const server = await startFakeServer();
    try {
      const plaintext = Buffer.from('plain body', 'utf8');
      server.uploads.set('fk-3', { ciphertext: plaintext, key: randomBytes(16) });
      const api = makeApi(server.baseUrl);
      const media = new MediaTransfer({ api, cdnBaseUrl: server.cdnBaseUrl, fetchImpl: asCompatFetch(globalThis.fetch) });
      const result = await media.download({ encryptedQueryParam: 'download-param-fk-3' });
      expect(result.decrypted).toBe(false);
      expect(result.bytes.equals(plaintext)).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe('图片尺寸', () => {
  /** 拼一段只有帧头的最小 JPEG：SOI、可跳过的段、SOF、SOS。 */
  const jpeg = (opts: { width: number; height: number; marker?: number; filler?: number }): Buffer => {
    const marker = opts.marker ?? 0xc2;
    // 微信的图片在 APP1 里塞了一长段 EXIF，段内容按长度跳过，不能按字节找。
    const exif = Buffer.alloc(opts.filler ?? 0, 0x28);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x00]), exif]);
    app1.writeUInt16BE(app1.length - 2, 2);
    const sof = Buffer.alloc(2 + 2 + 6 + 3);
    sof.writeUInt8(0xff, 0);
    sof.writeUInt8(marker, 1);
    sof.writeUInt16BE(sof.length - 2, 2);
    sof.writeUInt8(8, 4);
    sof.writeUInt16BE(opts.height, 5);
    sof.writeUInt16BE(opts.width, 7);
    sof.writeUInt8(3, 9);
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x02]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, sos]);
  };

  it('JPEG 从 SOF 段读尺寸，按段长跳过前面的大段 EXIF', () => {
    expect(imageSize(jpeg({ width: 868, height: 1920 }))).toEqual({ width: 868, height: 1920 });
    expect(imageSize(jpeg({ width: 868, height: 1920, filler: 96 }))).toEqual({ width: 868, height: 1920 });
  });

  it('JPEG 的 baseline 与 progressive 帧头都认', () => {
    expect(imageSize(jpeg({ width: 640, height: 480, marker: 0xc0 }))).toEqual({ width: 640, height: 480 });
    expect(imageSize(jpeg({ width: 640, height: 480, marker: 0xc2 }))).toEqual({ width: 640, height: 480 });
  });

  it('PNG 读 IHDR', () => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(1440, 16);
    png.writeUInt32BE(1699, 20);
    expect(imageSize(png)).toEqual({ width: 1440, height: 1699 });
  });

  it('GIF 与 BMP 读各自的文件头', () => {
    const gif = Buffer.alloc(13);
    Buffer.from('GIF89a', 'ascii').copy(gif, 0);
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    expect(imageSize(gif)).toEqual({ width: 320, height: 240 });

    const bmp = Buffer.alloc(54);
    Buffer.from('BM', 'ascii').copy(bmp, 0);
    bmp.writeUInt32LE(1280, 18);
    bmp.writeUInt32LE(720, 22);
    expect(imageSize(bmp)).toEqual({ width: 1280, height: 720 });
  });

  it('WebP 的 VP8X 与 VP8 都认', () => {
    const vp8x = Buffer.alloc(30);
    Buffer.from('RIFF', 'ascii').copy(vp8x, 0);
    Buffer.from('WEBP', 'ascii').copy(vp8x, 8);
    Buffer.from('VP8X', 'ascii').copy(vp8x, 12);
    // 宽高各 24 位，存的是「减一」。
    vp8x.writeUIntLE(1279 - 1, 24, 3);
    vp8x.writeUIntLE(2275 - 1, 27, 3);
    expect(imageSize(vp8x)).toEqual({ width: 1279, height: 2275 });

    const vp8 = Buffer.alloc(30);
    Buffer.from('RIFF', 'ascii').copy(vp8, 0);
    Buffer.from('WEBP', 'ascii').copy(vp8, 8);
    Buffer.from('VP8 ', 'ascii').copy(vp8, 12);
    vp8[23] = 0x9d;
    vp8[24] = 0x01;
    vp8[25] = 0x2a;
    vp8.writeUInt16LE(800, 26);
    vp8.writeUInt16LE(600, 28);
    expect(imageSize(vp8)).toEqual({ width: 800, height: 600 });
  });

  it('认不出或数据不够时返回 null，不猜', () => {
    expect(imageSize(Buffer.from('not an image at all'))).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
  });
});
