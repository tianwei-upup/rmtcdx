import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { InboxBusinessAdapter } from '../src/inbox-business-adapter.mjs';
import { CompanionService } from '../src/service.mjs';
import { serveLocal } from '../src/local-server.mjs';
import { createBusinessServer } from '../../../business/src/server.mjs';
import { startAgent } from '../../../business/src/agent.mjs';
test('queue capability is opt-in and rejects foreign chats before any desktop call',async t=>{
  let calls=0;const adapter=new InboxBusinessAdapter({runtime:'unused',threadId:'controller',call:async()=>{calls++;}});
  await assert.rejects(adapter.execute('queue.enqueue',{conversationId:'controller',intentId:'one',text:'test'}),{code:'precondition_rejected'});assert.equal(calls,0);
  const enabled=new InboxBusinessAdapter({runtime:'unused',threadId:'controller',enableLocalQueueTest:true,call:async()=>{calls++;return {mode:'test',callerThreadId:'controller',ownerInbox:{protocolVersion:2}};}});
  t.after(()=>enabled.stop());await enabled.start();const before=calls;
  await assert.rejects(enabled.execute('queue.status',{conversationId:'foreign'}),{code:'precondition_rejected'});assert.equal(calls,before);
});
test('worker readiness fails closed on companion loss and recovers without replaying writes',async t=>{
  let offline=false,calls=0;
  const adapter=new InboxBusinessAdapter({runtime:'test',threadId:'controller',enableLocalQueueTest:true,call:async()=>{calls++;if(offline)throw Error('offline');return {mode:'test',callerThreadId:'controller',ownerInbox:{protocolVersion:2}};}});
  t.after(()=>adapter.stop());await adapter.start();assert.equal(adapter.ready(),true);
  offline=true;await assert.rejects(adapter.health());assert.equal(adapter.ready(),false);
  const before=calls;await assert.rejects(adapter.execute('queue.enqueue',{conversationId:'controller',intentId:'one',text:'read'}),{code:'precondition_rejected'});assert.equal(calls,before);
  offline=false;await adapter.health();assert.equal(adapter.ready(),true);
});
test('loopback business jobs enqueue/cancel/query the private inbox, preserve CAS and never send native messages',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'queue-business-')),runtime=path.join(dir,'run');let nativeCalls=0;
  const service=new CompanionService({runtime,scope:{version:1,mode:'test',callerThreadId:'controller',threadIds:['target'],expectedCwds:{target:'/test'}},client:{close(){},tool(){nativeCalls++;throw Error('must not call native');}}});
  const closeSocket=await serveLocal(runtime,service,()=>{});
  const origin='http://127.0.0.1:3230',password='local-test-password-longer-than-24-characters';
  const server=await createBusinessServer({origin,password,stateFile:path.join(dir,'server.json'),claimWaitMs:10,enableLocalQueueTest:true});
  const port=(await server.listen(0)).port;let cookie='';
  async function api(route,data){const r=await fetch(`http://127.0.0.1:${port}`+route,{method:data?'POST':'GET',headers:{origin,cookie,'content-type':'application/json'},body:data?JSON.stringify(data):undefined});if(route==='/api/login')cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,value:await r.json()};}
  await api('/api/login',{username:'admin',password});const pair=(await api('/api/pairing',{deviceId:'local-test',name:'local'})).value;
  const adapter=new InboxBusinessAdapter({runtime,threadId:'controller',enableLocalQueueTest:true});
  const agent=await startAgent({origin:`http://127.0.0.1:${port}`,deviceId:'local-test',pairCode:pair.code,stateFile:path.join(dir,'agent.json'),adapter,enableLocalQueueTest:true,log(){}});
  t.after(async()=>{await agent.stop();await server.close();await closeSocket();service.stop();fs.rmSync(dir,{recursive:true,force:true});});
  async function job(route,data){const a=await api(route,data);assert.equal(a.status,202,JSON.stringify(a.value));for(let i=0;i<100;i++){const r=(await api('/api/jobs/'+a.value.id)).value;if(!['pending','leased','running'].includes(r.state))return r;await new Promise(r=>setTimeout(r,20));}throw Error('job timeout');}
  const uuid=()=>crypto.randomUUID();
  await job('/api/devices/local-test/sync',{resource:'projects',clientIntentId:uuid()});
  await job('/api/devices/local-test/sync',{resource:'sessions',projectId:adapter.projectId,clientIntentId:uuid()});
  const endpoint='/api/conversations/controller/queue',intent=uuid();
  const queued=await job(endpoint,{clientIntentId:intent,text:'PRIVATE-LOCAL-QUEUE'});assert.equal(queued.result.receipt.state,'queued');
  const cancelled=await job(endpoint+'/cancel',{clientIntentId:uuid(),intentId:intent,expectedRevision:queued.result.receipt.revision});assert.equal(cancelled.result.receipt.state,'cancelled');
  const stale=await job(endpoint+'/cancel',{clientIntentId:uuid(),intentId:intent,expectedRevision:1});assert.equal(stale.state,'rejected');
  const status=await job(endpoint+'/status',{clientIntentId:uuid(),intentId:intent});assert.equal(status.result.receipts[0].state,'cancelled');
  const uncertain=uuid();await job(endpoint,{clientIntentId:uncertain,text:'PRIVATE-UNKNOWN'});
  service.inbox.claim('old-turn');service.inbox.recover();service.inbox.resolveUnknown(uncertain,service.inbox.get(uncertain).revision,'explicit test abandonment');
  const resolved=await job(endpoint+'/status',{clientIntentId:uuid(),intentId:uncertain});
  assert.equal(resolved.result.receipts[0].outcomeUncertain,true);assert.equal(resolved.result.receipts[0].resolution,'abandoned_unknown');
  assert.equal((await api('/api/conversations/foreign/queue',{clientIntentId:uuid(),text:'wrong'})).status,404);
  assert(!fs.readFileSync(path.join(dir,'server.json'),'utf8').includes('PRIVATE-LOCAL-QUEUE'));assert.equal(nativeCalls,0);
});
test('normal server disables queue HTTP/claims, and test mode cannot listen on LAN',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'queue-gate-')),origin='http://127.0.0.1:3230',password='local-test-password-longer-than-24-characters';
  const server=await createBusinessServer({origin,password,stateFile:path.join(dir,'off.json')});const port=(await server.listen(0)).port;
  const login=await fetch(`http://127.0.0.1:${port}/api/login`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'admin',password})});const cookie=login.headers.get('set-cookie').split(';')[0];
  const r=await fetch(`http://127.0.0.1:${port}/api/conversations/controller/queue`,{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({clientIntentId:'test',text:'test'})});assert.equal(r.status,403);assert.equal((await r.json()).code,'queue_protocol_disabled');
  const enabled=await createBusinessServer({origin,password,stateFile:path.join(dir,'on.json'),enableLocalQueueTest:true});
  await assert.rejects(enabled.listen(0,'0.0.0.0'),/loopback/);
  t.after(async()=>{await server.close();await enabled.close();fs.rmSync(dir,{recursive:true,force:true});});
});
