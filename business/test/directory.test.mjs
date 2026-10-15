import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryCache } from '../web/chat-state.mjs';
import { output } from '../src/contracts.mjs';
const snapshot = title => ({ projects: [{ id: 'a', name: 'A' }], directories: [{ projectId: 'a', conversations: [{ id: 'one', projectId: 'a', title, status: 'idle' }], nextCursor: null }] });
test('directory cache coalesces refreshes, serves existing entries during background fetch and retains them after failure', async () => {
  let now = 100, reads = 0, resolve, reject;
  const cache = new DirectoryCache(() => { reads++; return new Promise((a, b) => { resolve = a; reject = b; }); }, { now: () => now });
  const first = cache.refresh(), same = cache.refresh(true); assert.equal(first, same); assert.equal(reads, 1);
  resolve(snapshot('Old')); await first;
  await cache.refresh(); assert.equal(reads, 1);
  now += 31000; const pending = cache.refresh(); assert.equal(cache.get('a').conversations[0].title, 'Old');
  resolve(snapshot('New')); await pending; assert.equal(cache.get('a').conversations[0].title, 'New');
  const failed = cache.refresh(true); reject(new Error('offline')); await assert.rejects(failed);
  assert.equal(cache.get('a').conversations[0].title, 'New'); assert.equal(cache.pending, null);
  cache.remember({ id: 'fresh', projectId: 'a', title: 'Created', status: 'idle' });
  assert.deepEqual(cache.conversations('a').map(c => c.id), ['fresh', 'one']);
  cache.append('a', { conversations: [{ id: 'one' }, { id: 'older' }], nextCursor: null });
  assert.deepEqual(cache.get('a').conversations.map(c => c.id), ['one', 'older']);
});
test('directory schema rejects duplicate ownership, remote paths and unknown projects', () => {
  const value = snapshot('Chat'); assert.equal(output('directory.sync', value).directories.length, 1);
  const orphan = structuredClone(value); orphan.directories[0].conversations[0].projectId = 'elsewhere'; assert.throws(() => output('directory.sync', orphan));
  const transport = structuredClone(value); transport.directories[0].path = '/private'; assert.throws(() => output('directory.sync', transport));
  const duplicate = structuredClone(value); duplicate.directories.push(duplicate.directories[0]); assert.throws(() => output('directory.sync', duplicate));
});
