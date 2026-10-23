import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {startAgent} from '../src/agent.mjs';
import {TaskBoard} from '../src/tasks.mjs';
import {OwnerInbox} from '../../prototype/desktop-companion/src/inbox.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function fixture(t,{existingState}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-shutdown-')),stateFile=path.join(dir,'agent.json');
 const threadId='shutdown-chat',input={conversationId:threadId,intentId:'phone-message',text:'Keep the exact admitted phone body.'};
 const inbox=new OwnerInbox({runtime:path.join(dir,'inbox'),threadId}),board=new TaskBoard();
 const job=board.submit('shutdown-test','queue.enqueue',input,'business-intent');
 const initial={token:'test-only-agent-token',receipts:{},events:[]};
 if(existingState){const receipt=inbox.enqueue(input.intentId,input.text);initial.receipts[job.id]={fingerprint:job.fingerprint,state:existingState,...(existingState==='succeeded'?{result:{conversationId:threadId,receipt}}:{code:'execution_unknown'})};}
 fs.writeFileSync(stateFile,JSON.stringify(initial),{mode:0o600});
 const claim=deferred(),ack=deferred(),execution=deferred(),claimSeen=deferred(),ackSeen=deferred(),executionSeen=deferred();
 let accepting=true,calls=0,claims=0,results=0,ready=false,agent,stopping;
 const requests=[];
 const server=http.createServer(async(req,res)=>{
  try{
   const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
   assert.equal(req.headers.authorization,'Bearer '+initial.token);requests.push(req.url);
   let value={};
   if(req.url==='/api/agent/heartbeat')value={reconcile:[]};
   else if(req.url==='/api/agent/tasks/claim'){
    claims++;const task=board.claim('shutdown-test',body.accepts);claimSeen.resolve();await claim.promise;value={task};
   }else if(req.url===`/api/agent/tasks/${job.id}/ack`){board.ack('shutdown-test',job.id,body.leaseToken);ackSeen.resolve();await ack.promise;}
   else if(req.url===`/api/agent/tasks/${job.id}/result`){results++;value=body.state==='succeeded'?board.complete('shutdown-test',job.id,body.leaseToken,body.result):board.reject('shutdown-test',job.id,body.leaseToken,body.state,body.code);}
   else throw Error('unexpected route '+req.url);
   res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
  }catch(error){res.statusCode=500;res.end(JSON.stringify({code:error.code??error.message}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const adapter={operations:['queue.enqueue'],ready:()=>ready,async start(){ready=true;},async stop(){ready=false;},async execute(operation,params){
  calls++;assert.equal(operation,'queue.enqueue');assert.equal(accepting,true,'quiesced intake must never receive an unexecuted cloud task');
  const receipt=inbox.enqueue(params.intentId,params.text);executionSeen.resolve();await execution.promise;return{conversationId:threadId,receipt};
 }};
 t.after(async()=>{claim.resolve();ack.resolve();execution.resolve();await(stopping??agent?.stop());await new Promise(resolve=>server.close(resolve));inbox.close();fs.rmSync(dir,{recursive:true,force:true});});
 agent=await startAgent({origin:`http://127.0.0.1:${server.address().port}`,deviceId:'shutdown-test',stateFile,adapter,enableLocalQueueTest:true,realtime:true,log(){}});
 return{inbox,board,job,input,claim,ack,execution,claimSeen,ackSeen,executionSeen,requests,
  stop(){accepting=false;stopping??=agent.stop();return stopping;},
  snapshot(){return{calls,claims,results,stored:JSON.parse(fs.readFileSync(stateFile,'utf8')).receipts[job.id],cloud:board.get(job.id)};}};
}

test('shutdown rejects a claim response arriving after quiesce without losing its lease as unknown',{timeout:5000},async t=>{
 const f=await fixture(t);await f.claimSeen.promise;const stopped=f.stop();f.claim.resolve();await f.ackSeen.promise;f.ack.resolve();await stopped;
 const s=f.snapshot();assert.equal(s.calls,0);assert.equal(s.claims,1);assert.equal(s.results,1);assert.equal(s.stored.state,'rejected');assert.equal(s.stored.code,'precondition_rejected');assert.equal(s.cloud.state,'rejected');assert.equal(f.inbox.receipts().length,0);
});
test('shutdown after ACK submission rejects before the first local side effect',{timeout:5000},async t=>{
 const f=await fixture(t);f.claim.resolve();await f.ackSeen.promise;const stopped=f.stop();f.ack.resolve();await stopped;
 const s=f.snapshot();assert.equal(s.calls,0);assert.equal(s.claims,1);assert.equal(s.stored.state,'rejected');assert.equal(s.cloud.state,'rejected');assert.equal(f.inbox.receipts().length,0);
});
test('shutdown waits for an already admitted body and persists its real terminal receipt',{timeout:5000},async t=>{
 const f=await fixture(t);f.claim.resolve();f.ack.resolve();await f.executionSeen.promise;
 const before=f.snapshot();assert.equal(before.stored.state,'unknown');assert.equal(f.inbox.get(f.input.intentId).text,f.input.text);
 const stopped=f.stop();f.execution.resolve();await stopped;
 const s=f.snapshot();assert.equal(s.calls,1);assert.equal(s.claims,1);assert.equal(s.stored.state,'succeeded');assert.equal(s.cloud.state,'succeeded');assert.equal(s.stored.result.receipt.intentId,f.input.intentId);assert.equal(f.inbox.receipts().length,1);
});
for(const state of ['succeeded','unknown'])test(`shutdown retransmits an existing ${state} receipt without executing its body`,{timeout:5000},async t=>{
 const f=await fixture(t,{existingState:state});await f.claimSeen.promise;const original=f.snapshot().stored,stopped=f.stop();f.claim.resolve();f.ack.resolve();await stopped;
 const s=f.snapshot();assert.equal(s.calls,0);assert.equal(s.claims,1);assert.equal(s.results,1);assert.deepEqual(s.stored,original);assert.equal(s.cloud.state,state);assert.equal(f.inbox.receipts().length,1);
});
