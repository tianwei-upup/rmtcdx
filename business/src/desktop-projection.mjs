import crypto from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code,status:['desktop_projection_unavailable','desktop_cursor_expired'].includes(code)?409:400});};
// Public transcript projection only; all bodies and subscribers are RAM-only.
// A projection is scoped independently from inbox write/consumer privileges.
export class DesktopProjection {
 constructor({conversationIds,maxBytes=32*1024*1024,now=Date.now}={}){if(!conversationIds?.length||new Set(conversationIds).size!==conversationIds.length)fail('desktop_scope_required');this.ids=new Set(conversationIds);this.maxBytes=maxBytes;this.now=now;this.states=new Map();this.listeners=new Map();this.pages=new Map();}
 allowed(id){if(!this.ids.has(id))fail('desktop_scope_rejected');}
 update(value){
  const fields=new Set(['conversationId','epoch','revision','available','reason','historyComplete','unsupported','items','approvals','activeTurnId','capabilities']);
  if(Object.keys(value).some(k=>!fields.has(k)))fail('invalid_desktop_projection');
  this.allowed(value.conversationId);if(typeof value.epoch!=='string'||!Number.isSafeInteger(value.revision)||!Array.isArray(value.items)||!Array.isArray(value.approvals))fail('invalid_desktop_projection');
  const itemFields=new Set(['id','turnId','itemId','kind','status','text','phase','attachmentsUnavailable','type','title','detail','output','exitCode','error','queueLinks','at']);
  if(value.items.some(i=>!i||typeof i.id!=='string'||i.id.length>512||!['user','assistant','tool'].includes(i.kind)||Object.keys(i).some(k=>!itemFields.has(k))))fail('invalid_desktop_projection');
  if(value.items.some(i=>i.queueLinks&&(!Array.isArray(i.queueLinks)||i.queueLinks.some(l=>Object.keys(l).some(k=>!['intentId','phase'].includes(k))||typeof l.intentId!=='string'||!['received','reply','progress','cancel'].includes(l.phase)))))fail('invalid_desktop_projection');
  const approvalFields=new Set(['id','turnId','itemId','method','title','detail','reason','canRespond','status']);
  if(value.approvals.some(a=>!a||typeof a.id!=='string'||Object.keys(a).some(k=>!approvalFields.has(k))))fail('invalid_desktop_projection');
  const before=this.states.get(value.conversationId);if(before?.epoch===value.epoch&&value.revision<before.revision)return;
  if(new Set(value.items.map(i=>i.id)).size!==value.items.length)fail('invalid_desktop_projection');
  let bytes=Buffer.byteLength(JSON.stringify(value));for(const [id,s]of this.states)if(id!==value.conversationId)bytes+=Buffer.byteLength(JSON.stringify(s));if(bytes>this.maxBytes)fail('desktop_projection_capacity');
  const next={...structuredClone(value),receivedAt:this.now()};this.states.set(value.conversationId,next);
  if(!before||before.epoch!==value.epoch||!value.available){this.emit(value.conversationId,{type:'desktop.reset',epoch:value.epoch,revision:value.revision,available:value.available,reason:value.reason});return;}
  const old=new Map(before.items.map(i=>[i.id,JSON.stringify(i)])),changed=value.items.filter(i=>old.get(i.id)!==JSON.stringify(i));
  const event={...next,type:'desktop.update',baseRevision:before.revision,items:changed,order:value.items.map(i=>i.id)};delete event.receivedAt;
  if(Buffer.byteLength(JSON.stringify(event))>512*1024)this.emit(value.conversationId,{type:'desktop.reset',epoch:value.epoch,revision:value.revision,available:value.available});else this.emit(value.conversationId,event);
 }
 read(id,{cursor,pageSize=50}={}){
  this.allowed(id);let value,offset=0;
  if(cursor){const page=this.pages.get(cursor);if(!page||page.id!==id||page.expires<this.now())fail('desktop_cursor_expired');({value,offset}=page);}
  else {value=this.states.get(id);if(!value)fail('desktop_projection_unavailable');value=structuredClone(value);}
  const items=value.items.slice(offset,offset+pageSize);let nextCursor=null;
  if(offset+pageSize<value.items.length){nextCursor=crypto.randomUUID();this.pages.set(nextCursor,{id,value,offset:offset+pageSize,expires:this.now()+30000});}
  for(const [key,page]of this.pages)if(page.expires<this.now())this.pages.delete(key);while(this.pages.size>100)this.pages.delete(this.pages.keys().next().value);
  return {...value,type:'desktop.snapshot',items,nextCursor};
 }
 subscribe(id,send){this.allowed(id);const set=this.listeners.get(id)??new Set();set.add(send);this.listeners.set(id,set);send({type:'desktop.reset',epoch:this.states.get(id)?.epoch??null});return()=>{set.delete(send);if(!set.size)this.listeners.delete(id);};}
 emit(id,value){for(const send of this.listeners.get(id)??[])send(value);}
 invalidate(id,reason='desktop_disconnected'){this.allowed(id);for(const [key,page]of this.pages)if(page.id===id)this.pages.delete(key);const old=this.states.get(id);if(old){const {receivedAt,...value}=old;this.update({...value,available:false,reason,approvals:[]});}}
 close(){this.states.clear();this.listeners.clear();this.pages.clear();}
}
