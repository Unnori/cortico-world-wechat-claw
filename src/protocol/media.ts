/**
 * CDN 媒体传输：上传（加密）与下载（解密）。
 *
 * 上传三步：申请上传参数 → AES-128-ECB 加密后 POST 密文 → 从响应头 `x-encrypted-param`
 * 取下载参数。下载相反：GET 密文 → 用密钥解出明文。
 *
 * 成功判定与重试对齐官方实现：上传要 HTTP 200 且 `x-encrypted-param` 非空；
 * 4xx 立即放弃，其他失败重试到 3 次。下载不做重试——失败会如实回给模型。
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  aesEcbPaddedSize,
  buildCdnDownloadUrl,
  buildCdnUploadUrl,
  decryptAesEcb,
  encryptAesEcb,
  parseAesKey,
} from './crypto.ts';
import type { ILinkApi } from './api.ts';
import type { CompatFetch, FetchInit } from './fetch.ts';
import { UploadMediaType } from './types.ts';

/** 单条入站媒体的上限，与官方一致。 */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const UPLOAD_ATTEMPTS = 3;

export interface UploadedMedia {
  filekey: string;
  /** 填进 `CDNMedia.encrypt_query_param`。 */
  downloadQueryParam: string;
  /** 16 字节密钥的十六进制字符串；发送时再 base64。 */
  aesKeyHex: string;
  /** 明文字节数。 */
  rawSize: number;
  /** 密文字节数。 */
  cipherSize: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class MediaTransfer {
  readonly #api: ILinkApi;
  readonly #cdnBaseUrl: string;
  readonly #fetchImpl: CompatFetch;
  readonly #dispatcher?: unknown;

  constructor(opts: {
    api: ILinkApi;
    cdnBaseUrl: string;
    fetchImpl: CompatFetch;
    dispatcher?: unknown;
  }) {
    this.#api = opts.api;
    this.#cdnBaseUrl = opts.cdnBaseUrl.replace(/\/+$/, '');
    this.#fetchImpl = opts.fetchImpl;
    this.#dispatcher = opts.dispatcher;
  }

  /** 上传一份明文，返回发消息需要的三个值。 */
  async upload(params: {
    bytes: Uint8Array;
    toUserId: string;
    mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
  }): Promise<UploadedMedia> {
    const plaintext = Buffer.from(params.bytes);
    const rawSize = plaintext.length;
    const cipherSize = aesEcbPaddedSize(rawSize);
    const filekey = randomBytes(16).toString('hex');
    const aesKey = randomBytes(16);
    const aesKeyHex = aesKey.toString('hex');

    const uploadInfo = await this.#api.getUploadUrl({
      filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: rawSize,
      rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
      filesize: cipherSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
    });

    const fullUrl = String(uploadInfo?.upload_full_url ?? '').trim();
    const uploadParam = String(uploadInfo?.upload_param ?? '').trim();
    if (!fullUrl && !uploadParam) {
      throw new Error('服务端没有给上传地址（upload_full_url 与 upload_param 都为空）');
    }
    const url = fullUrl || buildCdnUploadUrl({ cdnBaseUrl: this.#cdnBaseUrl, uploadParam, filekey });

    const ciphertext = encryptAesEcb(plaintext, aesKey);
    const downloadQueryParam = await this.#postCiphertext(url, ciphertext);

    return { filekey, downloadQueryParam, aesKeyHex, rawSize, cipherSize };
  }

  async #postCiphertext(url: string, ciphertext: Buffer): Promise<string> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        const init: FetchInit = {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
        };
        if (this.#dispatcher) init.dispatcher = this.#dispatcher;
        const response = await this.#fetchImpl(url, init);

        if (response.status >= 400 && response.status < 500) {
          const detail = response.headers.get('x-error-message') ?? (await response.text());
          throw new Error(`CDN 拒收（HTTP ${response.status}）：${String(detail).slice(0, 200)}`);
        }
        if (response.status !== 200) {
          const detail = response.headers.get('x-error-message') ?? `HTTP ${response.status}`;
          throw new Error(`CDN 上传失败：${detail}`);
        }
        const downloadParam = response.headers.get('x-encrypted-param');
        if (!downloadParam) throw new Error('CDN 响应缺少 x-encrypted-param');
        return downloadParam;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        // 4xx 是请求本身不对，重试没有意义。
        if (/CDN 拒收/.test(message)) throw err;
        if (attempt < UPLOAD_ATTEMPTS) await sleep(attempt * 500);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('CDN 上传失败');
  }

  /**
   * 下载一份媒体并解密。
   * `aesKeyBase64` 为空时按明文下载（服务端偶尔给未加密的图）。
   */
  async download(params: {
    encryptedQueryParam?: string;
    fullUrl?: string;
    aesKeyBase64?: string;
    /** 入站图片另有明文十六进制密钥，优先于 media.aes_key。 */
    aesKeyHex?: string;
    maxBytes?: number;
  }): Promise<{ bytes: Buffer; decrypted: boolean }> {
    const fullUrl = String(params.fullUrl ?? '').trim();
    const queryParam = String(params.encryptedQueryParam ?? '').trim();
    if (!fullUrl && !queryParam) throw new Error('媒体引用里没有下载参数');
    const url = fullUrl || buildCdnDownloadUrl(queryParam, this.#cdnBaseUrl);

    const init: FetchInit = { method: 'GET' };
    if (this.#dispatcher) init.dispatcher = this.#dispatcher;
    const response = await this.#fetchImpl(url, init);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`CDN 下载失败（HTTP ${response.status}）${body ? `：${body.slice(0, 120)}` : ''}`);
    }
    const limit = params.maxBytes ?? MEDIA_MAX_BYTES;
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > limit) throw new Error(`媒体超过上限（${declared} > ${limit} 字节）`);

    const ciphertext = Buffer.from(await response.arrayBuffer());
    if (ciphertext.length > limit) throw new Error(`媒体超过上限（${ciphertext.length} > ${limit} 字节）`);

    const keyHex = String(params.aesKeyHex ?? '').trim();
    const keyBase64 = String(params.aesKeyBase64 ?? '').trim();
    if (!keyHex && !keyBase64) return { bytes: ciphertext, decrypted: false };

    const key = keyHex ? Buffer.from(keyHex, 'hex') : parseAesKey(keyBase64);
    if (key.length !== 16) throw new Error(`AES 密钥长度不对：${key.length} 字节`);
    return { bytes: decryptAesEcb(ciphertext, key), decrypted: true };
  }
}
