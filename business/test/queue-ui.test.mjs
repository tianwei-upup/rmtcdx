import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueState } from '../web/queue-state.mjs';
test('queue UI preserves newer receipts and separates delivery, cancellation and uncertain outcomes',()=>{
  const s=new QueueState(),base={intentId:'one',revision:1,state:'queued',cancelRequested:false,outcomeUncertain:false};
  s.merge([base]);assert.equal(s.label(s.list()[0]),'排队中');assert(s.canCancel(base));
  const leased={...base,revision:2,state:'leased'};s.merge([leased]);s.merge([base]);assert.equal(s.list()[0].state,'leased');
  const pending={...leased,revision:3,cancelRequested:true};s.merge([pending]);assert.equal(s.label(pending),'等待取消确认');assert(!s.canCancel(pending));
  const unknown={...leased,state:'unknown',outcomeUncertain:true};assert.equal(s.label(unknown),'结果未知');assert(!s.canCancel(unknown));
  const abandoned={...unknown,state:'cancelled',resolution:'abandoned_unknown'};assert.equal(s.label(abandoned),'结果未知 · 已停止跟进');
  const done={...leased,revision:4,state:'completed',result:'answer'};s.merge([done]);assert.equal(s.list()[0].result,'answer');assert(!s.canCancel(done));
});
test('optimistic messages reconcile with receipts and never overwrite server outcomes',()=>{
  const s=new QueueState();s.sending('second','two',20);s.sending('first','one',10);
  assert.deepEqual(s.list().map(r=>r.intentId),['first','second']);
  s.deliveryFailed('first',true);assert.equal(s.items.get('first').state,'unconfirmed');
  s.sending('first','one',30);assert.equal(s.items.get('first').timing.enqueuedAt,10);
  const receipt={intentId:'first',text:'one',revision:2,state:'completed',result:'answer',timing:{enqueuedAt:10}};
  s.merge([receipt]);s.deliveryFailed('first',true);s.sending('first','one');s.removeLocal('first');
  assert.equal(s.items.get('first'),receipt);assert(!s.items.get('first').local);
  s.deliveryFailed('second',false);assert.equal(s.items.get('second').state,'failed');
  s.removeLocal('second');assert.equal(s.list().length,1);
});
