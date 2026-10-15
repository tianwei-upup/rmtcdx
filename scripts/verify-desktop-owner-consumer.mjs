// Loopback-only acceptance coordinator. It never sends to a desktop chat.
// The root operator starts only the dedicated consumer at the reported phases.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createBusinessServer } from '../business/src/server.mjs';
import { startAgent } from '../business/src/agent.mjs';
import { InboxBusinessAdapter } from '../prototype/desktop-companion/src/inbox-business-adapter.mjs';
import { OwnerInbox } from '../prototype/desktop-companion/src/inbox.mjs';
import { control } from '../prototype/desktop-companion/src/control.mjs';
import { readPrivate,writePrivate,privateDirectory } from '../prototype/desktop-companion/src/state.mjs';

const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'.runtime/owner-consumer-validation');privateDirectory(base);
const scope=readPrivate(path.join(root,'.runtime/desktop-companion-mcp/scope.json'),null);
assert.equal(scope.mode,'test');assert.equal(scope.callerThreadId,'01a13fef-a018-7303-a2a6-f5903548537f');
const before=await control(scope.runtime,{operation:'status'});assert.equal(before.ownerInbox.protocolVersion,2);assert.equal(before.ownerInbox.inflight,null);
const q=new OwnerInbox({runtime:scope.runtime,threadId:scope.callerThreadId});
const ids=Object.fromEntries(['queued-cancel','a','b','uncertain','resumed'].map(s=>[s,'consumer-v2-20261016-'+s]));
assert(!q.receipts().some(r=>Object.values(ids).includes(r.intentId)),'existing test intents require reconciliation, not automatic replay');
const receiptFile=path.join(scope.runtime,'receipts.json'),hash=()=>crypto.createHash('sha256').update(fs.readFileSync(receiptFile)).digest('hex'),nativeHash=hash();
const origin='http://127.0.0.1:3230',password='local-only-'+crypto.randomBytes(24).toString('hex');
let server,agent,cookie='',endpoint,firstSession;
const progress=(phase,extra={})=>{const value={recordedAt:new Date().toISOString(),phase,threadId:scope.callerThreadId,...extra};writePrivate(path.join(base,'progress.json'),value);console.log(JSON.stringify(value));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(check,label,timeout=150000){const end=Date.now()+timeout;do{const value=await check();if(value)return value;await sleep(150);}while(Date.now()<end);throw Error('timeout: '+label);}
async function api(route,data){const r=await fetch(endpoint+route,{method:data?'POST':'GET',headers:{origin,cookie,'content-type':'application/json'},body:data?JSON.stringify(data):undefined});if(route==='/api/login')cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,value:await r.json()};}
async function job(route,data){const accepted=await api(route,data);assert.equal(accepted.status,202,JSON.stringify(accepted.value));return wait(async()=>{const r=(await api('/api/jobs/'+accepted.value.id)).value;return !['pending','leased','running'].includes(r.state)&&r;},'business delivery',15000);}
const fresh=()=>crypto.randomUUID();
const route='/api/conversations/'+scope.callerThreadId+'/queue';
const enqueue=async(intentId,text)=>{const r=await job(route,{clientIntentId:intentId,text});assert.equal(r.state,'succeeded');return r.result.receipt;};
const cancel=async receipt=>{const r=await job(route+'/cancel',{clientIntentId:fresh(),intentId:receipt.intentId,expectedRevision:receipt.revision});assert.equal(r.state,'succeeded');return r.result.receipt;};
const queueStatus=()=>control(scope.runtime,{operation:'inbox_queue_status',threadId:scope.callerThreadId});
const auditCount=(event,intent)=>Number(q.db.prepare('SELECT count(*) AS n FROM audit WHERE event=?'+(intent?' AND intent_id=?':'')).get(...(intent?[event,intent]:[event])).n);
try {
  server=await createBusinessServer({origin,password,stateFile:path.join(base,'server.json'),claimWaitMs:100,enableLocalQueueTest:true});
  endpoint='http://127.0.0.1:'+(await server.listen(0,'127.0.0.1')).port;
  await api('/api/login',{username:'admin',password});const pair=(await api('/api/pairing',{deviceId:'local-inbox-v2',name:'Local Inbox v2 test'})).value;
  const adapter=new InboxBusinessAdapter({runtime:scope.runtime,threadId:scope.callerThreadId,enableLocalQueueTest:true});
  agent=await startAgent({origin:endpoint,deviceId:'local-inbox-v2',pairCode:pair.code,stateFile:path.join(base,'agent.json'),adapter,enableLocalQueueTest:true,log:value=>{if(value.event?.includes('failed'))console.log(JSON.stringify(value));}});
  await job('/api/devices/local-inbox-v2/sync',{resource:'projects',clientIntentId:fresh()});
  await job('/api/devices/local-inbox-v2/sync',{resource:'sessions',projectId:adapter.projectId,clientIntentId:fresh()});
  const queued=await enqueue(ids['queued-cancel'],'PRIVATE-QUEUED-CANCEL must never execute');assert.equal((await cancel(queued)).state,'cancelled');
  const emptyBaseline=auditCount('consumer.empty');
  progress('awaiting_continuous_consumer',{endpoint,windowMs:180000,maxJobs:4});
  firstSession=await wait(async()=>{const s=(await queueStatus()).consumer;return s?.state==='active'&&s.waiting&&s;},'continuous consumer');
  await wait(()=>auditCount('consumer.empty')>emptyBaseline,'real empty long poll');
  progress('empty_poll_observed',{consumerTurnId:firstSession.consumerTurnId});
  await enqueue(ids.a,'这是专用持续领取只读测试。记住代码 BIRCH-6428，只回复 STREAM1 BIRCH-6428。不修改文件、不联网、不操作其他聊天。');
  await wait(()=>q.get(ids.a).state==='completed','first completion');assert.equal(q.get(ids.a).result,'STREAM1 BIRCH-6428');
  await enqueue(ids.b,'这是专用协作取消测试。先调用 companion_inbox_checkpoint，若未取消，用 exec_command 运行 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node -e "setTimeout(() => {}, 8000)" 只读等待；等待后再 checkpoint。若 cancelRequested=true，只调用 companion_inbox_ack_cancel 并继续领取，不输出任务答案或 complete。不修改文件、不联网、不操作其他聊天。');
  await wait(()=>auditCount('job.checkpoint',ids.b)>0,'checkpoint before cancellation');
  const pending=q.receipt(q.get(ids.b));assert.equal(pending.state,'leased');assert.equal((await cancel(pending)).cancelRequested,true);
  await wait(()=>q.get(ids.b).state==='cancelled','cooperative cancellation');
  await wait(async()=>{const s=(await queueStatus()).consumer;return s?.waiting&&s;},'idle wait after cancellation');
  const stopped=await job(route+'/stop',{clientIntentId:fresh(),sessionId:firstSession.sessionId});assert.equal(stopped.result.consumer.state,'closed');
  await enqueue(ids.uncertain,'这是未确认恢复测试占位。领取后不要执行任何工作，也不要 complete 或 ack_cancel；只关闭本消费窗口，然后结束本轮，明确保留未确认租约供测试恢复。不操作文件、网络或其他聊天。');
  assert.equal(q.get(ids.uncertain).state,'queued');
  progress('awaiting_uncertain_consumer',{firstConsumerTurn:firstSession.consumerTurnId});
  await wait(()=>q.get(ids.uncertain).state==='leased','uncertain lease');
  await wait(async()=> (await queueStatus()).consumer?.state==='stopping','uncertain session closed');
  progress('awaiting_scoped_service_reload',{leasedTurnId:q.get(ids.uncertain).consumer_turn});
  await wait(()=>q.get(ids.uncertain).state==='unknown','unknown after MCP restart');
  progress('awaiting_blocked_open_probe',{revision:q.get(ids.uncertain).revision});
  await wait(()=>fs.existsSync(path.join(base,'blocked-probe-confirmed.json')),'operator blocked-open confirmation');
  const confirmation=readPrivate(path.join(base,'blocked-probe-confirmed.json'),null);assert.equal(confirmation.abandonDedicatedProbe,true);
  const unknown=q.receipt(q.get(ids.uncertain));assert.equal(q.resolveUnknown(ids.uncertain,unknown.revision,'Operator verified dedicated placeholder; abandon without replay').state,'cancelled');
  await enqueue(ids.resumed,'沿用持续领取测试记住的代码，只回复 STREAM_RESUMED <代码>。不修改文件、不联网、不操作其他聊天。');
  progress('awaiting_resume_consumer');
  await wait(()=>q.get(ids.resumed).state==='completed','resumed completion');assert.equal(q.get(ids.resumed).result,'STREAM_RESUMED BIRCH-6428');
  const status=await queueStatus();assert.equal(status.consumer.state,'closed');assert.equal(q.get(ids.b).consumer_turn,firstSession.consumerTurnId);assert.equal(q.get(ids.a).consumer_turn,firstSession.consumerTurnId);
  assert.equal(q.get(ids['queued-cancel']).consumer_turn,null);assert.equal(auditCount('job.leased',ids.uncertain),1);
  assert.equal(hash(),nativeHash);const target=await control(scope.runtime,{operation:'snapshot',threadId:scope.threadIds[0]});assert.equal(target.turns.length,9);
  const queried=await job(route+'/status',{clientIntentId:fresh()});assert.equal(queried.state,'succeeded');
  const persisted=fs.readFileSync(path.join(base,'server.json'),'utf8');assert(!persisted.includes('BIRCH-6428'));assert(!persisted.includes('PRIVATE-QUEUED-CANCEL'));
  const report={recordedAt:new Date().toISOString(),passed:true,threadId:scope.callerThreadId,loopbackOnly:true,continuousEmptyPollObserved:true,jobs:q.receipts().filter(r=>Object.values(ids).includes(r.intentId)),consumer:status.consumer,nativeReceiptUnchanged:true,acceptanceTargetTurns:9,uncertainLeaseNeverReplayed:true,businessMetadataContainsNoBodies:true,ecsApkWritesEnabled:false,blockedOpenConfirmation:confirmation};
  writePrivate(path.join(base,'report.json'),report);progress('passed');
} catch(error) { progress('failed',{code:error.code??error.message});throw error; }
finally {await agent?.stop();await server?.close();q.close();}
