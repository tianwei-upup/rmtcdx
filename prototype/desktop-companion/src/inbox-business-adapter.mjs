import { control } from './control.mjs';
import { input, output, fail } from '../../../business/src/contracts.mjs';
import { queueTestScope } from '../../../business/src/queue-scope.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateDirectory } from './state.mjs';

// Remote use needs an explicit single-project grant matching the local MCP owner.
export class InboxBusinessAdapter {
  constructor({ runtime, threadId, enableLocalQueueTest = false, queueTestScope: grant, call = control }) {
    this.grant = queueTestScope(grant);
    if (this.grant && (this.grant.mode !== 'dedicated-test' || this.grant.conversationId !== threadId || this.grant.projectId !== 'rmtcdx-owner-inbox-test')) fail('queue_scope_rejected');
    this.runtime = runtime; this.threadId = threadId; this.call = call; this.enabled = enableLocalQueueTest === true || Boolean(this.grant); this.available = false;
    this.projectId = 'rmtcdx-owner-inbox-test';
    this.operations = ['projects.sync','directory.sync','sessions.sync', ...(this.enabled ? ['queue.enqueue','queue.status','queue.cancel','queue.consumer.stop'] : [])];
  }
  matchesQueueScope(scope) { return Boolean(this.grant && ['mode','deviceId','projectId','conversationId'].every(k=>this.grant[k]===scope[k])); }
  async health() {
    try {
      const s = await this.call(this.runtime,{operation:'status'});
      if (s.mode !== 'test' || s.callerThreadId !== this.threadId || s.ownerInbox?.protocolVersion !== 2) fail('precondition_rejected');
      if (!this.stopped) { this.available=true;this.checkedAt=Date.now(); }
    } catch(error) { this.available=false;throw error; }
  }
  async start() {
    this.stopped=false;await this.health();
    if(this.grant){
      privateDirectory(this.runtime);const file=path.join(this.runtime,'inbox.sqlite'),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)) fail('precondition_rejected');
      // Read only our own inbox to restore prompt/result cards after mobile reload.
      // No desktop database, migrations, recovery, or native sends are involved.
      this.reader=new DatabaseSync(file,{readOnly:true});
      if(this.reader.prepare('SELECT thread_id FROM scope').get()?.thread_id!==this.threadId){this.reader.close();this.reader=null;fail('precondition_rejected');}
    }
    if(!this.stopped)this.timer=setInterval(()=>void this.health().catch(()=>{}),5000);
  }
  ready() { return this.available && !this.stopped && Date.now()-this.checkedAt<10000; }
  async stop() { this.stopped=true;clearInterval(this.timer);this.available=false;this.reader?.close();this.reader=null; }
  withText(receipt){if(!receipt||!this.reader)return receipt;const row=this.reader.prepare('SELECT text FROM jobs WHERE intent_id=?').get(receipt.intentId);if(!row)fail('precondition_rejected');return {...receipt,text:row.text};}
  async execute(operation, params) {
    input(operation, params);
    if (!this.operations.includes(operation) || !this.ready()) fail('precondition_rejected');
    if (operation === 'projects.sync') return { projects: [{ id: this.projectId, name: '专用 Inbox 协议验收', available: true }] };
    if (operation === 'directory.sync') return { projects:[{id:this.projectId,name:'专用 Inbox 协议验收',available:true}],directories:[{projectId:this.projectId,conversations:[{id:this.threadId,projectId:this.projectId,title:'rmtcdx companion lifecycle',status:'idle'}],nextCursor:null}] };
    if (operation === 'sessions.sync') {
      if (params.projectId !== this.projectId || params.cursor || params.archived) fail('precondition_rejected');
      return { conversations: [{ id: this.threadId, projectId: this.projectId, title: 'rmtcdx companion lifecycle', status: 'idle' }], nextCursor: null };
    }
    if (params.conversationId !== this.threadId) fail('precondition_rejected');
    const operations = { 'queue.enqueue':'inbox_enqueue','queue.status':'inbox_queue_status','queue.cancel':'inbox_cancel','queue.consumer.stop':'inbox_consumer_stop' };
    const {conversationId,...args} = params;
    try {
      const result = await this.call(this.runtime,{...args,threadId:this.threadId,operation:operations[operation]});
      const value = operation === 'queue.status' ? {...result,receipts:result.receipts.map(r=>this.withText(r)),conversationId} : {conversationId,[operation === 'queue.consumer.stop' ? 'consumer':'receipt']:operation === 'queue.consumer.stop'?result:this.withText(result)};
      return output(operation,value);
    } catch (error) {
      if (['inbox_intent_conflict','inbox_revision_conflict','inbox_consumer_mismatch','inbox_job_not_found','test_thread_not_allowed','inbox_full'].includes(error.code)) fail('precondition_rejected');
      this.available=false;
      throw error;
    }
  }
}
