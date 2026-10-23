import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {zstdDecompressSync} from 'node:zlib';
import {PersonalScope} from './personal-scope.mjs';
import {OwnerInbox} from './inbox.mjs';
import {InboxConsumer} from './consumer.mjs';
import {InboxService} from './inbox-service.mjs';
import {StandbyPolicy} from './standby.mjs';
import {NativeDirectRuntime,directLinks} from './native-direct-runtime.mjs';
import {verifyNativeQueueSchema,HISTORY_QUEUE_TEST_ID} from './native-history-queue.mjs';
import {migrateNativeDelivery} from './native-delivery-migration.mjs';
import {failure} from './app-tools.mjs';

const table=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const writeOperations=new Set(['inbox_enqueue','inbox_open','inbox_listen','inbox_take','inbox_progress','inbox_standby_enable','inbox_standby_resume']);
const privateFile=file=>{const s=fs.lstatSync(file,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid())||s.nlink!==1n)throw failure('unsafe_native_delivery_file');return s;};
const generation=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
const compressedIdleCache=new Map(),maxCompressed=64*1024*1024,maxExpanded=512*1024*1024;
const absent=file=>{try{fs.lstatSync(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}};
function historyEvidence(first,tail,{id,offset,size,allowBlank}){
 const line=first.indexOf(10);if(line<0)return false;
 const meta=JSON.parse(first.subarray(0,line).toString('utf8'));if(meta.type!=='session_meta'||(meta.payload?.id??meta.payload?.session_id)!==id)return false;
 if(!tail.length||tail.at(-1)!==10)return false;
 if(offset){const skip=tail.indexOf(10);if(skip<0)return false;tail=tail.subarray(skip+1);}
 const records=tail.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const blank=allowBlank&&offset===0&&!meta.payload?.history_base&&records.length===1&&records[0].type==='session_meta';
 const events=records.map((r,index)=>({r,index})).filter(({r})=>r.type==='event_msg'&&['task_started','task_complete','turn_aborted'].includes(r.payload?.type)),last=events.at(-1),payload=last?.r.payload;
 const terminal=Boolean(payload&&['task_complete','turn_aborted'].includes(payload.type)&&typeof payload.turn_id==='string'&&payload.turn_id&&!records.slice(last.index+1).some(r=>r.type==='turn_context'||r.type==='event_msg'&&r.payload?.type==='user_message'||r.type==='response_item'&&r.payload?.role==='user'));
 return blank||terminal;
}

// A cold observer never loads an owner to decide migration. Plain JSONL reads
// only its identity header and <=1 MiB terminal tail. An immutable compressed
// generation is decoded in memory once under input/output caps, then only its
// boolean evidence is cached. Every call still fences the live source, scope
// and native queue; a new plain file always supersedes a compressed snapshot.
export function nativeDeliveryIdle(scope,id,{maxCompressedBytes=maxCompressed,maxExpandedBytes=maxExpanded}={}){
 try{
  if(!Number.isSafeInteger(maxCompressedBytes)||maxCompressedBytes<1||maxCompressedBytes>maxCompressed||!Number.isSafeInteger(maxExpandedBytes)||maxExpandedBytes<1||maxExpandedBytes>maxExpanded)return false;
  const chat=scope.check(id,{write:true}),root=fs.realpathSync(path.dirname(scope.metadataDatabase)),metadataPath=chat.rollout_path;
  if(!path.isAbsolute(metadataPath??''))return false;
  const base=metadataPath.endsWith('.zst')?metadataPath.slice(0,-4):metadataPath,compressed=absent(base),file=compressed?base+'.zst':base;
  if(!fs.realpathSync(file).startsWith(path.join(root,'sessions')+path.sep))return false;
  const stat=privateFile(file),size=Number(stat.size);if(!Number.isSafeInteger(size)||size<1)return false;
  const key=JSON.stringify([root,id,chat.projectId,chat.cwd,chat.binding,metadataPath,file,generation(stat),maxCompressedBytes,maxExpandedBytes]);
  let evidence=compressedIdleCache.get(key);
  if(!compressed||evidence===undefined){
   const fd=fs.openSync(file,'r');
   try{
    if(generation(stat)!==generation(fs.fstatSync(fd,{bigint:true})))return false;
    const read=(length,offset)=>{const bytes=Buffer.alloc(length);if(fs.readSync(fd,bytes,0,length,offset)!==length)throw failure('native_delivery_history_changed');return bytes;};
    if(compressed){
     if(size>maxCompressedBytes)return false;
     try{const expanded=zstdDecompressSync(read(size,0),{maxOutputLength:maxExpandedBytes}),offset=Math.max(0,expanded.length-1024*1024);evidence=historyEvidence(expanded.subarray(0,65536),expanded.subarray(offset),{id,offset,size:expanded.length,allowBlank:false});}catch{evidence=false;}
    }else{
     const offset=Math.max(0,size-1024*1024);evidence=historyEvidence(read(Math.min(size,65536),0),read(size-offset,offset),{id,offset,size,allowBlank:true});
    }
    if(generation(stat)!==generation(fs.fstatSync(fd,{bigint:true})))return false;
   }finally{fs.closeSync(fd);}
   if(compressed){
    if(!absent(base)||generation(stat)!==generation(privateFile(file)))return false;
    compressedIdleCache.set(key,evidence);while(compressedIdleCache.size>128)compressedIdleCache.delete(compressedIdleCache.keys().next().value);
   }
  }
  if(!evidence)return false;
  const database=path.join(root,'queue_1.sqlite');privateFile(database);const db=new DatabaseSync(database,{readOnly:true});
  try{verifyNativeQueueSchema(db);if(db.prepare('SELECT 1 FROM queued_items WHERE thread_id=? LIMIT 1').get(id))return false;}finally{db.close();}
  if(compressed&&!absent(base)||generation(stat)!==generation(privateFile(file)))return false;
  const current=scope.check(id,{write:true});
  return current.projectId===chat.projectId&&current.cwd===chat.cwd&&current.binding===chat.binding&&current.rollout_path===metadataPath&&(!compressed||absent(base))&&generation(stat)===generation(privateFile(file));
 }catch{return false;}
}

export class NativeDeliveryManager{
 constructor({scope,queueRuntime,enabled=false,projectIds,log=()=>{},checkIdle},{runtimeFactory=config=>new NativeDirectRuntime(config),migrate=migrateNativeDelivery,now=Date.now}={}){
  if(!(scope instanceof PersonalScope)||!path.isAbsolute(queueRuntime??'')||typeof enabled!=='boolean'||checkIdle!==undefined&&typeof checkIdle!=='function')throw failure('native_delivery_scope_required');
  Object.assign(this,{scope,queueRuntime,enabled,log,runtimeFactory,migrate,now});this.checkIdle=checkIdle??(id=>nativeDeliveryIdle(scope,id));this.queues=new Map();this.stopped=false;this.setProjects(projectIds);
 }
 setProjects(ids){if(ids!==undefined&&(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length))throw failure('native_delivery_projects_required');this.projectIds=ids===undefined?null:new Set(ids);}
 selected(id){const c=this.scope.chats.get(id);return Boolean(this.enabled&&c&&(this.projectIds===null||this.projectIds.has(c.projectId)));}
 handles(id){return this.queues.get(id)?.mode==='native'||this.selected(id);}
 createInbox(options){
  if(this.stopped)throw failure('queue_stopped');const id=options.threadId;
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id??'')||options.runtime!==path.join(this.queueRuntime,id)||this.scope.route(id)!==this.queueRuntime)throw failure('native_delivery_scope_rejected');
  this.scope.check(id);if(this.queues.has(id))throw failure('native_delivery_inbox_already_open');
  const q=new RoutedInbox(this,options);this.queues.set(id,q);return q;
 }
 nativeLinks(chat){const id=typeof chat==='string'?chat:chat.id;this.scope.check(id);if(this.queues.get(id)?.mode!=='native')return new Map();return directLinks({conversationId:id,queueRuntime:this.queueRuntime,personalScope:this.scope});}
 capabilities(chat){const id=typeof chat==='string'?chat:chat.id,q=this.queues.get(id);return{nativeDirect:Boolean(q&&q.mode!=='legacy')};}
 tick(){if(this.pending)return this.pending;if(this.stopped)return Promise.resolve();this.pending=(async()=>{for(const q of this.queues.values()){if(this.stopped)break;try{await q.tick();}catch(error){this.log({event:'native.delivery.tick.unavailable',conversationId:q.threadId,code:error.code??'native_delivery_unavailable'});}}})().finally(()=>{this.pending=null;});return this.pending;}
 async stop(){if(this.stopped)return this.stopping;this.stopped=true;this.stopping=(async()=>{await Promise.all([...this.queues.values()].map(q=>q.runtime?.stop()));await this.pending;})();return this.stopping;}
}

// Shared OwnerInbox is intentionally opened without recover(). The old
// consumer may still be active; neither construction, status nor shutdown
// expires or rewrites its lease while migration waits for natural completion.
export class RoutedInbox{
 constructor(manager,options){
  Object.assign(this,{manager,options,threadId:options.threadId,log:options.log??manager.log,onChange:options.onChange??(()=>{})});
  this.inbox=new OwnerInbox(options);this.mode='legacy';this.stopped=false;this.lastAttemptAt=-Infinity;
  this.legacy=Object.create(InboxService.prototype);Object.assign(this.legacy,{scope:{callerThreadId:this.threadId},log:this.log,onChange:this.onChange,inbox:this.inbox,consumer:new InboxConsumer(this.inbox),stopped:false,standby:null});
  this.legacy.consumer.status=()=>this.legacy.consumer.view(this.inbox.db.prepare('SELECT * FROM consumers ORDER BY rowid DESC LIMIT 1').get());
  if(options.standby||table(this.inbox.db,'standby_policy'))this.legacy.standby=new StandbyPolicy(this.inbox,options.standby);
  try{if(table(this.inbox.db,'native_dispatch')){this.mode='native';try{this.activate();}catch(error){this.blocked=error.code??'native_delivery_unavailable';this.log({event:'native.delivery.restore.blocked',conversationId:this.threadId,code:this.blocked});}}else this.refresh(true);}catch(error){this.inbox.close();throw error;}
 }
 protected(){const db=this.inbox.db;return Boolean(db.prepare("SELECT 1 FROM jobs WHERE state IN ('leased','unknown')").get()||db.prepare("SELECT 1 FROM consumers WHERE state IN ('active','stopping')").get()||table(db,'standby_policy')&&db.prepare('SELECT 1 FROM standby_policy WHERE enabled=1').get());}
 activate(){
  const current=this.manager.scope.check(this.threadId);if(table(this.inbox.db,'native_delivery')){const marker=this.inbox.db.prepare('SELECT * FROM native_delivery WHERE singleton=1').get();if(!marker||marker.project_id!==current.projectId||marker.cwd!==current.cwd||marker.binding!==current.binding)throw failure('native_delivery_binding_changed_pending');}else if(this.threadId!==HISTORY_QUEUE_TEST_ID)throw failure('native_delivery_adoption_required');
  const runtime=this.manager.runtimeFactory({enabled:true,conversationId:this.threadId,scope:this.manager.scope,restoreNative:true,log:this.log});
  try{this.direct=runtime.createInbox({...this.options,inbox:this.inbox});this.runtime=runtime;this.mode='native';this.blocked=null;this.legacy.stopped=true;this.onChange();}catch(error){void runtime.stop();throw error;}
 }
 refresh(force=false){
  if(this.mode==='native'||this.stopped)return;
  if(!this.manager.selected(this.threadId)||this.protected()){this.mode='legacy';return;}
  this.mode='pending-native';if(!force&&this.manager.now()-this.lastAttemptAt<1000)return;this.lastAttemptAt=this.manager.now();
  try{
   const current=this.manager.scope.check(this.threadId);
   // These histories remain readable, but they cannot become new native
   // writers. Treat this as an ordinary read-only state rather than an error
   // retried and logged once per migration poll.
   if(current.archived===true||current.archived===1||current.workspaceAvailable===false){this.mode='legacy';this.deferredCode=null;return;}
   this.manager.migrate(this.inbox,{checkScope:(id,o)=>{const chat=this.manager.scope.check(id,o);if(!this.manager.enabled||this.manager.projectIds!==null&&!this.manager.projectIds.has(chat.projectId)||this.manager.scope.route(id)!==this.manager.queueRuntime)throw failure('native_delivery_project_disabled');return chat;},checkNativeIdle:(id,s)=>this.manager.checkIdle(id,s),allowQueued:true});this.activate();
   this.deferredCode=null;
   this.log({event:'native.delivery.migrated',conversationId:this.threadId});
  }catch(error){
   if(table(this.inbox.db,'native_dispatch')){this.mode='native';this.blocked=error.code??'native_delivery_unavailable';}else if(this.protected())this.mode='legacy';
   const code=error.code??'native_delivery_unavailable',now=this.manager.now();
   if(code!==this.deferredCode||now-(this.deferredAt??-Infinity)>=60000){this.log({event:'native.delivery.deferred',conversationId:this.threadId,code});this.deferredCode=code;this.deferredAt=now;}
  }
 }
 status(){const value=this.mode==='native'&&this.direct?this.direct.status():this.legacy.status();return{...value,...(this.mode==='native'?{consumer:null}:{}),deliveryMode:this.mode==='legacy'?'legacy':'native',nativeTurnPerMessage:this.mode!=='legacy',...(this.mode==='pending-native'?{migrationPending:true}:{}),...(this.blocked?{deliveryBlocked:this.blocked}:{})};}
 async execute(request){
  if(this.stopped)throw failure('queue_stopped');if(request.threadId!==this.threadId)throw failure('queue_scope_rejected');
  const write=writeOperations.has(request.operation);this.manager.scope.check(this.threadId,{write});
  // A final close can arrive after reply naturally closed the old consumer,
  // including after this Inbox migrated. Resolve that exact old identity as a
  // read-only acknowledgement; never reopen or take from the native queue.
  if(request.operation==='inbox_close'){
   const session=this.legacy.consumer.get(request.sessionId,request.consumerTurnId);
   if(session.state==='closed')return this.legacy.consumer.view(session);
  }
  this.refresh();
  if(this.mode==='native'&&this.direct)return this.direct.execute(request);
  if(this.mode==='native'&&write)throw failure(this.blocked??'native_delivery_unavailable');
  if(this.mode==='legacy')return this.legacy.execute(request);
  let value;
  if(request.operation==='inbox_enqueue'){if(typeof request.text==='string'&&Buffer.byteLength(request.text)>32768)throw failure('invalid_inbox_job');value=this.inbox.enqueue(request.intentId,request.text);}
  else if(request.operation==='inbox_cancel'){
   const row=this.inbox.get(request.intentId),reserved=table(this.inbox.db,'native_dispatch')&&this.inbox.db.prepare('SELECT 1 FROM native_dispatch WHERE intent_id=?').get(request.intentId);
   if(row.state!=='cancelled'&&(reserved||row.state!=='queued'))throw failure('inbox_native_cancel_unavailable');
   value=this.inbox.cancel(request.intentId,request.expectedRevision);
  }
  else if(request.operation==='inbox_job')return this.inbox.receipt(this.inbox.get(request.intentId));
  else if(request.operation==='inbox_queue_status')return{receipts:request.intentId?[this.inbox.receipt(this.inbox.get(request.intentId))]:this.inbox.receipts().slice(-100),consumer:null};
  else throw failure('inbox_native_delivery_only');
  this.onChange();return value;
 }
 async tick(){if(this.stopped)return;this.refresh();if(this.mode==='native'){if(this.runtime)await this.runtime.tick();else if(this.manager.now()-this.lastAttemptAt>=1000){this.lastAttemptAt=this.manager.now();try{this.activate();}catch(error){this.blocked=error.code??'native_delivery_unavailable';}}}}
 stop(){
  if(this.stopped)return this.stopping;this.stopped=true;this.legacy.stopped=true;if(this.direct)this.direct.stopped=true;
  this.stopping=(async()=>{await this.runtime?.stop();this.inbox.close();})();return this.stopping;
 }
}
