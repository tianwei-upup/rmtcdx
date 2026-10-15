// Negative live test only. Must run inside the dedicated controller's own
// command execution: its turn is active for the lifetime of this command.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { AppToolsClient, encode } from '../prototype/desktop-companion/src/app-tools.mjs';
import { readPrivate } from '../prototype/desktop-companion/src/state.mjs';

const base = path.resolve(import.meta.dirname, '../.runtime/desktop-companion-mcp');
const scope = readPrivate(path.join(base, 'scope.json'), null);
const threadId = '01a13fef-a018-7303-a2a6-f5903548537f';
const cwd = '/Users/liutianwei/Documents/Codex/2026-10-15/rmtcdx-companion-lifecycle-20261015';
assert.equal(scope.mode, 'test'); assert.equal(scope.callerThreadId, threadId);
assert.equal(process.env.CODEX_THREAD_ID, threadId, 'actual dedicated controller required');
const endpoint = '/Users/liutianwei/.codex/ipc/ipc.sock';
const stat = fs.lstatSync(endpoint);
assert.ok(stat.isSocket() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'unsafe owner IPC');
const native = new AppToolsClient({ endpoint: process.env.CODEX_APP_TOOLS_PIPE_PATH, callerThreadId: threadId });
const pending = new Map();
let socket, buffer = Buffer.alloc(0), clientId = 'initializing-client';
const rejectPending = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
function request(method, params, version, targetClientId) {
  assert.ok(['initialize', 'thread-owner-discovery', 'thread-follower-start-turn'].includes(method));
  if (method !== 'initialize') assert.equal(params.conversationId, threadId);
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error('owner_request_timeout_no_retry')); }, 10000);
    const finish = callback => value => { clearTimeout(timer); callback(value); };
    pending.set(requestId, { resolve: finish(resolve), reject: finish(reject) });
    socket.write(encode({ type: 'request', requestId, sourceClientId: clientId, method, params, version, targetClientId, timeoutMs: 10000 }));
  });
}
const activeTurn = snapshot => snapshot.turns.find(turn => turn.status === 'inProgress')?.id;
const report = { recordedAt: new Date().toISOString(), kind: 'live_owner_busy_self_negative_probe', threadId, passed: false, nativeSendUsed: false };
try {
  await native.connect();
  const before = await native.tool('read_thread', { threadId, hostId: 'local', turnLimit: 10, includeOutputs: false, maxOutputCharsPerItem: 1000 });
  assert.equal(before.thread.id, threadId); assert.equal(before.thread.cwd, cwd);
  assert.ok(activeTurn(before), 'self must already be active; never probe an idle chat');
  report.activeTurnId = activeTurn(before);
  socket = net.createConnection(endpoint);
  socket.on('error', rejectPending); socket.on('close', () => rejectPending(Error('owner_closed_no_retry')));
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE();
      if (size > 8 * 1024 * 1024) { socket.destroy(Error('oversized_owner_frame')); return; }
      if (buffer.length < size + 4) return;
      let message;
      try { message = JSON.parse(buffer.subarray(4, size + 4).toString('utf8')); }
      catch { socket.destroy(Error('invalid_owner_frame')); return; }
      buffer = buffer.subarray(size + 4);
      if (message.type === 'response') { pending.get(message.requestId)?.resolve(message); pending.delete(message.requestId); }
      else if (message.type === 'client-discovery-request') socket.write(encode({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }));
    }
  });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const initialized = await request('initialize', { clientType: 'rmtcdx-dedicated-owner-negative-probe' }, 0);
  assert.equal(initialized.resultType, 'success'); clientId = initialized.result.clientId;
  const owner = await request('thread-owner-discovery', { conversationId: threadId, hostId: 'local' }, 1);
  assert.equal(owner.resultType, 'success'); report.ownerId = owner.handledByClientId;
  // Nonempty responseItems invokes the installed owner's busy guard. This is
  // deliberately not offered as an idle sender: the offline race test fails.
  const result = await request('thread-follower-start-turn', {
    conversationId: threadId,
    turnStart: {
      request: { threadId, clientUserMessageId: `rmtcdx-rejected-${crypto.randomUUID()}`, input: [{ type: 'text', text: 'Dedicated negative admission probe. This request must be rejected while busy.' }] },
      context: { inheritThreadSettings: true, responseItems: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Dedicated owner busy rejection probe; no project work is requested.' }] }] }
    }
  }, 2, owner.handledByClientId);
  report.resultType = result.resultType; report.error = result.error;
  assert.equal(result.resultType, 'error', 'candidate unexpectedly accepted; do not retry');
  assert.match(String(result.error), /App context must wait until the current turn finishes/);
  const after = await native.tool('read_thread', { threadId, hostId: 'local', turnLimit: 10, includeOutputs: false, maxOutputCharsPerItem: 1000 });
  assert.equal(activeTurn(after), activeTurn(before));
  assert.deepEqual(after.turns.map(turn => turn.id), before.turns.map(turn => turn.id));
  report.noNewTurn = true; report.originalTurnStillActive = true; report.passed = true;
  report.atomicAdmissionPassed = false;
} finally {
  socket?.destroy(); native.close();
  fs.writeFileSync(path.join(base, 'owner-busy-self.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify(report, null, 2));
