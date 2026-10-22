import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueProjection } from '../src/queue-projection.mjs';
const a={mode:'dedicated-test',deviceId:'mac',projectId:'project',conversationId:'chat'};
const receipt={intentId:'one',threadId:'chat',state:'queued',revision:1,cancelRequested:false,consumerTurnId:null,sessionId:null,outcomeUncertain:false,text:'private body'};
test('fresh projection supplies reads and live events without business read jobs; stale epochs cannot overwrite it',()=>{
 const p=new QueueProjection({grants:[a],now:()=>1000}),frames=[];
 p.hello('mac','epoch-one');p.subscribe('chat',v=>frames.push(v));
 p.update('mac',{epoch:'epoch-one',revision:1,conversationId:'chat',receipts:[receipt],consumer:null});
 assert.equal(p.read('chat').receipts[0].text,'private body');assert(frames.some(f=>f.type==='queue.update'));
 p.hello('mac','epoch-two');assert.throws(()=>p.update('mac',{epoch:'epoch-one',revision:2,conversationId:'chat',receipts:[receipt],consumer:null}));
 assert.throws(()=>p.update('mac',{epoch:'epoch-two',revision:2,conversationId:'foreign',receipts:[],consumer:null}));
 p.close();
});
test('removing a project member evicts its cached body while other chats stay fresh',()=>{
 const grant={mode:'project-readonly',deviceId:'mac',projectId:'project',projectName:'named',conversations:[{id:'chat',title:'one',archived:false},{id:'other',title:'two',archived:false}]};
 let now=1000;const p=new QueueProjection({grants:[grant],now:()=>now}),frames=[];
 p.hello('mac','epoch',['chat','other']);p.subscribe('chat',v=>frames.push(v));
 p.update('mac',{epoch:'epoch',revision:1,conversationId:'chat',receipts:[receipt],consumer:null});
 p.ping('mac','epoch',['other']);assert.throws(()=>p.read('chat'));assert.equal(p.health('chat').available,false);assert.equal(p.health('other').fresh,true);
 assert.throws(()=>p.update('mac',{epoch:'epoch',revision:2,conversationId:'chat',receipts:[receipt],consumer:null}));assert.throws(()=>p.ping('mac','epoch',['foreign']));assert(frames.at(-1).type==='queue.reset');
 now+=8000;assert.equal(p.health('other').fresh,false);p.close();
});
test('UI confirmation bypasses delayed delivery response without clearing a subsequent intent',async()=>{
 const {BusinessClient}=await import('../web/business-client.mjs');let release;const bodyPending=new Promise(r=>release=r),map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const client=new BusinessClient({storage,fetcher:async()=>{await bodyPending;return {ok:true,json:async()=>({id:'job-one'})};}});
 let confirm,close=false,intentReady;const started=new Promise(r=>intentReady=r);const confirmation=new Promise(r=>confirm=r);
 const first=client.job('/queue',{text:'first'},{writing:true,onIntent:id=>intentReady(id),confirmation:()=>({promise:confirmation,close:()=>close=true})});
 const intentId=await started;confirm({receipt:{intentId,state:'queued'}});await first;assert(close);assert.equal(client.pending('/queue'),null);
 storage.setItem(client.key('/queue'),JSON.stringify({id:'next-intent',signature:'new'}));release();await new Promise(r=>setImmediate(r));assert.equal(client.pending('/queue').id,'next-intent');
});
test('late SSE frames and stale fetches never update another conversation',async()=>{
 const {QueueLive}=await import('../web/queue-live.mjs');let receive,updates=0;
 const source={close(){},readyState:1};const live=new QueueLive({route:'/one',api:async()=>new Promise(r=>receive=r),onUpdate(){updates++;},onHealth(){},eventSource:()=>source}).start();
 live.message({type:'queue.reset',epoch:'epoch'});live.close();receive({epoch:'epoch',revision:1,receipts:[],consumer:null});await new Promise(r=>setTimeout(r,1));assert.equal(updates,0);
});
