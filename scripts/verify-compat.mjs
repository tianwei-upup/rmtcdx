import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { WebSocket } = createRequire(new URL('../control/package.json', import.meta.url))('ws');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.RMT_TEST_BASE ?? 'http://127.0.0.1:3210';
const origin = new URL(base).origin;
const proxied = new URL(base).pathname.startsWith('/devices/');
let cookie = '';
if (proxied) {
  const credentials = JSON.parse(fs.readFileSync(path.join(root, '.runtime/control-admin.json'), 'utf8'));
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
}
async function api(route, body, method = body === undefined ? 'GET' : 'POST', requestId = crypto.randomUUID()) {
  const response = await fetch(base + route, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'x-request-id': requestId }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${value.message ?? ''}`);
  return value;
}
const health = await api('/healthz');
assert.equal(health.codex.mode, 'real');
assert.equal(health.codex.ready, true);
const before = await api('/api/sessions');
assert.ok(before.sessions.length > 0, 'Native history must exist');
let historyRead = 0;
for (const session of before.sessions.slice(0, 5)) {
  const value = await api(`/api/sessions/${session.id}/messages`);
  assert.ok(Array.isArray(value.messages));
  historyRead++;
}
const events = [];
const socket = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { Origin: origin, Cookie: cookie } });
const hello = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Real WebSocket hello timeout')), 15000);
  socket.on('message', data => {
    const value = JSON.parse(data.toString());
    events.push(value);
    if (value.type === 'hello') { clearTimeout(timer); resolve(value); }
  });
  socket.once('error', reject);
});
try {
  assert.equal((await hello).mode, 'real');
  if (!process.argv.includes('--run')) {
    console.log(JSON.stringify({ result: 'PASS', real: true, historyCount: before.sessions.length, historyRead, websocket: true }));
  } else {
    const fixture = path.join(root, '.runtime/compat-workspace/README.md');
    const fileBefore = fs.readFileSync(fixture, 'utf8');
    const { session } = await api('/api/sessions', { repoId: 'rmtagt-compat' });
    assert.ok(session.id);
    for (const marker of ['RMTAGT_WINDOWS_NEW_OK', 'RMTAGT_WINDOWS_RESUME_OK']) {
      const { run } = await api('/api/runs', { sessionId: session.id, prompt: `只回复 ${marker}。不要使用工具，不要读取或修改文件，不要执行命令。`, codex: { sandbox: 'read-only', approvalPolicy: 'on-request' } });
      assert.equal(run.sessionId, session.id);
      const until = Date.now() + 120000;
      let latest;
      do {
        await new Promise(resolve => setTimeout(resolve, 500));
        latest = (await api(`/api/runs/${run.id}`)).run;
      } while (['running', 'queued'].includes(latest.status) && Date.now() < until);
      assert.equal(latest.status, 'completed', `Run ended as ${latest.status}`);
    }
    const title = `rmtagt ${process.platform === 'darwin' ? 'Mac' : 'Windows'} compatibility`;
    const renamed = await api(`/api/sessions/${session.id}`, { title }, 'PATCH');
    assert.equal(renamed.session.title, title, 'Rename must be visible in subsequent reads');
    assert.equal((await api(`/api/sessions/${session.id}`)).session.repoId, 'rmtagt-compat', 'Fixture must remain in its own workspace');
    const messages = (await api(`/api/sessions/${session.id}/messages`)).messages;
    for (const marker of ['RMTAGT_WINDOWS_NEW_OK', 'RMTAGT_WINDOWS_RESUME_OK']) assert.ok(messages.some(m => m.role === 'assistant' && m.text.includes(marker)));
    assert.equal((await api(`/api/sessions/${session.id}/select`, {})).session.id, session.id);
    assert.ok(Array.isArray((await api(`/api/sessions/${session.id}/codex/requests`)).requests));
    assert.ok(events.some(e => e.type === 'message.delta' && e.sessionId === session.id));
    assert.ok(events.some(e => e.type === 'run.completed' && e.run.sessionId === session.id));
    assert.equal(fs.readFileSync(fixture, 'utf8'), fileBefore);
    const result = { result: 'PASS', real: true, viaCloud: proxied, historyCount: before.sessions.length, historyRead, sessionId: session.id, fixtureTitle: title, completedTurns: 2, streamingEvents: events.filter(e => e.type === 'message.delta' && e.sessionId === session.id).length, fixtureUnchanged: true };
    fs.writeFileSync(path.join(root, `.runtime/${proxied ? 'cloud' : 'windows'}-compat-result.json`), JSON.stringify(result, null, 2));
    if (proxied) {
      const credentials = JSON.parse(fs.readFileSync(path.join(root, '.runtime/control-admin.json'), 'utf8'));
      fs.writeFileSync(path.join(root, '.runtime/android-cloud-test.json'), JSON.stringify({ cloudUrl: origin, ...credentials, fixtureTitle: title }), { mode: 0o600 });
    }
    console.log(JSON.stringify(result));
  }
} finally { socket.close(); }
