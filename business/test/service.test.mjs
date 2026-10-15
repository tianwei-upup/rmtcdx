import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBusinessServer } from '../src/server.mjs';

test('HTTP business API accepts jobs and a device publishes domain results without request forwarding', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt-business-'));
  const origin = 'http://127.0.0.1:3230';
  const password = 'test-password-more-than-24-characters';
  const service = await createBusinessServer({ origin, password, stateFile: path.join(directory, 'state.json'), claimWaitMs: 10 });
  const address = await service.listen(0); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let cookie = '', token = '';
  const request = (route, body, agent = false) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(agent ? { authorization: `Bearer ${token}`, 'x-device-id': 'mac' } : { origin, cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await request('/api/devices')).status, 401);
  const login = await request('/api/login', { username: 'admin', password });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
  const pair = await (await request('/api/pairing', { deviceId: 'mac', name: 'Mac' })).json();
  token = (await (await request('/api/agent/pair', { deviceId: 'mac', code: pair.code }, true)).json()).token;
  assert.equal((await request('/api/agent/heartbeat', { active: [], ready: true }, true)).status, 200);
  const accepted = await request('/api/devices/mac/sync', { resource: 'projects', clientIntentId: crypto.randomUUID() });
  assert.equal(accepted.status, 202);
  const job = await accepted.json();
  const task = (await (await request('/api/agent/tasks/claim', { accepts: ['projects.sync'] }, true)).json()).task;
  assert.equal(task.id, job.id); assert.equal(task.operation, 'projects.sync');
  assert.equal('path' in task, false); assert.equal('method' in task, false);
  await request(`/api/agent/tasks/${task.id}/ack`, { leaseToken: task.leaseToken }, true);
  const result = await request(`/api/agent/tasks/${task.id}/result`, { leaseToken: task.leaseToken, state: 'succeeded', result: { projects: [{ id: 'fixture', name: 'Fixture' }] } }, true);
  assert.equal(result.status, 200);
  assert.equal((await (await request(`/api/jobs/${job.id}`)).json()).state, 'succeeded');
  assert.equal((await (await request('/api/devices/mac/projects')).json()).projects[0].id, 'fixture');
  async function finish(operation, accepted, result) {
    const queued = await accepted.json(); assert.equal(accepted.status, 202);
    const lease = (await (await request('/api/agent/tasks/claim', { accepts: [operation] }, true)).json()).task;
    assert.equal(lease.id, queued.id);
    await request(`/api/agent/tasks/${lease.id}/ack`, { leaseToken: lease.leaseToken }, true);
    assert.equal((await request(`/api/agent/tasks/${lease.id}/result`, { leaseToken: lease.leaseToken, state: 'succeeded', result }, true)).status, 200);
    return lease;
  }
  const directoryValue = { projects: [{ id: 'fixture', name: 'Fixture' }, { id: 'second', name: 'Second' }], directories: [{ projectId: 'fixture', conversations: [], nextCursor: null }, { projectId: 'second', conversations: [{ id: 'directory-thread', projectId: 'second', title: 'PRIVATE-DIRECTORY-TITLE', status: 'idle' }], nextCursor: null }] };
  await finish('directory.sync', await request('/api/devices/mac/sync', { resource: 'directory', clientIntentId: crypto.randomUUID() }), directoryValue);
  assert.equal((await (await request('/api/devices/mac/conversations?projectId=second')).json()).conversations[0].id, 'directory-thread');
  assert(!fs.readFileSync(path.join(directory, 'state.json'), 'utf8').includes('PRIVATE-DIRECTORY-TITLE'));
  await finish('conversation.create', await request('/api/devices/mac/conversations', { projectId: 'fixture', clientIntentId: crypto.randomUUID() }),
    { conversation: { id: 'thread-1', projectId: 'fixture', title: 'New conversation', status: 'idle' } });
  const text = 'PRIVATE-BUSINESS-PROMPT';
  const turn = await finish('turn.start', await request('/api/conversations/thread-1/turns', { text, attachmentIds: [], clientIntentId: crypto.randomUUID() }),
    { conversationId: 'thread-1', turnId: 'turn-1', status: 'running' });
  assert.equal((await request('/api/agent/events', { eventId: crypto.randomUUID(), jobId: turn.id, type: 'assistant.delta', conversationId: 'thread-1', turnId: 'turn-1', text: 'PRIVATE-REPLY' }, true)).status, 200);
  assert.equal((await (await request('/api/devices/mac/activity?after=0')).json()).events.at(-1).text, 'PRIVATE-REPLY');
  const snapshot = { conversation: { id: 'thread-1', projectId: 'fixture', title: 'Test', status: 'idle' }, messages: [{ id: 'message-1', role: 'assistant', text: 'PRIVATE-REPLY', attachmentIds: [] }], approvals: [], nextCursor: null, assets: [] };
  await finish('conversation.snapshot', await request('/api/conversations/thread-1/snapshots', { clientIntentId: crypto.randomUUID(), pageSize: 20 }), snapshot);
  assert.equal((await (await request('/api/conversations/thread-1/messages')).json()).messages[0].text, 'PRIVATE-REPLY');
  assert.equal((await request('/api/conversations/not-owned/turns', { text: 'x', attachmentIds: [], clientIntentId: crypto.randomUUID() })).status, 404);
  assert(!fs.readFileSync(path.join(directory, 'state.json'), 'utf8').includes(text));
  assert(!fs.readFileSync(path.join(directory, 'state.json'), 'utf8').includes('PRIVATE-REPLY'));
  assert.equal((await request('/agent/connect')).status, 404);
  assert.equal((await request('/devices/mac/api/sessions')).status, 404);
  assert(!fs.readFileSync(path.join(directory, 'state.json'), 'utf8').includes(token));
});
