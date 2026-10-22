import crypto from 'node:crypto';

export function activationId(conversationId, intentId) {
  const data = crypto.createHash('sha256').update('rmtcdx-history-receiver-v1\0' + conversationId + '\0' + intentId).digest().subarray(0, 16);
  data[6] = (data[6] & 15) | 80; data[8] = (data[8] & 63) | 128;
  const value = data.toString('hex'); return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join('-');
}
export function activationPrompt(id) {
  return `用户已通过本人手机向当前历史会话发送消息，明确授权接入原 ID 和原上下文。接入编号 ${id}。这是本会话的接收启动请求，不是另一聊天的消息。只处理本会话队列，不新建、切换或操作其他会话，不修改桌面权限。\n` +
    '调用 rmt_queue_listen，windowMs=600000、maxJobs=100、waitMs=0，领取已排队消息。按每次工具返回的 executionMode/handlingInstructions 和手机消息要求执行；有副作用前及步骤之间检查取消。长回答逐段调用 rmt_queue_progress 发布真实累计公开文本。使用 rmt_queue_reply 回传结果，takeNext=true、waitMs=0，连续处理已经排队的下一条；始终采用返回的 sessionId。unknown/blocked/stopped 立即停止，绝不重放未知任务。\n' +
    '队列空时调用 rmt_queue_close 关闭本轮接收并正常结束，不调用 standby_enable、不等待空队列、不自行重新开窗。之后的新消息由常驻接收服务另行原子排队到本会话。启动请求本身不要执行命令或改文件，不把接入编号当作业务任务结果。';
}
export function activationReference(text) {
  const match = /^用户已通过本人手机向当前历史会话发送消息，明确授权接入原 ID 和原上下文。接入编号 ([0-9a-f-]{36})。/.exec(text);
  return match && text === activationPrompt(match[1]) ? match[1] : null;
}

// An on-demand receiver, not a model that polls forever. Busy native threads
// receive only a durable queue append; only Codex decides when they are idle.
export class HistoryReceiver {
  constructor({ conversationId, nativeQueue, readQueue, wake, publish = () => {}, now = Date.now, promptFactory=activationPrompt }) {
    Object.assign(this, { conversationId, nativeQueue, readQueue, wake, publish, now, promptFactory });
    this.wakes = new Map();
  }
  async tick() {
    if (this.pending) return this.pending;
    this.pending = this.run().finally(() => { this.pending = null; }); return this.pending;
  }
  async run() {
    const q = await this.readQueue();
    if ((q.receipts ?? []).some(r => r.state === 'unknown')) return this.publish({ state: 'blocked', code: 'existing_job_inflight_or_unknown' });
    if (['active', 'stopping'].includes(q.consumer?.state)) return this.publish({ state: 'receiving', consumerTurnId: q.consumer.consumerTurnId });
    if ((q.receipts ?? []).some(r => r.state === 'leased')) return this.publish({ state: 'blocked', code: 'existing_job_inflight_or_unknown' });
    const job = (q.receipts ?? []).find(r => r.state === 'queued' && !r.cancelRequested);
    if (!job) return this.publish({ state: 'idle' });
    const id = activationId(this.conversationId, job.intentId);
    const result = this.nativeQueue.enqueue({ intentId: id, text: this.promptFactory(id) });
    if (['queued', 'accepted'].includes(result.state)) {
      if (!this.wakes.has(id)) {
        await this.wake(this.conversationId); this.wakes.set(id, this.now());
      }
      return this.publish({ state: result.state === 'queued' ? 'queued' : 'awaiting_consumer', intentId: job.intentId, activationId: id });
    }
    // Accepted + absent means consumed, never permission to enqueue a second
    // activation. A receiver restart uses the same durable id/receipt.
    return this.publish({ state: 'blocked', intentId: job.intentId, activationId: id, code: 'native_admission_' + result.state });
  }
}
