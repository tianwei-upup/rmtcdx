import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wakeNativeQueue, checkQueueWakeBuild } from '../src/native-queue-wake.mjs';

const id = '01a13feb-ce80-7ca3-aa1e-17814542b353';
function fixture() {
  const calls = [], logs = [];
  return { calls, logs, options: {
    conversationId: id, checkScope: () => calls.push('scope'),
    checkRuntime: async () => { calls.push('runtime'); },
    verifyBuild: () => calls.push('build'),
    run: async (...args) => { calls.push(args); }, log: e => logs.push(e)
  } };
}
test('wake launches only the dedicated queue URL, without user input or navigation', async () => {
  const { calls, logs, options } = fixture();
  assert.equal((await wakeNativeQueue(options)).state, 'notification_dispatched');
  assert.deepEqual(calls.slice(0, 4), ['scope', 'runtime', 'build', 'scope']);
  assert.deepEqual(calls[4], ['/usr/bin/open', ['-g', '-a', '/Applications/ChatGPT.app', 'codex://threads/wake/' + id], { timeout: 5000 }]);
  assert.equal(logs.at(-1).event, 'native.queue.wake.dispatched');
  assert.equal(logs.at(-1).conversationId, id);
});
test('other chats and rejected scope/build/runtime never invoke open', async () => {
  for (const field of ['conversationId', 'checkScope', 'checkRuntime', 'verifyBuild']) {
    const { calls, options } = fixture();
    options[field] = field === 'conversationId' ? 'other' : () => { throw Error('blocked'); };
    await assert.rejects(wakeNativeQueue(options));
    assert.equal(calls.some(Array.isArray), false);
  }
});
test('lost launch acknowledgement remains unknown and never claims queue acceptance', async () => {
  const { options, logs } = fixture();
  options.run = async () => { throw Error('timed out after delivery'); };
  assert.equal((await wakeNativeQueue(options)).state, 'notification_unknown');
  assert.equal(logs.at(-1).event, 'native.queue.wake.unknown');
});
test('scope revoked during the runtime check prevents notification', async () => {
  const { calls, options } = fixture();let checks = 0;
  options.checkScope = () => { if (++checks === 2) throw Error('scope revoked'); };
  await assert.rejects(wakeNativeQueue(options), /scope revoked/);
  assert.equal(calls.some(Array.isArray), false);
});
test('archive verification rejects malformed or unverified desktop sources', () => {
  assert.throws(() => checkQueueWakeBuild({ archive: import.meta.filename }));
});
test('a well-formed archive with known filenames and changed source is rejected', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-wake-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const header = Buffer.from(JSON.stringify({ files: { '.vite': { files: { build: { files: {
    'bootstrap-DCRTDDSX.js': { size: 1, offset: '0' },
    'main-JI9qDiXp.js': { size: 1, offset: '1' }
  } } } } } }));
  const prefix = Buffer.alloc(16);prefix.writeUInt32LE(4);prefix.writeUInt32LE(header.length + 8, 4);prefix.writeUInt32LE(header.length, 12);
  const archive = path.join(dir, 'app.asar');fs.writeFileSync(archive, Buffer.concat([prefix, header, Buffer.from('xx')]));
  assert.throws(() => checkQueueWakeBuild({ archive }), /native_queue_wake_build_changed/);
});
