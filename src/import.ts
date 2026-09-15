import { DateTime } from 'luxon';
import { hash } from './db.js';
import type { IncomingMessage } from './types.js';

// WhatsApp iOS [D/M/Y, H:M:S] and Android D/M/Y, H:M - exports.
const header = /^\[?(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\]?\s*(?:-\s*)?(.*)$/i;
export function parseExport(text: string, chatId: string, timezone: string, monthFirst = false) {
  const messages: IncomingMessage[] = [];
  let current: IncomingMessage | undefined, systemLines = 0;
  const flush = () => {
    if (current) {
      current.externalId = `export:${hash(`${current.timestamp}\0${current.sender}\0${current.text}`)}`;
      messages.push(current); current = undefined;
    }
  };
  for (const original of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = original.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\u00a0\u202f]/g, ' ');
    const m = header.exec(line);
    if (!m) {
      if (current) current.text += `\n${line}`;
      else if (line.trim()) throw new Error('Unrecognized export line before first message. Expected iOS/Android numeric date format.');
      continue;
    }
    flush();
    const body = m[8]!, colon = body.indexOf(': ');
    if (colon < 1) { systemLines++; continue; }
    let hour = Number(m[4]);
    if (m[7]) hour = hour % 12 + (m[7].toUpperCase() === 'PM' ? 12 : 0);
    const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    const date = DateTime.fromObject({ year, month: Number(m[monthFirst ? 1 : 2]), day: Number(m[monthFirst ? 2 : 1]), hour, minute: Number(m[5]), second: Number(m[6] || 0) }, { zone: timezone });
    if (!date.isValid) throw new Error(`Invalid export date: ${m[0].slice(0, 24)}. Check date order and timezone.`);
    current = { chatId, externalId: '', sender: body.slice(0, colon), text: body.slice(colon + 2), timestamp: date.toMillis(), historical: true, kind: 'text' };
  }
  flush();
  if (!messages.length) throw new Error('No messages found in export');
  return { messages, systemLines };
}
