import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeHistoryQueue, HISTORY_QUEUE_TEST_ID as id } from '../prototype/desktop-companion/src/native-history-queue.mjs';
import { HistoryReceiver } from '../prototype/desktop-companion/src/history-receiver.mjs';
import { checkDesktopRuntime, runReceiverTick } from '../prototype/desktop-companion/src/desktop-runtime.mjs';
import { HistoryInboxReader } from '../prototype/desktop-companion/src/history-inbox-reader.mjs';
import { acquireOwner, readPrivate, writePrivate } from '../prototype/desktop-companion/src/state.mjs';
const config = readPrivate(path.resolve(process.argv[2]), null);
if (config?.enabled !== true || !Number.isSafeInteger(config.desktopPid)) throw Error('native_history_scope_required');
const project = config.projectQueueConfig ? readPrivate(config.projectQueueConfig, null) : null;
const ids = project ? config.threadIds : [config.conversationId];
if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || !project && ids[0] !== id) throw Error('native_history_scope_required');
const release = acquireOwner(config.runtime), exec = promisify(execFile);
const checkDesktop = () => checkDesktopRuntime();
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
 try { await runReceiverTick({checkDesktop,ids:receivers.map(r=>r.conversationId),receive:id=>receivers.find(r=>r.conversationId===id).tick(),unavailable:(id,e)=>publish(id,{state:'unavailable',code:/^[a-z_]+$/.test(e.code??'')?e.code:'history_receiver_unavailable',...(e.code==='desktop_build_changed'?{desktopVersion:e.desktopVersion,supportedVersions:e.supportedVersions}:{})})}); }
 finally { ticking = false; }
}
await tick(); const timer = setInterval(() => void tick(), 1000);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopped = true; clearInterval(timer); Promise.allSettled(receivers.map(r => r.pending)).finally(() => { for (const reader of readers) reader.close(); release(); process.exit(0); }); });
