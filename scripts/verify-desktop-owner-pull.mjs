import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { OwnerInbox } from '../prototype/desktop-companion/src/inbox.mjs';
import { readPrivate, writePrivate } from '../prototype/desktop-companion/src/state.mjs';
const base = path.resolve(import.meta.dirname, '../.runtime/desktop-companion-mcp');
const scope = readPrivate(path.join(base, 'scope.json'), null);
assert.equal(scope.mode, 'test'); assert.equal(scope.callerThreadId, '01a13fef-a018-7303-a2a6-f5903548537f');
const jobs = [
  { intentId: 'owner-pull-20261015-round1', text: '这是已授权的专用手机队列只读验证。记住代码 MAPLE-7319，只回复 PULL1 MAPLE-7319。不要操作文件、shell、网络或其他聊天。', expected: 'PULL1 MAPLE-7319' },
  { intentId: 'owner-pull-20261015-round2', text: '沿用上一条队列消息的代码，只回复 PULL2 <代码> | PREVIOUS PULL1 <代码>。不要操作文件、shell、网络或其他聊天。', expected: 'PULL2 MAPLE-7319 | PREVIOUS PULL1 MAPLE-7319' }
];
const queue = new OwnerInbox({ runtime: scope.runtime, threadId: scope.callerThreadId });
const nativeReceiptHash = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(scope.runtime, 'receipts.json'))).digest('hex');
const baselineFile = path.join(base, 'owner-pull-baseline.json');
try {
  if (process.argv[2] === 'prepare') {
    if (!fs.existsSync(baselineFile)) writePrivate(baselineFile, { nativeReceiptHash: nativeReceiptHash(), recordedAt: new Date().toISOString() });
    const receipts = jobs.map(job => queue.enqueue(job.intentId, job.text));
    assert.deepEqual(queue.enqueue(jobs[0].intentId, jobs[0].text), receipts[0]);
    assert.throws(() => queue.enqueue(jobs[0].intentId, 'conflicting body'), { code: 'inbox_intent_conflict' });
    console.log(JSON.stringify({ threadId: scope.callerThreadId, jobs: receipts, dedupPassed: true, conflictRejected: true }));
  } else if (process.argv[2] === 'report') {
    const receipts = queue.receipts();
    for (const job of jobs) {
      const receipt = receipts.find(r => r.intentId === job.intentId);
      assert.equal(receipt?.state, 'completed'); assert.equal(receipt.result, job.expected);
      assert.equal(queue.enqueue(job.intentId, job.text).state, 'completed');
    }
    assert.equal(nativeReceiptHash(), readPrivate(baselineFile, null).nativeReceiptHash);
    const turns = queue.db.prepare('SELECT DISTINCT consumer_turn AS turnId FROM jobs WHERE intent_id IN (?,?)').all(...jobs.map(j => j.intentId));
    const report = { recordedAt: new Date().toISOString(), passed: true, threadId: scope.callerThreadId, jobs: receipts, queue: queue.status(), consumerTurnsFromMetadata: turns, completedIntentReplaySkipped: true, nativeCompanionReceiptsUnchanged: true, ecsApkWritesEnabled: false };
    writePrivate(path.join(base, 'owner-pull-acceptance.json'), report); console.log(JSON.stringify(report, null, 2));
  } else throw Error('usage: verify-desktop-owner-pull.mjs prepare|report');
} finally { queue.close(); }
