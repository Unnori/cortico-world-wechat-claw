/**
 * undici 与宿主 fetch 的类型适配。
 *
 * 两条路径的差别只有一处：undici 的 fetch 接受 `dispatcher`，而 `RequestInit` 里没有这个字段。
 * 这里把带 dispatcher 的 init 收成一个类型，调用点就不必各自强转。
 *
 * dispatcher 本身按结构化最小接口声明（只有 `close`），不 import undici 的 `Dispatcher`：
 * undici 8 自带的类型与 `@types/node` 里的 undici-types 是两份不兼容的定义，
 * 直接引用会在每个赋值点报「Dispatcher & Dispatcher」。运行时形状不受影响。
 */

/** dispatcher 只需要能被关掉。 */
export interface CloseableDispatcher {
  close(): Promise<void>;
}

/**
 * 带 undici dispatcher 的请求参数。
 *
 * 先从 `RequestInit` 里去掉 `dispatcher`：`@types/node` 的 `RequestInit` 自带一个来自
 * undici-types 的 `dispatcher?: Dispatcher`，与本地声明取交集会又变回那个类型。
 */
export type FetchInit = Omit<RequestInit, 'dispatcher'> & { dispatcher?: unknown };

/** 一份可以被 undici 与全局 fetch 共同接受的 fetch 签名。 */
export type CompatFetch = (input: string, init?: FetchInit) => Promise<Response>;

/** 把任意 fetch 看成兼容签名：全局 fetch 会忽略 dispatcher，但类型一致。 */
export function asCompatFetch(fetchImpl: unknown): CompatFetch {
  return fetchImpl as CompatFetch;
}
