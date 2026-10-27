/**
 * 部署数据目录里的 iLink 凭据与游标。
 *
 * 目录是 `<dataDir>/wechat-claw/`：
 *   auth.json            bot_token、baseUrl、bot 账号、微信用户
 *   sync.json            get_updates_buf
 *   context-tokens.json  from_user_id → context_token
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

export class CredentialStore {
  readonly dir: string;

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

  async loadContextTokens(): Promise<Record<string, string>> {
    const data = await this.#readJson<Record<string, unknown>>('context-tokens.json');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const tokens: Record<string, string> = {};
    for (const [userId, token] of Object.entries(data)) {
      if (typeof token === 'string' && token) tokens[userId] = token;
    }
    return tokens;
  }

  /** 存一条 token，返回现在一共有几条。 */
  async saveContextToken(userId: string, token: string): Promise<number> {
    const tokens = await this.loadContextTokens();
    tokens[String(userId)] = String(token);
    await this.#writeJson('context-tokens.json', tokens);
    return Object.keys(tokens).length;
  }

  async getContextToken(userId: string): Promise<string> {
    const tokens = await this.loadContextTokens();
    return tokens[String(userId)] ?? '';
  }

  async countContextTokens(): Promise<number> {
    return Object.keys(await this.loadContextTokens()).length;
  }

  /** 会话过期时清掉全部凭据，让用户重新扫码。 */
  async clearSession(): Promise<void> {
    await Promise.all([
      rm(this.#path('auth.json'), { force: true }),
      rm(this.#path('context-tokens.json'), { force: true }),
      rm(this.#path('sync.json'), { force: true }),
    ]);
  }
}
