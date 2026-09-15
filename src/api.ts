import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FamilyService } from './service.js';
import type { WhatsApp } from './whatsapp.js';
import { durationHours } from './telegram.js';

export const incomingSchema = z.object({
  chatId: z.string().min(1).max(200), externalId: z.string().min(1).max(250), sender: z.string().min(1).max(250),
  timestamp: z.number().int().positive().refine(t => t <= Date.now() + 300000, 'Timestamp is in the future'),
  text: z.string().min(1).max(100000), kind: z.string().max(40).optional(),
});
export function buildApi(service: FamilyService, token: string, whatsapp?: WhatsApp) {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024, requestTimeout: 120000 });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.url === '/healthz') return;
    const actual = Buffer.from(request.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Unauthorized' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', fields: error.issues.map(i => ({ path: i.path, message: i.message })) });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: 'Invalid request' });
    // Provider errors can embed private prompts or credentials; never echo them.
    return reply.code(503).send({ error: 'Request could not be completed. Check configuration, group name, period, and service status.' });
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/status', async () => ({ ...service.store.stats(), whatsapp: service.store.get('wa:status', 'disabled'),
    modelConfigured: service.store.get('model:configured', false), telegramConfigured: service.store.get('telegram:configured', false),
    lastConnected: service.store.get('wa:lastConnected', null), workerError: service.store.get('worker:error', null),
    telegramError: service.store.get('telegram:pollError', null),
    schedules: service.config.digests.map(d => ({ ...d, state: service.store.get(`schedule:${d.name}`, null), error: service.store.get(`schedule:${d.name}:error`, null) })) }));
  app.get('/groups', async () => ({ selected: service.groups, available: whatsapp?.groups() || [] }));
  app.post('/whatsapp/resync', async () => ({ chats: (await whatsapp?.resyncChats()) ?? 0 }));
  app.get('/whatsapp/pairing', async () => ({ qr: whatsapp?.pairing() || null, status: service.store.get('wa:status', 'disabled') }));
  app.post('/summary', async request => {
    const body = z.object({ period: z.string().default('24h'), group: z.string().optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).parse(request.body || {});
    const to = body.to ? Date.parse(body.to) : Date.now();
    return service.summarize(body.from ? Date.parse(body.from) : to - durationHours(body.period) * 3600000, to, body.group);
  });
  app.get('/search', async request => {
    const q = z.object({ q: z.string().min(1).max(500), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    return service.store.search(q.q, service.chatIds, q.limit);
  });
  app.post('/ask', async request => {
    const body = z.object({ question: z.string().min(1).max(2000) }).parse(request.body);
    return service.ask(body.question);
  });
  app.get('/sources/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(request.params);
    const message = service.store.source(id, service.chatIds);
    return message || reply.code(404).send({ error: 'Source not found' });
  });
  app.get('/memory', async () => service.store.memories(false));
  app.put('/memory', async request => {
    const m = z.object({ key: z.string().min(1).max(200), value: z.string().min(1).max(1200) }).parse(request.body);
    service.store.remember(m.key, m.value, true); return { saved: true };
  });
  app.delete('/memory/:key', async request => {
    const { key } = z.object({ key: z.string().max(200) }).parse(request.params);
    return { deleted: Number(service.store.forget(key)) };
  });
  app.get('/topics', async request => {
    const { q } = z.object({ q: z.string().max(500).default('') }).parse(request.query);
    return service.topics(q);
  });
  app.post('/import', async request => {
    const messages = z.array(incomingSchema).min(1).max(1000).parse(request.body);
    // All externally supplied history is historical, even if it includes a 'live' flag.
    return service.ingest(messages.map(m => ({ ...m, historical: true })));
  });
  return app;
}
