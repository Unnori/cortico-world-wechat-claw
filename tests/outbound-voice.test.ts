import { describe, expect, it } from 'vitest';
import { audioToMp3, audioToSilk, isMp3 } from '../src/media/outbound-voice.ts';
import { pcm16ToWav, silkToWav } from '../src/media/voice.ts';
import { silkVoiceFixture } from './helpers/voice-fixture.ts';

describe('出站音频编码', () => {
  it('将不同采样率的立体声 WAV、MP3 和 SILK 转为 24 kHz 单声道腾讯 SILK，保留尾帧', async () => {
    const limit = 1024 * 1024;
    const stereo = pcm16ToWav(Buffer.alloc(4411 * 4), 44_100, 2);
    const mp3 = await audioToMp3(stereo, limit);
    for (const original of [stereo, mp3, await silkVoiceFixture()]) {
      const { bytes, durationMs } = await audioToSilk(original, limit);
      expect(bytes.subarray(0, 10)).toEqual(Buffer.from('\x02#!SILK_V3'));
      const wav = await silkToWav(bytes, limit);
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(24_000);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.readUInt32LE(40) / 48).toBe(durationMs);
    }
    expect((await audioToSilk(stereo, limit)).durationMs).toBe(120);
    expect((await audioToSilk(pcm16ToWav(Buffer.alloc(962), 24_000, 1), limit)).durationMs).toBe(40);
  });

  it.each([1, 2])('WAV %i 声道转成有效 MP3，现成 MP3 原样使用', async (channels) => {
    const wav = pcm16ToWav(Buffer.alloc(2400 * channels * 2), 24_000, channels);
    const mp3 = await audioToMp3(wav, 1024 * 1024);
    expect(isMp3(mp3)).toBe(true);
    expect(await audioToMp3(mp3, mp3.length)).toBe(mp3);
    const tagged = Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 3, 11, 12, 13]), mp3]);
    expect(isMp3(tagged)).toBe(true);
  });

  it('SILK v3 复用入站解码器并确实转为 MP3', async () => {
    const silk = await silkVoiceFixture();
    expect(isMp3(await audioToMp3(silk, 1024 * 1024))).toBe(true);
  });

  it('拒绝无音频帧的假 MP3、截断 WAV 和超限音频', async () => {
    const wav = pcm16ToWav(Buffer.alloc(4800), 24_000, 1);
    await expect(audioToMp3(Buffer.from('ID3 假音频'), 1000)).rejects.toThrow(/无法识别/);
    await expect(audioToMp3(wav.subarray(0, -1), wav.length)).rejects.toThrow(/数据块不完整/);
    await expect(audioToMp3(wav, 1000)).rejects.toThrow(/超过/);
  });
});
