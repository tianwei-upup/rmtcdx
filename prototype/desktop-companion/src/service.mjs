import { InboxService } from './inbox-service.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { failure } from './app-tools.mjs';
import { privateDirectory, readPrivate, writePrivate } from './state.mjs';
import { OwnerInbox } from './inbox.mjs';
import { InboxConsumer } from './consumer.mjs';

const terminal = new Set(['completed', 'interrupted', 'failed']);
const settled = new Set(['completed', 'interrupted', 'failed', 'rejected']);
const active = snapshot => snapshot.thread?.status?.type === 'active' || snapshot.turns?.some(turn => turn.status === 'inProgress');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class CompanionService {
  constructor({ runtime, client, scope, log = () => {} }) {
    privateDirectory(runtime);
    if (scope.version !== 1 || scope.mode !== 'test' || !scope.callerThreadId || !scope.threadIds?.length || !scope.expectedCwds) throw failure('test_scope_required');
    this.scope = scope; this.client = client; this.log = log;
    this.inbox = new OwnerInbox({ runtime, threadId: scope.callerThreadId });
    this.consumer = new InboxConsumer(this.inbox);
    const recovered = this.inbox.recover();
    if (recovered) this.log({ event: 'inbox.recovered_unknown', count: recovered });
    this.file = path.join(runtime, 'receipts.json');
    this.receipts = readPrivate(this.file, {}); this.checking = new Set();
    this.ready = false; this.stopped = false; this.recovering = false; this.reconciling = false;
    this.backoff = 250; this.nextConnectAt = 0;
  }
  save() { writePrivate(this.file, this.receipts); }
  allowed(id) { if (!this.scope.threadIds.includes(id)) throw failure('test_thread_not_allowed'); }
  holds(id) { return Object.entries(this.receipts).filter(([, receipt]) => receipt.threadId === id && !settled.has(receipt.state)); }
  status() {
    return { pid: process.pid, parentPid: process.ppid, ready: this.ready && Boolean(this.client.socket && !this.client.socket.destroyed), callerThreadId: this.scope.callerThreadId, allowedThreadIds: this.scope.threadIds,
      mode: this.scope.mode, mcpRole: 'owner',
      capabilities: { atomicIdleAdmission: false, atomicQueueAppend: false, nonAtomicSend: 'dedicated_test_only' },
      ownerInbox: { ...this.inbox.status(), consumer: this.consumer.status() },
      productionGate: 'desktop_atomic_admission_unverified',
      holds: Object.entries(this.receipts).filter(([, r]) => !settled.has(r.state)).map(([intentId, r]) => ({ intentId, threadId: r.threadId, state: r.state, turnId: r.turnId ?? null })) };
  }
  async connect() {
    if (this.recovering || this.reconciling || this.stopped) return;
    this.recovering = true; this.ready = false;
    try {
      this.client.close(); await this.client.connect();
      const tools = await this.client.catalog();
      if (!tools.some(tool => tool.namespace === 'codex_app' && tool.name === 'send_message_to_thread')) throw failure('desktop_send_missing');
      // Reconcile only acknowledged writes. Unknown writes remain blocked after restart.
      await this.reconcile(); this.ready = true; this.backoff = 250;
      this.log({ event: 'desktop.connected' });
    } catch (error) {
      this.client.close(); this.nextConnectAt = Date.now() + this.backoff; this.backoff = Math.min(30000, this.backoff * 2);
      this.log({ event: 'desktop.unavailable', code: error.code ?? 'connect_failed' });
    } finally { this.recovering = false; }
  }
  async start() {
    await this.connect();
    this.timer = setInterval(() => void this.tick(), 500);
  }
  async tick() {
    if (this.stopped) return;
    this.consumer.expire();
    if (!this.client.socket || this.client.socket.destroyed) {
      this.ready = false;
      if (Date.now() >= this.nextConnectAt) await this.connect();
      return;
    }
    if (!this.recovering) await this.reconcile().catch(() => { this.ready = false; this.client.close(); });
  }
  async snapshot(threadId, cursor) {
    this.allowed(threadId);
    const snapshot = await this.client.tool('read_thread', { threadId, hostId: 'local', turnLimit: 10, includeOutputs: false, maxOutputCharsPerItem: 20000, ...(cursor ? { cursor } : {}) });
    if (snapshot.thread?.id !== threadId || snapshot.thread.cwd !== this.scope.expectedCwds[threadId]) throw failure('thread_identity_mismatch');
    return snapshot;
  }
  async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const [intentId, receipt] of Object.entries(this.receipts)) {
        if (!['submitted', 'running'].includes(receipt.state)) continue;
        // Never inspect outside the current grant, even when a grant is narrowed.
        if (!this.scope.threadIds.includes(receipt.threadId)) continue;
        const snapshot = await this.snapshot(receipt.threadId);
        const created = snapshot.turns.filter(turn => !receipt.beforeTurnIds.includes(turn.id));
        if (!receipt.turnId) {
          if (created.length > 1) { receipt.state = 'unknown'; receipt.reason = 'multiple_new_turns'; this.save(); continue; }
          if (created.length === 0) {
            if (Date.now() - receipt.submittedAt > 30000) { receipt.state = 'unknown'; receipt.reason = 'turn_not_observed'; this.save(); }
            continue;
          }
          receipt.turnId = created[0].id; receipt.state = 'running'; this.save();
        }
        const turn = snapshot.turns.find(turn => turn.id === receipt.turnId);
        if (!turn) { receipt.state = 'unknown'; receipt.reason = 'observed_turn_missing'; this.save(); continue; }
        if (terminal.has(turn.status)) { receipt.state = turn.status; receipt.finishedAt = Date.now(); this.save(); this.log({ event: 'turn.settled', intentId, threadId: receipt.threadId, turnId: turn.id, state: turn.status }); }
      }
    } finally { this.reconciling = false; }
  }
  async execute(request) {
    if (request.operation === 'status') return this.status();
    if (request.operation.startsWith('inbox_') && request.threadId != null && request.threadId !== this.scope.callerThreadId) throw failure('test_thread_not_allowed');
    if (request.operation.startsWith('inbox_')) return InboxService.prototype.dispatch.call(this,{...request,threadId:this.scope.callerThreadId});
    if (request.operation === 'receipt') {
      this.allowed(request.threadId);
      const receipt = this.receipts[request.intentId];
      if (!receipt || receipt.threadId !== request.threadId) throw failure('receipt_not_found');
      return structuredClone(receipt);
    }
    if (request.operation === 'reconnect') {
      if (this.checking.size || this.reconciling) throw failure('companion_busy');
      await this.connect(); return this.status();
    }
    if (!this.status().ready) throw failure('desktop_unavailable');
    this.allowed(request.threadId);
    if (request.operation === 'snapshot') return this.snapshot(request.threadId, request.cursor);
    if (request.operation !== 'send') throw failure('unsupported_operation');
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(request.intentId ?? '') || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 16000) throw failure('invalid_send');
    const fingerprint = hash([request.threadId, request.text]);
    const existing = this.receipts[request.intentId];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw failure('intent_conflict');
      return structuredClone(existing);
    }
    if (this.checking.has(request.threadId) || this.holds(request.threadId).length) throw failure('test_thread_busy');
    this.checking.add(request.threadId);
    try {
      const before = await this.snapshot(request.threadId);
      if (active(before)) throw failure('test_thread_busy');
      const receipt = this.receipts[request.intentId] = { threadId: request.threadId, fingerprint, state: 'unknown', reason: 'write_outcome_pending', beforeTurnIds: before.turns.map(turn => turn.id), submittedAt: Date.now() };
      this.save();
      // At-most-once write. A disconnect/timeout leaves a durable hold, never replayed.
      const response = await this.client.tool('send_message_to_thread', { threadId: request.threadId, hostId: 'local', prompt: request.text });
      if (response?.threadId !== request.threadId) throw failure('send_identity_mismatch');
      receipt.state = 'submitted'; delete receipt.reason; receipt.response = response; this.save();
      this.log({ event: 'test.message.submitted', threadId: request.threadId, intentId: request.intentId });
      return structuredClone(receipt);
    } finally { this.checking.delete(request.threadId); }
  }
  stop() { if (this.stopped) return; this.stopped = true; this.ready = false; clearInterval(this.timer); this.client.close(); this.inbox.recover(); this.inbox.close(); }
}
