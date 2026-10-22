import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startAgent} from '../business/src/agent.mjs';
import {queueTestScope,queueChats} from '../business/src/queue-scope.mjs';
import {catalogRevision as catalogHash} from '../business/src/personal-catalog.mjs';
import {personalGrant} from '../prototype/desktop-companion/src/personal-discovery.mjs';
import {PersonalScope} from '../prototype/desktop-companion/src/personal-scope.mjs';
import {PersonalQueue,PersonalQueueAdapter} from '../prototype/desktop-companion/src/personal-queue.mjs';
import {RolloutHistory} from '../prototype/desktop-companion/src/rollout-history.mjs';
import {ScopedHistoryStream} from '../prototype/desktop-companion/src/scoped-history-stream.mjs';
import {DesktopPublisher} from '../prototype/desktop-companion/src/desktop-publisher.mjs';
import {NativeHistoryQueue} from '../prototype/desktop-companion/src/native-history-queue.mjs';
import {HistoryReceiver} from '../prototype/desktop-companion/src/history-receiver.mjs';
import {checkDesktopRuntime,runReceiverTick} from '../prototype/desktop-companion/src/desktop-runtime.mjs';
import {personalActivation,personalActivationV2} from '../prototype/desktop-companion/src/personal-activation.mjs';
import {HistoryInboxReader} from '../prototype/desktop-companion/src/history-inbox-reader.mjs';
import {acquireOwner,readPrivate,writePrivate} from '../prototype/desktop-companion/src/state.mjs';
import {serveLocal} from '../prototype/desktop-companion/src/local-server.mjs';
const config=readPrivate(path.resolve(process.argv[2]),null),scope=new PersonalScope(readPrivate(config.scopeFile,null)),initialGrant=queueTestScope(config.grant),base=readPrivate(config.connectionFile,null),runtime=scope.manifest.runtime;
let grant=scope.manifest.discovery==='local-projects'?queueTestScope(personalGrant(scope,initialGrant.deviceId)):initialGrant;
if(grant.mode!=='personal-projects'||grant.projects.some(p=>p.conversations.some(c=>scope.route(c.id)!==runtime||scope.chats.get(c.id)?.projectId!==p.id))||!base.origin.startsWith('https://'))throw Error('personal_scope_required');
const release=acquireOwner(runtime),log=e=>console.log(JSON.stringify(e)),queue=new PersonalQueue({scope,grant,log}),abort=new AbortController(),exec=promisify(execFile),readers=new Map(),receivers=new Map();let closeLocal,agent,publisher,timer,discoveryTimer,catalogCall,catalogRevision,ticking=false,stopping=false;
const callAdmin=async(route,data,cookie)=>{const r=await fetch(base.origin+route,{method:data===undefined?'GET':'POST',headers:{origin:base.origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('personal_catalog_request_'+r.status);return r;};
function activationText(id,activation){const dir=path.join(runtime,'receipts',id),marker=path.join(dir,activation+'.protocol.json'),old=readPrivate(marker,null);if(old?.version===2)return personalActivationV2(activation);if(fs.existsSync(path.join(dir,activation+'.json')))return personalActivation(activation);writePrivate(marker,{version:2});return personalActivationV2(activation);}
const desktopChats=()=>queueChats(grant).map(c=>({...c,cwd:scope.chats.get(c.id).cwd,approvals:!c.archived&&c.workspaceAvailable!==false,mobileReceive:!c.archived&&c.workspaceAvailable!==false}));
const receiverErrors=new Map();
let discovering=false;
async function discover(){if(stopping||discovering||!catalogCall)return;discovering=true;try{const next=queueTestScope(personalGrant(scope,grant.deviceId)),result=await (catalogHash(next)===catalogRevision?catalogCall('/api/agent/catalog/ping',{revision:catalogRevision}):catalogCall('/api/agent/catalog',{baseRevision:catalogRevision,grant:next}));catalogRevision=result.revision;if(JSON.stringify(next)!==JSON.stringify(grant)){grant=next;queue.updateGrant(grant);writePrivate(path.join(runtime,'catalog.json'),{revision:catalogRevision,projects:grant.projects.length,chats:queueChats(grant).length,at:Date.now()});log({event:'personal.catalog.changed',projects:grant.projects.length,chats:queueChats(grant).length,revision:catalogRevision});}if(publisher&&publisher.catalogRevision!==catalogRevision){await publisher.updateChats(desktopChats());publisher.catalogRevision=catalogRevision;}}catch(e){log({event:'personal.catalog.unavailable',code:e.code??e.message});if(e.code==='catalog_revision_conflict')catalogRevision=(await catalogCall('/api/agent/catalog')).revision;}finally{discovering=false;}}
const checkDesktop=()=>checkDesktopRuntime();
function receiverUnavailable(id,error){
 const code=/^[a-z_]+$/.test(error.code??'')?error.code:'receiver_unavailable';
 const value={state:'unavailable',code,...(code==='desktop_build_changed'?{desktopVersion:error.desktopVersion,supportedVersions:error.supportedVersions}:{})};
 const file=path.join(runtime,id,'receiver.json'),old=readPrivate(file,null),previous=receiverErrors.get(id);
 if(JSON.stringify(old?.value)!==JSON.stringify(value))writePrivate(file,{value,at:Date.now()});
 if(!previous||previous.code!==code||Date.now()-previous.at>60000){receiverErrors.set(id,{code,at:Date.now()});log({at:new Date().toISOString(),event:'personal.receiver.unavailable',conversationId:id,...value});}
}
async function receive(id){
 queue.eligible(id);
 if(!receivers.has(id)){
  const reader=new HistoryInboxReader({database:path.join(runtime,id,'inbox.sqlite'),conversationId:id});readers.set(id,reader);
  receivers.set(id,new HistoryReceiver({conversationId:id,nativeQueue:new NativeHistoryQueue({database:path.join(path.dirname(scope.metadataDatabase),'queue_1.sqlite'),runtime:path.join(runtime,'receipts',id),conversationId:id,personalScope:scope,enabled:true}),readQueue:async()=>reader.snapshot(),promptFactory:activation=>activationText(id,activation),
   wake:async chat=>{await checkDesktop();queue.eligible(chat);await exec('/usr/bin/open',['-g','-a','/Applications/ChatGPT.app','codex://threads/'+chat],{timeout:5000});},
   publish:value=>{const file=path.join(runtime,id,'receiver.json'),old=readPrivate(file,null);if(JSON.stringify(old?.value)!==JSON.stringify(value)){writePrivate(file,{value,at:Date.now()});log({at:new Date().toISOString(),event:'personal.receiver',conversationId:id,...value});}}
  }));
 }
 await receivers.get(id).tick();
 if(receiverErrors.delete(id))log({at:new Date().toISOString(),event:'personal.receiver.recovered',conversationId:id});
}
async function tick(){if(stopping||ticking)return;ticking=true;try{await runReceiverTick({checkDesktop,ids:queue.queues.keys(),receive,unavailable:receiverUnavailable});}finally{ticking=false;}}
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);clearInterval(discoveryTimer);abort.abort();await Promise.allSettled([publisher?.stop(),agent?.stop(),...Array.from(receivers.values(),r=>r.pending)]);for(const r of readers.values())r.close();queue.stop();await closeLocal?.();release();}
try{
 closeLocal=await serveLocal(runtime,queue,()=>void stop().then(()=>process.exit(0)));
 const login=await callAdmin('/api/login',{username:'admin',password:base.password}),cookie=login.headers.get('set-cookie').split(';')[0];
 const deployed=await(await callAdmin('/api/queue/config?deviceId='+grant.deviceId,undefined,cookie)).json();const{protocolVersion,desktopSync,desktopConversations,realtime,executionMode,projectCatalog,catalogRevision:ignoredRevision,...g}=deployed;if(!grant.autoDiscover&&JSON.stringify(queueTestScope(g))!==JSON.stringify(grant))throw Error('server_scope_mismatch');
 const stateFile=path.join(runtime,'agent.json');let pairCode;if(!fs.existsSync(stateFile))pairCode=(await(await callAdmin('/api/pairing',{deviceId:grant.deviceId,name:'Mac · 全部本机项目'},cookie)).json()).code;
 if(grant.autoDiscover){let existing=readPrivate(stateFile,null);if(!existing&&pairCode){const response=await fetch(base.origin+'/api/agent/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:grant.deviceId,code:pairCode}),signal:AbortSignal.timeout(15000)});const paired=await response.json();if(!response.ok||typeof paired.token!=='string')throw Error('discovery_pair_failed');existing={token:paired.token,receipts:{},events:[]};writePrivate(stateFile,existing);}if(!existing?.token)throw Error('discovery_pair_required');catalogCall=async(route,data)=>{const r=await fetch(base.origin+route,{method:data===undefined?'GET':'POST',headers:{'content-type':'application/json','x-device-id':grant.deviceId,authorization:'Bearer '+existing.token},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});const value=await r.json();if(!r.ok)throw Object.assign(Error(value.code),{code:value.code,status:r.status});return value;};catalogRevision=(await catalogCall('/api/agent/catalog')).revision;await discover();}
 agent=await startAgent({origin:base.origin,deviceId:grant.deviceId,stateFile,pairCode,adapter:new PersonalQueueAdapter(queue),queueTestScope:grant,realtime:true});
 const state=readPrivate(stateFile,null),call=async(route,data,timeout=15000)=>{const r=await fetch(base.origin+route,{method:'POST',headers:{'content-type':'application/json','x-device-id':grant.deviceId,authorization:'Bearer '+state.token},body:JSON.stringify(data),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(timeout)])});const result=await r.json();if(!r.ok)throw Object.assign(Error(result.code),{code:result.code,status:r.status});return result;};
 const history=new RolloutHistory(scope),chats=desktopChats();
 publisher=await new DesktopPublisher({chats,runtime:path.join(runtime,'desktop'),endpoint:'/Users/liutianwei/.codex/ipc/ipc.sock',lazy:true,call,log,isAllowed:c=>{try{scope.check(c.id);return true;}catch{return false;}},streamFactory:o=>new ScopedHistoryStream({...o,scope,history})}).start();
 if(grant.autoDiscover)discoveryTimer=setInterval(()=>void discover(),2000);
 timer=setInterval(()=>void tick(),1000);await tick();writePrivate(path.join(runtime,'worker.json'),{pid:process.pid,deviceId:grant.deviceId,projects:grant.projects.length,chats:chats.length,startedAt:new Date().toISOString()});log({event:'personal.queue.ready',projects:grant.projects.length,chats:chats.length});
 for(const s of ['SIGTERM','SIGINT'])process.once(s,()=>void stop().then(()=>process.exit(0)));
}catch(e){await stop();throw e;}
