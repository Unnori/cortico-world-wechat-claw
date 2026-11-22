import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { Agent, fetch } from 'undici';
import { ttsSpeechUrl } from './tts.ts';
import type { TtsCatalog } from './tts-catalog.ts';

const SOVITS_MODEL = 'gpt-sovits';
const DEFAULT_PORTS = [9880, 9883];
const MAX_PEERS = 508;
const MODEL_LIMIT = 32 * 1024;

export interface LocalTtsService {
  baseUrl: string;
  model: string;
}

function isPrivateIpv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second! >= 16 && second! <= 31) || (first === 192 && second === 168);
}

export function ttsProbeOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = ttsSpeechUrl(value.trim(), 'gpt-sovits');
    return isPrivateIpv4(url.hostname) || url.hostname === '[::1]' || url.hostname === '127.0.0.1' ? url.origin : null;
  } catch {
    return null;
  }
}

function ipv4Number(ip: string): number {
  return ip.split('.').reduce((number, byte) => number * 256 + Number(byte), 0);
}

export function lanTtsPeers(interfaces: ReturnType<typeof networkInterfaces>): string[] {
  const peers = new Set<string>();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== 'IPv4' || !isPrivateIpv4(address.address)) continue;
      const prefix = Math.max(24, Number(address.cidr?.split('/')[1] ?? 24));
      if (prefix >= 31) continue;
      const size = 2 ** (32 - prefix);
      const own = ipv4Number(address.address);
      const start = Math.floor(own / size) * size;
      for (let i = start + 1; i < start + size - 1; i++) {
        const ip = [24, 16, 8, 0].map(shift => (i >>> shift) & 255).join('.');
        if (isPrivateIpv4(ip)) peers.add(ip);
        if (peers.size >= MAX_PEERS) return [...peers];
      }
    }
  }
  return [...peers];
}

async function checkModel(origin: string, token: string, dispatcher: Agent, signal: AbortSignal): Promise<LocalTtsService> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(new URL('/v1/models', origin), { headers, dispatcher, redirect: 'error', signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`本地语音接口返回 HTTP ${response.status}。`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MODEL_LIMIT) throw new Error('本地语音接口的模型列表过大。');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  const rows = (value as { data?: unknown } | null)?.data;
  const supported = Array.isArray(rows) && rows.some(row => row?.id === SOVITS_MODEL && row.owned_by === 'coopanion');
  if (!supported) throw new Error('未识别到大肥鱼 GPT-SoVITS 语音接口。');
  return { baseUrl: origin, model: SOVITS_MODEL };
}

export async function discoverLocalTts(draft: unknown, interfaces = networkInterfaces()): Promise<LocalTtsService[]> {
  const seed = new Set(['127.0.0.1', '[::1]'].flatMap(host => DEFAULT_PORTS.map(port => `http://${host}:${port}`)));
  const entered = ttsProbeOrigin(draft);
  if (entered) seed.add(entered);
  const origins = [...new Set([...seed, ...lanTtsPeers(interfaces).flatMap(ip => DEFAULT_PORTS.map(port => `http://${ip}:${port}`))])];
  const dispatcher = new Agent({ pipelining: 0 });
  const deadline = AbortSignal.timeout(8_000);
  const found: Array<LocalTtsService | undefined> = [];
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(48, origins.length) }, async () => {
      while (!deadline.aborted && next < origins.length) {
        const index = next++;
        const origin = origins[index]!;
        const signal = AbortSignal.any([deadline, AbortSignal.timeout(seed.has(origin) ? 1_500 : 300)]);
        found[index] = await checkModel(origin, '', dispatcher, signal).catch(() => undefined);
      }
    }));
    return found.filter((item): item is LocalTtsService => item !== undefined);
  } finally {
    await dispatcher.destroy().catch(() => {});
  }
}

export async function listLocalTtsModels(baseUrl: string, token: string): Promise<TtsCatalog> {
  const { origin } = ttsSpeechUrl(baseUrl, 'gpt-sovits');
  const dispatcher = new Agent({ pipelining: 0 });
  try {
    const result = await checkModel(origin, token, dispatcher, AbortSignal.timeout(4_000));
    return { choices: [{ value: result.model, label: 'GPT-SoVITS' }] };
  } finally {
    await dispatcher.destroy().catch(() => {});
  }
}

export function localTtsVoices(): TtsCatalog {
  return {
    choices: [
      { value: 'xll', label: '星落落', source: 'preset' },
      { value: 'dfy', label: '大肥鱼', source: 'preset' },
      { value: 'female', label: 'female', source: 'preset' },
      { value: 'male', label: 'male', source: 'preset' },
    ],
    note: '留空跟随服务当前音色，自定义音色可手动输入名称或 ID。',
  };
}
