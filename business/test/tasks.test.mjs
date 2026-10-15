import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TaskBoard } from '../src/tasks.mjs';

test('a business intent has an independent lifecycle and is executed only by its assigned device', () => {
  const board = new TaskBoard();
  const intentId = crypto.randomUUID();
  const job = board.submit('mac', 'conversation.create', { projectId: 'fixture' }, intentId);
  assert.equal(job.state, 'pending');
  assert.equal(board.claim('windows'), null);
  const task = board.claim('mac');
  assert.equal(task.operation, 'conversation.create');
  assert.deepEqual(task.input, { projectId: 'fixture' });
  assert.equal(board.claim('mac'), null);
  board.ack('mac', task.id, task.leaseToken);
  board.complete('mac', task.id, task.leaseToken, { conversation: { id: 'thread-1', projectId: 'fixture', title: 'New conversation', status: 'idle' } });
  assert.equal(board.get(job.id).state, 'succeeded');
  assert.equal(board.get(job.id).result.conversation.id, 'thread-1');
  assert.equal(board.submit('mac', 'conversation.create', { projectId: 'fixture' }, intentId).id, job.id);
  assert.throws(() => board.submit('mac', 'conversation.create', { projectId: 'other' }, intentId), /intent_conflict/);
});

test('private turn payloads expire and terminal receipts can reconcile unknown writes without replay', () => {
  let now = 0; const store = { data: { jobs: [] }, save() { this.saved = JSON.stringify(this.data); } };
  const board = new TaskBoard({ store, now: () => now, ttlMs: 100, leaseMs: 20 });
  const privateText = 'PRIVATE-PROMPT-NOT-FOR-DISK';
  const job = board.submit('mac', 'turn.start', { conversationId: 'thread-1', text: privateText, attachmentIds: [] }, crypto.randomUUID());
  assert.equal(board.claim('mac', ['projects.sync']), null, 'Workers only claim capabilities they advertise');
  const task = board.claim('mac', ['turn.start']); board.ack('mac', job.id, task.leaseToken);
  assert(!store.saved.includes(privateText));
  assert.throws(() => board.submit('mac', 'turn.start', { conversationId: 'thread-1', text: 'x', attachmentIds: [], method: 'POST', path: '/api/runs' }, crypto.randomUUID()), /invalid_fields/);
  now = 21;
  assert.equal(board.get(job.id).state, 'unknown');
  board.reconcile('mac', job.id, task.fingerprint, { conversationId: 'thread-1', turnId: 'turn-1', status: 'running' });
  assert.equal(board.get(job.id).result.turnId, 'turn-1');
  assert.equal(board.claim('mac'), null);
  now = 122;
  assert.equal(board.get(job.id).resultAvailable, false);
  assert(!store.saved.includes(privateText));
});

test('lease loss never re-executes a write; a read can retry and restarts retain only metadata', () => {
  let now = 1000;
  const store = { data: { jobs: [] }, save() { this.saved = JSON.stringify(this.data); } };
  const board = new TaskBoard({ store, now: () => now, leaseMs: 50 });
  const write = board.submit('mac', 'conversation.create', { projectId: 'private-project' }, crypto.randomUUID());
  const leased = board.claim('mac'); board.ack('mac', leased.id, leased.leaseToken);
  now += 51;
  assert.equal(board.get(write.id).state, 'unknown');
  assert.equal(board.claim('mac'), null);
  const read = board.submit('mac', 'projects.sync', {}, crypto.randomUUID());
  board.claim('mac'); now += 51;
  const retried = board.claim('mac');
  assert.equal(retried.id, read.id);
  assert.throws(() => board.complete('windows', retried.id, retried.leaseToken, { projects: [] }), /job_not_found/);
  const restarted = new TaskBoard({ store: { data: JSON.parse(store.saved), save() {} }, now: () => now });
  assert.equal(restarted.get(write.id).state, 'unknown');
  assert.equal(restarted.get(read.id).state, 'unknown');
  assert.equal(restarted.claim('mac'), null);
  assert(!store.saved.includes('"input"'));
  assert(!store.saved.includes('private-project'));
});
