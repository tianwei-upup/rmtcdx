import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionBusinessAdapter } from '../src/business-adapter.mjs';

const snapshot = turns => ({ thread: { id: 'test-thread', title: 'Test', updatedAt: 1 }, turns, page: { hasMore: false } });
test('cloud calls cannot target an unregistered desktop thread', async () => {
  let count = 0;
  const adapter = new CompanionBusinessAdapter({ runtime: 'unused', threadIds: ['test-thread'], call: async () => count++ });
  await assert.rejects(adapter.execute('conversation.snapshot', { conversationId: 'another-thread' }, 'job'), { code: 'precondition_rejected' });
  assert.equal(count, 0);
});
test('summary pagination is never advertised as complete history', async () => {
  const adapter = new CompanionBusinessAdapter({ runtime: 'unused', threadIds: ['test-thread'], call: async () => ({ ...snapshot([]), page: { hasMore: true } }) });
  await assert.rejects(adapter.execute('conversation.snapshot', { conversationId: 'test-thread' }, 'job'), { code: 'precondition_rejected' });
});
test('ambiguous new turns stay unknown and never produce a fabricated turn ID', async () => {
  let sends = 0; const events = [];
  const adapter = new CompanionBusinessAdapter({ runtime: 'unused', threadIds: ['test-thread'], emit: e => events.push(e), allowNonAtomicTestSends: true, call: async (_, input) => {
    if (input.operation === 'send') { sends++; return { state: 'unknown', beforeTurnIds: ['old'] }; }
    return snapshot([{ id: 'new-a' }, { id: 'new-b' }, { id: 'old' }]);
  } });
  await assert.rejects(adapter.execute('turn.start', { conversationId: 'test-thread', text: 'test', attachmentIds: [] }, 'job'), { code: 'execution_unknown' });
  assert.equal(sends, 1); assert.equal(events.length, 0);
});
test('unsupported attachments are rejected before any desktop side effect', async () => {
  let calls = 0; const adapter = new CompanionBusinessAdapter({ runtime: 'unused', threadIds: ['test-thread'], call: async () => calls++ });
  await assert.rejects(adapter.execute('turn.start', { conversationId: 'test-thread', text: 'test', attachmentIds: ['image'] }, 'job'), { code: 'precondition_rejected' });
  assert.equal(calls, 0);
});

test('snapshot forwards native pagination rather than silently dropping older turns', async () => {
  let received;
  const adapter = new CompanionBusinessAdapter({ runtime: 'unused', threadIds: ['test-thread'], call: async (_, input) => { received = input; return { ...snapshot([]), page: { hasMore: true, nextCursor: 'older-page' } }; } });
  const value = await adapter.execute('conversation.snapshot', { conversationId: 'test-thread', cursor: 'this-page' }, 'job');
  assert.equal(received.cursor, 'this-page'); assert.equal(value.nextCursor, 'older-page');
});
test('adapter reserves a thread before waiting for a send acknowledgement', async () => {
  let release, sends = 0;
  const adapter = new CompanionBusinessAdapter({ runtime: 'unused', threadIds: ['test-thread'], allowNonAtomicTestSends: true, call: async () => { sends++; return new Promise(resolve => { release = resolve; }); } });
  const first = adapter.execute('turn.start', { conversationId: 'test-thread', text: 'one', attachmentIds: [] }, 'job-one');
  await assert.rejects(adapter.execute('turn.start', { conversationId: 'test-thread', text: 'two', attachmentIds: [] }, 'job-two'), { code: 'precondition_rejected' });
  release({ state: 'unknown' }); await assert.rejects(first, { code: 'execution_unknown' }); assert.equal(sends, 1);
});

test('default business worker never advertises or invokes the non-atomic desktop write path', async () => {
  let calls = 0;
  const adapter = new CompanionBusinessAdapter({ runtime: 'unused', threadIds: ['test-thread'], call: async () => { calls++; } });
  assert.deepEqual(adapter.operations, ['projects.sync', 'sessions.sync', 'conversation.snapshot']);
  await assert.rejects(adapter.execute('turn.start', { conversationId: 'test-thread', text: 'must not steer', attachmentIds: [] }, 'blocked-write'), { code: 'precondition_rejected' });
  assert.equal(calls, 0);
});
