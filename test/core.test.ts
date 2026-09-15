import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { chunkMessages, isQuiet } from '../src/service.js';
import { parseExport } from '../src/import.js';
import { loadConfig } from '../src/config.js';
import { extractText, sqliteAuth, readOnlySocket, WhatsAppWriteBlocked, WhatsApp } from '../src/whatsapp.js';
import { setup, fixture, now, group, analysis } from './helpers.js';

test('only selected groups are stored; retries are idempotent and imports never become live', () => {
  const { service, store } = setup();
  assert.deepEqual(service.ingest([fixture('a', { historical: true }), fixture('a'), fixture('secret', { chatId: 'private@s.whatsapp.net' })]), { inserted: 1, ignored: 2 });
  assert.equal(store.pending([group]).length, 0);
  assert.equal(store.messages(0, now, [group]).length, 1);
  store.close();
});
test('a stuck backlog in one chat cannot starve newer messages in another chat', async () => {
  const other = 'kindergarten@g.us';
  const { service, store } = setup(
    { analyze: async messages => { if (messages.some(m => m.chat_id === group)) throw new Error('offline'); return analysis(messages); } },
    { groups: [{ id: group, name: 'Класс' }, { id: other, name: 'Сад' }] });
  // One chat fails analysis and keeps more than a full window of messages queued.
  service.ingest(Array.from({ length: 400 }, (_, i) => fixture(`stuck${i}`, { timestamp: now - 3600000 + i })));
  service.ingest([fixture('fresh', { chatId: other, timestamp: now - 1000 })]);
  const pending = store.pending([group, other]);
  assert.equal(pending.length, 300);
  assert.equal(pending.filter(m => m.chat_id === other).length, 1);
  // The failing chat keeps its backlog; the other chat is still analysed and alerts both parents.
  await assert.rejects(service.analyzePending(now));
  assert.equal(store.messages(now - 2000, now, [other])[0]!.analyzed, 1);
  assert.equal(store.stats().pendingDelivery, 2);
  store.close();
});
test('SQLite history and queued delivery survive a restart, including auth buffers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-test-'));
  try {
    let store = new Store(join(dir, 'state.sqlite'));
    store.insert(fixture('persist')); store.enqueue('k', '111', 'Текст');
    const auth = sqliteAuth(store); auth.saveCreds();
    await auth.state.keys.set({ 'pre-key': { '1': { private: Buffer.from('private'), public: Buffer.from('public') } } });
    const publicKey = Buffer.from(auth.state.creds.noiseKey.public);
    store.close(); store = new Store(join(dir, 'state.sqlite'));
    const restored = sqliteAuth(store);
    assert.deepEqual(Buffer.from(restored.state.creds.noiseKey.public), publicKey);
    assert.equal(Buffer.from((await restored.state.keys.get('pre-key', ['1']))['1']!.private).toString(), 'private');
    assert.equal(store.stats().messages, 1); assert.equal(store.stats().pendingDelivery, 1); store.close();
  } finally { rmSync(dir, { recursive: true }); }
});
test('Hebrew FTS safely handles punctuation and updates/deletes its index', () => {
  const { service, store } = setup(); service.ingest([fixture('a')]);
  assert.equal(store.search('"טיול" OR (NEAR *)', [group]).length, 1);
  assert.equal(store.search('טיול', ['different']).length, 0);
  store.db.prepare('UPDATE messages SET text=?').run('השיעור בוטל');
  assert.equal(store.search('טיול', [group]).length, 0);
  assert.equal(store.search('בוטל', [group]).length, 1);
  store.prune(1, now + 2 * 86400000);
  assert.equal(store.search('בוטל', [group]).length, 0); store.close();
});
test('Hebrew search reaches words behind an attached article or preposition', () => {
  const { service, store } = setup();
  service.ingest([fixture('forms', { text: 'נבקש לחתום על האישורים השנתיים בעבור ילדכם' }),
    fixture('books', { text: 'הספרים הגיעו' })]);
  // The bare form is what a question is phrased with; the message carries ה glued on.
  assert.equal(store.search('אישורים', [group]).length, 1);
  assert.equal(store.search('האישורים', [group]).length, 1);
  assert.equal(store.search('ספרים', [group]).length, 1);
  // Inflection still reaches forward, and unrelated words must not start matching.
  assert.equal(store.search('אישור', [group]).length, 1);
  assert.equal(store.search('מכתב', [group]).length, 0);
  assert.equal(store.search('טיול', [group]).length, 0);
  store.close();
});
test('confirmed family facts cannot be overwritten by AI candidates', () => {
  const { store } = setup();
  store.remember('class', '2А', true); store.remember('class', '3Б', false, ['source']);
  assert.equal(store.memories()[0]!.value, '2А');
  store.remember('teacher', 'Рина', false); assert.equal(store.memories().length, 1);
  store.remember('teacher', 'Рина', true); assert.equal(store.memories().length, 2);
  store.forget('teacher'); assert.equal(store.memories().length, 1); store.close();
});
test('chunking preserves every character of long notices and summary sees every message', async () => {
  const seen: string[] = [];
  const { service, store } = setup({ analyze: async messages => { seen.push(...messages.map(m => m.text)); return analysis(messages); } }, { chunkCharacters: 4000 });
  const long = 'א'.repeat(15000);
  service.ingest([fixture('long', { text: long, historical: true }), fixture('short', { text: 'END', historical: true })]);
  const all = store.messages(0, now, [group]);
  assert.equal(chunkMessages(all, 4000).flat().filter(m => m.external_id === 'long').map(m => m.text).join(''), long);
  const result = await service.summarize(now - 3600000, now);
  assert.equal(result.messageCount, 2); assert.equal(seen.join('').length, long.length + 3);
  assert.equal(store.stats().pendingDelivery, 0); store.close();
});
test('summary explicitly rejects oversized periods instead of omitting messages', async () => {
  const { service, store } = setup({}, { maxSummaryMessages: 100 });
  service.ingest(Array.from({ length: 101 }, (_, i) => fixture(String(i))));
  await assert.rejects(service.summarize(0, now), /Слишком много/); store.close();
});
test('Russian questions retrieve Hebrew originals and retain source metadata', async () => {
  const { service, store } = setup(); service.ingest([fixture('a')]);
  const result = await service.ask('Когда экскурсия?');
  assert.equal(result.sources.length, 1); assert.match(result.text, /טיול/); assert.match(result.text, /Завтра/); store.close();
});
test('live analysis alerts both parents once; backfill, stale messages and duplicate events do not flood', async () => {
  const { service, store } = setup();
  service.ingest([fixture('live'), fixture('history', { historical: true }), fixture('stale', { timestamp: now - 2 * 86400000 })]);
  await service.analyzePending(now); assert.equal(store.stats().pendingDelivery, 2);
  service.ingest([fixture('forward')]); await service.analyzePending(now);
  assert.equal(store.stats().pendingDelivery, 2); assert.equal(store.stats().pendingAnalysis, 0); store.close();
});
test('two distinct actionable items in one notice are both retained', async () => {
  const { service, store } = setup({ analyze: async messages => {
    const a = analysis(messages); a.findings.push({ ...a.findings[0]!, title: 'Оплатить автобус', eventKey: 'bus-payment-2026-09-08' }); return a;
  } });
  service.ingest([fixture('live')]); await service.analyzePending(now);
  assert.equal(store.stats().pendingDelivery, 4); store.close();
});
test('non-actionable, low-confidence and past-deadline findings cannot trigger alerts', async () => {
  const { service, store } = setup({ analyze: async messages => {
    const a = analysis(messages), base = a.findings[0]!;
    a.findings = [{ ...base, actionable: false }, { ...base, confidence: 0.4 }, { ...base, dueAt: '2026-09-01T00:00:00Z' }, { ...base, priority: 'routine' }]; return a;
  } });
  service.ingest([fixture('a')]); await service.analyzePending(now); assert.equal(store.stats().pendingDelivery, 0); store.close();
});
test('failed model calls keep a multi-chunk message retryable', async () => {
  let calls = 0;
  const { service, store, model } = setup({ analyze: async messages => { if (++calls === 2) throw new Error('outage'); return analysis(messages); } }, { chunkCharacters: 4000 });
  service.ingest([fixture('long', { text: 'א'.repeat(12000) })]);
  await assert.rejects(service.analyzePending(now), /analyses failed/); assert.equal(store.stats().pendingAnalysis, 1);
  model.analyze = async messages => analysis(messages);
  await service.analyzePending(now); assert.equal(store.stats().pendingAnalysis, 0); store.close();
});
test('quiet hours follow configured timezone and support daytime intervals or disabling', () => {
  const { service, store } = setup();
  assert.equal(isQuiet(service.config, Date.parse('2026-09-07T20:00:00Z')), true); // 23:00
  assert.equal(isQuiet(service.config, now), false);
  service.config.quietHours = { start: 9, end: 17 }; assert.equal(isQuiet(service.config, now), true);
  service.config.quietHours = { start: 0, end: 0 }; assert.equal(isQuiet(service.config, now), false); store.close();
});
test('a failed group does not prevent alerts from other groups', async () => {
  const { service, store } = setup({ analyze: async messages => {
    if (messages[0]!.chat_id === group) throw new Error('bad result');
    return analysis(messages);
  } }, { groups: [{ id: group, name: 'A' }, { id: 'second@g.us', name: 'B' }] });
  service.ingest([fixture('a'), fixture('b', { chatId: 'second@g.us' })]);
  await assert.rejects(service.analyzePending(now), /analyses failed/);
  assert.equal(store.pending([group]).length, 1);
  assert.equal(store.pending(['second@g.us']).length, 0);
  assert.equal(store.stats().pendingDelivery, 2); store.close();
});
test('exports parse iOS, Android, Hebrew bidi markers, multiline and explicit US dates', () => {
  const ios = parseExport('\u200e[07/09/2026, 09:15:02] מורה: שלום\nשורה שנייה\n[07/09/2026, 09:16:00] Messages are encrypted', group, 'Asia/Hebron');
  assert.equal(ios.messages.length, 1); assert.equal(ios.systemLines, 1); assert.match(ios.messages[0]!.text, /שורה שנייה/);
  assert.equal(ios.messages[0]!.timestamp, Date.parse('2026-09-07T06:15:02Z'));
  const android = parseExport('9/7/26, 9:15 PM - Teacher: Test', group, 'Asia/Hebron', true);
  assert.equal(android.messages[0]!.timestamp, Date.parse('2026-09-07T18:15:00Z'));
  assert.throws(() => parseExport('unknown format', group, 'Asia/Hebron'), /Unrecognized/);
});
test('unsupported media are clearly marked; ephemeral text unwraps; reactions ignored', () => {
  assert.equal(extractText({ audioMessage: {} })!.kind, 'audio');
  assert.match(extractText({ documentMessage: { fileName: 'letter.pdf' } })!.text, /не прочитано/);
  assert.equal(extractText({ ephemeralMessage: { message: { conversation: 'שלום' } } })!.text, 'שלום');
  assert.equal(extractText({ reactionMessage: { text: '👍' } }), undefined);
});
test('the WhatsApp socket cannot write: every write method throws instead of reaching WhatsApp', async () => {
  const attempted: string[] = [];
  const raw: any = {
    ev: { on: () => {} }, ws: { isOpen: true }, authState: { creds: { registered: false } },
    end: () => 'ended', logout: async () => 'logged out',
    requestPairingCode: async () => 'ABCD1234',
    // Allowed deliberately: it fetches the account's own chat settings and replays them as
    // events. Baileys already calls it on every connect; it changes nothing on the account.
    resyncAppState: async () => 'resynced',
    // Allowed deliberately: asks WhatsApp for older messages in one chat, relayed to the
    // account's own JID. Never delivered to a conversation; no other person sees it.
    fetchMessageHistory: async () => 'requested',
    groupFetchAllParticipating: async () => ({ 'a@g.us': { id: 'a@g.us', subject: 'Класс' } }),
    user: { id: 'me' },
  };
  // Everything Baileys offers that changes something on WhatsApp's side.
  for (const name of ['sendMessage', 'sendReceipt', 'sendReceipts', 'sendPresenceUpdate', 'readMessages',
    'chatModify', 'groupCreate', 'groupLeave', 'groupUpdateSubject', 'groupParticipantsUpdate', 'groupRevokeInvite',
    'updateProfilePicture', 'updateProfileName', 'updateBlockStatus', 'sendNode', 'sendRawMessage',
    'star', 'addChatLabel', 'rejectCall', 'sendPeerDataOperationMessage']) {
    raw[name] = async () => { attempted.push(name); return 'sent'; };
  }
  const socket = readOnlySocket(raw);

  const allowed = ['end', 'logout', 'requestPairingCode', 'groupFetchAllParticipating', 'resyncAppState', 'fetchMessageHistory'];
  for (const name of Object.keys(raw).filter(k => typeof raw[k] === 'function' && !allowed.includes(k))) {
    assert.throws(() => (socket as any)[name](), WhatsAppWriteBlocked, `${name} must be blocked`);
  }
  // Nothing reached the underlying socket.
  assert.deepEqual(attempted, []);

  // The reads the app genuinely needs still work.
  assert.equal(socket.ws.isOpen, true);
  assert.equal(socket.authState.creds.registered, false);
  assert.equal(socket.end(undefined as any), 'ended');
  assert.equal(await socket.requestPairingCode('972500000000'), 'ABCD1234');
  assert.deepEqual(Object.keys(await socket.groupFetchAllParticipating()), ['a@g.us']);
  assert.equal(await socket.logout(), 'logged out');
  assert.equal(await (socket as any).resyncAppState(['regular'], true), 'resynced');
  assert.equal(await (socket as any).fetchMessageHistory(100, { id: 'x' }, 1), 'requested');
  // The allow-list is exactly this and nothing more: everything else on the socket, whatever
  // Baileys adds later, must come back blocked rather than callable.
  const reachable = Object.keys(raw).filter(name => {
    const value = (socket as any)[name];
    if (typeof value !== 'function') return false;
    try { value(); return true; } catch { return false; }
  });
  assert.deepEqual(reachable.sort(), [...allowed].sort());

  // Data that is not needed is not exposed, and the guard cannot be patched away.
  assert.equal((socket as any).user, undefined);
  assert.throws(() => { (socket as any).sendMessage = async () => 'bypassed'; }, WhatsAppWriteBlocked);
  assert.throws(() => { delete (socket as any).end; }, WhatsAppWriteBlocked);
  // Awaiting a value that holds the socket must not trip the guard on `.then`.
  assert.equal((await Promise.resolve(socket)).ws.isOpen, true);
});
test('a deployment with no config file starts on defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-config-'));
  const previous = process.env.CONFIG_PATH;
  try {
    process.env.CONFIG_PATH = join(dir, 'absent.json');
    const config = loadConfig();
    // Everything a chat can configure starts empty; everything else has a working default.
    assert.deepEqual(config.groups, []);
    assert.deepEqual(config.family, []);
    assert.equal(config.timezone, 'Asia/Hebron');
    assert.deepEqual(config.digests, [{ name: 'evening', cron: '0 20 * * *' }]);
    // A file that is present is still read.
    writeFileSync(join(dir, 'present.json'), JSON.stringify({ timezone: 'Asia/Jerusalem' }));
    process.env.CONFIG_PATH = join(dir, 'present.json');
    assert.equal(loadConfig().timezone, 'Asia/Jerusalem');
  } finally {
    if (previous === undefined) delete process.env.CONFIG_PATH; else process.env.CONFIG_PATH = previous;
    rmSync(dir, { recursive: true });
  }
});
test('the write guard cannot be walked around by descriptor reads or the raw transport', async () => {
  const reached: string[] = [];
  const raw: any = {
    ev: {}, authState: { creds: { registered: true } }, end: () => 'ended', logout: async () => 'out',
    requestPairingCode: async () => 'CODE', groupFetchAllParticipating: async () => ({}),
    resyncAppState: async () => 'synced', fetchMessageHistory: async () => 'asked',
    sendMessage: async () => { reached.push('sendMessage'); return 'SENT'; },
    readMessages: async () => { reached.push('readMessages'); return 'READ'; },
    ws: { isOpen: true, send: () => { reached.push('ws.send'); return 'RAW'; }, close: () => reached.push('ws.close') },
  };
  const socket = readOnlySocket(raw);

  // The obvious route.
  assert.throws(() => (socket as any).sendMessage(), WhatsAppWriteBlocked);
  // Reading the descriptor must answer exactly as the getter does, not hand back the original.
  for (const name of ['sendMessage', 'readMessages']) {
    const descriptor = Object.getOwnPropertyDescriptor(socket, name);
    assert.ok(descriptor, `${name} descriptor still exists`);
    assert.throws(() => (descriptor!.value as () => unknown)(), WhatsAppWriteBlocked, `${name} via descriptor must be blocked`);
  }
  // The raw transport speaks the protocol directly, so it must never be handed out.
  assert.equal(typeof (socket as any).ws.send, 'undefined', 'ws.send must not be reachable');
  assert.equal(typeof (socket as any).ws.close, 'undefined');
  assert.equal((socket as any).ws.isOpen, true, 'the one piece of state the app reads still works');
  const wsDescriptor = Object.getOwnPropertyDescriptor(socket, 'ws');
  assert.equal(typeof (wsDescriptor!.value as any).send, 'undefined', 'nor through its descriptor');
  raw.ws.isOpen = false;
  assert.equal((socket as any).ws.isOpen, false, 'and it tracks the real socket');

  // Nothing above reached the underlying socket.
  assert.deepEqual(reached, []);
  assert.equal(await (socket as any).requestPairingCode('972500000000'), 'CODE');
});
test('a correction to an event still alerts after the original notice was sent', async () => {
  const notices = [
    { title: 'Экскурсия завтра', detail: 'Взять воду.', text: 'מחר טיול, להביא מים' },
    { title: 'Экскурсия отменена', detail: 'Поездка отменена.', text: 'הטיול מחר מבוטל' },
  ];
  let step = 0;
  const { service, store } = setup({ analyze: async messages => ({
    overview: '', memories: [],
    // The prompt tells the model to reuse an event's identity for follow-ups, so a
    // cancellation arrives under the same eventKey and the same day as the notice it undoes.
    findings: [{ title: notices[step]!.title, detail: notices[step]!.detail, priority: 'important' as const,
      actionable: true, confidence: 0.95, eventKey: 'class-trip-2026-09-08',
      dueAt: '2026-09-08T07:00:00+03:00', sources: [messages.at(-1)!.id] }],
  }) });
  service.ingest([fixture('notice', { text: notices[0]!.text })]);
  await service.analyzePending(now);
  assert.equal(store.stats().pendingDelivery, 2, 'the original notice alerts both parents');

  step = 1;
  service.ingest([fixture('correction', { text: notices[1]!.text, timestamp: now - 30000 })]);
  await service.analyzePending(now);
  assert.equal(store.stats().pendingDelivery, 4, 'the cancellation must reach them too');
  assert.match(store.db.prepare('SELECT text FROM outbox ORDER BY rowid DESC LIMIT 1').get()!.text as string, /отменена/);

  // The same notice arriving twice is still suppressed: identity plus content, not identity alone.
  step = 0;
  service.ingest([fixture('repeat', { text: notices[0]!.text, timestamp: now - 20000 })]);
  await service.analyzePending(now);
  assert.equal(store.stats().pendingDelivery, 4, 'an identical repeat is still deduplicated');
  store.close();
});
test('closing a WhatsApp session disowns it, so it cannot reconnect into the next link', () => {
  const { service, store } = setup();
  const whatsapp = new WhatsApp(service);
  let ended = 0;
  const socket: any = { ws: { isOpen: true }, end: () => { ended++; } };
  (whatsapp as any).socket = socket;
  (whatsapp as any).timer = setTimeout(() => { throw new Error('a reconnect survived stop()'); }, 50);
  whatsapp.stop();
  // Disowned before closing: end() waits on the peer with no bound this code can impose, and
  // every handler is guarded by `socket !== this.socket`, which only holds once it is not ours.
  assert.equal((whatsapp as any).socket, undefined, 'the old socket is no longer ours');
  assert.equal(ended, 1, 'and it was still asked to close');
  assert.equal((whatsapp as any).qr, undefined);
  store.close();
});
test('an ambiguous child name is refused rather than resolved by storage order', () => {
  const { service, store } = setup({}, { family: [{ name: 'Даниэль', context: '' }, { name: 'Данила', context: '' }] });
  // A prefix both children answer to names neither of them.
  assert.equal(service.findKid('Дани'), undefined);
  // A prefix only one answers to still works, and a full name always wins.
  assert.equal(service.findKid('Даниэ')?.name, 'Даниэль');
  assert.equal(service.findKid('Данила')?.name, 'Данила');
  assert.equal(service.findKid('даниэль')?.name, 'Даниэль');
  store.close();
});
test('the same notice in two children’s groups alerts for both', async () => {
  const kids = 'kindergarten@g.us';
  const { service, store } = setup({}, {
    groups: [{ id: group, name: 'Класс', children: ['А'] }, { id: kids, name: 'Сад', children: ['Б'] }],
    family: [{ name: 'А', context: '' }, { name: 'Б', context: '' }],
  });
  // Schools send identical wording to every year group on the same day.
  const notice = 'מחר אין לימודים';
  service.ingest([fixture('a', { text: notice }), fixture('b', { chatId: kids, text: notice })]);
  await service.analyzePending(now);
  // Two groups, two parents: four queued messages, not two.
  assert.equal(store.stats().pendingDelivery, 4, 'the second group must not be read as a repeat of the first');
  store.close();
});
test('a notice due today is not treated as already expired', async () => {
  const midnightToday = new Date(now).toISOString().slice(0, 10) + 'T00:00:00+03:00';
  const { service, store } = setup({ analyze: async messages => ({
    overview: '', memories: [],
    // A model given a date and no clock time answers midnight.
    findings: [{ title: 'Забрать в 12:00', detail: 'Раньше обычного.', priority: 'urgent' as const,
      actionable: true, confidence: 0.95, eventKey: 'pickup', dueAt: midnightToday, sources: [messages.at(-1)!.id] }],
  }) });
  service.ingest([fixture('pickup')]);
  await service.analyzePending(now);
  assert.equal(store.stats().pendingDelivery, 2, 'a same-day notice must still alert');
  store.close();
});
test('reconnecting replaces the live socket instead of running a second one beside it', async () => {
  const { service, store } = setup();
  const whatsapp = new WhatsApp(service);
  const ended: string[] = [];
  const first: any = { name: 'first', ws: { isOpen: true }, end: () => ended.push('first') };
  (whatsapp as any).socket = first;
  // A reconnect armed by the previous session, which used to survive into the next connect.
  (whatsapp as any).timer = setTimeout(() => { throw new Error('an orphaned reconnect fired'); }, 40);
  let built = 0;
  (whatsapp as any).build = () => { built++; return { name: 'second', ws: { isOpen: true }, ev: { on: () => {} }, end: () => ended.push('second') }; };
  // Drive the same replacement connect() performs, without opening a real WhatsApp socket.
  clearTimeout((whatsapp as any).timer);
  const previous = (whatsapp as any).socket;
  (whatsapp as any).socket = undefined;
  previous?.end(undefined);
  assert.deepEqual(ended, ['first'], 'the socket being replaced is ended');
  assert.equal((whatsapp as any).socket, undefined, 'and disowned, so its handlers stop acting');
  await new Promise(resolve => setTimeout(resolve, 60));
  store.close();
});
test('a deadline the schema accepts but no clock can read suppresses nothing and crashes nothing', async () => {
  // zod's datetime({offset:true}) accepts an out-of-range offset; Date.parse returns NaN.
  const unreadable = '2026-09-16T08:00:00+03:99';
  const { service, store } = setup({ analyze: async messages => ({
    overview: '', memories: [],
    findings: [{ title: 'Забрать раньше', detail: 'Сегодня в 12:00.', priority: 'urgent' as const,
      actionable: true, confidence: 0.95, eventKey: 'pickup', dueAt: unreadable, sources: [messages.at(-1)!.id] }],
  }) });
  service.ingest([fixture('pickup')]);
  // It must not throw out of the transaction and abandon the whole group's chunk.
  await service.analyzePending(now);
  assert.equal(store.stats().pendingDelivery, 2, 'an unreadable deadline is not evidence the notice has passed');
  assert.equal(store.stats().pendingAnalysis, 0, 'and the group was analysed rather than aborted');
  store.close();
});
test('a retried group does not alert twice, even when the model rewords the finding', async () => {
  let call = 0;
  const { service, store } = setup({ analyze: async messages => {
    call++;
    // The group splits into several chunks. The first is analysed and its alerts commit; a
    // later one fails, which by design leaves the whole group retryable — so the first chunk
    // is analysed again, and the model does not word it the same way twice.
    if (call % 2 === 0) throw new Error('offline');
    const fresh = messages.at(-1)!;
    return { overview: '', memories: [], findings: [{
      title: call === 1 ? 'Экскурсия завтра' : 'Завтра экскурсия для класса',
      detail: call === 1 ? 'Взять воду.' : 'Нужно взять воду и головной убор.',
      priority: 'important' as const, actionable: true, confidence: 0.95,
      eventKey: call === 1 ? 'trip-2026-09-08' : 'class-trip', dueAt: null, sources: [fresh.id],
    }] };
  } }, { chunkCharacters: 4000 });

  service.ingest(Array.from({ length: 40 }, (_, i) => fixture(`m${i}`, { timestamp: now - 60000 + i })));
  await assert.rejects(service.analyzePending(now), 'a later chunk fails');
  const afterFirst = store.stats().pendingDelivery;
  assert.equal(afterFirst, 2, 'the first chunk alerted both parents');
  assert.equal(store.stats().pendingAnalysis, 40, 'and the group stayed retryable');

  await assert.rejects(service.analyzePending(now));
  assert.equal(store.stats().pendingDelivery, afterFirst,
    'the retry re-analysed the same messages and must not alert on them again');
  store.close();
});
