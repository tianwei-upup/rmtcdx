import { EventEmitter } from 'node:events';
import path from 'node:path';
import { queueTestScope, SCOPED_QUEUE_OPERATIONS } from '../../../business/src/queue-scope.mjs';
import { desktopProjects } from '../../../business/src/projects.mjs';
import { input, output, fail } from '../../../business/src/contracts.mjs';
import { InboxService } from './inbox-service.mjs';
import { privateDirectory } from './state.mjs';

export class ProjectQueue {
  constructor({runtime,grant,desktopStateFile,log=()=>{},standby,inboxFactory=options=>new InboxService(options)}){
    this.events=new EventEmitter();this.grant=queueTestScope(grant);
    if(!['project-readonly','dedicated-test'].includes(this.grant?.mode))fail('queue_scope_rejected');
    this.chats=this.grant.conversations??[{id:this.grant.conversationId,title:'rmtcdx realtime acceptance',archived:false}];
    this.runtime=runtime;privateDirectory(runtime);this.desktopStateFile=desktopStateFile;this.queues=new Map();this.log=log;this.stopped=false;
    if(standby&&(!Array.isArray(standby.threadIds)||!standby.threadIds.length||new Set(standby.threadIds).size!==standby.threadIds.length||standby.threadIds.some(id=>!this.chats.some(c=>c.id===id&&!c.archived))))fail('standby_scope_rejected');
    this.members();
    try{for(const chat of this.chats){
      // ID is a directory component as well as an API identity.
      if(!/^[a-zA-Z0-9-]{1,80}$/.test(chat.id))fail('queue_scope_rejected');
      this.queues.set(chat.id,inboxFactory({runtime:path.join(runtime,chat.id),threadId:chat.id,log,onChange:()=>this.events.emit('change',chat.id),...(standby?.threadIds.includes(chat.id)?{standby:{windowMs:standby.windowMs,maxJobs:standby.maxJobs}}:{})}));
    }}catch(error){this.stop();throw error;}
  }
  members(){
    if(this.grant.mode==='dedicated-test')return new Set(this.chats.map(c=>c.id));
    const project=desktopProjects(this.desktopStateFile).find(p=>p.id===this.grant.projectId);
    if(!project||project.name!==this.grant.projectName)fail('queue_scope_rejected');
    return new Set(project.threadIds);
  }
  allowed(threadId){const chat=this.chats.find(c=>c.id===threadId);if(!chat||!this.members().has(threadId))fail('queue_scope_rejected');return chat;}
  catalog(){const members=this.members();return this.chats.filter(c=>members.has(c.id)).map(c=>({id:c.id,projectId:this.grant.projectId,title:c.title,status:'idle'}));}
  async execute(request){
    if(this.stopped||this.accepting===false)fail('queue_stopped');
    if(request.operation==='status'&&!request.threadId)return {mode:this.grant.mode,projectId:this.grant.projectId,ready:true,protocolVersion:2,allowedThreadIds:this.catalog().map(c=>c.id)};
    const chat=this.allowed(request.threadId),queue=this.queues.get(chat.id);
    if(request.operation==='status')return {mode:this.grant.mode,projectId:this.grant.projectId,callerThreadId:chat.id,ready:true,ownerInbox:queue.status()};
    if(chat.archived&&(['inbox_open','inbox_enqueue','inbox_take','inbox_listen'].includes(request.operation)||request.operation.startsWith('inbox_standby_')))fail('archived_conversation_readonly');
    const value=await queue.execute(request);
    const withText=r=>({...r,text:queue.inbox.get(r.intentId).text});
    if(request.operation==='inbox_queue_status')return {...value,receipts:value.receipts.map(withText)};
    if(['inbox_enqueue','inbox_cancel'].includes(request.operation))return withText(value);
    return value;
  }
  subscribeQueue(listener){this.events.on('change',listener);return()=>this.events.off('change',listener);}
  quiesce(){this.accepting=false;}
  async snapshotQueue(id){return {...await this.execute({operation:'inbox_queue_status',threadId:id}),conversationId:id};}
  stop(){if(this.stopped)return;this.stopped=true;for(const queue of this.queues.values())queue.stop();}
}

export class ProjectQueueAdapter {
  constructor(service){this.service=service;this.grant=service.grant;this.operations=SCOPED_QUEUE_OPERATIONS;}
  subscribeQueue(listener){return this.service.subscribeQueue(listener);}
  queueIds(){return this.service.catalog().map(c=>c.id);}
  snapshotQueue(id){return this.service.snapshotQueue(id);}
  matchesQueueScope(scope){return JSON.stringify(scope)===JSON.stringify(this.grant);}
  async start(){this.stopped=false;this.service.members();}
  ready(){try{return !this.stopped&&!this.service.stopped&&Boolean(this.service.members());}catch{return false;}}
  async stop(){this.stopped=true;}
  async execute(operation,params){
    input(operation,params);if(!this.ready()||!this.operations.includes(operation))fail('precondition_rejected');
    const g=this.grant,projects=[{id:g.projectId,name:g.projectName??'专用实时性验收',available:true}],conversations=this.service.catalog();
    if(operation==='projects.sync')return {projects};
    if(operation==='directory.sync')return output(operation,{projects,directories:[{projectId:g.projectId,conversations:conversations.slice(0,100),nextCursor:conversations.length>100?'100':null}]});
    if(operation==='sessions.sync'){
      if(params.projectId!==g.projectId)fail('precondition_rejected');
      const offset=params.cursor?Number(params.cursor):0;if(!Number.isSafeInteger(offset)||offset<0)fail('precondition_rejected');
      const filtered=conversations.filter(c=>Boolean(params.archived)===this.service.chats.find(x=>x.id===c.id).archived&&(!params.search||c.title.toLowerCase().includes(params.search.toLowerCase()))),size=params.pageSize??100;
      return output(operation,{conversations:filtered.slice(offset,offset+size),nextCursor:offset+size<filtered.length?String(offset+size):null});
    }
    const map={'queue.enqueue':'inbox_enqueue','queue.status':'inbox_queue_status','queue.cancel':'inbox_cancel','queue.consumer.stop':'inbox_consumer_stop'};
    try{
      const {conversationId,...args}=params,value=await this.service.execute({...args,threadId:conversationId,operation:map[operation]});
      return output(operation,{conversationId,...(operation==='queue.status'?value:{[operation==='queue.consumer.stop'?'consumer':'receipt']:value})});
    }catch(error){if(error.code?.startsWith('inbox_')||['queue_scope_rejected','archived_conversation_readonly'].includes(error.code))fail('precondition_rejected');throw error;}
  }
}
