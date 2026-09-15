import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { IncomingMessage, Message, Memory } from './types.js';

export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const PARTICLES = ['ה', 'ו', 'ב', 'ל', 'כ', 'מ', 'ש'];
// Hebrew attaches the article and prepositions to the word, so "אישורים" and "האישורים"
// are unrelated FTS tokens and a prefix search cannot reach backwards past the ה. Search
// both directions instead: strip leading particles off the query, and also offer the
// attached forms of whatever is left.
export function searchVariants(token: string): string[] {
  if (!/^[֐-׿]+$/.test(token)) return [token];
  const bases = new Set([token]);
  for (let base = token; base.length > 3 && PARTICLES.includes(base[0]!) && bases.size < 3;) {
    base = base.slice(1);
    bases.add(base);
  }
  const variants = new Set(bases);
  for (const base of bases) if (base.length >= 3) for (const particle of PARTICLES) variants.add(particle + base);
  return [...variants];
}
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, external_id TEXT NOT NULL,
        sender TEXT NOT NULL, timestamp INTEGER NOT NULL, text TEXT NOT NULL,
        kind TEXT NOT NULL, historical INTEGER NOT NULL, analyzed INTEGER NOT NULL DEFAULT 0,
        UNIQUE(chat_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS messages_time ON messages(timestamp, chat_id);
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(analyzed, historical, timestamp);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid,text) VALUES(new.rowid,new.text); END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts,rowid,text) VALUES('delete',old.rowid,old.text); END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
        INSERT INTO messages_fts(messages_fts,rowid,text) VALUES('delete',old.rowid,old.text);
        INSERT INTO messages_fts(rowid,text) VALUES(new.rowid,new.text); END;
      CREATE TABLE IF NOT EXISTS memory (key TEXT PRIMARY KEY, value TEXT NOT NULL, confirmed INTEGER NOT NULL, sources TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analyses (id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, created_at INTEGER NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, title TEXT NOT NULL, fingerprint TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS alerts_fingerprint ON alerts(fingerprint, created_at);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, text TEXT NOT NULL, silent INTEGER NOT NULL,
        urgent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, next_at INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER, last_error TEXT, photo TEXT, markup TEXT, parse_mode TEXT
      );
    `);
    // Databases created before onboarding moved into Telegram predate the photo column.
    if (Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) < 4) {
      const columns = this.db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[];
      if (!columns.some(c => c.name === 'photo')) this.db.exec('ALTER TABLE outbox ADD COLUMN photo TEXT');
      if (!columns.some(c => c.name === 'markup')) this.db.exec('ALTER TABLE outbox ADD COLUMN markup TEXT');
      if (!columns.some(c => c.name === 'parse_mode')) this.db.exec('ALTER TABLE outbox ADD COLUMN parse_mode TEXT');
      this.db.exec('PRAGMA user_version=4');
    }
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);
    return row ? JSON.parse(row.value as string) as T : fallback;
  }
  set(key: string, value: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run(key, JSON.stringify(value));
  }
  insert(m: IncomingMessage): boolean {
    const id = hash(`${m.chatId}\0${m.externalId}`).slice(0, 20);
    return !!this.db.prepare(`INSERT OR IGNORE INTO messages
      (id,chat_id,external_id,sender,timestamp,text,kind,historical,analyzed) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id, m.chatId, m.externalId, m.sender, m.timestamp, m.text, m.kind || 'text', +!!m.historical, +!!m.historical).changes;
  }
  messages(from: number, to: number, chats: string[], limit = 20001): Message[] {
    if (!chats.length) return [];
    return this.db.prepare(`SELECT * FROM messages WHERE timestamp>=? AND timestamp<? AND chat_id IN (${chats.map(() => '?')}) ORDER BY timestamp,id LIMIT ?`)
      .all(from, to, ...chats, limit) as unknown as Message[];
  }
  pending(chats: string[], limit = 300): Message[] {
    if (!chats.length) return [];
    // Take turns between chats. A chat whose messages keep failing analysis holds its
    // backlog at the front of the queue, and a global oldest-first window would let it
    // starve newer messages in every other chat until that backlog ages out.
    return this.db.prepare(`SELECT id,chat_id,external_id,sender,timestamp,text,kind,historical,analyzed FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp,id) turn FROM messages
        WHERE analyzed=0 AND historical=0 AND chat_id IN (${chats.map(() => '?')})
      ) ORDER BY turn,timestamp,id LIMIT ?`)
      .all(...chats, limit) as unknown as Message[];
  }
  markAnalyzed(ids: string[]) {
    const stmt = this.db.prepare('UPDATE messages SET analyzed=1 WHERE id=?');
    ids.forEach(id => stmt.run(id));
  }
  source(id: string, chats: string[]): Message | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as unknown as Message | undefined;
    return row && chats.includes(row.chat_id) ? row : undefined;
  }
  search(query: string, chats: string[], limit = 30): Message[] {
    if (!chats.length) return [];
    const tokens = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 20) || [];
    if (!tokens.length) return [];
    // Quote terms: user input is never interpreted as FTS syntax.
    const fts = [...new Set(tokens.flatMap(searchVariants))].slice(0, 200)
      .map(t => t.length >= 3 ? `"${t}"*` : `"${t}"`).join(' OR ');
    return this.db.prepare(`SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid=f.rowid
      WHERE messages_fts MATCH ? AND m.chat_id IN (${chats.map(() => '?')}) ORDER BY rank, m.timestamp DESC LIMIT ?`)
      .all(fts, ...chats, limit) as unknown as Message[];
  }
  memories(confirmedOnly = true): Memory[] {
    return this.db.prepare(`SELECT * FROM memory ${confirmedOnly ? 'WHERE confirmed=1' : ''} ORDER BY updated_at DESC LIMIT 200`).all() as unknown as Memory[];
  }
  remember(key: string, value: string, confirmed: boolean, sources: string[] = [], now = Date.now()) {
    // Inferred facts cannot overwrite a parent's confirmed facts.
    this.db.prepare(`INSERT INTO memory VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      value=excluded.value,confirmed=excluded.confirmed,sources=excluded.sources,updated_at=excluded.updated_at
      WHERE excluded.confirmed=1 OR memory.confirmed=0`).run(key, value, +confirmed, JSON.stringify(sources), now);
  }
  forget(key: string) { return this.db.prepare('DELETE FROM memory WHERE key=?').run(key).changes; }
  enqueue(key: string, chatId: string, text: string, silent = false, urgent = false, now = Date.now(), parseMode?: string) {
    // Split by Unicode code points, keeping below Telegram's UTF-16 message limit.
    const points = Array.from(text || 'Нет новых сообщений.');
    for (let i = 0, part = 0; i < points.length; i += 1800, part++) {
      this.db.prepare(`INSERT OR IGNORE INTO outbox(id,chat_id,text,silent,urgent,created_at,parse_mode) VALUES(?,?,?,?,?,?,?)`)
        .run(hash(`${key}\0${chatId}\0${part}`), chatId, points.slice(i, i + 1800).join(''), +silent, +urgent, now, parseMode ?? null);
    }
  }
  // A QR is useless as text in a chat, so pairing images ride the same retrying outbox.
  enqueuePhoto(key: string, chatId: string, photo: string, caption: string, now = Date.now()) {
    this.db.prepare(`INSERT OR IGNORE INTO outbox(id,chat_id,text,silent,urgent,created_at,photo) VALUES(?,?,?,?,?,?,?)`)
      .run(hash(`${key}\0${chatId}\0photo`), chatId, caption.slice(0, 1000), 0, 1, now, photo);
  }
  // A menu is one message with buttons: never split, and replaced rather than repeated.
  enqueueMenu(key: string, chatId: string, text: string, markup: unknown, now = Date.now(), parseMode?: string) {
    this.db.prepare(`INSERT OR IGNORE INTO outbox(id,chat_id,text,silent,urgent,created_at,markup,parse_mode) VALUES(?,?,?,?,?,?,?,?)`)
      // A menu is one message by definition, so it cannot be split — but if something ever
      // overruns, say so rather than letting the tail disappear without a trace.
      .run(hash(`${key}\0${chatId}\0menu`), chatId,
        text.length > 3500 ? `${text.slice(0, 3400)}\n\n… показано не полностью` : text,
        0, 1, now, JSON.stringify(markup), parseMode ?? null);
  }
  stats() {
    const count = (table: string, where = '') => Number(this.db.prepare(`SELECT count(*) n FROM ${table} ${where}`).get()!.n);
    return { messages: count('messages'), memory: count('memory'), pendingAnalysis: count('messages', 'WHERE analyzed=0 AND historical=0'),
      pendingDelivery: count('outbox', 'WHERE sent_at IS NULL'), deliveryFailures: count('outbox', 'WHERE sent_at IS NULL AND attempts>0') };
  }
  prune(days: number, now = Date.now()) {
    if (!days) return;
    const before = now - days * 86400000;
    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE timestamp<?').run(before);
      this.db.prepare('DELETE FROM analyses WHERE created_at<?').run(before);
      this.db.prepare('DELETE FROM alerts WHERE created_at<?').run(before);
      this.db.prepare('DELETE FROM outbox WHERE sent_at IS NOT NULL AND created_at<?').run(before);
      this.db.prepare('DELETE FROM memory WHERE confirmed=0 AND updated_at<?').run(before);
    });
  }
}
