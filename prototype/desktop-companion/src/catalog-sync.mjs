import {catalogRevision} from '../../../business/src/personal-catalog.mjs';

// Display names/times may change while a large catalog upload is in flight.
// Confirm only when the latest local execution membership still matches the
// catalog acknowledged by ECS. Archive/cwd/binding changes never get this ping.
export const admissionRevision=g=>catalogRevision({deviceId:g.deviceId,projects:g.projects.map(p=>({id:p.id,available:p.available,conversations:p.conversations.map(c=>({id:c.id,binding:c.binding,archived:c.archived,workspaceAvailable:c.workspaceAvailable})).sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.id.localeCompare(b.id))});
export class CatalogSync {
 constructor({revision,readGrant,call,onPublished=()=>{},onConfirmed=()=>{},onError=()=>{}}){Object.assign(this,{revision,readGrant,call,onPublished,onConfirmed,onError});this.closed=false;}
 async resync(){if(this.resyncing)return this.resyncing;this.known=null;this.resyncing=this.call('/api/agent/catalog').then(v=>{this.revision=v.revision;}).catch(e=>this.onError(e)).finally(()=>{this.resyncing=null;});return this.resyncing;}
 async tick(){
  if(this.closed)return;
  try{this.latest=this.readGrant();}catch(e){this.latest=null;this.onError(e);return;}
  const work=[];
  if(this.known&&admissionRevision(this.latest)===admissionRevision(this.known)&&!this.pinging){
   const revision=this.revision;this.pinging=this.call('/api/agent/catalog/ping',{revision}).then(()=>this.onConfirmed({kind:'ping',revision})).catch(async e=>{this.onError(e);if(e.code==='catalog_revision_conflict')await this.resync();}).finally(()=>{this.pinging=null;});work.push(this.pinging);
  }
  if(!this.publishing&&!this.resyncing&&(!this.known||catalogRevision(this.latest)!==this.revision)){
   const grant=this.latest;
   this.publishing=this.call('/api/agent/catalog',{baseRevision:this.revision,grant}).then(async value=>{
    if(this.closed)return;this.revision=value.revision;this.known=grant;this.onConfirmed({kind:'publish',revision:value.revision});await this.onPublished(grant,value.revision);
   }).catch(async e=>{this.onError(e);await this.resync();}).finally(()=>{this.publishing=null;});work.push(this.publishing);
  }
  await Promise.allSettled(work);
 }
 stop(){this.closed=true;}
}
