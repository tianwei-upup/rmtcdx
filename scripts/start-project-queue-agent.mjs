// Resident business queue only. No Codex process, desktop pipe or native sender.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startAgent } from '../business/src/agent.mjs';
import { queueTestScope } from '../business/src/queue-scope.mjs';
import { ProjectQueue, ProjectQueueAdapter } from '../prototype/desktop-companion/src/project-queue.mjs';
import { acquireOwner, readPrivate, writePrivate } from '../prototype/desktop-companion/src/state.mjs';
import { serveLocal } from '../prototype/desktop-companion/src/local-server.mjs';
const config=readPrivate(path.resolve(process.argv[2]),null),grant=queueTestScope(config?.grant);
if(!['project-readonly','dedicated-test'].includes(grant?.mode))throw Error('explicit_project_scope_required');
const base=readPrivate(config.connectionFile,null);
if(!base?.origin?.startsWith('https://'))throw Error('https_required');
const release=acquireOwner(config.runtime);
let queue,closeLocal,agent,stopping;
async function stop(){if(stopping)return stopping;stopping=(async()=>{queue?.stop();await closeLocal?.();await agent?.stop();release();})();return stopping;}
try{
  queue=new ProjectQueue({runtime:config.runtime,grant,desktopStateFile:config.desktopStateFile,standby:config.standby,log:event=>console.log(JSON.stringify(event))});
  closeLocal=await serveLocal(config.runtime,queue,()=>void stop().then(()=>process.exit(0)));
  const login=await fetch(base.origin+'/api/login',{method:'POST',headers:{origin:base.origin,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:base.password}),signal:AbortSignal.timeout(15000)});
  if(!login.ok)throw Error('business_login_failed');const cookie=login.headers.get('set-cookie').split(';')[0];
  const api=async(route,data)=>{const r=await fetch(base.origin+route,{method:data===undefined?'GET':'POST',headers:{origin:base.origin,cookie,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('catalog_request_failed_'+r.status);return r.json();};
  // Verify the deployed grant BEFORE pairing or advertising capabilities.
  if(JSON.stringify(queueTestScope(await (async()=>{const {protocolVersion,desktopSync,desktopConversations,realtime,executionMode,projectCatalog,catalogRevision,...scope}=await api('/api/queue/config?deviceId='+grant.deviceId);return scope;})()))!==JSON.stringify(grant))throw Error('server_scope_mismatch');
  const stateFile=path.join(config.runtime,'agent.json');let pairCode;
  if(!fs.existsSync(stateFile))pairCode=(await api('/api/pairing',{deviceId:grant.deviceId,name:'Mac · '+(grant.projectName??'实时性验收')})).code;
  agent=await startAgent({origin:base.origin,deviceId:grant.deviceId,stateFile,pairCode,adapter:new ProjectQueueAdapter(queue),queueTestScope:grant,realtime:config.realtime===true});
  const job=await api('/api/devices/'+grant.deviceId+'/sync',{resource:'directory',clientIntentId:crypto.randomUUID()});let registered=false;
  for(let i=0;i<80;i++){
    const current=await api('/api/jobs/'+job.id);
    if(current.state==='succeeded'){
      const result=current.result,actual=result?.directories?.flatMap(d=>d.conversations)??[],expected=queue.catalog();
      if(result?.projects?.length!==1||result.projects[0].id!==grant.projectId||actual.length!==expected.length||actual.some(c=>!expected.some(e=>e.id===c.id)))throw Error('catalog_scope_mismatch');
      registered=true;break;
    }
    if(['unknown','rejected','expired'].includes(current.state))throw Error('catalog_registration_failed');await new Promise(r=>setTimeout(r,250));
  }
  if(!registered)throw Error('catalog_registration_timeout');
  writePrivate(path.join(config.runtime,'worker.json'),{pid:process.pid,deviceId:grant.deviceId,projectId:grant.projectId,startedAt:new Date().toISOString()});
  console.log(JSON.stringify({event:'project.queue.ready',projectId:grant.projectId,chats:queue.catalog().length}));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void stop().then(()=>process.exit(0)));
}catch(error){await stop();throw error;}
