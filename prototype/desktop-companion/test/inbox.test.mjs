import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { OwnerInbox } from '../src/inbox.mjs';
import { CompanionService } from '../src/service.mjs';

function fixture(t) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rmtcdx-inbox-')), connections = [];
  const open = () => { const db = new OwnerInbox({ runtime, threadId: 'controller' }); connections.push(db); return db; };
  t.after(() => { for (const db of connections) db.close(); fs.rmSync(runtime, { recursive: true, force: true }); });
  return { runtime, open };
}
test('independent producer processes append atomically without losing jobs or duplicating an intent', async t => {
  const f = fixture(t), db = f.open();
  const moduleUrl = new URL('../src/inbox.mjs', import.meta.url).href;
  const program = `import {OwnerInbox} from ${JSON.stringify(moduleUrl)}; const q=new OwnerInbox({runtime:process.argv[1],threadId:'controller'}); for(let i=0;i<10;i++)q.enqueue(process.argv[2]+'-'+i,'read-only '+i);q.enqueue('duplicate','same body');q.close();`;
  await Promise.all(['a', 'b', 'c', 'd'].map(prefix => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, f.runtime, prefix], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; }); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error(stderr)));
  })));
  assert.equal(db.receipts().length, 41); assert.equal(db.status().counts.queued, 41);
  assert.throws(() => db.enqueue('duplicate', 'different body'), { code: 'inbox_intent_conflict' });
});
test('one inflight lease, caller turn binding and result dedup hold across database connections', t => {
  const f = fixture(t), a = f.open(), b = f.open();
  a.enqueue('one', 'first'); b.enqueue('two', 'second');
  const job = a.claim('native-turn');
  assert.equal(job.intentId, 'one'); assert.equal(b.claim('other-turn').status, 'blocked');
  assert.throws(() => b.complete('one', job.leaseToken, 'result', 'other-turn'), { code: 'inbox_lease_mismatch' });
  assert.throws(() => a.complete('one', 'wrong', 'result', 'native-turn'), { code: 'inbox_lease_mismatch' });
  const completed = a.complete('one', job.leaseToken, 'result', 'native-turn');
  assert.deepEqual(b.complete('one', job.leaseToken, 'result', 'native-turn'), completed);
  assert.throws(() => b.complete('one', job.leaseToken, 'changed', 'native-turn'), { code: 'inbox_result_conflict' });
  assert.equal(b.claim('native-turn').intentId, 'two');
});
test('owner recovery retains unknown delivery and never replays it', t => {
  const f = fixture(t), a = f.open(); a.enqueue('one', 'read'); const leased = a.claim('old-turn');
  const b = f.open(); b.recover();
  assert.equal(b.claim('new-turn').state, 'unknown');
  assert.equal(b.enqueue('one', 'read').state, 'unknown');
  assert.throws(() => b.complete('one', leased.leaseToken, 'late result', 'old-turn'), { code: 'inbox_outcome_unknown' });
});
test('SIGKILL after a durable claim recovers as unknown without replaying it', async t => {
  const f = fixture(t), db = f.open(); db.enqueue('crash', 'read-only');
  const moduleUrl = new URL('../src/inbox.mjs', import.meta.url).href;
  const program = `import {OwnerInbox} from ${JSON.stringify(moduleUrl)}; const q=new OwnerInbox({runtime:process.argv[1],threadId:'controller'});console.log(JSON.stringify(q.claim('killed-turn')));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, f.runtime], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve); });
  child.kill('SIGKILL'); await exited;
  db.recover(); assert.equal(db.claim('resumed-turn').state, 'unknown');
  assert.equal(db.receipts().length, 1);
});
test('existing inbox cannot be reopened with a wider or different caller scope', t => {
  const f = fixture(t); f.open();
  assert.throws(() => new OwnerInbox({ runtime: f.runtime, threadId: 'other' }), { code: 'inbox_scope_mismatch' });
});
test('MCP pull and completion never use the native sender, even when desktop connectivity is unavailable', async t => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rmtcdx-pull-')); let calls = 0;
  const service = new CompanionService({ runtime, scope: { version: 1, mode: 'test', callerThreadId: 'controller', threadIds: ['target'], expectedCwds: { target: '/test' } }, client: { tool: () => { calls++; throw Error('must not call native'); }, close() {} } });
  t.after(() => { service.stop(); fs.rmSync(runtime, { recursive: true, force: true }); });
  service.inbox.enqueue('job', 'read-only');
  const session = await service.execute({ operation: 'inbox_open', consumerTurnId: 'turn' });
  const job = await service.execute({ operation: 'inbox_take', sessionId: session.sessionId, consumerTurnId: 'turn' });
  const done = await service.execute({ operation: 'inbox_complete', intentId: job.intentId, leaseToken: job.leaseToken, result: 'done', consumerTurnId: 'turn' });
  assert.equal(done.state, 'completed'); assert.equal(calls, 0);
});
test('cancelled long poll leaves queued work available rather than claiming it in the background', async t => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rmtcdx-cancel-'));
  const service = new CompanionService({ runtime, scope: { version: 1, mode: 'test', callerThreadId: 'controller', threadIds: ['target'], expectedCwds: { target: '/test' } }, client: { close() {} } });
  t.after(() => { service.stop(); fs.rmSync(runtime, { recursive: true, force: true }); });
  const abort = new AbortController();
  const session = await service.execute({ operation: 'inbox_open', consumerTurnId: 'turn' });
  const take = service.execute({ operation: 'inbox_take', sessionId: session.sessionId, consumerTurnId: 'turn', waitMs: 1000, signal: abort.signal });
  abort.abort(); service.inbox.enqueue('after-cancel', 'read');
  await assert.rejects(take, { code: 'inbox_wait_cancelled' });
  assert.equal(service.inbox.status().counts.queued, 1);
});
