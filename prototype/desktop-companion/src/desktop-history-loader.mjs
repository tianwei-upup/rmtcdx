import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { desktopProjects } from '../../../business/src/projects.mjs';
import { HISTORY_QUEUE_TEST_ID, RN_HISTORY_IDS, RN_HISTORY_PROJECT } from './native-history-queue.mjs';
import { assertDesktopCliVersion } from './desktop-runtime.mjs';

const fail=code=>{throw Object.assign(Error(code),{code});};
const exec=promisify(execFile);
// Read-demand entry only. Normal native navigation loads the history owner;
// there is no queued message, execution RPC, desktop launch, or archive write.
export function historyLoader({enabled=false,membership,metadataDatabase,now=Date.now,run=exec,readVersion=()=>JSON.parse(fs.readFileSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-package.json','utf8')).version,projects=desktopProjects,metadata=id=>{
 const db=new DatabaseSync(metadataDatabase,{readOnly:true});try{return db.prepare('SELECT cwd,archived FROM threads WHERE id=?').get(id);}finally{db.close();}
},log=()=>{}}={}){
 const attempts=new Map();let pending=Promise.resolve();
 return chat=>{
  if(enabled!==true)return Promise.resolve();
  const action=async()=>{
   if(chat.mobileReceive!==true||chat.archived===true)return;
   if(chat.id!==HISTORY_QUEUE_TEST_ID){
    if(!RN_HISTORY_IDS.has(chat.id)||membership?.projectId!==RN_HISTORY_PROJECT||membership.projectName!=='壳工程RN UI相关')fail('history_view_scope_rejected');
    const project=projects(membership.stateFile).find(p=>p.id===RN_HISTORY_PROJECT&&p.name===membership.projectName);
    if(!project?.threadIds.includes(chat.id)||!project.paths.includes(chat.cwd))fail('history_view_scope_rejected');
   }
   const row=metadata(chat.id);if(!row||row.cwd!==chat.cwd||row.archived!==0)fail('history_view_scope_rejected');
   if(now()-(attempts.get(chat.id)??-Infinity)<30000)return;
   assertDesktopCliVersion(readVersion());
   const {stdout}=await run('/bin/ps',['-axo','uid=,pid=,comm=']);
   const matches=stdout.split('\n').map(l=>/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(l)).filter(m=>m&&Number(m[1])===process.getuid()&&m[3]==='/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
   if(matches.length!==1)fail('original_desktop_unavailable');
   attempts.set(chat.id,now());
   await run('/usr/bin/open',['-g','-a','/Applications/ChatGPT.app','codex://threads/'+chat.id],{timeout:5000,env:{PATH:'/usr/bin:/bin',HOME:'/Users/liutianwei',LANG:'en_US.UTF-8'}});
   log({event:'desktop.history.view_requested',conversationId:chat.id});
  };
  const result=pending.then(action);pending=result.catch(()=>{});return result;
 };
}
