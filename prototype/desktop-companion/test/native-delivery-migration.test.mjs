import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {OwnerInbox} from '../src/inbox.mjs';
import {InboxConsumer} from '../src/consumer.mjs';
import {InboxService} from '../src/inbox-service.mjs';
import {NativeDirectInbox} from '../src/native-direct.mjs';
import {migrateNativeDelivery} from '../src/native-delivery-migration.mjs';

const threadId='01a13feb-ce80-7ca3-aa1e-17814542b353';
function fixture(t){
 const runtime=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'native-migrate-'))),inbox=new OwnerInbox({runtime,threadId});
 t.after(()=>{try{inbox.close();}catch{}fs.rmSync(runtime,{recursive:true,force:true});});
 const chat={id:threadId,projectId:'project-one',cwd:runtime,binding:'stable-binding',archived:false,workspaceAvailable:true};
 const options={checkScope:()=>({...chat}),checkNativeIdle:()=>true};
 const migrate=extra=>migrateNativeDelivery(inbox,{...options,...extra});
 const schema=()=>inbox.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
 const marker=()=>Boolean(inbox.db.prepare("SELECT 1 FROM sqlite_master WHERE name='native_delivery'").get());
 return{runtime,inbox,chat,options,migrate,schema,marker};
}
function assertCode(fn,code){assert.throws(fn,e=>e.code===code);}

test('migration atomically persists its binding and resumes idempotently',t=>{
 const f=fixture(t),first=f.migrate();assert.equal(first.state,'migrated');assert.equal(first.scope.threadId,threadId);
 const row=f.inbox.db.prepare('SELECT * FROM native_delivery').get();assert.equal(row.binding,f.chat.binding);assert.equal(row.project_id,f.chat.projectId);assert.equal(row.cwd,f.chat.cwd);
 assert.equal(f.migrate().state,'resumed');assert.deepEqual(f.inbox.db.prepare('SELECT * FROM native_delivery').get(),row);
});
for(const state of ['queued','leased','unknown'])test(`migration preserves ${state} work and does not create a fence`,t=>{
 const f=fixture(t);f.inbox.enqueue('phone-one','original body');if(state!=='queued')f.inbox.db.prepare('UPDATE jobs SET state=? WHERE intent_id=?').run(state,'phone-one');
 const row=f.inbox.get('phone-one'),schema=f.schema();assertCode(()=>f.migrate(),'native_delivery_jobs_pending');assert.deepEqual(f.inbox.get('phone-one'),row);assert.deepEqual(f.schema(),schema);assert.equal(f.marker(),false);
});
for(const state of ['active','stopping'])test(`migration never closes an ${state} consumer`,t=>{
 const f=fixture(t),consumer=new InboxConsumer(f.inbox),s=consumer.open('existing-turn',600000,20);if(state==='stopping')f.inbox.db.prepare("UPDATE consumers SET state='stopping' WHERE id=?").run(s.sessionId);
 const row=consumer.get(s.sessionId);assertCode(()=>f.migrate(),'native_delivery_consumer_active');assert.deepEqual(consumer.get(s.sessionId),row);assert.equal(f.marker(),false);
});
test('enabled standby defers migration without changing its policy',t=>{
 const f=fixture(t);f.inbox.db.exec('CREATE TABLE standby_policy(singleton INTEGER PRIMARY KEY,enabled INTEGER); INSERT INTO standby_policy VALUES(1,1)');
 assertCode(()=>f.migrate(),'native_delivery_standby_enabled');assert.equal(f.inbox.db.prepare('SELECT enabled FROM standby_policy').get().enabled,1);assert.equal(f.marker(),false);
});
test('native activity and archived scope reject before persisting a fence',t=>{
 const f=fixture(t);assertCode(()=>f.migrate({checkNativeIdle:()=>false}),'native_delivery_native_busy');assert.equal(f.marker(),false);
 f.chat.archived=true;assertCode(()=>f.migrate(),'archived_conversation_readonly');assert.equal(f.marker(),false);
});
test('explicit queued adoption preserves bodies while retaining every other drain guard',t=>{
 const f=fixture(t);f.inbox.enqueue('phone-before-idle','body waiting for original owner');const row=f.inbox.get('phone-before-idle');
 assert.equal(f.migrate({allowQueued:true}).state,'migrated');assert.deepEqual(f.inbox.get('phone-before-idle'),row);
 for(const state of ['leased','unknown']){f.inbox.db.prepare('INSERT OR REPLACE INTO native_dispatch VALUES(?,?,?,?,?)').run('phone-before-idle','native-client','prepared',null,Date.now());f.inbox.db.prepare('UPDATE jobs SET state=? WHERE intent_id=?').run(state,'phone-before-idle');assertCode(()=>f.migrate({allowQueued:true}),'native_delivery_jobs_pending');}
});
test('scope and native idle are rechecked inside the commit transaction',t=>{
 const f=fixture(t),schema=f.schema();let active=false;
 assertCode(()=>f.migrate({checkNativeIdle:()=>!active,beforeCommit:()=>{active=true;}}),'native_delivery_native_busy');assert.deepEqual(f.schema(),schema);
 active=false;assertCode(()=>f.migrate({beforeCommit:()=>{f.chat.archived=true;}}),'archived_conversation_readonly');assert.deepEqual(f.schema(),schema);
});
test('exceptions after DDL roll back tables, marker and rejection triggers',t=>{
 const f=fixture(t),schema=f.schema();assert.throws(()=>f.migrate({beforeCommit:()=>{throw Error('injected interruption');}}),/injected interruption/);assert.deepEqual(f.schema(),schema);
 const c=new InboxConsumer(f.inbox),s=c.open('still-legacy',1000,1);assert.equal(s.state,'active');
});
test('a binding change never silently rebinds, with a separate pending failure',t=>{
 const f=fixture(t);f.migrate();const row=f.inbox.db.prepare('SELECT * FROM native_delivery').get();f.chat.binding='new-binding';
 assertCode(()=>f.migrate(),'native_delivery_binding_changed');assert.deepEqual(f.inbox.db.prepare('SELECT * FROM native_delivery').get(),row);
 f.inbox.enqueue('new-phone','queued body');assertCode(()=>f.migrate(),'native_delivery_binding_changed_pending');assert.deepEqual(f.inbox.db.prepare('SELECT * FROM native_delivery').get(),row);
});
test('pre-marker native dispatch requires explicit drained adoption',t=>{
 const f=fixture(t);f.inbox.db.exec('CREATE TABLE native_dispatch(intent_id TEXT PRIMARY KEY REFERENCES jobs(intent_id),client_id TEXT NOT NULL UNIQUE,admission TEXT NOT NULL,turn_id TEXT,prepared_at INTEGER NOT NULL)');
 assertCode(()=>f.migrate(),'native_delivery_adoption_required');assert.equal(f.marker(),false);assert.equal(f.migrate({adoptExisting:true}).state,'migrated');assert.equal(f.migrate().state,'resumed');
});
test('migration fence blocks real legacy consumers and raw legacy claims',async t=>{
 const f=fixture(t),old=new InboxConsumer(f.inbox),closed=old.open('old-turn',1000,1);old.stop(closed.sessionId);f.migrate();
 assert.throws(()=>old.open('new-turn',1000,1),/inbox_native_delivery_only/);
 assert.throws(()=>f.inbox.db.prepare("UPDATE consumers SET state='active' WHERE id=?").run(closed.sessionId),/inbox_native_delivery_only/);
 const legacy=new InboxService({runtime:f.runtime,threadId});t.after(()=>legacy.stop());
 await assert.rejects(legacy.execute({threadId,operation:'inbox_listen',consumerTurnId:'bad-turn',windowMs:1000,maxJobs:1,waitMs:0}),/inbox_native_delivery_only/);
 f.inbox.enqueue('phone-now','native body');assert.throws(()=>f.inbox.claim('bad-turn'),/inbox_native_delivery_only/);assert.equal(f.inbox.get('phone-now').state,'queued');
 assert.equal(old.take(closed.sessionId,'old-turn').status,'stopped');assert.equal(f.inbox.get('phone-now').state,'queued');
});
test('native reservation remains usable after fencing all legacy consumers',async t=>{
 const f=fixture(t);f.migrate();let body;
 const q=new NativeDirectInbox({runtime:f.runtime,threadId,nativeQueue:{enqueue:j=>{body=j;return{state:'queued'};},inspect:()=>({state:'queued'})},readState:()=>({id:threadId,turns:[]}),checkAdmission:async()=>{},wake:async()=>{}});t.after(()=>q.stop());
 await q.execute({threadId,operation:'inbox_enqueue',intentId:'native-one',text:'original phone text'});await q.tick();assert.equal(body.text,'original phone text');assert.equal(q.inbox.get('native-one').state,'leased');assert.equal(q.inbox.db.prepare('SELECT count(*) n FROM native_dispatch').get().n,1);
});
test('async callbacks cannot escape the synchronous transaction guard',t=>{
 const f=fixture(t);assertCode(()=>f.migrate({checkScope:()=>Promise.resolve(f.chat)}),'native_delivery_async_scope');assertCode(()=>f.migrate({checkNativeIdle:()=>Promise.resolve(true)}),'native_delivery_async_idle');assertCode(()=>f.migrate({beforeCommit:()=>Promise.resolve()}),'native_delivery_async_commit');assert.equal(f.marker(),false);
});
