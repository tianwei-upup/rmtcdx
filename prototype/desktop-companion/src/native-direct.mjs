import crypto from 'node:crypto';
import {OwnerInbox} from './inbox.mjs';
import {nativeTurns} from './desktop-view.mjs';
import {HISTORY_QUEUE_TEST_ID} from './native-history-queue.mjs';
import {failure} from './app-tools.mjs';

const clientId=(thread,intent)=>{const b=crypto.createHash('sha256').update('rmtcdx-native-body-v1\0'+thread+'\0'+intent).digest().subarray(0,16);b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;return [b.subarray(0,4),b.subarray(4,6),b.subarray(6,8),b.subarray(8,10),b.subarray(10)].map(v=>v.toString('hex')).join('-');};
const bounded=text=>text.length<=16000?text:text.slice(0,15900)+'\n[队列摘要已截断，完整回复见原生会话历史]';

// Locally authorized transport. The model receives the original body,
// never a prompt instructing it to operate our delivery protocol.
export class NativeDirectInbox {
 constructor({runtime,threadId,inbox,nativeQueue,readState,checkAdmission,checkScope,wake,onChange=()=>{},log=()=>{}}){
  if((threadId!==HISTORY_QUEUE_TEST_ID&&typeof checkScope!=='function')||!nativeQueue||!readState||!checkAdmission||!wake)throw failure('native_direct_scope_required');
  const restoring=inbox instanceof OwnerInbox&&inbox.threadId===threadId&&Boolean(inbox.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_dispatch'").get());
  if(inbox&&!restoring)throw failure('native_direct_restore_required');
  checkScope??=()=>{};checkScope(threadId,{write:!restoring});
  Object.assign(this,{threadId,nativeQueue,readState,checkAdmission,checkScope,wake,onChange,log});
  this.inbox=inbox??new OwnerInbox({runtime,threadId});this.stopped=false;this.woken=new Set();
  if(!restoring){this.inbox.db.exec(`CREATE TABLE IF NOT EXISTS native_dispatch(intent_id TEXT PRIMARY KEY REFERENCES jobs(intent_id),client_id TEXT NOT NULL UNIQUE,admission TEXT NOT NULL,turn_id TEXT,prepared_at INTEGER NOT NULL);`);this.inbox.recover({preserveNative:true});}
 }
 status(){return{...this.inbox.status(),nativeTurnPerMessage:true,consumer:null};}
 async execute(request){
  if(this.stopped)throw failure('queue_stopped');if(request.threadId!==this.threadId)throw failure('queue_scope_rejected');
  this.checkScope(this.threadId,{write:['inbox_enqueue','inbox_cancel'].includes(request.operation)});
  let value;
  if(request.operation==='inbox_enqueue'){if(typeof request.text==='string'&&Buffer.byteLength(request.text)>32768)throw failure('invalid_inbox_job');value=this.inbox.enqueue(request.intentId,request.text);}
  else if(request.operation==='inbox_cancel'){
   if(this.inbox.db.prepare('SELECT 1 FROM native_dispatch WHERE intent_id=?').get(request.intentId))throw failure('inbox_native_cancel_unavailable');
   value=this.inbox.cancel(request.intentId,request.expectedRevision);
  }else if(request.operation==='inbox_queue_status')return{receipts:request.intentId?[this.inbox.receipt(this.inbox.get(request.intentId))]:this.inbox.receipts().slice(-100),consumer:null};
  else if(request.operation==='inbox_job')return this.inbox.receipt(this.inbox.get(request.intentId));
  else throw failure('inbox_native_delivery_only');
  this.onChange();return value;
 }
 reserve(){this.checkScope(this.threadId,{write:true});return this.inbox.transaction(()=>{
  const db=this.inbox.db;
  if(db.prepare("SELECT 1 FROM jobs WHERE state IN ('leased','unknown')").get()||db.prepare("SELECT 1 FROM consumers WHERE state IN ('active','stopping')").get())return null;
  const row=db.prepare("SELECT * FROM jobs WHERE state='queued' AND cancel_requested=0 ORDER BY created_at,rowid LIMIT 1").get();if(!row)return null;
  const client=clientId(this.threadId,row.intent_id);
  db.prepare("INSERT INTO native_dispatch VALUES(?,?,'prepared',NULL,?)").run(row.intent_id,client,Date.now());
  db.prepare("UPDATE jobs SET state='leased',token=?,revision=revision+1 WHERE intent_id=? AND state='queued'").run(crypto.randomUUID(),row.intent_id);
  this.inbox.event('job.leased',this.inbox.get(row.intent_id),'native_reservation');
  this.inbox.event('native.prepared',this.inbox.get(row.intent_id));
  return db.prepare('SELECT * FROM native_dispatch WHERE intent_id=?').get(row.intent_id);
 });}
 tick(){if(this.pending)return this.pending;if(this.stopped)return Promise.resolve();this.pending=this.run().finally(()=>{this.pending=null;});return this.pending;}
 async run(){
  let dispatch=this.inbox.db.prepare("SELECT d.* FROM native_dispatch d JOIN jobs j ON j.intent_id=d.intent_id WHERE j.state IN ('leased','unknown') ORDER BY j.created_at LIMIT 1").get();
  if(!dispatch){
   if(!this.inbox.db.prepare("SELECT 1 FROM jobs WHERE state='queued'").get())return;
   await this.checkAdmission();if(this.stopped)return;dispatch=this.reserve();if(!dispatch)return;this.onChange();
  }
  this.checkScope(this.threadId,{write:false});
  let state;
  try{state=await this.readState();}catch(e){this.log({event:'native.observe.unavailable',code:e.code??'history_unavailable',conversationId:this.threadId});}
  if(state&&this.observe(dispatch,state))return;
  // A durable native receipt is inspected on recovery. An absent accepted
  // row is not an invitation to append again or evidence of completion.
  let admission;
  if(dispatch.admission==='prepared'){
   await this.checkAdmission();if(this.stopped)return;
   this.checkScope(this.threadId,{write:true});
   admission=this.nativeQueue.enqueue({intentId:dispatch.client_id,text:this.inbox.get(dispatch.intent_id).text});
  }else admission=this.nativeQueue.inspect(dispatch.client_id);
  if(admission.state!==dispatch.admission){this.inbox.db.prepare('UPDATE native_dispatch SET admission=? WHERE intent_id=?').run(admission.state,dispatch.intent_id);this.inbox.event('native.'+admission.state,this.inbox.get(dispatch.intent_id));this.onChange();}
  if(['unknown','rejected'].includes(admission.state)){this.markUnknown(dispatch,'native_admission_'+admission.state);return;}
  if(['queued','accepted'].includes(admission.state)&&!this.woken.has(dispatch.client_id)){
   this.checkScope(this.threadId,{write:true});
   const notification=await this.wake(this.threadId,{clientId:dispatch.client_id,intentId:dispatch.intent_id});
   this.inbox.event('native.wake',this.inbox.get(dispatch.intent_id),notification?.state??'notification_dispatched');
   this.woken.add(dispatch.client_id);
  }
 }
 observe(dispatch,state){
  if(state.id!==this.threadId)throw failure('native_direct_scope_rejected');
  const matches=nativeTurns(state).turns.filter(t=>t.params?.clientUserMessageId===dispatch.client_id||(t.items??[]).some(i=>i.type==='userMessage'&&(i.clientId??i.client_id)===dispatch.client_id));
  if(matches.length>1){this.markUnknown(dispatch,'native_client_multiple_turns');return true;}
  const turn=matches[0];if(!turn)return false;
  const turnId=turn.turnId??turn.entityKey;if(!turnId)throw failure('native_direct_turn_missing');
  if(dispatch.turn_id&&dispatch.turn_id!==turnId){this.markUnknown(dispatch,'native_turn_changed');return true;}
  const row=this.inbox.get(dispatch.intent_id);
  if(row.consumer_turn!==turnId){this.inbox.transaction(()=>{
   this.inbox.db.prepare("UPDATE native_dispatch SET turn_id=?,admission='consumed' WHERE intent_id=?").run(turnId,dispatch.intent_id);
   this.inbox.db.prepare('UPDATE jobs SET consumer_turn=?,revision=revision+1 WHERE intent_id=?').run(turnId,dispatch.intent_id);
   this.inbox.event('native.started',this.inbox.get(dispatch.intent_id));
  });this.onChange();}
  // Unknown may be resolved only by this exact client/turn's native evidence.
  if(row.state==='unknown'&&turn.status==='inProgress'){this.inbox.db.prepare("UPDATE jobs SET state='leased',revision=revision+1 WHERE intent_id=?").run(dispatch.intent_id);this.onChange();}
  const messages=(turn.items??[]).filter(i=>i.type==='agentMessage'&&typeof i.text==='string'&&i.text.trim());
  const publicText=bounded(messages.map(i=>i.text).join('\n\n'));
  if(publicText){const old=this.inbox.db.prepare('SELECT * FROM progress WHERE intent_id=?').get(dispatch.intent_id);if(old?.text!==publicText){this.inbox.transaction(()=>{
   this.inbox.db.prepare('INSERT INTO progress VALUES(?,?,?,?) ON CONFLICT(intent_id) DO UPDATE SET seq=excluded.seq,text=excluded.text,at=excluded.at').run(dispatch.intent_id,(old?.seq??0)+1,publicText,Date.now());
   this.inbox.event('job.progress',this.inbox.get(dispatch.intent_id),'native_public_output');
  });this.onChange();}}
  if(turn.completionObserved===true&&turn.status==='completed'){
   const final=bounded(messages.filter(i=>i.phase==='final_answer').map(i=>i.text).join('\n\n')||publicText||'原生回合已结束（无文字回复）。');
   this.inbox.transaction(()=>{
    this.inbox.db.prepare("UPDATE jobs SET state='completed',result=?,result_hash=?,revision=revision+1 WHERE intent_id=?").run(final,crypto.createHash('sha256').update(final).digest('hex'),dispatch.intent_id);
    this.inbox.event('job.completed',this.inbox.get(dispatch.intent_id),'native_task_complete');
   });this.onChange();this.log({event:'native.direct.completed',conversationId:this.threadId,intentId:dispatch.intent_id,clientId:dispatch.client_id,turnId});
  }else if(turn.completionObserved===true&&['failed','interrupted'].includes(turn.status))this.markUnknown(dispatch,'native_'+turn.status);
  return true;
 }
 markUnknown(dispatch,reason){
  const row=this.inbox.get(dispatch.intent_id);if(row.state==='unknown')return;
  this.inbox.transaction(()=>{this.inbox.db.prepare("UPDATE jobs SET state='unknown',revision=revision+1 WHERE intent_id=?").run(dispatch.intent_id);this.inbox.event('job.unknown',this.inbox.get(dispatch.intent_id),reason);});this.onChange();
 }
 stop(){if(this.stopped)return;this.stopped=true;this.inbox.close();}
}
