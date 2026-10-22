import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { privateDirectory } from './state.mjs';
import { failure } from './app-tools.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const validText = value => typeof value === 'string' && value.trim() && value.length <= 16000;

// This is our own inbox, never the desktop's database or native input queue.
// A desktop-owned MCP caller pulls jobs; no start/steer operation is involved.
export class OwnerInbox {
  constructor({ runtime, threadId }) {
    privateDirectory(runtime); this.threadId = threadId;
    const file = path.join(runtime, 'inbox.sqlite');
    try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw failure('unsafe_inbox');
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS scope(thread_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS jobs(intent_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','leased','completed','unknown')),
        token TEXT, consumer_turn TEXT, result TEXT, result_hash TEXT, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_inflight ON jobs((1)) WHERE state IN ('leased','unknown');`);
    this.transaction(() => {
      if (this.db.prepare('PRAGMA user_version').get().user_version < 2) {
        this.db.exec(`CREATE TABLE jobs_v2(intent_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, text TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued','leased','completed','cancelled','unknown')),
          token TEXT, consumer_turn TEXT, result TEXT, result_hash TEXT, created_at INTEGER NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,cancel_requested INTEGER NOT NULL DEFAULT 0,session_id TEXT);
          INSERT INTO jobs_v2(intent_id,fingerprint,text,state,token,consumer_turn,result,result_hash,created_at)
            SELECT intent_id,fingerprint,text,state,token,consumer_turn,result,result_hash,created_at FROM jobs;
          DROP TABLE jobs; ALTER TABLE jobs_v2 RENAME TO jobs;
          CREATE UNIQUE INDEX one_inflight ON jobs((1)) WHERE state IN ('leased','unknown');
          PRAGMA user_version=2;`);
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS consumers(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,state TEXT NOT NULL,
        expires_at INTEGER NOT NULL,max_jobs INTEGER NOT NULL,taken INTEGER NOT NULL DEFAULT 0,waiting INTEGER NOT NULL DEFAULT 0,reason TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS one_consumer ON consumers((1)) WHERE state IN ('active','stopping');
        CREATE TABLE IF NOT EXISTS progress(intent_id TEXT PRIMARY KEY,seq INTEGER NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,event TEXT NOT NULL,intent_id TEXT,session_id TEXT,revision INTEGER,reason TEXT);
        CREATE INDEX IF NOT EXISTS audit_intent_event ON audit(intent_id,event,at);`);
    });
    try { this.transaction(() => {
      const scope = this.db.prepare('SELECT thread_id FROM scope').get();
      if (scope && scope.thread_id !== threadId) throw failure('inbox_scope_mismatch');
      if (!scope) this.db.prepare('INSERT INTO scope VALUES (?)').run(threadId);
    }); } catch (error) { this.db.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  receipt(row) { const progress=this.db.prepare('SELECT seq,text,at FROM progress WHERE intent_id=?').get(row.intent_id);const times=this.db.prepare("SELECT min(CASE WHEN event='job.leased' THEN at END) AS leasedAt,min(CASE WHEN event='job.completed' THEN at END) AS completedAt FROM audit WHERE intent_id=?").get(row.intent_id); const abandoned=Boolean(this.db.prepare("SELECT 1 FROM audit WHERE intent_id=? AND event='job.unknown_abandoned' LIMIT 1").get(row.intent_id)); return { intentId: row.intent_id, threadId: this.threadId, state: row.state, revision: row.revision,
    timing:{enqueuedAt:row.created_at,...(times.leasedAt==null?{}:{leasedAt:times.leasedAt}),...(times.completedAt==null?{}:{completedAt:times.completedAt}),...(progress?{firstProgressAt:this.db.prepare("SELECT min(at) AS at FROM audit WHERE intent_id=? AND event='job.progress'").get(row.intent_id).at}: {})},...(progress?{progress:{...progress}}:{}),
    cancelRequested: Boolean(row.cancel_requested), consumerTurnId: row.consumer_turn ?? null, sessionId: row.session_id ?? null,
    outcomeUncertain: row.state === 'unknown' || abandoned, ...(abandoned ? {resolution:'abandoned_unknown'} : {}),
    ...(row.result == null ? {} : { result: row.result }) }; }
  event(event, row = {}, reason = null) { this.db.prepare('INSERT INTO audit(at,event,intent_id,session_id,revision,reason) VALUES (?,?,?,?,?,?)').run(Date.now(), event, row.intent_id ?? null, row.session_id ?? null, row.revision ?? null, reason); }
  get(intentId) { const row = this.db.prepare('SELECT * FROM jobs WHERE intent_id=?').get(intentId); if (!row) throw failure('inbox_job_not_found'); return row; }
  finishSession(sessionId) {
    if (!sessionId) return;
    const session = this.db.prepare('SELECT * FROM consumers WHERE id=?').get(sessionId);
    if (!session || !['active','stopping'].includes(session.state)) return;
    if (this.db.prepare("SELECT 1 FROM jobs WHERE session_id=? AND state IN ('leased','unknown')").get(sessionId)) return;
    if (session.state === 'stopping' || session.taken >= session.max_jobs || session.expires_at <= Date.now()) {
      this.db.prepare("UPDATE consumers SET state='closed',waiting=0,reason=coalesce(reason,?) WHERE id=?").run(session.taken >= session.max_jobs ? 'job_limit' : 'deadline', sessionId);
      this.event('consumer.closed', {session_id: sessionId});
    }
  }
  enqueue(intentId, text) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(intentId ?? '') || !validText(text)) throw failure('invalid_inbox_job');
    return this.transaction(() => {
      const fingerprint = digest(text), existing = this.db.prepare('SELECT * FROM jobs WHERE intent_id=?').get(intentId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw failure('inbox_intent_conflict');
        return this.receipt(existing);
      }
      if (this.db.prepare("SELECT count(*) AS n FROM jobs WHERE state='queued'").get().n >= 100) throw failure('inbox_full');
      this.db.prepare("INSERT INTO jobs(intent_id,fingerprint,text,state,created_at) VALUES (?,?,?,'queued',?)").run(intentId, fingerprint, text, Date.now());
      const row = this.get(intentId); this.event('job.enqueued', row); return this.receipt(row);
    });
  }
  claim(consumerTurnId = null) {
    return this.transaction(() => this.claimRow(consumerTurnId));
  }
  claimRow(consumerTurnId, sessionId = null) {
      const held = this.db.prepare("SELECT intent_id,state FROM jobs WHERE state IN ('leased','unknown')").get();
      if (held) return { status: 'blocked', intentId: held.intent_id, state: held.state };
      const row = this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created_at,rowid LIMIT 1").get();
      if (!row) return { status: 'empty' };
      const token = crypto.randomUUID();
      this.db.prepare("UPDATE jobs SET state='leased',token=?,consumer_turn=?,session_id=?,revision=revision+1 WHERE intent_id=? AND state='queued'").run(token, consumerTurnId, sessionId, row.intent_id);
      this.event('job.leased', this.get(row.intent_id));
      return { status: 'job', threadId: this.threadId, intentId: row.intent_id, leaseToken: token, text: row.text };
  }
  owned(intentId, leaseToken, consumerTurnId) {
    const row = this.get(intentId);
    if (row.token !== leaseToken || (row.consumer_turn != null && row.consumer_turn !== consumerTurnId)) throw failure('inbox_lease_mismatch');
    return row;
  }
  complete(intentId, leaseToken, result, consumerTurnId = null) {
    if (!validText(result)) throw failure('invalid_inbox_result');
    return this.transaction(() => {
      const row = this.owned(intentId, leaseToken, consumerTurnId);
      const fingerprint = digest(result);
      if (row.state === 'completed') {
        if (row.result_hash !== fingerprint) throw failure('inbox_result_conflict');
        return this.receipt(row);
      }
      if (row.state !== 'leased') throw failure('inbox_outcome_unknown');
      if (row.cancel_requested) throw failure('inbox_cancel_requested');
      this.db.prepare("UPDATE jobs SET state='completed',result=?,result_hash=?,revision=revision+1 WHERE intent_id=?").run(result, fingerprint, intentId);
      const done = this.get(intentId); this.event('job.completed', done); this.finishSession(row.session_id); return this.receipt(done);
    });
  }
  progress(intentId,leaseToken,seq,text,consumerTurnId){
    if(!validText(text)||!Number.isSafeInteger(seq)||seq<1)throw failure('invalid_inbox_progress');
    return this.transaction(()=>{
      const row=this.owned(intentId,leaseToken,consumerTurnId);
      if(row.state!=='leased')throw failure('inbox_outcome_unknown');
      if(row.cancel_requested)throw failure('inbox_cancel_requested');
      const old=this.db.prepare('SELECT * FROM progress WHERE intent_id=?').get(intentId);
      if(old?.seq===seq&&old.text===text)return this.receipt(row);
      if(seq!==(old?.seq??0)+1)throw failure('inbox_progress_conflict');
      this.db.prepare('INSERT INTO progress(intent_id,seq,text,at) VALUES (?,?,?,?) ON CONFLICT(intent_id) DO UPDATE SET seq=excluded.seq,text=excluded.text,at=excluded.at').run(intentId,seq,text,Date.now());
      this.event('job.progress',row);return this.receipt(row);
    });
  }
  reply(intentId,leaseToken,result,consumerTurnId){
    // Completion atomically checks cancellation. A cancelled answer is never published.
    const row=this.owned(intentId,leaseToken,consumerTurnId);
    if(row.state==='cancelled')return this.receipt(row);
    try{return this.complete(intentId,leaseToken,result,consumerTurnId);}
    catch(error){if(error.code!=='inbox_cancel_requested')throw error;return this.ackCancel(intentId,leaseToken,consumerTurnId);}
  }
  cancel(intentId, expectedRevision) {
    return this.transaction(() => {
      const row = this.get(intentId);
      if (row.revision !== expectedRevision) throw failure('inbox_revision_conflict');
      if (['completed','cancelled'].includes(row.state) || row.cancel_requested) return this.receipt(row);
      this.db.prepare("UPDATE jobs SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,cancel_requested=1,revision=revision+1 WHERE intent_id=?").run(intentId);
      const next = this.get(intentId); this.event('job.cancel_requested', next); return this.receipt(next);
    });
  }
  checkpoint(intentId, leaseToken, consumerTurnId) { const row=this.owned(intentId, leaseToken, consumerTurnId); this.event('job.checkpoint',row,row.cancel_requested?'cancel_requested':'continue'); return this.receipt(row); }
  ackCancel(intentId, leaseToken, consumerTurnId) {
    return this.transaction(() => {
      const row = this.owned(intentId, leaseToken, consumerTurnId);
      if (row.state === 'cancelled') return this.receipt(row);
      if (row.state !== 'leased' || !row.cancel_requested) throw failure('inbox_cancel_not_acknowledgeable');
      this.db.prepare("UPDATE jobs SET state='cancelled',revision=revision+1 WHERE intent_id=?").run(intentId);
      const next = this.get(intentId); this.event('job.cancelled', next); this.finishSession(row.session_id); return this.receipt(next);
    });
  }
  resolveUnknown(intentId, expectedRevision, reason) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 200) throw failure('inbox_reconciliation_reason_required');
    return this.transaction(() => {
      const row = this.get(intentId);
      if (row.revision !== expectedRevision || row.state !== 'unknown') throw failure('inbox_reconciliation_conflict');
      // Explicit local operator abandonment only. Never requeue uncertain work.
      this.db.prepare("UPDATE jobs SET state='cancelled',cancel_requested=1,revision=revision+1 WHERE intent_id=?").run(intentId);
      const next = this.get(intentId); this.event('job.unknown_abandoned', next, reason); this.finishSession(row.session_id); return this.receipt(next);
    });
  }
  recover() { return this.transaction(() => {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE state='leased'").all();
    this.db.prepare("UPDATE jobs SET state='unknown',revision=revision+1 WHERE state='leased'").run();
    for (const row of rows) this.event('job.unknown', this.get(row.intent_id), 'service_recovery');
    this.db.exec("UPDATE consumers SET state='closed',waiting=0,reason='service_recovery' WHERE state IN ('active','stopping')");
    return rows.length;
  }); }
  receipts() { return this.db.prepare('SELECT * FROM jobs ORDER BY created_at,rowid').all().map(row => this.receipt(row)); }
  status() {
    return { protocolVersion: 2, threadId: this.threadId, nativeTurnPerMessage: false, atomicLocalQueue: true,
      counts: Object.fromEntries(this.db.prepare('SELECT state,count(*) AS n FROM jobs GROUP BY state').all().map(row => [row.state, row.n])),
      inflight: this.db.prepare("SELECT intent_id AS intentId,state FROM jobs WHERE state IN ('leased','unknown')").get() ?? null };
  }
  close() { this.db.close(); }
}
