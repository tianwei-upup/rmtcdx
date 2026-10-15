import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..'), runtime = path.resolve(root, process.env.RMT_BUSINESS_TEST_RUNTIME ?? '.runtime/business');
const config = JSON.parse(fs.readFileSync(path.join(runtime, 'local.json')));
let cookie;
async function api(route, data) {
  const response = await fetch(config.origin + route, { method: data ? 'POST' : 'GET', headers: { origin: config.origin, cookie: cookie ?? '', 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  if (route === '/api/login') cookie = response.headers.get('set-cookie')?.split(';')[0];
  const result = await response.json(); assert(response.ok, JSON.stringify({ route, status: response.status, code: result.code })); return result;
}
async function job(route, data) {
  const accepted = await api(route, { ...data, clientIntentId: crypto.randomUUID() });
  for (let i = 0; i < 100; i++) { const current = await api('/api/jobs/' + accepted.id); if (current.state === 'succeeded') return current.result; assert(!['unknown', 'expired', 'rejected'].includes(current.state), `${current.operation}:${current.state}:${current.code}`); await new Promise(r => setTimeout(r, 300)); }
  throw new Error('job_timeout');
}
await api('/api/login', { username: 'admin', password: config.password });
const projects = await job('/api/devices/mac/sync', { resource: 'projects' }); assert(projects.projects.some(p => p.id === 'rmtagt-compat'));
const created = await job('/api/devices/mac/conversations', { projectId: 'rmtagt-compat' });
const conversationId = created.conversation.id;
const markers = [];
for (const phase of ['NEW', 'RESUME']) {
  const marker = `BUSINESS_${phase}_${crypto.randomBytes(5).toString('hex')}`; markers.push(marker);
  const turn = await job(`/api/conversations/${conversationId}/turns`, { text: `Do not use tools or modify files. Reply exactly ${marker}.`, attachmentIds: [] });
  let done = false;
  for (let i = 0; i < 120; i++) {
    const activity = await api('/api/devices/mac/activity');
    done = activity.events.some(e => e.turnId === turn.turnId && e.type === 'turn.finished');
    if (done) break; await new Promise(r => setTimeout(r, 1000));
  }
  assert(done, 'turn_finished_event');
  const snapshot = await job(`/api/conversations/${conversationId}/snapshots`, { pageSize: 100 });
  assert(snapshot.messages.some(m => m.role === 'assistant' && m.text.includes(marker)), 'real_response_marker');
}
const history = await job('/api/devices/mac/sync', { resource: 'sessions', projectId: 'rmtagt-compat', pageSize: 1 });
assert(history.conversations.length <= 1);
const checks = ['projects', 'create', 'send', 'resume', 'domain-events', 'snapshot', 'pagination'];
if (fs.existsSync(path.join(runtime, 'server.json'))) { checks.push('metadata-no-chat'); const metadata = fs.readFileSync(path.join(runtime, 'server.json'), 'utf8'); for (const marker of markers) assert(!metadata.includes(marker), 'no_chat_body_on_server_disk'); }
fs.writeFileSync(path.join(runtime, 'verification.json'), JSON.stringify({ ok: true, mode: 'real', origin: config.origin, conversationId, markers, checkedAt: new Date().toISOString(), checks }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ok: true, conversationId, checks: checks.length }));
