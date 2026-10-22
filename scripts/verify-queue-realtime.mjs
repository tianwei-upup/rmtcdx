// Read-only evidence collector. Never opens a consumer, sends a job or starts Codex.
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {readPrivate,writePrivate} from '../prototype/desktop-companion/src/state.mjs';
const config=readPrivate(path.resolve(process.argv[2]),null),g=config?.grant;
if(g?.mode!=='dedicated-test'||g.deviceId!=='mac-realtime-test'||g.conversationId!=='01a13feb-ce80-7ca3-aa1e-17814542b353')throw Error('dedicated_realtime_test_only');
const base=readPrivate(config.connectionFile,null);if(!base.origin.startsWith('https://'))throw Error('https_required');
const login=await fetch(base.origin+'/api/login',{method:'POST',headers:{origin:base.origin,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:base.password})});if(!login.ok)throw Error('login_failed');const cookie=login.headers.get('set-cookie').split(';')[0];
const get=async route=>{const r=await fetch(base.origin+route,{headers:{cookie}});if(!r.ok)throw Error('http_'+r.status);return r.json();};
const metrics=await get('/api/conversations/'+g.conversationId+'/queue/metrics'),live=await get('/api/conversations/'+g.conversationId+'/queue/live');
const db=new DatabaseSync(path.join(config.runtime,g.conversationId,'inbox.sqlite'),{readOnly:true}),jobs=db.prepare('SELECT intent_id,state,created_at,consumer_turn,session_id FROM jobs ORDER BY created_at').all(),audit=db.prepare('SELECT intent_id,event,min(at) AS at FROM audit WHERE intent_id IS NOT NULL GROUP BY intent_id,event').all();db.close();
const byIntent=new Map();for(const r of audit){const a=byIntent.get(r.intent_id)??{};a[r.event]=r.at;byIntent.set(r.intent_id,a);}
const stages=jobs.map(j=>{const a=byIntent.get(j.intent_id)??{};return {intentId:j.intent_id,state:j.state,turnId:j.consumer_turn,sessionId:j.session_id,leaseMs:a['job.leased']==null?null:a['job.leased']-j.created_at,modelMs:a['job.completed']==null?null:a['job.completed']-a['job.leased'],totalSourceMs:a['job.completed']==null?null:a['job.completed']-j.created_at,firstOutputMs:(a['job.progress']??a['job.completed'])==null?null:(a['job.progress']??a['job.completed'])-a['job.leased']};});
const stats=values=>{const a=values.filter(x=>Number.isFinite(x)&&x>=0).sort((x,y)=>x-y);return a.length?{count:a.length,min:a[0],p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],max:a.at(-1)}:null;};
const report={at:new Date().toISOString(),deviceId:g.deviceId,conversationId:g.conversationId,phonePhases:metrics.phases,source:{lease:stats(stages.map(s=>s.leaseMs)),model:stats(stages.map(s=>s.modelMs)),total:stats(stages.map(s=>s.totalSourceMs)),firstOutput:stats(stages.map(s=>s.firstOutputMs))},consumer:live.consumer,fresh:live.fresh,stages};
if(process.argv[3])writePrivate(path.resolve(process.argv[3]),report);console.log(JSON.stringify({...report,stages:undefined},null,2));
