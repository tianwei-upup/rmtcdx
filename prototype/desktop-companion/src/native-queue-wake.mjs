import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkDesktopRuntime } from './desktop-runtime.mjs';
import { HISTORY_QUEUE_TEST_ID } from './native-history-queue.mjs';
import { PersonalScope } from './personal-scope.mjs';

const exec = promisify(execFile);
const app = '/Applications/ChatGPT.app';
// These installed sources were inspected and exercised together. In particular,
// wake is handled outside navigation and sends no turn/start or turn/steer.
const entries = Object.freeze({
  '.vite/build/bootstrap-DCRTDDSX.js': '18ad69fcbc0ecda53536a78b83b6b76bdf2ae2dda6231c7f6f68334cbcc33d39',
  '.vite/build/main-JI9qDiXp.js': 'b8c5d07cc3c30fbf0abe729b05434e7d1ffa19ee6c4daa818ae8f855be66d1e1'
});
let verifiedStamp;
const fail = () => { throw Object.assign(Error('native_queue_wake_build_changed'), { code: 'native_queue_wake_build_changed' }); };

export function checkQueueWakeBuild({ archive = app + '/Contents/Resources/app.asar' } = {}) {
  const st = fs.lstatSync(archive);
  if (!st.isFile() || st.isSymbolicLink()) fail();
  const stamp = [archive, st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');
  if (verifiedStamp === stamp) return;
  const fd = fs.openSync(archive, 'r');
  try {
    const read = (size, position) => {
      const buffer = Buffer.alloc(size);
      if (fs.readSync(fd, buffer, 0, size, position) !== size) fail();
      return buffer;
    };
    const prefix = read(16, 0), headerSize = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || headerSize > 16 * 1024 * 1024 || headerSize < 2) fail();
    const header = JSON.parse(read(headerSize, 16).toString('utf8'));
    for (const [name, expected] of Object.entries(entries)) {
      let entry = header;
      for (const part of name.split('/')) entry = entry?.files?.[part];
      if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > 8 * 1024 * 1024) fail();
      const offset = 8 + prefix.readUInt32LE(4) + Number(entry.offset);
      if (!Number.isSafeInteger(offset) || offset < 16 + headerSize || offset + entry.size > st.size) fail();
      if (crypto.createHash('sha256').update(read(entry.size, offset)).digest('hex') !== expected) fail();
    }
    verifiedStamp = stamp;
  } finally { fs.closeSync(fd); }
}

// A hint after durable admission, never an admission receipt. Duplicate/lost
// hints are harmless: the original native queue retains the only user input.
// Other chats require the current local project's explicit membership grant.
export async function wakeNativeQueue({ conversationId, personalScope, checkScope, log = () => {},
  checkRuntime = checkDesktopRuntime, verifyBuild = checkQueueWakeBuild, run = exec }) {
  if (personalScope!==undefined && !(personalScope instanceof PersonalScope) || conversationId !== HISTORY_QUEUE_TEST_ID && !(personalScope instanceof PersonalScope) || typeof checkScope !== 'function') {
    throw Object.assign(Error('native_direct_scope_required'), { code: 'native_direct_scope_required' });
  }
  let original;
  const check=()=>{const current=personalScope?.check(conversationId,{write:true});if(original&&(original.cwd!==current.cwd||original.projectId!==current.projectId))throw Object.assign(Error('native_direct_scope_changed'),{code:'native_direct_scope_changed'});original??=current;return checkScope(conversationId,{write:true});};
  check();
  await checkRuntime();
  verifyBuild();
  check();
  const started = Date.now();
  try {
    await run('/usr/bin/open', ['-g', '-a', app, 'codex://threads/wake/' + conversationId], { timeout: 5000 });
    log({ event: 'native.queue.wake.dispatched', conversationId, at: started, elapsedMs: Date.now() - started });
    return { state: 'notification_dispatched' };
  } catch {
    // open may time out after delivering the URL. Native polling remains the
    // recovery path; do not reinsert the body or claim that a turn has started.
    log({ event: 'native.queue.wake.unknown', conversationId, at: started, elapsedMs: Date.now() - started });
    return { state: 'notification_unknown' };
  }
}
