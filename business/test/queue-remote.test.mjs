import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createBusinessServer } from '../src/server.mjs';
import { queueTestScope } from '../src/queue-scope.mjs';
const grant={mode:'dedicated-test',deviceId:'queue-mac',projectId:'queue-project',conversationId:'queue-chat'};
test('remote queue grant requires explicit exact scope and HTTPS',async()=>{
  assert.equal(queueTestScope(null),null);assert.throws(()=>queueTestScope({...grant,mode:'all'}));assert.throws(()=>queueTestScope({...grant,extra:'*'}));
  await assert.rejects(createBusinessServer({origin:'http://localhost',queueTestScope:grant}),{code:'dedicated_queue_https_required'});
});
test('HTTPS queue service admits only the granted project, device and conversation; old native writes stay closed',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remote-queue-'));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(root,'key'),'-out',path.join(root,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  const cert=fs.readFileSync(path.join(root,'cert')),password='queue-test-password-at-least-24-chars',origin='https://localhost:3230',stateFile=path.join(root,'server.json');
  const server=await createBusinessServer({origin,password,stateFile,queueTestScope:grant,claimWaitMs:10,tls:{key:fs.readFileSync(path.join(root,'key')),cert}});
  const port=(await server.listen(0)).port;let cookie='',token='';
  t.after(async()=>{await server.close();fs.rmSync(root,{recursive:true,force:true});});
  async function api(route,data,agent=false){return new Promise((resolve,reject)=>{const req=https.request({hostname:'localhost',port,path:route,method:data===undefined?'GET':'POST',ca:cert,headers:{'content-type':'application/json',...(agent?{'x-device-id':grant.deviceId,authorization:'Bearer '+token}:{origin,cookie})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();if(route==='/api/login')cookie=res.headers['set-cookie'][0].split(';')[0];resolve({status:res.statusCode,value:res.headers['content-type'].includes('json')?JSON.parse(raw):raw});});});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));});}
  assert.equal((await api('/api/queue/config')).status,401);
  await api('/api/login',{username:'admin',password});assert.deepEqual((await api('/api/queue/config')).value,{...grant,protocolVersion:2});
  assert.equal((await api('/devices/foreign/')).status,404);assert.match((await api('/')).value,/专用测试队列/);
  assert.equal((await api('/api/pairing',{deviceId:'foreign',name:'wrong'})).status,403);
  const pair=(await api('/api/pairing',{deviceId:grant.deviceId,name:'test'})).value;
  token=(await api('/api/agent/pair',{deviceId:grant.deviceId,code:pair.code},true)).value.token;
  await api('/api/agent/heartbeat',{active:[],ready:true},true);
  assert.equal((await api('/api/agent/tasks/claim',{accepts:['turn.start']},true)).status,400);
  const uuid=()=>crypto.randomUUID();
  async function finish(route,data,operation,result){const accepted=await api(route,{...data,clientIntentId:uuid()});assert.equal(accepted.status,202,JSON.stringify(accepted.value));const task=(await api('/api/agent/tasks/claim',{accepts:[operation]},true)).value.task;await api('/api/agent/tasks/'+task.id+'/ack',{leaseToken:task.leaseToken},true);const done=await api('/api/agent/tasks/'+task.id+'/result',{leaseToken:task.leaseToken,state:'succeeded',result},true);assert.equal(done.status,200,JSON.stringify(done.value));return (await api('/api/jobs/'+task.id)).value;}
  await finish('/api/devices/queue-mac/sync',{resource:'directory'},'directory.sync',{projects:[{id:grant.projectId,name:'test'}],directories:[{projectId:grant.projectId,conversations:[{id:grant.conversationId,projectId:grant.projectId,title:'test',status:'idle'}],nextCursor:null}]});
  assert.equal((await api('/api/devices/foreign/projects')).status,404);
  assert.equal((await api('/api/devices/queue-mac/conversations?projectId=foreign')).status,404);
  assert.equal((await api('/api/devices/queue-mac/conversations',{projectId:grant.projectId,clientIntentId:uuid()})).status,403);
  assert.equal((await api('/api/conversations/queue-chat/turns',{text:'never native',clientIntentId:uuid()})).status,403);
  assert.equal((await api('/api/conversations/foreign/queue',{text:'never enqueue',clientIntentId:uuid()})).status,404);
  const pending=await api('/api/devices/queue-mac/sync',{resource:'projects',clientIntentId:uuid()});const task=(await api('/api/agent/tasks/claim',{accepts:['projects.sync']},true)).value.task;await api('/api/agent/tasks/'+task.id+'/ack',{leaseToken:task.leaseToken},true);
  assert.equal((await api('/api/agent/tasks/'+task.id+'/result',{leaseToken:task.leaseToken,state:'succeeded',result:{projects:[{id:'foreign',name:'must reject'}]}},true)).status,409);
  await api('/api/agent/tasks/'+task.id+'/result',{leaseToken:task.leaseToken,state:'succeeded',result:{projects:[{id:grant.projectId,name:'test'}]}},true);
  const receipt={intentId:uuid(),threadId:grant.conversationId,state:'queued',revision:1,cancelRequested:false,consumerTurnId:null,sessionId:null,outcomeUncertain:false};
  // Enqueue intent must equal the submitted durable identity, not an executor substitution.
  const accepted=await api('/api/conversations/queue-chat/queue',{clientIntentId:receipt.intentId,text:'PRIVATE-CLOUD-QUEUE'});assert.equal(accepted.status,202);
  const lease=(await api('/api/agent/tasks/claim',{accepts:['queue.enqueue']},true)).value.task;await api('/api/agent/tasks/'+lease.id+'/ack',{leaseToken:lease.leaseToken},true);
  assert.equal((await api('/api/agent/tasks/'+lease.id+'/result',{leaseToken:lease.leaseToken,state:'succeeded',result:{conversationId:grant.conversationId,receipt:{...receipt,intentId:'wrong'}}},true)).status,409);
  assert.equal((await api('/api/agent/tasks/'+lease.id+'/result',{leaseToken:lease.leaseToken,state:'succeeded',result:{conversationId:grant.conversationId,receipt}},true)).status,200);
  assert.equal((await api('/api/jobs/'+accepted.value.id)).value.result.receipt.state,'queued');
  assert(!fs.readFileSync(stateFile,'utf8').includes('PRIVATE-CLOUD-QUEUE'));
});
