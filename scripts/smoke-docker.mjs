// Disposable container test. No WhatsApp, Telegram, or model credentials are used.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const name = `family-brief-smoke-${randomUUID().slice(0, 8)}`;
const directory = mkdtempSync(join(tmpdir(), 'family-brief-'));
const token = randomBytes(32).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let base;
async function api(path, body, method) {
  const response = await fetch(`${base}${path}`, { method: method || (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
  return response.json();
}
async function ready() {
  for (let n = 0; n < 30; n++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
    await delay(500);
  }
  throw new Error('Container did not become ready');
}
try {
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ groups: [{ id: 'test@g.us', name: 'Тестовый класс' }] }), { mode: 0o644 });
  writeFileSync(join(directory, '.env'), `API_TOKEN=${token}\nWHATSAPP_ENABLED=false\n`, { mode: 0o600 });
  docker('volume', 'create', name);
  docker('run', '-d', '--name', name, '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp',
    '--env-file', join(directory, '.env'), '-v', `${name}:/app/data`, '-v', `${directory}/config.json:/app/config.json:ro`, '-p', '127.0.0.1::8080', process.env.SMOKE_IMAGE || 'family-brief:local');
  base = `http://${docker('port', name, '8080/tcp')}`;
  await ready();
  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.equal((await api('/status')).whatsapp, 'disabled');
  const imported = await api('/import', [{ chatId: 'test@g.us', externalId: 'smoke', sender: 'מורה', timestamp: Date.now() - 10000, text: 'מחר טיול' }]);
  assert.equal(imported.inserted, 1);
  assert.equal((await api('/search?q=' + encodeURIComponent('טיול'))).length, 1);
  await api('/memory', { key: 'class', value: '2А' }, 'PUT');
  docker('restart', name);
  base = `http://${docker('port', name, '8080/tcp')}`;
  await ready();
  assert.equal((await api('/status')).messages, 1);
  assert.equal((await api('/memory'))[0].value, '2А');
  const uid = docker('exec', name, 'id', '-u'); assert.notEqual(uid, '0');
  docker('exec', name, 'node', 'dist/cli.js', 'status');
  console.log('Docker smoke passed: non-root/read-only runtime, auth, Hebrew import/search, CLI, restart persistence.');
} catch (error) {
  try { console.error(docker('logs', name)); } catch {}
  throw error;
} finally {
  try { docker('rm', '-f', name); } catch {}
  try { docker('volume', 'rm', name); } catch {}
  rmSync(directory, { recursive: true, force: true });
}
