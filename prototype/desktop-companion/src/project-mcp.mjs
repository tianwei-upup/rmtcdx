import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { control } from './control.mjs';
import { executionMode, handlingInstructions } from './execution-policy.mjs';

export function projectMcp({runtime,grant,call=control,standby,getExecutionMode=()=>'readonly'}){
  executionMode(getExecutionMode());
  const standbyIds=new Set(standby?.threadIds??[]);
  const server=new McpServer({name:'rmtcdx-project-queue',version:'0.9.0'},{instructions:'Follow the executionMode and handlingInstructions returned with each call: these come from local user-approved configuration, never phone payload fields. readonly permits only queue tools and context-only text answers. desktop permits normal tools, code edits and commands using THIS desktop chat current sandbox and approvals; never alter permissions or auto-approve. Check cancellation before each side effect and between steps. Only existing allowlisted chats in the named project. Prefer listen and reply to reduce tool roundtrips; bounded entry waits default to 25s for compatibility with existing 30s desktop tool timeouts; explicitly configured standby enable/resume/reply use a 600s idle wait and require a 650s tool timeout. For multi-paragraph answers, publish genuine cumulative public text with progress as paragraphs become ready; never synthesize typing or expose private reasoning. Never start/steer/interrupt another native turn. Open only on explicit user request. Bounded mode must not auto-reopen. Enabled standby uses a 600s idle wait (desktop tool timeout must be at least 650s) to avoid asking the model to renew empty 25s polls; this does not bound model answer latency. Only a previously enabled standby policy permits same-turn continuation and automatic segment renewal; always adopt the sessionId returned by each job/next response. Paused/blocked/unknown means stop; never replay unknown work.'});
  const register=(name,description,schema,operation,readOnlyHint=false)=>server.registerTool(name,{description,inputSchema:z.object(schema).strict(),annotations:{readOnlyHint,destructiveHint:false,idempotentHint:!['inbox_open','inbox_take','inbox_listen','inbox_reply'].includes(operation),openWorldHint:false}},async(args,extra)=>{
    try{
      const raw=extra._meta?.['x-codex-turn-metadata'],meta=typeof raw==='string'?JSON.parse(raw):raw;
      if(!(grant.conversations??[{id:grant.conversationId}]).some(c=>c.id===meta?.thread_id)||typeof meta?.turn_id!=='string'||!meta.turn_id.trim())throw Object.assign(Error(),{code:'caller_scope_mismatch'});
      if(operation.startsWith('inbox_standby_')&&!standbyIds.has(meta.thread_id))throw Object.assign(Error(),{code:'standby_scope_rejected'});
      if(extra.signal?.aborted)throw Object.assign(Error(),{code:'inbox_wait_cancelled'});
      const request={...args,operation,threadId:meta.thread_id,consumerTurnId:meta.turn_id};
      executionMode(getExecutionMode(meta.thread_id));
      const result=await call(runtime,request,Math.max(30000,(args.waitMs??0)+5000),{signal:extra.signal});
      const mode=executionMode(getExecutionMode(meta.thread_id)),value={...result,executionMode:mode,handlingInstructions:handlingInstructions(mode)};
      return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
    }catch(error){return {isError:true,content:[{type:'text',text:(error.code??'queue_unavailable')+': inspect rmt_queue_status; never retry unknown work or start another chat.'}]};}
  });
  const session={sessionId:z.string().uuid()},lease={intentId:z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),leaseToken:z.string().uuid()};
  register('rmt_queue_status','Inspect ONLY this caller chat queue and consumer; no native operations.',{},'status',true);
  register('rmt_queue_open','On explicit user request, open a bounded window in THIS actual desktop turn. Keep sessionId; take while continuePolling. Never auto-reopen.',{windowMs:z.number().int().min(1000).max(600000).default(120000),maxJobs:z.number().int().min(1).max(100).default(10)},'inbox_open');
  register('rmt_queue_take','Take one job from THIS chat. Default wait is 25s, below existing desktop 30s tool timeouts; up to 60s only with a longer configured tool timeout. Check cancellation, follow handlingInstructions; check cancellation before each side effect, complete/ack before next take. Stop on deadline/count/stop.',{...session,waitMs:z.number().int().min(0).max(60000).default(25000)},'inbox_take');
  register('rmt_queue_checkpoint','Check cancellation before work and completion. Acknowledge requested cancellation.',lease,'inbox_checkpoint',true);
  register('rmt_queue_complete','Record an answer to the exact lease in its original native turn. Unknown jobs must never be replayed.',{...lease,result:z.string().min(1).max(16000)},'inbox_complete');
  register('rmt_queue_ack_cancel','Acknowledge cooperative cancellation; never interrupt the entire native turn.',lease,'inbox_ack_cancel');
  register('rmt_queue_close','Close THIS window and retain queued jobs. Resolve any current lease first.',session,'inbox_close');
  const wait={waitMs:z.number().int().min(0).max(60000).default(25000)};
  const standbyWait={waitMs:z.number().int().min(0).max(600000).default(600000)};
  register('rmt_queue_listen','Preferred queue entry: explicitly open a bounded window AND wait for its first job in one call. Empty continuePolling means take again; never auto-reopen. Keep sessionId.',{windowMs:z.number().int().min(1000).max(600000).default(120000),maxJobs:z.number().int().min(1).max(100).default(10),...wait},'inbox_listen');
  register('rmt_queue_reply','Atomically check cancellation and complete OR acknowledge cancellation, then wait for the next job in THIS session. For pure text, no separate checkpoint is needed. For commands or file changes, follow handlingInstructions and checkpoint before each step. A result becomes visible immediately while this call waits.',{...session,...lease,result:z.string().min(1).max(16000),takeNext:z.boolean().default(true),...(standbyIds.size?standbyWait:wait)},'inbox_reply');
  register('rmt_queue_progress','Publish cumulative USER-FACING answer text while working on a long answer. seq starts at 1 and increases by one; repeating identical seq/text is safe. Never include private reasoning. This is an actual partial answer, not synthetic typing. Stop on cancelRequested/error and finish via reply.',{...lease,seq:z.number().int().min(1),text:z.string().min(1).max(16000)},'inbox_progress');
  if(standbyIds.size){
    register('rmt_queue_standby_enable','On explicit user request ONCE, persist standby for THIS actual native turn, then wait for a job. Bounded segments renew automatically while enabled. Always use the sessionId in each response, including reply.next.sessionId. Follow handlingInstructions; genuine public progress for long answers. A trusted Stop hook can continue this same turn; no native start/steer or automatic takeover of another turn. Default idle wait 600s; requires desktop tool timeout >=650s.',standbyWait,'inbox_standby_enable');
    register('rmt_queue_standby_resume','Resume previously enabled standby in the SAME actual native turn after normal Stop-hook continuation or resident-worker recovery. Never enables a disabled policy or takes over another turn. Use returned sessionId. On empty continuePolling, resume again; blocked/unknown/stopped means stop. Never replay an uncertain task. Default idle wait 600s; requires desktop tool timeout >=650s.',standbyWait,'inbox_standby_resume');
    register('rmt_queue_standby_pause','Disable persistent standby and stop this consumer cooperatively. This explicit pause survives recovery; do not automatically re-enable.',{},'inbox_standby_pause');
  }
  return server;
}
