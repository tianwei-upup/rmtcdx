import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {queueTestScope,queueChats,queueProjects,SCOPED_QUEUE_OPERATIONS} from '../../../business/src/queue-scope.mjs';
import {input,output,fail} from '../../../business/src/contracts.mjs';
import {desktopProjects} from '../../../business/src/projects.mjs';
import {InboxService} from './inbox-service.mjs';
import {privateDirectory} from './state.mjs';

export class PersonalQueue {
 constructor({scope,grant,log=()=>{}}){this.scope=scope;this.grant=queueTestScope(grant);if(this.grant.mode!=='personal-projects')fail('personal_scope_required');this.chats=queueChats(this.grant);this.runtime=scope.manifest.runtime;privateDirectory(this.runtime);this.queues=new Map();this.events=new EventEmitter();this.log=log;this.stopped=false;
  // Resume only this service's existing inboxes. Never construct/recover the
  // legacy RN inboxes or allocate hundreds of empty SQLite databases.
  for(const c of this.chats)if(fs.existsSync(path.join(this.runtime,c.id,'inbox.sqlite')))this.queue(c.id);
 }
 members(){const ps=desktopProjects(this.scope.desktopStateFile);return new Set(this.chats.filter(c=>ps.find(p=>p.id===c.projectId)?.threadIds.includes(c.id)).map(c=>c.id));}
 catalog(){const ids=this.members();return this.chats.filter(c=>ids.has(c.id)).map(c=>({id:c.id,projectId:c.projectId,title:c.title,status:'idle'}));}
 queue(id){if(!this.chats.some(c=>c.id===id))fail('personal_scope_rejected');if(!this.queues.has(id))this.queues.set(id,new InboxService({runtime:path.join(this.runtime,id),threadId:id,log:this.log,onChange:()=>this.events.emit('change',id)}));return this.queues.get(id);}
 async execute(request){
  if(this.stopped)fail('queue_stopped');
  if(request.operation==='status'&&!request.threadId)return{mode:'personal-projects',ready:true,protocolVersion:2,allowedThreadIds:this.catalog().map(c=>c.id)};
  if(!this.chats.some(c=>c.id===request.threadId))fail('personal_scope_rejected');
  const write=['inbox_enqueue','inbox_open','inbox_listen','inbox_take'].includes(request.operation);this.scope.check(request.threadId,{write});
  const q=this.queue(request.threadId);
  if(request.operation==='status')return{ready:true,callerThreadId:request.threadId,ownerInbox:q.status()};
  const value=await q.execute(request),withText=r=>({...r,text:q.inbox.get(r.intentId).text});
  if(request.operation==='inbox_queue_status')return{...value,receipts:value.receipts.map(withText)};
  return ['inbox_enqueue','inbox_cancel'].includes(request.operation)?withText(value):value;
 }
 async snapshotQueue(id){this.scope.check(id);if(!this.queues.has(id))return{conversationId:id,receipts:[],consumer:null};return{...await this.execute({threadId:id,operation:'inbox_queue_status'}),conversationId:id};}
 subscribeQueue(fn){this.events.on('change',fn);return()=>this.events.off('change',fn);}
 stop(){this.stopped=true;for(const q of this.queues.values())q.stop();}
}
export class PersonalQueueAdapter {
 constructor(service){this.service=service;this.operations=SCOPED_QUEUE_OPERATIONS;}
 matchesQueueScope(g){return JSON.stringify(g)===JSON.stringify(this.service.grant);}
 ready(){return !this.service.stopped;}
 async start(){}
 async stop(){}
 queueIds(){return this.service.catalog().map(c=>c.id);}
 liveQueueIds(){return [...this.service.queues.keys()];}
 subscribeQueue(fn){return this.service.subscribeQueue(fn);}
 snapshotQueue(id){return this.service.snapshotQueue(id);}
 async execute(operation,params){input(operation,params);const projects=queueProjects(this.service.grant).map(({id,name,available})=>({id,name,available})),all=this.service.catalog();
  if(operation==='projects.sync')return{projects};
  if(operation==='directory.sync')return output(operation,{projects,directories:projects.map(p=>{const c=all.filter(c=>c.projectId===p.id);return{projectId:p.id,conversations:c.slice(0,100),nextCursor:c.length>100?'100':null};})});
  if(operation==='sessions.sync'){const offset=params.cursor?Number(params.cursor):0;if(!Number.isSafeInteger(offset)||offset<0||!projects.some(p=>p.id===params.projectId))fail('precondition_rejected');const c=all.filter(c=>c.projectId===params.projectId&&this.service.scope.check(c.id).archived===Boolean(params.archived)&&(!params.search||c.title.toLowerCase().includes(params.search.toLowerCase()))),size=params.pageSize??100;return output(operation,{conversations:c.slice(offset,offset+size),nextCursor:offset+size<c.length?String(offset+size):null});}
  const map={'queue.enqueue':'inbox_enqueue','queue.status':'inbox_queue_status','queue.cancel':'inbox_cancel','queue.consumer.stop':'inbox_consumer_stop'},op=map[operation];if(!op)fail('precondition_rejected');const{conversationId,...args}=params;
  try{const value=await this.service.execute({...args,threadId:conversationId,operation:op});return output(operation,operation==='queue.status'?{conversationId,receipts:value.receipts,consumer:value.consumer}:{conversationId,[operation==='queue.consumer.stop'?'consumer':'receipt']:value});}
  catch(e){if(e.code?.startsWith('inbox_')||['archived_conversation_readonly','workspace_unavailable','personal_membership_changed','personal_scope_changed'].includes(e.code))fail('precondition_rejected');throw e;}
 }
}
