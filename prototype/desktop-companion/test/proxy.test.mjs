import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionProxy } from '../src/proxy.mjs';
const scope = { callerThreadId: 'controller', threadIds: ['allowed'] };
const status = { callerThreadId: 'controller', allowedThreadIds: ['allowed'], mode: 'test', ready: true };
test('frontend attaches to the existing writer without claiming or stopping its owner', async () => {
  const calls = [], proxy = new CompanionProxy({ runtime: 'test', scope, call: async (_, input) => { calls.push(input); return input.operation === 'status' ? status : { state: 'submitted' }; } });
  assert.equal((await proxy.execute({ operation: 'status' })).mcpRole, 'proxy');
  await proxy.execute({ operation: 'send', threadId: 'allowed', text: 'test', intentId: 'one' }); proxy.stop();
  assert.equal(calls.filter(r => r.operation === 'send').length, 1); assert.equal(calls.some(r => r.operation === 'stop'), false);
});
test('frontend cannot widen the owner grant or call arbitrary control operations', async () => {
  const proxy = new CompanionProxy({ runtime: 'test', scope, call: async () => status });
  await assert.rejects(proxy.execute({ operation: 'send', threadId: 'other' }), { code: 'test_thread_not_allowed' });
  await assert.rejects(proxy.execute({ operation: 'stop' }), { code: 'unsupported_operation' });
  const wrong = new CompanionProxy({ runtime: 'test', scope: { ...scope, callerThreadId: 'other' }, call: async () => status });
  await assert.rejects(wrong.execute({ operation: 'status' }), { code: 'owner_scope_mismatch' });
});
test('proxy never leaves a hidden long-poll claim after frontend cancellation', async () => {
  const calls = [], proxy = new CompanionProxy({ runtime: 'test', scope, call: async (_, input) => { calls.push(input); return input.operation === 'status' ? status : { status: 'empty' }; } });
  await proxy.execute({ operation: 'inbox_take', waitMs: 20000, signal: new AbortController().signal });
  assert.equal(calls.at(-1).waitMs, 0); assert.equal('signal' in calls.at(-1), false);
  const abort = new AbortController(); abort.abort();
  const before = calls.filter(c => c.operation === 'inbox_take').length;
  await assert.rejects(proxy.execute({ operation: 'inbox_take', waitMs: 20000, signal: abort.signal }), { code: 'inbox_wait_cancelled' });
  assert.equal(calls.filter(c => c.operation === 'inbox_take').length, before);
});
