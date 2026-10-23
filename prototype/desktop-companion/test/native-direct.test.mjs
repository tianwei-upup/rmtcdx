import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {NativeDirectInbox} from '../src/native-direct.mjs';
const id='01a13feb-ce80-7ca3-aa1e-17814542b353';
function fixture(t,{threadId=id,checkScope}={}){
 const id=threadId;
 const runtime=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'native-direct-')));t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
 const native=new Map(),calls=[];let turns=[];
 const options={runtime,threadId:id,checkScope,nativeQueue:{enqueue:job=>{calls.push(job);native.set(job.intentId,job);return{state:'queued'};},inspect:client=>({state:native.has(client)?'queued':'accepted'})},readState:()=>({id,cwd:runtime,turns,turnsPagination:{hasMore:false}}),checkAdmission:async()=>{},wake:async()=>{}};
 const make=()=>new NativeDirectInbox(options),q=make();t.after(()=>{if(!q.stopped)q.stop();});
 const enqueue=(intentId='phone-1',text='actual user body')=>q.execute({operation:'inbox_enqueue',threadId:id,intentId,text});
 const observe=(clientId,{turnId='turn-1',status='inProgress',text='first paragraph',complete=false}={})=>{turns=[{turnId,status,completionObserved:complete,items:[{type:'userMessage',id:'u',clientId,content:[{type:'text',text:'actual user body'}]},{type:'agentMessage',id:'a',text,phase:status==='completed'?'final_answer':'commentary'}]}];};
 return{q,make,enqueue,observe,calls,native,options};
}
test('direct body is admitted once, linked by client ID, and completion follows native evidence',async t=>{
 const {q,enqueue,observe,calls}=fixture(t);await enqueue();await q.tick();assert.equal(calls.length,1);assert.equal(calls[0].text,'actual user body');
 await enqueue();await q.tick();assert.equal(calls.length,1);assert.equal(q.inbox.get('phone-1').state,'leased');
 observe('different-client',{status:'completed',complete:true});await q.tick();assert.equal(q.inbox.get('phone-1').state,'leased');
 observe(calls[0].intentId);await q.tick();let r=q.inbox.receipt(q.inbox.get('phone-1'));assert.equal(r.consumerTurnId,'turn-1');assert.equal(r.progress.text,'first paragraph');assert.equal(r.state,'leased');
 observe(calls[0].intentId,{status:'completed',text:'native final reply',complete:false});await q.tick();assert.equal(q.inbox.get('phone-1').state,'leased');
 observe(calls[0].intentId,{status:'completed',text:'native final reply',complete:true});await q.tick();r=q.inbox.receipt(q.inbox.get('phone-1'));assert.equal(r.state,'completed');assert.equal(r.result,'native final reply');
 await enqueue();await q.tick();assert.equal(calls.length,1);await assert.rejects(enqueue('phone-1','conflicting text'),/inbox_intent_conflict/);
});
test('worker restart reconciles the original client ID without replaying an accepted body',async t=>{
 const {q,make,enqueue,observe,calls}=fixture(t);await enqueue();await q.tick();const client=calls[0].intentId;q.stop();const next=make();t.after(()=>next.stop());
 assert.equal(next.inbox.get('phone-1').state,'leased');await next.tick();assert.equal(calls.length,1);observe(client,{status:'completed',complete:true,text:'recovered'});await next.tick();assert.equal(next.inbox.get('phone-1').result,'recovered');
});
test('uncertain native admission blocks following work and never replays',async t=>{
 const {q,enqueue,calls,options}=fixture(t);options.nativeQueue.enqueue=job=>{calls.push(job);return{state:'unknown'};};options.nativeQueue.inspect=()=>({state:'unknown'});
 await enqueue();await q.tick();await enqueue('phone-2');await q.tick();assert.equal(calls.length,1);assert.equal(q.inbox.get('phone-1').state,'unknown');assert.equal(q.inbox.get('phone-2').state,'queued');
});
test('cancel only succeeds before native reservation; queued work preserves order',async t=>{
 const {q,enqueue,observe,calls}=fixture(t);await enqueue();await enqueue('phone-2','second body');await q.tick();
 await assert.rejects(q.execute({threadId:id,operation:'inbox_cancel',intentId:'phone-1',expectedRevision:2}),/inbox_native_cancel_unavailable/);
 await q.execute({threadId:id,operation:'inbox_cancel',intentId:'phone-2',expectedRevision:1});assert.equal(q.inbox.get('phone-2').state,'cancelled');
 observe(calls[0].intentId,{status:'completed',complete:true});await q.tick();assert.equal(calls.length,1);
});
test('direct mode rejects MCP consumption and other thread identities',async t=>{
 const {q}=fixture(t);await assert.rejects(q.execute({operation:'inbox_listen',threadId:id}),/inbox_native_delivery_only/);
 await assert.rejects(q.execute({operation:'inbox_enqueue',threadId:'other',intentId:'a',text:'wrong'}),/queue_scope_rejected/);
});
test('a native turn whose user is still in params is correlated before item persistence',async t=>{
 const {q,enqueue,calls,options}=fixture(t);await enqueue();await q.tick();options.readState=()=>({id,turns:[{turnId:'early-turn',status:'inProgress',params:{clientUserMessageId:calls[0].intentId},items:[{type:'agentMessage',id:'a',text:'real live delta'}]}]});q.readState=options.readState;
 await q.tick();assert.equal(q.inbox.get('phone-1').consumer_turn,'early-turn');assert.equal(q.inbox.receipt(q.inbox.get('phone-1')).progress.text,'real live delta');
});
test('legacy recovery cannot take over a pending direct dispatch',async t=>{
 const {q,enqueue}=fixture(t);await enqueue();await q.tick();assert.throws(()=>q.inbox.recover(),/inbox_native_delivery_required/);assert.equal(q.inbox.get('phone-1').state,'leased');
});
test('failed native turns remain uncertain and do not release later work',async t=>{
 const {q,enqueue,observe,calls}=fixture(t);await enqueue();await enqueue('phone-2');await q.tick();observe(calls[0].intentId,{status:'interrupted',complete:true});await q.tick();assert.equal(q.inbox.get('phone-1').state,'unknown');await q.tick();assert.equal(calls.length,1);
});
test('the UTF-8 native queue limit rejects before reserving a phone message',async t=>{
 const {q,enqueue,calls}=fixture(t);await assert.rejects(enqueue('large','中'.repeat(12000)),/invalid_inbox_job/);assert.equal(q.inbox.receipts().length,0);assert.equal(calls.length,0);
});
test('unknown notification and repeated ticks never replay an admitted body or claim completion',async t=>{
 const {q,enqueue,calls}=fixture(t);let notifications=0;
 q.wake=async()=>{notifications++;return{state:'notification_unknown'};};
 await enqueue();await q.tick();await enqueue();await q.tick();await q.tick();
 assert.equal(calls.length,1);assert.equal(notifications,1);assert.equal(q.inbox.get('phone-1').state,'leased');
 assert.equal(q.inbox.db.prepare("SELECT reason FROM audit WHERE event='native.wake'").get().reason,'notification_unknown');
});
test('notification failure after insertion recovers by receipt without another native append',async t=>{
 const {q,enqueue,calls}=fixture(t);let notifications=0;
 q.wake=async()=>{if(++notifications===1)throw Error('build guard rejected wake');};
 await enqueue();await assert.rejects(q.tick(),/build guard rejected wake/);await q.tick();
 assert.equal(calls.length,1);assert.equal(notifications,2);assert.equal(q.inbox.get('phone-1').state,'leased');
});
test('crash after real atomic insertion reconciles a consumed native receipt without inserting twice',async t=>{
 const {q,make,enqueue,observe,options}=fixture(t),{DatabaseSync}=await import('node:sqlite'),{NativeHistoryQueue}=await import('../src/native-history-queue.mjs');
 const schema=JSON.parse(fs.readFileSync(new URL('./fixtures/native-queue-schema.json',import.meta.url))),database=path.join(options.runtime,'queue_1.sqlite'),db=new DatabaseSync(database);t.after(()=>db.close());for(const row of schema.objects)if(row.sql)db.exec(row.sql);for(const row of schema.migrations)db.prepare('INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(?,?,1,?,0)').run(row.version,row.description,Buffer.from(row.checksum,'hex'));
 const native=new NativeHistoryQueue({database,runtime:path.join(options.runtime,'receipts'),conversationId:id,enabled:true});let fail=true;
 options.nativeQueue={enqueue:job=>{const v=native.enqueue(job);if(fail){fail=false;throw Error('process_died_after_insert');}return v;},inspect:client=>native.inspect(client)};q.nativeQueue=options.nativeQueue;
 await enqueue();await assert.rejects(q.tick(),/process_died_after_insert/);const row=db.prepare('SELECT * FROM queued_items').get(),payload=JSON.parse(row.payload_json);assert.equal(payload.UserInput.content[0].text,'actual user body');const client=payload.UserInput.client_id;
 db.prepare('DELETE FROM queued_items WHERE id=?').run(client);q.stop();const next=make();t.after(()=>next.stop());await next.tick();assert.equal(db.prepare('SELECT count(*) n FROM queued_items').get().n,0);assert.equal(native.inspect(client).state,'accepted');observe(client,{status:'completed',complete:true,text:'once'});await next.tick();assert.equal(next.inbox.get('phone-1').result,'once');
});
test('other threads require an explicit local scope and retain body deduplication',async t=>{
 const {options}=fixture(t);assert.throws(()=>new NativeDirectInbox({...options,threadId:'other'}),/native_direct_scope_required/);
 const checks=[],other=fixture(t,{threadId:'other',checkScope:(threadId,o)=>{assert.equal(threadId,'other');checks.push(o.write);}});
 await other.enqueue();await other.q.tick();await other.enqueue();await other.q.tick();assert.equal(other.calls.length,1);assert(checks.includes(true));assert(checks.includes(false));
 other.observe(other.calls[0].intentId,{status:'completed',complete:true,text:'same original context'});await other.q.tick();assert.equal(other.q.inbox.get('phone-1').result,'same original context');
});
test('live archive checks block local reservation and native effects, then preserve its original client ID on restore',async t=>{
 let archived=false,admissions=0;const f=fixture(t,{threadId:'historical',checkScope:(_,{write})=>{if(write&&archived)throw Error('archived_conversation_readonly');}});
 archived=true;await assert.rejects(f.enqueue(),/archived_conversation_readonly/);assert.equal(f.q.inbox.receipts().length,0);
 archived=false;await f.enqueue();archived=true;await assert.rejects(f.q.tick(),/archived_conversation_readonly/);assert.equal(f.calls.length,0);assert.equal(f.q.inbox.get('phone-1').state,'queued');
 archived=false;f.q.checkAdmission=async()=>{if(++admissions===2)archived=true;};await assert.rejects(f.q.tick(),/archived_conversation_readonly/);assert.equal(f.calls.length,0);const prepared=f.q.inbox.db.prepare('SELECT client_id FROM native_dispatch').get();assert(prepared);
 archived=false;await f.q.tick();assert.equal(f.calls.length,1);assert.equal(f.calls[0].intentId,prepared.client_id);
 archived=true;f.observe(prepared.client_id,{status:'completed',complete:true});await f.q.tick();assert.equal(f.q.inbox.get('phone-1').state,'completed');assert.equal(f.calls.length,1);
});
test('a busy original native owner does not block atomic admission or create a second executor',async t=>{
 const f=fixture(t,{threadId:'busy-history',checkScope:()=>{}});f.q.readState=()=>({id:'busy-history',turns:[{turnId:'desktop-active',status:'inProgress',items:[]}],turnsPagination:{hasMore:false}});
 await f.enqueue();await f.q.tick();assert.equal(f.calls.length,1);assert.equal(f.q.inbox.get('phone-1').state,'leased');assert.equal(f.q.inbox.get('phone-1').consumer_turn,null);await f.q.tick();assert.equal(f.calls.length,1);
});
