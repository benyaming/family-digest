import { Store } from '../src/db.js';
import { validateConfig } from '../src/config.js';
import { FamilyService } from '../src/service.js';
import type { Analysis, Model, Message } from '../src/types.js';

export const now = Date.parse('2026-09-07T12:00:00Z');
export const group = 'kids@g.us';
export const fixture = (id: string, extra = {}) => ({ chatId: group, externalId: id, sender: 'המורה', timestamp: now - 60000, text: 'מחר טיול, להביא מים וכובע', ...extra });
export function analysis(messages: Message[]): Analysis {
  return { overview: 'Завтра экскурсия.', findings: messages.length ? [{ title: 'Подготовиться к экскурсии', detail: 'Взять воду и головной убор.', priority: 'important', actionable: true, confidence: 0.95,
    eventKey: 'class-trip-2026-09-08', dueAt: '2026-09-08T07:00:00+03:00', sources: [messages.at(-1)!.id] }] : [], memories: [] };
}
export function setup(overrides: Partial<Model> = {}, config = {}) {
  const store = new Store(':memory:');
  const model: Model = { analyze: async messages => analysis(messages), searchTerms: async () => ['טיול'], extractFacts: async () => ({ facts: [] }), answer: async (_q, messages) => ({ answer: messages.length ? 'Завтра экскурсия.' : 'Недостаточно данных.', sources: messages.map(m => m.id) }), ...overrides };
  const service = new FamilyService(store, validateConfig({ groups: [{ id: group, name: 'Класс', children: ['Ребёнок'] }], ...config }), model, ['111', '222']);
  return { store, model, service };
}
