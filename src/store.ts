/**
 * 部署数据目录里的 iLink 凭据与游标。
 *
 * 目录是 `<dataDir>/wechat-claw/`：
 *   auth.json            bot_token、baseUrl、bot 账号、微信用户
 *   sync.json            get_updates_buf
 *   context-tokens.json  from_user_id → 回复凭据及已发送条数
 *
 * bot_token 与 context_token 都是凭据：不写进 config.json，不进日志，不进事件 meta。
 * 写入用「临时文件 + rename」，断电不会留下半个 JSON。
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export interface AuthRecord {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
  savedAt: string;
}

/** 按实测设置的本地发送上限，同一凭据下的文字与媒体共用。 */
export const MAX_REPLIES_PER_CONTEXT = 10;

export interface ReplyContext {
  token: string;
  sent: number;
  rejected?: true;
}

export class CredentialStore {
  readonly dir: string;
  #contexts: Promise<Map<string, ReplyContext>> | undefined;
  #contextWrites = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  #path(name: string): string {
    return join(this.dir, name);
  }

  async #readJson<T>(name: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.#path(name), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  async #writeJson(name: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.#path(name);
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
    try {
      await chmod(file, 0o600);
    } catch {
      /* Windows 不保证 chmod；文件仍在本部署的数据目录里。 */
    }
  }

  async loadAuth(): Promise<AuthRecord | null> {
    const data = await this.#readJson<Partial<AuthRecord>>('auth.json');
    const token = String(data?.token ?? '').trim();
    if (!token) return null;
    return {
      token,
      baseUrl: String(data?.baseUrl ?? '').trim(),
      accountId: String(data?.accountId ?? '').trim(),
      userId: String(data?.userId ?? '').trim(),
      savedAt: String(data?.savedAt ?? ''),
    };
  }

  async saveAuth(auth: AuthRecord): Promise<void> {
    await this.#writeJson('auth.json', {
      token: auth.token,
      baseUrl: auth.baseUrl,
      accountId: auth.accountId,
      userId: auth.userId,
      savedAt: auth.savedAt || new Date().toISOString(),
    });
  }

  async loadSyncBuf(): Promise<string> {
    const data = await this.#readJson<{ get_updates_buf?: string }>('sync.json');
    return typeof data?.get_updates_buf === 'string' ? data.get_updates_buf : '';
  }

  async saveSyncBuf(value: string): Promise<void> {
    await this.#writeJson('sync.json', { get_updates_buf: String(value ?? '') });
  }

  #replyContexts(): Promise<Map<string, ReplyContext>> {
    return this.#contexts ??= this.#loadReplyContexts();
  }

  async #loadReplyContexts(): Promise<Map<string, ReplyContext>> {
    const data = await this.#readJson<Record<string, unknown>>('context-tokens.json');
    const contexts = new Map<string, ReplyContext>();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return contexts;
    for (const [userId, value] of Object.entries(data)) {
      if (typeof value === 'string' && value) {
        contexts.set(userId, { token: value, sent: 0 });
      } else if (value && typeof value === 'object') {
        const entry = value as Partial<ReplyContext>;
        if (typeof entry.token !== 'string' || !entry.token) continue;
        contexts.set(userId, {
          token: entry.token,
          sent: Math.max(0, Math.min(MAX_REPLIES_PER_CONTEXT, Math.floor(Number(entry.sent) || 0))),
          ...(entry.rejected === true ? { rejected: true } : {}),
        });
      }
    }
    return contexts;
  }

  #writeContexts<T>(action: (contexts: Map<string, ReplyContext>) => Promise<T>): Promise<T> {
    const writing = this.#contextWrites.then(async () => action(await this.#replyContexts()));
    this.#contextWrites = writing.then(() => {}, () => {});
    return writing;
  }

  saveContextToken(userId: string, token: string): Promise<void> {
    return this.#writeContexts(async (contexts) => {
      if (contexts.get(userId)?.token !== token) contexts.set(userId, { token, sent: 0 });
      await this.#writeJson('context-tokens.json', Object.fromEntries(contexts));
    });
  }

  /** 晚到的发送回执只更新它实际使用的凭据。 */
  recordReply(userId: string, context: ReplyContext, outcome: 'sent' | 'rejected'): Promise<void> {
    return this.#writeContexts(async (contexts) => {
      if (contexts.get(userId) !== context) return;
      if (outcome === 'sent') context.sent += 1;
      else context.rejected = true;
      await this.#writeJson('context-tokens.json', Object.fromEntries(contexts));
    });
  }

  async getReplyContext(userId: string): Promise<ReplyContext | undefined> {
    await this.#contextWrites;
    return (await this.#replyContexts()).get(userId);
  }

  async countContextTokens(): Promise<number> {
    const contexts = await this.#replyContexts();
    return [...contexts.values()].filter(c => !c.rejected && c.sent < MAX_REPLIES_PER_CONTEXT).length;
  }

  async loadLastMessageAt(userId: string): Promise<string> {
    const data = await this.#readJson<{ userId: string; lastMessageAt: string }>('status.json');
    const ms = Date.parse(data?.lastMessageAt ?? '');
    return data?.userId === userId && Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  }

  async saveLastMessageAt(userId: string, lastMessageAt: string): Promise<void> {
    await this.#writeJson('status.json', { userId, lastMessageAt });
  }

  /** 会话过期时清掉全部凭据，让用户重新扫码。 */
  async clearSession(): Promise<void> {
    await Promise.all([
      rm(this.#path('auth.json'), { force: true }),
      this.#writeContexts(async (contexts) => {
        contexts.clear();
        await rm(this.#path('context-tokens.json'), { force: true });
      }),
      rm(this.#path('sync.json'), { force: true }),
      rm(this.#path('status.json'), { force: true }),
    ]);
  }
}
