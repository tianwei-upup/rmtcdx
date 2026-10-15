import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBusinessServer } from '../src/server.mjs';
import { startAgent } from '../src/agent.mjs';

test('worker executes one durable business intent; restart expires RAM input and keeps terminal metadata', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-worker-'));
  const origin = 'http://127.0.0.1:3230', password = 'test-only-password-at-least-24-characters', stateFile = path.join(dir, 'server.json');
  let server = await createBusinessServer({ origin, password, stateFile, claimWaitMs: 10 });
  let port = (await server.listen(0)).port, cookie, calls = 0, online = false, eventSink;
  async function api(route, data) {
    const response = await fetch(`http://127.0.0.1:${port}` + route, { method: data ? 'POST' : 'GET', headers: { origin, cookie: cookie ?? '', 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    if (route === '/api/login') cookie = response.headers.get('set-cookie')?.split(';')[0];
    return { status: response.status, value: await response.json() };
  }
  await api('/api/login', { username: 'admin', password });
  const pair = (await api('/api/pairing', { deviceId: 'mac', name: 'Mac' })).value;
  const adapter = { operations: ['projects.sync'], setEventSink(value) { eventSink = value; }, async start() { online = true; }, async stop() { online = false; }, ready: () => online,
    async execute(operation) { calls++; assert.equal(operation, 'projects.sync'); return { projects: [{ id: 'fixture', name: 'Fixture' }] }; } };
  const agent = await startAgent({ origin: `http://127.0.0.1:${port}`, deviceId: 'mac', pairCode: pair.code, stateFile: path.join(dir, 'agent.json'), projects: [], adapter, log() {} });
  assert.equal(typeof eventSink, 'function');
  t.after(async () => { await agent.stop(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const intent = crypto.randomUUID(), payload = { resource: 'projects', clientIntentId: intent };
  const accepted = await api('/api/devices/mac/sync', payload); assert.equal(accepted.status, 202);
  let done;
  for (let i = 0; i < 100; i++) { done = (await api('/api/jobs/' + accepted.value.id)).value; if (done.state === 'succeeded') break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(done.state, 'succeeded');
  assert.equal((await api('/api/devices/mac/sync', payload)).value.id, accepted.value.id);
  assert.equal(calls, 1);
  // A pending request has no durable private payload and cannot execute after restart.
  const pending = await api('/api/devices/mac/conversations', { projectId: 'fixture', clientIntentId: crypto.randomUUID() });
  assert.equal(pending.status, 202);
  await server.close();
  server = await createBusinessServer({ origin, password, stateFile, claimWaitMs: 10 }); port = (await server.listen(0)).port;
  await api('/api/login', { username: 'admin', password });
  const state = (await api('/api/jobs/' + pending.value.id)).value;
  assert(['expired', 'unknown'].includes(state.state));
  assert.equal((await api('/api/jobs/' + accepted.value.id)).value.resultAvailable, false);
  const retriedOffline = await api('/api/devices/mac/sync', payload);
  assert.equal(retriedOffline.status, 202); assert.equal(retriedOffline.value.id, accepted.value.id);
  assert.equal(calls, 1);
  assert.equal((await api('/api/devices/mac/conversations', { projectId: 'fixture', clientIntentId: crypto.randomUUID() })).value.code, 'device_offline');
});
