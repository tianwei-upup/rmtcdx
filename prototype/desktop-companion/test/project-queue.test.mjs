import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectQueue, ProjectQueueAdapter } from '../src/project-queue.mjs';
import { projectMcp } from '../src/project-mcp.mjs';
const chats=['a','b','archived'].map((title,i)=>({id:crypto.randomUUID(),title,archived:i===2}));
const grant={mode:'project-readonly',deviceId:'mac-project',projectId:'named-project',projectName:'RN UI',conversations:chats};
function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'project-queue-')),runtime=path.join(root,'run'),state=path.join(root,'desktop.json');
  const meta={'local-projects':{[grant.projectId]:{name:grant.projectName,rootPaths:[root]},other:{name:'same cwd',rootPaths:[root]}},'thread-project-assignments':Object.fromEntries(chats.map(c=>[c.id,{projectKind:'local',projectId:grant.projectId}]))};
  const save=()=>fs.writeFileSync(state,JSON.stringify(meta));save();let service=new ProjectQueue({runtime,grant,desktopStateFile:state});
  t.after(()=>{service.stop();fs.rmSync(root,{recursive:true,force:true});});
  return {get service(){return service;},runtime,meta,save,restart(){service.stop();service=new ProjectQueue({runtime,grant,desktopStateFile:state});return service;}};
}
test('named-project isolation, independent consumers, cancellation CAS and restart unknown without replay',async t=>{
  const f=setup(t),q=f.service,adapter=new ProjectQueueAdapter(q);await adapter.start();
  assert.equal((await adapter.execute('directory.sync',{})).directories[0].conversations.length,3);
  const send=(id,op,args={})=>q.execute({threadId:id,operation:op,...args}),[a,b,archived]=chats.map(c=>c.id);
  await assert.rejects(send('other','inbox_enqueue',{intentId:'x',text:'other cwd project'}));
  await assert.rejects(send(archived,'inbox_enqueue',{intentId:'x',text:'no archive wake'}));
  for(const id of [a,b])await send(id,'inbox_enqueue',{intentId:'same-intent',text:'read-only '+id});
  const wa=await send(a,'inbox_open',{consumerTurnId:'turn-a',windowMs:60000,maxJobs:2});
  const wb=await send(b,'inbox_open',{consumerTurnId:'turn-b',windowMs:60000,maxJobs:2});
  await assert.rejects(send(a,'inbox_open',{consumerTurnId:'second',windowMs:60000,maxJobs:2}));
  const ja=await send(a,'inbox_take',{consumerTurnId:'turn-a',sessionId:wa.sessionId}),jb=await send(b,'inbox_take',{consumerTurnId:'turn-b',sessionId:wb.sessionId});
  assert.notEqual(ja.leaseToken,jb.leaseToken);
  await assert.rejects(send(b,'inbox_complete',{intentId:'same-intent',leaseToken:ja.leaseToken,consumerTurnId:'turn-a',result:'wrong chat'}));
  await send(a,'inbox_complete',{intentId:'same-intent',leaseToken:ja.leaseToken,consumerTurnId:'turn-a',result:'answer-a'});
  const before=(await send(b,'inbox_queue_status')).receipts[0];
  await assert.rejects(send(b,'inbox_cancel',{intentId:'same-intent',expectedRevision:0}));
  await send(b,'inbox_cancel',{intentId:'same-intent',expectedRevision:before.revision});
  assert.equal((await send(b,'inbox_checkpoint',{intentId:'same-intent',leaseToken:jb.leaseToken,consumerTurnId:'turn-b'})).cancelRequested,true);
  await send(b,'inbox_ack_cancel',{intentId:'same-intent',leaseToken:jb.leaseToken,consumerTurnId:'turn-b'});
  await send(a,'inbox_enqueue',{intentId:'uncertain',text:'never replay'});
  await send(a,'inbox_take',{consumerTurnId:'turn-a',sessionId:wa.sessionId});
  const recovered=f.restart(),status=await recovered.execute({threadId:a,operation:'inbox_queue_status'});
  assert.equal(status.receipts.find(r=>r.intentId==='uncertain').state,'unknown');assert.equal(status.consumer.state,'closed');
  await assert.rejects(recovered.execute({threadId:a,operation:'inbox_open',consumerTurnId:'new-turn',windowMs:60000,maxJobs:1}));
  f.meta['thread-project-assignments'][b].projectId='other';f.save();
  await assert.rejects(recovered.execute({threadId:b,operation:'inbox_queue_status'}));
  assert(!recovered.catalog().some(c=>c.id===b));
});
test('MCP exposes only caller-bound queue tools and validates real turn metadata',async t=>{
  const f=setup(t),calls=[],server=projectMcp({runtime:f.runtime,grant,call:async(_runtime,request)=>{calls.push(request);return f.service.execute(request);}}),client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});
  const tools=(await client.listTools()).tools;assert.equal(tools.length,10);assert(!tools.some(t=>/send|native|snapshot/.test(t.name)));
  const ask=(name,args,threadId=chats[0].id,turnId='real-turn')=>client.callTool({name,arguments:args,_meta:{'x-codex-turn-metadata':{thread_id:threadId,turn_id:turnId}}});
  assert.equal((await ask('rmt_queue_status',{},'foreign')).isError,true);
  assert.equal((await ask('rmt_queue_open',{},chats[0].id,'')).isError,true);assert.equal(calls.length,0);
  const opened=await ask('rmt_queue_open',{windowMs:30000,maxJobs:1});assert(opened.structuredContent.sessionId);
  const hijack=await ask('rmt_queue_take',{sessionId:opened.structuredContent.sessionId,waitMs:0},chats[1].id);assert.equal(hijack.isError,true);
  assert.equal((await ask('rmt_queue_open',{threadId:chats[1].id})).isError,true);
  assert.equal((await ask('rmt_queue_close',{sessionId:opened.structuredContent.sessionId})).structuredContent.state,'closed');
});
test('combined listen/reply streams genuine partial text and honors cancellation without a second model checkpoint',async t=>{
 const f=setup(t),q=f.service,id=chats[0].id,turn='real-turn';
 await q.execute({operation:'inbox_enqueue',threadId:id,intentId:'stream',text:'context-only answer'});
 const first=await q.execute({operation:'inbox_listen',threadId:id,consumerTurnId:turn,windowMs:60000,maxJobs:2,waitMs:0});
 assert.equal(first.status,'job');
 const args={threadId:id,intentId:first.intentId,leaseToken:first.leaseToken,consumerTurnId:turn};
 const partial=await q.execute({...args,operation:'inbox_progress',seq:1,text:'First public paragraph.'});
 assert.equal(partial.progress.seq,1);assert(partial.timing.firstProgressAt>=partial.timing.leasedAt);
 assert.equal((await q.execute({...args,operation:'inbox_progress',seq:1,text:'First public paragraph.'})).progress.seq,1);
 await assert.rejects(q.execute({...args,operation:'inbox_progress',seq:1,text:'conflicting retry'}));
 const cancelled=await q.execute({operation:'inbox_cancel',threadId:id,intentId:first.intentId,expectedRevision:partial.revision});
 assert(cancelled.cancelRequested);
 await q.execute({operation:'inbox_enqueue',threadId:id,intentId:'next',text:'second context answer'});
 const reply=await q.execute({...args,operation:'inbox_reply',sessionId:first.sessionId,result:'must not publish after cancel',waitMs:0});
 assert.equal(reply.receipt.state,'cancelled');assert.equal(reply.receipt.result,undefined);assert.equal(reply.next.intentId,'next');
 const done=await q.execute({operation:'inbox_reply',threadId:id,consumerTurnId:turn,sessionId:first.sessionId,intentId:'next',leaseToken:reply.next.leaseToken,result:'ok',waitMs:0});
 assert.equal(done.receipt.state,'completed');assert.equal(done.next.status,'stopped');assert.equal(done.next.session.state,'closed');
});
test('socket cancellation closes an empty wait before a later message can be claimed',async t=>{
 const {serveLocal}=await import('../src/local-server.mjs'),{control}=await import('../src/control.mjs');
 const f=setup(t),id=chats[0].id,turn='socket-turn',close=await serveLocal(f.runtime,f.service,()=>{});t.after(close);
 const session=await control(f.runtime,{operation:'inbox_open',threadId:id,consumerTurnId:turn,windowMs:60000,maxJobs:2});
 const abort=new AbortController(),pending=control(f.runtime,{operation:'inbox_take',threadId:id,consumerTurnId:turn,sessionId:session.sessionId,waitMs:20000},30000,{signal:abort.signal});
 setTimeout(()=>abort.abort(),20);await assert.rejects(pending,{code:'inbox_wait_cancelled'});
 await new Promise(r=>setTimeout(r,150));await control(f.runtime,{operation:'inbox_enqueue',threadId:id,intentId:'after-disconnect',text:'must stay queued'});
 const value=await control(f.runtime,{operation:'inbox_queue_status',threadId:id});assert.equal(value.consumer.state,'closed');assert.equal(value.receipts[0].state,'queued');
});
test('standby tools require explicit per-chat opt-in and retain native metadata binding',async t=>{
 const f=setup(t),calls=[],server=projectMcp({runtime:f.runtime,grant,standby:{threadIds:[chats[0].id]},call:async(_runtime,request)=>{calls.push(request);return {status:'stopped'};}}),client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});
 const registered=(await client.listTools()).tools;assert.equal(registered.length,13);
 for(const name of ['rmt_queue_standby_enable','rmt_queue_standby_resume','rmt_queue_reply']){
   const wait=registered.find(t=>t.name===name).inputSchema.properties.waitMs;
   assert.equal(wait.default,600000);assert.equal(wait.maximum,600000);
 }
 assert.equal(registered.find(t=>t.name==='rmt_queue_listen').inputSchema.properties.waitMs.default,25000);
 const ask=id=>client.callTool({name:'rmt_queue_standby_enable',arguments:{waitMs:0},_meta:{'x-codex-turn-metadata':{thread_id:id,turn_id:'actual-turn'}}});
 assert.equal((await ask(chats[1].id)).isError,true);assert.equal(calls.length,0);
 assert.equal((await ask(chats[0].id)).isError,undefined);assert.equal(calls[0].consumerTurnId,'actual-turn');
});

test('desktop execution policy is local, reloadable and retains exact caller fences',async t=>{
 const f=setup(t);let mode='readonly',calls=0;
 const server=projectMcp({runtime:f.runtime,grant,getExecutionMode:()=>mode,call:async()=>{calls++;return {ready:true};}}),client=new Client({name:'policy-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);t.after(async()=>{await client.close();await server.close();});
 const ask=()=>client.callTool({name:'rmt_queue_status',arguments:{},_meta:{'x-codex-turn-metadata':{thread_id:chats[0].id,turn_id:'actual-turn'}}});
 assert.equal((await ask()).structuredContent.executionMode,'readonly');mode='desktop';
 const value=(await ask()).structuredContent;assert.equal(value.executionMode,'desktop');assert.match(value.handlingInstructions,/改代码和执行命令/);assert.match(value.handlingInstructions,/每个有副作用的步骤前/);
 mode='anything';assert.equal((await ask()).isError,true);assert.equal(calls,2);
});
