import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter}from'node:events';import{DesktopPublisher}from'../src/desktop-publisher.mjs';
test('lazy cloud demand observes only the selected allowed chat; membership removal closes its observer',async()=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-publisher-'));let demand=[],allowed=true,releaseClaim;const streams=[],routes=[];
 class Stream extends EventEmitter{constructor(o){super();Object.assign(this,o);this.epoch='native';this.revision=1;this.state={id:o.conversationId,cwd:o.expectedCwd,turns:[],requests:[],turnsPagination:{hasMore:false}};}async start(){this.ready=true;this.emit('state');}close(){this.ready=false;this.closed=true;this.emit('unavailable');}}
 const call=async(route)=>{routes.push(route);if(route.endsWith('/claim'))return new Promise(r=>releaseClaim=r);return {ok:true,conversationIds:demand};};
 const p=new DesktopPublisher({runtime,lazy:true,chats:[{id:'a',cwd:'/a',approvals:false},{id:'b',cwd:'/b',approvals:false}],isAllowed:()=>allowed,call,streamFactory:o=>{const s=new Stream(o);streams.push(s);return s;}});
 try{await p.start();assert.equal(streams.length,0);demand=['a'];await p.maintain();await new Promise(r=>setImmediate(r));assert.equal(streams.length,1);assert.equal(streams[0].conversationId,'a');allowed=false;await p.maintain();assert(streams[0].closed);assert.equal(p.entries.size,0);assert(!routes.some(r=>/start|steer|interrupt/.test(r)));}
 finally{const stopping=p.stop();releaseClaim?.({intent:null});await stopping;fs.rmSync(runtime,{recursive:true,force:true});}
});
test('ownerless read demand prepares only that allowed history; generic failures never navigate',async()=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-demand-'));const prepared=[];let finish;
 class Stream extends EventEmitter{constructor(o){super();Object.assign(this,o);this.epoch='e';this.revision=-1;}async start(){throw Object.assign(Error(),{code:this.conversationId==='a'?'desktop_owner_unavailable':'desktop_snapshot_timeout'});}close(){this.ready=false;}}
 const p=new DesktopPublisher({runtime,lazy:true,chats:[{id:'a',cwd:'/a',approvals:false},{id:'b',cwd:'/b',approvals:false},{id:'denied',cwd:'/c',approvals:false}],isAllowed:c=>c.id!=='denied',prepareHistory:async c=>prepared.push(c.id),call:async route=>route.endsWith('/claim')?new Promise(r=>finish=r):{conversationIds:['a','b','denied']},streamFactory:o=>new Stream(o)});
 try{await p.start();await p.maintain();await new Promise(r=>setImmediate(r));assert.deepEqual(prepared,['a']);assert.equal(p.entries.has('denied'),false);}finally{const stop=p.stop();finish?.({});await stop;fs.rmSync(runtime,{recursive:true,force:true});}
});
test('a missing cloud snapshot republishes a ready local stream even without a new native revision',async()=>{
 const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-resync-'));let finish,resync=false;const projections=[];
 class Stream extends EventEmitter{constructor(o){super();Object.assign(this,o);this.epoch='e';this.revision=1;this.state={id:o.conversationId,cwd:o.expectedCwd,turns:[],requests:[],turnsPagination:{hasMore:false}};}async start(){this.ready=true;this.emit('state');}close(){this.ready=false;}}
 const p=new DesktopPublisher({runtime,lazy:true,chats:[{id:'a',cwd:'/a',approvals:false}],streamFactory:o=>new Stream(o),call:async(route,data)=>{if(route.endsWith('/claim'))return new Promise(r=>finish=r);if(route.endsWith('/projection'))projections.push(data.view);return{conversationIds:['a'],resyncIds:resync?['a']:[]};}});
 try{await p.start();await p.maintain();await new Promise(r=>setImmediate(r));await p.flush(p.entries.get('a'));const count=projections.length;resync=true;await p.maintain();await p.flush(p.entries.get('a'));assert.equal(projections.length,count+1);assert.equal(projections.at(-1).revision,1);}finally{const stopped=p.stop();finish?.({});await stopped;fs.rmSync(runtime,{recursive:true,force:true});}
});
