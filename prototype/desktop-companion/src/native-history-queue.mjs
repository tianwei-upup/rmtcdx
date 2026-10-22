import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { privateDirectory, readPrivate, writePrivate } from './state.mjs';
import { desktopProjects } from '../../../business/src/projects.mjs';
import { PersonalScope } from './personal-scope.mjs';

// Local, build-fenced native queue adapter. Only the acceptance chat and the
// user's original exact RN project grant are eligible; archived chats are not.
export const HISTORY_QUEUE_TEST_ID = '01a13feb-ce80-7ca3-aa1e-17814542b353';
export const HISTORY_QUEUE_SCHEMA = 'b1d0caf9abeec1744bc84b2373a312e0c09bdeb3c808c9bf8b0fcc5dcc7e24c5';
export const RN_HISTORY_PROJECT = 'c28d39c4-620e-41ca-a8bc-8c6f0e78ccb3';
export const RN_HISTORY_IDS = new Set([
  '01a14253-db6e-7640-b7ba-6305e9b7ec14','01a1424d-dde8-7da1-bd2e-9707c42673dd','01a13f6e-3bde-7383-8ee2-457f1ef98f19','01a13a58-2057-7ae0-b0cb-d0d30e7d7315',
  '01a12692-9431-7a41-af9c-09212ff3f812','01a13a56-5aca-76b3-9bec-d4c7e019f502','01a12696-3c9c-7c93-84a2-be96c8fefe3e','01a12fe1-ff56-7f21-bef3-7e153823f062',
  '01a1392d-9340-70d0-b5ad-642c63c448db','01a1347e-8fa1-7222-b782-bf431d52fae8','01a133ec-0862-7f91-bc8b-7246c2ca8b9d','01a1204f-acd2-72c2-95b9-44efc9125304',
  '01a12f9a-56ce-79f3-8d60-5d22b460b6f8','01a12051-90c7-74a2-95c2-d17dfc050d89'
]);
const migrations = [
  [1, 'cea113c9a74fe4ed12cf41951b57c66ca375a14a722ac28d41bc06a096ed3e1d777ac0710c5377e8cd75f645c99ca03c'],
  [2, '983a2b17b454feb00d7c221d7f556e900e7f9ade4aef395e854ed9093fa21237fd3fd93f99c66758b489c0f376f56570']
];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const error = code => Object.assign(new Error(code), { code });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function regular(file, privateFile = false) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || s.nlink !== 1 || privateFile && (s.mode & 0o077)) throw error('unsafe_native_queue_file');
}
export function verifyNativeQueueSchema(db) {
  const rows = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all().map(r => [r.type, r.name, r.sql]);
  if (hash(JSON.stringify(rows)) !== HISTORY_QUEUE_SCHEMA) throw error('native_queue_schema_changed');
  const versions = db.prepare('SELECT version,success,checksum FROM _sqlx_migrations ORDER BY version').all();
  if (versions.length !== migrations.length || versions.some((v, i) => v.version !== migrations[i][0] || v.success !== 1 || Buffer.from(v.checksum).toString('hex') !== migrations[i][1])) throw error('native_queue_schema_changed');
}

// Uses the native queue's atomic INSERT and revision triggers. Never opens the
// history database for writes, migrates a schema, starts a CLI, resumes a thread,
// replaces a queue, or calls start/steer. Only the desktop owns execution.
export class NativeHistoryQueue {
  constructor({ database, runtime, conversationId, enabled = false, grant, desktopStateFile, metadataDatabase, personalScope }) {
    if (enabled !== true) throw error('native_history_acceptance_only');
    if(personalScope){
      if(!(personalScope instanceof PersonalScope)||!personalScope.chats.has(conversationId))throw error('native_history_scope_rejected');
      this.checkScope=()=>personalScope.check(conversationId,{write:true});
    }else if (conversationId !== HISTORY_QUEUE_TEST_ID) {
      if (!RN_HISTORY_IDS.has(conversationId) || grant?.mode !== 'project-readonly' || grant.projectId !== RN_HISTORY_PROJECT || grant.projectName !== '壳工程RN UI相关' || !grant.conversations?.some(c => c.id === conversationId && c.archived === false) || !path.isAbsolute(desktopStateFile ?? '') || !path.isAbsolute(metadataDatabase ?? '')) throw error('native_history_acceptance_only');
      this.checkScope = () => {
        const project = desktopProjects(desktopStateFile).find(p => p.id === RN_HISTORY_PROJECT && p.name === grant.projectName);
        if (!project?.threadIds.includes(conversationId)) throw error('native_history_scope_rejected');
        regular(metadataDatabase); const metadata = new DatabaseSync(metadataDatabase, { readOnly: true });
        try { const row = metadata.prepare('SELECT cwd,archived FROM threads WHERE id=?').get(conversationId); if (!row || row.archived !== 0 || !project.paths.includes(row.cwd)) throw error('native_history_scope_rejected'); }
        finally { metadata.close(); }
      };
      // Membership/archive checks run before every actual admission. Merely
      // constructing an idle watcher must not disable its sibling watchers
      // when one authorized chat is later archived or removed from a project.
    }
    if (!path.isAbsolute(database) || path.basename(database) !== 'queue_1.sqlite' || fs.realpathSync(database) !== database) throw error('unsafe_native_queue_file');
    regular(database); privateDirectory(runtime);
    Object.assign(this, { database, runtime, conversationId });
  }
  withLock(action) {
    const file = path.join(this.runtime, 'admission-lock.sqlite');
    try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    regular(file, true);
    const lock = new DatabaseSync(file);
    try { lock.exec('BEGIN EXCLUSIVE'); } catch { lock.close(); throw error('native_queue_admission_busy'); }
    let db;
    try {
      this.checkScope?.();
      regular(this.database);
      for (const suffix of ['-wal', '-shm']) if (fs.existsSync(this.database + suffix)) regular(this.database + suffix);
      db = new DatabaseSync(this.database); db.exec('PRAGMA busy_timeout=5000');
      verifyNativeQueueSchema(db);
      return action(db);
    } finally { db?.close(); lock.close(); }
  }
  receiptPath(intentId) { if (!uuid.test(intentId)) throw error('invalid_native_intent'); return path.join(this.runtime, intentId + '.json'); }
  row(db, id) { return db.prepare('SELECT payload_json FROM queued_items WHERE id=? AND thread_id=?').get(id, this.conversationId); }
  public(receipt, row) { return { intentId: receipt.intentId, conversationId: receipt.conversationId, queuedSubmissionId: receipt.intentId, state: row ? 'queued' : receipt.state === 'prepared' ? 'unknown' : receipt.state === 'rejected' ? 'rejected' : 'accepted', ...(receipt.code ? { code: receipt.code } : {}), replayed: false }; }
  enqueue({ intentId, text }) {
    const receiptFile = this.receiptPath(intentId);
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 32768) throw error('invalid_native_message');
    const payload = JSON.stringify({ UserInput: { content: [{ type: 'text', text, text_elements: [] }], client_id: intentId } });
    const digest = hash(payload);
    return this.withLock(db => {
      const old = readPrivate(receiptFile, null);
      if (old) {
        if (old.intentId !== intentId || old.conversationId !== this.conversationId || old.digest !== digest) throw error('native_intent_conflict');
        const row = this.row(db, intentId);
        if (row && hash(row.payload_json) !== digest) throw error('native_intent_conflict');
        // Prepared + absent could already have executed. Never insert again.
        return this.public(old, row);
      }
      if (this.row(db, intentId)) throw error('native_intent_conflict');
      const receipt = { intentId, conversationId: this.conversationId, digest, state: 'prepared', preparedAt: Date.now() };
      writePrivate(receiptFile, receipt); // fsync BEFORE the possible side effect.
      let inserted;
      try {
        const now = Date.now();
        inserted = db.prepare(`INSERT INTO queued_items (id,thread_id,payload_json,queue_order,created_at_ms,updated_at_ms)
          SELECT ?,?,?,COALESCE((SELECT MAX(queue_order) FROM queued_items WHERE thread_id=?),-1)+1,?,?
          WHERE (SELECT COUNT(*) FROM queued_items WHERE thread_id=?)<100
          RETURNING id`).get(intentId, this.conversationId, payload, this.conversationId, now, now, this.conversationId);
      } catch { return this.public(receipt, this.row(db, intentId)); }
      if (!inserted) { writePrivate(receiptFile, { ...receipt, state: 'rejected', code: 'native_queue_capacity' }); return { ...this.public(receipt, null), state: 'rejected', code: 'native_queue_capacity' }; }
      writePrivate(receiptFile, { ...receipt, state: 'accepted', acceptedAt: Date.now() });
      return this.public({ ...receipt, state: 'accepted' }, this.row(db, intentId));
    });
  }
  inspect(intentId) {
    return this.withLock(db => {
      const receipt = readPrivate(this.receiptPath(intentId), null);
      if (!receipt || receipt.conversationId !== this.conversationId) throw error('native_intent_not_found');
      return receipt.state === 'rejected' ? { ...this.public(receipt, null), state: 'rejected', code: receipt.code } : this.public(receipt, this.row(db, intentId));
    });
  }
}
