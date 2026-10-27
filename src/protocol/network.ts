/**
 * 网络出口。
 *
 * Coopanion 启动 Core 时带 `--use-env-proxy`，把系统代理写进 `HTTP_PROXY`/`HTTPS_PROXY`，
 * 而那条代理是给模型端点用的。微信的 `ilinkai.weixin.qq.com` 走同一条代理时经常连不上，
 * 表现为 `UND_ERR_CONNECT_TIMEOUT`。这里给三种出口：
 * - `inherit`：跟随环境变量里的代理（默认，与宿主一致）；
 * - `direct`：绕过代理直连；
 * - `proxy`：用配置里的 HTTP/HTTPS 代理。
 *
 * `direct` 与 `proxy` 用 undici 自己的 dispatcher，因此配 undici 的 fetch；
 * 建不出来时退回全局 fetch 并如实报告原因，不假装已经绕过代理。
 */
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

import { asCompatFetch, type CloseableDispatcher, type CompatFetch } from './fetch.ts';

export type NetworkMode = 'inherit' | 'direct' | 'proxy';

export interface NetworkRoute {
  mode: NetworkMode;
  fetchImpl: CompatFetch;
  /** 传给 fetch 的 dispatcher；inherit 时没有。 */
  dispatcher?: CloseableDispatcher;
  /** 配置要的出口做不到时的原因；此时已降级为 inherit。 */
  problem?: string;
}

export function normalizeNetworkMode(value: unknown): NetworkMode {
  const text = String(value ?? '').trim();
  return text === 'direct' || text === 'proxy' ? text : 'inherit';
}

/**
 * 按配置建出口。`forceIpv4` 只在 direct/proxy 下有意义：系统 IPv6 路由坏掉时，
 * 微信域名会先连 IPv6 再超时。
 */
export function createNetworkRoute(opts: {
  mode: unknown;
  proxyUrl?: unknown;
  forceIpv4?: unknown;
}): NetworkRoute {
  const mode = normalizeNetworkMode(opts.mode);
  if (mode === 'inherit') return { mode, fetchImpl: asCompatFetch(globalThis.fetch) };

  const connect = opts.forceIpv4 === true ? { family: 4 as const } : undefined;

  try {
    if (mode === 'direct') {
      const dispatcher = new Agent(connect ? { connect } : {}) as unknown as CloseableDispatcher;
      return { mode, fetchImpl: asCompatFetch(undiciFetch as unknown as typeof globalThis.fetch), dispatcher };
    }
    const proxyUrl = String(opts.proxyUrl ?? '').trim();
    if (!proxyUrl) {
      return {
        mode: 'inherit',
        fetchImpl: asCompatFetch(globalThis.fetch),
        problem: 'proxy 模式没有填代理地址，已退回跟随 Coopanion 的代理',
      };
    }
    const dispatcher = new ProxyAgent({ uri: proxyUrl, ...(connect ? { connect } : {}) }) as unknown as CloseableDispatcher;
    return { mode, fetchImpl: asCompatFetch(undiciFetch as unknown as typeof globalThis.fetch), dispatcher };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      mode: 'inherit',
      fetchImpl: asCompatFetch(globalThis.fetch),
      problem: `网络出口配置无效（${detail}），已退回跟随 Coopanion 的代理`,
    };
  }
}

/** 关掉 dispatcher；没有或已经关过都不报错。 */
export async function closeNetworkRoute(route: NetworkRoute | null): Promise<void> {
  const dispatcher = route?.dispatcher;
  if (!dispatcher) return;
  try {
    await dispatcher.close();
  } catch {
    /* 关闭失败不影响卸载。 */
  }
}
