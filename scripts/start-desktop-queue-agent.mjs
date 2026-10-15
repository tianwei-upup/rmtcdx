// This worker uses only the existing MCP private inbox; it never starts Codex.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startAgent } from '../business/src/agent.mjs';
import { queueTestScope } from '../business/src/queue-scope.mjs';
import { InboxBusinessAdapter } from '../prototype/desktop-companion/src/inbox-business-adapter.mjs';
import { privateDirectory, readPrivate, writePrivate } from '../prototype/desktop-companion/src/state.mjs';
const root=path.resolve(import.meta.dirname,'..'),runtime=path.join(root,'.runtime/owner-queue-ecs');privateDirectory(runtime);
const grant=queueTestScope(readPrivate(path.join(runtime,'scope.json'),null));
if(!grant)throw Error('explicit_dedicated_test_scope_required');
const owner=readPrivate(path.join(root,'.runtime/desktop-companion-mcp/scope.json'),null);
if(owner?.mode!=='test'||owner.callerThreadId!==grant.conversationId)throw Error('companion_scope_mismatch');
const base=readPrivate(path.join(root,'.runtime/business-ecs/local.json'),null);
if(!base?.origin?.startsWith('https://'))throw Error('https_required');
const stateFile=path.join(runtime,'agent.json');let pairCode;
if(!fs.existsSync(stateFile)){
  const login=await fetch(base.origin+'/api/login',{method:'POST',headers:{origin:base.origin,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:base.password}),signal:AbortSignal.timeout(15000)});
  if(!login.ok)throw Error('business_login_failed');const cookie=login.headers.get('set-cookie').split(';')[0];
  const pair=await fetch(base.origin+'/api/pairing',{method:'POST',headers:{origin:base.origin,cookie,'content-type':'application/json'},body:JSON.stringify({deviceId:grant.deviceId,name:'Mac 专用测试队列'}),signal:AbortSignal.timeout(15000)});
  if(!pair.ok)throw Error('business_pairing_failed');pairCode=(await pair.json()).code;
}
const adapter=new InboxBusinessAdapter({runtime:owner.runtime,threadId:owner.callerThreadId,queueTestScope:grant});
const agent=await startAgent({origin:base.origin,deviceId:grant.deviceId,stateFile,pairCode,adapter,queueTestScope:grant});
try {
  // Register the exact directory before mobile queries; no chat turn is started.
  const login=await fetch(base.origin+'/api/login',{method:'POST',headers:{origin:base.origin,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:base.password}),signal:AbortSignal.timeout(15000)});
  if(!login.ok)throw Error('catalog_login_failed');const cookie=login.headers.get('set-cookie').split(';')[0];
  const response=await fetch(base.origin+'/api/devices/'+grant.deviceId+'/sync',{method:'POST',headers:{origin:base.origin,cookie,'content-type':'application/json'},body:JSON.stringify({resource:'directory',clientIntentId:crypto.randomUUID()}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('catalog_registration_failed');const job=await response.json();let registered=false;
  for(let i=0;i<80;i++){
    const response=await fetch(base.origin+'/api/jobs/'+job.id,{headers:{cookie},signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('catalog_registration_failed');const current=await response.json();
    if(current.state==='succeeded'){
      const result=current.result;
      if(result?.projects.length!==1||result.projects[0].id!==grant.projectId||result.directories.length!==1||result.directories[0].conversations.length!==1||result.directories[0].conversations[0].id!==grant.conversationId)throw Error('catalog_scope_mismatch');
      registered=true;break;
    }
    if(['unknown','rejected','expired'].includes(current.state))throw Error('catalog_registration_failed');await new Promise(r=>setTimeout(r,250));
  }
  if(!registered)throw Error('catalog_registration_timeout');
}catch(error){await agent.stop();throw error;}
writePrivate(path.join(runtime,'worker.json'),{pid:process.pid,origin:base.origin,deviceId:grant.deviceId,conversationId:grant.conversationId,startedAt:new Date().toISOString()});
console.log(JSON.stringify({event:'queue.worker.ready',deviceId:grant.deviceId,conversationId:grant.conversationId}));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void agent.stop().then(()=>process.exit(0)));
