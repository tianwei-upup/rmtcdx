import test from 'node:test';import assert from 'node:assert/strict';
import {CatalogSync,admissionRevision} from '../src/catalog-sync.mjs';
import {catalogRevision} from '../../../business/src/personal-catalog.mjs';
const grant=()=>({deviceId:'mac',projects:[{id:'p',name:'P',available:true,conversations:[{id:'chat',title:'Chat',updatedAt:1,binding:'a',archived:false,workspaceAvailable:true}]}]});
test('slow display upload does not block exact membership confirmations',async()=>{
 let local=grant(),release;const calls=[],sync=new CatalogSync({revision:'initial',readGrant:()=>structuredClone(local),call:async(route,data)=>{calls.push({route,data});if(route.endsWith('/ping'))return{ok:true};if(data.grant.projects[0].conversations[0].updatedAt===2)await new Promise(r=>release=r);return{revision:catalogRevision(data.grant)};}});
 await sync.tick();local.projects[0].conversations[0].updatedAt=2;const upload=sync.tick();await new Promise(r=>setImmediate(r));const before=calls.filter(c=>c.route.endsWith('/ping')).length;await sync.tick();assert.equal(calls.filter(c=>c.route.endsWith('/ping')).length,before+1);release();await upload;sync.stop();
});
test('archive, workspace, reassignment and binding changes never confirm an older execution catalog',async()=>{
 for(const mutate of[g=>g.projects[0].conversations[0].archived=true,g=>g.projects[0].conversations[0].workspaceAvailable=false,g=>g.projects[0].conversations[0].binding='other',g=>g.projects[0].id='other',g=>g.projects.pop()]){
  let local=grant(),pings=0,release;const sync=new CatalogSync({revision:'initial',readGrant:()=>structuredClone(local),call:async(route,data)=>{if(route.endsWith('/ping')){pings++;return{};}if(sync.known)await new Promise(r=>release=r);return{revision:catalogRevision(data.grant)};}});await sync.tick();mutate(local);const upload=sync.tick();await new Promise(r=>setImmediate(r));await sync.tick();assert.equal(pings,0);release();await upload;sync.stop();
 }
 const a=grant(),b=grant();b.projects[0].name='renamed';b.projects[0].conversations[0].updatedAt=100;assert.equal(admissionRevision(a),admissionRevision(b));
});
test('failed publication stops confirming until CAS revision is recovered and latest grant published',async()=>{
 let local=grant(),fail=false,pings=0,revision='initial';const sync=new CatalogSync({revision,readGrant:()=>local,call:async(route,data)=>{if(!data)return{revision};if(route.endsWith('/ping')){pings++;return{};}if(fail)throw Object.assign(Error('network'),{code:'network_unavailable'});revision=catalogRevision(data.grant);return{revision};}});await sync.tick();local=structuredClone(local);local.projects[0].conversations[0].archived=true;fail=true;await sync.tick();await sync.tick();assert.equal(pings,0);assert.equal(sync.known,null);fail=false;await sync.tick();assert(sync.known.projects[0].conversations[0].archived);sync.stop();
});
