import {PersonalScope} from '../prototype/desktop-companion/src/personal-scope.mjs';
import {RolloutHistory} from '../prototype/desktop-companion/src/rollout-history.mjs';
import {ScopedHistoryStream} from '../prototype/desktop-companion/src/scoped-history-stream.mjs';
import path from 'node:path';
import { DesktopPublisher } from '../prototype/desktop-companion/src/desktop-publisher.mjs';
import { readPrivate, acquireOwner } from '../prototype/desktop-companion/src/state.mjs';
import { desktopProjects } from '../business/src/projects.mjs';
import { historyLoader } from '../prototype/desktop-companion/src/desktop-history-loader.mjs';
const config=readPrivate(path.resolve(process.argv[2]),null),base=readPrivate(config.connectionFile,null),state=readPrivate(config.agentStateFile,null);
const origin=new URL(base.origin);if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash||!state.token)throw Error('desktop_secure_connection_required');
if(!Array.isArray(config.chats)||!config.chats.length||new Set(config.chats.map(c=>c.id)).size!==config.chats.length||config.chats.some(c=>!c.id||!path.isAbsolute(c.cwd)||typeof c.approvals!=='boolean'))throw Error('desktop_scope_required');
const release=acquireOwner(config.runtime),abort=new AbortController();
const call=async(route,data,timeout=15000)=>{
  const response=await fetch(origin.origin+route,{method:'POST',headers:{'content-type':'application/json','x-device-id':config.deviceId,authorization:'Bearer '+state.token},body:JSON.stringify(data),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(timeout)])});
  const result=await response.json();if(!response.ok)throw Object.assign(Error(result.code),{code:result.code,status:response.status});return result;
};
const isAllowed=chat=>{if(!config.membership)return true;try{const p=desktopProjects(config.membership.stateFile).find(p=>p.id===config.membership.projectId&&p.name===config.membership.projectName);return p?.threadIds.includes(chat.id)===true;}catch{return false;}};
const log=e=>console.log(JSON.stringify(e)),prepareHistory=historyLoader({...config.historyEntry,membership:config.membership,log});
const scope=config.personalScopeFile?new PersonalScope(readPrivate(config.personalScopeFile,null)):null,history=scope?new RolloutHistory(scope):null;
let publisher;try{publisher=await new DesktopPublisher({...config,...(scope?{streamFactory:o=>new ScopedHistoryStream({...o,scope,history}),prepareHistory:undefined}:{}),call,isAllowed,prepareHistory:scope?undefined:prepareHistory,endpoint:config.endpoint??'/Users/liutianwei/.codex/ipc/ipc.sock',log}).start();console.log(JSON.stringify({event:'desktop.publisher.ready',pid:process.pid,chats:config.chats.map(c=>c.id)}));}catch(error){release();throw error;}
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;abort.abort();await publisher.stop();release();};
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void stop().then(()=>process.exit(0)));
