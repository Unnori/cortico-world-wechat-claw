import { silkV3HeaderLength } from '../protocol/mime.ts';

const SAMPLE_RATE = 24_000;
const WAV_HEADER_BYTES = 44;
const SILK_PACKET_MAX_BYTES = 250 * 5;
const PCM_BYTES_PER_20_MS = SAMPLE_RATE * 2 / 50;
const SILK_TENCENT_PREFIX = Buffer.from([0x02]);
const SILK_END = Buffer.from([0xff, 0xff]);

/** 封装交错排列的有符号 16-bit 小端 PCM。 */
export function pcm16ToWav(pcmData: Uint8Array, sampleRate: number, channels: number): Buffer {
  const blockAlign = channels * 2;
  if (!pcmData.byteLength || pcmData.byteLength % blockAlign !== 0) {
    throw new Error('PCM 音频为空或采样不完整。');
  }
  const wav = Buffer.alloc(WAV_HEADER_BYTES + pcmData.byteLength);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * blockAlign, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcmData.byteLength, 40);
  wav.set(pcmData, WAV_HEADER_BYTES);
  return wav;
}

export async function silkToWav(silk: Buffer, maxBytes: number): Promise<Buffer> {
  const headerLength = silkV3HeaderLength(silk);
  if (!headerLength) throw new Error('缺少 SILK v3 文件头。');

  // silk-wasm 在 WASM 中按包长度读取并预读两个包。先检查边界，再为它补齐终止标记。
  let end = headerLength;
  let packets = 0;
  while (end + 2 <= silk.length) {
    const size = silk.readUInt16LE(end);
    if (size === 0xffff && end + 2 === silk.length) break;
    if (!size || size > SILK_PACKET_MAX_BYTES || end + 2 + size > silk.length) {
      throw new Error('SILK 数据包长度无效。');
    }
    end += 2 + size;
    packets += 1;
    if (WAV_HEADER_BYTES + packets * PCM_BYTES_PER_20_MS > maxBytes) {
      throw new Error('WAV 超过单条媒体上限。');
    }
  }
  if (!packets || (end !== silk.length && end !== silk.length - 2)) {
    throw new Error('SILK 音频为空或数据包不完整。');
  }

  const parts = [silk.subarray(0, end)];
  if (silk[0] !== 0x02) parts.unshift(SILK_TENCENT_PREFIX);
  // 极短语音只有一个包时补一个相同的包供预读，解码后去掉其 PCM。
  if (packets === 1) parts.push(silk.subarray(headerLength, end));
  parts.push(SILK_END);
  const { decode } = await import('silk-wasm');
  const { data } = await decode(Buffer.concat(parts), SAMPLE_RATE);
  if (packets === 1 && data.byteLength % 4 !== 0) throw new Error('SILK 解码得到不完整的采样。');
  const pcm = packets === 1 ? data.subarray(0, data.byteLength / 2) : data;
  if (WAV_HEADER_BYTES + pcm.byteLength > maxBytes) throw new Error('WAV 超过单条媒体上限。');
  return pcm16ToWav(pcm, SAMPLE_RATE, 1);
}
