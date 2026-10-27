/**
 * CDN 媒体的加解密与 URL 拼装。
 *
 * 微信 CDN 只存密文：上传前用 AES-128-ECB（PKCS#7）加密，下载后同样解密。
 * 密钥两种编码都在线上出现过，`parseAesKey` 都认：
 * - base64(16 字节原始密钥)
 * - base64(32 位十六进制字符串)
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** PKCS#7 填充后的密文长度。 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * 把 `CDNMedia.aes_key` 解析成 16 字节原始密钥。
 * 认两种编码；其他长度一律报错，避免用错密钥解出垃圾数据。
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString('ascii');
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex');
  throw new Error(`aes_key 长度不对：解出 ${decoded.length} 字节，既不是 16 字节原始密钥，也不是 32 位十六进制`);
}

/** 出站密钥统一按「十六进制字符串再 base64」编码，与官方发送端一致。 */
export function encodeAesKeyHex(aesKeyHex: string): string {
  return Buffer.from(aesKeyHex, 'utf8').toString('base64');
}

/** 下载地址：优先 `full_url`，否则按 `encrypted_query_param` 拼。 */
export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** 上传地址：优先 `upload_full_url`，否则按 `upload_param` + `filekey` 拼。 */
export function buildCdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  filekey: string;
}): string {
  const base = params.cdnBaseUrl.replace(/\/+$/, '');
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}
