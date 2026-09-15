import { hash } from './db.js';
import type { FamilyService } from './service.js';
import type { WhatsAppControl } from './telegram.js';

export interface Button { text: string; callback_data: string }
export interface Screen { text: string; markup: { inline_keyboard: Button[][] }; parseMode?: string }
// Only the screens that build their own markup opt in; everything else stays plain text,
// so a digest full of arbitrary Hebrew can never be mangled as broken HTML.
export const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export interface Pending { action: 'kid_add' | 'kid_context' | 'group_note' | 'wa_phone' | 'group_search'; key?: string }
// Buttons used to carry a position in the last rendered list, which meant an older message
// could act on whatever now sits at that position — another parent's filtered listing, or a
// different child after one was deleted. A short digest of the identity travels instead, and
// is resolved against the stored groups and children rather than against any rendering.
const token = (value: string) => hash(value).slice(0, 12);

const screen = (text: string, rows: Button[][], parseMode?: string): Screen => ({ text, markup: { inline_keyboard: rows }, ...(parseMode ? { parseMode } : {}) });
const back = (to: string): Button => ({ text: '← Назад', callback_data: to });
// Callback payloads are capped at 64 bytes, so screens address kids and groups by position
// in the list they were drawn from rather than by name or JID.
const rows = (buttons: Button[], perRow = 1) =>
  buttons.reduce<Button[][]>((acc, b, i) => (i % perRow ? acc[acc.length - 1]!.push(b) : acc.push([b]), acc), []);

const PAGE = 10;
export class Menu {
  constructor(private service: FamilyService, private whatsapp?: WhatsAppControl) {}
  private get store() { return this.service.store; }

  home(): Screen {
    const kids = this.service.family.length, groups = this.service.groups.length;
    return screen(`Семейный помощник\n\nДетей: ${kids} · Групп: ${groups}\n\nВыберите раздел или просто напишите вопрос обычным текстом.`, [
      [{ text: '🧒 Дети', callback_data: 'kids' }, { text: '💬 Группы', callback_data: 'groups' }],
      [{ text: '📋 Сводка за сутки', callback_data: 'summary' }, { text: '⚙️ Состояние', callback_data: 'status' }],
    ]);
  }

  kids(): Screen {
    const kids = this.service.family, groups = this.service.groups;
    const lines = kids.map(k => {
      const theirs = groups.filter(g => g.children.includes(k.name)).map(g => g.name);
      return `🧒 ${k.name}\n${k.context || 'Описания нет'}\nГруппы: ${theirs.join(', ') || 'нет'}`;
    });
    return screen(kids.length ? `Дети\n\n${lines.join('\n\n')}` : 'Детей пока нет.\n\nДобавьте ребёнка — к нему можно будет привязать группы WhatsApp.', [
      ...rows(kids.map(k => ({ text: k.name, callback_data: `kid:${token(k.name)}` })), 2),
      [{ text: '➕ Добавить ребёнка', callback_data: 'kid_add' }],
      [back('home')],
    ]);
  }

  kid(key: string): Screen {
    const kid = this.service.family.find(k => token(k.name) === key);
    if (!kid) return this.kids();
    const theirs = this.service.groups.filter(g => g.children.includes(kid.name));
    return screen(`🧒 ${kid.name}\n\n${kid.context || 'Описания нет. Оно помогает лучше разбирать сообщения.'}\n\nГруппы: ${theirs.map(g => g.name).join(', ') || 'нет'}`, [
      [{ text: '✏️ Изменить описание', callback_data: `kid:${key}:ctx` }],
      [{ text: '🗑 Удалить ребёнка', callback_data: `kid:${key}:del` }],
      [back('kids')],
    ]);
  }

  async groups(chatId: string, page = 0, force = false): Promise<Screen> {
    // The chat snapshot is what makes archive state and ordering correct, and it is only
    // replayed on request. Ask for it the first time the list is opened after linking, so
    // the reader never has to know that a sync exists. Once per link: it is not cheap.
    if (this.whatsapp && !this.store.get('wa:chatsSynced', false)) {
      this.store.set('wa:chatsSynced', true);
      try { await this.whatsapp.resyncChats(); } catch { /* the list is still usable without it */ }
    }
    const watched = this.service.groups;
    const available = await (this.whatsapp?.refreshGroups(force) ?? Promise.resolve([]));
    const watchedIds = new Set(watched.map(g => g.id));
    const activity = this.whatsapp?.activity() ?? new Map<string, number>();
    const all = [...available, ...watched.filter(g => !available.some(a => a.id === g.id))]
      // A group can have no subject at all; showing its raw JID as a name helps nobody.
      .map(g => { const w = watched.find(x => x.id === g.id); const raw = (w?.name || g.name || '').trim();
        const named = raw && !/^\d+@(g\.us|lid)$/.test(raw);
        return { id: g.id, name: named ? raw : 'Без названия', children: w?.children || [], at: activity.get(g.id) ?? 0, named }; });
    // Followed first, then most recently active, then by name so the order never wobbles.
    all.sort((a, b) => Number(watchedIds.has(b.id)) - Number(watchedIds.has(a.id)) || b.at - a.at || a.name.localeCompare(b.name));
    // Several groups can legitimately share a name, so collisions are dated to tell apart.
    const seen = new Map<string, number>();
    for (const g of all) seen.set(g.name, (seen.get(g.name) ?? 0) + 1);

    const archived = this.whatsapp?.archived() ?? new Set<string>();
    const showArchived = this.store.get<boolean>(`groups:archived:${chatId}`, false);
    const hidden = showArchived ? 0 : all.filter(g => archived.has(g.id) && !watchedIds.has(g.id)).length;
    const visible = showArchived ? all : all.filter(g => !archived.has(g.id) || watchedIds.has(g.id));
    const filter = this.store.get<string>(`groups:filter:${chatId}`, '').toLocaleLowerCase();
    const shown = filter ? visible.filter(g => g.name.toLocaleLowerCase().includes(filter)) : visible;
    // Kept only so the typed /watch N still means the list this reader just saw.
    this.store.set(`chats:listing:${chatId}`, shown.map(g => g.id));
    if (!all.length) return screen('Групп пока нет.\n\nПодключите WhatsApp — после этого здесь появятся ваши группы.', [
      [{ text: '🔗 Подключить WhatsApp', callback_data: 'link' }], [back('home')]]);

    const pages = Math.max(1, Math.ceil(shown.length / PAGE));
    const current = Math.min(Math.max(0, page), pages - 1);
    const slice = shown.slice(current * PAGE, current * PAGE + PAGE);
    const when = (at: number) => at ? new Intl.DateTimeFormat('ru-RU', { timeZone: this.service.config.timezone, day: '2-digit', month: '2-digit' }).format(at) : '';
    // Names go in the text, where nothing is truncated; the buttons are just their numbers.
    const lines = slice.map((g, i) => {
      const number = current * PAGE + i + 1;
      const marks = [watchedIds.has(g.id) ? (g.children.join(', ') || '⚠️ без ребёнка') : '',
        (seen.get(g.name) ?? 0) > 1 || !g.named ? when(g.at) || `id ${g.id.slice(0, 6)}…` : '',
        archived.has(g.id) ? 'архив' : ''].filter(Boolean).join(' · ');
      return `${number}. ${watchedIds.has(g.id) ? '✅' : '➕'} ${g.name}${marks ? `\n     ${marks}` : ''}`;
    });
    const nav: Button[] = [];
    if (current > 0) nav.push({ text: '◀️', callback_data: `groups:p:${current - 1}` });
    if (pages > 1) nav.push({ text: `${current + 1}/${pages}`, callback_data: `groups:p:${current}` });
    if (current < pages - 1) nav.push({ text: '▶️', callback_data: `groups:p:${current + 1}` });
    // A device revoked in WhatsApp leaves a cached list that still looks alive; say otherwise.
    const status = this.store.get<string>('wa:status', 'disabled');
    const dead = status === 'disabled' || status === 'connection_failed' || status.startsWith('needs_attention');
    const stale = this.store.get<string | null>('wa:discoveryError', null);
    return screen(`Группы WhatsApp · ${watchedIds.size} из ${all.length} анализируется`
      + (filter ? `\nФильтр: «${filter}» — найдено ${shown.length}` : '')
      + (hidden ? `\nСкрыто архивных: ${hidden}` : '')
      + (dead ? '\n⚠️ WhatsApp не подключён — список показан по памяти и не обновляется.' : '')
      + (stale ? '\n⚠️ Список может быть устаревшим: WhatsApp не ответил.' : '')
      + (shown.length ? `\n\n${lines.join('\n')}\n\nНажмите номер группы ниже.` : '\n\nНичего не найдено.'), [
      ...rows(slice.map((g, i) => ({ text: String(current * PAGE + i + 1), callback_data: `grp:${token(g.id)}` })), 4),
      ...(nav.length ? [nav] : []),
      ...(dead ? [[{ text: '🔗 Подключить WhatsApp', callback_data: 'link' }]] : []),
      [{ text: filter ? '🔍 Сбросить фильтр' : '🔍 Найти группу', callback_data: filter ? 'groups:clear' : 'groups:find' },
        { text: '🔄 Обновить', callback_data: 'groups:refresh' }],
      ...(hidden || showArchived ? [[{ text: showArchived ? '📥 Скрыть архивные' : `📥 Показать архивные (${hidden})`, callback_data: 'groups:arch' }]] : []),
      [{ text: '🗂 Обновить архив и даты', callback_data: 'groups:sync' }],
      [back('home')],
    ]);
  }

  private findGroup(key: string) {
    return [...this.service.groups, ...(this.whatsapp?.groups() ?? [])].find(g => token(g.id) === key);
  }
  group(key: string): Screen {
    const found = this.findGroup(key);
    if (!found) return this.home();
    const id = found.id;
    const watched = this.service.groups.find(g => g.id === id);
    const name = watched?.name || found.name || id;
    if (!watched) return screen(`💬 ${name}\n\nГруппа не анализируется. Выберите, чьи это сообщения.`, [
      ...rows(this.service.family.map(k => ({ text: `🧒 ${k.name}`, callback_data: `grp:${key}:k:${token(k.name)}` })), 2),
      ...(this.service.family.length ? [] : [[{ text: '➕ Сначала добавьте ребёнка', callback_data: 'kid_add' }]]),
      [back('groups')],
    ]);
    return screen(`💬 ${name}\n\nРебёнок: ${watched.children.join(', ') || '⚠️ не указан'}\nКомментарий: ${watched.context || 'нет'}`, [
      [{ text: '📝 Комментарий', callback_data: `grp:${key}:note` }],
      [{ text: '🧒 Сменить ребёнка', callback_data: `grp:${key}:pick` }],
      [{ text: '❌ Не анализировать', callback_data: `grp:${key}:off` }],
      [back('groups')],
    ]);
  }

  pickKid(key: string): Screen {
    return screen(`Чьи это сообщения?\n\n${this.findGroup(key)?.name || ''}`, [
      ...rows(this.service.family.map(k => ({ text: `🧒 ${k.name}`, callback_data: `grp:${key}:k:${token(k.name)}` })), 2),
      [back(`grp:${key}`)],
    ]);
  }

  private ask(chatId: string, pending: Pending, text: string, cancelTo: string): Screen {
    this.store.set(`pending:${chatId}`, pending);
    return screen(text, [[{ text: '✖️ Отмена', callback_data: `cancel:${cancelTo}` }]]);
  }

  async route(data: string, chatId: string): Promise<Screen> {
    const [head = '', ...rest] = data.split(':');
    const key = rest[0] ?? '';
    if (head === 'cancel') { this.store.set(`pending:${chatId}`, null); return this.route(rest.join(':') || 'home', chatId); }
    switch (head) {
      case 'home': return this.home();
      case 'kids': return this.kids();
      case 'kid_add': return this.ask(chatId, { action: 'kid_add' }, 'Как зовут ребёнка?\n\nОтправьте имя одним сообщением. Можно на двух языках: «Даниэль / דניאל».', 'kids');
      case 'groups': {
        if (rest[0] === 'p') return this.groups(chatId, Number(rest[1]));
        if (rest[0] === 'refresh') { this.store.set(`groups:filter:${chatId}`, ''); return this.groups(chatId, 0, true); }
        if (rest[0] === 'clear') { this.store.set(`groups:filter:${chatId}`, ''); return this.groups(chatId); }
        if (rest[0] === 'sync') {
          try {
            await this.whatsapp!.resyncChats();
            // Show the result rather than a number: the list itself is the confirmation.
            return this.groups(chatId);
          } catch {
            return screen('Не удалось обновить состояние чатов. Проверьте подключение WhatsApp.',
              [[{ text: '⚙️ Состояние', callback_data: 'status' }], [back('groups')]]);
          }
        }
        if (rest[0] === 'arch') { this.store.set(`groups:archived:${chatId}`, !this.store.get(`groups:archived:${chatId}`, false)); return this.groups(chatId); }
        if (rest[0] === 'find') return this.ask(chatId, { action: 'group_search' },
          'Введите часть названия группы — например «כיתה» или «сад».', 'groups');
        this.store.set(`groups:filter:${chatId}`, '');
        return this.groups(chatId);
      }
      case 'facts_ok': return this.confirmFacts(chatId);
      case 'status': return this.status();
      case 'unlink': {
        if (rest[0] !== 'yes') return screen('Отвязать WhatsApp?\n\nСохранённая история сообщений, дети и комментарии останутся. Придётся подключить устройство заново, чтобы снова получать сообщения.',
          [[{ text: '🔌 Да, отвязать', callback_data: 'unlink:yes' }], [back('status')]]);
        try { await this.whatsapp?.unlink(); } catch { /* the link may already be gone on WhatsApp's side */ }
        this.store.set(`groups:filter:${chatId}`, '');
        return screen('WhatsApp отвязан. История, дети и комментарии сохранены.', [
          [{ text: '🔗 Подключить заново', callback_data: 'link' }], [back('home')]]);
      }
      case 'summary': return this.summary(chatId);
      case 'link': {
        this.store.set('wa:pairingChat', chatId);
        if (rest[0] === 'phone') return this.ask(chatId, { action: 'wa_phone' },
          'Отправьте номер телефона этого WhatsApp в международном формате, например +972501234567.', 'link');
        if (rest[0] === 'qr') return this.qr(chatId);
        return screen('Подключение WhatsApp\n\nВыберите, как связать устройство. Код вводится в самом WhatsApp, сканировать ничего не нужно.', [
          [{ text: '📱 По номеру телефона', callback_data: 'link:phone' }],
          [{ text: '📷 Показать QR-код', callback_data: 'link:qr' }],
          [back('home')],
        ]);
      }
      case 'kid': {
        const kid = this.service.family.find(k => token(k.name) === key);
        if (!kid) return this.kids();
        if (rest[1] === 'del') {
          this.service.setFamily(this.service.family.filter(k => k.name !== kid.name));
          this.service.setGroups(this.service.groups.map(g => ({ ...g, children: g.children.filter(c => c !== kid.name) })));
          return this.kids();
        }
        if (rest[1] === 'ctx') return this.ask(chatId, { action: 'kid_context', key },
          `Расскажите про ${kid.name}: класс, учительница, кружки.\n\nЭто помогает точнее разбирать сообщения. Отправьте одним сообщением.`, `kid:${key}`);
        return this.kid(key);
      }
      case 'grp': {
        const found = this.findGroup(key);
        if (!found) return this.home();
        const id = found.id;
        if (rest[1] === 'off') {
          this.service.setGroups(this.service.groups.filter(g => g.id !== id));
          return this.groups(chatId);
        }
        if (rest[1] === 'pick') return this.pickKid(key);
        if (rest[1] === 'note') return this.ask(chatId, { action: 'group_note', key },
          'Что стоит знать про эту группу?\n\nНапример: кто пишет важное, в какие дни занятия, что можно игнорировать. Отправьте одним сообщением.', `grp:${key}`);
        if (rest[1] === 'k') {
          const kid = this.service.family.find(k => token(k.name) === rest[2]);
          if (!kid) return this.group(key);
          const watched = this.service.groups, existing = watched.find(g => g.id === id);
          const name = existing?.name || found.name || id;
          this.service.setGroups([...watched.filter(g => g.id !== id),
            { id, name, children: [kid.name], context: existing?.context || '', alerts: existing?.alerts ?? true }]);
          return this.group(key);
        }
        return this.group(key);
      }
      default: return this.home();
    }
  }

  status(): Screen {
    const stats = this.store.stats();
    const wa = this.store.get<string>('wa:status', 'disabled');
    const labels: Record<string, string> = { connected: '✅ подключён', scan_qr: '📷 ждёт сканирования', connecting: '⏳ подключается',
      reconnecting: '⏳ переподключается', disabled: '— не подключён', connection_failed: '⚠️ не удалось подключиться' };
    // 401 logged out, 440 session taken over elsewhere, 500 unusable session.
    const attention: Record<string, string> = { '401': '⚠️ устройство отвязано — подключите заново',
      '440': '⚠️ сессия занята другим устройством — подключите заново', '500': '⚠️ сессия повреждена — подключите заново' };
    const label = wa.startsWith('needs_attention') ? (attention[wa.split(':')[1] ?? ''] || '⚠️ требуется переподключение') : (labels[wa] || wa);
    return screen(`Состояние\n\nWhatsApp: ${label}\nСообщений: ${stats.messages}\nЖдут анализа: ${stats.pendingAnalysis}\nЖдут отправки: ${stats.pendingDelivery}\nОшибка фоновых задач: ${this.store.get('worker:error', 'нет') || 'нет'}`, [
      ...(wa === 'connected' ? [] : [[{ text: wa.startsWith('needs_attention') ? '🔗 Подключить заново' : '🔗 Подключить WhatsApp', callback_data: 'link' }]]),
      ...(wa === 'disabled' ? [] : [[{ text: '🔌 Отвязать WhatsApp', callback_data: 'unlink' }]]),
      [back('home')],
    ]);
  }

  async summary(chatId: string): Promise<Screen> {
    const to = Date.now();
    try {
      const result = await this.service.summarize(to - 86400000, to);
      // A digest can run past any single message, and the end of it is where the later
      // groups sit. Send it through the splitting queue rather than cutting it to fit here:
      // losing a pickup change off the bottom is the exact failure this app exists to avoid.
      this.store.enqueue(`summary:${to}`, chatId, result.text, false, true);
      return screen(`Сводка за сутки · сообщений: ${result.messageCount}\n\nОтправляю её следующим сообщением.`, [[back('home')]]);
    } catch {
      return screen('Не удалось собрать сводку. Проверьте состояние и настройки модели.', [[{ text: '⚙️ Состояние', callback_data: 'status' }], [back('home')]]);
    }
  }

  private async qr(chatId: string): Promise<Screen> {
    try {
      const value = await this.whatsapp?.pairingQr();
      if (!value) return screen('QR-код пока не готов. Попробуйте ещё раз через несколько секунд.', [[{ text: '🔄 Ещё раз', callback_data: 'link:qr' }], [back('link')]]);
      const QRCode = await import('qrcode');
      const png = await QRCode.default.toBuffer(value, { width: 512, margin: 2 });
      this.store.enqueuePhoto(`qr:${Date.now()}`, chatId, png.toString('base64'),
        'WhatsApp → Настройки → Связанные устройства → Связать устройство. Отсканируйте этот код.');
      return screen('QR-код отправлен следующим сообщением. Он действует около минуты.', [[{ text: '🔄 Новый код', callback_data: 'link:qr' }], [back('home')]]);
    } catch {
      return screen('Не удалось подготовить QR-код.', [[back('link')]]);
    }
  }

  confirmFacts(chatId: string): Screen {
    // The value is stored with the key, not looked up at confirmation time: two readers can
    // propose a fact under the same key, and pressing confirm must approve what was shown
    // on that button, not whatever happens to sit in the row by then.
    const pending = this.store.get<{ key: string; value: string }[]>(`facts:pending:${chatId}`, []);
    if (!pending.length) return screen('Подтверждать нечего.', [[back('home')]]);
    this.store.transaction(() => {
      for (const fact of pending) this.store.remember(fact.key, fact.value, true, []);
      this.store.set(`facts:pending:${chatId}`, []);
    });
    return screen(`Сохранено фактов: ${pending.length}. Теперь они учитываются при анализе.`, [[back('home')]]);
  }

  // A reply to one of the prompts above, rather than a question for the assistant.
  async input(pending: Pending, text: string, chatId: string): Promise<Screen> {
    this.store.set(`pending:${chatId}`, null);
    const value = text.trim().slice(0, 1200);
    if (pending.action === 'wa_phone') {
      try {
        const code = await this.whatsapp!.requestPairingCode(value);
        // <code> makes the pairing code tap-to-copy in every Telegram client.
        return screen(`Код: <code>${escapeHtml(code)}</code>\n\nНажмите на код, чтобы скопировать.\n\nWhatsApp → Настройки → Связанные устройства → Связать устройство → Связать по номеру телефона. Введите этот код, он действует около минуты.`,
          [[{ text: '🔄 Новый код', callback_data: 'link:phone' }], [back('home')]], 'HTML');
      } catch (e) {
        if (e instanceof Error && e.message === 'Already linked') return screen('WhatsApp уже подключён.', [[{ text: '💬 Группы', callback_data: 'groups' }], [back('home')]]);
        return screen('Не удалось начать подключение. Проверьте номер в международном формате.', [[{ text: '🔄 Ещё раз', callback_data: 'link:phone' }], [back('home')]]);
      }
    }
    if (pending.action === 'group_search') {
      this.store.set(`groups:filter:${chatId}`, value.slice(0, 60));
      return this.groups(chatId);
    }
    if (pending.action === 'kid_add') {
      if (this.service.findKid(value)) return this.kids();
      this.service.setFamily([...this.service.family, { name: value, context: '' }]);
      return this.kids();
    }
    if (pending.action === 'kid_context') {
      const kid = this.service.family.find(k => token(k.name) === pending.key);
      if (!kid) return this.kids();
      this.service.setFamily(this.service.family.map(k => k.name === kid.name ? { ...k, context: value } : k));
      return this.kid(pending.key!);
    }
    const found = this.findGroup(pending.key ?? '');
    const watched = this.service.groups, existing = found && watched.find(g => g.id === found.id);
    if (!found || !existing) return this.home();
    this.service.setGroups(watched.map(g => g.id === found.id ? { ...g, context: value } : g));
    const learned = await this.learn(value, found.id, chatId);
    return screen(`Комментарий сохранён.${learned.text}`, learned.facts
      ? [[{ text: '✅ Сохранить факты', callback_data: 'facts_ok' }], [back(`grp:${pending.key}`)]]
      : [[back(`grp:${pending.key}`)]]);
  }

  // The note is the parent's own words and is trusted. What the model reads out of it is
  // model output, so it waits for an explicit confirmation before reaching any prompt.
  async learn(note: string, groupId: string, chatId: string) {
    try {
      const { facts } = await this.service.model.extractFacts(note, this.service.context());
      if (!facts.length) return { text: ' Он будет учитываться при анализе.', facts: false };
      this.store.transaction(() => {
        for (const fact of facts) this.store.remember(`${groupId}:${fact.key}`, fact.value, false, []);
        this.store.set(`facts:pending:${chatId}`, facts.map(f => ({ key: `${groupId}:${f.key}`, value: f.value })));
      });
      return { text: ` Он будет учитываться при анализе.\n\nИз него понятно:\n${facts.map(f => `• ${f.value}`).join('\n')}`, facts: true };
    } catch {
      return { text: ' Разобрать его на отдельные факты не удалось.', facts: false };
    }
  }
}
