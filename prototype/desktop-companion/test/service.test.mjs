import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../src/service.mjs';
import { acquireOwner, writePrivate } from '../src/state.mjs';

const fixture = t => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rmtcdx-service-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const turns = { a: [], b: [] }; let sends = 0, failSend = false, beforeRead;
  const client = { socket: { destroyed: false }, close() {}, connect: async () => {}, catalog: async () => [{ namespace: 'codex_app', name: 'send_message_to_thread' }],
    tool: async (name, args) => {
      if (name === 'read_thread') { await beforeRead?.(); return { thread: { id: args.threadId, cwd: '/test/' + args.threadId, status: { type: 'idle' } }, turns: structuredClone(turns[args.threadId]) }; }
      sends++; if (failSend) throw Object.assign(Error(), { code: 'desktop_pipe_closed' });
      turns[args.threadId].unshift({ id: `turn-${sends}`, status: 'inProgress' }); return { threadId: args.threadId };
    } };
  const scope = { version: 1, mode: 'test', callerThreadId: 'controller', threadIds: ['a', 'b'], expectedCwds: { a: '/test/a', b: '/test/b' } };
  const make = () => { const s = new CompanionService({ runtime, client, scope }); s.ready = true; return s; };
  return { make, turns, runtime, scope, client, sends: () => sends, fail: () => { failSend = true; }, readBarrier: fn => { beforeRead = fn; } };
};
const send = (s, intentId, threadId = 'a') => s.execute({ operation: 'send', threadId, intentId, text: 'read only test' });
test('same thread locks before first await and remains held after ACK until terminal turn', async t => {
  const f = fixture(t), s = f.make(); let release;
  f.readBarrier(() => new Promise(resolve => { release = resolve; })); const first = send(s, 'one');
  await assert.rejects(send(s, 'two'), { code: 'test_thread_busy' });
  f.readBarrier(null); release(); await first;
  await assert.rejects(send(s, 'two'), { code: 'test_thread_busy' });
  await s.reconcile(); assert.equal(s.status().holds[0].turnId, 'turn-1');
  f.turns.a[0].status = 'completed'; await s.reconcile();
  assert.equal(s.status().holds.length, 0); await send(s, 'two'); assert.equal(f.sends(), 2);
});
test('different allowed threads proceed concurrently', async t => {
  const f = fixture(t), s = f.make(); await Promise.all([send(s, 'one'), send(s, 'two', 'b')]); assert.equal(f.sends(), 2);
});
test('restart recovers acknowledged active turn and never repeats a send', async t => {
  const f = fixture(t); await send(f.make(), 'one'); const s = f.make(); await s.reconcile();
  await assert.rejects(send(s, 'two'), { code: 'test_thread_busy' });
  assert.equal((await send(s, 'one')).turnId, 'turn-1'); assert.equal(f.sends(), 1);
  f.turns.a[0].status = 'completed'; await s.reconcile(); assert.equal((await send(s, 'one')).state, 'completed'); assert.equal(f.sends(), 1);
});
test('lost acknowledgement remains unknown and blocks across restart and a new observed turn', async t => {
  const f = fixture(t); f.fail(); await assert.rejects(send(f.make(), 'one'), { code: 'desktop_pipe_closed' });
  f.turns.a.push({ id: 'foreign-or-original', status: 'completed' }); const s = f.make(); await s.reconcile();
  assert.equal((await send(s, 'one')).state, 'unknown'); await assert.rejects(send(s, 'two'), { code: 'test_thread_busy' }); assert.equal(f.sends(), 1);
});
test('ambiguous turn attribution retains durable unknown hold', async t => {
  const f = fixture(t), s = f.make(); await send(s, 'one'); f.turns.a.push({ id: 'desktop-race', status: 'completed' }); await s.reconcile();
  assert.equal(s.status().holds[0].state, 'unknown'); await assert.rejects(send(s, 'two'), { code: 'test_thread_busy' });
});
test('desktop active state and out-of-scope identity fail before writes', async t => {
  const f = fixture(t), s = f.make(); f.turns.a.push({ id: 'desktop', status: 'inProgress' });
  await assert.rejects(send(s, 'one'), { code: 'test_thread_busy' }); await assert.rejects(send(s, 'two', 'other'), { code: 'test_thread_not_allowed' });
  f.scope.expectedCwds.b = '/wrong'; await assert.rejects(send(s, 'three', 'b'), { code: 'thread_identity_mismatch' }); assert.equal(f.sends(), 0);
});
test('live owner excludes another writer; stale owner recovery preserves receipts', t => {
  const f = fixture(t), release = acquireOwner(f.runtime); assert.throws(() => acquireOwner(f.runtime), { code: 'companion_already_running' }); release();
  writePrivate(path.join(f.runtime, 'owner.json'), { pid: 2147483647 }); writePrivate(path.join(f.runtime, 'receipts.json'), { proof: true });
  const next = acquireOwner(f.runtime); assert.equal(JSON.parse(fs.readFileSync(path.join(f.runtime, 'receipts.json'))).proof, true); next();
});

test('kernel mutex recovery tolerates a reused PID from a terminated modern owner', t => {
  const f = fixture(t);
  writePrivate(path.join(f.runtime, 'owner.json'), { pid: process.pid, lockVersion: 1, token: 'previous-boot' });
  const release = acquireOwner(f.runtime); release();
});
