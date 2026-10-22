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
