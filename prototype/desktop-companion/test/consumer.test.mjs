import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OwnerInbox } from '../src/inbox.mjs';
import { InboxConsumer } from '../src/consumer.mjs';
import { CompanionService } from '../src/service.mjs';
function fixture(t) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(),'consumer-'));
  const inbox = new OwnerInbox({runtime,threadId:'controller'}), consumer = new InboxConsumer(inbox);
  t.after(()=>{inbox.close();fs.rmSync(runtime,{recursive:true,force:true});}); return {runtime,inbox,consumer};
}
test('continuous window retains empty waits and closes at its job limit', t=>{
  const {inbox:q,consumer:c}=fixture(t), s=c.open('turn',120000,2);
  assert.equal(c.take(s.sessionId,'turn').continuePolling,true);
  assert.throws(()=>c.open('other'),{code:'inbox_consumer_already_active'});
  assert.throws(()=>c.take(s.sessionId,'other'),{code:'inbox_consumer_mismatch'});
  for(let i=0;i<2;i++){q.enqueue('j'+i,'read');const job=c.take(s.sessionId,'turn');q.complete(job.intentId,job.leaseToken,'ok','turn');}
  assert.equal(c.take(s.sessionId,'turn').status,'stopped');assert.equal(c.status().stopReason,'job_limit');
});
test('queued cancellation and cooperative leased cancellation are fenced and never interrupt native turns',t=>{
  const {inbox:q,consumer:c}=fixture(t);
  const first=q.enqueue('queued','first');assert.equal(q.cancel('queued',first.revision).state,'cancelled');
  assert.equal(q.enqueue('queued','first').state,'cancelled');
  q.enqueue('leased','second');const s=c.open('turn'),job=c.take(s.sessionId,'turn');
  const row=q.receipt(q.get(job.intentId));const cancelled=q.cancel(job.intentId,row.revision);
  assert.equal(cancelled.cancelRequested,true);assert.equal(cancelled.state,'leased');
  assert.throws(()=>q.cancel(job.intentId,row.revision),{code:'inbox_revision_conflict'});
  assert.throws(()=>q.complete(job.intentId,job.leaseToken,'late result','turn'),{code:'inbox_cancel_requested'});
  assert.equal(q.checkpoint(job.intentId,job.leaseToken,'turn').cancelRequested,true);
  assert.equal(q.ackCancel(job.intentId,job.leaseToken,'turn').state,'cancelled');
  assert.equal(q.ackCancel(job.intentId,job.leaseToken,'turn').state,'cancelled');
});
test('stopping an idle poll preserves new jobs for explicit reopening',async t=>{
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'consumer-stop-'));
  const s=new CompanionService({runtime,scope:{version:1,mode:'test',callerThreadId:'controller',threadIds:['target'],expectedCwds:{target:'/test'}},client:{close(){}}});
  t.after(()=>{s.stop();fs.rmSync(runtime,{recursive:true,force:true});});
  const first=await s.execute({operation:'inbox_open',consumerTurnId:'one'});
  const wait=s.execute({operation:'inbox_take',sessionId:first.sessionId,consumerTurnId:'one',waitMs:1000});
  s.consumer.stop(first.sessionId);s.inbox.enqueue('after-stop','read');
  assert.equal((await wait).status,'stopped');assert.equal(s.inbox.get('after-stop').state,'queued');
  const next=s.consumer.open('two');assert.equal(s.consumer.take(next.sessionId,'two').intentId,'after-stop');
});
test('deadline and graceful stop do not discard a leased job or start queued work',t=>{
  const {inbox:q,consumer:c}=fixture(t);q.enqueue('one','one');q.enqueue('two','two');
  const s=c.open('turn'),job=c.take(s.sessionId,'turn');
  assert.equal(c.stop(s.sessionId).state,'stopping');assert.equal(c.take(s.sessionId,'turn').status,'stopped');
  q.complete(job.intentId,job.leaseToken,'ok','turn');assert.equal(c.status().state,'closed');assert.equal(q.get('two').state,'queued');
  const next=c.open('next');q.db.prepare('UPDATE consumers SET expires_at=0 WHERE id=?').run(next.sessionId);
  assert.equal(c.take(next.sessionId,'next').status,'stopped');assert.equal(q.get('two').state,'queued');
});
test('recovery requires explicit revision-fenced abandonment; uncertain work is never requeued',t=>{
  const {inbox:q,consumer:c}=fixture(t);q.enqueue('one','read');const s=c.open('turn');const job=c.take(s.sessionId,'turn');
  const old=q.get('one').revision;q.recover();assert.equal(c.status().state,'closed');
  assert.throws(()=>c.open('next'),{code:'inbox_outcome_unknown'});
  assert.throws(()=>q.resolveUnknown('one',old,'verified test abandonment'),{code:'inbox_reconciliation_conflict'});
  const abandoned=q.resolveUnknown('one',q.get('one').revision,'verified test abandonment');
  assert.equal(abandoned.state,'cancelled');assert.equal(abandoned.outcomeUncertain,true);assert.equal(abandoned.resolution,'abandoned_unknown');
  assert.throws(()=>q.complete('one',job.leaseToken,'late','turn'),{code:'inbox_outcome_unknown'});
  assert.equal(c.take(c.open('next').sessionId,'next').status,'empty');
  const audit=JSON.stringify(q.db.prepare('SELECT * FROM audit').all());assert(!audit.includes(job.leaseToken));assert(!audit.includes('late'));
});
test('v1 schema migration preserves completed history and adds cancellation without deleting data',t=>{
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'consumer-migration-')),file=path.join(runtime,'inbox.sqlite');
  fs.closeSync(fs.openSync(file,'wx',0o600));const old=new DatabaseSync(file);
  old.exec("CREATE TABLE jobs(intent_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','leased','completed','unknown')),token TEXT,consumer_turn TEXT,result TEXT,result_hash TEXT,created_at INTEGER NOT NULL); INSERT INTO jobs VALUES('legacy','hash','old prompt','completed','token','old-turn','old result','result-hash',1);");old.close();
  const q=new OwnerInbox({runtime,threadId:'controller'});t.after(()=>{q.close();fs.rmSync(runtime,{recursive:true,force:true});});
  assert.equal(q.get('legacy').result,'old result');assert.equal(q.get('legacy').consumer_turn,'old-turn');assert.equal(q.db.prepare('PRAGMA user_version').get().user_version,2);
  const row=q.enqueue('new','new prompt');assert.equal(q.cancel('new',row.revision).state,'cancelled');
});
