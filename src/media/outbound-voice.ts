import { setImmediate } from 'node:timers/promises';
import { silkV3HeaderLength } from '../protocol/mime.ts';
import { SILK_SAMPLE_RATE, silkToWav } from './voice.ts';

const MPG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPG1_RATES = [44_100, 48_000, 32_000];
const WAVE_SUBFORMAT_SUFFIX = Buffer.from('000000001000800000aa00389b71', 'hex');

export function isMp3(bytes: Buffer): boolean {
  let start = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    const tagSize = bytes.subarray(6, 10);
    if (tagSize.length !== 4 || tagSize.some(byte => byte > 127)) return false;
    start = 10 + tagSize.reduce((size, byte) => size * 128 + byte, 0);
    if (bytes[3] === 4 && (bytes[5]! & 0x10)) start += 10;
  }
  if (start + 4 > bytes.length || bytes[start] !== 0xff) return false;
  const header = bytes[start + 1]!;
  const version = (header >> 3) & 3;
  if ((header & 0xe6) !== 0xe2 || version === 1) return false;
  const fields = bytes[start + 2]!;
  const bitrate = (version === 3 ? MPG1_BITRATES : MPG2_BITRATES)[fields >> 4];
  const rate = MPG1_RATES[(fields >> 2) & 3];
  if (!bitrate || !rate) return false;
  const frameSize = Math.floor((version === 0 ? 288_000 : 144_000) * bitrate / rate) + ((fields >> 1) & 1);
  return start + frameSize <= bytes.length;
}

function waveform(bytes: Buffer) {
  let format: Buffer | undefined;
  let pcm: Buffer | undefined;
  const end = Math.min(bytes.length, bytes.readUInt32LE(4) + 8);
  for (let offset = 12; offset + 8 <= end;) {
    const length = bytes.readUInt32LE(offset + 4);
    const limit = offset + 8 + length;
    if (limit > end) throw new Error('WAV 数据块不完整。');
    const name = bytes.toString('ascii', offset, offset + 4);
    if (name === 'fmt ' && !format) format = bytes.subarray(offset + 8, limit);
    if (name === 'data' && !pcm) pcm = bytes.subarray(offset + 8, limit);
    offset = limit + (length & 1);
  }
  if (!format || format.length < 16 || !pcm?.length) throw new Error('WAV 缺少格式或音频数据。');
  let encoding = format.readUInt16LE(0);
  if (encoding === 0xfffe && format.length >= 40 && format.readUInt16LE(16) >= 22 &&
    format.subarray(26, 40).equals(WAVE_SUBFORMAT_SUFFIX)) {
    encoding = format.readUInt16LE(24);
  }
  const channels = format.readUInt16LE(2);
  const rate = format.readUInt32LE(4);
  const stride = format.readUInt16LE(12);
  const bits = format.readUInt16LE(14);
  const sampleBytes = bits / 8;
  if (
    (channels !== 1 && channels !== 2) || rate < 8_000 || rate > 96_000 ||
    stride !== channels * sampleBytes || pcm.length % stride ||
    !(encoding === 1 && [8, 16, 24, 32].includes(bits) || encoding === 3 && bits === 32)
  ) throw new Error('WAV 需要单声道或立体声 PCM（8/16/24/32-bit）或 32-bit 浮点音频。');

  const sample = (offset: number): number => {
    if (encoding === 3) {
      const value = pcm.readFloatLE(offset);
      return Number.isFinite(value) ? Math.round(Math.max(-1, Math.min(32767 / 32768, value)) * 32768) : 0;
    }
    if (bits === 8) return (pcm[offset]! - 128) << 8;
    return pcm.readIntLE(offset, sampleBytes) >> (bits - 16);
  };
  return { frames: pcm.length / stride, sample, channels, rate, stride, sampleBytes };
}

async function readWave(bytes: Buffer, maxBytes: number) {
  const wav = silkV3HeaderLength(bytes) ? await silkToWav(bytes, maxBytes) : bytes;
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('无法识别音频文件，支持 WAV、MP3 和 SILK v3。');
  }
  return waveform(wav);
}

async function monoPcm(
  frames: number,
  rate: number,
  sample: (index: number) => number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('音频采样率无效。');
  const step = rate / SILK_SAMPLE_RATE;
  const count = Math.max(1, Math.round(frames / step));
  if (count * 2 > maxBytes) throw new Error('语音转码后的 PCM 超过单条媒体上限。');
  const pcm = Buffer.allocUnsafe(count * 2);
  for (let i = 0; i < count; i += 1) {
    if (i && i % 65_536 === 0) await setImmediate(undefined, { signal });
    const input = Math.min(i * step, frames - 1);
    const left = Math.floor(input);
    const value = sample(left) * (1 - (input - left)) + sample(Math.min(left + 1, frames - 1)) * (input - left);
    pcm.writeInt16LE(Math.round(Math.max(-32768, Math.min(32767, value))), i * 2);
  }
  return pcm;
}

async function mp3ToMonoPcm(bytes: Buffer, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const { MPEGDecoder } = await import('mpg123-decoder');
  const decoder = new MPEGDecoder();
  await decoder.ready;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    // Decode in blocks so highly compressed audio cannot allocate an unbounded PCM buffer.
    const blockSize = 16_384;
    for (let offset = 0; offset < bytes.length; offset += blockSize) {
      if (offset) await setImmediate(undefined, { signal });
      signal?.throwIfAborted();
      const { channelData, samplesDecoded, sampleRate } = decoder.decode(bytes.subarray(offset, offset + blockSize));
      if (!samplesDecoded || !channelData[0]) continue;
      const [left, right] = channelData;
      const pcm = await monoPcm(samplesDecoded, sampleRate, (index) => {
        const value = right ? (left[index]! + right[index]!) / 2 : left[index]!;
        return Number.isFinite(value) ? value * 32768 : 0;
      }, maxBytes - size, signal);
      chunks.push(pcm);
      size += pcm.length;
    }
  } finally {
    decoder.free();
  }
  if (size === 0) throw new Error('MP3 解码未得到音频采样。');
  return Buffer.concat(chunks, size);
}

export async function audioToSilk(bytes: Buffer, maxBytes: number, signal?: AbortSignal): Promise<{
  bytes: Buffer;
  durationMs: number;
}> {
  if (bytes.length > maxBytes) throw new Error('音频文件超过单条媒体大小上限。');
  let pcm: Buffer;
  if (isMp3(bytes)) {
    pcm = await mp3ToMonoPcm(bytes, maxBytes, signal);
  } else {
    const { frames, sample, channels, rate, stride, sampleBytes } = await readWave(bytes, maxBytes);
    pcm = await monoPcm(frames, rate, (index) => {
      const offset = index * stride;
      return channels === 2 ? (sample(offset) + sample(offset + sampleBytes)) / 2 : sample(offset);
    }, maxBytes, signal);
  }
  // silk-wasm encodes 20 ms packets. Keep the last partial packet by padding silence.
  const frameBytes = SILK_SAMPLE_RATE * 2 / 50;
  const padding = (frameBytes - pcm.length % frameBytes) % frameBytes;
  if (padding) pcm = Buffer.concat([pcm, Buffer.alloc(padding)]);
  const { encode } = await import('silk-wasm');
  signal?.throwIfAborted();
  const { data, duration } = await encode(pcm, SILK_SAMPLE_RATE);
  const silk = Buffer.from(data);
  if (silkV3HeaderLength(silk) !== 10 || duration <= 0) throw new Error('音频编码未生成有效的腾讯 SILK v3。');
  if (silk.length > maxBytes) throw new Error('SILK 语音超过单条媒体大小上限。');
  return { bytes: silk, durationMs: duration };
}

export async function audioToMp3(bytes: Buffer, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (bytes.length > maxBytes) throw new Error('音频文件超过单条媒体大小上限。');
  if (isMp3(bytes)) return bytes;
  const { frames, sample, channels, rate, stride, sampleBytes } = await readWave(bytes, maxBytes);
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  signal?.throwIfAborted();
  const encoder = new Mp3Encoder(channels, rate, 64 * channels);
  const blockFrames = 1152;
  const left = new Int16Array(blockFrames);
  const right = new Int16Array(blockFrames);
  const encoded: Buffer[] = [];
  let size = 0;
  const add = (block: Uint8Array): void => {
    size += block.length;
    if (size > maxBytes) throw new Error('转码后的 MP3 超过单条媒体大小上限。');
    if (block.length) encoded.push(Buffer.from(block));
  };
  for (let offset = 0; offset < frames; offset += blockFrames) {
    if (offset && offset % (64 * blockFrames) === 0) {
      await setImmediate(undefined, { signal });
    }
    const count = Math.min(blockFrames, frames - offset);
    for (let i = 0; i < count; i += 1) {
      const index = (offset + i) * stride;
      left[i] = sample(index);
      if (channels === 2) right[i] = sample(index + sampleBytes);
    }
    add(encoder.encodeBuffer(left.subarray(0, count), channels === 2 ? right.subarray(0, count) : undefined));
  }
  add(encoder.flush());
  const mp3 = Buffer.concat(encoded, size);
  if (!isMp3(mp3)) throw new Error('音频编码未生成有效的 MP3。');
  return mp3;
}
