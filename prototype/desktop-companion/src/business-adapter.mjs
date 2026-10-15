import fs from 'node:fs';
import crypto from 'node:crypto';
import { control } from './control.mjs';
import { input, output, fail } from '../../../business/src/contracts.mjs';

const opaque = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 40);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export class CompanionBusinessAdapter {
  constructor({ runtime, threadIds, emit = () => {}, projectId = 'rmtcdx-companion-test', ledgerFile, call = control, allowNonAtomicTestSends = false }) {
    this.runtime = runtime; this.threadIds = threadIds; this.emit = emit; this.projectId = projectId; this.call = call;
    this.project = { id: projectId, name: '伴随接入隔离验证', available: true };
    // Read-only by default: the desktop bridge has no atomic idle admission.
    // Explicit opt-in exists solely for isolated protocol acceptance tests.
    this.operations = ['projects.sync', 'sessions.sync', 'conversation.snapshot', ...(allowNonAtomicTestSends === true ? ['turn.start'] : [])];
    this.active = new Map(); this.available = false; this.stopped = false; this.ledgerFile = ledgerFile;
    this.prompts = ledgerFile && fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {};
  }
  async start() { await this.health(); this.timer = setInterval(() => void this.health().catch(() => { this.available = false; }), 5000); }
  setEventSink(emit) { this.emit = emit; }
  async stop() { this.stopped = true; clearInterval(this.timer); this.available = false; }
  async health() {
    const status = await this.call(this.runtime, { operation: 'status' });
    this.available = status.ready && this.threadIds.every(id => status.allowedThreadIds.includes(id));
    if (!this.available) fail('precondition_rejected');
  }
  ready() { return this.available && !this.stopped; }
  owned(threadId) { if (!this.threadIds.includes(threadId)) fail('precondition_rejected'); }
  async read(threadId, cursor) { this.owned(threadId); const value = await this.call(this.runtime, { operation: 'snapshot', threadId, ...(cursor ? { cursor } : {}) }); if (value.thread?.id !== threadId) fail('precondition_rejected'); return value; }
  conversation(snapshot) {
    const active = snapshot.turns.some(turn => turn.status === 'inProgress');
    return { id: snapshot.thread.id, projectId: this.projectId, title: snapshot.thread.title ?? 'Companion acceptance', status: active ? 'running' : 'idle', updatedAt: snapshot.thread.updatedAt ?? 0 };
  }
  messages(snapshot) {
    const messages = [];
    for (const turn of [...snapshot.turns].reverse()) {
      for (const [intentId, prompt] of Object.entries(this.prompts)) if (prompt.threadId === snapshot.thread.id && prompt.turnId === turn.id) messages.push({ id: opaque(intentId), role: 'user', text: prompt.text, attachmentIds: [] });
      for (const item of turn.items ?? []) {
        if (item.type !== 'agentMessage' || !item.text) continue;
        for (let i = 0; i < item.text.length; i += 32000) messages.push({ id: opaque(item.id + ':' + i), role: 'assistant', text: item.text.slice(i, i + 32000), attachmentIds: [] });
      }
    }
    return messages;
  }
  savePrompts() { if (this.ledgerFile) fs.writeFileSync(this.ledgerFile, JSON.stringify(this.prompts), { mode: 0o600 }); }
  event(type, jobId, conversationId, turnId, extra = {}) { this.emit({ eventId: opaque([type, jobId, turnId, extra.text ?? ''].join(':')), type, jobId, conversationId, turnId, ...extra }); }
  async execute(operation, params, jobId) {
    input(operation, params);
    if (!this.operations.includes(operation)) fail('precondition_rejected');
    let result;
    if (operation === 'projects.sync') result = { projects: [this.project] };
    if (operation === 'sessions.sync') {
      if (params.projectId !== this.projectId || params.cursor || params.archived) fail('precondition_rejected');
      const snapshots = await Promise.all(this.threadIds.map(id => this.read(id)));
      result = { conversations: snapshots.map(value => this.conversation(value)).filter(value => !params.search || value.title.includes(params.search)), nextCursor: null };
    }
    if (operation === 'conversation.snapshot') {
      const snapshot = await this.read(params.conversationId, params.cursor);
      const messages = this.messages(snapshot);
      if (messages.length > 100 || (snapshot.page?.hasMore && !snapshot.page.nextCursor)) fail('precondition_rejected');
      result = { conversation: this.conversation(snapshot), messages, approvals: [], assets: [], nextCursor: snapshot.page?.nextCursor ?? null, activeTurnId: snapshot.turns.find(turn => turn.status === 'inProgress')?.id ?? null };
    }
    if (operation === 'turn.start') {
      this.owned(params.conversationId);
      if (params.attachmentIds.length || this.active.has(params.conversationId)) fail('precondition_rejected');
      // Reserve before the first await. The companion owns the durable full-turn lock.
      this.active.set(params.conversationId, 'submitting');
      try {
        let receipt = await this.call(this.runtime, { operation: 'send', threadId: params.conversationId, text: params.text, intentId: jobId });
        for (let i = 0; !receipt.turnId && receipt.state !== 'unknown' && i < 80 && !this.stopped; i++) {
          await delay(250);
          receipt = await this.call(this.runtime, { operation: 'receipt', threadId: params.conversationId, intentId: jobId });
        }
        if (!receipt.turnId || receipt.state === 'unknown') fail('execution_unknown');
        const turnId = receipt.turnId;
        this.prompts[jobId] = { threadId: params.conversationId, turnId, text: params.text }; this.savePrompts();
        this.event('turn.started', jobId, params.conversationId, turnId);
        this.active.set(params.conversationId, turnId);
        void this.observe(params.conversationId, turnId, jobId).catch(() => { this.available = false; }).finally(() => this.active.delete(params.conversationId));
        result = { conversationId: params.conversationId, turnId, status: 'running' };
      } catch (error) { this.active.delete(params.conversationId); throw error; }
    }
    return output(operation, result);
  }
  async observe(threadId, turnId, jobId) {
    for (let i = 0; i < 120 && !this.stopped; i++) {
      const snapshot = await this.read(threadId), turn = snapshot.turns.find(value => value.id === turnId);
      if (!turn) throw Error('observed_turn_missing');
      if (['completed', 'interrupted', 'failed'].includes(turn.status)) {
        // Snapshot-derived final text, not a claim of native token streaming.
        const text = turn.items.filter(item => item.type === 'agentMessage').map(item => item.text ?? '').join('\n');
        for (let offset = 0; offset < text.length; offset += 8000) this.event('assistant.delta', jobId, threadId, turnId, { text: text.slice(offset, offset + 8000) });
        this.event('turn.finished', jobId, threadId, turnId, { status: turn.status }); return;
      }
      await delay(1000);
    }
    if (!this.stopped) throw Error('observed_turn_timeout');
  }
}
