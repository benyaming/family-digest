import makeWASocket, { BufferJSON, DisconnectReason, initAuthCreds, normalizeMessageContent, proto,
  type AuthenticationState, type SignalDataTypeMap, type WAMessage, type WAMessageKey, type WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';
import type { Store } from './db.js';
import type { FamilyService } from './service.js';

// Transactional session storage: credentials and Signal keys survive container restarts.
export function sqliteAuth(store: Store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS wa_auth (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const read = (key: string) => {
    const row = store.db.prepare('SELECT value FROM wa_auth WHERE key=?').get(key);
    return row ? JSON.parse(row.value as string, BufferJSON.reviver) : null;
  };
  const write = (key: string, value: unknown) => {
    if (value == null) store.db.prepare('DELETE FROM wa_auth WHERE key=?').run(key);
    else store.db.prepare('INSERT OR REPLACE INTO wa_auth VALUES(?,?)').run(key, JSON.stringify(value, BufferJSON.replacer));
  };
  const creds = read('creds') || initAuthCreds();
  const state: AuthenticationState = { creds, keys: {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        let value = read(`${type}:${id}`);
        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
        if (value) result[id] = value;
      }
      return result;
    },
    set: async (data) => {
      store.transaction(() => {
        for (const [category, entries] of Object.entries(data)) for (const [id, value] of Object.entries(entries || {})) write(`${category}:${id}`, value);
      });
    },
  } };
  return { state, saveCreds: () => write('creds', creds) };
}

// Everything this app is permitted to do with the linked account. The socket exposes 170
// methods, 77 of which write to WhatsApp — sending, receipts, presence, group administration,
// profile and blocking. A deny-list would rot as Baileys grows, so nothing is reachable
// unless it is named here, and a blocked call throws instead of reaching WhatsApp.
const ALLOWED_SOCKET_ACCESS = new Set([
  'ev',                          // receive events
  'authState',                   // is this device registered
  'end',                         // close the connection locally
  'requestPairingCode',          // link this device
  'logout',                      // unlink this device, on explicit request
  'groupFetchAllParticipating',  // read group names
  // Fetches the account's own chat settings (archived, pinned, muted) and replays them as
  // events. Baileys already calls this itself on every connect; allowing it only lets the
  // app ask for a fresh snapshot. It is framed as an iq type="set" because that is how
  // WhatsApp's app-state protocol requests state — it changes nothing on the account.
  'resyncAppState',
  // Asks WhatsApp for older messages in one chat. It relays a protocol message to the
  // account's own JID (category 'peer') — it is never delivered to a conversation and no
  // other person can see it — but it is a send, so it is an explicit, documented exception
  // to the read-only rule rather than an oversight.
  'fetchMessageHistory',
]);
export class WhatsAppWriteBlocked extends Error {
  constructor(public method: string) { super(`Blocked WhatsApp write attempt: ${method}`); }
}
/** Wraps the socket so only reads survive; anything else throws when called. */
export function readOnlySocket<T extends object>(socket: T): T {
  // `ws` is the raw transport. Handing it back exposes send(), which speaks the protocol
  // directly and would walk straight past every rule above it, so only the one piece of
  // state this app actually reads is exposed.
  let connection: { readonly isOpen: boolean } | undefined;
  const view = (target: { ws?: { isOpen?: boolean } }) => (connection ??= { get isOpen() { return !!target.ws?.isOpen; } });
  const blocked = (property: string) => () => { throw new WhatsAppWriteBlocked(property); };
  const guard = (target: T, property: string | symbol, real: unknown) => {
    if (property === 'ws') return view(target as { ws?: { isOpen?: boolean } });
    if (typeof property === 'symbol' || ALLOWED_SOCKET_ACCESS.has(property)) return real;
    // Unknown data stays hidden; unknown behaviour fails loudly at the call, not on access,
    // so ordinary property probing (await checking .then, for one) still works.
    return typeof real === 'function' ? blocked(String(property)) : undefined;
  };
  return new Proxy(socket, {
    get(target, property, receiver) { return guard(target, property, Reflect.get(target, property, receiver)); },
    // Reading a descriptor is a second way to reach a property, and it hands back the
    // original function untouched. It has to answer exactly as the getter does.
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      // A non-configurable own property cannot be misreported without breaking a proxy
      // invariant; Baileys builds its socket from plain objects, so this does not arise.
      if (!descriptor || !descriptor.configurable || !('value' in descriptor)) return descriptor;
      return { ...descriptor, value: guard(target, property, descriptor.value) };
    },
    set(_target, property) { throw new WhatsAppWriteBlocked(`assignment to ${String(property)}`); },
    deleteProperty(_target, property) { throw new WhatsAppWriteBlocked(`deletion of ${String(property)}`); },
  });
}

export function extractText(content?: proto.IMessage | null): { text: string; kind: string } | undefined {
  const m = normalizeMessageContent(content);
  if (!m) return;
  if (m.conversation) return { text: m.conversation, kind: 'text' };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, kind: 'text' };
  if (m.imageMessage) return { text: m.imageMessage.caption || '[Изображение: содержимое не распознано]', kind: 'image' };
  if (m.videoMessage) return { text: m.videoMessage.caption || '[Видео: содержимое не распознано]', kind: 'video' };
  if (m.documentMessage) return { text: `${m.documentMessage.caption || ''}\n[Документ: ${m.documentMessage.fileName || 'без имени'}; содержимое не прочитано]`.trim(), kind: 'document' };
  if (m.audioMessage) return { text: '[Голосовое сообщение: расшифровка пока не поддерживается]', kind: 'audio' };
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
  if (poll) return { text: `[Опрос] ${poll.name}\n${poll.options?.map(o => o.optionName).join('\n') || ''}`, kind: 'poll' };
  return; // Ignore reactions, stickers, receipts and protocol noise.
}

export class WhatsApp {
  private socket?: WASocket;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private reconnects = 0;
  private qr?: { value: string; at: number };
  onConnected?: () => void;
  constructor(private service: FamilyService) {}
  pairing() { return this.qr && Date.now() - this.qr.at < 60000 ? this.qr.value : null; }
  enabled() { return this.service.store.get('wa:enabled', false); }
  // Asking WhatsApp when the list is actually read: a group joined since linking would
  // otherwise stay invisible until the next reconnect.
  // Asking WhatsApp costs about a second and a half, which is far too slow to repeat on
  // every page flip. Serve the last answer unless it is stale or a refresh was asked for.
  async refreshGroups(force = false) {
    const cached = this.groups();
    const age = Date.now() - this.service.store.get<number>('wa:groupsAt', 0);
    if (!force && cached.length && age < 120000) return cached;
    if (!this.socket?.ws?.isOpen) return cached;
    try {
      const fetched = await this.socket.groupFetchAllParticipating();
      const list = Object.values(fetched).map(g => ({ id: g.id, name: g.subject?.trim() || '' }));
      this.service.store.set('wa:groups', list);
      this.service.store.set('wa:groupsAt', Date.now());
      this.service.store.set('wa:discoveryError', null);
      return list;
    } catch {
      this.service.store.set('wa:discoveryError', 'Group discovery failed; the last known list is shown');
      return cached;
    }
  }
  // A logged-out, replaced or corrupted session never reconnects on its own, and its stored
  // credentials cannot be resumed: pairing again has to start from a clean slate.
  static needsFreshSession(status: string, socketOpen: boolean) {
    return { reconnect: !socketOpen || status.startsWith('needs_attention'), wipe: status.startsWith('needs_attention') };
  }
  // Onboarding is driven from Telegram, so linking must be startable without a restart.
  private async socketReady(timeout = 20000) {
    const deadline = Date.now() + timeout;
    const status = this.service.store.get<string>('wa:status', 'disabled');
    const { reconnect, wipe } = WhatsApp.needsFreshSession(status, !!this.socket?.ws?.isOpen);
    if (reconnect) {
      if (wipe) {
        this.stop();
        this.service.store.db.exec('DELETE FROM wa_auth');
        this.service.store.set('wa:groups', []);
      }
      this.stopping = false;
      this.service.store.set('wa:enabled', true);
      await this.connect();
    }
    while (Date.now() < deadline) {
      if (this.socket?.ws?.isOpen) return this.socket;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('WhatsApp did not become ready');
  }
  async requestPairingCode(phone: string) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) throw new Error('Invalid phone number');
    const socket = await this.socketReady();
    if (socket.authState.creds.registered) throw new Error('Already linked');
    return socket.requestPairingCode(digits);
  }
  async pairingQr(timeout = 20000) {
    await this.socketReady(timeout);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = this.pairing();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
  }
  // Archive state and last-activity arrive with app-state sync. If the account was already
  // in sync when this app started listening, there are no patches to replay and the list
  // looks uniformly unarchived; asking for a full snapshot recovers it without re-pairing.
  async resyncChats() {
    const socket = await this.socketReady();
    // Two halves have to be true at once. Baileys only refetches patches newer than the
    // version it has stored, so the stored versions are dropped to force a full snapshot.
    // And an "initial" sync makes every archive update conditional on the chat arriving in
    // the same history batch (chat-utils getChatUpdateConditional) — which never happens
    // here, so those updates sit in the buffer forever. A normal sync has no such condition.
    this.service.store.db.prepare("DELETE FROM wa_auth WHERE key LIKE 'app-state-sync-version:%'").run();
    await socket.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false);
    // The updates arrive through Baileys' event buffer just after the call returns, so the
    // count is read once it stops growing rather than immediately, when it is still stale.
    let seen = -1;
    for (let attempt = 0; attempt < 16; attempt++) {
      const known = Object.keys(this.chatMeta()).length;
      if (known === seen && known > 0) break;
      seen = known;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    this.service.store.set('wa:chatsSynced', true);
    return Object.keys(this.chatMeta()).length;
  }
  async unlink() {
    this.service.store.set('wa:enabled', false);
    try { await this.socket?.logout(); } catch { /* the link may already be gone; clear local state regardless */ }
    this.stop();
    this.service.store.db.exec('DELETE FROM wa_auth');
    this.service.store.set('wa:groups', []);
    this.service.store.set('wa:groupsAt', 0);
    this.service.store.set('wa:chatmeta', {});
    this.service.store.set('wa:chatsSynced', false);
    this.status('disabled');
    this.stopping = false;
  }
  groups() { return this.service.store.get<{ id: string; name: string }[]>('wa:groups', []); }
  chatMeta() { return this.service.store.get<Record<string, { a?: boolean; t?: number }>>('wa:chatmeta', {}); }
  archived() { return new Set(Object.entries(this.chatMeta()).filter(([, v]) => v.a).map(([id]) => id)); }
  activity() { return new Map(Object.entries(this.chatMeta()).filter(([, v]) => v.t).map(([id, v]) => [id, v.t!])); }
  // WhatsApp reports archive state and last activity through chat sync, not through group
  // metadata, so both are accumulated as they arrive. Unknown means "not archived, unranked".
  private noteChats(chats: { id?: string | null; archived?: boolean | null; conversationTimestamp?: unknown }[]) {
    if (!chats.length) return;
    const meta = this.chatMeta();
    let changed = false;
    for (const chat of chats) {
      if (!chat.id) continue;
      // Tracked per chat: a single earlier change used to make every later chat store an
      // empty entry, which then counted as "known" and was never filled in.
      let touched = false;
      const entry = meta[chat.id] ?? {};
      if (chat.archived !== undefined && chat.archived !== null && entry.a !== !!chat.archived) { entry.a = !!chat.archived; touched = true; }
      const raw = chat.conversationTimestamp as { toNumber?: () => number } | number | null | undefined;
      const seconds = typeof raw === 'object' && raw?.toNumber ? raw.toNumber() : Number(raw ?? 0);
      const at = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
      if (at && at !== entry.t) { entry.t = at; touched = true; }
      if (touched) { meta[chat.id] = entry; changed = true; }
    }
    if (changed) this.service.store.set('wa:chatmeta', meta);
  }
  stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    const socket = this.socket;
    // Disown it before closing. end() waits on the peer — up to the ws library's 30s backstop —
    // and emits its close afterwards, so no sleep can bound it. Every handler is guarded by
    // `socket !== this.socket`, which only fires once the old socket is no longer ours: that is
    // what stops a closing session from scheduling a reconnect into the next link.
    this.socket = undefined;
    this.qr = undefined;
    socket?.end(undefined);
  }
  private status(status: string) { this.service.store.set('wa:status', status); }
  private receive(messages: WAMessage[], historical: boolean) {
    for (const message of messages) {
      const chatId = message.key.remoteJid, externalId = message.key.id;
      if (!chatId || !externalId || !this.service.chatIds.includes(chatId)) continue;
      const content = normalizeMessageContent(message.message);
      const protocol = content?.protocolMessage;
      if (protocol?.key?.id && protocol.editedMessage) {
        const edited = extractText(protocol.editedMessage);
        if (edited) this.edit(chatId, protocol.key.id, edited.text);
        continue;
      }
      if (protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE && protocol.key?.id) { this.edit(chatId, protocol.key.id, '[Сообщение удалено]', true); continue; }
      const extracted = extractText(content);
      if (!extracted) continue;
      const timestamp = Number(message.messageTimestamp) * 1000;
      if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 5 * 60000) continue;
      this.service.ingest([{ chatId, externalId, sender: message.pushName || message.key.participant || (message.key.fromMe ? 'Вы' : 'Неизвестный отправитель'), timestamp,
        ...extracted, historical: historical || timestamp < Date.now() - this.service.config.alertMaxAgeHours * 3600000 }]);
      if (!historical) this.backfill(chatId, message.key, timestamp);
    }
  }
  private backfilling = new Set<string>();
  // Fired on a followed group's first live message, because paging backwards needs a message
  // to page from. Runs detached: the reply the reader is waiting for must not wait for this.
  private backfill(chatId: string, key: WAMessageKey, timestamp: number) {
    const pending = new Set(this.service.store.get<string[]>('wa:backfill', []));
    if (!pending.has(chatId) || this.backfilling.has(chatId)) return;
    this.backfilling.add(chatId);
    void (async () => {
      try {
        await this.socket?.fetchMessageHistory(100, key, timestamp);
        // Only now is the intent spent. Clearing it first meant one failed request — a
        // reconnect mid-flight, say — silently cost the group its history for good.
        pending.delete(chatId);
        this.service.store.set('wa:backfill', [...pending]);
      } catch { /* history is a bonus: the group still works going forward without it */ }
      finally { this.backfilling.delete(chatId); }
    })();
  }
  private edit(chatId: string, externalId: string, text: string, deleted = false) {
    if (!this.service.chatIds.includes(chatId)) return;
    this.service.store.db.prepare('UPDATE messages SET text=?,analyzed=? WHERE chat_id=? AND external_id=?').run(text, +deleted, chatId, externalId);
  }
  private connecting = false;
  async connect() {
    if (this.stopping || this.connecting) return;
    this.connecting = true;
    try {
    // Whatever is here is being replaced: end it and disown it before another is built, or
    // two live sockets share one auth store and a reconnect armed by the old one survives
    // into the new session. Every handler is guarded by `socket !== this.socket`, which only
    // holds once the old socket is no longer ours.
    clearTimeout(this.timer);
    const previous = this.socket;
    this.socket = undefined;
    previous?.end(undefined);
    this.status('connecting');
    const auth = sqliteAuth(this.service.store);
    // markOnlineOnConnect keeps the account from appearing online because of this app.
    const socket = readOnlySocket(makeWASocket({ auth: auth.state, logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false, syncFullHistory: true, shouldSyncHistoryMessage: () => true,
      getMessage: async () => undefined,
    }));
    this.socket = socket;
    socket.ev.on('creds.update', auth.saveCreds);
    socket.ev.on('messages.upsert', ({ messages, type }) => this.receive(messages, type !== 'notify'));
    socket.ev.on('messaging-history.set', ({ messages, chats }) => { this.noteChats(chats || []); this.receive(messages, true); });
    socket.ev.on('chats.upsert', chats => this.noteChats(chats || []));
    socket.ev.on('chats.update', chats => this.noteChats(chats as { id?: string | null; archived?: boolean | null; conversationTimestamp?: unknown }[]));
    socket.ev.on('messages.update', updates => {
      for (const { key, update } of updates) {
        if (!key.remoteJid || !key.id) continue;
        if (update.message === null) this.edit(key.remoteJid, key.id, '[Сообщение удалено]', true);
        else if (update.message) { const m = extractText(update.message); if (m) this.edit(key.remoteJid, key.id, m.text); }
      }
    });
    socket.ev.on('connection.update', update => {
      if (this.stopping || socket !== this.socket) return;
      if (update.qr) { this.qr = { value: update.qr, at: Date.now() }; this.status('scan_qr'); }
      if (update.connection === 'open') {
        this.qr = undefined; this.reconnects = 0; this.status('connected');
        this.service.store.set('wa:lastConnected', new Date().toISOString());
        void this.refreshGroups().then(() => { if (!this.stopping) this.onConnected?.(); });
      }
      if (update.connection === 'close') {
        this.qr = undefined;
        const error = update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        const code = error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.connectionReplaced || code === DisconnectReason.badSession) {
          this.status(`needs_attention:${code}`); return;
        }
        this.status('reconnecting');
        const wait = Math.min(60000, 1500 * 2 ** Math.min(this.reconnects++, 5));
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.connect().catch(() => this.status('connection_failed')); }, wait);
      }
    });
    } finally { this.connecting = false; }
  }
}
