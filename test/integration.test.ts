import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildApi } from '../src/api.js';
import { Telegram } from '../src/telegram.js';
import { Menu } from '../src/menu.js';
import { hash } from '../src/db.js';
// Buttons address a group or a child by identity, never by position in a rendered list.
const id = (value: string) => hash(value).slice(0, 12);
import { WhatsApp } from '../src/whatsapp.js';
import { Scheduler, nextRun } from '../src/scheduler.js';
import { JsonModel } from '../src/llm.js';
import { validateConfig } from '../src/config.js';
import { setup, fixture, now, group, analysis } from './helpers.js';

const token = 'test-token-'.repeat(4);
const telegramEnv = { telegramToken: 'fake-token', telegramChats: ['111', '222'], telegramUsers: ['11', '22'] };

test('API authenticates all private routes, validates input, and forces imports to be historical', async () => {
  const { service, store } = setup(); const app = buildApi(service, token);
  try {
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    assert.equal((await app.inject('/status')).statusCode, 401);
    const headers = { authorization: `Bearer ${token}` };
    const invalid = await app.inject({ method: 'POST', url: '/import', headers, payload: [fixture('bad', { timestamp: -5 })] });
    assert.equal(invalid.statusCode, 400);
    const response = await app.inject({ method: 'POST', url: '/import', headers, payload: [fixture('a', { historical: false, timestamp: Date.now() - 60000 })] });
    assert.equal(response.statusCode, 200); assert.equal(response.json().inserted, 1);
    assert.equal(store.stats().pendingAnalysis, 0);
    const search = await app.inject({ url: '/search?q=' + encodeURIComponent('טיול'), headers });
    assert.equal(search.json().length, 1);
    const noSource = await app.inject({ url: '/sources/missing', headers }); assert.equal(noSource.statusCode, 404);
    const put = await app.inject({ method: 'PUT', url: '/memory', headers, payload: { key: 'class', value: '2А' } }); assert.equal(put.statusCode, 200);
  } finally { await app.close(); store.close(); }
});
test('API never echoes provider secrets or raw model failure details', async () => {
  const { service, store } = setup({ analyze: async () => { throw new Error('secret-api-key and child details'); } });
  service.ingest([fixture('a')]); const app = buildApi(service, token);
  try {
    const response = await app.inject({ method: 'POST', url: '/summary', headers: { authorization: `Bearer ${token}` }, payload: { from: '2026-09-07T00:00:00Z', to: '2026-09-08T00:00:00Z' } });
    assert.equal(response.statusCode, 503); assert.doesNotMatch(response.body, /secret-api-key/);
  } finally { await app.close(); store.close(); }
});
test('Telegram requires both user and chat allowlists and persists offset with reply', async () => {
  const { service, store } = setup(); const bot = new Telegram(service, telegramEnv);
  await bot.handle({ update_id: 1, message: { chat: { id: 111 }, from: { id: 99 }, text: '/summary 24h' } });
  await bot.handle({ update_id: 2, message: { chat: { id: 999 }, from: { id: 11 }, text: '/memory' } });
  assert.equal(store.stats().pendingDelivery, 0);
  const update = { update_id: 3, message: { chat: { id: 11, type: 'private' }, from: { id: 11 }, text: '/remember class = 2А' } };
  await bot.handle(update); await bot.handle(update);
  assert.equal(store.memories()[0]!.value, '2А'); assert.equal(store.stats().pendingDelivery, 1);
  assert.equal(store.get('telegram:offset', 0), 4); store.close();
});
test('the group takes requests and broadcasts; configuration only happens in a direct chat', async () => {
  const { service, store } = setup({}, { family: [] });
  const wa = fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }]);
  const sent: any[] = [];
  const request = (async (url: string, init: RequestInit) => { sent.push({ method: String(url).split('/').pop(), body: JSON.parse(String(init.body)) }); return Response.json({ ok: true, result: {} }); }) as unknown as typeof fetch;
  const bot = new Telegram(service, telegramEnv, request, wa.control);
  // Management in the shared group is refused and says where to go instead.
  await bot.handle({ update_id: 1, message: { chat: { id: 111, type: 'supergroup' }, from: { id: 11 }, text: '/kid add Даниэль' } });
  await bot.deliver();
  assert.match(sent.at(-1)!.body.text, /в личном чате/);
  assert.deepEqual(service.family, []);
  // /start in the group explains itself rather than opening a settings menu.
  await bot.handle({ update_id: 2, message: { chat: { id: 111, type: 'supergroup' }, from: { id: 11 }, text: '/start' } });
  await bot.deliver();
  assert.equal(sent.at(-1)!.body.reply_markup, undefined);
  assert.match(sent.at(-1)!.body.text, /сводки/);
  // A button pressed in the group is answered with an alert and changes nothing.
  await bot.handle({ update_id: 3, callback_query: { id: 'c1', data: 'kid_add', from: { id: 11 }, message: { message_id: 7, chat: { id: 111, type: 'supergroup' } } } });
  assert.match(sent.at(-1)!.body.text, /в личном чате/);
  assert.equal(sent.at(-1)!.body.show_alert, true);
  assert.equal(store.get('pending:111', null), null);
  assert.ok(!sent.some(x => x.method === 'editMessageText'));
  // Requests still work in the group.
  await bot.handle({ update_id: 4, message: { chat: { id: 111, type: 'supergroup' }, from: { id: 11 }, text: '/memory' } });
  await bot.deliver();
  assert.doesNotMatch(sent.at(-1)!.body.text, /в личном чате/);
  // The same command in the parent's own chat is accepted, and the reply reaches them.
  await bot.handle({ update_id: 5, message: { chat: { id: 11, type: 'private' }, from: { id: 11 }, text: '/kid add Даниэль' } });
  await bot.deliver();
  assert.deepEqual(service.family.map(k => k.name), ['Даниэль']);
  assert.equal(sent.at(-1)!.body.chat_id, '11');
  store.close();
});
test('outbox retries failed recipients without resending successful recipients', async () => {
  const { service, store } = setup(); const sent: string[] = [];
  let fail = true;
  const request = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (body.chat_id === '222' && fail) return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 120 } }, { status: 429 });
    sent.push(body.chat_id); return Response.json({ ok: true, result: {} });
  }) as typeof fetch;
  const bot = new Telegram(service, telegramEnv, request);
  store.enqueue('notice', '111', 'Hello', false, true, now); store.enqueue('notice', '222', 'Hello', false, true, now);
  await bot.deliver(now); assert.deepEqual(sent, ['111']); assert.equal(store.stats().pendingDelivery, 1);
  fail = false; await bot.deliver(now + 1000); assert.deepEqual(sent, ['111']);
  await bot.deliver(now + 121000); assert.deepEqual(sent, ['111', '222']); assert.equal(store.stats().pendingDelivery, 0); store.close();
});
test('quiet hours delay normal alerts but allow urgent notices and direct replies', async () => {
  const { service, store } = setup(); const sent: string[] = [];
  const bot = new Telegram(service, telegramEnv, (async (_url: unknown, init: RequestInit) => { sent.push(JSON.parse(init.body as string).text); return Response.json({ ok: true, result: {} }); }) as typeof fetch);
  store.enqueue('normal', '111', 'normal', false, false, now); store.enqueue('urgent', '111', 'urgent', false, true, now);
  await bot.deliver(Date.parse('2026-09-07T20:00:00Z')); assert.deepEqual(sent, ['urgent']); assert.equal(store.stats().pendingDelivery, 1); store.close();
});
test('failed multipart delivery blocks later parts until retry, without starving urgent replies', async () => {
  const { service, store } = setup(); const sent: string[] = [];
  const bot = new Telegram(service, telegramEnv, (async (_url: unknown, init: RequestInit) => { sent.push(JSON.parse(init.body as string).text); return Response.json({ ok: true, result: {} }); }) as typeof fetch);
  store.enqueue('long', '111', 'A'.repeat(1800) + 'SECOND', false, false, now);
  store.db.prepare('UPDATE outbox SET next_at=? WHERE rowid=(SELECT min(rowid) FROM outbox)').run(now + 60000);
  store.enqueue('reply', '111', 'reply', false, true, now);
  await bot.deliver(now); assert.deepEqual(sent, ['reply']); store.close();
});
test('Telegram splitting keeps emoji under message limits and enqueue is idempotent', () => {
  const { store } = setup(); const text = '😀'.repeat(5000);
  store.enqueue('long', '111', text); store.enqueue('long', '111', text);
  const rows = store.db.prepare('SELECT text FROM outbox ORDER BY rowid').all();
  assert.equal(rows.length, 3); assert.equal(rows.map(r => r.text).join(''), text);
  assert.ok(rows.every(r => String(r.text).length < 4096)); store.close();
});
test('scheduled digests persist boundaries across restarts and do not repeat a completed slot', async () => {
  const { service, store } = setup(); service.ingest([fixture('a', { historical: true })]);
  const scheduler = new Scheduler(service);
  const before = Date.parse('2026-09-07T16:59:00Z'), due = Date.parse('2026-09-07T17:00:00Z');
  await scheduler.tick(before); await scheduler.tick(due);
  assert.equal(store.stats().pendingDelivery, 2);
  await new Scheduler(service).tick(due + 1000); assert.equal(store.stats().pendingDelivery, 2);
  assert.equal(store.get<any>('schedule:evening', null).from, due); store.close();
});
test('missed schedule catches up once; failed first digest preserves its original start boundary', async () => {
  const { service, store, model } = setup({ analyze: async () => { throw new Error('offline'); } });
  service.ingest([fixture('a', { historical: true })]);
  const scheduler = new Scheduler(service), due = Date.parse('2026-09-07T17:00:00Z');
  await scheduler.tick(due - 60000); await scheduler.tick(due);
  const failed = store.get<any>('schedule:evening', null); assert.equal(failed.next, due); assert.equal(failed.from, due - 86400000);
  model.analyze = async messages => analysis(messages);
  await new Scheduler(service).tick(due + 3600000);
  assert.equal(store.stats().pendingDelivery, 2); assert.equal(store.get<any>('schedule:evening', null).from, due + 3600000); store.close();
});
test('a digest that always fails is skipped after its attempt budget instead of retrying forever', async () => {
  const { service, store } = setup({ analyze: async () => { throw new Error('too many messages'); } }, { maxDigestAttempts: 2 });
  service.ingest([fixture('a', { historical: true })]);
  const scheduler = new Scheduler(service), due = Date.parse('2026-09-07T17:00:00Z');
  await scheduler.tick(due - 60000); await scheduler.tick(due);
  const retrying = store.get<any>('schedule:evening', null);
  assert.equal(retrying.attempts, 1); assert.equal(retrying.next, due); assert.equal(retrying.retryAt, due + 300000);
  assert.equal(store.stats().pendingDelivery, 0);
  await scheduler.tick(due + 300000);
  const skipped = store.get<any>('schedule:evening', null);
  assert.equal(skipped.attempts, 0); assert.equal(skipped.from, due + 300000);
  assert.equal(skipped.next, Date.parse('2026-09-08T17:00:00Z'));
  assert.match(store.get<string>('schedule:evening:error', ''), /skipped/);
  // Both parents are told the period was dropped rather than losing it silently.
  assert.equal(store.stats().pendingDelivery, 2);
  await scheduler.tick(due + 600000);
  assert.equal(store.stats().pendingDelivery, 2); store.close();
});
test('cron timezone changes offset correctly across DST', () => {
  assert.equal(nextRun('0 20 * * *', 'Asia/Jerusalem', Date.parse('2026-07-01T00:00:00Z')), Date.parse('2026-07-01T17:00:00Z'));
  assert.equal(nextRun('0 20 * * *', 'Asia/Jerusalem', Date.parse('2026-12-01T00:00:00Z')), Date.parse('2026-12-01T18:00:00Z'));
  assert.throws(() => validateConfig({ groups: [{ id: group, name: 'a' }, { id: group, name: 'b' }] }), /Duplicate/);
});
test('real model adapter validates JSON schema and rejects fabricated source citations', async () => {
  const { store, service } = setup(); service.ingest([fixture('a')]); const messages = store.messages(0, now, [group]);
  let payload: any;
  const model = new JsonModel({ llmBaseUrl: 'http://mock/v1', llmApiKey: 'mock', llmModel: 'model', llmJsonMode: true }, (async (_url: unknown, init: RequestInit) => {
    payload = JSON.parse(init.body as string); const a = analysis(messages); a.findings[0]!.sources = ['fabricated'];
    return Response.json({ choices: [{ message: { content: JSON.stringify(a) }, finish_reason: 'stop' }] });
  }) as typeof fetch);
  await assert.rejects(model.analyze(messages, {}), /unknown source/);
  assert.deepEqual(payload.response_format, { type: 'json_object' }); assert.match(payload.messages[0].content, /UNTRUSTED DATA/); store.close();
});
test('Hermes MCP handshake discovers tools and reads authenticated service through stdio', async () => {
  const { service, store } = setup(); const app = buildApi(service, token);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp.ts'], env: { PATH: process.env.PATH!, API_TOKEN: token, API_BASE_URL: address }, stderr: 'pipe' });
  const client = new Client({ name: 'test-hermes', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools(); assert.equal(tools.tools.length, 8);
    // Reading is annotated read-only; the two that call the model and persist what it returns
  // are not, so a caller cannot treat them as free to retry.
  const writing = tools.tools.filter(t => !t.annotations?.readOnlyHint).map(t => t.name).sort();
  assert.deepEqual(writing, ['family_ask', 'family_summary']);
  assert.ok(tools.tools.filter(t => !writing.includes(t.name)).every(t => t.annotations?.readOnlyHint));
    const result = await client.callTool({ name: 'family_status', arguments: {} });
    assert.equal(result.isError, undefined); assert.match(JSON.stringify(result.content), /messages/);
  } finally { await client.close(); await app.close(); store.close(); }
});
const fakeWhatsApp = (groups: { id: string; name: string }[] = []) => {
  const calls: string[] = [];
  const state: { groups: { id: string; name: string }[]; archived: string[]; activity: Record<string, number> } = { groups, archived: [], activity: {} };
  return { calls, state, control: {
    requestPairingCode: async (phone: string) => { calls.push(`pair:${phone}`); return 'ABCD1234'; },
    pairingQr: async () => 'qr-payload',
    unlink: async () => { calls.push('unlink'); },
    groups: () => state.groups,
    refreshGroups: async () => { calls.push('refresh'); return state.groups; },
    archived: () => new Set(state.archived),
    resyncChats: async () => { calls.push('resync'); return state.archived.length; },
    activity: () => new Map(Object.entries(state.activity)),
  } };
};
test('asking for the chat list re-reads groups from WhatsApp', async () => {
  const { service, store } = setup({}, { groups: [] });
  const wa = fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }]);
  const bot = new Telegram(service, telegramEnv, undefined, wa.control);
  store.set('wa:status', 'connected');
  await bot.command('/kid add Даниэль');
  assert.doesNotMatch(await bot.command('/chats'), /חוג/);
  // A group joined after linking appears without a reconnect or a separate refresh command.
  wa.state.groups = [...wa.state.groups, { id: 'c@g.us', name: 'חוג כדורגל' }];
  const listing = await bot.command('/chats');
  assert.match(listing, /1\. ➕ חוג כדורגל/, 'a group joined after linking appears');
  assert.deepEqual(wa.calls, ['resync', 'refresh', 'refresh'], 'the snapshot is fetched once, the list twice');
  assert.match(await bot.command('/watch 1 Даниэль'), /חוג כדורגל/);
  assert.deepEqual(service.chatIds, ['c@g.us']);
  store.close();
});
test('a stale list is flagged rather than silently shown as current', async () => {
  const { service, store } = setup({}, { groups: [] });
  const wa = fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }]);
  store.set('wa:discoveryError', 'Group discovery failed; the last known list is shown');
  const bot = new Telegram(service, telegramEnv, undefined, wa.control);
  assert.match(await bot.command('/chats'), /устаревшим/);
  store.close();
});
test('WhatsApp groups are chosen from Telegram and take effect without a restart', async () => {
  const { service, store } = setup({}, { groups: [] });
  const wa = fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }, { id: 'b@g.us', name: 'גן שקד' }]);
  const bot = new Telegram(service, telegramEnv, undefined, wa.control);
  await bot.command('/kid add Даниэль');
  assert.deepEqual(service.chatIds, []);
  const listing = await bot.command('/chats');
  assert.match(listing, /1\. ➕ גן שקד/); assert.match(listing, /2\. ➕ כיתה ג3/);
  assert.match(await bot.command('/watch 1 Даниэль'), /גן שקד/);
  // The numbered choice must resolve to the group that was actually shown.
  assert.deepEqual(service.chatIds, ['b@g.us']);
  service.ingest([fixture('live', { chatId: 'b@g.us' })]);
  assert.equal(store.stats().messages, 1);
  // A followed group floats to the top, and the listing the numbers refer to follows it.
  assert.match(await bot.command('/chats'), /1\. ✅ גן שקד\n\s+Даниэль/);
  assert.match(await bot.command('/watch 1 Даниэль'), /обновлена/);
  assert.match(await bot.command('/unwatch 1'), /убрана/);
  assert.deepEqual(service.chatIds, []);
  assert.equal(store.stats().messages, 1); // History survives being unwatched.
  store.close();
});
test('config.json keeps supplying children and context for a group chosen from Telegram', async () => {
  const { service, store } = setup({}, { groups: [{ id: 'a@g.us', name: 'Класс', children: ['Даниэль'], context: 'ב2' }], family: [{ name: 'Даниэль', context: '' }] });
  const bot = new Telegram(service, telegramEnv, undefined, fakeWhatsApp([{ id: 'a@g.us', name: 'raw whatsapp subject' }]).control);
  service.setGroups([]);
  assert.deepEqual(service.chatIds, []);
  await bot.command('/chats');
  await bot.command('/watch 1 Даниэль');
  assert.deepEqual(service.groups[0]!.children, ['Даниэль']);
  assert.equal(service.groups[0]!.name, 'Класс');
  store.close();
});
test('pairing returns a code, and a QR is delivered as a photo rather than as text', async () => {
  const { service, store } = setup();
  const wa = fakeWhatsApp();
  const sent: { method: string; body: unknown }[] = [];
  const request = (async (url: string, init: RequestInit) => {
    sent.push({ method: String(url).split('/').pop()!, body: init.body });
    return Response.json({ ok: true, result: {} });
  }) as unknown as typeof fetch;
  const bot = new Telegram(service, telegramEnv, request, wa.control);
  assert.match(await bot.command('/link +972501234567'), /ABCD1234/);
  assert.deepEqual(wa.calls, ['pair:+972501234567']);
  assert.match(await bot.command('/link qr', '111'), /QR/);
  await bot.deliver();
  const photo = sent.find(s => s.method === 'sendPhoto');
  assert.ok(photo, 'a sendPhoto call was made');
  assert.ok(photo!.body instanceof FormData);
  assert.ok((photo!.body as FormData).get('photo') instanceof Blob);
  assert.equal(store.stats().pendingDelivery, 0);
  store.close();
});
test('an outbox created before the photo column still opens and delivers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-migrate-'));
  try {
    const path = join(dir, 'old.sqlite');
    let store = new Store(path);
    store.db.exec('DROP TABLE outbox');
    store.db.exec(`CREATE TABLE outbox (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, text TEXT NOT NULL, silent INTEGER NOT NULL,
      urgent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, next_at INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER, last_error TEXT)`);
    store.db.exec('PRAGMA user_version=1');
    // Written the way the old build wrote it, before photo/markup/parse_mode existed.
    store.db.prepare('INSERT INTO outbox(id,chat_id,text,silent,urgent,created_at) VALUES(?,?,?,?,?,?)')
      .run('old-row', '111', 'до миграции', 0, 1, Date.now());
    store.close();
    store = new Store(path);
    assert.equal(store.stats().pendingDelivery, 1);
    assert.equal(Number((store.db.prepare('PRAGMA user_version').get() as any).user_version), 6);
    store.enqueuePhoto('qr', '111', Buffer.from('png').toString('base64'), 'подпись');
    store.enqueueMenu('menu', '111', 'меню', { inline_keyboard: [] }, Date.now(), 'HTML');
    store.enqueue('code', '111', '<code>ABCD</code>', false, true, Date.now(), 'HTML');
    assert.equal(store.stats().pendingDelivery, 4);
    assert.equal(store.db.prepare("SELECT count(*) n FROM outbox WHERE parse_mode='HTML'").get()!.n, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true }); }
});
test('a group can only be attached to a kid, and the kid reaches the analysis prompt', async () => {
  const seen: any[] = [];
  const { service, store } = setup({ analyze: async (m, ctx) => { seen.push(ctx); return analysis(m); } }, { groups: [], family: [] });
  const wa = fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }]);
  const bot = new Telegram(service, telegramEnv, undefined, wa.control);
  await bot.command('/chats');
  assert.match(await bot.command('/watch 1'), /Сначала добавьте ребёнка/);
  await bot.command('/kid add Даниэль');
  assert.match(await bot.command('/watch 1'), /Укажите ребёнка/);
  assert.deepEqual(service.chatIds, []);
  assert.match(await bot.command('/watch 1 Даниэль'), /для: Даниэль/);
  assert.deepEqual(service.groups[0]!.children, ['Даниэль']);
  assert.match(await bot.command('/kids'), /Даниэль[\s\S]*Группы: כיתה ג3/);
  // The kid's own description is parent-written and goes to the model directly.
  await bot.command('/kid Даниэль второй класс ב2');
  service.ingest([fixture('live', { chatId: 'a@g.us' })]);
  await service.analyzePending(now);
  assert.equal(seen[0].family[0].context, 'второй класс ב2');
  assert.deepEqual(seen[0].group.children, ['Даниэль']);
  store.close();
});
test('removing a kid detaches their groups without deleting history', async () => {
  const { service, store } = setup({}, { groups: [], family: [] });
  const bot = new Telegram(service, telegramEnv, undefined, fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }]).control);
  await bot.command('/kid add Даниэль'); await bot.command('/chats'); await bot.command('/watch 1 Даниэль');
  service.ingest([fixture('live', { chatId: 'a@g.us' })]);
  assert.match(await bot.command('/kid remove Даниэль'), /удалён/);
  assert.deepEqual(service.groups[0]!.children, []);
  assert.equal(store.stats().messages, 1);
  assert.match(await bot.command('/chats'), /⚠️ без ребёнка/);
  store.close();
});
test('a comment is stored verbatim for the prompt while its extracted facts wait for /confirm', async () => {
  const seen: any[] = [];
  const { service, store } = setup({
    analyze: async (m, ctx) => { seen.push(ctx); return analysis(m); },
    extractFacts: async () => ({ facts: [{ key: 'teacher_name', value: 'Рина' }] }),
  }, { groups: [], family: [] });
  const bot = new Telegram(service, telegramEnv, undefined, fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }]).control);
  await bot.command('/kid add Даниэль'); await bot.command('/chats');
  const reply = await bot.command('/watch 1 Даниэль важное пишет только Рина');
  assert.match(reply, /Из него понятно/); assert.match(reply, /Рина/); assert.match(reply, /\/confirm/);
  // Verbatim comment is trusted; the model's reading of it is not, so it stays out of the prompt.
  assert.equal(service.groups[0]!.context, 'важное пишет только Рина');
  assert.equal(store.memories().length, 0);
  assert.equal(store.memories(false).filter(m => !m.confirmed).length, 1);
  service.ingest([fixture('live', { chatId: 'a@g.us' })]);
  await service.analyzePending(now);
  assert.equal(seen[0].group.context, 'важное пишет только Рина');
  assert.deepEqual(seen[0].confirmedMemory, []);
  assert.match(await bot.command('/confirm'), /Сохранено фактов: 1/);
  assert.equal(store.memories()[0]!.value, 'Рина');
  assert.match(await bot.command('/confirm'), /Подтверждать нечего/);
  store.close();
});
test('a failed extraction still keeps the comment', async () => {
  const { service, store } = setup({ extractFacts: async () => { throw new Error('model offline'); } }, { groups: [], family: [] });
  const bot = new Telegram(service, telegramEnv, undefined, fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }]).control);
  await bot.command('/kid add Даниэль'); await bot.command('/chats');
  assert.match(await bot.command('/watch 1 Даниэль много флуда'), /на отдельные факты не удалось/);
  assert.equal(service.groups[0]!.context, 'много флуда');
  assert.match(await bot.command('/note 1'), /много флуда/);
  store.close();
});
const tapper = (service: any, wa: any) => {
  const sent: any[] = [];
  const request = (async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    sent.push({ method, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: {} });
  }) as unknown as typeof fetch;
  const bot = new Telegram(service, telegramEnv, request, wa);
  let id = 0;
  // Drive the bot the way a person does: press a button on the message it just sent.
  const dm = { id: 11, type: 'private' };
  const tap = async (data: string) => { await bot.handle({ update_id: ++id, callback_query: { id: String(id), data, from: { id: 11 }, message: { message_id: 7, chat: dm } } }); return sent.at(-1)!.body; };
  const type = async (text: string) => { await bot.handle({ update_id: ++id, message: { chat: dm, from: { id: 11 }, text } }); await bot.deliver(); return sent.at(-1)!.body; };
  return { bot, sent, tap, type };
};
const labels = (body: any) => (body.reply_markup?.inline_keyboard || []).flat().map((b: any) => b.text);

test('a kid is created and described entirely by tapping and answering, with no syntax', async () => {
  const { service, store } = setup({}, { groups: [], family: [] });
  const { tap, type } = tapper(service, fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }]).control);
  assert.match((await type('/start')).text, /Семейный помощник/);
  const kids = await tap('kids');
  assert.match(kids.text, /Детей пока нет/);
  assert.ok(labels(kids).includes('➕ Добавить ребёнка'));
  const prompt = await tap('kid_add');
  assert.match(prompt.text, /Как зовут ребёнка/);
  assert.ok(labels(prompt).includes('✖️ Отмена'));
  assert.match((await type('Даниэль')).text, /🧒 Даниэль/);
  assert.deepEqual(service.family.map(k => k.name), ['Даниэль']);
  await tap(`kid:${id('Даниэль')}`);
  assert.match((await tap(`kid:${id('Даниэль')}:ctx`)).text, /Расскажите про Даниэль/);
  await type('второй класс ב2, учительница Рина');
  assert.equal(service.family[0]!.context, 'второй класс ב2, учительница Рина');
  store.close();
});
test('a group is attached to a kid by tapping, and a comment is a plain reply', async () => {
  const { service, store } = setup({ extractFacts: async () => ({ facts: [{ key: 'teacher', value: 'Важное пишет Рина' }] }) }, { groups: [], family: [] });
  const { tap, type } = tapper(service, fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }]).control);
  await tap('kids'); await tap('kid_add'); await type('Даниэль');
  const groups = await tap('groups');
  assert.match(groups.text, /1\. ➕ כיתה ג3/);
  assert.deepEqual(labels(groups).slice(0, 1), ['1']);
  // Tapping an unwatched group asks whose it is rather than accepting a name as text.
  const whose = await tap(`grp:${id('a@g.us')}`);
  assert.match(whose.text, /Чьи это сообщения|Выберите, чьи/);
  assert.ok(labels(whose).includes('🧒 Даниэль'));
  const attached = await tap(`grp:${id('a@g.us')}:k:${id('Даниэль')}`);
  assert.match(attached.text, /Ребёнок: Даниэль/);
  assert.deepEqual(service.groups[0]!.children, ['Даниэль']);
  assert.match((await tap('groups')).text, /1\. ✅ כיתה ג3\n\s+Даниэль/);
  await tap(`grp:${id('a@g.us')}`);
  assert.match((await tap(`grp:${id('a@g.us')}:note`)).text, /Что стоит знать про эту группу/);
  const saved = await type('важное пишет только Рина');
  assert.match(saved.text, /Комментарий сохранён/);
  assert.equal(service.groups[0]!.context, 'важное пишет только Рина');
  // Model-read facts still wait behind an explicit button.
  assert.ok(labels(saved).includes('✅ Сохранить факты'));
  assert.equal(store.memories().length, 0);
  assert.match((await tap('facts_ok')).text, /Сохранено фактов: 1/);
  assert.equal(store.memories()[0]!.value, 'Важное пишет Рина');
  store.close();
});
test('cancelling a prompt restores the menu and leaves the next message a question', async () => {
  const asked: string[] = [];
  const { service, store } = setup({ answer: async q => { asked.push(String(q)); return { answer: 'ответ', sources: [] }; } }, { groups: [], family: [] });
  const { tap, type } = tapper(service, fakeWhatsApp().control);
  await tap('kids'); await tap('kid_add');
  assert.match((await tap('cancel:kids')).text, /Детей пока нет/);
  assert.equal(store.get('pending:11', null), null);
  await type('Когда экскурсия?');
  assert.deepEqual(asked, ['Когда экскурсия?']);
  assert.deepEqual(service.family, []);
  store.close();
});
test('button presses obey the same allowlists as typed commands', async () => {
  const { service, store } = setup({}, { groups: [], family: [] });
  const { bot, sent } = tapper(service, fakeWhatsApp().control);
  await bot.handle({ update_id: 1, callback_query: { id: '1', data: 'kid_add', from: { id: 99 }, message: { message_id: 7, chat: { id: 111 } } } });
  await bot.handle({ update_id: 2, callback_query: { id: '2', data: 'kid_add', from: { id: 11 }, message: { message_id: 7, chat: { id: 999 } } } });
  assert.deepEqual(sent, []);
  assert.equal(store.get('telegram:offset', 0), 3);
  store.close();
});
test('every button on the main menu leads somewhere, not silently back to it', async () => {
  const { service, store } = setup({}, { groups: [], family: [] });
  const menu = new Menu(service, fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }]).control);
  const home = menu.home();
  const targets = home.markup.inline_keyboard.flat().map(b => b.callback_data);
  assert.ok(targets.length >= 4);
  for (const target of targets) {
    const reached = await menu.route(target, '111');
    assert.notEqual(reached.text, home.text, `button "${target}" fell through to the main menu`);
    assert.ok(reached.markup.inline_keyboard.flat().length, `screen "${target}" offers no way onward`);
  }
  // The linking screen's own buttons must resolve too.
  for (const target of (await menu.route('link', '111')).markup.inline_keyboard.flat().map(b => b.callback_data)) {
    if (target === 'home') continue;
    assert.notEqual((await menu.route(target, '111')).text, home.text, `button "${target}" fell through`);
  }
  store.close();
});
test('the command menu is published per scope and never advertises a dead or misplaced command', async () => {
  const calls: any[] = [];
  const request = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(url).split('/').pop(), body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: true });
  }) as unknown as typeof fetch;
  const { service, store } = setup();
  const bot = new Telegram(service, telegramEnv, request, fakeWhatsApp().control);
  await bot.publishCommands();
  assert.ok(calls.every(c => c.method === 'setMyCommands'));
  assert.deepEqual(calls.map(c => c.body.scope.type).slice(0, 2), ['all_private_chats', 'all_group_chats']);
  const group = calls[1]!.body.commands.map((c: any) => `/${c.command}`);
  // Nothing offered in the group may be a command the group refuses.
  for (const cmd of group) assert.doesNotMatch(await bot.command(cmd, '111', false), /в личном чате/, `${cmd} is advertised in groups but refused there`);
  // Every advertised command must actually exist.
  for (const direct of [true, false]) {
    for (const cmd of Telegram.advertised(direct)) {
      if (cmd === '/start' || cmd === '/summary') continue; // handled before dispatch / needs a period
      assert.doesNotMatch(await bot.command(cmd, '11', direct), /Неизвестная команда/, `${cmd} is advertised but unhandled`);
    }
  }
  for (const list of [calls[0]!.body.commands, calls[1]!.body.commands]) {
    for (const c of list) {
      assert.match(c.command, /^[a-z_]{1,32}$/);
      assert.ok(c.description.length >= 3 && c.description.length <= 256);
    }
  }
  assert.equal(store.get('telegram:commandsError', 'unset'), null);
  store.close();
});
test('a failed command menu is recorded but does not stop the bot', async () => {
  const { service, store } = setup();
  const bot = new Telegram(service, telegramEnv, (async () => Response.json({ ok: false, error_code: 429 }, { status: 429 })) as unknown as typeof fetch);
  await bot.publishCommands();
  assert.match(store.get<string>('telegram:commandsError', ''), /command menu/);
  store.close();
});
test('each parent chat gets the menu explicitly, so a shared bot cannot hide it', async () => {
  const calls: any[] = [];
  const request = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(url).split('/').pop(), body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: true });
  }) as unknown as typeof fetch;
  const { service, store } = setup();
  await new Telegram(service, telegramEnv, request).publishCommands();
  const scopes = calls.map(c => c.body.scope);
  assert.deepEqual(scopes.map(s => s.type), ['all_private_chats', 'all_group_chats', 'chat', 'chat']);
  // One explicit publication per allowed parent, carrying the private list.
  assert.deepEqual(scopes.filter(s => s.type === 'chat').map(s => s.chat_id), [11, 22]);
  for (const call of calls.filter(c => c.body.scope.type === 'chat')) {
    assert.deepEqual(call.body.commands, calls[0]!.body.commands);
  }
  store.close();
});
test('the pairing code is sent as tap-to-copy monospace, and ordinary replies stay plain', async () => {
  const sent: any[] = [];
  const request = (async (url: string, init: RequestInit) => {
    sent.push({ method: String(url).split('/').pop(), body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: {} });
  }) as unknown as typeof fetch;
  const { service, store } = setup({}, { family: [] });
  const wa = fakeWhatsApp();
  const bot = new Telegram(service, telegramEnv, request, wa.control);
  const dm = { id: 11, type: 'private' };
  // Through the buttons: tap "по номеру телефона", then send the number.
  await bot.handle({ update_id: 1, callback_query: { id: 'c1', data: 'link:phone', from: { id: 11 }, message: { message_id: 7, chat: dm } } });
  await bot.handle({ update_id: 2, message: { chat: dm, from: { id: 11 }, text: '+972501234567' } });
  await bot.deliver();
  const code = sent.at(-1)!.body;
  assert.equal(code.parse_mode, 'HTML');
  assert.match(code.text, /<code>ABCD1234<\/code>/);
  // Typed command reaches the same place.
  await bot.handle({ update_id: 3, message: { chat: dm, from: { id: 11 }, text: '/link +972501234567' } });
  await bot.deliver();
  assert.equal(sent.at(-1)!.body.parse_mode, 'HTML');
  assert.match(sent.at(-1)!.body.text, /<code>ABCD1234<\/code>/);
  // A digest could contain < or &; it must never be sent as HTML.
  store.enqueue('digest', '111', 'Сводка: 5 < 10 & «тест»', false, true);
  await bot.deliver();
  const digest = sent.at(-1)!.body;
  assert.equal(digest.parse_mode, undefined);
  assert.match(digest.text, /5 < 10 & «тест»/);
  store.close();
});
test('answering a prompt folds back into one menu and leaves nothing stale behind', async () => {
  const sent: any[] = [];
  let nextId = 100;
  const request = (async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    sent.push({ method, body: JSON.parse(String(init.body)) });
    // Only a real send mints a message id.
    return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: ++nextId } : true });
  }) as unknown as typeof fetch;
  const { service, store } = setup({}, { family: [] });
  const bot = new Telegram(service, telegramEnv, request, fakeWhatsApp().control);
  const dm = { id: 11, type: 'private' };
  let update = 0;

  await bot.handle({ update_id: ++update, message: { message_id: 500, chat: dm, from: { id: 11 }, text: '/start' } });
  await bot.deliver();
  // The command stays; one menu message is sent for it.
  assert.ok(!sent.some(s => s.method === 'deleteMessage'), 'nothing is deleted for a plain command');
  assert.equal(sent.filter(s => s.method === 'sendMessage').length, 1);
  const menuId = store.get('menu:11', null);
  assert.equal(menuId, 101);

  await bot.handle({ update_id: ++update, callback_query: { id: 'c1', data: 'kid_add', from: { id: 11 }, message: { message_id: menuId as number, chat: dm } } });
  assert.equal(sent.at(-1)!.method, 'editMessageText');
  assert.match(sent.at(-1)!.body.text, /Как зовут ребёнка/);

  sent.length = 0;
  await bot.handle({ update_id: ++update, message: { message_id: 501, chat: dm, from: { id: 11 }, text: 'Йоня' } });
  await bot.deliver();
  // The prompt becomes the result in place; what the reader typed is left alone.
  assert.ok(!sent.some(s => s.method === 'deleteMessage'), 'the reader\'s own message stays');
  assert.equal(sent.filter(s => s.method === 'sendMessage').length, 0);
  const edit = sent.find(s => s.method === 'editMessageText');
  assert.equal(edit!.body.message_id, menuId);
  assert.match(edit!.body.text, /Йоня/);
  assert.deepEqual(service.family.map(k => k.name), ['Йоня']);
  assert.equal(store.get('pending:11', null), null);
  store.close();
});
test('a menu that no longer exists is replaced rather than silently lost', async () => {
  const sent: any[] = [];
  let nextId = 200;
  const request = (async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    sent.push({ method, body: JSON.parse(String(init.body)) });
    if (method === 'editMessageText') return Response.json({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }, { status: 400 });
    return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: ++nextId } : true });
  }) as unknown as typeof fetch;
  const { service, store } = setup({}, { groups: [], family: [] });
  const bot = new Telegram(service, telegramEnv, request, fakeWhatsApp().control);
  // A prompt is waiting, and the menu it belongs to has since been deleted.
  store.set('menu:11', 42);
  store.set('pending:11', { action: 'kid_add' });
  await bot.handle({ update_id: 1, message: { message_id: 500, chat: { id: 11, type: 'private' }, from: { id: 11 }, text: 'Даниэль' } });
  await bot.deliver();
  // Editing is tried first, then a replacement is sent rather than the answer vanishing.
  assert.ok(sent.some(s => s.method === 'editMessageText' && s.body.message_id === 42));
  assert.ok(sent.some(s => s.method === 'sendMessage' && s.body.reply_markup));
  assert.equal(store.get('menu:11', null), 201);
  assert.deepEqual(service.family.map(k => k.name), ['Даниэль']);
  store.close();
});
test('a terminal WhatsApp session reconnects from a clean slate instead of hanging', () => {
  // Live and healthy: leave it alone.
  assert.deepEqual(WhatsApp.needsFreshSession('connected', true), { reconnect: false, wipe: false });
  // Never started, or the socket died: reconnect, but keep any stored credentials.
  assert.deepEqual(WhatsApp.needsFreshSession('disabled', false), { reconnect: true, wipe: false });
  assert.deepEqual(WhatsApp.needsFreshSession('reconnecting', false), { reconnect: true, wipe: false });
  // Logged out, taken over, or unusable: the stored session cannot be resumed.
  for (const code of ['401', '440', '500']) {
    assert.deepEqual(WhatsApp.needsFreshSession(`needs_attention:${code}`, false), { reconnect: true, wipe: true },
      `needs_attention:${code} must start over`);
    // Even with a socket still nominally open, a terminal status must not be reused.
    assert.deepEqual(WhatsApp.needsFreshSession(`needs_attention:${code}`, true), { reconnect: true, wipe: true });
  }
});
test('a terminal state is explained in plain words with a way out', () => {
  const { service, store } = setup({}, { family: [] });
  const menu = new Menu(service, fakeWhatsApp().control);
  store.set('wa:status', 'needs_attention:401');
  const s401 = menu.status();
  assert.match(s401.text, /устройство отвязано/);
  assert.ok(s401.markup.inline_keyboard.flat().some(b => b.text.includes('Подключить заново')));
  store.set('wa:status', 'needs_attention:440');
  assert.match(menu.status().text, /занята другим устройством/);
  store.set('wa:status', 'needs_attention:999');
  assert.match(menu.status().text, /требуется переподключение/);
  store.set('wa:status', 'connected');
  const ok = menu.status();
  assert.match(ok.text, /подключён/);
  assert.ok(!ok.markup.inline_keyboard.flat().some(b => b.callback_data === 'link'));
  store.close();
});
test('a long group list is paged and searchable, and numbers still point at the right group', async () => {
  const { service, store } = setup({}, { groups: [], family: [{ name: 'Даниэль', context: '' }] });
  const many = Array.from({ length: 96 }, (_, i) => ({ id: `g${i}@g.us`, name: i === 40 ? "כיתה ג'3 הורים" : `Группа ${i}` }));
  const menu = new Menu(service, fakeWhatsApp(many).control);
  const first = await menu.groups('11');
  const buttons = (s: any) => s.markup.inline_keyboard.flat().map((b: any) => b.text);
  const listed = (s: any) => (s.text.match(/^\s*\d+\. [✅➕]/gm) || []).length;
  assert.equal(listed(first), 10, 'one page of groups, not all 96');
  assert.match(first.text, /0 из 96 анализируется/);
  assert.ok(buttons(first).includes('1/10'), 'page indicator');
  // Searching narrows it, and the button that appears maps to the group that was found.
  await menu.route('groups:find', '11');
  const found = await menu.input({ action: 'group_search' }, 'כיתה', '11');
  assert.match(found.text, /найдено 1/);
  assert.equal(listed(found), 1);
  assert.match(found.text, /כיתה ג'3 הורים/);
  await menu.route(`grp:${id('g40@g.us')}:k:${id('Даниэль')}`, '11');
  assert.deepEqual(service.groups.map(g => g.id), ['g40@g.us']);
  // Clearing the filter restores the full list, with the followed group floated to the top.
  const cleared = await menu.route('groups:clear', '11');
  assert.match(cleared.text, /1 из 96 анализируется/);
  assert.match(cleared.text, /^1\. ✅/m, 'followed groups sort first');
  const second = await menu.route('groups:p:1', '11');
  assert.match(second.text, /^11\. /m);
  assert.doesNotMatch(second.text, /^1\. /m);
  store.close();
});
test('linking is announced to the chat that asked for it, and the QR image is cleared', async () => {
  const sent: any[] = [];
  let nextId = 300;
  const request = (async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    sent.push({ method, body: init.body instanceof FormData ? Object.fromEntries([...init.body].filter(([, v]) => typeof v === 'string')) : JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: method === 'sendMessage' || method === 'sendPhoto' ? { message_id: ++nextId } : true });
  }) as unknown as typeof fetch;
  const { service, store } = setup({}, { groups: [], family: [] });
  const wa = fakeWhatsApp([{ id: 'a@g.us', name: 'כיתה ג3' }]);
  const bot = new Telegram(service, telegramEnv, request, wa.control);
  store.set('wa:pairingChat', '11');
  store.enqueuePhoto('qr', '11', Buffer.from('png').toString('base64'), 'сканируйте');
  await bot.deliver();
  assert.deepEqual(store.get('wa:qrMessage', null), { chat: '11', id: 301 });
  await bot.announceLinked();
  await bot.deliver();
  // The transient QR is removed and the menu says what happened.
  assert.ok(sent.some(s => s.method === 'deleteMessage' && s.body.message_id === 301));
  assert.equal(store.get('wa:qrMessage', null), null);
  const announced = sent.filter(s => s.method === 'sendMessage' || s.method === 'editMessageText').at(-1)!;
  assert.match(announced.body.text, /WhatsApp подключён\. Найдено групп: 1/);
  assert.match(announced.body.text, /1\. ➕ כיתה ג3/, 'the groups are offered straight away');
  store.close();
});
test('archived groups are hidden by default but never hide one you already follow', async () => {
  const { service, store } = setup({}, { groups: [], family: [{ name: 'Даниэль', context: '' }] });
  const wa = fakeWhatsApp([
    { id: 'live@g.us', name: 'Класс активный' },
    { id: 'old@g.us', name: 'Архивный кружок' },
    { id: 'kept@g.us', name: 'Архивный но нужный' },
  ]);
  wa.state.archived = ['old@g.us', 'kept@g.us'];
  const menu = new Menu(service, wa.control);
  const labels = (s: any) => s.markup.inline_keyboard.flat().map((b: any) => b.text);
  const first = await menu.groups('11');
  assert.match(first.text, /Класс активный/);
  assert.doesNotMatch(first.text, /Архивный кружок/);
  assert.match(first.text, /Скрыто архивных: 2/);
  assert.ok(labels(first).some((t: string) => t.includes('Показать архивные (2)')));
  // Reveal them, follow one, hide again: a followed group stays visible regardless.
  const revealed = await menu.route('groups:arch', '11');
  assert.match(revealed.text, /Архивный но нужный/);
  await menu.route(`grp:${id('kept@g.us')}:k:${id('Даниэль')}`, '11');
  const hiddenAgain = await menu.route('groups:arch', '11');
  assert.match(hiddenAgain.text, /Архивный но нужный/, 'a followed archived group stays');
  assert.doesNotMatch(hiddenAgain.text, /Архивный кружок/);
  assert.match(hiddenAgain.text, /Скрыто архивных: 1/);
  store.close();
});
test('groups sharing a name are told apart, and the newest conversations come first', async () => {
  const { service, store } = setup({}, { groups: [], family: [{ name: 'Даниэль', context: '' }] });
  const wa = fakeWhatsApp([
    { id: 'old@g.us', name: 'Learning with Rav' },
    { id: 'new@g.us', name: 'Learning with Rav' },
    { id: 'quiet@g.us', name: 'Тихая группа' },
    { id: 'busy@g.us', name: 'Активная группа' },
  ]);
  wa.state.activity = {
    'old@g.us': Date.parse('2026-03-02T10:00:00Z'),
    'new@g.us': Date.parse('2026-09-14T10:00:00Z'),
    'busy@g.us': Date.parse('2026-09-15T10:00:00Z'),
  };
  const menu = new Menu(service, wa.control);
  const listing = await menu.groups('11');
  const order = [...listing.text.matchAll(/^\d+\. [✅➕] (.+)$/gm)].map(m => m[1]);
  assert.deepEqual(order, ['Активная группа', 'Learning with Rav', 'Learning with Rav', 'Тихая группа'],
    'most recent first, unknown activity last');
  // The colliding pair carries dates; the unique names are left uncluttered.
  assert.match(listing.text, /Learning with Rav\n\s+14\.09/);
  assert.match(listing.text, /Learning with Rav\n\s+02\.03/);
  assert.doesNotMatch(listing.text, /Активная группа\n\s+15\.09/);
  // Number 2 is the recent one, and tapping it follows that exact group.
  assert.equal(store.get<string[]>('chats:listing:11', [])[1], 'new@g.us');
  await menu.route(`grp:${id('new@g.us')}:k:${id('Даниэль')}`, '11');
  assert.deepEqual(service.groups.map(g => g.id), ['new@g.us']);
  store.close();
});
test('a typed command is never deleted and always produces a visible menu', async () => {
  const sent: any[] = [];
  let nextId = 400;
  const request = (async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    sent.push({ method, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: method === 'sendMessage' ? { message_id: ++nextId } : true });
  }) as unknown as typeof fetch;
  const { service, store } = setup({}, { groups: [], family: [] });
  const bot = new Telegram(service, telegramEnv, request, fakeWhatsApp([{ id: 'a@g.us', name: 'Класс' }]).control);
  const dm = { id: 11, type: 'private' };
  // A menu the reader has cleared: the bot can still edit it, so editing would go unseen.
  store.set('menu:11', 42);
  await bot.handle({ update_id: 1, message: { message_id: 500, chat: dm, from: { id: 11 }, text: '/start' } });
  await bot.deliver();
  assert.ok(!sent.some(s => s.method === 'deleteMessage' && s.body.message_id === 500), 'the command itself must survive');
  assert.ok(!sent.some(s => s.method === 'editMessageText'), 'an explicit command must not edit a possibly-invisible message');
  const fresh = sent.find(s => s.method === 'sendMessage');
  assert.ok(fresh, 'a new menu is actually sent');
  assert.match(fresh!.body.text, /Семейный помощник/);
  assert.equal(store.get('menu:11', null), 401);
  // The earlier menu is left in place: it is still a real answer to what was asked then.
  assert.ok(!sent.some(s => s.method === 'deleteMessage' && s.body.message_id === 42));
  // /chats behaves the same way.
  sent.length = 0;
  await bot.handle({ update_id: 2, message: { message_id: 501, chat: dm, from: { id: 11 }, text: '/chats' } });
  await bot.deliver();
  assert.ok(!sent.some(s => s.method === 'deleteMessage' && s.body.message_id === 501));
  assert.match(sent.find(s => s.method === 'sendMessage')!.body.text, /Группы WhatsApp/);
  store.close();
});
test('only a spent pairing QR is ever deleted; every other message is left where it is', async () => {
  const sent: any[] = [];
  let nextId = 700;
  const request = (async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    sent.push({ method, body: init.body instanceof FormData ? { photo: true } : JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: method === 'sendMessage' || method === 'sendPhoto' ? { message_id: ++nextId } : true });
  }) as unknown as typeof fetch;
  const { service, store } = setup({}, { groups: [], family: [] });
  const bot = new Telegram(service, telegramEnv, request, fakeWhatsApp([{ id: 'a@g.us', name: 'Класс' }]).control);
  const dm = { id: 11, type: 'private' };
  let update = 0;
  const deletions = () => sent.filter(s => s.method === 'deleteMessage').map(s => s.body.message_id);

  await bot.handle({ update_id: ++update, message: { message_id: 500, chat: dm, from: { id: 11 }, text: '/start' } });
  await bot.deliver();
  await bot.handle({ update_id: ++update, message: { message_id: 501, chat: dm, from: { id: 11 }, text: '/chats' } });
  await bot.deliver();
  await bot.handle({ update_id: ++update, callback_query: { id: 'c1', data: 'kid_add', from: { id: 11 }, message: { message_id: 702, chat: dm } } });
  await bot.handle({ update_id: ++update, message: { message_id: 502, chat: dm, from: { id: 11 }, text: 'Даниэль' } });
  await bot.deliver();
  // Two commands, a prompt and an answer later: nothing has been removed.
  assert.deepEqual(deletions(), []);
  assert.deepEqual(service.family.map(k => k.name), ['Даниэль']);
  // Both menus still exist, and the prompt was turned into the result rather than replaced.
  assert.equal(sent.filter(s => s.method === 'sendMessage').length, 2);
  assert.ok(sent.some(s => s.method === 'editMessageText' && s.body.message_id === 702));

  // The QR is the one exception: once linking succeeds it means nothing.
  store.set('wa:pairingChat', '11');
  store.enqueuePhoto('qr', '11', Buffer.from('png').toString('base64'), 'сканируйте');
  await bot.deliver();
  const qr = store.get<{ chat: string; id: number }>('wa:qrMessage', null as any);
  await bot.announceLinked();
  await bot.deliver();
  assert.deepEqual(deletions(), [qr.id]);
  store.close();
});
test('opening the chat list fetches the chat snapshot once, without being asked', async () => {
  const { service, store } = setup({}, { groups: [], family: [] });
  const wa = fakeWhatsApp([{ id: 'a@g.us', name: 'Класс' }]);
  const menu = new Menu(service, wa.control);
  // Looking at the list before linking must not spend the one attempt, nor start WhatsApp.
  await menu.groups('11');
  assert.deepEqual(wa.calls, ['refresh'], 'nothing is asked of an unlinked account');
  assert.equal(store.get('wa:chatsSynced', false), false, 'and the one attempt is still available');
  wa.calls.length = 0;
  store.set('wa:status', 'connected');
  await menu.groups('11');
  assert.deepEqual(wa.calls, ['resync', 'refresh'], 'the snapshot is asked for before the list is drawn');
  // It is not cheap, so it does not repeat on every listing.
  await menu.groups('11');
  await menu.route('groups:p:0', '11');
  assert.deepEqual(wa.calls, ['resync', 'refresh', 'refresh', 'refresh']);
  // The button still forces one on demand.
  const forced = await menu.route('groups:sync', '11');
  assert.match(forced.text, /Группы WhatsApp/, 'the refreshed list is the confirmation');
  assert.equal(wa.calls.filter(c => c === 'resync').length, 2);
  // A failing snapshot must not take the list down with it.
  store.set('wa:chatsSynced', false);
  wa.control.resyncChats = async () => { throw new Error('offline'); };
  const listing = await menu.groups('11');
  assert.match(listing.text, /Класс/);
  assert.equal(store.get('wa:chatsSynced', false), false, 'a failure does not consume the one attempt');
  store.close();
});
test('slow work shows a typing indicator, refreshed until it finishes, then stopped', async () => {
  const sent: any[] = [];
  const request = (async (url: string, init: RequestInit) => {
    sent.push({ method: String(url).split('/').pop(), body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: { message_id: 900 } });
  }) as unknown as typeof fetch;
  let release: (() => void) | undefined;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const { service, store } = setup({ answer: async () => { await slow; return { answer: 'ответ', sources: [] }; } }, { family: [] });
  const bot = new Telegram(service, telegramEnv, request, fakeWhatsApp().control);
  const dm = { id: 11, type: 'private' };
  const actions = () => sent.filter(s => s.method === 'sendChatAction');

  const handling = bot.handle({ update_id: 1, message: { message_id: 500, chat: dm, from: { id: 11 }, text: 'Когда экскурсия?' } });
  // The indicator appears immediately, before any answer exists.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(actions().length, 1);
  assert.deepEqual(actions()[0]!.body, { chat_id: '11', action: 'typing' });
  assert.equal(sent.filter(s => s.method === 'sendMessage').length, 0);
  // Telegram expires it after about five seconds, so it is refreshed while work continues.
  await new Promise(resolve => setTimeout(resolve, 4300));
  assert.ok(actions().length >= 2, 'the indicator is kept alive');
  release!();
  await handling;
  const afterFinish = actions().length;
  await bot.deliver();
  await new Promise(resolve => setTimeout(resolve, 4300));
  // Once the work is done it stops: no indicator outlives the reply.
  assert.equal(actions().length, afterFinish, 'the indicator stops when the work stops');
  assert.match(sent.find(s => s.method === 'sendMessage')!.body.text, /ответ/);
  store.close();
});
test('unlinking is reachable, confirmed first, and keeps everything except the link', async () => {
  const { service, store } = setup({}, { groups: [], family: [{ name: 'Даниэль', context: '' }] });
  const wa = fakeWhatsApp([{ id: 'a@g.us', name: 'Класс' }]);
  const menu = new Menu(service, wa.control);
  store.set('wa:status', 'connected');
  const labels = (s: any) => s.markup.inline_keyboard.flat().map((b: any) => b.text);
  assert.ok(labels(menu.status()).some((t: string) => t.includes('Отвязать')), 'the option exists while linked');
  // Destructive, so it asks first and changes nothing until confirmed.
  const confirm = await menu.route('unlink', '11');
  assert.match(confirm.text, /Отвязать WhatsApp\?/);
  assert.deepEqual(wa.calls, []);
  const done = await menu.route('unlink:yes', '11');
  assert.deepEqual(wa.calls, ['unlink']);
  assert.match(done.text, /отвязан/);
  // Kids and history survive; only the link is gone.
  assert.deepEqual(service.family.map(k => k.name), ['Даниэль']);
  store.set('wa:status', 'disabled');
  assert.ok(!labels(menu.status()).some((t: string) => t.includes('Отвязать')), 'nothing to unlink when not linked');
});
test('a revoked device is said out loud instead of serving a cached list as if it were live', async () => {
  const { service, store } = setup({}, { groups: [], family: [] });
  const menu = new Menu(service, fakeWhatsApp([{ id: 'a@g.us', name: 'Класс' }]).control);
  store.set('wa:status', 'connected');
  const live = await menu.groups('11');
  assert.doesNotMatch(live.text, /не подключён/);
  // WhatsApp revoked the device: the group names are still cached, but they are not current.
  for (const status of ['needs_attention:401', 'disabled', 'connection_failed']) {
    store.set('wa:status', status);
    const screen = await menu.groups('11');
    assert.match(screen.text, /WhatsApp не подключён — список показан по памяти/, `${status} must be flagged`);
    assert.ok(screen.markup.inline_keyboard.flat().some(b => b.callback_data === 'link'), `${status} must offer a way back`);
  }
  store.close();
});
test('following a group queues a history backfill, and dropping it does not', async () => {
  const { service, store } = setup({}, { groups: [], family: [{ name: 'Даниэль', context: '' }] });
  const menu = new Menu(service, fakeWhatsApp([{ id: 'a@g.us', name: 'Класс' }, { id: 'b@g.us', name: 'Сад' }]).control);
  await menu.groups('11');
  assert.deepEqual(store.get('wa:backfill', []), []);
  await menu.route(`grp:${id('a@g.us')}:k:${id('Даниэль')}`, '11');
  // Newly followed, so its past is worth asking for.
  assert.deepEqual(store.get('wa:backfill', []), ['a@g.us']);
  // Re-saving the same group must not queue it twice.
  await menu.route(`grp:${id('a@g.us')}:k:${id('Даниэль')}`, '11');
  assert.deepEqual(store.get('wa:backfill', []), ['a@g.us']);
  await menu.groups('11');
  await menu.route(`grp:${id('b@g.us')}:k:${id('Даниэль')}`, '11');
  assert.deepEqual([...store.get<string[]>('wa:backfill', [])].sort(), ['a@g.us', 'b@g.us']);
  // Unfollowing is not a reason to fetch anything.
  const before = store.get<string[]>('wa:backfill', []);
  await menu.route(`grp:${id('a@g.us')}:off`, '11');
  assert.deepEqual(store.get('wa:backfill', []), before);
  store.close();
});
test('a spent QR is only ever deleted from the chat it was sent to', async () => {
  const sent: any[] = [];
  const request = (async (url: string, init: RequestInit) => {
    sent.push({ method: String(url).split('/').pop(), body: init.body instanceof FormData ? { photo: true } : JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: { message_id: 500 } });
  }) as unknown as typeof fetch;
  const { service, store } = setup({}, { groups: [], family: [] });
  const bot = new Telegram(service, telegramEnv, request, fakeWhatsApp([{ id: 'a@g.us', name: 'Класс' }]).control);
  // One parent gets the QR as message 500 in their own chat.
  store.set('wa:pairingChat', '11');
  store.enqueuePhoto('qr', '11', Buffer.from('png').toString('base64'), 'сканируйте');
  await bot.deliver();
  assert.deepEqual(store.get('wa:qrMessage', null), { chat: '11', id: 500 });
  // The other parent then starts pairing, moving where the confirmation will land.
  store.set('wa:pairingChat', '22');
  sent.length = 0;
  await bot.announceLinked();
  await bot.deliver();
  // Message 500 in chat 22 is somebody else's message and must not be touched.
  assert.deepEqual(sent.filter(s => s.method === 'deleteMessage'), [],
    'a message id from another chat must never be deleted here');
  assert.deepEqual(store.get('wa:qrMessage', null), { chat: '11', id: 500 }, 'and the real QR is still tracked');
  store.close();
});
test('a button from an older listing still acts on the group it named', async () => {
  const { service, store } = setup({}, { groups: [], family: [{ name: 'Даниэль', context: '' }] });
  const wa = fakeWhatsApp([{ id: 'alpha@g.us', name: 'Alpha' }, { id: 'beta@g.us', name: 'Beta' }]);
  const menu = new Menu(service, wa.control);
  // Parent 11 looks at the full list, then parent 22 filters theirs down to Beta.
  await menu.groups('11');
  await menu.route('groups:find', '22');
  await menu.input({ action: 'group_search' }, 'Beta', '22');
  // Parent 11 presses the button they were shown for Alpha.
  await menu.route(`grp:${id('alpha@g.us')}:k:${id('Даниэль')}`, '11');
  assert.deepEqual(service.groups.map(g => g.id), ['alpha@g.us'], 'the group named on the button is the one followed');
  // One parent filtering does not change what the other sees.
  assert.doesNotMatch((await menu.groups('11')).text, /найдено/);
  assert.match((await menu.groups('22')).text, /найдено 1/);
  store.close();
});
test('deleting a child cannot make an older button delete a different one', async () => {
  const { service, store } = setup({}, { groups: [], family: [] });
  const menu = new Menu(service, fakeWhatsApp().control);
  for (const name of ['Аврам', 'Борис', 'Вера']) {
    await menu.route('kid_add', '11');
    await menu.input({ action: 'kid_add' }, name, '11');
  }
  // A button rendered for Борис, before Аврам was removed.
  const borisButton = `kid:${id('Борис')}:del`;
  await menu.route(`kid:${id('Аврам')}:del`, '11');
  assert.deepEqual(service.family.map(k => k.name), ['Борис', 'Вера']);
  await menu.route(borisButton, '11');
  assert.deepEqual(service.family.map(k => k.name), ['Вера'], 'the child named on the button is the one deleted');
  store.close();
});
test('one parent cannot confirm the facts the other was shown', async () => {
  const { service, store } = setup({
    extractFacts: async (note: string) => ({ facts: [{ key: 'teacher', value: note }] }),
  }, { groups: [{ id: 'a@g.us', name: 'Класс', children: ['Д'] }], family: [{ name: 'Д', context: '' }] });
  const menu = new Menu(service, fakeWhatsApp([{ id: 'a@g.us', name: 'Класс' }]).control);
  await menu.groups('11');
  await menu.input({ action: 'group_note', key: id('a@g.us') }, 'Учительница A', '11');
  await menu.input({ action: 'group_note', key: id('a@g.us') }, 'Учительница B', '22');
  // Parent 11 presses their own confirm; it must approve what they were shown.
  await menu.route('facts_ok', '11');
  assert.deepEqual(store.memories().map(m => m.value), ['Учительница A']);
  store.close();
});
test('a reply queued during an in-flight delivery is sent, not left for the next tick', async () => {
  const sent: string[] = [];
  let release: (() => void) | undefined;
  const firstSend = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const request = (async (_url: unknown, init: RequestInit) => {
    calls++;
    if (calls === 1) await firstSend;
    sent.push(JSON.parse(String(init.body)).text);
    return Response.json({ ok: true, result: { message_id: calls } });
  }) as unknown as typeof fetch;
  const { service, store } = setup();
  const bot = new Telegram(service, telegramEnv, request);
  store.enqueue('first', '111', 'первое', false, true, now);
  const inFlight = bot.deliver(now);
  await new Promise(resolve => setTimeout(resolve, 20));
  store.enqueue('second', '111', 'второе', false, true, now);
  // Joining a running pass must make it go round again rather than being dropped.
  const joined = bot.deliver(now);
  release!();
  await Promise.all([inFlight, joined]);
  assert.deepEqual(sent, ['первое', 'второе']);
  assert.equal(store.stats().pendingDelivery, 0, 'nothing waits for the next tick');
  store.close();
});
test('sending is paced across separate delivery calls, not just within one', async () => {
  const at: number[] = [];
  const request = (async () => { at.push(Date.now()); return Response.json({ ok: true, result: { message_id: at.length } }); }) as unknown as typeof fetch;
  const { service, store } = setup();
  const bot = new Telegram(service, telegramEnv, request);
  store.enqueue('a', '111', 'раз', false, true, now);
  await bot.deliver(now);
  store.enqueue('b', '111', 'два', false, true, now);
  await bot.deliver(now);
  assert.equal(at.length, 2);
  // Two consecutive commands used to send milliseconds apart and risk a Telegram throttle.
  assert.ok(at[1]! - at[0]! >= 1000, `expected pacing between calls, got ${at[1]! - at[0]!}ms`);
  store.close();
});
test('a reader sees why their own input was rejected, and never a provider failure', async () => {
  const sent: string[] = [];
  const request = (async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).text);
    return Response.json({ ok: true, result: { message_id: sent.length } });
  }) as unknown as typeof fetch;
  // A provider error carrying a prompt and a credential, which must never reach a chat.
  const leak = 'OpenAI 401: invalid api key sk-secret-abc123 for prompt "Даниэль, класс ב2"';
  const { service, store } = setup({ answer: async () => { throw new Error(leak); } });
  const bot = new Telegram(service, telegramEnv, request, fakeWhatsApp().control);
  const dm = { id: 11, type: 'private' };
  let update = 0;

  await bot.handle({ update_id: ++update, message: { message_id: 1, chat: dm, from: { id: 11 }, text: '/summary 99d' } });
  await bot.deliver();
  assert.match(sent.at(-1)!, /Период должен быть от 1 часа до 30 дней/, 'their own mistake is explained');

  await bot.handle({ update_id: ++update, message: { message_id: 2, chat: dm, from: { id: 11 }, text: '/summary banana' } });
  await bot.deliver();
  assert.match(sent.at(-1)!, /24h, 48h или 7d/);

  await bot.handle({ update_id: ++update, message: { message_id: 3, chat: dm, from: { id: 11 }, text: 'Когда экскурсия?' } });
  await bot.deliver();
  const reply = sent.at(-1)!;
  assert.doesNotMatch(reply, /sk-secret-abc123/, 'a credential must never be echoed');
  assert.doesNotMatch(reply, /OpenAI 401/);
  assert.doesNotMatch(reply, /Даниэль/, 'nor prompt content');
  assert.match(reply, /Не удалось выполнить запрос/, 'an infrastructure failure gets the generic text');
  store.close();
});
