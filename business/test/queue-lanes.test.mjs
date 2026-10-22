import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {createBusinessServer} from '../src/server.mjs';import {startAgent} from '../src/agent.mjs';
test('a delayed catalog read cannot block queue admission in realtime mode',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'queue-lanes-')),origin='http://127.0.0.1:3230',password='read-delay-test-password-24-characters';
 fs.writeFileSync(path.join(dir,'server.json'),JSON.stringify({version:1,devices:{},jobs:[],projects:{mac:[{id:'project',name:'fixture'}]},conversations:{chat:{id:'chat',deviceId:'mac',projectId:'project'}},turns:{},scopes:{}}),{mode:0o600});
 const server=await createBusinessServer({origin,password,stateFile:path.join(dir,'server.json'),enableLocalQueueTest:true,claimWaitMs:5});const port=(await server.listen(0)).port;let cookie='',release,entered=false,admitted=false,agent;
 const blocked=new Promise(r=>release=r);t.after(async()=>{release();await agent?.stop();await server.close();fs.rmSync(dir,{recursive:true,force:true});});
 const api=async(route,data)=>{const r=await fetch('http://127.0.0.1:'+port+route,{method:data?'POST':'GET',headers:{origin,cookie,'content-type':'application/json'},body:data?JSON.stringify(data):undefined});if(route==='/api/login')cookie=r.headers.get('set-cookie').split(';')[0];assert(r.ok,await r.clone().text());return r.json();};
 await api('/api/login',{username:'admin',password});const pair=await api('/api/pairing',{deviceId:'mac',name:'Mac'});
 const adapter={operations:['projects.sync','queue.enqueue'],start:async()=>{},stop:async()=>{},ready:()=>true,async execute(op,input){if(op==='projects.sync'){entered=true;await blocked;return {projects:[]};}admitted=true;return {conversationId:'chat',receipt:{intentId:input.intentId,threadId:'chat',state:'queued',revision:1,cancelRequested:false,consumerTurnId:null,sessionId:null,outcomeUncertain:false}};}};
 agent=await startAgent({origin:'http://127.0.0.1:'+port,deviceId:'mac',pairCode:pair.code,stateFile:path.join(dir,'agent.json'),adapter,enableLocalQueueTest:true,realtime:true,log(){}});
 await api('/api/devices/mac/sync',{resource:'projects',clientIntentId:crypto.randomUUID()});
 for(let i=0;i<50&&!entered;i++)await new Promise(r=>setTimeout(r,10));assert(entered);
 await api('/api/conversations/chat/queue',{text:'readonly fixture',clientIntentId:crypto.randomUUID()});
 for(let i=0;i<100&&!admitted;i++)await new Promise(r=>setTimeout(r,10));
 assert(admitted,'a stalled catalog read blocked durable queue admission');
});
