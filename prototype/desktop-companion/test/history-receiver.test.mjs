import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryReceiver, activationId } from '../src/history-receiver.mjs';
const job = { intentId: 'phone-message', state: 'queued' };
function fixture() {
  let snapshot = { receipts: [job], consumer: { state: 'closed' } }, state = 'queued';
  const writes = [], wakes = [], events = [];
  const receiver = new HistoryReceiver({ conversationId: 'original-id', nativeQueue: { enqueue: data => { writes.push(data); return { state }; } }, readQueue: async () => snapshot, wake: async id => wakes.push(id), publish: e => events.push(e) });
  return { receiver, writes, wakes, events, snapshot: s => { snapshot = s; }, state: s => { state = s; } };
}
test('cold queued phone message activates original chat; concurrent ticks share one attempt', async () => {
  const f = fixture(); await Promise.all([f.receiver.tick(), f.receiver.tick(), f.receiver.tick()]);
  assert.equal(f.writes.length, 1); assert.deepEqual(f.wakes, ['original-id']);
  assert.equal(f.writes[0].intentId, activationId('original-id', job.intentId));
  assert.match(f.writes[0].text, /rmt_queue_listen/);
  f.snapshot({ receipts: [job], consumer: { state: 'active', consumerTurnId: 'original-native-turn' } });
  await f.receiver.tick(); assert.equal(f.writes.length, 1); assert.equal(f.events.at(-1).state, 'receiving');
});
test('leased, unknown and cancelled work never creates an activation', async () => {
  for (const state of ['leased', 'unknown', 'cancelled']) {
    const f = fixture(); f.snapshot({ receipts: [{ ...job, state }] }); await f.receiver.tick();
    assert.equal(f.writes.length, 0); assert.equal(f.wakes.length, 0);
  }
});
test('lost native acknowledgement blocks without wake or a changed activation id', async () => {
  const f = fixture(); f.state('unknown'); await f.receiver.tick(); await f.receiver.tick();
  assert.equal(f.wakes.length, 0); assert.equal(new Set(f.writes.map(w => w.intentId)).size, 1);
  assert.equal(f.events.at(-1).code, 'native_admission_unknown');
  f.state('accepted'); await f.receiver.tick(); assert.equal(f.events.at(-1).state, 'awaiting_consumer'); assert.equal(f.wakes.length, 1);
  await f.receiver.tick(); assert.equal(f.wakes.length, 1);
});
test('a direct Inbox is never activated by the legacy pull receiver',async()=>{
 const f=fixture();f.snapshot({deliveryMode:'native',receipts:[job],consumer:null});await f.receiver.tick();assert.equal(f.writes.length,0);assert.equal(f.wakes.length,0);assert.equal(f.events.at(-1).deliveryMode,'native');
});
test('a migration that wins while a legacy snapshot is pending fences the old activation',async()=>{
 const writes=[];let release,allowed=true;const snapshot=new Promise(r=>{release=r;});
 const receiver=new HistoryReceiver({conversationId:'original-id',readQueue:()=>snapshot,nativeQueue:{enqueue:r=>writes.push(r)},wake:()=>{},isLegacyAllowed:()=>allowed});
 const pending=receiver.tick();allowed=false;release({receipts:[job],consumer:null});await pending;assert.equal(writes.length,0);
});
