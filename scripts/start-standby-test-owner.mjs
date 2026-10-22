// Explicit local-native lifecycle acceptance, not a mock or an ECS executor.
import path from 'node:path';
import { readPrivate, acquireOwner, writePrivate } from '../prototype/desktop-companion/src/state.mjs';
import { ProjectQueue } from '../prototype/desktop-companion/src/project-queue.mjs';
import { serveLocal } from '../prototype/desktop-companion/src/local-server.mjs';
const config=readPrivate(path.resolve(process.argv[2]),null);
if(config?.localOnly!==true||config.grant?.mode!=='dedicated-test'||config.grant.conversationId!=='01a13fef-a018-7303-a2a6-f5903548537f')throw Error('dedicated_local_lifecycle_only');
const release=acquireOwner(config.runtime);let queue,close,stopping;
async function stop(){if(stopping)return stopping;stopping=(async()=>{queue?.stop();await close?.();release();})();return stopping;}
try{
 queue=new ProjectQueue({runtime:config.runtime,grant:config.grant,standby:config.standby});
 close=await serveLocal(config.runtime,queue,()=>void stop().then(()=>process.exit(0)));
 writePrivate(path.join(config.runtime,'worker.json'),{pid:process.pid,startedAt:new Date().toISOString(),localOnly:true,threadId:config.grant.conversationId});
 console.log(JSON.stringify({event:'standby.local.ready',threadId:config.grant.conversationId}));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void stop().then(()=>process.exit(0)));
}catch(error){await stop();throw error;}
