import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts';
import { saveMedia, type InboundMedia } from './protocol/inbound.ts';
import { extensionForInbound } from './protocol/mime.ts';
import { MessageItemType, type PartialText, type RefMessage, type WeixinMessage } from './protocol/types.ts';
import { checkSendable, datedFileName, derivedDir } from './paths.ts';

const LIMIT = 500;
const TTL = 30 * 24 * 60 * 60_000;

export type QuoteMedia = InboundMedia & { mtimeMs?: number };
type SavedMedia = QuoteMedia & { mtimeMs: number };
type QuoteEntry = { account: string; peer: string; ids: string[]; text: string; media: SavedMedia[]; savedAt: number };

/** Never coerce a server ID to a number. An item and its containing message can have different IDs. */
export function quoteIds(message: WeixinMessage): string[] {
  return serverIds([message.message_id, ...(Array.isArray(message.item_list) ? message.item_list : []).map(item => item?.msg_id)]);
}

export function referenceIds(ref: RefMessage): string[] {
  return serverIds([ref.svr_id, ref.message_item?.msg_id]);
}

function serverIds(ids: unknown[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && /^\d{1,20}$/.test(id)))];
}

/** Recover only the original attachments belonging to this archived event. */
export async function restoreArchivedQuote(
  event: EventEnvelope,
  host: Pick<WorldHost, 'blob'>,
  inboxDir: string,
  accepts: (kind: InboundMedia['kind'], bytes: number) => boolean,
) {
  const blobs = event.blobs ?? [];
  const rows = Array.isArray(event.meta?.media) ? event.meta.media : [];
  const media: InboundMedia[] = [];
  let unavailable = 0;
  let excluded = 0;
  let offset = 0;
  for (const row of rows) {
    const mimes: unknown[] = Array.isArray(row?.attachedMimes) ? row.attachedMimes : [];
    const refs = blobs.slice(offset, offset + mimes.length);
    offset += mimes.length;
    if (!row || row.quoted) continue;
    const kind = row.kind as InboundMedia['kind'];
    if (kind !== 'image' && kind !== 'file' && kind !== 'video' && kind !== 'voice') continue;
    if (!mimes.length) { unavailable += 1; continue; }
    for (const [i, mime] of mimes.entries()) {
      const ref = refs[i];
      if (!ref || ref.mime !== mime) { unavailable += 1; continue; }
      try {
        const content = host.blob(ref.handle);
        if (!content?.bytes.length) { unavailable += 1; continue; }
        if (!accepts(kind, content.bytes.length)) { excluded += 1; continue; }
        const path = await saveMedia({
          bytes: content.bytes,
          dir: derivedDir(inboxDir, 'quoted'),
          name: datedFileName(ref.name, 'wx-quote', extensionForInbound(ref.mime, content.bytes)),
        });
        const videoFrames = row.delivery === 'frames';
        const label = videoFrames ? '引用视频帧' : '引用附件';
        media.push({ kind, mime: ref.mime, bytes: content.bytes.length, path, label: `[${label} ${basename(path)}]`,
          ...(videoFrames ? { videoFrames: true } : {}) });
      } catch {
        unavailable += 1;
      }
    }
  }
  return { media, unavailable, excluded };
}

export function quoteText(message: WeixinMessage): string {
  return (Array.isArray(message.item_list) ? message.item_list : []).flatMap(item => {
    const text = item?.text_item?.text ?? item?.voice_item?.text;
    return typeof text === 'string' && text.trim() ? [text] : [];
  }).join('\n');
}

/** Both end-index interpretations exist. Use the server hash to resolve ambiguity when supplied. */
export function partialQuote(text: string, partial?: PartialText): string {
  if (!partial || typeof partial.start !== 'string' || typeof partial.end !== 'string' || !partial.start || !partial.end) return text;
  function nth(needle: string, occurrence: number, offset = 0): number {
    if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= text.length) return -1;
    let pos = -1;
    for (let i = 0; i <= occurrence; i += 1) {
      pos = text.indexOf(needle, offset);
      if (pos < 0) break;
      offset = pos + needle.length;
    }
    return pos;
  }
  const start = nth(partial.start, partial.startindex);
  if (start < 0) return text;
  for (const end of [nth(partial.end, partial.endindex), nth(partial.end, partial.endindex, start + partial.start.length)]) {
    if (end < start) continue;
    const selected = text.slice(start, end + partial.end.length);
    if (!partial.quotemd5 || createHash('md5').update(selected).digest('hex') === String(partial.quotemd5).toLowerCase()) return selected;
  }
  return text;
}

export function echoedMediaKind(message: WeixinMessage): InboundMedia['kind'] {
  switch (message.item_list?.[0]?.type) {
    case MessageItemType.IMAGE: return 'image';
    case MessageItemType.VIDEO: return 'video';
    case MessageItemType.VOICE: return 'voice';
    default: return 'file';
  }
}

/** Index only; media bytes stay in existing files. Do not persist tokens, CDN URLs, or AES keys. */
export class QuoteIndex {
  #entries?: Promise<QuoteEntry[]>;
  #writes = Promise.resolve();
  constructor(private readonly dir: string) {}

  #load(): Promise<QuoteEntry[]> {
    return this.#entries ??= readFile(join(this.dir, 'quote-index.json'), 'utf8').then(raw => {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value as QuoteEntry[] : [];
    }).catch(() => []);
  }

  async find(account: string, peer: string, id: string, roots: string[]) {
    const entry = (await this.#load()).slice().reverse().find(row => row && row.account === account && row.peer === peer
      && Array.isArray(row.ids) && row.ids.includes(id) && row.savedAt > Date.now() - TTL);
    if (!entry) return undefined;
    const media: InboundMedia[] = [];
    let missing = 0;
    for (const file of Array.isArray(entry.media) ? entry.media : []) {
      if (!file || typeof file.path !== 'string') { missing += 1; continue; }
      const checked = checkSendable(file.path, roots);
      const info = checked.ok ? await stat(checked.path).catch(() => null) : null;
      if (!checked.ok || !info?.isFile() || info.size !== file.bytes || info.mtimeMs !== file.mtimeMs) {
        missing += 1;
        continue;
      }
      media.push({ ...file, path: checked.path, label: `[引用附件 ${basename(checked.path)}]` });
    }
    return { text: entry.text, media, missing };
  }

  remember(account: string, peer: string, ids: string[], text: string, media: QuoteMedia[]) {
    if (!ids.length || (!text && !media.length)) return Promise.resolve();
    const write = this.#writes.then(async () => {
      const saved: SavedMedia[] = [];
      for (const file of media) {
        const info = await stat(file.path).catch(() => null);
        if (info?.isFile() && info.size === file.bytes && (file.mtimeMs === undefined || file.mtimeMs === info.mtimeMs)) {
          saved.push({ ...file, mtimeMs: info.mtimeMs });
        }
      }
      const entries = await this.#load();
      const now = Date.now();
      const next = entries.filter(row => row && row.savedAt > now - TTL &&
        !(row.account === account && row.peer === peer && Array.isArray(row.ids) && row.ids.some(id => ids.includes(id))));
      next.push({ account, peer, ids, text: text.slice(0, 16_000), media: saved, savedAt: now });
      const bounded = next.slice(-LIMIT);
      this.#entries = Promise.resolve(bounded);
      await mkdir(this.dir, { recursive: true });
      const temporary = join(this.dir, `quote-index.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(bounded), { mode: 0o600 });
        await rename(temporary, join(this.dir, 'quote-index.json'));
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.#writes = write.catch(() => {});
    return write;
  }
}
