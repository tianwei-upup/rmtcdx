import test from 'node:test';
import assert from 'node:assert/strict';
import {QueuePublisher} from '../src/queue-publisher.mjs';
const pause=()=>new Promise(r=>setTimeout(r,30));
test('progress snapshots captured while upload is blocked arrive in order before final',async()=>{
 let notify,current=0,release;const sent=[];
 const p=new QueuePublisher({adapter:{queueIds:()=>['chat'],liveQueueIds:()=>[],subscribeQueue:fn=>(notify=fn,()=>{}),snapshotQueue:async()=>({conversationId:'chat',receipts:[{seq:current}],consumer:null})},call:async(route,value)=>{if(!route.endsWith('/projection'))return;sent.push(value);if(sent.length===1)await new Promise(r=>{release=r;});}});
 await p.start();try{notify('chat');await pause();current=1;notify('chat');await pause();current=2;notify('chat');await pause();current=3;notify('chat');await pause();release();await pause();assert.deepEqual(sent.map(v=>v.receipts[0].seq),[0,1,2,3]);assert.deepEqual(sent.map(v=>v.revision),[1,2,3,4]);}finally{release?.();p.stop();}
});
test('uncertain projection ACK retries the same revision before newer output',async()=>{
 let notify,current=0,fail=true;const sent=[];
 const p=new QueuePublisher({adapter:{queueIds:()=>['chat'],liveQueueIds:()=>[],subscribeQueue:fn=>(notify=fn,()=>{}),snapshotQueue:async()=>({conversationId:'chat',receipts:[{seq:current}],consumer:null})},call:async(route,value)=>{if(!route.endsWith('/projection'))return;sent.push(value);if(fail){fail=false;throw Error('ACK lost');}}});
 await p.start();try{notify('chat');await pause();current=1;notify('chat');await pause();assert.deepEqual(sent.map(v=>v.receipts[0].seq),[0,0,1]);assert.deepEqual(sent.map(v=>v.revision),[1,1,2]);}finally{p.stop();}
});
test('removed membership discards buffered output without publishing it',async()=>{
 let notify,ids=['chat'],release;const sent=[];
 const p=new QueuePublisher({adapter:{queueIds:()=>ids,liveQueueIds:()=>[],subscribeQueue:fn=>(notify=fn,()=>{}),snapshotQueue:async()=>({conversationId:'chat',receipts:[],consumer:null})},call:async(route,value)=>{if(route.endsWith('/projection')){sent.push(value);await new Promise(r=>{release=r;});}}});
 await p.start();try{notify('chat');await pause();ids=[];await p.tick();release();await pause();assert.equal(sent.length,1);assert.equal(p.states.size,0);}finally{release?.();p.stop();}
});
