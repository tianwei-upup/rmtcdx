import { control } from './control.mjs';
import { input, output, fail } from '../../../business/src/contracts.mjs';

// Explicitly enabled ONLY by a loopback test harness, never by the ECS launcher.
export class InboxBusinessAdapter {
  constructor({ runtime, threadId, enableLocalQueueTest = false, call = control }) {
    this.runtime = runtime; this.threadId = threadId; this.call = call; this.enabled = enableLocalQueueTest === true; this.available = false;
    this.projectId = 'rmtcdx-owner-inbox-test';
    this.operations = ['projects.sync','sessions.sync', ...(this.enabled ? ['queue.enqueue','queue.status','queue.cancel','queue.consumer.stop'] : [])];
  }
  async health() {
    try {
      const s = await this.call(this.runtime,{operation:'status'});
      if (s.mode !== 'test' || s.callerThreadId !== this.threadId || s.ownerInbox?.protocolVersion !== 2) fail('precondition_rejected');
      if (!this.stopped) { this.available=true;this.checkedAt=Date.now(); }
    } catch(error) { this.available=false;throw error; }
  }
  async start() { this.stopped=false;await this.health();if(!this.stopped)this.timer=setInterval(()=>void this.health().catch(()=>{}),5000); }
  ready() { return this.available && !this.stopped && Date.now()-this.checkedAt<10000; }
  async stop() { this.stopped=true;clearInterval(this.timer);this.available=false; }
  async execute(operation, params) {
    input(operation, params);
    if (!this.operations.includes(operation) || !this.ready()) fail('precondition_rejected');
    if (operation === 'projects.sync') return { projects: [{ id: this.projectId, name: '专用 Inbox 协议验收', available: true }] };
    if (operation === 'sessions.sync') {
      if (params.projectId !== this.projectId || params.cursor || params.archived) fail('precondition_rejected');
      return { conversations: [{ id: this.threadId, projectId: this.projectId, title: 'rmtcdx companion lifecycle', status: 'idle' }], nextCursor: null };
    }
    if (params.conversationId !== this.threadId) fail('precondition_rejected');
    const operations = { 'queue.enqueue':'inbox_enqueue','queue.status':'inbox_queue_status','queue.cancel':'inbox_cancel','queue.consumer.stop':'inbox_consumer_stop' };
    const {conversationId,...args} = params;
    try {
      const result = await this.call(this.runtime,{...args,threadId:this.threadId,operation:operations[operation]});
      const value = operation === 'queue.status' ? {...result,conversationId} : {conversationId,[operation === 'queue.consumer.stop' ? 'consumer':'receipt']:result};
      return output(operation,value);
    } catch (error) {
      if (['inbox_intent_conflict','inbox_revision_conflict','inbox_consumer_mismatch','inbox_job_not_found','test_thread_not_allowed','inbox_full'].includes(error.code)) fail('precondition_rejected');
      this.available=false;
      throw error;
    }
  }
}
