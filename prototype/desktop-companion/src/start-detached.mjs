// Run with the desktop's bundled signed Node, from a dedicated test chat.
// Wait for an authenticated connection before letting the launcher exit.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { control } from './control.mjs';

const [runtimeArgument, ...allowed] = process.argv.slice(2), runtime = path.resolve(runtimeArgument);
if (!process.env.CODEX_THREAD_ID || !process.env.CODEX_APP_TOOLS_PIPE_PATH || !allowed.length) throw Error('desktop_context_and_test_allowlist_required');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const log = fs.openSync(path.join(runtime, 'companion.jsonl'), 'a', 0o600);
const child = spawn(process.execPath, [fileURLToPath(new URL('./companion.mjs', import.meta.url)), runtime, ...allowed], {
  detached: true, stdio: ['ignore', log, log],
  env: { PATH: process.env.PATH, CODEX_THREAD_ID: process.env.CODEX_THREAD_ID, CODEX_APP_TOOLS_PIPE_PATH: process.env.CODEX_APP_TOOLS_PIPE_PATH }
});
fs.closeSync(log); child.unref();
let ready;
for (let i = 0; i < 100; i++) {
  try { ready = await control(runtime, { operation: 'status' }, 1000); if (ready.ready && ready.pid === child.pid) break; }
  catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!ready?.ready || ready.pid !== child.pid) {
  // This process owns this exact child; no discovery or unrelated PID killing.
  child.kill('SIGTERM'); throw Error('companion_start_not_confirmed');
}
console.log(JSON.stringify({ launched: true, launcherPid: process.pid, companionPid: child.pid, callerThreadId: ready.callerThreadId, runtime }));
