import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDesktopRuntime, runReceiverTick } from '../src/desktop-runtime.mjs';
import { HistoryReceiver } from '../src/history-receiver.mjs';

const desktop = `${process.getuid()} 42 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n`;
const check = (version, stdout = desktop) => () => checkDesktopRuntime({ readVersion: () => version, run: async () => ({ stdout }) });
test('verified upgraded desktop reaches the real receiver and preserves the original admission identity', async () => {
  const writes = [], wakes = [], errors = [];
  const receiver = new HistoryReceiver({ conversationId: 'original-id',
    readQueue: async () => ({ receipts: [{ intentId: 'same-phone-intent', state: 'queued' }] }),
    nativeQueue: { enqueue: value => { writes.push(value); return { state: writes.length === 1 ? 'queued' : 'accepted' }; } },
    wake: async id => wakes.push(id)
  });
  const tick = () => runReceiverTick({ checkDesktop: check('0.163.0-alpha.11.1'), ids: ['original-id'],
    receive: () => receiver.tick(), unavailable: (id, error) => errors.push({ id, code: error.code }) });
  await tick(); await tick();
  assert.equal(errors.length, 0); assert.equal(writes.length, 2);
  assert.equal(writes[0].intentId, writes[1].intentId); assert.deepEqual(wakes, ['original-id']);
});
test('unknown builds are rejected before process/admission calls and published for every Inbox', async () => {
  let processCalls = 0, received = 0; const errors = [];
  await runReceiverTick({ checkDesktop: () => checkDesktopRuntime({ readVersion: () => '0.163.0-alpha.12.1', run: async () => { processCalls++; return { stdout: desktop }; } }),
    ids: ['a', 'b'], receive: () => { received++; }, unavailable: (id, error) => errors.push({ id, code: error.code, version: error.desktopVersion }) });
  assert.equal(processCalls, 0); assert.equal(received, 0);
  assert.deepEqual(errors, ['a', 'b'].map(id => ({ id, code: 'desktop_build_changed', version: '0.163.0-alpha.12.1' })));
});
test('missing, duplicate or another user desktop never starts a receiver', async () => {
  for (const stdout of ['', desktop + desktop, `${process.getuid() + 1} 42 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n`]) {
    let received = false, code;
    await runReceiverTick({ checkDesktop: check('0.163.0-alpha.11.1', stdout), ids: ['a'], receive: () => { received = true; }, unavailable: (_id, error) => { code = error.code; } });
    assert.equal(received, false); assert.equal(code, 'original_desktop_unavailable');
  }
});
test('schema/admission failure is visible and does not block an independent receiver', async () => {
  const received = [], errors = [];
  await runReceiverTick({ checkDesktop: check('0.163.0-alpha.10.2'), ids: ['a', 'b'], receive: id => {
    if (id === 'a') throw Object.assign(Error('native_queue_schema_changed'), { code: 'native_queue_schema_changed' });
    received.push(id);
  }, unavailable: (id, error) => errors.push({ id, code: error.code }) });
  assert.deepEqual(errors, [{ id: 'a', code: 'native_queue_schema_changed' }]); assert.deepEqual(received, ['b']);
});
