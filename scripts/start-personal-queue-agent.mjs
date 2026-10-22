import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startAgent} from '../business/src/agent.mjs';
import {queueTestScope,queueChats} from '../business/src/queue-scope.mjs';
import {PersonalScope} from '../prototype/desktop-companion/src/personal-scope.mjs';
import {PersonalQueue,PersonalQueueAdapter} from '../prototype/desktop-companion/src/personal-queue.mjs';
import {RolloutHistory} from '../prototype/desktop-companion/src/rollout-history.mjs';
import {ScopedHistoryStream} from '../prototype/desktop-companion/src/scoped-history-stream.mjs';
import {DesktopPublisher} from '../prototype/desktop-companion/src/desktop-publisher.mjs';
import {NativeHistoryQueue} from '../prototype/desktop-companion/src/native-history-queue.mjs';
import {HistoryReceiver} from '../prototype/desktop-companion/src/history-receiver.mjs';
import {personalActivation} from '../prototype/desktop-companion/src/personal-activation.mjs';
import {HistoryInboxReader} from '../prototype/desktop-companion/src/history-inbox-reader.mjs';
import {acquireOwner,readPrivate,writePrivate} from '../prototype/desktop-companion/src/state.mjs';
import {serveLocal} from '../prototype/desktop-companion/src/local-server.mjs';
const config=readPrivate(path.resolve(process.argv[2]),null),scope=new PersonalScope(readPrivate(config.scopeFile,null)),grant=queueTestScope(config.grant),base=readPrivate(config.connectionFile,null),runtime=scope.manifest.runtime;
if(grant.mode!=='personal-projects'||grant.projects.some(p=>p.conversations.some(c=>scope.route(c.id)!==runtime||scope.chats.get(c.id)?.projectId!==p.id))||!base.origin.startsWith('https://'))throw Error('personal_scope_required');
const release=acquireOwner(runtime),log=e=>console.log(JSON.stringify(e)),queue=new PersonalQueue({scope,grant,log}),abort=new AbortController(),exec=promisify(execFile),readers=new Map(),receivers=new Map();let closeLocal,agent,publisher,timer,ticking=false,stopping=false;
const callAdmin=async(route,data,cookie)=>{const r=await fetch(base.origin+route,{method:data===undefined?'GET':'POST',headers:{origin:base.origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('personal_catalog_request_'+r.status);return r;};
async function checkDesktop(){if(JSON.parse(fs.readFileSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-package.json')).version!=='0.163.0-alpha.10.2')throw Error('desktop_build_changed');const {stdout}=await exec('/bin/ps',['-axo','uid=,pid=,comm=']);if(stdout.split('\n').filter(l=>{const m=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(l);return m&&Number(m[1])===process.getuid()&&m[3]==='/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';}).length!==1)throw Error('original_desktop_unavailable');}
async function tick(){if(stopping||ticking)return;ticking=true;try{await checkDesktop();for(const [id]of queue.queues){try{scope.check(id,{write:true});if(!receivers.has(id)){const reader=new HistoryInboxReader({database:path.join(runtime,id,'inbox.sqlite'),conversationId:id});readers.set(id,reader);receivers.set(id,new HistoryReceiver({conversationId:id,nativeQueue:new NativeHistoryQueue({database:path.join(path.dirname(scope.metadataDatabase),'queue_1.sqlite'),runtime:path.join(runtime,'receipts',id),conversationId:id,personalScope:scope,enabled:true}),readQueue:async()=>reader.snapshot(),promptFactory:personalActivation,wake:async chat=>{await checkDesktop();await exec('/usr/bin/open',['-g','-a','/Applications/ChatGPT.app','codex://threads/'+chat],{timeout:5000});},publish:v=>{const old=readPrivate(path.join(runtime,id,'receiver.json'),null);if(JSON.stringify(old?.value)!==JSON.stringify(v)){writePrivate(path.join(runtime,id,'receiver.json'),{value:v,at:Date.now()});log({event:'personal.receiver',conversationId:id,...v});}}}));}await receivers.get(id).tick();}catch(e){if(e.code!=='archived_conversation_readonly')log({event:'personal.receiver.unavailable',conversationId:id,code:e.code??'receiver_unavailable'});}}}catch{}finally{ticking=false;}}
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);abort.abort();await Promise.allSettled([publisher?.stop(),agent?.stop(),...Array.from(receivers.values(),r=>r.pending)]);for(const r of readers.values())r.close();queue.stop();await closeLocal?.();release();}
try{
 closeLocal=await serveLocal(runtime,queue,()=>void stop().then(()=>process.exit(0)));
 const login=await callAdmin('/api/login',{username:'admin',password:base.password}),cookie=login.headers.get('set-cookie').split(';')[0];
 const deployed=await(await callAdmin('/api/queue/config?deviceId='+grant.deviceId,undefined,cookie)).json();const{protocolVersion,desktopSync,desktopConversations,realtime,executionMode,projectCatalog,...g}=deployed;if(JSON.stringify(queueTestScope(g))!==JSON.stringify(grant))throw Error('server_scope_mismatch');
 const stateFile=path.join(runtime,'agent.json');let pairCode;if(!fs.existsSync(stateFile))pairCode=(await(await callAdmin('/api/pairing',{deviceId:grant.deviceId,name:'Mac · 全部本机项目'},cookie)).json()).code;
 agent=await startAgent({origin:base.origin,deviceId:grant.deviceId,stateFile,pairCode,adapter:new PersonalQueueAdapter(queue),queueTestScope:grant,realtime:true});
 const state=readPrivate(stateFile,null),call=async(route,data,timeout=15000)=>{const r=await fetch(base.origin+route,{method:'POST',headers:{'content-type':'application/json','x-device-id':grant.deviceId,authorization:'Bearer '+state.token},body:JSON.stringify(data),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(timeout)])});const result=await r.json();if(!r.ok)throw Object.assign(Error(result.code),{code:result.code,status:r.status});return result;};
 const history=new RolloutHistory(scope),chats=queueChats(grant).map(c=>({...c,cwd:scope.chats.get(c.id).cwd,approvals:!c.archived,mobileReceive:!c.archived}));
 publisher=await new DesktopPublisher({chats,runtime:path.join(runtime,'desktop'),endpoint:'/Users/liutianwei/.codex/ipc/ipc.sock',lazy:true,call,log,isAllowed:c=>{try{scope.check(c.id);return true;}catch{return false;}},streamFactory:o=>new ScopedHistoryStream({...o,scope,history})}).start();
 timer=setInterval(()=>void tick(),1000);await tick();writePrivate(path.join(runtime,'worker.json'),{pid:process.pid,deviceId:grant.deviceId,projects:grant.projects.length,chats:chats.length,startedAt:new Date().toISOString()});log({event:'personal.queue.ready',projects:grant.projects.length,chats:chats.length});
 for(const s of ['SIGTERM','SIGINT'])process.once(s,()=>void stop().then(()=>process.exit(0)));
}catch(e){await stop();throw e;}
