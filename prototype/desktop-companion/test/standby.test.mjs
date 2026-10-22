import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { InboxService } from '../src/inbox-service.mjs';
import { standbyHook } from '../src/standby.mjs';

function fixture(t,{projectLayout=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'queue-standby-')),runtime=projectLayout?path.join(root,'chat'):root;let service;
 const start=()=>service=new InboxService({runtime,threadId:'chat',standby:{windowMs:1000,maxJobs:1}});
 start();t.after(()=>{service.stop();fs.rmSync(root,{recursive:true,force:true});});
 return {runtime,get service(){return service;},restart(){service.stop();start();},call(operation,args={}){return service.execute({operation,threadId:'chat',consumerTurnId:'original-turn',waitMs:0,...args});}};
}
test('one enable spans bounded segments and worker recovery in the same native turn',async t=>{
 const f=fixture(t);await f.call('inbox_enqueue',{intentId:'one',text:'one'});await f.call('inbox_enqueue',{intentId:'two',text:'two'});
 const first=await f.call('inbox_standby_enable');assert.equal(first.status,'job');
 const reply=await f.call('inbox_reply',{sessionId:first.sessionId,intentId:first.intentId,leaseToken:first.leaseToken,result:'first'});
 assert.equal(reply.next.status,'job');assert.notEqual(reply.next.sessionId,first.sessionId);
 await f.call('inbox_reply',{sessionId:reply.next.sessionId,intentId:reply.next.intentId,leaseToken:reply.next.leaseToken,result:'second',takeNext:false});
 f.restart();const restored=await f.call('inbox_standby_resume');assert.equal(restored.status,'empty');
 assert.equal(f.service.status().standby.enabled,true);
 assert.equal(f.service.inbox.db.prepare("SELECT count(*) AS n FROM audit WHERE event='standby.enabled'").get().n,1);
 await assert.rejects(f.call('inbox_standby_resume',{consumerTurnId:'other-turn'}),{code:'standby_turn_mismatch'});
 await f.call('inbox_consumer_stop',{sessionId:restored.sessionId});assert.equal(f.service.status().standby.enabled,false);
 assert.deepEqual(standbyHook(f.service.inbox,{session_id:'chat',turn_id:'original-turn',hook_event_name:'Stop'}),{});
});
test('Stop continues only its authorized turn; interrupt pauses and fences an unfinished lease',async t=>{
 const f=fixture(t);await f.call('inbox_standby_enable');
 const input={session_id:'chat',turn_id:'original-turn',hook_event_name:'Stop'};
 assert.equal(standbyHook(f.service.inbox,input).decision,'block');
 assert.deepEqual(standbyHook(f.service.inbox,{...input,turn_id:'foreign-turn'}),{});
 assert.deepEqual(standbyHook(f.service.inbox,{...input,session_id:'foreign-chat'}),{});
 await f.call('inbox_enqueue',{intentId:'held',text:'never replay'});await f.call('inbox_standby_resume');
 standbyHook(f.service.inbox,{...input,hook_event_name:'Interrupt'});
 assert.equal(f.service.inbox.get('held').state,'unknown');assert.equal(f.service.status().standby.enabled,false);
 assert.deepEqual(standbyHook(f.service.inbox,input),{});
});
test('uncertain recovery blocks continuation and does not replay or claim the next job',async t=>{
 const f=fixture(t);await f.call('inbox_enqueue',{intentId:'held',text:'unfinished'});await f.call('inbox_enqueue',{intentId:'next',text:'must stay queued'});
 await f.call('inbox_standby_enable');f.restart();
 const r=await f.call('inbox_standby_resume');assert.equal(r.status,'blocked');assert.equal(r.state,'unknown');
 assert.equal(f.service.inbox.get('next').state,'queued');
 assert.deepEqual(standbyHook(f.service.inbox,{session_id:'chat',turn_id:'original-turn',hook_event_name:'Stop'}),{});
});
test('a mode without opt-in has no enabling operation',async t=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'queue-bounded-')),service=new InboxService({runtime,threadId:'chat'});
 t.after(()=>{service.stop();fs.rmSync(runtime,{recursive:true,force:true});});
 await assert.rejects(service.execute({operation:'inbox_standby_enable',threadId:'chat',consumerTurnId:'turn'}),{code:'standby_not_enabled_for_scope'});
 assert.equal(service.status().standby,undefined);
});
test('an empty wait crosses the segment deadline without a second enable or external wake',async t=>{
 const f=fixture(t),opened=await f.call('inbox_standby_enable');
 const waiting=f.call('inbox_take',{sessionId:opened.sessionId,waitMs:1800});
 const timer=setTimeout(()=>void f.call('inbox_enqueue',{intentId:'after-deadline',text:'late read-only message'}),1150);t.after(()=>clearTimeout(timer));
 const next=await waiting;assert.equal(next.status,'job');assert.notEqual(next.sessionId,opened.sessionId);
 assert.equal(f.service.consumer.get(opened.sessionId).state,'closed');assert.equal(f.service.status().standby.enabled,true);
});
test('an explicit pause wins over renewal and remains paused after worker recovery',async t=>{
 const f=fixture(t),opened=await f.call('inbox_standby_enable');
 await f.call('inbox_enqueue',{intentId:'later',text:'must remain queued'});
 await f.call('inbox_standby_pause');
 assert.throws(()=>f.service.standby.bind(opened.sessionId,'original-turn'),{code:'standby_paused'});
 f.restart();const next=await f.call('inbox_standby_resume');
 assert.equal(next.status,'stopped');assert.equal(next.continuePolling,false);
 assert.equal(f.service.inbox.get('later').state,'queued');
 assert.equal(f.service.status().consumer.state,'closed');
});
test('normal Stop with an unfinished lease fences it and leaves the next message queued',async t=>{
 const f=fixture(t);await f.call('inbox_enqueue',{intentId:'held',text:'unfinished'});await f.call('inbox_enqueue',{intentId:'next',text:'keep queued'});
 await f.call('inbox_standby_enable');
 assert.deepEqual(standbyHook(f.service.inbox,{session_id:'chat',turn_id:'original-turn',hook_event_name:'Stop'}),{});
 assert.equal(f.service.inbox.get('held').state,'unknown');assert.equal(f.service.inbox.get('next').state,'queued');
 assert.equal(f.service.status().standby.enabled,false);assert.equal(f.service.status().consumer.state,'closed');
});
test('repeated normal-stop recovery failure pauses and closes the consumer instead of looping forever',async t=>{
 const f=fixture(t);await f.call('inbox_standby_enable');
 const input={session_id:'chat',turn_id:'original-turn',hook_event_name:'Stop'};
 for(let i=0;i<6;i++)assert.equal(standbyHook(f.service.inbox,input).decision,'block');
 assert.deepEqual(standbyHook(f.service.inbox,input),{});
 assert.equal(f.service.status().standby.enabled,false);assert.equal(f.service.status().consumer.state,'closed');
 assert.equal(f.service.status().standby.reason,'continuation_retry_limit');
});
test('a phone stop across automatic renewal pauses the same enablement but cannot stop a later one',async t=>{
 const f=fixture(t);await f.call('inbox_enqueue',{intentId:'first',text:'first'});
 const first=await f.call('inbox_standby_enable');
 const replied=await f.call('inbox_reply',{sessionId:first.sessionId,intentId:first.intentId,leaseToken:first.leaseToken,result:'done'});
 assert.notEqual(replied.next.sessionId,first.sessionId);
 const stop=await f.call('inbox_consumer_stop',{sessionId:first.sessionId});
 assert.equal(stop.sessionId,replied.next.sessionId);assert.equal(stop.state,'closed');assert.equal(f.service.status().standby.enabled,false);
 const next=await f.call('inbox_standby_enable');
 await f.call('inbox_consumer_stop',{sessionId:first.sessionId});
 assert.equal(f.service.status().standby.enabled,true);assert.equal(f.service.status().consumer.sessionId,next.sessionId);
 assert.equal(f.service.status().consumer.state,'active');
});
test('project Hook rechecks membership before continuing even when another named project shares the directory',async t=>{
 const f=fixture(t,{projectLayout:true});await f.call('inbox_standby_enable');
 const desktopStateFile=path.join(f.runtime,'desktop.json'),configFile=path.join(f.runtime,'config.json');
 const state={'local-projects':{p:{name:'RN UI',rootPaths:[f.runtime]},other:{name:'other',rootPaths:[f.runtime]}},'thread-project-assignments':{chat:{projectKind:'local',projectId:'p'}}};
 const save=()=>fs.writeFileSync(desktopStateFile,JSON.stringify(state));save();
 fs.writeFileSync(configFile,JSON.stringify({runtime:path.dirname(f.runtime),desktopStateFile,grant:{mode:'project-readonly',projectId:'p',projectName:'RN UI',conversations:[{id:'chat',archived:false}]},standby:{threadIds:['chat']}}),{mode:0o600});
 const run=()=>JSON.parse(execFileSync(process.execPath,[new URL('../../../scripts/queue-standby-hook.mjs',import.meta.url).pathname,configFile],{input:JSON.stringify({session_id:'chat',turn_id:'original-turn',hook_event_name:'Stop'}),encoding:'utf8',stdio:['pipe','pipe','pipe']}));
 assert.equal(run().decision,'block');
 state['thread-project-assignments'].chat.projectId='other';save();
 assert.deepEqual(run(),{});assert.equal(f.service.inbox.db.prepare("SELECT count(*) AS n FROM audit WHERE event='standby.continued'").get().n,1);
});
test('a long standby wait aborts promptly and cannot claim a later task until the same turn resumes',async t=>{
 const f=fixture(t),abort=new AbortController(),start=Date.now();
 const pending=f.call('inbox_standby_enable',{waitMs:600000,signal:abort.signal});
 setTimeout(()=>abort.abort(),20);await assert.rejects(pending,{code:'inbox_wait_cancelled'});
 assert(Date.now()-start<1000);assert.equal(f.service.status().consumer.state,'closed');
 await f.call('inbox_enqueue',{intentId:'after-abort',text:'retain until actual resume'});
 assert.equal(f.service.inbox.get('after-abort').state,'queued');
 const next=await f.call('inbox_standby_resume');assert.equal(next.intentId,'after-abort');
});

test('trusted Stop continuation follows desktop permissions only when explicitly configured',async t=>{
 const f=fixture(t);await f.call('inbox_standby_enable');const input={session_id:'chat',turn_id:'original-turn',hook_event_name:'Stop'};
 assert.match(standbyHook(f.service.inbox,input).reason,/仅只读文本问答/);
 const desktop=standbyHook(f.service.inbox,input,{executionMode:'desktop'});assert.equal(desktop.decision,'block');assert.match(desktop.reason,/改代码和执行命令/);assert.match(desktop.reason,/遵守桌面现有沙箱/);assert.doesNotMatch(desktop.reason,/不要运行其他工具/);
});
