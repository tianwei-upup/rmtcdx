import path from 'node:path';
import fs from 'node:fs';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {projectMcp} from './project-mcp.mjs';
import {PersonalScope} from './personal-scope.mjs';
import {readPrivate} from './state.mjs';
import {control} from './control.mjs';
const file=path.resolve(process.argv[2]),config=readPrivate(file,null),scope=new PersonalScope(config);
const drains=new Set(['status','inbox_queue_status','inbox_checkpoint','inbox_complete','inbox_reply','inbox_ack_cancel','inbox_cancel','inbox_close']);
const server=projectMcp({runtime:config.manifest.runtime,grant:{conversations:config.manifest.chats},
 getExecutionMode:id=>!id||scope.check(id).archived?'readonly':'desktop',
 call:async(_runtime,request,timeout,options)=>{
  const chat=scope.check(request.threadId,{write:!drains.has(request.operation)}),event={at:new Date().toISOString(),operation:request.operation,threadId:request.threadId,turnId:request.consumerTurnId,projectId:chat.projectId,...(request.intentId?{intentId:request.intentId}:{})};
  try{const result=await control(scope.route(request.threadId),request,timeout,options);if(config.logFile)fs.appendFileSync(config.logFile,JSON.stringify({...event,state:'ok'})+'\n',{mode:0o600});return result;}
  catch(error){if(config.logFile)fs.appendFileSync(config.logFile,JSON.stringify({...event,state:'error',code:error.code??'queue_unavailable'})+'\n',{mode:0o600});throw error;}
 }
});
await server.connect(new StdioServerTransport());
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void server.close());
process.stdin.once('end',()=>void server.close());
