import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..'), runtime = path.resolve(root, process.env.RMT_BUSINESS_TEST_RUNTIME ?? '.runtime/business-ecs');
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
const fixture = JSON.parse(fs.readFileSync(path.join(runtime, 'verification.json')));
const conversationId = fixture.conversationId;
if (process.argv.includes('--offline')) {
  let offline = false;
  for (let i = 0; i < 40; i++) {
    const devices = await api('/api/devices');
    if (!devices.devices.find(d => d.id === 'mac')?.online) { offline = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(offline, 'worker_offline_detected');
  const response = await fetch(config.origin + `/api/conversations/${conversationId}/turns`, { method: 'POST', headers: { origin: config.origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'OFFLINE_SHOULD_NOT_EXECUTE', attachmentIds: [], clientIntentId: crypto.randomUUID() }) });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'device_offline');
  fs.writeFileSync(path.join(runtime, 'offline-verification.json'), JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), offlineWriteStatus: 409, conversationId }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, checks: ['cloud-heartbeat-expiry', 'offline-write-rejected'] }));
} else {
  const projects = await api('/api/devices/mac/projects'); assert(projects.projects.some(p => p.id === 'rmtagt-compat'));
  const snapshot = await job(`/api/conversations/${conversationId}/snapshots`, { pageSize: 100 });
  for (const marker of fixture.markers) assert(snapshot.messages.some(m => m.role === 'assistant' && m.text.includes(marker)), 'native_history_after_cloud_restart');
  fs.writeFileSync(path.join(runtime, 'recovery-verification.json'), JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), conversationId, messages: snapshot.messages.length }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, checks: ['project-metadata-retained', 'original-conversation-retained', 'fresh-native-snapshot-after-restart'] }));
}
