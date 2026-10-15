import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createCloud } from '../src/cloud.mjs';
import { createClient, pairDevice } from '../src/client.mjs';
import { MAX_BODY, MAX_RESPONSE, allowedApi, trustedUrl } from '../src/common.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(20); }
  throw new Error('Condition timed out');
}
async function fakeBridge(name) {
  let mutations = 0;
  let failing = false;
  let historyBody;
  let readDelay = 0;
  let activeReads = 0;
  let maxReads = 0;
  let readCalls = 0;
  let completedReads = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'GET') {
      readCalls++; activeReads++; maxReads = Math.max(maxReads, activeReads);
      await sleep(readDelay);
      activeReads--; completedReads++;
    }
    if (req.method !== 'GET') { mutations++; await sleep(40); }
    res.writeHead(failing ? 500 : 200, { 'content-type': 'application/json' });
    if (req.method === 'GET' && req.url.includes('/messages') && historyBody !== undefined) return res.end(historyBody);
    res.end(JSON.stringify({ name, path: req.url, mutations, body }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => { ws.on('error', () => {}); ws.send(JSON.stringify({ type: 'hello', mode: 'real' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    get mutations() { return mutations; },
    set failing(value) { failing = value; },
    set historyBody(value) { historyBody = value; },
    set readDelay(value) { readDelay = value; },
    resetReads() { assert.equal(activeReads, 0); readCalls = 0; maxReads = 0; completedReads = 0; },
    get readCalls() { return readCalls; },
    get maxReads() { return maxReads; },
    get completedReads() { return completedReads; },
    emit(value) { for (const ws of wss.clients) ws.send(JSON.stringify(value)); },
    async close() { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); }
  };
}
function connect(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.on('error', reject);
    ws.once('open', () => { ws.removeListener('error', reject); ws.on('error', () => {}); resolve(ws); });
  });
}
async function rejectedWs(url, options, expected) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.on('error', () => {});
    ws.on('open', () => { ws.close(); reject(new Error('Unauthorized WebSocket opened')); });
    ws.on('unexpected-response', (_req, res) => { assert.equal(res.statusCode, expected); res.resume(); resolve(); });
  });
}

test('URL and bridge allowlist reject arbitrary destinations and developer interfaces', () => {
  assert.throws(() => trustedUrl('http://example.com'));
  assert.throws(() => trustedUrl('https://user:password@example.com'));
  assert.throws(() => trustedUrl('https://example.com/path'));
  assert.equal(trustedUrl('http://127.0.0.1:3220').origin, 'http://127.0.0.1:3220');
  assert(allowedApi('POST', '/api/runs'));
  assert(allowedApi('GET', '/api/sessions?repoId=all'));
  for (const p of ['http://evil/api/sessions', '//evil/api/sessions', '/api/dev/sessions/abc/codex/requests', '/api/sessions/%2e%2e/repos', '/api/sessions/abc%2fdef', '/api/notifications/subscriptions']) assert(!allowedApi('POST', p), p);
});

test('two-device relay protocol, authentication and durable mutation receipts (fake bridges only)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmtagt-relay-test-'));
  const origin = 'http://127.0.0.1:39999';
  const password = 'test-only-password-at-least-24-chars';
  const stateFile = path.join(dir, 'cloud.json');
  const cloud = await createCloud({ publicUrl: origin, password, stateFile, heartbeatMs: 200, timeoutMs: 2000, pairingTtlMs: 250 });
  const address = await cloud.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const socketBase = base.replace('http:', 'ws:');
  const win = await fakeBridge('windows');
  const mac = await fakeBridge('mac');
  const clients = [];
  const sockets = [];
  const agentSockets = new Map();
  cloud.server.on('upgrade', (req, socket) => { if (req.headers['x-device-id']) agentSockets.set(req.headers['x-device-id'], socket); });
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    for (const c of clients) await c.close();
    await cloud.close(); await win.close(); await mac.close();
    // Only removes the exact temporary directory created by this test.
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let cookie;
  async function request(route, method = 'GET', body, headers = {}) {
    return fetch(base + route, { method, headers: { origin, ...(cookie ? { cookie } : {}), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const tokens = {};
  await t.test('login requires origin and credentials, cookie is HttpOnly, no unauthenticated API/WS', async () => {
    assert.equal((await fetch(base + '/api/devices')).status, 401);
    assert.equal((await fetch(base + '/api/login', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await request('/api/login', 'POST', { username: 'admin', password: 'wrong' })).status, 401);
    const response = await request('/api/login', 'POST', { username: 'admin', password });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    cookie = response.headers.get('set-cookie').split(';')[0];
    await rejectedWs(socketBase + '/agent/connect', {}, 401);
    await rejectedWs(socketBase + '/devices/windows/ws', { origin }, 403);
    for (const deviceId of ['toString', 'constructor', '__proto__', 'prototype']) {
      await rejectedWs(socketBase + '/agent/connect', { headers: { 'x-device-id': deviceId, authorization: 'Bearer untrusted' } }, 401);
      assert.equal((await fetch(base + '/healthz')).status, 200);
    }
  });
  await t.test('unauthenticated device HTML redirects to login with safe local return path; APIs keep 401', async () => {
    const redirect = await fetch(base + '/devices/windows/sessions/example?view=history', { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/?next=%2Fdevices%2Fwindows%2Fsessions%2Fexample%3Fview%3Dhistory');
    assert.equal((await fetch(base + '/devices/windows/api/sessions')).status, 401);
    const html = await (await fetch(base + '/?next=%2Fdevices%2Fwindows%2Fsessions%2Fexample')).text();
    assert(html.includes('const next="/devices/windows/sessions/example"'));
    for (const next of ['https://evil.example/', '//evil.example/', '/devices/windows/../../evil', '/devices/windows/\\evil']) {
      const rejected = await (await fetch(base + '/?next=' + encodeURIComponent(next))).text();
      assert(rejected.includes('const next="";'), next);
    }
  });
  await t.test('pairing codes expire', async () => {
    const response = await request('/api/pairing', 'POST', { deviceId: 'expired', name: 'expired' });
    const { code } = await response.json();
    await sleep(300);
    const expired = await fetch(base + '/api/pair', { method: 'POST', body: JSON.stringify({ deviceId: 'expired', code }) });
    assert.equal(expired.status, 401);
  });
  await t.test('pairing codes are single use, per-device tokens are hashed', async () => {
    for (const [id, bridge] of [['windows', win], ['mac', mac]]) {
      const pairing = await request('/api/pairing', 'POST', { deviceId: id, name: id });
      assert.equal(pairing.status, 201);
      const { code } = await pairing.json();
      const config = await pairDevice({ serverUrl: base, deviceId: id, code, configFile: path.join(dir, `${id}.json`) });
      tokens[id] = config.token;
      assert.equal((await fetch(base + '/api/pair', { method: 'POST', body: JSON.stringify({ deviceId: id, code }) })).status, 401);
      clients.push(createClient({ ...config, bridgePort: bridge.port, receiptFile: path.join(dir, `${id}-receipts.json`), reconnectMs: 50, heartbeatMs: 200 }));
    }
    await until(async () => (await (await request('/api/devices')).json()).devices.every(d => d.online));
    const persisted = fs.readFileSync(stateFile, 'utf8');
    assert(!persisted.includes(tokens.windows)); assert(!persisted.includes(tokens.mac)); assert(!persisted.includes(password));
  });
  await t.test('routes each request only to the selected device, forbids unsupported APIs and cross-origin mutations', async () => {
    assert.equal((await (await request('/devices/windows/api/sessions')).json()).name, 'windows');
    assert.equal((await (await request('/devices/mac/api/sessions')).json()).name, 'mac');
    assert.equal((await request('/devices/windows/healthz')).status, 200);
    assert.equal((await request('/devices/missing/api/sessions')).status, 404);
    assert.equal((await request('/devices/windows/api/dev/sessions/x/codex/requests', 'POST', {})).status, 404);
    assert.equal((await request('/devices/windows/api/runs', 'POST', {}, { origin: 'https://evil.example' })).status, 403);
    await rejectedWs(socketBase + '/devices/windows/ws', { headers: { cookie }, origin: 'https://evil.example' }, 403);
    await rejectedWs(socketBase + '/agent/connect', { headers: { 'x-device-id': 'mac', authorization: 'Bearer ' + tokens.windows } }, 401);
  });
  await t.test('concurrent retry executes once; different payload with same request ID is rejected', async () => {
    const id = crypto.randomUUID();
    const before = win.mutations;
    const responses = await Promise.all([request('/devices/windows/api/runs', 'POST', { prompt: 'test-private-prompt' }, { 'x-request-id': id }), request('/devices/windows/api/runs', 'POST', { prompt: 'test-private-prompt' }, { 'x-request-id': id })]);
    assert.equal(responses[0].status, 200); assert.equal(responses[1].status, 200);
    assert.equal(win.mutations, before + 1);
    assert.deepEqual(await responses[0].json(), await responses[1].json());
    assert.equal((await request('/devices/windows/api/runs', 'POST', { prompt: 'different' }, { 'x-request-id': id })).status, 409);
    assert(!fs.readFileSync(stateFile, 'utf8').includes('test-private-prompt'));
  });
  await t.test('15,331,058-byte escaped history passes intact; request and response bounds return explicit 413', async () => {
    const prefix = '{"messages":[{"text":"';
    const suffix = '"}]}';
    const contentBytes = 15_331_058 - prefix.length - suffix.length;
    // Repeated JSON-escaped quotes also exercise response-frame expansion.
    const expected = prefix + '\\"'.repeat(Math.floor(contentBytes / 2)) + (contentBytes % 2 ? 'x' : '') + suffix;
    assert.equal(Buffer.byteLength(expected), 15_331_058);
    win.historyBody = expected;
    const response = await request('/devices/windows/api/sessions/large/messages');
    assert.equal(response.status, 200);
    const received = await response.text();
    assert.equal(Buffer.byteLength(received), 15_331_058);
    assert.equal(crypto.createHash('sha256').update(received).digest('hex'), crypto.createHash('sha256').update(expected).digest('hex'));
    const before = win.mutations;
    const oversizedInput = await request('/devices/windows/api/runs', 'POST', { prompt: 'x'.repeat(MAX_BODY) });
    assert.equal(oversizedInput.status, 413);
    assert.match((await oversizedInput.json()).message, /too large/i);
    assert.equal(win.mutations, before);
    win.historyBody = JSON.stringify({ messages: [{ text: 'x'.repeat(MAX_RESPONSE) }] });
    const oversizedHistory = await request('/devices/windows/api/sessions/large/messages');
    assert.equal(oversizedHistory.status, 413);
    const failure = await oversizedHistory.json();
    assert.equal(failure.state, 'too_large');
    assert.equal(failure.limitBytes, MAX_RESPONSE);
    assert.equal(win.mutations, before);
    win.historyBody = undefined;
    assert.equal((await request('/devices/windows/api/sessions')).status, 200);
  });
  await t.test('completed receipt survives client restart and unknown outcome never reruns', async () => {
    const requestId = crypto.randomUUID();
    const body = { name: 'persisted' };
    assert.equal((await request('/devices/windows/api/sessions', 'POST', body, { 'x-request-id': requestId })).status, 200);
    const before = win.mutations;
    await clients[0].close();
    clients[0] = createClient({ serverUrl: base, deviceId: 'windows', token: tokens.windows, bridgePort: win.port, receiptFile: path.join(dir, 'windows-receipts.json'), reconnectMs: 50, heartbeatMs: 200 });
    await until(() => clients[0].connected);
    assert.equal((await request('/devices/windows/api/sessions', 'POST', body, { 'x-request-id': requestId })).status, 200);
    assert.equal(win.mutations, before);
    win.failing = true;
    const unknownId = crypto.randomUUID();
    const failed = await request('/devices/windows/api/runs', 'POST', { prompt: 'unknown' }, { 'x-request-id': unknownId });
    assert.equal(failed.status, 503); assert.equal((await failed.json()).state, 'unknown');
    win.failing = false;
    const after = win.mutations;
    const retried = await request('/devices/windows/api/runs', 'POST', { prompt: 'unknown' }, { 'x-request-id': unknownId });
    assert.equal(retried.status, 409); assert.equal((await retried.json()).state, 'unknown');
    assert.equal(win.mutations, after);
  });
  await t.test('ten normal reads queue without 429, at most four dispatch; writes have independent capacity', async () => {
    win.resetReads(); win.readDelay = 250;
    const reads = Array.from({ length: 10 }, (_, index) => request(`/devices/windows/api/sessions?request=${index}`));
    await until(() => win.readCalls === 4);
    const write = await request('/devices/windows/api/runs', 'POST', { prompt: 'write priority' });
    assert.equal(write.status, 200);
    assert.equal(win.completedReads, 0);
    const responses = await Promise.all(reads);
    assert(responses.every(r => r.status === 200));
    assert.equal(win.readCalls, 10);
    assert.equal(win.maxReads, 4);
    win.readDelay = 0;
  });
  await t.test('network disconnect cancels queued reads and reconnect never dispatches them', async () => {
    win.resetReads(); win.readDelay = 400;
    const reads = Array.from({ length: 10 }, (_, index) => request(`/devices/windows/api/sessions?cancel=${index}`));
    await until(() => win.readCalls === 4);
    const previous = agentSockets.get('windows');
    previous.destroy();
    const responses = await Promise.all(reads);
    assert(responses.every(r => r.status === 503));
    await until(() => agentSockets.get('windows') !== previous && clients[0].connected);
    await sleep(500);
    assert.equal(win.readCalls, 4);
    assert.equal(win.maxReads, 4);
    win.readDelay = 0;
    assert.equal((await request('/devices/windows/api/sessions')).status, 200);
  });
  await t.test('device-scoped realtime events include sequence metadata', async () => {
    const ws = await connect(socketBase + '/devices/windows/ws', { headers: { cookie }, origin });
    sockets.push(ws);
    const received = [];
    ws.on('message', data => received.push(JSON.parse(data.toString())));
    mac.emit({ type: 'message.delta', sessionId: 'mac-only', text: 'private' });
    win.emit({ type: 'message.delta', sessionId: 'windows-only', text: 'visible' });
    await until(() => received.some(e => e.sessionId === 'windows-only'));
    assert(!received.some(e => e.sessionId === 'mac-only'));
    const last = received.find(e => e.sessionId === 'windows-only');
    assert(last._relay.epoch); assert(last._relay.seq > 0);
  });
  await t.test('network reconnect explicitly restores real mode and new browser hello/history', async () => {
    const previous = agentSockets.get('windows');
    previous.destroy();
    await until(() => agentSockets.get('windows') !== previous && clients[0].connected);
    const received = [];
    const ws = new WebSocket(socketBase + '/devices/windows/ws', { headers: { cookie }, origin });
    sockets.push(ws);
    ws.on('error', () => {});
    ws.on('message', data => received.push(JSON.parse(data.toString())));
    await until(() => received.some(e => e.type === 'hello' && e.mode === 'real'));
    const history = await request('/devices/windows/api/sessions');
    assert.equal(history.status, 200);
    assert.equal((await history.json()).name, 'windows');
  });
  await t.test('real-mode guard rejects mock bridge mutations', async () => {
    win.emit({ type: 'hello', mode: 'mock' });
    await sleep(15);
    const before = win.mutations;
    const rejected = await request('/devices/windows/api/runs', 'POST', { prompt: 'must not execute' });
    assert.equal(rejected.status, 503);
    assert.equal(win.mutations, before);
    await sleep(100);
  });
  await t.test('replacing agent connection disconnects old generation without reconnect takeover', async () => {
    const replacement = await connect(socketBase + '/agent/connect', { headers: { 'x-device-id': 'windows', authorization: 'Bearer ' + tokens.windows } });
    sockets.push(replacement);
    await until(() => !clients[0].connected);
    await sleep(150);
    assert(!clients[0].connected);
    replacement.close();
    await until(async () => !(await (await request('/api/devices')).json()).devices.find(d => d.id === 'windows').online);
    assert.equal((await request('/devices/windows/api/runs', 'POST', { prompt: 'offline' })).status, 503);
  });
  await t.test('revocation closes device and browser sockets, invalidates token', async () => {
    const ws = await connect(socketBase + '/devices/mac/ws', { headers: { cookie }, origin });
    sockets.push(ws);
    const close = new Promise(resolve => ws.once('close', resolve));
    assert.equal((await request('/api/devices/mac', 'DELETE')).status, 200);
    await close;
    await rejectedWs(socketBase + '/agent/connect', { headers: { 'x-device-id': 'mac', authorization: 'Bearer ' + tokens.mac } }, 401);
    assert.equal((await request('/devices/mac/api/sessions')).status, 404);
  });
  await t.test('logout invalidates cookie', async () => {
    assert.equal((await request('/api/logout', 'POST', {})).status, 200);
    assert.equal((await request('/api/devices')).status, 401);
  });
});
