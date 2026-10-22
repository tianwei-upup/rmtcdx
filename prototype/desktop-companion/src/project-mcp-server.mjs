import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readPrivate } from './state.mjs';
import { queueTestScope } from '../../../business/src/queue-scope.mjs';
import { projectMcp } from './project-mcp.mjs';
const config=readPrivate(path.resolve(process.argv[2]),null),grant=queueTestScope(config?.grant);
if(!['project-readonly','dedicated-test'].includes(grant?.mode)||!path.isAbsolute(config.runtime))throw Error('explicit_project_scope_required');
// A stateless frontend. Closing this chat never kills the resident queue worker.
const server=projectMcp({runtime:config.runtime,grant,standby:config.standby,getExecutionMode:()=>readPrivate(path.resolve(process.argv[2]),null)?.executionMode??'readonly'});
await server.connect(new StdioServerTransport());
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void server.close());
process.stdin.once('end',()=>void server.close());
