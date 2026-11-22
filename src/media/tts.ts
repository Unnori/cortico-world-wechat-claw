import { createHash } from 'node:crypto';
import { Agent, fetch as directFetch } from 'undici';
import { TTS_SPEED_MAX, TTS_SPEED_MIN, type TtsProtocol, type TtsSettings } from '../config.ts';
import { audioToMp3, isMp3 } from './outbound-voice.ts';

export const TTS_KEY = 'WECHAT_CLAW_TTS_API_KEY';
export const TTS_MAX_CHARS = 4096;

export function ttsSpeechUrl(baseUrl: string, protocol: TtsProtocol = 'openai'): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('TTS 服务地址无效。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('TTS 服务地址须为不带凭据和查询参数的 HTTP(S) URL。');
  }
  if (protocol === 'gpt-sovits' && url.hostname === 'localhost') url.hostname = '127.0.0.1';
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  url.pathname = path.endsWith('/audio/speech') ? path
    : path + (protocol === 'openai' && !path.endsWith('/v1') ? '/v1' : '') + '/audio/speech';
  return url;
}

export function ttsSecretName(protocol: TtsProtocol, baseUrl: string): string {
  if (protocol === 'openai') return TTS_KEY;
  const { origin } = ttsSpeechUrl(baseUrl, protocol);
  const suffix = createHash('sha256').update(origin).digest('hex').slice(0, 24).toUpperCase();
  return 'WECHAT_CLAW_TTS_LOCAL_' + suffix;
}

export function validateTtsSettings(input: unknown): TtsSettings {
  if (!input || typeof input !== 'object') throw new Error('TTS 设置无效。');
  const { ttsEnabled, ttsBaseUrl, ttsModel, ttsVoice, ttsSpeed } = input as Partial<TtsSettings>;
  const { ttsProtocol = 'openai' } = input as Partial<TtsSettings>;
  if (typeof ttsEnabled !== 'boolean' || typeof ttsBaseUrl !== 'string' ||
      typeof ttsModel !== 'string' || typeof ttsVoice !== 'string' ||
      (ttsProtocol !== 'openai' && ttsProtocol !== 'gpt-sovits')) {
    throw new Error('TTS 设置无效。');
  }
  const baseUrl = ttsBaseUrl.trim();
  const model = ttsModel.trim();
  const voice = ttsVoice.trim();
  if (ttsEnabled && !baseUrl) throw new Error('启用 TTS 前请填写服务地址。');
  if (ttsEnabled && ttsProtocol === 'openai' && (!model || !voice)) throw new Error('启用 TTS 前请填写模型和声音。');
  if (baseUrl) ttsSpeechUrl(baseUrl, ttsProtocol);
  if (typeof ttsSpeed !== 'number' || !(ttsSpeed >= TTS_SPEED_MIN && ttsSpeed <= TTS_SPEED_MAX)) {
    throw new Error('TTS 语速须在 0.25 到 4 之间。');
  }
  return { ttsEnabled, ttsProtocol, ttsBaseUrl: baseUrl, ttsModel: model, ttsVoice: voice, ttsSpeed };
}

export async function synthesizeMp3(
  text: string,
  cfg: TtsSettings,
  apiKey: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const baseUrl = String(cfg.ttsBaseUrl ?? '').trim();
  const model = String(cfg.ttsModel ?? '').trim();
  const voice = String(cfg.ttsVoice ?? '').trim();
  const speed = Number(cfg.ttsSpeed);
  const local = cfg.ttsProtocol === 'gpt-sovits';
  if (!baseUrl || (!local && (!model || !voice))) throw new Error('请先完成 TTS 配置。');
  if (!(speed >= TTS_SPEED_MIN && speed <= TTS_SPEED_MAX)) throw new Error('TTS 语速须在 0.25 到 4 之间。');
  const url = ttsSpeechUrl(baseUrl, cfg.ttsProtocol);
  const timeout = AbortSignal.timeout(local ? 125_000 : 60_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const dispatcher = local ? new Agent({ pipelining: 0 }) : undefined;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: local ? 'audio/wav' : 'audio/mpeg' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const request = {
      method: 'POST' as const,
      headers,
      body: JSON.stringify({ model: model || undefined, voice: voice || undefined, speed, input: text,
        response_format: local ? undefined : 'mp3' }),
      redirect: 'error' as const,
      signal: requestSignal,
    };
    const response = dispatcher ? await directFetch(url, { ...request, dispatcher }) : await fetch(url, request);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new TtsError('TTS 服务未返回音频（HTTP ' + response.status + '）。');
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      if (Number(response.headers.get('content-length')) > maxBytes) size = maxBytes + 1;
      while (size <= maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (size > maxBytes) throw new TtsError('TTS 音频超过单条媒体大小上限。');
    const audio = Buffer.concat(parts, size);
    if (local) {
      try { return await audioToMp3(audio, maxBytes, requestSignal); }
      catch (error) {
        if (requestSignal.aborted) throw error;
        throw new TtsError(error instanceof Error ? error.message : '本机语音接口返回的 WAV 无法转换。');
      }
    }
    const mp3 = audio;
    if (!isMp3(mp3)) throw new TtsError('TTS 服务返回的内容不是有效的 MP3。');
    return mp3;
  } catch (error) {
    if (error instanceof TtsError) throw error;
    if (signal?.aborted) throw new Error('TTS 请求已取消。');
    if (timeout.aborted) throw new Error('TTS 请求超时。');
    throw new Error('TTS 请求失败，请检查服务地址、网络和密钥配置。');
  } finally {
    await dispatcher?.destroy().catch(() => {});
  }
}

class TtsError extends Error {}
