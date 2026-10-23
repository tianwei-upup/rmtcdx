import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {NativeDirectInbox} from './native-direct.mjs';
import {NativeHistoryQueue,HISTORY_QUEUE_TEST_ID} from './native-history-queue.mjs';
import {checkDesktopRuntime} from './desktop-runtime.mjs';
import {RolloutHistory} from './rollout-history.mjs';
import {DesktopStream} from './desktop-stream.mjs';
import {nativeTurns} from './desktop-view.mjs';
import {mergeHistory} from './history-merge.mjs';
import {wakeNativeQueue,checkQueueWakeBuild} from './native-queue-wake.mjs';
import {PersonalScope} from './personal-scope.mjs';
const expectedCwd='/Users/liutianwei/Documents/Codex/2026-10-15/rmtcdx-companion-acceptance-20261015';
const fail=code=>{throw Object.assign(Error(code),{code});};
const metadataFile=file=>{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid())fail('native_direct_metadata_rejected');};
export function directScope({enabled,conversationId,metadataDatabase,scope,restoreNative=false}){
 if(enabled!==true)fail('native_direct_scope_required');
 if(scope!==undefined){
  if(!(scope instanceof PersonalScope)||!path.isAbsolute(scope.metadataDatabase??''))fail('native_direct_scope_required');
  const original=scope.check(conversationId,{write:!restoreNative});
  const check=(id,{write=false}={})=>{if(id!==conversationId)fail('native_direct_scope_rejected');metadataFile(scope.metadataDatabase);const chat=scope.check(id,{write});if(chat.cwd!==original.cwd||chat.projectId!==original.projectId||chat.binding!==original.binding)fail('native_direct_scope_changed');return chat;};
  check(conversationId,{write:!restoreNative});return{metadataDatabase:scope.metadataDatabase,check,personalScope:scope};
 }
 if(conversationId!==HISTORY_QUEUE_TEST_ID||!path.isAbsolute(metadataDatabase??''))fail('native_direct_acceptance_only');
 const check=id=>{
  if(id!==conversationId)fail('native_direct_scope_rejected');metadataFile(metadataDatabase);
  const db=new DatabaseSync(metadataDatabase,{readOnly:true});let row;try{row=db.prepare('SELECT id,cwd,archived,rollout_path FROM threads WHERE id=?').get(id);}finally{db.close();}
  if(!row||row.cwd!==expectedCwd||row.archived!==0||!fs.statSync(row.cwd).isDirectory())fail('native_direct_scope_rejected');return{...row,workspaceAvailable:true};
 };
 check(conversationId);return{metadataDatabase,check};
}
export class NativeDirectRuntime {
 constructor(config,{checkRuntime=checkDesktopRuntime,verifyBuild=checkQueueWakeBuild,streamFactory=options=>new DesktopStream(options),wakeQueue=wakeNativeQueue}={}){
  this.config=config;this.scope=directScope(config);this.id=config.conversationId;this.expectedCwd=this.scope.check(this.id).cwd;this.history=new RolloutHistory(this.scope);this.log=config.log??(()=>{});this.stopped=false;
  Object.assign(this,{checkRuntime,verifyBuild,streamFactory,wakeQueue});
 }
 createInbox(options){
  if(this.queue||options.threadId!==this.id)fail('native_direct_scope_rejected');
  this.scope.check(this.id,{write:!options.inbox});
  const nativeQueue=new NativeHistoryQueue({database:path.join(path.dirname(this.scope.metadataDatabase),'queue_1.sqlite'),runtime:path.join(options.runtime,'native-receipts'),conversationId:this.id,enabled:true,personalScope:this.scope.personalScope});
  nativeQueue.checkScope=()=>this.scope.check(this.id,{write:true});
  this.queue=new NativeDirectInbox({...options,nativeQueue,checkScope:(id,o)=>this.scope.check(id,o),readState:()=>this.readState(),checkAdmission:async()=>{await this.checkRuntime();this.scope.check(this.id,{write:true});this.verifyBuild();},wake:async(id,identity)=>{const result=await this.wakeQueue({conversationId:id,personalScope:this.scope.personalScope,checkScope:this.scope.check,checkRuntime:this.checkRuntime,verifyBuild:this.verifyBuild,log:e=>this.log({...e,...identity})});this.retryAfter=0;this.attach();return result;}});return this.queue;
 }
 readState(){
  const file=this.history.read(this.id).state;if(!this.stream?.ready)return file;
  const value=mergeHistory(file,this.stream.state),persisted=new Map(nativeTurns(file).turns.map(t=>[t.turnId,t]));
  // Completion is proven by the durable native task_complete/turn_aborted,
  // not inferred from a transient snapshot's default status.
  for(const t of value.turns)t.completionObserved=persisted.get(t.turnId)?.completionObserved===true;
  return value;
 }
 nativeLinks(){this.scope.check(this.id);return this.queue?new Map(this.queue.inbox.db.prepare('SELECT client_id,intent_id,turn_id FROM native_dispatch').all().map(r=>[r.client_id,{intentId:r.intent_id,turnId:r.turn_id}])):new Map();}
 hasWork(){return Boolean(this.queue&&!this.queue.stopped&&this.queue.inbox.db.prepare("SELECT 1 FROM jobs WHERE state IN ('queued','leased','unknown')").get());}
 detach(){const stream=this.stream;this.stream=null;stream?.close();}
 attach(){
  if(this.stopped||this.stream||!this.hasWork()||Date.now()<(this.retryAfter??0))return;
  const chat=this.scope.check(this.id);if(chat.archived)return;
  const stream=this.streamFactory({endpoint:this.config.endpoint??'/Users/liutianwei/.codex/ipc/ipc.sock',conversationId:this.id,expectedCwd:this.expectedCwd});this.stream=stream;
  stream.on('state',()=>void this.tick());stream.on('unavailable',()=>{if(this.stream!==stream)return;this.stream=null;this.retryAfter=Date.now()+2000;stream.close();});
  void stream.start().catch(()=>{if(this.stream===stream){this.stream=null;this.retryAfter=Date.now()+2000;}stream.close();});
 }
 start(){if(this.stopped||this.timer)return this;this.timer=setInterval(()=>void this.tick(),200);return this;}
 async tick(){if(this.stopped||!this.queue)return;if(!this.hasWork()){this.detach();return;}try{const chat=this.scope.check(this.id);if(chat.archived)this.detach();else this.attach();await this.queue.tick();if(!this.hasWork())this.detach();}catch(e){if(Date.now()-(this.errorAt??0)>10000){this.errorAt=Date.now();this.log({event:'native.direct.unavailable',conversationId:this.id,code:e.code??'native_direct_unavailable'});}}}
 // The service owns the Inbox lifetime. Stopping this observer must never
 // release a native lease, replay its body or close a service's active store.
 async stop(){this.stopped=true;clearInterval(this.timer);const s=this.stream;this.stream=null;s?.close();await this.queue?.pending;}
}
export function directLinks({conversationId,queueRuntime,personalScope}){
 if(personalScope!==undefined&&!(personalScope instanceof PersonalScope)||conversationId!==HISTORY_QUEUE_TEST_ID&&!(personalScope instanceof PersonalScope))fail('native_direct_scope_required');
 if(!path.isAbsolute(queueRuntime??''))fail('native_direct_scope_rejected');
 if(personalScope){personalScope.check(conversationId);if(queueRuntime!==personalScope.route(conversationId))fail('native_direct_scope_rejected');}
 const file=path.join(queueRuntime,conversationId,'inbox.sqlite'),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077))fail('unsafe_inbox');
 const db=new DatabaseSync(file,{readOnly:true});try{
  if(db.prepare('SELECT thread_id FROM scope').get()?.thread_id!==conversationId)fail('native_direct_scope_rejected');
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_dispatch'").get())return new Map();
  return new Map(db.prepare('SELECT client_id,intent_id,turn_id FROM native_dispatch').all().map(r=>[r.client_id,{intentId:r.intent_id,turnId:r.turn_id}]));
 }finally{db.close();}
}
