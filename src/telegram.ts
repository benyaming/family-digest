import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { Menu, escapeHtml, type Pending } from './menu.js';
import { ReplyError } from './types.js';
import type { Env } from './config.js';
import { FamilyService, isQuiet } from './service.js';

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id?: number; text?: string; from?: { id: number }; chat: { id: number; type?: string } };
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { message_id: number; chat: { id: number; type?: string } } };
}
export class TelegramError extends Error {
  constructor(public code: number, public retryAfter = 0, public description = '') { super(`Telegram HTTP/API error ${code}`); }
}
export function durationHours(value = '24h') {
  const match = /^(\d+)(h|d)$/i.exec(value);
  if (!match) throw new ReplyError('Период: 24h, 48h или 7d (до 30 дней).');
  const hours = Number(match[1]) * (match[2]!.toLowerCase() === 'd' ? 24 : 1);
  if (hours < 1 || hours > 720) throw new ReplyError('Период должен быть от 1 часа до 30 дней.');
  return hours;
}
export interface WhatsAppControl {
  requestPairingCode(phone: string): Promise<string>;
  pairingQr(timeout?: number): Promise<string | null>;
  unlink(): Promise<void>;
  groups(): { id: string; name: string }[];
  refreshGroups(force?: boolean): Promise<{ id: string; name: string }[]>;
  archived(): Set<string>;
  resyncChats(): Promise<number>;
  activity(): Map<string, number>;
}
export class Telegram {
  // Anything that changes configuration is refused outside a parent's private chat.
  // Commands that build their own markup; every other reply is sent as plain text.
  private static html = new Set(['/link']);
  private static management = new Set(['/chats', '/kids', '/kid', '/watch', '/unwatch', '/note', '/confirm', '/link', '/unlink', '/remember', '/forget']);
  private stopping = false;
  private delivering?: Promise<void>;
  private queued = false;
  private lastSend = 0;
  private controller = new AbortController();
  private menu: Menu;
  constructor(private service: FamilyService, private env: Pick<Env, 'telegramToken' | 'telegramChats' | 'telegramUsers'>, private request: typeof fetch = fetch, private whatsapp?: WhatsAppControl) { this.menu = new Menu(service, whatsapp); }
  stop() { this.stopping = true; this.controller.abort(); }
  // The "/" menu is how commands are discovered, and it is scoped: a parent's own chat
  // offers setup, the family group offers only what makes sense in front of everyone.
  private static privateCommands = [
    { command: 'start', description: 'Меню: дети, группы, подключение' },
    { command: 'summary', description: 'Сводка за период, например /summary 24h' },
    { command: 'ask', description: 'Вопрос по истории сообщений' },
    { command: 'kids', description: 'Дети и их группы' },
    { command: 'chats', description: 'Группы WhatsApp' },
    { command: 'memory', description: 'Подтверждённые факты о семье' },
    { command: 'candidates', description: 'Факты, предложенные моделью' },
    { command: 'topics', description: 'Что обсуждалось' },
    { command: 'search', description: 'Поиск оригиналов на иврите' },
    { command: 'status', description: 'Состояние сервиса' },
    { command: 'help', description: 'Список всех команд' },
  ];
  private static groupCommands = [
    { command: 'summary', description: 'Сводка за период, например /summary 24h' },
    { command: 'ask', description: 'Вопрос по истории сообщений' },
    { command: 'search', description: 'Поиск оригиналов на иврите' },
    { command: 'source', description: 'Показать исходное сообщение по ID' },
    { command: 'topics', description: 'Что обсуждалось' },
    { command: 'status', description: 'Состояние сервиса' },
    { command: 'help', description: 'Список всех команд' },
  ];
  // Scanning a QR gives no feedback in Telegram, so the bot has to say it worked.
  async announceLinked() {
    const store = this.service.store;
    const chatId = store.get<string | null>('wa:pairingChat', null);
    if (!chatId) return;
    // The QR belongs to the chat it was sent to. Pairing can be restarted from a different
    // chat, so a bare message id would aim this deletion at whatever chat is current now.
    const qr = store.get<{ chat: string; id: number } | null>('wa:qrMessage', null);
    // Only the chat that was shown the QR may have it removed, and only that case forgets
    // it: clearing the record for somebody else's QR would strand it for good.
    if (qr && qr.chat === chatId) {
      await this.erase(chatId, qr.id);
      store.set('wa:qrMessage', null);
    }
    // Pairing is finished, so a later reconnect is not something anyone asked to be told about.
    store.set('wa:pairingChat', null);
    const count = this.whatsapp?.groups().length ?? 0;
    const screen = await this.menu.route('groups', chatId);
    await this.renderMenu(chatId, `linked:${Date.now()}`, {
      ...screen,
      text: `✅ WhatsApp подключён. Найдено групп: ${count}.\n\n${screen.text}`,
    });
  }
  async publishCommands() {
    if (!this.env.telegramToken) return;
    try {
      await this.call('setMyCommands', { commands: Telegram.privateCommands, scope: { type: 'all_private_chats' } });
      await this.call('setMyCommands', { commands: Telegram.groupCommands, scope: { type: 'all_group_chats' } });
      // Telegram resolves a chat-scoped list before all_private_chats, so a leftover list
      // on a parent's own chat — from a bot shared with another project — would hide ours.
      for (const user of this.env.telegramUsers) {
        await this.call('setMyCommands', { commands: Telegram.privateCommands, scope: { type: 'chat', chat_id: Number(user) } });
      }
      this.service.store.set('telegram:commandsError', null);
    } catch {
      // Purely cosmetic: a stale menu must never stop the bot from running.
      this.service.store.set('telegram:commandsError', 'Could not publish the command menu');
    }
  }
  static advertised(direct: boolean) { return (direct ? Telegram.privateCommands : Telegram.groupCommands).map(c => `/${c.command}`); }
  async call(method: string, body: unknown) {
    const response = await this.request(`https://api.telegram.org/bot${this.env.telegramToken}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(40000)]),
    });
    const data = await response.json() as { ok: boolean; result: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (!response.ok || !data.ok) throw new TelegramError(data.error_code || response.status, data.parameters?.retry_after, data.description);
    return data.result;
  }
  // sendPhoto cannot carry binary in a JSON body, so pairing images go up as multipart.
  async sendPhoto(chatId: string, base64: string, caption: string, silent: boolean, store?: { set(k: string, v: unknown): void }) {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('disable_notification', String(silent));
    form.append('photo', new Blob([Buffer.from(base64, 'base64')], { type: 'image/png' }), 'pairing.png');
    const response = await this.request(`https://api.telegram.org/bot${this.env.telegramToken}/sendPhoto`, {
      method: 'POST', body: form,
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(40000)]),
    });
    const data = await response.json() as { ok: boolean; result?: { message_id?: number }; error_code?: number; parameters?: { retry_after?: number } };
    if (!response.ok || !data.ok) throw new TelegramError(data.error_code || response.status, data.parameters?.retry_after);
    // A pairing QR is transient: remember it so it can be cleared once linking succeeds.
    const id = data.result?.message_id;
    store?.set('wa:qrMessage', id ? { chat: chatId, id } : null);
  }
  private static direct(chat?: { id: number; type?: string }, from?: { id: number }) {
    return !!chat && chat.type === 'private' && !!from && String(chat.id) === String(from.id);
  }
  allowed(update: TelegramUpdate) {
    const from = update.message?.from ?? update.callback_query?.from;
    const chat = update.message?.chat ?? update.callback_query?.message?.chat;
    if (!from || !chat || !this.env.telegramUsers.includes(String(from.id))) return false;
    // A private chat's ID is the user's own ID, so an allowed parent can always reach the
    // bot directly without their DM being listed as a broadcast destination.
    return Telegram.direct(chat, from) || this.env.telegramChats.includes(String(chat.id));
  }
  async command(text: string, chatId = '', direct = true): Promise<string> {
    const [raw = '', ...words] = text.trim().split(/\s+/);
    const cmd = raw.split('@')[0]!.toLowerCase(), args = words.join(' ');
    const service = this.service, store = service.store;
    if (!direct && Telegram.management.has(cmd)) return 'Настройка — в личном чате со мной: откройте диалог с ботом и отправьте /start.\nЗдесь можно спрашивать: /summary 24h, /ask вопрос, или просто напишите вопрос текстом.';
    switch (cmd) {
      case '/help': return 'Семейный помощник\n/link +9725XXXXXXXX — подключить WhatsApp кодом\n/link qr — подключить по QR-коду\n/kids — дети и их группы\n/kid add Имя — добавить ребёнка\n/kid Имя описание — контекст ребёнка\n/chats — группы: отслеживаемые и доступные\n/watch N Имя [комментарий] — привязать группу к ребёнку\n/note N текст — комментарий к группе\n/confirm — подтвердить факты из комментария\n/unwatch N — перестать\n/unlink — отвязать WhatsApp\n/summary 24h [группа] — сводка\n/ask Когда экскурсия? — вопрос по истории\n/search טיול — поиск оригиналов\n/source ID — исходное сообщение\n/memory — подтверждённые факты\n/candidates — предложенные факты\n/remember ключ = факт — сохранить/подтвердить\n/forget ключ — удалить факт\n/topics [слово] — обсуждавшиеся темы\n/status — состояние\nМожно задавать вопросы обычным текстом на русском.';
      case '/summary': {
        const hours = durationHours(words[0]), to = Date.now();
        return (await service.summarize(to - hours * 3600000, to, words.slice(1).join(' ') || undefined)).text;
      }
      case '/search': {
        if (!args) return 'Пример: /search טיול';
        return store.search(args, service.chatIds, 10).map(m => service.formatSource(m)).join('\n\n') || 'Совпадений нет. /ask умеет переводить запрос на иврит.';
      }
      case '/source': { const m = store.source(args, service.chatIds); return m ? service.formatSource(m) : 'Сообщение не найдено или срок хранения истёк.'; }
      // One implementation of each screen: the menu owns it, this is the text view.
      case '/chats': return (await this.menu.route('groups', chatId)).text;
      case '/kids': return (await this.menu.route('kids', chatId)).text;
      case '/kid': {
        const [action = '', ...rest] = words;
        const value = rest.join(' ');
        if (action.toLowerCase() === 'add') {
          if (!value) return 'Формат: /kid add Даниэль';
          if (service.findKid(value)) return 'Такой ребёнок уже есть. /kids';
          service.setFamily([...service.family, { name: value, context: '' }]);
          return `Ребёнок «${value}» добавлен. Привяжите группу: /chats, затем /watch N ${value}`;
        }
        if (action.toLowerCase() === 'remove') {
          const kid = service.findKid(value);
          if (!kid) return service.family.length ? `Не понял, кто это. Напишите имя целиком: ${service.family.map(k => k.name).join(', ')}` : 'Детей пока нет. /kids';
          service.setFamily(service.family.filter(k => k.name !== kid.name));
          service.setGroups(service.groups.map(g => ({ ...g, children: g.children.filter(c => c !== kid.name) })));
          return `Ребёнок «${kid.name}» удалён. Группы остались, но больше ни к кому не привязаны.`;
        }
        if (!action) return 'Формат: /kid add Имя · /kid Имя описание · /kid remove Имя';
        const kid = service.findKid(action);
        if (!kid) return 'Ребёнок не найден. Добавить: /kid add ' + action;
        if (!value) return `${kid.name}\n${kid.context || 'Описания пока нет.'}`;
        service.setFamily(service.family.map(k => k.name === kid.name ? { ...k, context: value } : k));
        return `Описание для «${kid.name}» сохранено. Оно учитывается при анализе.`;
      }
      case '/watch': case '/unwatch': case '/note': {
        if (!words.length) return `Укажите номер из /chats, например: ${cmd} 2${cmd === '/watch' ? ' Даниэль' : ''}`;
        const listing = store.get<string[]>(`chats:listing:${chatId}`, []);
        const position = Number(words[0]);
        const id = Number.isInteger(position) && position >= 1 && position <= listing.length ? listing[position - 1]! : words[0]!;
        const watched = service.groups;
        if (cmd === '/unwatch') {
          const remaining = watched.filter(g => g.id !== id);
          if (remaining.length === watched.length) return 'Эта группа не отслеживается. Откройте /chats.';
          service.setGroups(remaining);
          return 'Группа убрана. Сохранённая история остаётся, новые сообщения не анализируются.';
        }
        const existing = watched.find(g => g.id === id);
        if (cmd === '/note') {
          if (!existing) return 'Сначала добавьте группу: /watch N Имя';
          const note = words.slice(1).join(' ');
          if (!note) return `Комментарий: ${existing.context || 'пока пустой'}\nИзменить: /note ${words[0]} текст`;
          service.setGroups(watched.map(g => g.id === id ? { ...g, context: note } : g));
          const learned = await this.menu.learn(note, id, chatId);
          return `Комментарий сохранён.${learned.text}${learned.facts ? '\nПодтвердить: /confirm' : ''}`;
        }
        // Kid names are consumed greedily, so the rest of the line is free-text comment.
        const kids: string[] = [];
        let index = 1;
        for (; index < words.length; index++) {
          const kid = service.findKid(words[index]!.replace(/,$/, ''));
          if (!kid || kids.includes(kid.name)) break;
          kids.push(kid.name);
        }
        const note = words.slice(index).join(' ');
        if (!kids.length) {
          if (!service.family.length) return 'Сначала добавьте ребёнка: /kid add Даниэль';
          return `Укажите ребёнка: ${cmd} ${words[0]} ${service.family[0]!.name}\nДети: ${service.family.map(k => k.name).join(', ')}`;
        }
        const found = existing || (this.whatsapp?.groups() || []).find(g => g.id === id);
        if (!found) return 'Группа не найдена. Откройте /chats.';
        const group = { id: found.id, name: found.name, children: kids, context: note || existing?.context || '',
          alerts: existing?.alerts ?? true };
        service.setGroups([...watched.filter(g => g.id !== id), group]);
        const learned = note ? await this.menu.learn(note, id, chatId) : null;
        const noteResult = learned ? `${learned.text}${learned.facts ? '\nПодтвердить: /confirm' : ''}` : '';
        const verb = existing ? 'обновлена' : 'добавлена';
        return `Группа «${found.name}» ${verb} для: ${kids.join(', ')}.${noteResult}`;
      }
      case '/link': {
        if (!this.whatsapp) return 'Управление WhatsApp недоступно.';
        if (!args) return 'Подключение WhatsApp:\n/link +9725XXXXXXXX — код из 8 символов\n/link qr — QR-код картинкой';
        // announceLinked() confirms the link and clears the spent QR in this chat, and it has no
        // other way to know which chat asked. Without this the documented typed path pairs
        // successfully and then says nothing at all.
        store.set('wa:pairingChat', chatId);
        try {
          if (args.toLowerCase() === 'qr') {
            const value = await this.whatsapp.pairingQr();
            if (!value) return 'QR-код пока не готов. Повторите /link qr через несколько секунд.';
            const png = await QRCode.toBuffer(value, { width: 512, margin: 2 });
            store.enqueuePhoto(`qr:${Date.now()}`, chatId, png.toString('base64'),
              'WhatsApp → Настройки → Связанные устройства → Связать устройство. Отсканируйте этот код.');
            return 'QR-код отправлен. Он действует около минуты — если не успели, повторите /link qr';
          }
          const code = await this.whatsapp.requestPairingCode(args);
          return `Код: <code>${escapeHtml(code)}</code>\n\nНажмите на код, чтобы скопировать.\n\nWhatsApp → Настройки → Связанные устройства → Связать устройство → Связать по номеру телефона. Введите этот код. Он действует около минуты.`;
        } catch (e) {
          if (e instanceof Error && e.message === 'Already linked') return 'WhatsApp уже подключён. Состояние: /status';
          return 'Не удалось начать подключение. Укажите номер в международном формате, например /link +972501234567, и повторите.';
        }
      }
      case '/unlink': {
        if (!this.whatsapp) return 'Управление WhatsApp недоступно.';
        await this.whatsapp.unlink();
        return 'WhatsApp отвязан. Сохранённая история остаётся. Подключить заново: /link';
      }
      case '/memory': return store.memories().map(m => `${m.key} = ${m.value}`).join('\n\n') || 'Фактов пока нет. /remember имя.класс = 2А';
      case '/candidates': return store.memories(false).filter(m => !m.confirmed).slice(0, 20).map(m => `${m.key} = ${m.value}\nИсточники: ${JSON.parse(m.sources).join(', ')}`).join('\n\n') || 'Новых предложений нет. Подтвердить факт: /remember ключ = факт';
      case '/remember': {
        const split = args.indexOf('=');
        if (split < 1 || !args.slice(split + 1).trim()) return 'Формат: /remember ключ = факт';
        const key = args.slice(0, split).trim(), value = args.slice(split + 1).trim();
        if (key.length > 200 || value.length > 1200) return 'Слишком длинный ключ или факт.';
        store.remember(key, value, true); return 'Сохранено в подтверждённой памяти.';
      }
      case '/confirm': return this.menu.confirmFacts(chatId).text;
      case '/forget': return store.forget(args) ? 'Факт удалён.' : 'Такой ключ не найден.';
      case '/topics': return service.topics(args).map(t => `${new Date(Number(t.createdAt)).toISOString().slice(0, 10)} · ${t.overview}`).join('\n\n') || 'Сохранённых обсуждений пока нет. Запросите сводку.';
      case '/status': return `WhatsApp: ${store.get('wa:status', 'disabled')}\nСообщений: ${store.stats().messages}\nВ очереди анализа: ${store.stats().pendingAnalysis}\nВ очереди Telegram: ${store.stats().pendingDelivery}\nСбоев доставки: ${store.stats().deliveryFailures}\nЧасовой пояс: ${service.config.timezone}\nРасписание: ${service.config.digests.map(d => `${d.name}: ${d.cron}`).join('; ')}\nПоследний успешный анализ: ${store.get('worker:lastSuccess', 'ещё не выполнялся')}\nОшибка фоновых задач: ${store.get('worker:error', 'нет')}`;
      case '/ask': return args ? (await service.ask(args)).text : 'Например: /ask Что нужно принести завтра?';
      default: return raw.startsWith('/') ? 'Неизвестная команда. /help' : (await service.ask(text)).text;
    }
  }
  private showMenu(chatId: string, key: string, screen: { text: string; markup: unknown; parseMode?: string }) {
    this.service.store.enqueueMenu(key, chatId, screen.text, screen.markup, Date.now(), screen.parseMode);
  }
  // Model calls and WhatsApp syncs take seconds, and Telegram shows nothing while they run.
  // The indicator expires after about five seconds, so it is refreshed until the work ends.
  private working(chatId: string, action = 'typing') {
    let done = false;
    const show = () => { if (!done) void this.call('sendChatAction', { chat_id: chatId, action }).catch(() => {}); };
    show();
    const timer = setInterval(show, 4000);
    timer.unref?.();
    return () => { done = true; clearInterval(timer); };
  }
  private async erase(chatId: string, messageId?: number) {
    if (messageId) await this.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
  }
  // One menu message per chat, edited in place. Prompts and their answers are transient,
  // so nothing accumulates: no orphaned Отмена buttons, no stack of dead menus.
  private async renderMenu(chatId: string, key: string, screen: { text: string; markup: unknown; parseMode?: string }, fresh = false) {
    const live = this.service.store.get<number | null>(`menu:${chatId}`, null);
    // Clearing a Telegram chat deletes it only on the reader's side, so the bot can still
    // edit a message nobody can see. An explicit request always gets a visible new message,
    // and the previous menu is left alone: it is still a real answer to what was asked then.
    if (fresh && live) {
      this.service.store.set(`menu:${chatId}`, null);
    } else if (live) {
      try {
        await this.call('editMessageText', { chat_id: chatId, message_id: live, text: screen.text, reply_markup: screen.markup,
          ...(screen.parseMode ? { parse_mode: screen.parseMode } : {}) });
        return;
      } catch (e) {
        // An unchanged screen is already correct; anything else means the menu is gone.
        if (e instanceof TelegramError && /not modified/i.test(e.description)) return;
        // The pointer is dropped, but the message is not: a failed edit is not proof it
        // should be removed, and a spare menu is harmless where a missing one is not.
        this.service.store.set(`menu:${chatId}`, null);
      }
    }
    this.showMenu(chatId, key, screen);
    await this.deliver();
  }
  // A button press edits the message it sits on, so navigation replaces the menu in place
  // instead of pushing a new one into the chat for every tap.
  async onCallback(query: NonNullable<TelegramUpdate['callback_query']>) {
    const message = query.message;
    const direct = Telegram.direct(message?.chat, query.from);
    void this.call('answerCallbackQuery', { callback_query_id: query.id,
      ...(direct ? {} : { text: 'Настройка — в личном чате со мной.', show_alert: true }) }).catch(() => {});
    if (!message || !direct) return;
    const chatId = String(message.chat.id);
    this.service.store.set(`menu:${chatId}`, message.message_id);
    let screen;
    const stop = this.working(chatId);
    try { screen = await this.menu.route(query.data || 'home', chatId); }
    catch { screen = { text: 'Не удалось выполнить действие. Откройте меню заново: /start', markup: { inline_keyboard: [] } }; }
    finally { stop(); }
    await this.call('editMessageText', { chat_id: chatId, message_id: message.message_id, text: screen.text, reply_markup: screen.markup,
      ...(screen.parseMode ? { parse_mode: screen.parseMode } : {}) })
      .catch(() => this.showMenu(chatId, `menu:${query.id}`, screen));
  }
  async handle(update: TelegramUpdate) {
    const store = this.service.store;
    if (update.update_id < store.get('telegram:offset', 0)) return;
    if (update.callback_query) {
      if (this.allowed(update)) await this.onCallback(update.callback_query);
      store.set('telegram:offset', update.update_id + 1);
      return;
    }
    if (this.allowed(update) && update.message?.text) {
      const chatId = String(update.message.chat.id);
      const direct = Telegram.direct(update.message.chat, update.message.from);
      const text = update.message.text.slice(0, 4000);
      const pending = direct ? store.get<Pending | null>(`pending:${chatId}`, null) : null;
      // A prompt is waiting for this text, so it is an answer rather than a question.
      if (pending && !text.startsWith('/')) {
        let screen;
        const stop = this.working(chatId);
        try { screen = await this.menu.input(pending, text, chatId); }
        catch { store.set(`pending:${chatId}`, null); screen = this.menu.home(); }
        finally { stop(); }
        // The prompt becomes the result in place, so its Отмена button cannot go stale.
        // What the reader typed is theirs and stays where they put it.
        await this.renderMenu(chatId, `reply:${update.update_id}`, screen);
        store.set('telegram:offset', update.update_id + 1);
        return;
      }
      const entry = /^\/(start|menu|chats|kids)\b/.exec(text)?.[1];
      if (entry) {
        if (direct) {
          // A typed command stays in the chat: it is the reader's own record of what they asked.
          const route = entry === 'chats' ? 'groups' : entry === 'kids' ? 'kids' : 'home';
          const stopMenu = this.working(chatId);
          try { await this.renderMenu(chatId, `reply:${update.update_id}`, await this.menu.route(route, chatId), true); }
          finally { stopMenu(); }
          store.set('telegram:offset', update.update_id + 1);
          return;
        }
        store.transaction(() => {
          store.enqueue(`reply:${update.update_id}`, chatId, 'Я на связи. Здесь я присылаю сводки и срочные уведомления, и отвечаю на вопросы: /summary 24h, /ask вопрос, или просто напишите вопрос текстом.\nНастройка — в личном чате со мной.', false, true);
          store.set('telegram:offset', update.update_id + 1);
        });
        return;
      }
      let reply: string;
      const stop = this.working(chatId);
      try { reply = await this.command(text, chatId, direct); }
      catch (e) {
        // A command that rejected the reader's own input explains why; only an unexpected
        // failure gets the generic text, which would otherwise bury "период: 24h, 48h или 7d".
        // Only text written for the reader. Anything else — a model provider's failure above
        // all — can carry prompt content or credentials and must never be echoed into a chat.
        const explained = e instanceof ReplyError ? e.message : '';
        reply = explained || 'Не удалось выполнить запрос. Проверьте /status и настройки модели, затем повторите запрос. Для большой сводки попробуйте более короткий период.';
      }
      finally { stop(); }
      store.transaction(() => {
        store.enqueue(`reply:${update.update_id}`, chatId, reply, false, true, Date.now(),
          Telegram.html.has(text.trim().split(/\s+/)[0]!.split('@')[0]!.toLowerCase()) ? 'HTML' : undefined);
        store.set('telegram:offset', update.update_id + 1);
      });
      await this.deliver();
    } else store.set('telegram:offset', update.update_id + 1);
  }
  async poll() {
    if (!this.env.telegramToken) return;
    while (!this.stopping) {
      try {
        const updates = await this.call('getUpdates', { offset: this.service.store.get('telegram:offset', 0), timeout: 25, allowed_updates: ['message', 'callback_query'] }) as TelegramUpdate[];
        for (const update of updates) { if (this.stopping) break; await this.handle(update); }
        this.service.store.set('telegram:pollError', null);
      } catch (e) {
        if (this.stopping) break;
        this.service.store.set('telegram:pollError', e instanceof TelegramError ? e.message : 'Telegram connection failed');
        await delay(5000, undefined, { signal: this.controller.signal }).catch(() => {});
      }
    }
  }
  // Callers must be able to rely on this: a reply queued while a pass is already running
  // used to be dropped by the re-entrancy guard and wait for the next tick. A second call
  // now joins the running pass and makes it go round again, and resolves when it is done.
  async deliver(now = Date.now()): Promise<void> {
    if (!this.env.telegramToken || this.stopping) return;
    if (this.delivering) { this.queued = true; return this.delivering; }
    this.delivering = (async () => {
      try {
        do { this.queued = false; await this.pass(now); } while (this.queued && !this.stopping);
      } finally { this.delivering = undefined; }
    })();
    return this.delivering;
  }
  private async pass(now: number) {
      const db = this.service.store.db;
      const rows = db.prepare(`SELECT o.* FROM outbox o WHERE o.sent_at IS NULL AND o.next_at<=?
        AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.chat_id=o.chat_id AND p.sent_at IS NULL
          AND p.rowid<o.rowid AND p.next_at>? AND p.urgent>=o.urgent)
        ORDER BY o.urgent DESC,o.created_at,o.rowid LIMIT 20`).all(now, now);
      const blocked = new Set<string>();
      for (const row of rows) {
        const chatId = String(row.chat_id);
        if (blocked.has(chatId)) continue;
        if (!row.urgent && isQuiet(this.service.config, now)) { continue; }
        if (!this.env.telegramChats.includes(chatId) && !this.env.telegramUsers.includes(chatId)) {
          // Stop delivery to recipients removed from configuration, retain the record for inspection.
          db.prepare('UPDATE outbox SET next_at=?,last_error=? WHERE id=?').run(now + 3600000, 'Recipient not allowed', String(row.id)); continue;
        }
        try {
          // Telegram's per-chat rate limit is a property of the account, not of one pass:
          // pacing measured from the last send survives across separate deliver() calls.
          const since = Date.now() - this.lastSend;
          if (since < 1100) await delay(1100 - since);
          if (row.photo) await this.sendPhoto(chatId, String(row.photo), String(row.text), !!row.silent, this.service.store);
          else if (row.markup) {
            const result = await this.call('sendMessage', { chat_id: chatId, text: row.text, reply_markup: JSON.parse(String(row.markup)),
              link_preview_options: { is_disabled: true }, ...(row.parse_mode ? { parse_mode: String(row.parse_mode) } : {}) }) as { message_id?: number };
            this.service.store.set(`menu:${chatId}`, result?.message_id ?? null);
          }
          else await this.call('sendMessage', { chat_id: chatId, text: row.text, disable_notification: !!row.silent, link_preview_options: { is_disabled: true },
            ...(row.parse_mode ? { parse_mode: String(row.parse_mode) } : {}) });
          db.prepare('UPDATE outbox SET sent_at=?,last_error=NULL WHERE id=?').run(now, String(row.id));
          this.lastSend = Date.now();
        } catch (e) {
          const attempt = Number(row.attempts) + 1;
          const retry = Math.max(e instanceof TelegramError ? e.retryAfter * 1000 : 0, Math.min(3600000, 5000 * 2 ** Math.min(attempt, 10)));
          db.prepare('UPDATE outbox SET attempts=?,next_at=?,last_error=? WHERE id=?').run(attempt, now + retry, e instanceof TelegramError ? e.message : 'Telegram connection failed', String(row.id));
          blocked.add(chatId);
        }
      }
  }
}
