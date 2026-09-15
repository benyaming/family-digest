import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';

export const groupSchema = z.object({
  id: z.string().min(1), name: z.string().min(1),
  children: z.array(z.string()).default([]), context: z.string().default(''),
  alerts: z.boolean().default(true),
});
export const configSchema = z.object({
  timezone: z.string().default('Asia/Hebron'),
  language: z.string().default('Russian'),
  family: z.array(z.object({ name: z.string(), context: z.string() })).default([]),
  groups: z.array(groupSchema).default([]),
  digests: z.array(z.object({ name: z.string().regex(/^[a-z0-9_-]+$/), cron: z.string() }))
    .default([{ name: 'evening', cron: '0 20 * * *' }]),
  initialDigestHours: z.number().min(1).max(720).default(24),
  alertPollSeconds: z.number().min(10).max(3600).default(60),
  alertMaxAgeHours: z.number().min(1).max(168).default(24),
  alertMinConfidence: z.number().min(0).max(1).default(0.85),
  alertRules: z.string().default('Alert on cancellations, changed pickup/location/time, safety notices, and explicit parent action or payment deadlines within 48 hours. Routine homework, thanks, debates and distant events belong in digests.'),
  quietHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) })
    .default({ start: 22, end: 7 }),
  chunkCharacters: z.number().int().min(4000).max(60000).default(18000),
  maxSummaryMessages: z.number().int().min(100).max(100000).default(20000),
  maxDigestAttempts: z.number().int().min(1).max(10).default(3),
  retentionDays: z.number().int().min(0).default(0),
});
export type Config = z.infer<typeof configSchema>;
export type Group = z.infer<typeof groupSchema>;
export function validateConfig(value: unknown): Config {
  const c = configSchema.parse(value);
  new Intl.DateTimeFormat('en', { timeZone: c.timezone }).format();
  for (const d of c.digests) CronExpressionParser.parse(d.cron, { tz: c.timezone });
  if (new Set(c.groups.map(g => g.id)).size !== c.groups.length) throw new Error('Duplicate group IDs');
  if (new Set(c.digests.map(d => d.name)).size !== c.digests.length) throw new Error('Duplicate digest names');
  return c;
}
export function loadConfig(): Config {
  // Children, groups and notes are managed from Telegram and live in the database, so the
  // file is optional: a fresh deployment needs only its environment and a data volume.
  const path = process.env.CONFIG_PATH || 'config.json';
  return validateConfig(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
}
const csv = (v = '') => v.split(',').map(x => x.trim()).filter(Boolean);
export function loadEnv() {
  const e = process.env;
  const apiToken = e.API_TOKEN || '';
  if (apiToken.length < 32) throw new Error('API_TOKEN must contain at least 32 characters');
  const telegramChats = csv(e.TELEGRAM_CHAT_IDS), telegramUsers = csv(e.TELEGRAM_USER_IDS);
  if (e.TELEGRAM_BOT_TOKEN && (!telegramChats.length || !telegramUsers.length)) {
    throw new Error('Telegram requires both TELEGRAM_CHAT_IDS and TELEGRAM_USER_IDS');
  }
  return {
    dataDir: resolve(e.DATA_DIR || 'data'), apiToken,
    host: e.HOST || '127.0.0.1', port: z.coerce.number().int().min(1).max(65535).parse(e.PORT || 8080),
    whatsappEnabled: e.WHATSAPP_ENABLED === 'true',
    llmBaseUrl: (e.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    llmApiKey: e.LLM_API_KEY || '', llmModel: e.LLM_MODEL || '',
    llmJsonMode: e.LLM_JSON_MODE !== 'false',
    telegramToken: e.TELEGRAM_BOT_TOKEN || '', telegramChats, telegramUsers,
  };
}
export type Env = ReturnType<typeof loadEnv>;
