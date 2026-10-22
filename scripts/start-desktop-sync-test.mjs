// Dedicated, loopback-only desktop history/stream/approval acceptance.
// Does not change desktop config, queue workers, cloud scopes or other chats.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import crypto from 'node:crypto';
import {DesktopStream} from '../prototype/desktop-companion/src/desktop-stream.mjs';
import {desktopView,DesktopApprovals} from '../prototype/desktop-companion/src/desktop-view.mjs';
import {desktopTestScope} from '../prototype/desktop-companion/src/desktop-test-scope.mjs';
import {DesktopProjection} from '../business/src/desktop-projection.mjs';
import {readPrivate,writePrivate,privateDirectory} from '../prototype/desktop-companion/src/state.mjs';
import {control} from '../prototype/desktop-companion/src/control.mjs';
const config=readPrivate(path.resolve(process.argv[2]),null),{conversationId:id,cwd,title}=desktopTestScope(config);
if(typeof config.password!=='string'||config.password.length<24||!Number.isSafeInteger(config.port)||config.port<1024)throw Error('dedicated_desktop_sync_only');
const runtime=path.resolve(config.runtime);privateDirectory(runtime);const origin='http://127.0.0.1:'+config.port,staticRoot=path.resolve('business/dist'),projection=new DesktopProjection({conversationIds:[id]}),sessions=new Map(),subscribers=new Set(),stats={states:0,patches:0,textUpdates:0,beforeCompletion:0,toolStates:new Set(),requestMethods:new Set()};
let stream,approvals,stopping=false,reconnectTimer,queueRevision=0,lastQueue,queueReading=false;const queueEpoch=crypto.randomUUID(),previousTexts=new Map();
const log=event=>console.log(JSON.stringify(event));
const saveStats=()=>writePrivate(path.join(runtime,'stats.json'),{...stats,toolStates:[...stats.toolStates],requestMethods:[...stats.requestMethods]});
async function connect(){
 if(stopping)return;const candidate=new DesktopStream({endpoint:config.endpoint??'/Users/liutianwei/.codex/ipc/ipc.sock',conversationId:id,expectedCwd:cwd});stream=candidate;
 const ledger=new Map(readPrivate(path.join(runtime,'approval-ledger.json'),[]));approvals=new DesktopApprovals(candidate,{enabled:config.approvals===true,ledger,save:rows=>writePrivate(path.join(runtime,'approval-ledger.json'),[...rows])});
 candidate.on('state',({change})=>{try{stats.states++;if(change.type==='patches')stats.patches++;const view=desktopView(candidate,{approvalLedger:approvals.ledger});for(const item of view.items){if(item.kind==='assistant'&&previousTexts.get(item.id)!==item.text){if(previousTexts.has(item.id)){stats.textUpdates++;if(view.activeTurnId)stats.beforeCompletion++;}previousTexts.set(item.id,item.text);}if(item.kind==='tool')stats.toolStates.add(item.type+':'+item.status);}for(const a of view.approvals)stats.requestMethods.add(a.method);
  if(config.approvals!==true)for(const a of view.approvals)a.canRespond=false;projection.update(view);saveStats();
 }catch(error){log({event:'desktop.projection.failed',conversationId:id,revision:candidate.revision,errorType:error.name,code:error.code??'desktop_projection_failed',message:error.message,stack:error.stack?.split('\n').slice(1,5)});candidate.invalidate(error.code??'desktop_projection_failed');}});
 candidate.on('unavailable',({code})=>{projection.invalidate(id,code);log({event:'desktop.sync.unavailable',code});});
 try{await candidate.start();log({event:'desktop.sync.ready',conversationId:id,revision:candidate.revision});}
 catch(error){candidate.close();log({event:'desktop.sync.unavailable',code:error.code??'desktop_connect_failed'});}
 // Owner loss never triggers a takeover, resume or queued-message replay.
 if(!stopping){clearTimeout(reconnectTimer);reconnectTimer=setInterval(()=>{if(candidate.ready)return;if(stream===candidate){clearInterval(reconnectTimer);candidate.close();void connect();}},3000);}
}
async function queueSnapshot(){const value=await control(config.queueRuntime,{operation:'inbox_queue_status',threadId:id});return {type:'queue.update',conversationId:id,epoch:queueEpoch,revision:++queueRevision,available:true,fresh:true,receipts:value.receipts,consumer:value.consumer};}
const queueTimer=setInterval(async()=>{if(queueReading)return;queueReading=true;try{const value=await queueSnapshot(),signature=JSON.stringify({...value,revision:0});if(signature!==lastQueue){lastQueue=signature;for(const s of subscribers)s.send(value);}}catch{}finally{queueReading=false;}},1000);
async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>32768)throw Error('request_too_large');}return JSON.parse(raw||'{}');}
const assets=new Set(['queue-app.js','queue.css','style.css','queue-state.mjs','queue-live.mjs','business-client.mjs','markdown.mjs','chat-state.mjs','desktop-live.mjs','desktop-history.mjs','desktop-merge.mjs']);
const server=http.createServer(async(req,res)=>{
 const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
 try{
  if(req.headers.host!=='127.0.0.1:'+config.port) return json(403,{code:'host_rejected'});
  const url=new URL(req.url,origin),p=url.pathname;
  if(req.method==='POST'&&req.headers.origin!==origin)return json(403,{code:'origin_rejected'});
  if(req.method==='GET'&&(p==='/'||assets.has(p.slice(1))||/^\/icons\/[a-z-]+\.svg$/.test(p))){const name=p==='/'?'queue.html':p.slice(1),file=path.join(staticRoot,name);res.writeHead(200,{'content-type':name.endsWith('.css')?'text/css':/\.m?js$/.test(name)?'text/javascript':name.endsWith('.svg')?'image/svg+xml':'text/html'});return fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);}
  if(p==='/api/login'&&req.method==='POST'){const input=await body(req);if(typeof input.password!=='string'||input.password.length!==config.password.length||!crypto.timingSafeEqual(Buffer.from(input.password),Buffer.from(config.password)))return json(401,{code:'invalid_credentials'});const token=crypto.randomBytes(32).toString('hex');sessions.set(token,Date.now()+3600000);res.setHeader('set-cookie','rmt-desktop-test='+token+'; HttpOnly; SameSite=Strict; Path=/');return json(200,{ok:true});}
  const token=/(?:^|; )rmt-desktop-test=([^;]+)/.exec(req.headers.cookie??'')?.[1];if(!token||!(sessions.get(token)>Date.now()))return json(401,{code:'authentication_required'});
  if(p==='/api/queue/config')return json(200,{mode:'dedicated-test',deviceId:'local-desktop-sync-test',projectId:'rmtcdx-companion-test',projectName:'专用桌面同步验收',conversationId:id,conversations:[{id,title,archived:false}],realtime:true,desktopSync:true,queueWrites:false});
  if(p==='/api/devices')return json(200,{devices:[{id:'local-desktop-sync-test',online:true,ready:false}]});
  const route='/api/conversations/'+id;
  if(p===route+'/desktop/history'&&req.method==='GET')return json(200,projection.read(id,{cursor:url.searchParams.get('cursor')}));
  if(p===route+'/desktop/approvals'&&req.method==='POST'){const input=await body(req);if(Object.keys(input).some(k=>!['approvalId','decision','intentId'].includes(k)))return json(400,{code:'invalid_fields'});const value=await approvals.respond(input);return json(200,value);}
  if((p===route+'/desktop/events'||p===route+'/queue/events')&&req.method==='GET'){
   res.writeHead(200,{'content-type':'text/event-stream','x-accel-buffering':'no'});const send=value=>{if(res.writableLength>1024*1024)return res.destroy();if(!res.destroyed)res.write('data: '+JSON.stringify(value)+'\n\n');};
   const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},4000);let unsubscribe;
   if(p.includes('/desktop/'))unsubscribe=projection.subscribe(id,send);else {const s={send};subscribers.add(s);unsubscribe=()=>subscribers.delete(s);send(await queueSnapshot());}
   req.on('close',()=>{clearInterval(heartbeat);unsubscribe?.();});return;
  }
  if(p===route+'/queue/live'&&req.method==='GET')return json(200,await queueSnapshot());
  return json(404,{code:'endpoint_not_found'});
 }catch(error){return json(409,{code:error.code??error.message??'desktop_sync_failed'});}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});
writePrivate(path.join(runtime,'server.json'),{pid:process.pid,origin,conversationId:id,localOnly:true});log({event:'desktop.sync.test.listening',origin,conversationId:id});void connect();
async function stop(){if(stopping)return;stopping=true;clearInterval(queueTimer);clearInterval(reconnectTimer);stream?.close();projection.close();server.closeAllConnections();await new Promise(r=>server.close(r));saveStats();process.exit(0);}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void stop());
// Acceptance fault injection closes only this observer, never the desktop.
process.on('SIGUSR1',()=>stream?.close());
