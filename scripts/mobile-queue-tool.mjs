// Compatibility only for a native turn whose already-cached MCP set lacks the
// new frontend. No model process or native send; no caller identity arguments.
import path from 'node:path';
import {readPrivate} from '../prototype/desktop-companion/src/state.mjs';
import {PersonalScope} from '../prototype/desktop-companion/src/personal-scope.mjs';
import {RolloutHistory} from '../prototype/desktop-companion/src/rollout-history.mjs';
import {mobileQueueTool} from '../prototype/desktop-companion/src/mobile-queue-tool.mjs';
try{const scope=new PersonalScope(readPrivate(path.resolve(process.argv[2]),null));const value=await mobileQueueTool({scope,history:new RolloutHistory(scope),threadId:process.env.CODEX_THREAD_ID,activationId:process.argv[3],operation:process.argv[4],args:JSON.parse(process.argv[5]??'{}')});process.stdout.write(JSON.stringify(value)+'\n');}
catch(error){process.stderr.write(JSON.stringify({code:error.code??'queue_unavailable'})+'\n');process.exitCode=1;}
