import { OwnerInbox } from './inbox.mjs';
import { InboxConsumer } from './consumer.mjs';
import { failure } from './app-tools.mjs';
import { StandbyPolicy } from './standby.mjs';

// Queue only: no desktop pipe, app-server or native send dependency.
export class InboxService {
  constructor({runtime,threadId,log=()=>{},onChange=()=>{},standby}) {
    this.scope={callerThreadId:threadId}; this.log=log;this.onChange=onChange;
    this.inbox=new OwnerInbox({runtime,threadId}); this.consumer=new InboxConsumer(this.inbox);
    this.inbox.recover(); this.stopped=false;
    this.standby=standby?new StandbyPolicy(this.inbox,standby):null;
  }
  status(){return {...this.inbox.status(),consumer:this.consumer.status(),...(this.standby?{standby:this.standby.status()}: {})};}
  standbySession(turnId){
    return this.inbox.transaction(()=>{
    const row=this.standby.assertTurn(turnId);if(!row)return null;
    this.consumer.expireRows();
    const held=this.inbox.status().inflight;if(held)return {blocked:held};
    let session=this.consumer.view(this.inbox.db.prepare('SELECT * FROM consumers ORDER BY rowid DESC LIMIT 1').get());
    if(session&&['active','stopping'].includes(session.state)){
      if(session.consumerTurnId!==turnId)throw failure('inbox_consumer_already_active');
      if(session.state==='stopping')return null;
    }else session=this.consumer.openRow(turnId,this.standby.windowMs,this.standby.maxJobs);
    this.standby.bind(session.sessionId,turnId);return session;
    });
  }
  async execute(request){const notify=!['inbox_queue_status','inbox_job','inbox_checkpoint'].includes(request.operation),pending=this.dispatch(request);if(notify)this.onChange?.();try{return await pending;}finally{if(notify)this.onChange?.();}}
  async dispatch(request){
    if(this.stopped)throw failure('queue_stopped');
    if(request.threadId!==this.scope.callerThreadId)throw failure('queue_scope_rejected');
    if(request.operation.startsWith('inbox_standby_')){
      if(!this.standby)throw failure('standby_not_enabled_for_scope');
      if(request.operation==='inbox_standby_pause'){
        const policy=this.standby.assertTurn(request.consumerTurnId);this.standby.disable();
        if(policy?.session_id)this.consumer.stop(policy.session_id,'owner_paused',request.consumerTurnId);
        return {status:'stopped',continuePolling:false,standby:this.standby.status()};
      }
      if(!['inbox_standby_enable','inbox_standby_resume'].includes(request.operation))throw failure('unsupported_operation');
      if(request.operation==='inbox_standby_enable')this.standby.enable(request.consumerTurnId);
      const session=this.standbySession(request.consumerTurnId);
      if(!session)return {status:'stopped',continuePolling:false,standby:this.standby.status()};
      if(session.blocked)return {status:'blocked',...session.blocked,continuePolling:false,standby:this.standby.status()};
      return this.execute({...request,operation:'inbox_take',sessionId:session.sessionId});
    }
    if(request.operation==='inbox_progress')return this.inbox.progress(request.intentId,request.leaseToken,request.seq,request.text,request.consumerTurnId);
    if(request.operation==='inbox_listen'){
      const session=this.consumer.open(request.consumerTurnId,request.windowMs,request.maxJobs);this.onChange?.();
      const next=await this.execute({...request,operation:'inbox_take',sessionId:session.sessionId});return {...next,sessionId:session.sessionId};
    }
    if(request.operation==='inbox_reply'){
      this.consumer.get(request.sessionId,request.consumerTurnId);
      const row=this.inbox.owned(request.intentId,request.leaseToken,request.consumerTurnId);if(row.session_id!==request.sessionId)throw failure('inbox_consumer_mismatch');
      const receipt=this.inbox.reply(request.intentId,request.leaseToken,request.result,request.consumerTurnId);this.onChange?.();
      const next=request.takeNext===false?null:await this.execute({...request,operation:'inbox_take'});return {receipt,next};
    }
    if (request.operation === 'inbox_open') return this.consumer.open(request.consumerTurnId, request.windowMs, request.maxJobs);
    if (request.operation === 'inbox_close'||request.operation === 'inbox_consumer_stop') {
      const session=this.consumer.get(request.sessionId,request.operation==='inbox_close'?request.consumerTurnId:undefined);
      const target=this.standby?.stopTarget(request.sessionId,session.turn_id);
      if(target)this.standby.disable('owner_paused');
      return this.consumer.stop(target??request.sessionId,request.operation==='inbox_close'?'owner_closed':'requested',request.operation==='inbox_close'?request.consumerTurnId:undefined);
    }
    if (request.operation === 'inbox_enqueue') return this.inbox.enqueue(request.intentId, request.text);
    if (request.operation === 'inbox_job') return this.inbox.receipt(this.inbox.get(request.intentId));
    if (request.operation === 'inbox_cancel') return this.inbox.cancel(request.intentId, request.expectedRevision);
    if (request.operation === 'inbox_queue_status') return { receipts: request.intentId ? [this.inbox.receipt(this.inbox.get(request.intentId))] : this.inbox.receipts().slice(-100), consumer: this.consumer.status() };
    if (request.operation === 'inbox_checkpoint') return this.inbox.checkpoint(request.intentId, request.leaseToken, request.consumerTurnId);
    if (request.operation === 'inbox_ack_cancel') return this.inbox.ackCancel(request.intentId, request.leaseToken, request.consumerTurnId);
    if (request.operation === 'inbox_take') {
      const standbyWaiting=this.standby?.status().enabled&&this.standby.owns(request.sessionId,request.consumerTurnId);
      const deadline = Date.now() + Math.min(standbyWaiting?600000:60000, Math.max(0, request.waitMs ?? 0));
      let sessionId=request.sessionId;
      this.consumer.waiting(sessionId, request.consumerTurnId, true);this.onChange?.();
      try {
      do {
        if (this.stopped) throw failure('inbox_wait_cancelled');
        if (request.signal?.aborted) { this.consumer.stop(sessionId, 'request_cancelled', request.consumerTurnId); throw failure('inbox_wait_cancelled'); }
        let job = this.consumer.take(sessionId, request.consumerTurnId);
        if(job.status==='stopped'&&this.standby?.owns(sessionId,request.consumerTurnId)&&this.standby.status().enabled){
          const session=this.standbySession(request.consumerTurnId);
          if(session&&!session.blocked){sessionId=session.sessionId;this.consumer.waiting(sessionId,request.consumerTurnId,true);job=this.consumer.take(sessionId,request.consumerTurnId);this.onChange?.();}
        }
        if (job.status !== 'empty' || Date.now() >= deadline) {
          if (job.status === 'empty') this.inbox.event('consumer.empty', {session_id:request.sessionId});
          this.log({ event: 'inbox.take', status: job.status, intentId: job.intentId, consumerThreadId: this.scope.callerThreadId, consumerTurnId: request.consumerTurnId ?? null });
          return {...job,sessionId};
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (true);
      } finally { if (!this.stopped) this.consumer.waiting(sessionId, request.consumerTurnId, false); }
    }
    if (request.operation === 'inbox_complete') {
      const receipt = this.inbox.complete(request.intentId, request.leaseToken, request.result, request.consumerTurnId);
      this.log({ event: 'inbox.completed', intentId: request.intentId, consumerThreadId: this.scope.callerThreadId, consumerTurnId: request.consumerTurnId ?? null });
      return receipt;
    }
    throw failure('unsupported_operation');
  }
  stop(){if(this.stopped)return;this.stopped=true;this.inbox.recover();this.inbox.close();}
}
