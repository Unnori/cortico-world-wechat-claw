import { describe, expect, it } from 'vitest';
import { decode, getWavFileInfo } from 'silk-wasm';
import { pcm16ToWav, silkToWav } from '../src/media/voice.ts';
import { silkVoiceFixture } from './helpers/voice-fixture.ts';

describe('微信语音 WAV 封装', () => {
  it('在原 PCM 前写入标准 RIFF、fmt 和 data 长度', () => {
    const pcm = Buffer.from([0, 0x80, 0xff, 0x7f]);
    const wav = pcm16ToWav(pcm, 24_000, 1);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(getWavFileInfo(wav).fmt).toEqual({
      formatCode: 1, numberOfChannels: 1, sampleRate: 24_000,
      bytesPerSec: 48_000, bytesPerFrame: 2, bitsPerSample: 16,
    });
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it('两种 SILK 文件头解码得到同样的 PCM，单包语音保留原采样数', async () => {
    const tencent = await silkVoiceFixture();
    expect(tencent.subarray(0, 10)).toEqual(Buffer.from('\x02#!SILK_V3'));
    const end = Buffer.from([0xff, 0xff]);
    const standard = Buffer.concat([tencent.subarray(1), end]);
    const { data } = await decode(Buffer.concat([tencent, end]), 24_000);
    const maxBytes = 1024 * 1024;
    const tencentWav = await silkToWav(tencent, maxBytes);
    expect(tencentWav.subarray(44).equals(Buffer.from(data))).toBe(true);
    expect(Buffer.from(data).some(byte => byte !== 0)).toBe(true);
    expect((await silkToWav(standard, maxBytes)).equals(tencentWav)).toBe(true);
    const short = await silkToWav(await silkVoiceFixture(1), maxBytes);
    expect(short.readUInt32LE(40)).toBe(960);
  });

  it('限制 PCM 解压后的体积，并拒绝不完整的 SILK 包', async () => {
    const tencent = await silkVoiceFixture();
    await expect(silkToWav(tencent, 1000)).rejects.toThrow('WAV 超过单条媒体上限');
    await expect(silkToWav(tencent.subarray(0, -1), 1024 * 1024)).rejects.toThrow('SILK 数据包长度无效');
  });
});
