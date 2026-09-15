import { CronExpressionParser } from 'cron-parser';
import type { FamilyService } from './service.js';
export function nextRun(cron: string, timezone: string, after: number) {
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date(after) }).next().getTime();
}
export class Scheduler {
  private running = false;
  constructor(private service: FamilyService) {}
  async tick(now = Date.now()) {
    if (this.running || !this.service.recipients.length) return;
    this.running = true;
    try {
      const { config, store } = this.service;
      for (const schedule of config.digests) {
        const key = `schedule:${schedule.name}`;
        const signature = `${schedule.cron}:${config.timezone}`;
        let state = store.get(key, { signature, next: nextRun(schedule.cron, config.timezone, now), from: 0, retryAt: 0, attempts: 0 });
        if (state.signature !== signature) state = { ...state, signature, next: nextRun(schedule.cron, config.timezone, now), retryAt: 0, attempts: 0 };
        store.set(key, state);
        if (now < state.next || now < state.retryAt) continue;
        const from = state.from || now - config.initialDigestHours * 3600000;
        try {
          const summary = await this.service.summarize(from, now);
          store.transaction(() => {
            if (summary.messageCount) for (const recipient of this.service.recipients) store.enqueue(`digest:${schedule.name}:${state.next}`, recipient, summary.text, true, false, now);
            store.set(key, { signature, next: nextRun(schedule.cron, config.timezone, now), from: now, retryAt: 0, attempts: 0 });
            store.set(`${key}:error`, null);
          });
        } catch {
          const attempts = (state.attempts || 0) + 1;
          if (attempts < config.maxDigestAttempts) {
            store.set(key, { ...state, from, retryAt: now + 300000, attempts });
            store.set(`${key}:error`, `Digest failed ${attempts} time(s); retry in five minutes. Check model configuration and message limits.`);
            continue;
          }
          // Some failures never clear on their own — an oversized window only grows as it
          // waits. Give the period up so later digests still run, and say so rather than
          // dropping it quietly; the messages themselves stay searchable via /summary.
          const at = (ts: number) => new Intl.DateTimeFormat('ru-RU', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'short' }).format(ts);
          const notice = `⚠️ Сводка «${schedule.name}» не сформирована за период ${at(from)} — ${at(now)} (попыток: ${attempts}). Период пропущен, следующая сводка выйдет по расписанию. Сообщения сохранены: запросите их командой /summary за нужный период.`;
          store.transaction(() => {
            store.set(key, { signature, next: nextRun(schedule.cron, config.timezone, now), from: now, retryAt: 0, attempts: 0 });
            store.set(`${key}:error`, `Digest failed ${attempts} time(s); the period was skipped to keep later digests running. Check model configuration and message limits.`);
            for (const recipient of this.service.recipients) store.enqueue(`digest-skipped:${schedule.name}:${state.next}`, recipient, notice, false, false, now);
          });
        }
      }
    } finally { this.running = false; }
  }
}
