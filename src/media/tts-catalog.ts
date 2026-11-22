import { ttsSpeechUrl } from './tts.ts';

export interface TtsChoice {
  value: string;
  label: string;
  source?: 'preset' | 'custom';
}

export interface TtsCatalog {
  choices: TtsChoice[];
  note?: string;
}

const SILICONFLOW_HOSTS = new Set(['api.siliconflow.cn', 'api.siliconflow.com', 'api.ap.siliconflow.com']);
// /models?type=audio includes ASR. Only intersect with models documented for /audio/speech.
const SILICONFLOW_TTS_MODELS = new Set(['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5']);
const SILICONFLOW_PRESETS = ['alex', 'benjamin', 'charles', 'david', 'anna', 'bella', 'claire', 'diana'];

function siliconFlowUrl(baseUrl: unknown): URL {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new Error('请先填写 TTS 服务地址。');
  const url = ttsSpeechUrl(baseUrl.trim());
  // Catalog requests may use the saved key from an unfinished form. Only send it to the known HTTPS API.
  if (url.protocol !== 'https:' || url.port || !SILICONFLOW_HOSTS.has(url.hostname) || url.pathname !== '/v1/audio/speech') {
    throw new Error('此服务暂无可用的 TTS 列表查询，请手动填写。');
  }
  return url;
}

async function catalogRows(url: URL, key: string, kind: 'models' | 'voices'): Promise<unknown[]> {
  const endpoint = new URL(kind === 'models' ? '/v1/models?type=audio' : '/v1/audio/voice/list', url);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('TTS 列表请求失败，请检查网络后重试。');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) {
      throw new Error(`TTS 列表鉴权失败（HTTP ${response.status}），请检查已保存的 API Key。`);
    }
    throw new Error(`TTS 列表请求失败（HTTP ${response.status}）。`);
  }
  const payload = await response.json().catch(() => null) as { data?: unknown; results?: unknown; result?: unknown } | null;
  const rows = kind === 'models' ? payload?.data : payload?.results ?? payload?.result;
  if (!Array.isArray(rows)) throw new Error('TTS 服务未返回可识别的列表。');
  return rows;
}

export async function listTtsModels(baseUrl: unknown, key: string): Promise<TtsCatalog> {
  const url = siliconFlowUrl(baseUrl);
  if (!key) throw new Error('请先保存硅基流动 API Key，再获取模型。');
  const rows = await catalogRows(url, key, 'models');
  const ids = new Set<string>();
  for (const row of rows) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && SILICONFLOW_TTS_MODELS.has(id)) ids.add(id);
  }
  return { choices: [...ids].map(id => ({ value: id, label: id })) };
}

export async function listTtsVoices(baseUrl: unknown, modelValue: unknown, key: string): Promise<TtsCatalog> {
  const url = siliconFlowUrl(baseUrl);
  if (typeof modelValue !== 'string' || !modelValue.trim()) throw new Error('请先选择或填写 TTS 模型。');
  const model = modelValue.trim();
  const choices: TtsChoice[] = SILICONFLOW_TTS_MODELS.has(model)
    ? SILICONFLOW_PRESETS.map(id => ({ value: model + ':' + id, label: id, source: 'preset' }))
    : [];
  if (!key) return { choices, note: '保存 API Key 后可查询账号自定义音色。' };

  try {
    const rows = await catalogRows(url, key, 'voices');
    const seen = new Set(choices.map(choice => choice.value));
    for (const raw of rows) {
      const row = raw as { model?: unknown; uri?: unknown; customName?: unknown } | null;
      if (row?.model !== model || typeof row.uri !== 'string' || !row.uri.trim() || seen.has(row.uri)) continue;
      seen.add(row.uri);
      choices.push({
        value: row.uri,
        label: typeof row.customName === 'string' && row.customName.trim() ? row.customName : row.uri,
        source: 'custom',
      });
    }
    return { choices };
  } catch (error) {
    if (!choices.length) throw error;
    return { choices, note: '自定义音色未能获取。' + (error instanceof Error ? error.message : '') };
  }
}
