import crypto from 'node:crypto';
import { failure } from './app-tools.mjs';

export class InboxConsumer {
  constructor(inbox) { this.inbox = inbox; this.db = inbox.db; }
  view(row) { return row ? { sessionId: row.id, consumerTurnId: row.turn_id, state: row.state, waiting: Boolean(row.waiting), expiresAt: row.expires_at, maxJobs: row.max_jobs, takenJobs: row.taken, stopReason: row.reason ?? null } : null; }
  get(sessionId, turnId) {
    const row = this.db.prepare('SELECT * FROM consumers WHERE id=?').get(sessionId);
    if (!row || turnId != null && row.turn_id !== turnId) throw failure('inbox_consumer_mismatch');
    return row;
  }
  expire() { this.inbox.transaction(() => {
    for (const row of this.db.prepare("SELECT * FROM consumers WHERE state='active' AND expires_at<=?").all(Date.now())) {
      this.db.prepare("UPDATE consumers SET state='stopping',reason='deadline',waiting=0 WHERE id=?").run(row.id); this.inbox.finishSession(row.id);
    }
  }); }
  status() { this.expire(); return this.view(this.db.prepare('SELECT * FROM consumers ORDER BY rowid DESC LIMIT 1').get()); }
  open(turnId, windowMs = 120000, maxJobs = 10) {
    if (!turnId || !Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 600000 || !Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) throw failure('invalid_consumer_window');
    this.expire();
    return this.inbox.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM consumers WHERE state IN ('active','stopping')").get()) throw failure('inbox_consumer_already_active');
      if (this.db.prepare("SELECT 1 FROM jobs WHERE state IN ('leased','unknown')").get()) throw failure('inbox_outcome_unknown');
      const id = crypto.randomUUID();
      this.db.prepare("INSERT INTO consumers(id,turn_id,state,expires_at,max_jobs) VALUES (?,?,'active',?,?)").run(id, turnId, Date.now() + windowMs, maxJobs);
      this.inbox.event('consumer.opened', {session_id: id}); return this.view(this.get(id));
    });
  }
  stop(sessionId, reason = 'requested', turnId) {
    return this.inbox.transaction(() => {
      const row = this.get(sessionId, turnId);
      if (row.state === 'active') {
        this.db.prepare("UPDATE consumers SET state='stopping',waiting=0,reason=? WHERE id=?").run(reason, sessionId);
        this.inbox.event('consumer.stop_requested', {session_id: sessionId}, reason);
      }
      this.inbox.finishSession(sessionId); return this.view(this.get(sessionId));
    });
  }
  waiting(sessionId, turnId, value) {
    return this.inbox.transaction(() => {
      const row = this.get(sessionId, turnId);
      if (value && row.waiting) throw failure('inbox_consumer_busy');
      if (value && row.state !== 'active') return false;
      this.db.prepare('UPDATE consumers SET waiting=? WHERE id=?').run(value ? 1 : 0, sessionId);
      this.inbox.event(value ? 'consumer.waiting' : 'consumer.wait_ended', {session_id:sessionId}); return true;
    });
  }
  take(sessionId, turnId) {
    this.expire();
    return this.inbox.transaction(() => {
      this.inbox.finishSession(sessionId);
      const row = this.get(sessionId, turnId);
      if (row.state !== 'active') return { status: 'stopped', session: this.view(row), continuePolling: false };
      const job = this.inbox.claimRow(turnId, sessionId);
      if (job.status === 'job') this.db.prepare('UPDATE consumers SET taken=taken+1 WHERE id=?').run(sessionId);
      return { ...job, session: this.view(this.get(sessionId)), continuePolling: job.status === 'empty' };
    });
  }
}
