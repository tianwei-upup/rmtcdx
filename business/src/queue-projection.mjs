import { object, identifier, string, fail, output } from './contracts.mjs';
import { queueConversationAllowed, queueChats } from './queue-scope.mjs';

// Body-bearing projections, observations and subscriptions are RAM ONLY.
export class QueueProjection {
  constructor({grants,now=Date.now,maxBytes=32*1024*1024}){
    this.grants=grants;this.now=now;this.maxBytes=maxBytes;this.publishers=new Map();this.snapshots=new Map();this.listeners=new Map();this.observations=new Map();
  }
  replacePersonal(old,next){const ids=new Set(queueChats(next).map(c=>c.id));for(const c of queueChats(old))if(!ids.has(c.id)){this.emit(c.id,{type:'queue.reset',epoch:null});this.snapshots.delete(c.id);this.listeners.delete(c.id);this.publishers.get(next.deviceId)?.ids.delete(c.id);}}
  grant(deviceId){return this.grants.find(g=>g.deviceId===deviceId)??fail('queue_scope_rejected',403);}
  owner(conversationId){return this.grants.find(g=>queueConversationAllowed(g,conversationId))??fail('conversation_not_found',404);}
  membership(deviceId,ids){const g=this.grant(deviceId);ids??=queueChats(g).map(c=>c.id);if(!Array.isArray(ids)||ids.length>(g.mode==='personal-projects'?5000:500)||new Set(ids).size!==ids.length||ids.some(id=>!queueConversationAllowed(g,id)))fail('queue_scope_rejected',403);return new Set(ids);}
  hello(deviceId,epoch,conversationIds){identifier(epoch);const ids=this.membership(deviceId,conversationIds),old=this.publishers.get(deviceId);this.publishers.set(deviceId,{epoch,ids,at:this.now()});
    for(const [id,s]of this.snapshots)if(s.deviceId===deviceId&&(old?.epoch!==epoch||!ids.has(id)))this.snapshots.delete(id);
    for(const [id]of this.listeners)if(this.owner(id).deviceId===deviceId)this.emit(id,{type:'queue.reset',epoch});return {ok:true};
  }
  ping(deviceId,epoch,conversationIds){const p=this.publishers.get(deviceId);if(!p||p.epoch!==epoch)fail('projection_epoch_mismatch',409);if(conversationIds!==undefined){const ids=this.membership(deviceId,conversationIds);for(const id of p.ids)if(!ids.has(id)){this.snapshots.delete(id);this.emit(id,{type:'queue.reset',epoch});}p.ids=ids;}p.at=this.now();return {ok:true};}
  health(conversationId){const g=this.owner(conversationId),p=this.publishers.get(g.deviceId),available=Boolean(p?.ids.has(conversationId));return {type:'queue.health',available,fresh:Boolean(available&&this.now()-p.at<8000),epoch:p?.epoch??null,serverAt:this.now()};}
  update(deviceId,value){
    object(value,['epoch','revision','conversationId','receipts','consumer']);identifier(value.epoch);
    const g=this.grant(deviceId);if(!queueConversationAllowed(g,value.conversationId))fail('queue_scope_rejected',403);
    this.ping(deviceId,value.epoch);if(!this.publishers.get(deviceId).ids.has(value.conversationId))fail('queue_scope_rejected',403);if(!Number.isSafeInteger(value.revision)||value.revision<1)fail('invalid_projection_revision');
    output('queue.status',{conversationId:value.conversationId,receipts:value.receipts,consumer:value.consumer});
    const previous=this.snapshots.get(value.conversationId);
    if(previous?.epoch===value.epoch&&previous.revision>=value.revision)return {ok:true,stale:true};
    const snapshot={...structuredClone(value),deviceId,serverAt:this.now()};
    let bytes=Buffer.byteLength(JSON.stringify(snapshot));for(const[id,s]of this.snapshots)if(id!==value.conversationId)bytes+=Buffer.byteLength(JSON.stringify(s));
    if(bytes>this.maxBytes)fail('projection_capacity',507);
    this.snapshots.set(value.conversationId,snapshot);
    const old=new Map((previous?.receipts??[]).map(r=>[r.intentId,JSON.stringify(r)]));
    const changed=value.receipts.filter(r=>old.get(r.intentId)!==JSON.stringify(r));
    const event={...value,receipts:changed,type:'queue.update',serverAt:this.now()};
    this.emit(value.conversationId,Buffer.byteLength(JSON.stringify(event))>512*1024?{type:'queue.reset',epoch:value.epoch}:event);return {ok:true};
  }
  read(conversationId){const g=this.owner(conversationId);let s=this.snapshots.get(conversationId);if(!s&&g.mode==='personal-projects'&&this.health(conversationId).fresh)s={conversationId,epoch:this.publishers.get(g.deviceId).epoch,revision:0,receipts:[],consumer:null};if(!s)fail('projection_unavailable',409);return {...structuredClone(s),...this.health(conversationId)};}
  subscribe(conversationId,send){this.owner(conversationId);const set=this.listeners.get(conversationId)??new Set();set.add(send);this.listeners.set(conversationId,set);send({type:'queue.reset',epoch:this.publishers.get(this.owner(conversationId).deviceId)?.epoch??null});return()=>{set.delete(send);if(!set.size)this.listeners.delete(conversationId);};}
  emit(id,event){for(const send of this.listeners.get(id)??[])send(event);}
  observe(conversationId,value){
    this.owner(conversationId);object(value,['observationId','intentId','phase','durationMs','transport']);identifier(value.observationId);identifier(value.intentId);
    if(!['enqueueRendered','claimRendered','firstOutputRendered','resultRendered','cancelRendered','cancelAcknowledged'].includes(value.phase)||!['sse','poll'].includes(value.transport)||!Number.isFinite(value.durationMs)||value.durationMs<0||value.durationMs>86400000)fail('invalid_queue_observation');
    if(!this.snapshots.get(conversationId)?.receipts.some(r=>r.intentId===value.intentId))fail('receipt_not_found',404);
    this.observations.set(value.observationId,{...value,conversationId,at:this.now()});this.prune();return {ok:true};
  }
  prune(){for(const [id,s]of this.snapshots)if(this.now()-(this.publishers.get(s.deviceId)?.at??0)>300000)this.snapshots.delete(id);for(const[k,v]of this.observations)if(this.now()-v.at>1800000)this.observations.delete(k);while(this.observations.size>10000)this.observations.delete(this.observations.keys().next().value);}
  metrics(id){this.owner(id);this.prune();const phases={};for(const v of this.observations.values())if(v.conversationId===id)(phases[v.phase]??=[]).push(v.durationMs);
    return {conversationId:id,phases:Object.fromEntries(Object.entries(phases).map(([phase,a])=>{a.sort((x,y)=>x-y);return[phase,{count:a.length,min:a[0],p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],max:a.at(-1)}];}))};
  }
  close(){this.listeners.clear();this.publishers.clear();this.snapshots.clear();this.observations.clear();}
}
