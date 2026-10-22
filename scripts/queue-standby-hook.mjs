// Project-local lifecycle hook. No desktop socket, native sender or transcript read.
import fs from 'node:fs';
import path from 'node:path';
import { readPrivate } from '../prototype/desktop-companion/src/state.mjs';
import { OwnerInbox } from '../prototype/desktop-companion/src/inbox.mjs';
import { standbyHook } from '../prototype/desktop-companion/src/standby.mjs';
import { desktopProjects } from '../business/src/projects.mjs';
let inbox;
try{
 const config=readPrivate(path.resolve(process.argv[2]),null);
 let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>128*1024)throw Error('hook_input_too_large');}
 const input=JSON.parse(text),id=input.session_id,g=config?.grant;
 const project=g?.mode==='project-readonly'?desktopProjects(config.desktopStateFile).find(p=>p.id===g.projectId&&p.name===g.projectName):null;
 const allowed=g?.mode==='dedicated-test'?id===g.conversationId:project?.threadIds.includes(id)&&g.conversations.some(c=>c.id===id&&!c.archived);
 if(!allowed||!config.standby?.threadIds?.includes(id)||!['Stop','Interrupt'].includes(input.hook_event_name))process.stdout.write('{}\n');
 else{
  const runtime=path.join(config.runtime,id),file=path.join(runtime,'inbox.sqlite');
  if(!fs.existsSync(file))process.stdout.write('{}\n');
  else{inbox=new OwnerInbox({runtime,threadId:id});inbox.event('standby.hook_seen',{},input.hook_event_name+':'+String(input.turn_id??''));process.stdout.write(JSON.stringify(standbyHook(inbox,input,{executionMode:config.executionMode??'readonly'}))+'\n');}
 }
}catch{process.stdout.write('{}\n');process.stderr.write('queue_standby_hook_unavailable\n');}
finally{inbox?.close();}
