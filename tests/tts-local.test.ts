import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

import { discoverLocalTts, lanTtsPeers, listLocalTtsModels, ttsProbeOrigin } from '../src/media/tts-local.ts';

const modelList = { object: 'list', data: [{ id: 'gpt-sovits', owned_by: 'coopanion' }] };

async function withService(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
  test: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an IP endpoint');
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function iface(address: string, prefix: number): NetworkInterfaceInfo {
  return { address, cidr: `${address}/${prefix}`, netmask: '', family: 'IPv4', mac: '', internal: false };
}

describe('GPT-SoVITS service discovery', () => {
  it('bounds probes to local addresses and the private IPv4 segments', () => {
    expect(ttsProbeOrigin('http://localhost:9880/audio/speech')).toBe('http://127.0.0.1:9880');
    expect(ttsProbeOrigin('http://[::1]:9880')).toBe('http://[::1]:9880');
    expect(ttsProbeOrigin('http://192.168.20.30:9000')).toBe('http://192.168.20.30:9000');
    expect(ttsProbeOrigin('https://example.test:9880')).toBeNull();
    expect(ttsProbeOrigin('http://10.0.0.1:9880?token=secret')).toBeNull();
    const peers = lanTtsPeers({ wifi: [iface('192.168.20.5', 29)], public: [iface('203.0.113.5', 29)] });
    expect(peers).toEqual([1, 2, 3, 4, 5, 6].map(last => `192.168.20.${last}`));
    expect(lanTtsPeers({ wifi: [iface('10.2.17.5', 16)], second: [iface('10.2.18.3', 16), iface('10.2.19.4', 16)] })).toHaveLength(508);
  });

  it('recognizes the public models response through an anonymous read on a custom port', async () => {
    const requests: Array<[string | undefined, string | undefined, string | undefined]> = [];
    await withService((req, res) => {
      requests.push([req.method, req.url, req.headers.authorization]);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(modelList));
    }, async origin => {
      const found = await discoverLocalTts(origin + '/audio/speech', {});
      expect(found).toContainEqual({ baseUrl: origin, model: 'gpt-sovits' });
      expect(requests).toEqual([['GET', '/v1/models', undefined]]);
    });
  });

  it('skips unauthenticated failures, redirects and unrelated model services', async () => {
    let followCount = 0;
    await withService((req, res) => {
      if (req.url === '/follow') { followCount++; res.end(JSON.stringify(modelList)); return; }
      if (req.headers.authorization !== 'Bearer service-key') {
        res.writeHead(302, { Location: '/follow' });
        res.end();
        return;
      }
      res.end(JSON.stringify(modelList));
    }, async origin => {
      expect((await discoverLocalTts(origin, {})).some(service => service.baseUrl === origin)).toBe(false);
      expect(followCount).toBe(0);
      await expect(listLocalTtsModels(origin, 'service-key')).resolves.toEqual({ choices: [{ value: 'gpt-sovits', label: 'GPT-SoVITS' }] });
    });
    await withService((_req, res) => res.end(JSON.stringify({ data: [{ id: 'gpt-sovits', owned_by: 'other' }] })), async origin => {
      expect((await discoverLocalTts(origin, {})).some(service => service.baseUrl === origin)).toBe(false);
    });
  });
});
