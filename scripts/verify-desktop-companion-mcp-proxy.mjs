// Read-only real-MCP initialization test. Run from the actual dedicated controller.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '../prototype/desktop-companion/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../prototype/desktop-companion/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { control } from '../prototype/desktop-companion/src/control.mjs';
const root=path.resolve(import.meta.dirname,'..'), base=path.join(root,'.runtime/desktop-companion-mcp');
const scopeFile=path.join(base,'scope.json'), scope=JSON.parse(fs.readFileSync(scopeFile));
if(process.env.CODEX_THREAD_ID!==scope.callerThreadId)throw Error('actual_controller_required');
const before=await control(scope.runtime,{operation:'status'});
const client=new Client({name:'rmtcdx-secondary-frontend-acceptance',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'prototype/desktop-companion/src/mcp-server.mjs'),scopeFile],stderr:'pipe'});
let log='';transport.stderr.on('data',data=>{log+=data;});
try{
 await client.connect(transport); const tools=await client.listTools();
 const result=await client.callTool({name:'companion_status',arguments:{},_meta:{'x-codex-turn-metadata':{thread_id:process.env.CODEX_THREAD_ID}}});
 assert.equal(result.isError,undefined);assert.equal(result.structuredContent.ready,true);assert.equal(result.structuredContent.mcpRole,'proxy');assert.equal(result.structuredContent.pid,before.pid);
 await client.close();const after=await control(scope.runtime,{operation:'status'});assert.equal(after.pid,before.pid);assert.equal(after.ready,true);
 const report={recordedAt:new Date().toISOString(),passed:true,ownerPid:before.pid,ownerParentPid:before.parentPid,frontendRole:'proxy',tools:tools.tools.map(t=>t.name),actualCaller:process.env.CODEX_THREAD_ID,ownerRetainedAfterFrontendClose:true};
 fs.writeFileSync(path.join(base,'proxy-acceptance.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}catch(error){fs.writeFileSync(path.join(base,'proxy-failure.log'),log,{mode:0o600});throw error;}finally{await client.close();}
