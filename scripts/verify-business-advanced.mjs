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
await job('/api/devices/mac/sync', { resource: 'projects' });
const created = await job('/api/devices/mac/conversations', { projectId: 'rmtagt-compat' });
const conversationId = created.conversation.id;
const image = await job(`/api/conversations/${conversationId}/attachments`, { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB5kAAAAASUVORK5CYII=' });
const turn = await job(`/api/conversations/${conversationId}/turns`, { text: 'Do not use tools or modify files. Inspect the attached image and reply exactly BUSINESS_IMAGE_OK.', attachmentIds: [image.attachmentId] });
async function finish(turnId) {
  for (let i = 0; i < 120; i++) { const { events } = await api('/api/devices/mac/activity'); const done = events.find(e => e.turnId === turnId && e.type === 'turn.finished'); if (done) return done; await new Promise(r => setTimeout(r, 1000)); } throw new Error('turn_event_timeout');
}
assert.equal((await finish(turn.turnId)).status, 'completed');
const snapshot = await job(`/api/conversations/${conversationId}/snapshots`, { pageSize: 100 });
assert(snapshot.messages.some(m => m.role === 'assistant' && m.text.includes('BUSINESS_IMAGE_OK')));
const longTurn = await job(`/api/conversations/${conversationId}/turns`, { text: 'Do not use tools or modify files. Write 2000 distinct numbered lines of plain text, beginning now.', attachmentIds: [] });
const cancellation = await job(`/api/conversations/${conversationId}/interrupt`, { turnId: longTurn.turnId });
assert.equal(cancellation.status, 'interrupt_requested');
assert.equal((await finish(longTurn.turnId)).status, 'interrupted');
fs.writeFileSync(path.join(runtime, 'advanced-verification.json'), JSON.stringify({ ok: true, conversationId, image: 'real_codex_completed', interruption: 'real_codex_interrupted', checkedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ok: true, checks: ['image-staging', 'real-image-turn', 'bound-turn-interrupt'] }));
