import { DesktopProjection } from './desktop-projection.mjs';
import { object, identifier, fail } from './contracts.mjs';
import { queueConversationAllowed, queueChats } from './queue-scope.mjs';

// This is a typed, RAM-only public projection and approval mailbox. It is not
// a native RPC transport: no start/steer/interrupt, credentials or tool payloads.
export class DesktopRelay {
  constructor({scopes=[],queueScopes=[],now=Date.now}={}){
    if(!Array.isArray(scopes)||scopes.length>5)fail('invalid_desktop_scope');
    this.scopes=new Map();this.now=now;this.publishers=new Map();this.intents=new Map();this.latestRead=new Map();
    for(const s of scopes){
      object(s,['deviceId','projectId','conversations','executionMode'],['deviceId','projectId','conversations']);identifier(s.deviceId);identifier(s.projectId);
      if(s.executionMode!==undefined&&!['readonly','desktop'].includes(s.executionMode))fail('invalid_desktop_scope');
      const g=queueScopes.find(g=>g.deviceId===s.deviceId&&(g.projectId===s.projectId||g.mode==='personal-projects'&&s.projectId==='personal-library'));
      if(!g||this.scopes.has(s.deviceId)||!Array.isArray(s.conversations)||!s.conversations.length)fail('invalid_desktop_scope');
      const chats=new Map();for(const c of s.conversations){object(c,['id','approvals']);identifier(c.id);if(typeof c.approvals!=='boolean'||!queueConversationAllowed(g,c.id)||chats.has(c.id)||queueChats(g).find(x=>x.id===c.id)?.archived&&c.approvals)fail('invalid_desktop_scope');chats.set(c.id,c);}
      this.scopes.set(s.deviceId,{...s,chats});
    }
    this.projection=this.scopes.size?new DesktopProjection({conversationIds:[...this.scopes.values()].flatMap(s=>[...s.chats.keys()]),now}):null;
  }
  scope(deviceId,id){const s=this.scopes.get(deviceId);if(!s||id&&!s.chats.has(id))fail('desktop_scope_rejected',403);return s;}
  owner(id){const s=[...this.scopes.values()].find(s=>s.chats.has(id));if(!s)fail('desktop_scope_rejected',403);return s;}
  config(deviceId){return [...(this.scopes.get(deviceId)?.chats.values()??[])];}
  executionMode(deviceId){return this.scopes.get(deviceId)?.executionMode??'readonly';}
  hello(deviceId,{epoch,conversationIds}){
    identifier(epoch);const s=this.scope(deviceId),old=this.publishers.get(deviceId);
    if(!Array.isArray(conversationIds)||!conversationIds.length||new Set(conversationIds).size!==conversationIds.length||conversationIds.some(id=>!s.chats.has(id)))fail('desktop_scope_rejected',403);
    if(old&&old.epoch!==epoch&&this.now()-old.at<8000)fail('desktop_publisher_busy',409);
    if(old?.epoch!==epoch){for(const id of s.chats.keys())this.projection.invalidate(id,'desktop_epoch_changed');for(const r of this.intents.values())if(r.deviceId===deviceId&&['queued','claimed'].includes(r.state))r.state=r.state==='queued'?'rejected':'unknown';}
    this.publishers.set(deviceId,{epoch,ids:new Set(conversationIds),at:this.now()});return {ok:true};
  }
  publisher(deviceId,epoch){this.scope(deviceId);const p=this.publishers.get(deviceId);if(!p||p.epoch!==epoch)fail('desktop_epoch_mismatch',409);return p;}
  wanted(id){const s=this.owner(id),last=this.latestRead.get(s.deviceId);return Boolean(this.projection.listeners.get(id)?.size||last?.id===id&&this.now()-last.at<300000);}
  ping(deviceId,epoch){const p=this.publisher(deviceId,epoch);p.at=this.now();const conversationIds=[...p.ids].filter(id=>this.wanted(id));return {ok:true,conversationIds,resyncIds:conversationIds.filter(id=>!this.projection.states.get(id)?.available)};}
  update(deviceId,{publisherEpoch,view}){
    const s=this.scope(deviceId,view.conversationId),p=this.publisher(deviceId,publisherEpoch);
    if(!p.ids.has(view.conversationId))fail('desktop_scope_rejected',403);
    let value=structuredClone(view);
    // Multi-chat publishers are demand driven. Past selections must not refill
    // the bounded RAM cache while the phone is reading another large history.
    if(s.chats.size>1&&!this.wanted(view.conversationId))value={...value,available:false,reason:'desktop_view_not_requested',historyComplete:false,items:[],approvals:[],activeTurnId:null};
    if(!s.chats.get(view.conversationId).approvals)for(const a of value.approvals)a.canRespond=false;
    this.decorate(value);this.projection.update(value);p.at=this.now();
    const latest=this.projection.states.get(view.conversationId);
    for(const r of this.intents.values())if(r.conversationId===latest.conversationId&&r.viewEpoch===latest.epoch&&!latest.approvals.some(a=>a.id===r.approvalId)&&latest.available){r.state='resolved';r.resolvedAt=this.now();}
    return {ok:true};
  }
  fresh(id){const s=this.owner(id),p=this.publishers.get(s.deviceId);return Boolean(p?.ids.has(id)&&this.now()-p.at<8000);}
  demandRead(id){const s=this.owner(id),previous=this.latestRead.get(s.deviceId);this.latestRead.set(s.deviceId,{id,at:this.now()});if(previous&&previous.id!==id&&!this.projection.listeners.get(previous.id)?.size){const old=this.projection.states.get(previous.id);if(old){const {receivedAt,...value}=old;this.projection.update({...value,available:false,reason:'desktop_view_not_requested',historyComplete:false,items:[],approvals:[],activeTurnId:null});}}}
  read(id,options){this.demandRead(id);if(!this.fresh(id))this.projection.invalidate(id,'desktop_disconnected');return this.projection.read(id,options);}
  subscribe(id,send){this.demandRead(id);return this.projection.subscribe(id,send);}
  public(r){return {intentId:r.intentId,approvalId:r.approvalId,decision:r.decision,state:r.state,...(r.code?{code:r.code}:{})};}
  decorate(view){for(const a of view.approvals){const r=[...this.intents.values()].find(r=>r.conversationId===view.conversationId&&r.approvalId===a.id);if(r){a.canRespond=false;a.status=r.state;}}return view;}
  refresh(id){const old=this.projection.states.get(id);if(old){const {receivedAt,...value}=structuredClone(old);this.projection.update(this.decorate(value));}}
  submit(id,data){
    object(data,['approvalId','decision','intentId']);identifier(data.intentId);identifier(data.approvalId);
    if(!['accept','decline'].includes(data.decision))fail('desktop_approval_rejected',400);
    const s=this.owner(id),old=this.intents.get(data.intentId);
    if(old){if(old.conversationId!==id||old.approvalId!==data.approvalId||old.decision!==data.decision)fail('desktop_approval_conflict',409);return this.public(old);}
    if(!s.chats.get(id).approvals||!this.fresh(id))fail('desktop_approval_unavailable',409);
    const v=this.projection.states.get(id),a=v?.approvals.find(a=>a.id===data.approvalId);
    if(!v.available||!a?.canRespond)fail('desktop_approval_stale',409);
    if([...this.intents.values()].some(r=>r.conversationId===id&&r.approvalId===data.approvalId))fail('desktop_approval_already_submitted',409);
    if(this.intents.size>=10000)fail('desktop_approval_capacity',429);
    const r={...data,conversationId:id,deviceId:s.deviceId,publisherEpoch:this.publishers.get(s.deviceId).epoch,viewEpoch:v.epoch,state:'queued',at:this.now()};this.intents.set(r.intentId,r);this.refresh(id);return this.public(r);
  }
  receipt(id,intentId){this.owner(id);const r=this.intents.get(intentId);if(!r||r.conversationId!==id)fail('desktop_approval_not_found',404);return this.public(r);}
  claim(deviceId,epoch){
    this.publisher(deviceId,epoch);
    for(const r of this.intents.values())if(r.deviceId===deviceId&&r.publisherEpoch===epoch&&r.state==='queued'){
      const v=this.projection.states.get(r.conversationId);
      if(!this.fresh(r.conversationId)||!v?.available||v.epoch!==r.viewEpoch||!v.approvals.some(a=>a.id===r.approvalId)){r.state='rejected';r.code='desktop_approval_stale';this.refresh(r.conversationId);continue;}
      r.state='claimed';r.claimedAt=this.now();return {conversationId:r.conversationId,viewEpoch:r.viewEpoch,...this.public(r)};
    }return null;
  }
  result(deviceId,{epoch,intentId,state,code}){
    this.publisher(deviceId,epoch);const r=this.intents.get(intentId);
    if(!r||r.deviceId!==deviceId||r.publisherEpoch!==epoch||!['submitted','unknown','rejected'].includes(state))fail('desktop_approval_rejected',409);
    if(r.state==='resolved')return this.public(r);
    if(!['claimed',state].includes(r.state))fail('desktop_approval_rejected',409);
    r.state=state;if(code){if(typeof code!=='string'||!/^[a-z_]{1,100}$/.test(code))fail('invalid_fields');r.code=code;}this.refresh(r.conversationId);return this.public(r);
  }
  prune(){
    for(const [id]of this.projection?.states??[])if(!this.fresh(id)&&this.projection.states.get(id).available)this.projection.invalidate(id,'desktop_disconnected');
    for(const [id,r]of this.intents){if(r.state==='claimed'&&this.now()-r.claimedAt>30000){r.state='unknown';this.refresh(r.conversationId);}if(this.now()-r.at>43200000)this.intents.delete(id);}
    for(const [id]of this.projection?.states??[]){const p=this.publishers.get(this.owner(id).deviceId);if(this.now()-(p?.at??0)>300000)this.projection.states.delete(id);}
  }
  close(){this.projection?.close();this.publishers.clear();this.intents.clear();this.latestRead.clear();}
}
