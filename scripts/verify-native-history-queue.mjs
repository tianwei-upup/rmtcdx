// Local acceptance only. Sends exactly two read-only native user submissions to
// the fixed historical acceptance chat. A saved attempt is never replayed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { NativeHistoryQueue, HISTORY_QUEUE_TEST_ID as id } from '../prototype/desktop-companion/src/native-history-queue.mjs';
import { DesktopStream } from '../prototype/desktop-companion/src/desktop-stream.mjs';
import { nativeTurns } from '../prototype/desktop-companion/src/desktop-view.mjs';
import { control } from '../prototype/desktop-companion/src/control.mjs';
import { privateDirectory, writePrivate } from '../prototype/desktop-companion/src/state.mjs';

const scenario = process.argv[2] ?? 'acceptance';
if (!/^[a-z-]{1,40}$/.test(scenario)) throw Error('invalid_acceptance_scenario');
const runtime = path.resolve('.runtime/history-entry-20261021', scenario); privateDirectory(runtime);
const reportFile = path.join(runtime, 'report.json');
if (fs.existsSync(reportFile)) throw Error('acceptance_attempt_exists_do_not_replay');
const database = '/Users/liutianwei/.codex/queue_1.sqlite';
const queue = new NativeHistoryQueue({ database, runtime: path.join(runtime, 'receipts'), conversationId: id, enabled: true });
const config = JSON.parse(fs.readFileSync('.runtime/realtime-validation/config.json'));
const local = await control(config.runtime, { operation: 'status', threadId: id });
if (local.standby?.enabled || local.consumer?.state === 'active') throw Error('acceptance_consumer_must_be_inactive');
const stream = new DesktopStream({ endpoint: '/Users/liutianwei/.codex/ipc/ipc.sock', conversationId: id, expectedCwd: '/Users/liutianwei/Documents/Codex/2026-10-15/rmtcdx-companion-acceptance-20261015' });
const report = { at: new Date().toISOString(), conversationId: id, nativeStartSteerCalls: 0, executorProcessesStarted: 0, attempts: [], observations: [] };
const save = () => writePrivate(reportFile, report);
const before = new DatabaseSync(database, { readOnly: true });
const revisions = db => db.prepare('SELECT thread_id,revision FROM queued_thread_revisions WHERE thread_id<>? ORDER BY thread_id').all(id);
report.otherQueueRevisionsBefore = revisions(before); before.close();
const turns = () => nativeTurns(stream.state).turns;
const textHash = text => crypto.createHash('sha256').update(text).digest('hex');
const find = intent => {
  const expected = report.attempts.find(a => a.intentId === intent)?.textHash;
  return turns().find(t => t.params?.clientUserMessageId === intent || (t.items ?? []).some(i => i.clientUserMessageId === intent || i.type === 'userMessage' && expected && textHash((i.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('')) === expected));
};
const summary = t => t && ({ turnId: t.turnId ?? t.entityKey, state: t.status, text: (t.items ?? []).filter(i => i.type === 'agentMessage').map(i => i.text ?? '').join('\n'), itemTypes: (t.items ?? []).map(i => i.type) });
async function until(predicate, limit = 120000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { if (!stream.ready) throw Error('acceptance_observer_unavailable'); const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 200)); }
  throw Error('acceptance_observation_timeout_no_replay');
}
function append(text) {
  const request = { intentId: crypto.randomUUID(), text };
  report.attempts.push({ intentId: request.intentId, textHash: textHash(text), at: Date.now(), state: 'prepared' }); save();
  const result = queue.enqueue(request); Object.assign(report.attempts.at(-1), result); save();
  console.log(JSON.stringify({ event: 'native.history.enqueued', ...result }));
  if (!['queued', 'accepted'].includes(result.state)) throw Error('acceptance_admission_unknown_no_replay');
  return request.intentId;
}
try {
  await stream.start();
  if (stream.state.threadRuntimeStatus?.type === 'active' || turns().some(t => t.status === 'inProgress')) throw Error('acceptance_not_idle');
  report.turnIdsBefore = turns().map(t => t.turnId ?? t.entityKey); save();
  const seed = 'HISTORY_SEED_' + crypto.randomBytes(6).toString('hex'); report.seed = seed;
  const first = append(`这是用户授权的历史会话接入只读验收。记住口令 ${seed}。仅在当前专用测试目录执行一次 python3 -c 'import time; time.sleep(12); print("HISTORY_BUSY_DONE")'，等待该命令结束后回复口令和 HISTORY_ROUND1_DONE。不要写文件、不要发送其他会话消息、不要调用 MCP 领取工具、不要开启待命。`);
  const busy = await until(() => { const t = find(first); return t?.status === 'inProgress' && t; });
  report.busyBeforeSecond = summary(busy); report.busyAt = Date.now(); save();
  const second = append('继续同一历史会话的只读验收：请回复上一条消息要求记住的完整口令，并附加 HISTORY_ROUND2_DONE。不要执行任何工具，不要开启 MCP 领取或待命，不要操作其他会话。');
  report.secondEnqueuedWhileFirstInProgress = find(first)?.status === 'inProgress'; save();
  const firstDone = await until(() => { const t = find(first); return t && t.status !== 'inProgress' && t; });
  report.first = summary(firstDone); save(); console.log(JSON.stringify({ event: 'native.history.first.finished', turnId: report.first.turnId, state: report.first.state }));
  const secondDone = await until(() => { const t = find(second); return t && t.status !== 'inProgress' && t; });
  report.second = summary(secondDone);
  report.passed = report.secondEnqueuedWhileFirstInProgress && report.first.turnId !== report.second.turnId && report.first.state === 'completed' && report.second.state === 'completed' && report.first.text.includes(seed) && report.second.text.includes(seed) && report.second.text.includes('HISTORY_ROUND2_DONE');
  report.receipts = [queue.inspect(first), queue.inspect(second)]; save();
  console.log(JSON.stringify({ event: 'native.history.finished', passed: report.passed, turnIds: [report.first.turnId, report.second.turnId], originalId: id, contextRetained: report.second.text.includes(seed) }));
} catch (e) { report.error = e.code ?? e.message; save(); console.log(JSON.stringify({ event: 'native.history.failed', code: report.error })); process.exitCode = 1; }
finally {
  const db = new DatabaseSync(database, { readOnly: true }); report.otherQueueRevisionsAfter = revisions(db); db.close();
  report.otherQueuesUnchanged = JSON.stringify(report.otherQueueRevisionsBefore) === JSON.stringify(report.otherQueueRevisionsAfter); save(); stream.close();
}
