import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Poll only our own tiny inbox metadata. In particular, never run recover(),
// expireRows(), or status() on somebody else's currently active consumer.
export class HistoryInboxReader {
  constructor({ database, conversationId, now = Date.now }) {
    const s = fs.lstatSync(database);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw Error('unsafe_history_inbox');
    this.db = new DatabaseSync(database, { readOnly: true }); this.now = now;
    if (this.db.prepare('SELECT thread_id FROM scope').get()?.thread_id !== conversationId) { this.db.close(); throw Error('history_inbox_scope_rejected'); }
    this.hasStandby = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='standby_policy'").get());
  }
  snapshot() {
    this.db.exec('BEGIN');
    try {
      const receipts = this.db.prepare("SELECT intent_id AS intentId,state,cancel_requested AS cancelRequested FROM jobs WHERE state IN ('queued','leased','unknown') ORDER BY created_at,rowid").all();
      const row = this.db.prepare('SELECT state,turn_id AS consumerTurnId,expires_at AS expiresAt FROM consumers ORDER BY rowid DESC LIMIT 1').get();
      const standby = this.hasStandby && this.db.prepare('SELECT enabled FROM standby_policy WHERE singleton=1').get()?.enabled === 1;
      const consumer = row && { ...row, state: row.state === 'active' && row.expiresAt <= this.now() && !standby ? 'closed' : row.state };
      return { receipts, consumer, ...(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_dispatch'").get()?{deliveryMode:'native'}:{}) };
    } finally { this.db.exec('ROLLBACK'); }
  }
  close() { this.db.close(); }
}
