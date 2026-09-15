import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { loadConfig, loadEnv } from './config.js';
import { Store } from './db.js';
import { JsonModel } from './llm.js';
import { FamilyService } from './service.js';
import { Telegram } from './telegram.js';
import { WhatsApp } from './whatsapp.js';
import { Scheduler } from './scheduler.js';
import { buildApi } from './api.js';

process.umask(0o077);
const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const config = loadConfig(), env = loadEnv();
mkdirSync(env.dataDir, { recursive: true, mode: 0o700 });
chmodSync(env.dataDir, 0o700);
const store = new Store(join(env.dataDir, 'family.sqlite'));
store.set('model:configured', !!env.llmModel);
store.set('telegram:configured', !!env.telegramToken);
const service = new FamilyService(store, config, new JsonModel(env), env.telegramChats);
const whatsapp = new WhatsApp(service);
const telegram = new Telegram(service, env, fetch, whatsapp), scheduler = new Scheduler(service);
const api = buildApi(service, env.apiToken, whatsapp);
whatsapp.onConnected = () => track(telegram.announceLinked());
let stopping = false, working = false;
const tasks = new Set<Promise<unknown>>();
const track = (p: Promise<unknown>) => { tasks.add(p); void p.catch(() => {}).finally(() => tasks.delete(p)); };
async function work() {
  if (working || stopping) return;
  working = true;
  try {
    if (env.llmModel) {
      try {
        await service.analyzePending();
        store.set('worker:lastSuccess', new Date().toISOString());
        store.set('worker:error', null);
      } catch {
        store.set('worker:error', 'Some group analyses failed; queued messages will be retried. Check model configuration/connectivity.');
        log.warn('Analysis failed; retrying on next tick. Details suppressed to protect message content.');
      }
      await scheduler.tick();
    }
    store.prune(config.retentionDays);
  } catch {
    store.set('worker:error', 'Analysis failed; queued messages will be retried. Check model configuration/connectivity.');
    log.warn('Analysis failed; retrying on next tick. Details suppressed to protect message content.');
  } finally { working = false; }
}
await api.listen({ host: env.host, port: env.port });
log.info({ port: env.port, groups: service.groups.length, modelConfigured: !!env.llmModel }, 'Family Brief started');
if (env.whatsappEnabled && store.get('wa:enabled', null) === null) store.set('wa:enabled', true);
if (store.get('wa:enabled', false)) await whatsapp.connect(); else store.set('wa:status', 'disabled');
track(telegram.publishCommands());
track(telegram.poll());
track(work());
const workerTimer = setInterval(() => track(work()), config.alertPollSeconds * 1000);
const deliveryTimer = setInterval(() => track(telegram.deliver()), 2000);
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(workerTimer); clearInterval(deliveryTimer);
  telegram.stop(); whatsapp.stop();
  // Exit if an external model request fails to settle in the Docker grace period.
  const force = setTimeout(() => process.exit(1), 25000).unref();
  await api.close();
  await Promise.allSettled([...tasks]);
  store.close(); clearTimeout(force);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
