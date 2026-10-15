import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { AppToolsClient, encode } from '../src/app-tools.mjs';

async function fixture(t, onRequest, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt-app-tools-'));
  fs.chmodSync(dir, 0o700); const endpoint = path.join(dir, 'tools.sock'), sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const n = buffer.readUInt32LE(); if (buffer.length < n + 4) return;
        const request = JSON.parse(buffer.subarray(4, n + 4)); buffer = buffer.subarray(n + 4); onRequest(request, socket);
      }
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve)); fs.chmodSync(endpoint, 0o600);
  const client = new AppToolsClient({ endpoint, callerThreadId: 'test-caller', ...options });
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(); return client;
}

test('length-prefixed responses survive split multibyte text and out-of-order requests', async t => {
  const requests = [];
  const c = await fixture(t, (r, s) => {
    requests.push(r); if (requests.length !== 2) return;
    const second = encode({ id: requests[1].id, result: { text: '另一条🙂' } });
    const first = encode({ id: requests[0].id, result: { text: '原会话' } });
    const data = Buffer.concat([second, first]); s.write(data.subarray(0, 7)); s.write(data.subarray(7, data.length - 2)); s.write(data.subarray(data.length - 2));
  });
  const results = await Promise.all([c.request('tools/list', {}), c.request('tools/list', {})]);
  assert.deepEqual(results, [{ text: '原会话' }, { text: '另一条🙂' }]);
});
test('peer close rejects outstanding calls rather than treating them as success', async t => {
  const c = await fixture(t, (_, s) => s.destroy());
  await assert.rejects(c.request('tools/list', {}), { code: 'desktop_pipe_closed' });
});
test('a missing response times out without resending a write request', async t => {
  let count = 0; const c = await fixture(t, () => count++, { timeoutMs: 30 });
  await assert.rejects(c.tool('send_message_to_thread', { threadId: 'test-target', prompt: 'test' }), { code: 'desktop_request_timeout' });
  assert.equal(count, 1);
});
test('oversized incoming frame fails closed', async t => {
  const c = await fixture(t, (_, s) => { const size = Buffer.alloc(4); size.writeUInt32LE(8 * 1024 * 1024 + 1); s.write(size); });
  await assert.rejects(c.request('tools/list', {}), { code: 'frame_too_large' });
});
test('arbitrary tool names are rejected without sending a frame', async t => {
  let count = 0; const c = await fixture(t, () => count++);
  await assert.rejects(c.tool('shell.execute', {}), { code: 'unsupported_desktop_tool' });
  assert.equal(count, 0);
});
