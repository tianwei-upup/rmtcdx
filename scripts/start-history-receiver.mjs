import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeHistoryQueue, HISTORY_QUEUE_TEST_ID as id } from '../prototype/desktop-companion/src/native-history-queue.mjs';
import { HistoryReceiver } from '../prototype/desktop-companion/src/history-receiver.mjs';
import { HistoryInboxReader } from '../prototype/desktop-companion/src/history-inbox-reader.mjs';
import { acquireOwner, readPrivate, writePrivate } from '../prototype/desktop-companion/src/state.mjs';
const config = readPrivate(path.resolve(process.argv[2]), null);
if (config?.enabled !== true || !Number.isSafeInteger(config.desktopPid)) throw Error('native_history_scope_required');
const project = config.projectQueueConfig ? readPrivate(config.projectQueueConfig, null) : null;
const ids = project ? config.threadIds : [config.conversationId];
if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || !project && ids[0] !== id) throw Error('native_history_scope_required');
const release = acquireOwner(config.runtime), exec = promisify(execFile);
const checkDesktop = async () => {
  if (JSON.parse(fs.readFileSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-package.json', 'utf8')).version !== '0.163.0-alpha.10.2') throw Error('desktop_build_changed');
  const { stdout } = await exec('/bin/ps', ['-axo', 'uid=,pid=,comm=']);
  const processes = stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(m => m && Number(m[1]) === process.getuid() && m[3] === '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
  if (processes.length !== 1) throw Error('original_desktop_unavailable');
};
let stopped = false; const previous = new Map(), readers = [], receivers = [];
const publish = (conversationId, value) => {
  const signature = JSON.stringify(value);
  if (signature === previous.get(conversationId)) return;
  previous.set(conversationId, signature); writePrivate(path.join(config.runtime, ids.length === 1 ? 'receiver.json' : conversationId + '.json'), { ...value, conversationId, at: Date.now(), pid: process.pid });
  console.log(JSON.stringify({ event: 'history.receiver', ...value, conversationId }));
};
for (const conversationId of ids) {
 const queue = new NativeHistoryQueue({ database: config.database, runtime: project ? path.join(config.runtime, 'receipts', conversationId) : path.join(config.runtime, 'receipts'), conversationId, enabled: true, ...(project ? { grant: project.grant, desktopStateFile: project.desktopStateFile, metadataDatabase: config.metadataDatabase } : {}) });
 const reader = new HistoryInboxReader({ database: path.join(project?.runtime ?? config.queueRuntime, conversationId, 'inbox.sqlite'), conversationId }); readers.push(reader);
 const receiver = new HistoryReceiver({ conversationId, nativeQueue: queue,
  readQueue: async () => reader.snapshot(),
  // A normal native route loads the desktop view/owner as well as execution.
  // The wake-only route resumes Core but leaves followers/approvals ownerless.
  // This may change the displayed chat; no prompt/start/steer is sent by URL.
  wake: async threadId => { await checkDesktop(); await exec('/usr/bin/open', ['-g', '-a', '/Applications/ChatGPT.app', 'codex://threads/' + threadId], { timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: '/Users/liutianwei', LANG: 'en_US.UTF-8' } }); }, publish: value => publish(conversationId, value) });
 receivers.push(receiver);
}
let ticking = false;
async function tick() {
 if (stopped || ticking) return; ticking = true;
 try { await checkDesktop(); for (const receiver of receivers) try { await receiver.tick(); } catch (e) { publish(receiver.conversationId, { state: 'unavailable', code: /^[a-z_]+$/.test(e.code ?? '') ? e.code : 'history_receiver_unavailable' }); } }
 catch { for (const receiver of receivers) publish(receiver.conversationId, { state: 'unavailable', code: 'original_desktop_unavailable' }); }
 finally { ticking = false; }
}
await tick(); const timer = setInterval(() => void tick(), 1000);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopped = true; clearInterval(timer); Promise.allSettled(receivers.map(r => r.pending)).finally(() => { for (const reader of readers) reader.close(); release(); process.exit(0); }); });
