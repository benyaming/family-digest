import { copyFileSync, existsSync, readFileSync, writeFileSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { apiRequest } from './client.js';
import { parseExport } from './import.js';
import { loadConfig } from './config.js';
import { incomingSchema } from './api.js';

const [command = 'help', ...args] = process.argv.slice(2);
async function main() {
  if (command === 'init') {
    if (!existsSync('.env')) writeFileSync('.env', readFileSync('.env.example', 'utf8').replace('GENERATE_WITH_CLI_INIT', randomBytes(32).toString('hex')), { mode: 0o600, flag: 'wx' });
    if (!existsSync('config.json')) copyFileSync('config.example.json', 'config.json', constants.COPYFILE_EXCL);
    console.log('Created .env and config.json (existing files preserved). Add model and Telegram credentials before enabling integrations.'); return;
  }
  if (command === 'pair') {
    const result = await apiRequest('/whatsapp/pairing');
    if (!result.qr) { console.log(`WhatsApp: ${result.status}. If connecting, retry shortly. Enable WHATSAPP_ENABLED=true to pair.`); return; }
    console.log(await QRCode.toString(result.qr, { type: 'terminal', small: true }));
    console.log('WhatsApp → Linked devices → Link a device. This QR expires shortly.'); return;
  }
  if (command === 'telegram-ids') {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in .env first. Stop the service before running this command.');
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeout: 0, allowed_updates: ['message'] }), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json() as { ok: boolean; result?: { message?: { from?: { id: number; first_name?: string }; chat: { id: number; title?: string; type: string } } }[] };
    if (!data.ok) throw new Error('Could not read Telegram updates. Check token and stop any other bot poller.');
    const ids = data.result?.filter(u => u.message?.from).map(u => ({ userId: u.message!.from!.id, name: u.message!.from!.first_name, chatId: u.message!.chat.id, chatType: u.message!.chat.type, title: u.message!.chat.title }));
    console.log(JSON.stringify(ids, null, 2));
    console.log('Use only your own and your spouse’s IDs. If empty, each parent should send /start to the bot and run this again.'); return;
  }
  if (command === 'import') {
    const [file, chatId] = args;
    if (!file || !chatId) throw new Error('Usage: import path/to/chat.txt GROUP_ID [--month-first]');
    const raw = readFileSync(file, 'utf8');
    const parsed = file.endsWith('.json') ? { messages: incomingSchema.array().parse(JSON.parse(raw)), systemLines: 0 }
      : parseExport(raw, chatId, loadConfig().timezone, args.includes('--month-first'));
    let inserted = 0, ignored = 0;
    for (let i = 0; i < parsed.messages.length; i += 100) {
      const batch = incomingSchema.array().parse(parsed.messages.slice(i, i + 100));
      const result = await apiRequest('/import', batch);
      inserted += result.inserted; ignored += result.ignored;
    }
    console.log(JSON.stringify({ inserted, ignored, systemLines: parsed.systemLines })); return;
  }
  let result: any;
  switch (command) {
    case 'status': result = await apiRequest('/status'); break;
    case 'groups': result = await apiRequest('/groups'); break;
    case 'summary': result = await apiRequest('/summary', { period: args[0] || '24h', group: args.slice(1).join(' ') || undefined }); break;
    case 'ask': result = await apiRequest('/ask', { question: args.join(' ') }); break;
    case 'search': result = await apiRequest(`/search?q=${encodeURIComponent(args.join(' '))}`); break;
    case 'memory': result = await apiRequest('/memory'); break;
    default: console.log('Family Brief\ninit | pair | telegram-ids | status | groups | summary [24h] [group] | ask QUESTION | search WORDS | memory | import FILE GROUP_ID [--month-first]'); return;
  }
  console.log(result.text || JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
