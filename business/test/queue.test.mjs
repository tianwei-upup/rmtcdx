import test from 'node:test';
import assert from 'node:assert/strict';
import { input, output, OPERATIONS } from '../src/contracts.mjs';
import { TaskBoard } from '../src/tasks.mjs';
const receipt = {intentId:'intent',threadId:'test-chat',state:'queued',revision:1,cancelRequested:false,consumerTurnId:null,sessionId:null,outcomeUncertain:false};
test('queue protocol distinguishes durable enqueue from execution without fabricating native turns',()=>{
  const value={conversationId:'test-chat',intentId:'intent',text:'PRIVATE-PROMPT'};
  assert.deepEqual(input('queue.enqueue',value),value);
  assert.deepEqual(output('queue.enqueue',{conversationId:'test-chat',receipt}),{conversationId:'test-chat',receipt});
  assert.throws(()=>output('queue.enqueue',{conversationId:'test-chat',receipt,turnId:'fake'}));
  assert.throws(()=>output('queue.enqueue',{conversationId:'wrong',receipt}));
  assert.throws(()=>input('queue.cancel',{conversationId:'test-chat',intentId:'intent',expectedRevision:0}));
  assert.throws(()=>input('queue.enqueue',{...value,attachmentIds:[]}));
  assert(!OPERATIONS.includes('queue.enqueue'));
});
test('queue jobs persist metadata only, and succeeded means delivery not model completion',()=>{
  const store={data:{jobs:[]},save(){}};const board=new TaskBoard({store});
  const job=board.submit('device','queue.enqueue',{conversationId:'test-chat',intentId:'intent',text:'PRIVATE-QUEUE-PROMPT'},'intent');
  assert.equal(board.claim('device'),null);
  const lease=board.claim('device',['queue.enqueue']);board.ack('device',lease.id,lease.leaseToken);
  const done=board.complete('device',job.id,lease.leaseToken,{conversationId:'test-chat',receipt});
  assert.equal(done.state,'succeeded');assert.equal(done.result.receipt.state,'queued');
  assert(!JSON.stringify(store.data).includes('PRIVATE-QUEUE-PROMPT'));
  const query=board.submit('device','queue.status',{conversationId:'test-chat'},'query');const q=board.claim('device',['queue.status']);board.ack('device',q.id,q.leaseToken);
  board.complete('device',query.id,q.leaseToken,{conversationId:'test-chat',receipts:[{...receipt,state:'completed',consumerTurnId:'native-turn',result:'PRIVATE-QUEUE-ANSWER'}],consumer:null});
  assert(!JSON.stringify(store.data).includes('PRIVATE-QUEUE-ANSWER'));
});
test('dedicated queue polling expires read metadata without discarding durable write identities',()=>{
  let now=0;const store={data:{jobs:[],scopes:{}},save(){}};const board=new TaskBoard({store,now:()=>now,ttlMs:100,pruneQueueReads:true});
  const write=board.submit('device','queue.enqueue',{conversationId:'test-chat',intentId:'intent',text:'read only'},'intent');
  const query=board.submit('device','queue.status',{conversationId:'test-chat'},'query');store.data.scopes[query.id]={conversationId:'test-chat'};
  const q=board.claim('device',['queue.status']);board.ack('device',q.id,q.leaseToken);board.complete('device',q.id,q.leaseToken,{conversationId:'test-chat',receipts:[],consumer:null});
  now=101;board.sweep();assert.throws(()=>board.get(query.id),/job_not_found/);assert(!store.data.scopes[query.id]);assert.equal(board.get(write.id).state,'expired');assert.equal(board.submit('device','queue.enqueue',{conversationId:'test-chat',intentId:'intent',text:'read only'},'intent').id,write.id);
});
