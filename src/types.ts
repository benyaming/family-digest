import { z } from 'zod';

/** An error whose message was written for the reader: it is safe, and useful, to show. */
export class ReplyError extends Error {}

export interface Message {
  id: string; chat_id: string; external_id: string; sender: string;
  timestamp: number; text: string; kind: string; historical: number; analyzed: number; alerted?: number; revision: number;
}
export interface IncomingMessage {
  chatId: string; externalId: string; sender: string; timestamp: number;
  text: string; kind?: string; historical?: boolean;
}
const sources = z.array(z.string().min(1)).min(1).max(30);
export const findingSchema = z.object({
  title: z.string().min(1).max(250), detail: z.string().min(1).max(1600),
  priority: z.enum(['routine', 'important', 'urgent']),
  actionable: z.boolean(), confidence: z.number().min(0).max(1),
  eventKey: z.string().max(200),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  sources,
});
export const analysisSchema = z.object({
  overview: z.string().max(1600),
  findings: z.array(findingSchema).max(40),
  memories: z.array(z.object({ key: z.string().min(1).max(120), value: z.string().max(1200), sources })).max(15),
});
export type Analysis = z.infer<typeof analysisSchema>;
export type Finding = z.infer<typeof findingSchema>;
export const factsSchema = z.object({ facts: z.array(z.object({ key: z.string().min(1).max(120), value: z.string().min(1).max(600) })).max(12) });
export type Facts = z.infer<typeof factsSchema>;
export const answerSchema = z.object({ answer: z.string().max(12000), sources: z.array(z.string()).max(30) });
export type Answer = z.infer<typeof answerSchema>;
export interface Memory { key: string; value: string; confirmed: number; sources: string; updated_at: number }
export interface Model {
  analyze(messages: Message[], context: unknown): Promise<Analysis>;
  answer(question: string, messages: Message[], context: unknown): Promise<Answer>;
  searchTerms(question: string): Promise<string[]>;
  extractFacts(comment: string, context: unknown): Promise<Facts>;
}
