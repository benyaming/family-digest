import { hash, Store } from './db.js';
import type { Config, Group } from './config.js';
import { ReplyError, type Analysis, type IncomingMessage, type Message, type Model } from './types.js';

/** A unit whose messages changed under it while the model was running. */
class StaleUnit extends Error {}

export function chunkMessages(messages: Message[], max: number): Message[][] {
  const chunks: Message[][] = [];
  let batch: Message[] = [], size = 0;
  for (const message of messages) {
    // A long pasted notice is split into parts with the same source, never silently truncated.
    const textSize = Math.max(1000, max - 1000);
    for (let offset = 0; offset < Math.max(1, message.text.length); offset += textSize) {
      const part = { ...message, text: message.text.slice(offset, offset + textSize) };
      const length = JSON.stringify(part).length;
      if (size + length > max && batch.length) { chunks.push(batch); batch = []; size = 0; }
      batch.push(part); size += length;
    }
  }
  if (batch.length) chunks.push(batch);
  return chunks;
}
export function isQuiet(c: Config, now: number): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: c.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  const { start, end } = c.quietHours;
  return start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
export class FamilyService {
  private analyzing = false;
  private summaries = new Map<string, Promise<{ text: string; messageCount: number; from: number; to: number }>>();
  constructor(public store: Store, public config: Config, public model: Model, public recipients: string[] = []) {}
  // Selection lives in the database, not config.json: the file is mounted read-only and
  // onboarding happens from Telegram. config.json seeds the first run and supplies the
  // per-group children/context that a chat command cannot express well.
  get groups(): Group[] {
    const selected = this.store.get<Group[] | null>('groups:selected', null);
    if (!selected) return this.config.groups;
    // config.json seeds, it does not govern. What was chosen in the chat is authoritative,
    // and the file only fills in what nobody has set there — otherwise assigning a child
    // from Telegram would report success while the effective group kept its old one.
    return selected.map(g => {
      const seed = this.config.groups.find(c => c.id === g.id);
      if (!seed) return g;
      // Children are assigned in the chat and deleting one empties them here, so the file
      // must not put them back; it seeds a group's name and note, nothing that is managed.
      return { ...g, name: seed.name || g.name, context: g.context || seed.context };
    });
  }
  setGroups(groups: Group[]) {
    // A newly followed group has no history here: WhatsApp only ships the dump at link time.
    // Mark it so the client can ask for older messages once it has something to page from.
    const before = new Set(this.groups.map(g => g.id));
    const added = groups.map(g => g.id).filter(id => !before.has(id));
    this.store.set('groups:selected', groups);
    if (added.length) this.store.set('wa:backfill', [...new Set([...this.store.get<string[]>('wa:backfill', []), ...added])]);
  }
  // Kids are managed from chat like groups are; config.json seeds the first run.
  get family(): { name: string; context: string }[] {
    return this.store.get<{ name: string; context: string }[] | null>('family:members', null) ?? this.config.family;
  }
  setFamily(members: { name: string; context: string }[]) { this.store.set('family:members', members); }
  // "Даниэль / דניאל" should answer to either half, and to a unique prefix of either.
  findKid(query: string) {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return undefined;
    const parts = (kid: { name: string }) => kid.name.split('/').map(p => p.trim().toLocaleLowerCase()).filter(Boolean);
    const exact = this.family.find(k => parts(k).some(p => p === needle));
    if (exact) return exact;
    // A prefix is only an answer when it names one child: "Дани" between Даниэль and Данила
    // would otherwise delete or reassign whichever happens to be stored first.
    const prefixed = this.family.filter(k => parts(k).some(p => p.startsWith(needle)));
    return prefixed.length === 1 ? prefixed[0] : undefined;
  }
  get chatIds() { return this.groups.map(g => g.id); }
  context(group?: Group, now = Date.now()) {
    return { now: new Date(now).toISOString(), timezone: this.config.timezone, language: this.config.language,
      family: this.family, group, confirmedMemory: this.store.memories().slice(0, 50), alertRules: this.config.alertRules,
      recentAlerts: this.store.db.prepare('SELECT id,title FROM alerts WHERE created_at>? ORDER BY created_at DESC LIMIT 40').all(now - 7 * 86400000) };
  }
  ingest(messages: IncomingMessage[]) {
    let inserted = 0, ignored = 0;
    this.store.transaction(() => {
      for (const m of messages) {
        if (!this.chatIds.includes(m.chatId) || !m.text.trim()) { ignored++; continue; }
        if (this.store.insert(m)) inserted++; else ignored++;
      }
    });
    return { inserted, ignored };
  }
  selectGroups(filter?: string) {
    if (!filter) return this.groups;
    const matches = this.groups.filter(g => g.id === filter || g.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
    if (!matches.length) throw new ReplyError('Группа не найдена. Используйте /chats.');
    return matches;
  }
  /** The calendar day a finite instant falls on, in the family's own timezone. */
  private day(at: number) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.config.timezone, dateStyle: 'short' }).format(at);
  }
  formatSource(message: Message) {
    const group = this.groups.find(g => g.id === message.chat_id)?.name || message.chat_id;
    const date = new Intl.DateTimeFormat('ru-RU', { timeZone: this.config.timezone, dateStyle: 'short', timeStyle: 'short' }).format(message.timestamp);
    return `[${message.id}] ${group} · ${date} · ${message.sender}\n${message.text}`;
  }
  private record(group: Group, analysis: Analysis, now: number) {
    this.store.db.prepare('INSERT INTO analyses(chat_id,created_at,result) VALUES(?,?,?)').run(group.id, now, JSON.stringify(analysis));
    for (const memory of analysis.memories) this.store.remember(`${group.id}:${memory.key}`, memory.value, false, memory.sources, now);
  }
  async summarize(from: number, to: number, filter?: string) {
    const key = `${from}:${to}:${filter || ''}`;
    const existing = this.summaries.get(key);
    if (existing) return existing;
    const run = this.buildSummary(from, to, filter);
    this.summaries.set(key, run);
    try { return await run; } finally { this.summaries.delete(key); }
  }
  private async buildSummary(from: number, to: number, filter?: string) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new ReplyError('Некорректный период.');
    const groups = this.selectGroups(filter);
    const messages = this.store.messages(from, to, groups.map(g => g.id), this.config.maxSummaryMessages + 1);
    if (messages.length > this.config.maxSummaryMessages) throw new ReplyError('Слишком много сообщений. Выберите более короткий период.');
    const date = (ts: number) => new Intl.DateTimeFormat('ru-RU', { timeZone: this.config.timezone, dateStyle: 'short', timeStyle: 'short' }).format(ts);
    const parts = [`Семейная сводка · ${date(from)} — ${date(to)}\nСообщений: ${messages.length}`];
    for (const group of groups) {
      const selected = messages.filter(m => m.chat_id === group.id);
      if (!selected.length) continue;
      parts.push(`\n${group.name} (${selected.length})`);
      for (const chunk of chunkMessages(selected, this.config.chunkCharacters)) {
        const analysis = await this.model.analyze(chunk, this.context(group, to));
        this.store.transaction(() => this.record(group, analysis, Date.now()));
        parts.push(analysis.overview);
        const findings = [...analysis.findings].sort((a, b) => ['urgent', 'important', 'routine'].indexOf(a.priority) - ['urgent', 'important', 'routine'].indexOf(b.priority));
        for (const finding of findings) parts.push(`${finding.actionable ? '☐' : '•'} ${finding.title}: ${finding.detail}\n${finding.sources.map(s => `[${s}]`).join(' ')}`);
      }
    }
    if (!messages.length) parts.push('За этот период в сохранённой истории сообщений нет.');
    else parts.push('\nОригинал сообщения: /source ID. Вложения без подписи не прочитаны.');
    return { text: parts.join('\n'), messageCount: messages.length, from, to };
  }
  /**
   * Groups pending messages into units of work. A unit owns whole messages, never parts of
   * one: a message too large for a single model call gets a unit to itself, and its
   * fragments are that unit's internal business. The unit is the transaction boundary, so
   * what it decides is published together or not at all.
   */
  private planUnits(messages: Message[], max: number): Message[][] {
    const units: Message[][] = [];
    let unit: Message[] = [], size = 0;
    for (const message of messages) {
      const length = JSON.stringify(message).length;
      if (length > max) {
        if (unit.length) { units.push(unit); unit = []; size = 0; }
        units.push([message]);
        continue;
      }
      if (size + length > max && unit.length) { units.push(unit); unit = []; size = 0; }
      unit.push(message); size += length;
    }
    if (unit.length) units.push(unit);
    return units;
  }

  async analyzePending(now = Date.now()) {
    if (this.analyzing) return;
    this.analyzing = true;
    try {
      const pending = this.store.pending(this.chatIds);
      const stale = pending.filter(m => m.timestamp < now - this.config.alertMaxAgeHours * 3600000);
      this.store.transaction(() => this.store.markAnalyzed(stale.map(m => m.id)));
      const failures: unknown[] = [];
      for (const group of this.groups) {
        const targets = pending.filter(m => m.chat_id === group.id && !stale.includes(m));
        for (const unit of this.planUnits(targets, this.config.chunkCharacters)) {
          try {
            // Include a small recent conversation window so replies/corrections have context.
            const start = Math.min(...unit.map(m => m.timestamp));
            const earlier = this.store.db.prepare('SELECT * FROM messages WHERE chat_id=? AND timestamp>=? AND timestamp<? ORDER BY timestamp DESC,id DESC LIMIT 15')
              .all(group.id, start - 6 * 3600000, start) as unknown as Message[];
            const context = earlier.filter(m => m.text.length < 2000);
            // A message larger than one model call is split here, inside the unit. Every
            // fragment is analysed and their findings are collected into one decision, so an
            // action in the first part and an unrelated one in the last both survive, and
            // neither is published until the whole message has been read.
            const analyses: Analysis[] = [];
            for (const fragment of chunkMessages(unit, this.config.chunkCharacters)) {
              analyses.push(await this.model.analyze([...context, ...fragment], this.context(group, now)));
            }
            this.store.transaction(() => {
              // The work was computed against these exact revisions. If any was edited or
              // completed while the model was running, the whole unit is abandoned and the
              // corrected text is left pending for a fresh analysis.
              if (!this.store.completeUnit(unit.map(m => ({ id: m.id, revision: m.revision })),
                context.map(m => ({ id: m.id, revision: m.revision })))) {
                throw new StaleUnit();
              }
              for (const analysis of analyses) this.record(group, analysis, now);
              if (!group.alerts) return;
              const raised = new Set<string>();
              for (const analysis of analyses) for (const finding of analysis.findings) {
                if (!this.recipients.length || finding.priority === 'routine' || !finding.actionable || finding.confidence < this.config.alertMinConfidence) continue;
                const freshSources = unit.filter(m => finding.sources.includes(m.id));
                if (!freshSources.length) continue; // Never alert on old context alone.
                // Compared by day, not by instant: a model given a date with no clock time
                // answers midnight, and every same-day notice would read as already expired.
                // An unparseable deadline suppresses nothing — the schema's offset pattern
                // accepts values Date.parse cannot read, and a malformed one is not evidence
                // that the notice has passed.
                const due = finding.dueAt ? Date.parse(finding.dueAt) : Number.NaN;
                if (Number.isFinite(due) && this.day(due) < this.day(now)) continue;
                const eventIdentity = finding.eventKey.trim().toLocaleLowerCase() || finding.sources.slice().sort().join(',');
                const eventDay = finding.dueAt || new Date(Math.max(...freshSources.map(m => m.timestamp))).toISOString().slice(0, 10);
                // Scoped to the group: two children can be told the same thing on the same day
                // in their own groups, and the second parent alert must not be read as a repeat.
                const fingerprint = hash(`${group.id}:${finding.title.trim().toLocaleLowerCase()}:${freshSources.map(m => m.text.trim().replace(/\s+/g, ' ')).sort().join('\n')}`);
                const id = hash(`${group.id}:${eventIdentity}:${eventDay}:${fingerprint}`);
                // Within this decision, the same event raised by two fragments is one alert.
                if (raised.has(id)) continue;
                raised.add(id);
                // Across decisions this stays best effort: it suppresses a notice repeated
                // verbatim, and deliberately does not veto a correction that reads differently.
                const duplicate = this.store.db.prepare('SELECT id FROM alerts WHERE id=? OR (fingerprint=? AND created_at>?)')
                  .get(id, fingerprint, now - 2 * 86400000);
                if (duplicate) continue;
                this.store.db.prepare('INSERT INTO alerts VALUES(?,?,?,?)').run(id, now, finding.title, fingerprint);
                const originals = freshSources.slice(0, 2).map(m => this.formatSource({ ...m, text: m.text.slice(0, 800) + (m.text.length > 800 ? '… (полный текст: /source ' + m.id + ')' : '') })).join('\n\n');
                const text = `${finding.priority === 'urgent' ? '🚨 Срочно' : '🔔 Важно'} · ${group.name}\n${finding.title}\n${finding.detail}\n\nИсточник:\n${originals}`;
                for (const recipient of this.recipients) this.store.enqueue(`alert:${id}`, recipient, text, false, finding.priority === 'urgent', now);
              }
            });
          } catch (error) {
            // A unit that lost its race is not a failure worth reporting: its messages are
            // still pending and the corrected text will be analysed on the next pass.
            if (!(error instanceof StaleUnit)) failures.push(error);
          }
        }
      }
      if (failures.length) throw new AggregateError(failures, 'One or more group analyses failed');
    } finally { this.analyzing = false; }
  }
  async ask(question: string) {
    const terms = await this.model.searchTerms(question);
    const found = new Map<string, Message>();
    for (const query of [question, ...terms]) for (const m of this.store.search(query, this.chatIds, 12)) found.set(m.id, m);
    const messages = [...found.values()].slice(0, 50);
    // Keep retrieval bounded; disclose when only part of the matching history fits.
    const chunks = chunkMessages(messages, this.config.chunkCharacters * 2);
    const selected = chunks[0] || [];
    const result = await this.model.answer(question, selected, this.context());
    const sources = result.sources.map(id => this.store.source(id, this.chatIds)).filter((m): m is Message => !!m);
    return { ...result, sources, text: `${result.answer}${sources.length ? '\n\nИсточники:\n' + sources.map(m => this.formatSource(m)).join('\n\n') : ''}${chunks.length > 1 ? '\nПоказана часть найденных сообщений. Уточните запрос для более точного поиска.' : ''}` };
  }
  topics(query = '') {
    const rows = this.store.db.prepare('SELECT chat_id,created_at,result FROM analyses ORDER BY created_at DESC LIMIT 100').all();
    return rows.filter(r => this.chatIds.includes(r.chat_id as string)).map(r => ({ chatId: r.chat_id, createdAt: r.created_at, ...JSON.parse(r.result as string) }))
      .filter(r => !query || JSON.stringify(r).toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 20);
  }
}
