import test from 'node:test';
import assert from 'node:assert/strict';
import { input, output, businessEvent, validateImage } from '../src/contracts.mjs';
import { TaskBoard } from '../src/tasks.mjs';

test('business schemas reject generic transport, remote permission elevation and raw native frames', () => {
  for (const operation of ['proxy', 'http', 'rpc.invoke', 'shell.execute']) assert.throws(() => input(operation, { method: 'GET', path: '/', body: '' }));
  assert.throws(() => input('projects.sync', { url: 'http://localhost:3210' }));
  assert.throws(() => input('turn.start', { conversationId: 'thread', text: 'x', attachmentIds: [], settings: { sandbox: 'danger-full-access' } }));
  assert.throws(() => input('approval.resolve', { conversationId: 'thread', approvalId: 'approval', decision: 'acceptForSession' }));
  assert.throws(() => businessEvent({ type: 'item.delta', payload: { arbitrary: true } }));
  assert.throws(() => validateImage('image/svg+xml', Buffer.from('<svg/>').toString('base64')));
  assert.throws(() => validateImage('image/png', Buffer.from('fake PNG').toString('base64')));
  assert.throws(() => output('attachment.stage', { conversationId: 'thread', attachmentId: 'attachment', status: 'staged', localPath: '/tmp/private' }));
});

test('RAM and job limits fail closed, duplicate terminal results do not execute again', () => {
  const board = new TaskBoard({ maxJobs: 1, maxBytes: 100 });
  assert.throws(() => board.submit('mac', 'turn.start', { conversationId: 'thread', text: 'x'.repeat(101), attachmentIds: [] }, 'too-large'), /payload_capacity/);
  const job = board.submit('mac', 'projects.sync', {}, 'one');
  assert.throws(() => board.submit('mac', 'projects.sync', {}, 'two'), /job_capacity/);
  const lease = board.claim('mac'); board.ack('mac', job.id, lease.leaseToken);
  const result = { projects: [] }; board.complete('mac', job.id, lease.leaseToken, result);
  assert.equal(board.complete('mac', job.id, lease.leaseToken, result).state, 'succeeded');
  assert.equal(board.claim('mac'), null);
  assert.throws(() => board.reconcile('mac', job.id, job.fingerprint, result, 'arbitrary'), /invalid_reconciliation/);
});

test('business task payloads reject local path and cwd fields', () => {
  // ADR 001 forbids task parameters carrying local paths or network targets.
  // These assertions keep that a code constraint, not only a document rule.
  const scoped = { conversationId: 'conversation-1', clientIntentId: 'intent-1' };
  for (const field of ['path', 'cwd', 'absPath', 'projectPath']) {
    assert.throws(() => input('turn.start', { ...scoped, text: 'hi', attachmentIds: [], [field]: '/etc/passwd' }), { code: 'invalid_fields' });
    assert.throws(() => input('conversation.create', { projectId: 'p', [field]: '/tmp' }), { code: 'invalid_fields' });
    assert.throws(() => input('conversation.snapshot', { conversationId: 'conversation-1', [field]: '/tmp' }), { code: 'invalid_fields' });
  }
});

test('business task payloads reject network targets and generic transport fields', () => {
  assert.throws(() => input('turn.start', { conversationId: 'c', text: 'x', attachmentIds: [], url: 'http://127.0.0.1:3210' }), { code: 'invalid_fields' });
  assert.throws(() => input('turn.start', { conversationId: 'c', text: 'x', attachmentIds: [], method: 'POST' }), { code: 'invalid_fields' });
  assert.throws(() => input('turn.start', { conversationId: 'c', text: 'x', attachmentIds: [], operation: 'rpc.invoke' }), { code: 'invalid_fields' });
  assert.throws(() => input('unsupported.operation', {}), { code: 'unsupported_operation' });
});

test('agent dispatcher prefers an injected adapter, then transport, then refuses native by default', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/agent.mjs', import.meta.url), 'utf8');
  // Precedence must stay explicit so a configured transport is never bypassed.
  assert.match(source, /attachMode = Boolean\(config\.transport\)/);
  assert.match(source, /if \(config\.adapter\)[^\n]*\n\s*else if \(attachMode\)/);
  // The suspended native guard must still gate every non-attach path.
  assert.match(source, /if \(!config\.adapter && !attachMode\) assertNativeExecutionAllowed\(\)/);
});
