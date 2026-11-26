import { randomBytes } from 'node:crypto';
import { WECHAT_OPUS_MAGIC } from '../protocol/mime.ts';

const HEADER = Buffer.from(WECHAT_OPUS_MAGIC + '\x02\x01\x00', 'ascii');
const SAMPLES_PER_PACKET = 960;
const MAX_PACKET_BYTES = 1276;
const MAX_PACKETS_PER_PAGE = 50;

// Ogg uses the unreflected CRC-32 polynomial, with a zero initial value.
const CRC = Array.from({ length: 256 }, (_, byte) => {
  let value = byte << 24;
  for (let bit = 0; bit < 8; bit += 1) value = (value << 1) ^ (value < 0 ? 0x04c11db7 : 0);
  return value;
});

/** Wrap WeChat's observed 16 kHz, mono, 20 ms Opus packets without re-encoding. */
export function wechatOpusToOgg(raw: Buffer, maxBytes: number): Buffer {
  if (!raw.subarray(0, HEADER.length).equals(HEADER) || raw.length <= HEADER.length) {
    throw new Error('不支持的微信 Opus 文件头或空语音。');
  }

  const serial = randomBytes(4).readUInt32LE();
  const pages: Buffer[] = [];
  let totalBytes = 0;
  const appendPage = (packets: Buffer[], flags: number, granule: number) => {
    const lacing: number[] = [];
    let payloadBytes = 0;
    for (const packet of packets) {
      lacing.push(...Array<number>(Math.floor(packet.length / 255)).fill(255), packet.length % 255);
      payloadBytes += packet.length;
    }
    const pageBytes = 27 + lacing.length + payloadBytes;
    if (totalBytes + pageBytes > maxBytes) throw new Error('Ogg Opus 超过单条媒体上限。');
    const header = Buffer.alloc(27 + lacing.length);
    header.write('OggS');
    header[5] = flags;
    header.writeBigUInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(pages.length, 18);
    header[26] = lacing.length;
    header.set(lacing, 27);
    const page = Buffer.concat([header, ...packets], pageBytes);
    let crc = 0;
    for (const byte of page) crc = (crc << 8) ^ CRC[(crc >>> 24) ^ byte]!;
    page.writeUInt32LE(crc >>> 0, 22);
    pages.push(page);
    totalBytes += pageBytes;
  };

  const head = Buffer.alloc(19);
  head.write('OpusHead');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt32LE(16_000, 12);
  appendPage([head], 2, 0);
  const vendor = Buffer.from('wechat-claw');
  const tags = Buffer.alloc(16 + vendor.length);
  tags.write('OpusTags');
  tags.writeUInt32LE(vendor.length, 8);
  tags.set(vendor, 12);
  appendPage([tags], 0, 0);

  let offset = HEADER.length;
  let granule = 0;
  const packets: Buffer[] = [];
  let segments = 0;
  while (offset < raw.length) {
    const size = offset + 2 <= raw.length ? raw.readUInt16LE(offset) : 0;
    offset += 2;
    if (!size || size > MAX_PACKET_BYTES || offset + size > raw.length) {
      throw new Error('微信 Opus 数据包长度无效。');
    }
    const toc = raw[offset]!;
    const config = toc >> 3;
    // RFC 6716: only one mono frame of 20 ms in the verified WeChat container.
    const is20ms = config < 12 ? config % 4 === 1 : config < 16 ? config % 2 === 1 : config % 4 === 3;
    if ((toc & 7) !== 0 || !is20ms) throw new Error('不支持的微信 Opus 数据包格式。');
    const packetSegments = Math.floor(size / 255) + 1;
    if (packets.length === MAX_PACKETS_PER_PAGE || segments + packetSegments > 255) {
      appendPage(packets, 0, granule);
      packets.length = 0;
      segments = 0;
    }
    packets.push(raw.subarray(offset, offset + size));
    segments += packetSegments;
    granule += SAMPLES_PER_PACKET;
    offset += size;
  }
  appendPage(packets, 4, granule);
  return Buffer.concat(pages, totalBytes);
}
