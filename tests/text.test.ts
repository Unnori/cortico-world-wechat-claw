/**
 * 长文本分段与出站通道选择。
 *
 * 这两件事决定「微信里能不能收到」：文本超 4000 字服务端不收，通道选错就显示成下载附件。
 */
import { describe, expect, it } from 'vitest';

import { pickChannel, splitText } from '../src/text.ts';
import { MAX_TEXT_CHARS } from '../src/protocol/api.ts';

describe('splitText', () => {
  it('不超限时原样返回一段', () => {
    expect(splitText('你好', 4000)).toEqual(['你好']);
    expect(splitText('', 4000)).toEqual(['']);
  });

  it('每段都不超过上限，拼回去内容不丢', () => {
    const text = '这是一句话。'.repeat(1000); // 6000 字
    const parts = splitText(text, MAX_TEXT_CHARS);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(parts.join('')).toBe(text);
  });

  it('优先在段落处断开', () => {
    const first = 'a'.repeat(2000);
    const second = 'b'.repeat(2000);
    const third = 'c'.repeat(2000);
    const parts = splitText(`${first}\n${second}\n${third}`, MAX_TEXT_CHARS);
    // 第一段应当在第一个换行处结束，而不是硬切到 4000。
    expect(parts[0]).toBe(first);
    expect(parts[1]).toBe(second);
    expect(parts[2]).toBe(third);
  });

  it('没有段落时按句末标点断开，不把句子拦腰截断', () => {
    const sentence = `${'字'.repeat(90)}。`;
    const text = sentence.repeat(100); // 9100 字
    const parts = splitText(text, MAX_TEXT_CHARS);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
      expect(part.endsWith('。')).toBe(true);
    }
  });

  it('既没有段落也没有标点时硬切，但不切坏代理对', () => {
    // 每个 emoji 是两个 UTF-16 码元。
    const text = '🐟'.repeat(3000); // 6000 码元
    const parts = splitText(text, 4000);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4000);
      // 切开后每段首尾都不该是孤立代理位。
      const first = part.charCodeAt(0);
      const last = part.charCodeAt(part.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(parts.join('')).toBe(text);
  });

  it('上限很小时也能正确分段', () => {
    const parts = splitText('abcdef', 2);
    expect(parts).toEqual(['ab', 'cd', 'ef']);
  });
});

describe('pickChannel', () => {
  it('图片走图片通道', () => {
    expect(pickChannel('image/png')).toBe('image');
    expect(pickChannel('image/jpeg')).toBe('image');
  });

  it('视频走视频通道', () => {
    expect(pickChannel('video/mp4')).toBe('video');
    expect(pickChannel('video/quicktime')).toBe('video');
  });

  it('其余都走文件通道', () => {
    expect(pickChannel('application/pdf')).toBe('file');
    expect(pickChannel('application/octet-stream')).toBe('file');
    expect(pickChannel('audio/mpeg')).toBe('file');
    expect(pickChannel('')).toBe('file');
  });

  it('带 charset 的 MIME 也能认', () => {
    expect(pickChannel('image/png; charset=binary')).toBe('image');
    expect(pickChannel('VIDEO/MP4')).toBe('video');
  });
});
