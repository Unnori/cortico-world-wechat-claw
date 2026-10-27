/**
 * 本机假 iLink 服务端。
 *
 * 用真的 HTTP 端口跑，不是 mock：客户端走的是它真实的请求构造、鉴权头、长轮询与
 * CDN 上传下载路径，所以测试断言的是线上形状。
 *
 * 覆盖的端点：get_bot_qrcode、get_qrcode_status、getupdates、sendmessage、
 * getuploadurl、getconfig、sendtyping、notifystop/notifystart，以及 CDN 的
 * upload / download。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface FakeMessage {
  message_id?: string;
  from_user_id?: string;
  message_type?: number;
  create_time_ms?: number;
  context_token?: string;
  item_list?: unknown[];
}

export interface FakeServerOptions {
  /** 收消息时一次给多少批；给空数组就一直返回空批次。 */
  batches?: FakeMessage[][];
  /** 二维码状态序列；默认直接 confirmed。 */
  qrStatuses?: string[];
}

/** 假服务端跑起来后的句柄。 */
export interface FakeServer {
  baseUrl: string;
  cdnBaseUrl: string;
  requests: RecordedRequest[];
  /** 收到的 sendmessage 消息体。 */
  sent: Array<Record<string, unknown>>;
  /** 预先塞进上传表：filekey → 密文，供下载端点解密。 */
  uploads: Map<string, { ciphertext: Buffer; key: Buffer }>;
  /** 让下一批 getupdates 返回这些消息。 */
  queue: FakeMessage[];
  /** 下一次 sendmessage 的响应码，用来测错误路径。 */
  nextSendRet: number | null;
  /** 下一次 getupdates 返回的业务错误。 */
  nextUpdatesError: { ret?: number; errcode?: number; errmsg?: string } | null;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const sendJson = (res: ServerResponse, value: unknown, status = 200): void => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

export async function startFakeServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const uploads = new Map<string, { ciphertext: Buffer; key: Buffer }>();
  const queue: FakeMessage[] = [];
  const qrStatuses = [...(opts.qrStatuses ?? ['confirmed'])];
  let batchIndex = 0;
  let syncBuf = '';
  let uploadKey: Buffer | null = null;

  const state: FakeServer = {
    baseUrl: '',
    cdnBaseUrl: '',
    requests,
    sent,
    uploads,
    queue,
    nextSendRet: null,
    nextUpdatesError: null,
    close: async () => {},
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rawBody = await readBody(req);
    const body = rawBody.toString('utf8');
    requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body });

    // ---- CDN ----
    if (url.pathname === '/cdn/upload') {
      // 客户端拼的地址是 /upload?encrypted_query_param=...&filekey=...，filekey 在查询串里。
      const filekey = url.searchParams.get('filekey') ?? 'no-filekey';
      const key = uploadKey ?? randomBytes(16);
      uploads.set(filekey, { ciphertext: rawBody, key });
      res.writeHead(200, { 'x-encrypted-param': `download-param-${filekey}` });
      res.end();
      return;
    }
    if (url.pathname === '/cdn/download') {
      const param = url.searchParams.get('encrypted_query_param') ?? '';
      const filekey = param.replace(/^download-param-/, '');
      const entry = uploads.get(filekey);
      if (!entry) {
        sendJson(res, { error: 'not found' }, 404);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(entry.ciphertext);
      return;
    }

    // ---- iLink ----
    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      sendJson(res, { qrcode: 'qr-token', qrcode_img_content: 'https://example.test/scan/qr-token' });
      return;
    }
    if (url.pathname === '/ilink/bot/get_qrcode_status') {
      const status = qrStatuses.length > 1 ? qrStatuses.shift()! : qrStatuses[0];
      if (status === 'confirmed') {
        sendJson(res, {
          status,
          bot_token: 'bot-token-123',
          ilink_bot_id: 'bot-account@im.bot',
          ilink_user_id: 'wx-user@im.wechat',
          baseurl: state.baseUrl,
        });
        return;
      }
      sendJson(res, { status });
      return;
    }
    if (url.pathname === '/ilink/bot/getupdates') {
      if (state.nextUpdatesError) {
        const error = state.nextUpdatesError;
        state.nextUpdatesError = null;
        sendJson(res, { ...error, msgs: [], get_updates_buf: syncBuf });
        return;
      }
      const fromQueue = queue.splice(0, queue.length);
      const fromBatches = opts.batches?.[batchIndex] ?? [];
      batchIndex += 1;
      const msgs = [...fromQueue, ...fromBatches];
      syncBuf = `buf-${batchIndex}`;
      sendJson(res, { ret: 0, msgs, get_updates_buf: syncBuf, longpolling_timeout_ms: 5000 });
      return;
    }
    if (url.pathname === '/ilink/bot/sendmessage') {
      if (state.nextSendRet !== null) {
        const ret = state.nextSendRet;
        state.nextSendRet = null;
        sendJson(res, { ret, errmsg: 'send refused' });
        return;
      }
      const parsed = JSON.parse(body) as { msg?: Record<string, unknown> };
      sent.push(parsed.msg ?? {});
      sendJson(res, { ret: 0, message_id: '9007199254740993' });
      return;
    }
    if (url.pathname === '/ilink/bot/getuploadurl') {
      const parsed = JSON.parse(body) as { aeskey?: string; filekey?: string };
      uploadKey = Buffer.from(String(parsed.aeskey ?? ''), 'hex');
      sendJson(res, {
        upload_full_url: `${state.cdnBaseUrl}/upload?filekey=${encodeURIComponent(String(parsed.filekey ?? ''))}`,
        upload_param: 'upload-param',
      });
      return;
    }
    if (url.pathname === '/ilink/bot/getconfig') {
      sendJson(res, { ret: 0, typing_ticket: 'typing-ticket' });
      return;
    }
    if (url.pathname === '/ilink/bot/sendtyping' || url.pathname.startsWith('/ilink/bot/msg/notify')) {
      sendJson(res, { ret: 0 });
      return;
    }
    sendJson(res, { error: `unhandled ${url.pathname}` }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  state.cdnBaseUrl = `http://127.0.0.1:${address.port}/cdn`;
  state.close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

/** 与客户端同一套算法加密，用于构造「入站媒体」。 */
export function encryptForTest(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptForTest(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
