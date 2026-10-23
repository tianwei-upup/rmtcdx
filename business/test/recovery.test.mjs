import test from 'node:test';
import assert from 'node:assert/strict';
import {BusinessClient} from '../web/business-client.mjs';
import {loadCatalog,CatalogBootstrap} from '../web/catalog-live.mjs';
const response=(value,status=200)=>new Response(JSON.stringify(value),{status});
const storage=()=>{const m=new Map();return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};

test('config body abort retries through the actual client/catalog chain',async()=>{
 let calls=0;const client=new BusinessClient({storage:storage(),fetcher:async()=>++calls===1?{ok:true,status:200,json:async()=>{throw new DOMException('body aborted','AbortError');}}:response({deviceId:'mac'})});
 const value=await loadCatalog((...a)=>client.api(...a),'/api/queue/config',{sleep:async()=>{}});
 assert.equal(value.deviceId,'mac');assert.equal(calls,2);
});
test('a body abort after a write keeps its identity and is never automatically replayed',async()=>{
 let calls=0;const client=new BusinessClient({storage:storage(),sleep:async()=>{},fetcher:async()=>{calls++;return{ok:true,status:200,json:async()=>{throw new DOMException('aborted','AbortError');}};}});
 await assert.rejects(client.job('/api/conversations/chat/queue',{text:'test'},{writing:true}),{code:'network_unavailable',uncertain:true});
 assert.equal(calls,1);assert(client.pending('/api/conversations/chat/queue').id);
});
test('only an explicit pre-admission source rejection retries the same queue identity',async()=>{
 const writes=[],waits=[];let deferred=0;const client=new BusinessClient({storage:storage(),sleep:async ms=>waits.push(ms),fetcher:async(route,options)=>{
  if(route.endsWith('/queue')){writes.push(JSON.parse(options.body));return writes.length<3?response({code:'catalog_source_stale'},409):response({id:'job'});}
  return response({state:'succeeded',resultAvailable:true,result:{ok:true}});
 }});
 assert.deepEqual(await client.job('/api/conversations/chat/queue',{text:'test'},{writing:true,onDeferred:()=>deferred++}),{ok:true});
 assert.equal(writes.length,3);assert.equal(new Set(writes.map(v=>v.clientIntentId)).size,1);assert.equal(deferred,2);assert.deepEqual(waits,[500,1000]);
});
test('source retries are bounded; auth, archive, and other operations never retry',async()=>{
 for(const [route,code,status]of[['/api/conversations/chat/queue','login_required',401],['/api/conversations/chat/queue','queue_scope_rejected',403],['/api/conversations/chat/queue/cancel','catalog_source_stale',409]]){
  let calls=0;const client=new BusinessClient({storage:storage(),sleep:async()=>{},fetcher:async()=>{calls++;return response({code},status);}});
  await assert.rejects(client.job(route,{text:'test'},{writing:true}),{code});assert.equal(calls,1);
 }
 let calls=0;const client=new BusinessClient({storage:storage(),sleep:async()=>{},fetcher:async()=>{calls++;return response({code:'catalog_source_stale'},409);}});
 await assert.rejects(client.job('/api/conversations/chat/queue',{text:'test'},{writing:true}),{code:'catalog_source_stale'});assert.equal(calls,16);
});
test('an observed receipt cancels deferred source retry without another POST',async()=>{
 let calls=0,confirm,release;const gate=new Promise(r=>release=r),client=new BusinessClient({storage:storage(),sleep:()=>gate,fetcher:async()=>{calls++;return response({code:'catalog_source_stale'},409);}});
 const pending=client.job('/api/conversations/chat/queue',{text:'test'},{writing:true,confirmation:()=>({promise:new Promise(r=>confirm=r),close(){}})});
 await new Promise(r=>setTimeout(r,15));confirm({receipt:{intentId:'accepted'}});await pending;release();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
});
test('bootstrap recovers transient initialization loss without login or duplicate initialization',async()=>{
 let calls=0,retry;const errors=[],b=new CatalogBootstrap({initialize:async()=>{if(++calls===1)throw{code:'network_unavailable'};},onError:e=>errors.push(e.code),schedule:fn=>retry=fn,cancel:()=>{}});
 const first=b.connect();assert.equal(b.connect(),first);assert.equal(await first,false);assert.equal(calls,1);retry();await b.pending;assert.equal(calls,2);assert.deepEqual(errors,['network_unavailable']);b.stop();
 let scheduled=false;const auth=new CatalogBootstrap({initialize:async()=>{throw{code:'login_required',status:401};},onError:()=>{},schedule:()=>scheduled=true,cancel:()=>{}});assert.equal(await auth.connect(),false);assert(!scheduled);auth.stop();
});
test('browser default timers retain their Window receiver during bootstrap recovery',async()=>{
 const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;let scheduled=false;
 globalThis.setTimeout=function(){assert.equal(this,globalThis);scheduled=true;return 1;};globalThis.clearTimeout=function(){assert.equal(this,globalThis);};
 try{const b=new CatalogBootstrap({initialize:async()=>{throw{code:'network_unavailable'};},onError:()=>{}});await b.connect();assert(scheduled);b.stop();}finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});
