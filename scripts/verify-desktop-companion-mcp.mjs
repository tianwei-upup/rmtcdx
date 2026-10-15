// Only the explicitly granted test target may receive these read-only prompts.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { control } from '../prototype/desktop-companion/src/control.mjs';
const base = path.resolve('.runtime/desktop-companion-mcp'), scope = JSON.parse(fs.readFileSync(path.join(base, 'scope.json')));
const threadId = scope.threadIds[0], call = value => control(scope.runtime, { threadId, ...value });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const prompts = {
  'mcp-lock-20261015-1': '这是用户授权的专用会话并发验收。本轮先只调用一次 shell 工具执行 sleep 12，等待命令完成；不要读取或修改任何文件，不要操作其他聊天。然后只回复 LOCK1 加上本会话先前记忆的标记，中间用一个空格。',
  'mcp-restart-20261015-2': '这是专用会话 MCP 服务重启后第二轮验收。不要调用工具或操作文件。仅回复 MCPRESTART 加上本会话先前记忆的标记，再加上 | PREVIOUS 和上一轮 LOCK1 的完整回复。'
};
async function wait(predicate) { for (let i = 0; i < 120; i++) { const value = await predicate(); if (value) return value; await delay(500); } throw Error('acceptance_timeout'); }
async function restart() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(base, 'acceptance-host.sock')); let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(Error('restart_timeout')); }, 15000);
    socket.setEncoding('utf8'); socket.on('error', reject); socket.on('connect', () => socket.write(JSON.stringify({ operation: 'restart' }) + '\n'));
    socket.on('data', chunk => { data += chunk; if (data.includes('\n')) { clearTimeout(timer); socket.destroy(); resolve(JSON.parse(data)); } });
  });
}
const reportFile = path.join(base, 'live-acceptance.json');
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile)) : {};
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
if (report.passed) {
  const status = await call({ operation: 'status' }); assert.equal(status.ready, true);
  for (const intentId of Object.keys(prompts)) {
    const receipt = await call({ operation: 'receipt', intentId }); assert.equal(receipt.state, 'completed');
  }
  const snapshot = await call({ operation: 'snapshot' }); assert.equal(snapshot.thread.id, threadId);
  fs.writeFileSync(path.join(base, 'read-only-recheck.json'), JSON.stringify({ passed: true, status, historicalReportPreserved: true }), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, readOnlyRecheck: true, historicalReportPreserved: true, pid: status.pid }));
  process.exit(0);
}
report.initial = await call({ operation: 'status' }); assert.equal(report.initial.ready, true); save();
const firstId = Object.keys(prompts)[0];
report.first = await call({ operation: 'send', intentId: firstId, text: prompts[firstId] }); save();
if (!report.restart) {
  const receipt = await wait(async () => { const r = await call({ operation: 'receipt', intentId: firstId }); return r.turnId && r.state === 'running' ? r : false; });
  report.running = receipt;
  await assert.rejects(call({ operation: 'send', intentId: 'mcp-busy-must-not-send', text: 'THIS MUST NEVER BE SENT' }), { code: 'test_thread_busy' }); report.busyRejected = true;
  report.restart = await restart(); assert.equal(report.restart.restarted, true); save();
}
await wait(async () => (await call({ operation: 'status' })).ready);
report.afterRestart = await call({ operation: 'status' });
report.duplicate = await call({ operation: 'send', intentId: firstId, text: prompts[firstId] }); assert.equal(report.duplicate.turnId, report.running.turnId); save();
report.firstDone = await wait(async () => { const r = await call({ operation: 'receipt', intentId: firstId }); return r.state === 'completed' ? r : false; }); save();
const secondId = Object.keys(prompts)[1]; report.second = await call({ operation: 'send', intentId: secondId, text: prompts[secondId] }); save();
report.secondDone = await wait(async () => { const r = await call({ operation: 'receipt', intentId: secondId }); return r.state === 'completed' ? r : false; });
report.snapshot = await call({ operation: 'snapshot' });
const text = report.snapshot.turns.flatMap(turn => turn.items.filter(item => item.type === 'agentMessage').map(item => item.text)).join('\n');
assert.match(text, /LOCK1 LANTERN-4826/); assert.match(text, /MCPRESTART LANTERN-4826 \| PREVIOUS LOCK1 LANTERN-4826/);
report.finalStatus = await call({ operation: 'status' }); assert.equal(report.finalStatus.holds.length, 0);
report.passed = true; report.desktopRestarted = false; save();
console.log(JSON.stringify({ passed: true, initialPid: report.initial.pid, recoveredPid: report.afterRestart.pid, sameThreadId: threadId, firstTurnId: report.firstDone.turnId, secondTurnId: report.secondDone.turnId, busyRejected: true, replayed: false, desktopRestarted: false }));
