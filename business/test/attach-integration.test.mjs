// Integration test for the attach path: a real WebSocket JSON-RPC app-server
// double on a Unix socket, the production attachAdapter, and the real upstream
// client reached through the built bridge bundle.
//
// This is the offline equivalent of runbook phase A: it proves the protocol
// path end to end without a desktop, a second executor, or model inference.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { attachAdapter } from '../src/attach-adapter.mjs';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer, offset) {
  if (buffer.length - offset < 2) return null;
  const first = buffer[offset];
  const second = buffer[offset + 1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let cursor = offset + 2;
  if (length === 126) {
    if (buffer.length - cursor < 2) return null;
    length = buffer.readUInt16BE(cursor);
    cursor += 2;
  } else if (length === 127) {
    if (buffer.length - cursor < 8) return null;
    length = Number(buffer.readBigUInt64BE(cursor));
    cursor += 8;
  }
  let key = null;
  if (masked) {
    if (buffer.length - cursor < 4) return null;
    key = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
  }
  if (buffer.length - cursor < length) return null;
  const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
  if (key) for (let index = 0; index < payload.length; index += 1) payload[index] ^= key[index % 4];
  return { frame: { opcode, payload }, next: cursor + length };
}

const THREAD = {
  id: 'thread-attached',
  cwd: '/fixtures/repo',
  name: 'Attached thread',
  preview: 'attached preview',
  updatedAt: 1_700_000_000,
  status: { type: 'idle' },
  turns: [
    { id: 'turn-1', status: 'completed', items: [{ id: 'item-1', type: 'agentMessage', text: 'shared history' }] }
  ]
};

/** Minimal app-server double: handshake + method dispatch, nothing mocked. */
function createDouble(socketPath, handle) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 4);
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? '';
        const accept = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        upgraded = true;
      }
      for (;;) {
        const decoded = decodeFrame(buffer, 0);
        if (!decoded) return;
        buffer = buffer.subarray(decoded.next);
        if (decoded.frame.opcode !== 0x1) continue;
        const message = JSON.parse(decoded.frame.payload.toString('utf8'));
        if (message.method === undefined) continue;
        const result = handle(message.method, message.params);
        if (message.id === undefined) continue;
        socket.write(encodeFrame(0x1, Buffer.from(result === undefined ? JSON.stringify({ id: message.id, result: {} }) : JSON.stringify({ id: message.id, result }), 'utf8')));
      }
    });
  });
  return {
    server,
    async listen() {
      try { fs.unlinkSync(socketPath); } catch { /* not present */ }
      await new Promise(resolve => server.listen(socketPath, resolve));
      // A real executor socket grants no group/other access; the validator
      // rejects a world-visible socket, so the double must match that.
      fs.chmodSync(socketPath, 0o600);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}

const PROJECT = { id: 'fixture', name: 'Fixture', path: '/fixtures/repo', paths: ['/fixtures/repo'] };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmtcdx-attach-int-'));
  const socketPath = path.join(root, 'executor.sock');
  return { root, socketPath, physicalRoot: path.join(root, 'physical') };
}

test('attach adapter executes business operations against a shared executor over a Unix socket', async () => {
  const { root, socketPath } = setup();
  fs.mkdirSync(path.join(root, 'physical'), { recursive: true, mode: 0o700 });
  // inspectExecutorSocket requires a direct socket owned by the current uid.
  const double = createDouble(socketPath, method => {
    if (method === 'initialize') return { userAgent: 'double/1' };
    if (method === 'thread/list') return { data: [THREAD], nextCursor: null };
    if (method === 'thread/read') return { thread: THREAD };
    return {};
  });
  await double.listen();

  const { attachClientFactory } = await import('../src/attach-client.mjs');
  const adapter = await attachAdapter(
    { kind: 'unix-direct', path: socketPath },
    [PROJECT],
    () => {},
    null,
    {},
    { createClient: attachClientFactory() }
  );
  try {
    assert.equal(adapter.state, 'connecting');
    await adapter.start();
    assert.equal(adapter.state, 'connected');
    assert.equal(adapter.getState().ready, true);

    // projects.sync reflects the attached project catalog.
    const projects = await adapter.execute('projects.sync', {}, 'job-projects');
    assert.equal(projects.projects.length, 1);
    assert.equal(projects.projects[0].id, 'fixture');

    // directory.sync reads the shared history through the attached executor.
    const directory = await adapter.execute('directory.sync', {}, 'job-directory');
    assert.equal(directory.directories[0].conversations[0].id, 'thread-attached');

    // conversation.snapshot returns the real turn content, not a mock.
    const snapshot = await adapter.execute('conversation.snapshot', { conversationId: 'thread-attached' }, 'job-snapshot');
    assert.equal(snapshot.messages[0].text, 'shared history');
  } finally {
    await adapter.stop();
    await double.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attach adapter fails closed when the endpoint is absent and never falls back', async () => {
  const { root, socketPath } = setup();
  const { attachClientFactory } = await import('../src/attach-client.mjs');
  try {
    // Validation itself must reject a missing socket before any client is built.
    await assert.rejects(
      attachAdapter({ kind: 'unix-direct', path: socketPath }, [PROJECT], () => {}, null, {}, { createClient: attachClientFactory() }),
      { code: 'socket_missing' }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attach adapter without a client factory stays a validated skeleton', async () => {
  const { root, socketPath } = setup();
  const double = createDouble(socketPath, () => ({}));
  await double.listen();
  try {
    const adapter = await attachAdapter({ kind: 'unix-direct', path: socketPath }, [PROJECT], () => {});
    assert.equal(adapter.state, 'validated_only');
    assert.equal(adapter.getState().ready, false);
    assert.equal(adapter.getState().lastError.code, 'attach_not_implemented');
    await assert.rejects(adapter.execute('projects.sync', {}, 'job'), /attach_not_implemented/);
  } finally {
    await double.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
