import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const runtime = '.runtime/desktop-companion-acceptance';
const config = JSON.parse(fs.readFileSync('.runtime/business-ecs/local.json', 'utf8'));
const fixture = JSON.parse(fs.readFileSync(runtime + '/test-session.json', 'utf8'));
const deviceId = 'mac-companion', projectId = 'rmtcdx-companion-test', threadId = fixture.threadId;
let cookie;
async function api(route, data) {
  const response = await fetch(config.origin + route, { method: data ? 'POST' : 'GET', headers: { origin: config.origin, cookie: cookie ?? '', 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(15000) });
  if (route === '/api/login') cookie = response.headers.get('set-cookie')?.split(';')[0];
  const value = await response.json();
  assert(response.ok, JSON.stringify({ route, status: response.status, code: value.code })); return value;
}
async function job(route, data, intentId = crypto.randomUUID()) {
  const accepted = await api(route, { ...data, clientIntentId: intentId });
  for (let i = 0; i < 240; i++) {
    const current = await api('/api/jobs/' + accepted.id);
    if (current.state === 'succeeded') return current.result;
    assert(!['unknown', 'expired', 'rejected'].includes(current.state), JSON.stringify({ state: current.state, code: current.code, operation: current.operation }));
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('job_timeout');
}
await api('/api/login', { username: 'admin', password: config.password });
const projects = await job(`/api/devices/${deviceId}/sync`, { resource: 'projects' });
assert.equal(projects.projects.length, 1); assert.equal(projects.projects[0].id, projectId);
const sessions = await job(`/api/devices/${deviceId}/sync`, { resource: 'sessions', projectId });
assert.equal(sessions.conversations.length, 1); assert.equal(sessions.conversations[0].id, threadId);
const before = await job(`/api/conversations/${threadId}/snapshots`, { pageSize: 100 });
assert(before.messages.some(message => message.text.includes('ROUND2 LANTERN-4826')));
const intentFile = runtime + '/ecs-verification-intent.json';
if (!fs.existsSync(intentFile)) fs.writeFileSync(intentFile, JSON.stringify({ intentId: crypto.randomUUID() }), { mode: 0o600 });
const { intentId } = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
const turn = await job(`/api/conversations/${threadId}/turns`, { text: '现在从 ECS 业务任务接入这个原会话。不要使用工具或读写文件，请回忆最初的会话标记，只回复：ECS <最初的标记>。', attachmentIds: [] }, intentId);
let finished = false;
for (let i = 0; i < 120; i++) {
  const activity = await api(`/api/devices/${deviceId}/activity`);
  if (activity.events.some(event => event.turnId === turn.turnId && event.type === 'turn.finished' && event.status === 'completed')) { finished = true; break; }
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert(finished, 'completed business event');
const after = await job(`/api/conversations/${threadId}/snapshots`, { pageSize: 100 });
assert(after.messages.some(message => message.role === 'assistant' && message.text === 'ECS LANTERN-4826'));
fs.writeFileSync(runtime + '/ecs-verification.json', JSON.stringify({ passed: true, deviceId, conversationId: threadId, turnId: turn.turnId, originalHistoryVisible: true, contextPreserved: true, businessEvents: true, checkedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
fs.writeFileSync(runtime + '/phone-config.json', JSON.stringify({ origin: config.origin, password: config.password, deviceId, projectId, conversationId: threadId }), { mode: 0o600 });
console.log(JSON.stringify({ passed: true, conversationId: threadId, turnId: turn.turnId, assistant: 'ECS LANTERN-4826' }));
