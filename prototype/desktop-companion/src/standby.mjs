import { failure } from './app-tools.mjs';
import { executionMode, handlingInstructions } from './execution-policy.mjs';

// Durable intent in OUR Inbox only. It grants continuation of one actual native
// turn; it never starts, steers, interrupts or takes over a different turn.
export class StandbyPolicy {
  constructor(inbox,{windowMs=600000,maxJobs=100}={}){
    if(!Number.isInteger(windowMs)||windowMs<1000||windowMs>600000||!Number.isInteger(maxJobs)||maxJobs<1||maxJobs>100)throw failure('invalid_standby_segment');
    this.inbox=inbox;this.db=inbox.db;this.windowMs=windowMs;this.maxJobs=maxJobs;
    this.db.exec(`CREATE TABLE IF NOT EXISTS standby_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),enabled INTEGER NOT NULL,turn_id TEXT NOT NULL,session_id TEXT,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,reason TEXT);
      CREATE TABLE IF NOT EXISTS standby_sessions(session_id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,policy_revision INTEGER NOT NULL);`);
  }
  row(){return this.db.prepare('SELECT * FROM standby_policy WHERE singleton=1').get();}
  status(){const r=this.row();return r?{enabled:Boolean(r.enabled),ownerTurnId:r.turn_id,sessionId:r.session_id,revision:r.revision,updatedAt:r.updated_at,reason:r.reason??null}:{enabled:false,ownerTurnId:null,sessionId:null,revision:0,updatedAt:null,reason:null};}
  enable(turnId){
    if(typeof turnId!=='string'||!turnId.trim())throw failure('standby_turn_required');
    return this.inbox.transaction(()=>{
      const row=this.row(),held=this.db.prepare("SELECT state FROM jobs WHERE state IN ('leased','unknown')").get();
      if(held)throw failure('inbox_outcome_unknown');
      const active=this.db.prepare("SELECT turn_id FROM consumers WHERE state IN ('active','stopping')").get();
      if(active&&active.turn_id!==turnId)throw failure('inbox_consumer_already_active');
      if(row?.enabled&&row.turn_id===turnId)return this.status();
      this.db.prepare(`INSERT INTO standby_policy VALUES (1,1,?,NULL,1,?,NULL) ON CONFLICT(singleton) DO UPDATE SET enabled=1,turn_id=excluded.turn_id,session_id=NULL,revision=standby_policy.revision+1,updated_at=excluded.updated_at,reason=NULL`).run(turnId,Date.now());
      this.inbox.event('standby.enabled');return this.status();
    });
  }
  assertTurn(turnId){const r=this.row();if(!r?.enabled)return null;if(r.turn_id!==turnId)throw failure('standby_turn_mismatch');return r;}
  owns(sessionId,turnId){const r=this.row();return Boolean(r&&r.session_id===sessionId&&r.turn_id===turnId);}
  bind(sessionId,turnId){
    const row=this.assertTurn(turnId);if(!row)throw failure('standby_paused');
    this.db.prepare('UPDATE standby_policy SET session_id=?,updated_at=? WHERE singleton=1 AND enabled=1 AND turn_id=?').run(sessionId,Date.now(),turnId);
    this.db.prepare('INSERT OR IGNORE INTO standby_sessions VALUES (?,?,?)').run(sessionId,turnId,row.revision);
  }
  stopTarget(sessionId,turnId){
    const r=this.row();if(!r?.enabled||r.turn_id!==turnId)return null;
    // A phone may still display the previous segment when automatic renewal
    // happens. Stop the same enablement, but fence delayed stops from an older one.
    return this.owns(sessionId,turnId)||this.db.prepare('SELECT 1 FROM standby_sessions WHERE session_id=? AND turn_id=? AND policy_revision=?').get(sessionId,turnId,r.revision)?r.session_id:null;
  }
  disable(reason='owner_paused'){
    return this.inbox.transaction(()=>{
      const row=this.row();
      this.db.prepare('UPDATE standby_policy SET enabled=0,reason=?,revision=revision+1,updated_at=? WHERE singleton=1 AND enabled=1').run(reason,Date.now());
      if(row?.enabled&&row.session_id){
        this.db.prepare("UPDATE consumers SET state='stopping',waiting=0,reason=? WHERE id=? AND state='active'").run(reason,row.session_id);
        this.inbox.finishSession(row.session_id);
      }
      this.inbox.event('standby.paused',{},reason);return this.status();
    });
  }
}

export function standbyHook(inbox,input,{executionMode:mode='readonly'}={}){
  executionMode(mode);
  if(input?.session_id!==inbox.threadId||!['Stop','Interrupt'].includes(input.hook_event_name))return {};
  // An unconfigured scope must not create a policy or influence any turn.
  if(!inbox.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='standby_policy'").get())return {};
  const policy=new StandbyPolicy(inbox),r=policy.row();if(!r?.enabled||input.turn_id!==r.turn_id)return {};
  const held=inbox.db.prepare("SELECT 1 FROM jobs WHERE state IN ('leased','unknown')").get();
  if(input.hook_event_name==='Interrupt'||held){
    const reason=input.hook_event_name==='Interrupt'?'owner_interrupted':'owner_stopped_with_inflight';
    inbox.transaction(()=>{
      inbox.db.prepare('UPDATE standby_policy SET enabled=0,reason=?,revision=revision+1,updated_at=? WHERE singleton=1').run(reason,Date.now());
      for(const job of inbox.db.prepare("SELECT * FROM jobs WHERE state='leased'").all()){
        inbox.db.prepare("UPDATE jobs SET state='unknown',revision=revision+1 WHERE intent_id=?").run(job.intent_id);inbox.event('job.unknown',inbox.get(job.intent_id),reason);
      }
      inbox.db.prepare("UPDATE consumers SET state='closed',waiting=0,reason=? WHERE state IN ('active','stopping')").run(reason);
      inbox.event('standby.paused',{},reason);
    });return {};
  }
  // A broken/missing MCP must not produce an unbounded fast model loop.
  const attempts=inbox.db.prepare("SELECT count(*) AS n FROM audit WHERE event='standby.continued' AND at>?").get(Date.now()-60000).n;
  if(attempts>=6){policy.disable('continuation_retry_limit');return {};}
  inbox.event('standby.continued');
  return {decision:'block',reason:'用户已一次启用本会话的长期手机托管。'+handlingInstructions(mode)+'继续同一个原生 turn，使用 rmt_queue_standby_resume(waitMs=600000) 恢复领取；按返回的 sessionId 处理任务。用 rmt_queue_reply(waitMs=600000) 回答并领取下一条，每次采用 next.sessionId 或 next.session.sessionId；长回答用 progress。没有消息则继续等待，不要结束。若返回 paused/stopped、unknown 或 blocked，则停止并报告，不重放、不另开 native turn。'};
}
