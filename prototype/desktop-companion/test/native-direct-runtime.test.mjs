import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {EventEmitter} from 'node:events';
import {PersonalScope} from '../src/personal-scope.mjs';
import {NativeDirectRuntime,directScope,directLinks} from '../src/native-direct-runtime.mjs';
import {wakeNativeQueue} from '../src/native-queue-wake.mjs';
function fixture(t,{dynamic=false}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'native-direct-scope-'))),id='historical-chat',metadataDatabase=path.join(root,'state_5.sqlite'),desktopStateFile=path.join(root,'desktop.json'),runtime=path.join(root,'run'),db=new DatabaseSync(metadataDatabase);t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 fs.mkdirSync(path.join(root,'sessions'));const rollout=path.join(root,'sessions','history.jsonl');fs.writeFileSync(rollout,JSON.stringify({type:'session_meta',payload:{id}})+'\n');
 db.exec('CREATE TABLE threads(id TEXT,cwd TEXT,archived INTEGER,rollout_path TEXT,title TEXT)');db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(id,root,0,rollout,'History');
 const state={'local-projects':{p:{name:'P',rootPaths:[root]},q:{name:'same cwd',rootPaths:[root]}},'thread-project-assignments':{[id]:{projectKind:'local',projectId:'p'}}};fs.writeFileSync(desktopStateFile,JSON.stringify(state));
 const scope=new PersonalScope({manifest:{version:1,enabled:true,...(dynamic?{discovery:'local-projects'}:{}),runtime,projects:[{id:'p'},{id:'q'}],chats:[{id,cwd:root,projectId:'p'}]},metadataDatabase,desktopStateFile});
 const queueDatabase=path.join(root,'queue_1.sqlite'),native=new DatabaseSync(queueDatabase),schema=JSON.parse(fs.readFileSync(new URL('./fixtures/native-queue-schema.json',import.meta.url)));for(const row of schema.objects)if(row.sql)native.exec(row.sql);for(const row of schema.migrations)native.prepare('INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(?,?,1,?,0)').run(row.version,row.description,Buffer.from(row.checksum,'hex'));native.close();
 return{root,id,db,scope,runtime,metadataDatabase,desktopStateFile,state,queueDatabase,config:{enabled:true,conversationId:id,scope}};
}
test('native direct scope is an exact local membership adapter, not a phone-supplied authorization',t=>{
 const f=fixture(t);assert.throws(()=>directScope({...f.config,scope:{check:()=>({})}}),/native_direct_scope_required/);assert.throws(()=>directScope({...f.config,scope:undefined,metadataDatabase:f.metadataDatabase}),/native_direct_acceptance_only/);assert.throws(()=>directScope({...f.config,enabled:false}),/native_direct_scope_required/);
 const s=directScope(f.config);assert.equal(s.check(f.id).cwd,f.root);assert.throws(()=>s.check('another'),/native_direct_scope_rejected/);
 f.db.exec('UPDATE threads SET archived=1');assert.equal(s.check(f.id).archived,true);assert.throws(()=>s.check(f.id,{write:true}),/archived_conversation_readonly/);assert.throws(()=>new NativeDirectRuntime(f.config),/archived_conversation_readonly/);
 f.db.exec('UPDATE threads SET archived=0');f.state['thread-project-assignments'][f.id].projectId='q';fs.writeFileSync(f.desktopStateFile,JSON.stringify(f.state));assert.throws(()=>s.check(f.id),/personal_membership_changed/);
});
test('unloaded original history can atomically accept its body and stopping its observer preserves the Inbox lease',async t=>{
 const f=fixture(t),events=[],streams=[];const runtime=new NativeDirectRuntime(f.config,{checkRuntime:async()=>events.push('runtime'),verifyBuild:()=>events.push('build'),wakeQueue:async options=>{assert.equal(options.personalScope,f.scope);options.checkScope(f.id,{write:true});events.push('wake');return{state:'notification_dispatched'};},streamFactory:options=>{assert.equal(options.expectedCwd,f.root);const s=new EventEmitter();s.start=async()=>{};s.close=()=>{s.closed=true;};streams.push(s);return s;}});
 const q=runtime.createInbox({runtime:path.join(f.runtime,f.id),threadId:f.id});t.after(async()=>{await runtime.stop();q.stop();});assert.equal(runtime.readState().id,f.id);assert.equal(runtime.stream,undefined);
 await q.execute({operation:'inbox_enqueue',threadId:f.id,intentId:'phone-body',text:'only the original body'});await q.tick();assert.equal(q.inbox.get('phone-body').state,'leased');assert(events.includes('wake'));assert.equal(streams.length,1);
 const db=new DatabaseSync(f.queueDatabase,{readOnly:true});try{const row=db.prepare('SELECT * FROM queued_items').get();assert.equal(row.thread_id,f.id);assert.equal(JSON.parse(row.payload_json).UserInput.content[0].text,'only the original body');assert.equal(runtime.nativeLinks().get(row.id).intentId,'phone-body');assert.equal(directLinks({conversationId:f.id,queueRuntime:f.runtime,personalScope:f.scope}).get(row.id).intentId,'phone-body');}finally{db.close();}
 await runtime.stop();assert(streams[0].closed);assert.equal(q.stopped,false);assert.equal(q.inbox.get('phone-body').state,'leased');assert.equal(runtime.nativeLinks().size,1);
});
test('native links require the exact authorized route while archived links remain readable',async t=>{
 const f=fixture(t),runtime=new NativeDirectRuntime(f.config),q=runtime.createInbox({runtime:path.join(f.runtime,f.id),threadId:f.id});t.after(async()=>{await runtime.stop();q.stop();});
 assert.throws(()=>directLinks({conversationId:f.id,queueRuntime:f.runtime}),/native_direct_scope_required/);assert.throws(()=>directLinks({conversationId:f.id,queueRuntime:f.root,personalScope:f.scope}),/native_direct_scope_rejected/);assert.equal(directLinks({conversationId:f.id,queueRuntime:f.runtime,personalScope:f.scope}).size,0);
 f.db.exec('UPDATE threads SET archived=1');assert.equal(directLinks({conversationId:f.id,queueRuntime:f.runtime,personalScope:f.scope}).size,0);assert.equal(runtime.nativeLinks().size,0);await assert.rejects(q.execute({operation:'inbox_enqueue',threadId:f.id,intentId:'archived',text:'blocked'}),/archived_conversation_readonly/);
});
test('personal queue wake rechecks native archive and membership after asynchronous runtime checks',async t=>{
 const f=fixture(t),calls=[],options={conversationId:f.id,personalScope:f.scope,checkScope:id=>{assert.equal(id,f.id);calls.push('scope');},checkRuntime:async()=>calls.push('runtime'),verifyBuild:()=>calls.push('build'),run:async(...args)=>calls.push(args)};
 assert.equal((await wakeNativeQueue(options)).state,'notification_dispatched');assert.equal(calls.filter(Array.isArray).length,1);assert.equal(calls.at(-1)[1].at(-1),'codex://threads/wake/'+f.id);
 calls.length=0;options.checkRuntime=async()=>{f.db.exec('UPDATE threads SET archived=1');};await assert.rejects(wakeNativeQueue(options),/archived_conversation_readonly/);assert.equal(calls.some(Array.isArray),false);
 f.db.exec('UPDATE threads SET archived=0');options.checkRuntime=async()=>{f.state['thread-project-assignments'][f.id].projectId='q';fs.writeFileSync(f.desktopStateFile,JSON.stringify(f.state));};await assert.rejects(wakeNativeQueue(options),/personal_membership_changed/);assert.equal(calls.some(Array.isArray),false);
});
test('dynamic discovery cannot retarget an existing runtime or an in-flight wake to a different project',async t=>{
 const f=fixture(t,{dynamic:true}),scope=directScope(f.config),calls=[];
 const move=()=>{f.state['thread-project-assignments'][f.id].projectId='q';fs.writeFileSync(f.desktopStateFile,JSON.stringify(f.state));};
 await assert.rejects(wakeNativeQueue({conversationId:f.id,personalScope:f.scope,checkScope:()=>{},checkRuntime:async()=>move(),verifyBuild:()=>{},run:async()=>calls.push('open')}),/native_direct_scope_changed/);
 assert.equal(f.scope.check(f.id,{write:true}).projectId,'q');assert.throws(()=>scope.check(f.id,{write:true}),/native_direct_scope_changed/);assert.equal(calls.length,0);
});
