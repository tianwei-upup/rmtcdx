import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { encode } from '../src/app-tools.mjs';
import { writePrivate } from '../src/state.mjs';

const controller = '11111111-1111-4111-8111-111111111111', thread = '22222222-2222-4222-8222-222222222222';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await delay(30); } throw Error('test_timeout'); }
async function desktop(endpoint, state) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), request = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4); let result;
        if (request.method === 'tools/list') result = { tools: [{ namespace: 'codex_app', name: 'send_message_to_thread' }] };
        else if (request.params.tool === 'read_thread') result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ thread: { id: thread, cwd: '/test', status: { type: 'idle' } }, turns: state.turns }) }] };
        else { state.writes++; state.turns.unshift({ id: 'turn-' + state.writes, status: 'inProgress' }); if (state.loseAck) { socket.destroy(); continue; } result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: thread }) }] }; }
        socket.write(encode({ jsonrpc: '2.0', id: request.id, result }));
      }
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve)); fs.chmodSync(endpoint, 0o600);
  return async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); };
}
async function host(scopeFile, endpoint) {
  const client = new Client({ name: 'mock-desktop-recovery', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('../src/mcp-server.mjs', import.meta.url).pathname, scopeFile], env: { CODEX_APP_TOOLS_PIPE_PATH: endpoint }, stderr: 'pipe' });
  transport.stderr.on('data', () => {}); await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name, arguments: args, _meta: { 'x-codex-turn-metadata': { thread_id: controller } } });
  await until(async () => (await call('companion_status')).structuredContent?.ready);
  return { client, transport, call, async crash() { const closed = new Promise(resolve => { client.onclose = resolve; }); process.kill(transport.pid, 'SIGKILL'); await closed; } };
}
for (const loseAck of [false, true]) test(`process recovery with a new desktop pipe, lost acknowledgement=${loseAck}`, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rmtcdx-recovery-')), runtime = path.join(base, 'run');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const scopeFile = path.join(base, 'scope.json'); writePrivate(scopeFile, { version: 1, mode: 'test', callerThreadId: controller, threadIds: [thread], expectedCwds: { [thread]: '/test' }, runtime });
  const state = { writes: 0, turns: [], loseAck }, pipeA = path.join(base, 'desktop-A.sock'), pipeB = path.join(base, 'desktop-B.sock');
  const closeA = await desktop(pipeA, state); let current;
  t.after(async () => { await current?.client.close(); });
  current = await host(scopeFile, pipeA);
  const args = { threadId: thread, intentId: 'original-intent', text: 'read-only mock acceptance' };
  const sent = await current.call('companion_send_test', args); assert.equal(Boolean(sent.isError), loseAck);
  if (!loseAck) await until(async () => (await current.call('companion_receipt', { threadId: thread, intentId: args.intentId })).structuredContent?.turnId);
  await current.crash(); await closeA();
  state.turns[0].status = 'completed'; state.loseAck = false;
  const closeB = await desktop(pipeB, state); t.after(closeB);
  current = await host(scopeFile, pipeB);
  const receipt = (await current.call('companion_send_test', args)).structuredContent;
  assert.equal(receipt.state, loseAck ? 'unknown' : 'completed'); assert.equal(state.writes, 1);
  if (loseAck) { const blocked = await current.call('companion_send_test', { ...args, intentId: 'must-stay-blocked' }); assert.equal(blocked.isError, true); assert.equal(state.writes, 1); }
  await current.client.close();
  await until(() => !fs.existsSync(path.join(runtime, 'owner.json')) && !fs.existsSync(path.join(runtime, 'control.sock')));
});
