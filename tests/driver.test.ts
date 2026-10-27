/**
 * 驱动层的两条关键不变式。
 *
 * 这两条都是线上事故的直接原因：
 * - 游标返回空串时必须重置，否则会带着旧游标永远收不到新消息（"能发不能收"）；
 * - 长轮询超时不能当成"连接正常"，否则界面显示已连接而实际早就不通。
 */
import { describe, expect, it, vi } from 'vitest';

import { ILinkDriver, DEAD_AFTER_SILENT_ROUNDS } from '../src/driver.ts';
import type { GetUpdatesResp } from '../src/protocol/types.ts';

/** 记录日志的假 logger。 */
const quietLog = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  emit: () => {},
  child() { return quietLog; },
} as never;

/** 按脚本回放响应的假 api。 */
function fakeApi(responses: Array<GetUpdatesResp | Error>, opts: { repeatLast?: boolean; maxCalls?: number } = {}) {
  let index = 0;
  const calls: string[] = [];
  const maxCalls = opts.maxCalls ?? 50;
  return {
    calls,
    api: {
      async getUpdates(params: { syncBuf?: string }): Promise<GetUpdatesResp> {
        calls.push(params.syncBuf ?? '');
        // 上限保护：驱动在失败路径上会一直重试，测试里必须能停下来。
        if (calls.length > maxCalls) {
          await new Promise(() => {}); // 挂住，不再产生请求
        }
        const item = responses[Math.min(index, responses.length - 1)];
        if (!opts.repeatLast) index += 1;
        if (item instanceof Error) throw item;
        return item!;
      },
    },
  };
}

/** 极简 store：只记游标。 */
function fakeStore(initial = '') {
  let buf = initial;
  return {
    store: {
      async loadSyncBuf() { return buf; },
      async saveSyncBuf(v: string) { buf = v; },
      async getContextToken() { return ''; },
      async saveContextToken() { return 0; },
      async countContextTokens() { return 0; },
    } as never,
    current: () => buf,
  };
}

/** 停驱动，但不等它内部的长睡眠：测试只关心断言，不关心优雅退出。 */
async function stopQuietly(driver: ILinkDriver): Promise<void> {
  const stopping = driver.stop();
  await Promise.race([stopping, new Promise((r) => setTimeout(r, 300))]);
}

/** 等到条件成立或超时。 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等待超时');
}

describe('游标推进', () => {
  it('服务端返回空串游标时真的重置，不会带着旧游标继续问', async () => {
    const { api, calls } = fakeApi([
      { ret: 0, msgs: [], get_updates_buf: 'buf-A' },
      // 服务端要求重置：给空串。
      { ret: 0, msgs: [], get_updates_buf: '' },
      { ret: 0, msgs: [], get_updates_buf: 'buf-B' },
    ]);
    const st = fakeStore('');
    const driver = new ILinkDriver({
      api: api as never,
      store: st.store,
      log: quietLog,
      onMessage: () => {},
      onStatus: () => {},
      reconnectBaseMs: 5,
      deadAfterSilentRounds: 0,
    });
    driver.start();
    await waitFor(() => calls.length >= 3);
    await stopQuietly(driver);

    // 第二次请求带的是第一次的游标；第三次必须是空串（已重置），不是 buf-A。
    expect(calls[0]).toBe('');
    expect(calls[1]).toBe('buf-A');
    expect(calls[2]).toBe('');
    expect(st.current()).toBe('buf-B');
  });

  it('字段缺失时保留旧游标', async () => {
    const { api, calls } = fakeApi([
      { ret: 0, msgs: [], get_updates_buf: 'keep-me' },
      // 没有 get_updates_buf 字段。
      { ret: 0, msgs: [] },
      { ret: 0, msgs: [], get_updates_buf: 'next' },
    ]);
    const st = fakeStore('');
    const driver = new ILinkDriver({
      api: api as never,
      store: st.store,
      log: quietLog,
      onMessage: () => {},
      onStatus: () => {},
      reconnectBaseMs: 5,
      deadAfterSilentRounds: 0,
    });
    driver.start();
    await waitFor(() => calls.length >= 3);
    await stopQuietly(driver);

    expect(calls[2]).toBe('keep-me');
  });

  it('启动时从已保存的游标继续', async () => {
    const { api, calls } = fakeApi([{ ret: 0, msgs: [], get_updates_buf: 'x' }]);
    const st = fakeStore('saved-cursor');
    const driver = new ILinkDriver({
      api: api as never,
      store: st.store,
      log: quietLog,
      onMessage: () => {},
      onStatus: () => {},
      reconnectBaseMs: 5,
      deadAfterSilentRounds: 0,
    });
    driver.start();
    await waitFor(() => calls.length >= 1);
    await stopQuietly(driver);
    expect(calls[0]).toBe('saved-cursor');
  });
});

describe('连接状态', () => {
  it('拿到响应（哪怕空批次）才算连上，并刷新 lastPollAt', async () => {
    const { api } = fakeApi([{ ret: 0, msgs: [], get_updates_buf: 'a' }]);
    const st = fakeStore('');
    const statuses: Array<{ connected: boolean; lastPollAtMs?: number }> = [];
    const driver = new ILinkDriver({
      api: api as never,
      store: st.store,
      log: quietLog,
      onMessage: () => {},
      onStatus: (s) => statuses.push(s),
      reconnectBaseMs: 5,
      deadAfterSilentRounds: 0,
    });
    driver.start();
    await waitFor(() => statuses.some((s) => s.connected));
    await stopQuietly(driver);

    expect(driver.connected).toBe(true);
    expect(driver.lastPollAtMs).toBeGreaterThan(0);
  });

  it('请求抛错时置为断开，不留下"已连接"的假象', async () => {
    const { api } = fakeApi([new Error('TLS 握手失败')], { repeatLast: true });
    const st = fakeStore('');
    const statuses: Array<{ connected: boolean; error: string }> = [];
    const driver = new ILinkDriver({
      api: api as never,
      store: st.store,
      log: quietLog,
      onMessage: () => {},
      onStatus: (s) => statuses.push(s),
      reconnectBaseMs: 5,
      deadAfterSilentRounds: 0,
    });
    driver.start();
    await waitFor(() => statuses.length >= 1);
    expect(driver.connected).toBe(false);
    expect(statuses[0]!.connected).toBe(false);
    expect(statuses[0]!.error).toContain('TLS');
    await stopQuietly(driver);
  });

  it(`连续 ${DEAD_AFTER_SILENT_ROUNDS} 轮失败后请求重建`, async () => {
    const { api } = fakeApi([new Error('网络请求失败')], { repeatLast: true });
    const st = fakeStore('');
    let stalled = 0;
    const driver = new ILinkDriver({
      api: api as never,
      store: st.store,
      log: quietLog,
      onMessage: () => {},
      onStatus: () => {},
      reconnectBaseMs: 1,
      deadAfterSilentRounds: DEAD_AFTER_SILENT_ROUNDS,
      onStalled: () => { stalled += 1; },
    });
    driver.start();
    await waitFor(() => stalled >= 1, 5000);
    await stopQuietly(driver);
    expect(stalled).toBe(1);
  });
});

describe('消息投递', () => {
  it('把 msgs 逐条交给回调', async () => {
    const { api } = fakeApi([{
      ret: 0,
      get_updates_buf: 'b',
      msgs: [
        { from_user_id: 'u1', message_type: 1, item_list: [{ type: 1, text_item: { text: '一' } }] },
        { from_user_id: 'u2', message_type: 1, item_list: [{ type: 1, text_item: { text: '二' } }] },
      ],
    }]);
    const st = fakeStore('');
    const got: string[] = [];
    const driver = new ILinkDriver({
      api: api as never,
      store: st.store,
      log: quietLog,
      onMessage: (m) => { got.push(String(m.from_user_id)); },
      onStatus: () => {},
      reconnectBaseMs: 5,
      deadAfterSilentRounds: 0,
    });
    driver.start();
    await waitFor(() => got.length >= 2);
    await stopQuietly(driver);
    // 循环会反复取同一批（假 api 只给一份），所以只看开头两条的顺序。
    expect(got.slice(0, 2)).toEqual(['u1', 'u2']);
  });

  it('单条消息处理抛错不影响后续消息', async () => {
    const { api } = fakeApi([{
      ret: 0,
      get_updates_buf: 'b',
      msgs: [
        { from_user_id: 'bad', message_type: 1 },
        { from_user_id: 'good', message_type: 1 },
      ],
    }]);
    const st = fakeStore('');
    const got: string[] = [];
    const driver = new ILinkDriver({
      api: api as never,
      store: st.store,
      log: quietLog,
      onMessage: (m) => {
        if (m.from_user_id === 'bad') throw new Error('boom');
        got.push(String(m.from_user_id));
      },
      onStatus: () => {},
      reconnectBaseMs: 5,
      deadAfterSilentRounds: 0,
    });
    driver.start();
    await waitFor(() => got.length >= 1);
    await stopQuietly(driver);
    // 抛错的那条不该进 got；循环会重复投递 good，所以只验第一条。
    expect(got[0]).toBe('good');
    expect(got).not.toContain('bad');
  });
});

describe('令牌失效', () => {
  it('errcode -14 时暂停而不是继续高频重试', async () => {
    const { api, calls } = fakeApi([{ ret: 0, errcode: -14, msgs: [] }], { repeatLast: true });
    const st = fakeStore('');
    const statuses: Array<{ error: string; pausedUntilMs?: number }> = [];
    const driver = new ILinkDriver({
      api: api as never,
      store: st.store,
      log: quietLog,
      onMessage: () => {},
      onStatus: (s) => statuses.push(s),
      reconnectBaseMs: 1,
      deadAfterSilentRounds: 0,
    });
    driver.start();
    await waitFor(() => statuses.length >= 1);
    expect(statuses[0]!.pausedUntilMs).toBeGreaterThan(Date.now());
    // 暂停中不该继续发请求。
    expect(calls.length).toBe(1);
    await stopQuietly(driver);
  });
});
