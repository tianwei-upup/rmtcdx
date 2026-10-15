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
