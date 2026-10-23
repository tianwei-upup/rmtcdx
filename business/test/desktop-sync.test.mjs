import test from 'node:test';import assert from 'node:assert/strict';
import {DesktopProjection} from '../src/desktop-projection.mjs';
import {DesktopState} from '../web/desktop-live.mjs';
const value=(revision=1)=>({conversationId:'test',epoch:'epoch',revision,available:true,historyComplete:true,items:Array.from({length:120},(_,i)=>({id:'item'+i,kind:'assistant',text:'word'+i})),approvals:[]});
test('desktop history pagination is complete, coherent while live changes arrive, and cursor retries are idempotent',()=>{
 const p=new DesktopProjection({conversationIds:['test']});p.update(value());const first=p.read('test');assert.equal(first.items.length,50);p.update({...value(2),items:[{id:'new',kind:'assistant',text:'new'}]});
 const second=p.read('test',{cursor:first.nextCursor});assert.equal(second.revision,1);assert.deepEqual(p.read('test',{cursor:first.nextCursor}).items,second.items);const third=p.read('test',{cursor:second.nextCursor});assert.equal(third.items.length,20);assert.equal(third.nextCursor,null);assert.equal([...first.items,...second.items,...third.items].length,120);
 assert.throws(()=>p.read('foreign'));assert.throws(()=>p.update({...value(),conversationId:'foreign'}));
});
test('RAM projection emits native item updates and invalidates epoch/offline approval state',()=>{
 const p=new DesktopProjection({conversationIds:['test']}),events=[];p.subscribe('test',e=>events.push(e));p.update(value());const state=new DesktopState();state.snapshot(p.read('test',{pageSize:200}));
 const next=value(2);next.items[0].text='native longer text';p.update(next);const change=events.at(-1);assert.equal(change.items.length,1);assert(state.update(change));assert.equal(state.list()[0].text,'native longer text');
 assert(!state.update({...change,baseRevision:0,revision:3}));p.invalidate('test');assert.equal(events.at(-1).available,false);state.invalidate('offline');assert.deepEqual(state.approvals,[]);assert(!state.available);
 p.close();assert.equal(p.states.size,0);assert.equal(p.pages.size,0);
});
test('capacity and native duplicate IDs fail closed, history completeness is never invented',()=>{
 const p=new DesktopProjection({conversationIds:['test'],maxBytes:500});assert.throws(()=>p.update(value()));
 assert.throws(()=>p.update({...value(),items:[{id:'same'},{id:'same'}]}));
 const s=new DesktopState();s.snapshot({...value(),historyComplete:false});assert.equal(s.historyComplete,false);assert(!s.update({...value(2),baseRevision:1,epoch:'changed',order:[]}));
});
test('an epoch reset during history loading never re-enables stale approvals',async()=>{
 const {DesktopLive}=await import('../web/desktop-live.mjs');let release,calls=0;const seen=[];
 const live=new DesktopLive({route:'/test',api:async()=>{calls++;if(calls===1)return new Promise(r=>{release=r;});return {...value(2),epoch:'new',available:false,items:[],approvals:[]};},onChange:s=>seen.push({epoch:s.epoch,available:s.available,approvals:s.approvals.length}),onError:e=>{throw e;}});
 const loading=live.refresh();live.generation++;release({...value(),approvals:[{id:'stale'}]});await loading;await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert(seen.every(s=>s.epoch!=='epoch'));assert.equal(live.state.available,false);assert.deepEqual(live.state.approvals,[]);live.close();
});
test('failed initial history automatically recovers without SSE reconnect or manual refresh',async()=>{
 const {DesktopLive}=await import('../web/desktop-live.mjs');let calls=0,retry;const seen=[];
 const live=new DesktopLive({route:'/test',api:async()=>{if(++calls===1)throw Error('network unavailable');return value();},onChange:s=>seen.push(s.available),onError:()=>{},schedule:fn=>(retry=fn,1),cancel:()=>{retry=null;}});
 try{await live.refresh();assert.equal(calls,1);assert.equal(typeof retry,'function');retry();await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(live.state.historyComplete,true);assert.equal(seen.at(-1),true);}finally{live.close();}
});
test('unavailable initial history is retried and closing cancels scheduled recovery',async()=>{
 const {DesktopLive}=await import('../web/desktop-live.mjs');let calls=0,retry,cancelled=false;
 const live=new DesktopLive({route:'/test',api:async()=>({...value(),available:false,historyComplete:false}),onChange:()=>{calls++;},onError:()=>{},schedule:fn=>(retry=fn,1),cancel:()=>{cancelled=true;}});
 await live.refresh();assert.equal(typeof retry,'function');live.close();assert(cancelled);retry();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
});
test('repeated identical offline reset caused by a history read cannot create a refresh storm',async()=>{
 const {DesktopLive}=await import('../web/desktop-live.mjs');let calls=0;const source={close(){}};let retry;
 const live=new DesktopLive({route:'/test',eventSource:()=>source,api:async()=>{calls++;if(calls<=4)source.onmessage({data:JSON.stringify({type:'desktop.reset',epoch:'epoch',revision:1,available:false,reason:'desktop_disconnected'})});return {...value(),available:false};},onChange:()=>{},onError:()=>{},schedule:fn=>(retry=fn,1),cancel:()=>{}}).start();
 try{await live.refresh();await new Promise(r=>setImmediate(r));assert(calls<=2,'Repeated offline reset immediately retried '+calls+' times');assert.equal(typeof retry,'function');}finally{live.close();}
});
test('a failed later page retries a coherent full history and never publishes its partial prefix',async()=>{
 const {DesktopLive}=await import('../web/desktop-live.mjs');let calls=0,retry;const seen=[];
 const live=new DesktopLive({route:'/test',api:async()=>{calls++;if(calls===1)return {...value(),items:value().items.slice(0,50),nextCursor:'page2'};if(calls===2)throw Error('body aborted');return value();},onChange:s=>seen.push({available:s.available,items:s.list().length}),onError:()=>{},schedule:fn=>(retry=fn,1),cancel:()=>{}});
 try{await live.refresh();assert(seen.every(s=>!s.available));retry();await new Promise(r=>setImmediate(r));assert.equal(live.state.list().length,120);assert.equal(live.state.historyComplete,true);assert.equal(calls,3);}finally{live.close();}
});
test('offline reset deduplication never hides a new disconnect after recovery at the same revision',async()=>{
 const {DesktopLive}=await import('../web/desktop-live.mjs');const source={close(){}};let available=false;const observations=[];
 const live=new DesktopLive({route:'/test',eventSource:()=>source,api:async()=>({...value(),available}),onChange:s=>observations.push(s.available),onError:()=>{},schedule:()=>1,cancel:()=>{}}).start();
 const reset=()=>source.onmessage({data:JSON.stringify({type:'desktop.reset',epoch:'epoch',revision:1,available:false,reason:'desktop_disconnected'})});
 try{reset();await new Promise(r=>setImmediate(r));available=true;await live.refresh();assert(live.state.available);available=false;reset();assert.equal(observations.at(-1),false);await new Promise(r=>setImmediate(r));assert.equal(live.state.available,false);}finally{live.close();}
});
test('direct user identity places a single phone bubble and keeps genuine native output',async()=>{
 const {mergeDesktopQueue}=await import('../web/desktop-merge.mjs');const receipt={intentId:'p',state:'leased',consumerTurnId:'t'};
 const user={id:'u',kind:'user',turnId:'t',text:'same body',queueLinks:[{intentId:'p',phase:'received'}]},reply={id:'a',kind:'assistant',turnId:'t',text:'real native delta'};
 const merged=mergeDesktopQueue([user,reply],[receipt]);assert.equal(merged.length,2);assert.equal(merged[0].native,true);assert.equal(merged[0].hasNativeReply,true);assert.deepEqual(merged[1],reply);
 const noProof=mergeDesktopQueue([{...user,queueLinks:undefined},reply],[receipt]);assert.equal(noProof.length,3);
});
test('native admission cannot present an unsupported stop action as available',async()=>{
 const {QueueState}=await import('../web/queue-state.mjs');const state=new QueueState();state.nativeDirect=true;assert(state.canCancel({state:'queued'}));assert(!state.canCancel({state:'leased'}));state.nativeDirect=false;assert(state.canCancel({state:'leased'}));
});
