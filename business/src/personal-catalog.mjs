import crypto from 'node:crypto';
import {queueTestScope,queueChats} from './queue-scope.mjs';
import {object,fail} from './contracts.mjs';
export const catalogRevision=g=>crypto.createHash('sha256').update(JSON.stringify(g)).digest('hex');
// Only a configured, paired computer may replace its own exact discovery grant.
// Persist metadata only. A restart keeps history visible but requires a fresh
// source confirmation before accepting new phone writes.
export class PersonalCatalog {
 constructor({grants,store,onChange=()=>{},now=Date.now}){Object.assign(this,{grants,store,onChange,now});this.confirmed=new Map();
  for(const g of [...grants])if(g.autoDiscover&&store.data.personalCatalogs?.[g.deviceId])this.replace(g.deviceId,store.data.personalCatalogs[g.deviceId],false);
 }
 grant(id){const g=this.grants.find(g=>g.deviceId===id);if(!g?.autoDiscover||g.mode!=='personal-projects')fail('catalog_discovery_disabled',403);return g;}
 revision(id){return catalogRevision(this.grant(id));}
 fresh(id){return this.now()-(this.confirmed.get(id)??0)<10000;}
 validate(id,value){const old=this.grant(id),g=queueTestScope(value);if(g.deviceId!==old.deviceId||g.mode!=='personal-projects'||!g.autoDiscover)fail('catalog_scope_rejected',403);const foreign=new Set(this.grants.filter(g=>g.deviceId!==id).flatMap(queueChats).map(c=>c.id));if(queueChats(g).some(c=>foreign.has(c.id)||!c.binding||typeof c.workspaceAvailable!=='boolean'))fail('catalog_scope_rejected',403);return g;}
 replace(id,value,save=true){const g=this.validate(id,value),index=this.grants.findIndex(g=>g.deviceId===id),old=this.grants[index];this.grants[index]=g;
  if(save){this.store.data.personalCatalogs??={};this.store.data.personalCatalogs[id]=g;}
  this.store.data.projects[id]=g.projects.map(({id,name,available})=>({id,name,available}));const ids=new Set(queueChats(g).map(c=>c.id));for(const [key,c]of Object.entries(this.store.data.conversations))if(c.deviceId===id&&!ids.has(key))delete this.store.data.conversations[key];for(const c of queueChats(g))this.store.data.conversations[c.id]={id:c.id,projectId:c.projectId,deviceId:id};if(save)this.store.save();this.onChange(old,g);return g;
 }
 ping(id,revision){if(revision!==this.revision(id))fail('catalog_revision_conflict',409);this.confirmed.set(id,this.now());return {ok:true,revision};}
 publish(id,data){object(data,['baseRevision','grant']);if(typeof data.baseRevision!=='string')fail('invalid_fields');const g=this.validate(id,data.grant),revision=catalogRevision(g),current=this.revision(id);if(revision!==current){if(data.baseRevision!==current)fail('catalog_revision_conflict',409);this.replace(id,g);}this.confirmed.set(id,this.now());return {ok:true,revision};}
}
