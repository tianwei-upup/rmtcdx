// Offline diagnostic only. Never pairs a worker or sends a prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

if (process.platform !== 'darwin') throw new Error('macos_probe_only');
const binary = fs.realpathSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmtcdx-offline-')));
fs.chmodSync(root, 0o700);
const home = path.join(root, 'home'), profile = path.join(home, '.codex');
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, 'tmp'), { mode: 0o700 });
const quote = value => JSON.stringify(value);
const protectedPaths = [path.join(os.homedir(), '.codex'), path.join(os.homedir(), 'Library/Keychains')];
const policy = `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath ${quote(root)}) (literal "/dev/null"))
${protectedPaths.map(p => `(deny file-read* (subpath ${quote(p)}))`).join('\n')}
`;
const policyFile = path.join(root, 'offline.sb'); fs.writeFileSync(policyFile, policy, { mode: 0o600 });
// Build from an allowlist, never inherit desktop app context, auth, proxies or NODE_OPTIONS.
const env = { HOME: home, CODEX_HOME: profile, TMPDIR: path.join(root, 'tmp'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
const sandbox = (command, args) => spawnSync('/usr/bin/sandbox-exec', ['-f', policyFile, command, ...args], { cwd: home, env, encoding: 'utf8', timeout: 3000 });
const outside = path.join(fs.realpathSync(os.tmpdir()), 'rmtcdx-denied-' + crypto.randomUUID());
let child, deadline;
const kill = signal => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
const onExit = () => kill('SIGKILL');
const onInterrupt = () => { kill('SIGKILL'); process.exit(130); };
process.once('exit', onExit);
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);
try {
  const desktopState = path.join(protectedPaths[0], '.codex-global-state.json');
  if (!fs.existsSync(desktopState)) throw new Error('probe_desktop_canary_missing');
  const forbiddenRead = sandbox('/bin/cat', [desktopState]);
  const forbiddenWrite = sandbox('/usr/bin/touch', [outside]);
  const allowedWrite = sandbox('/usr/bin/touch', [path.join(root, 'allowed')]);
  const network = sandbox(process.execPath, ['--input-type=module', '-e', "import net from 'node:net'; const s=net.createServer(); s.on('error',e=>process.exit(e.code==='EPERM'?0:2)); s.listen(0,'127.0.0.1',()=>{s.close();process.exit(3)});"]);
  if (forbiddenRead.status === 0 || !/Operation not permitted/.test(forbiddenRead.stderr) || forbiddenWrite.status === 0 || !/Operation not permitted/.test(forbiddenWrite.stderr) || fs.existsSync(outside) || allowedWrite.status !== 0 || network.status !== 0) throw new Error('os_sandbox_preflight_failed');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  child = spawn('/usr/bin/sandbox-exec', ['-f', policyFile, binary, 'app-server', '--listen', 'stdio://'], { cwd: home, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0, bytes = 0, stderrBytes = 0;
  const rejectAll = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on('error', rejectAll);
  child.on('exit', () => rejectAll(new Error('probe_child_exited')));
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) { rejectAll(new Error('probe_stderr_limit')); kill('SIGKILL'); } });
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { rejectAll(new Error('probe_stdout_limit')); kill('SIGKILL'); } });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line), item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error('probe_rpc_error_' + message.error.code)); else item.resolve(message.result);
    } catch { rejectAll(new Error('probe_invalid_json')); }
  });
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
  deadline = setTimeout(() => { rejectAll(new Error('probe_timeout')); kill('SIGKILL'); }, 15000);
  const initialized = await request('initialize', { clientInfo: { name: 'rmtcdx_offline_probe', version: '0.1.0' }, capabilities: {} });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  if (initialized.codexHome && fs.realpathSync(initialized.codexHome) !== profile) throw new Error('probe_wrong_codex_home');
  const threads = await request('thread/list', { limit: 1, archived: false });
  if (!Array.isArray(threads.data) || threads.data.length !== 0) throw new Error('probe_profile_not_empty');
  console.log(JSON.stringify({ mode: 'offline-diagnostic-only', binarySha256: sha256, initialize: 'PASS', emptyThreadList: 'PASS', deniedDesktopRead: 'PASS', deniedOutsideWrite: 'PASS', deniedNetworkListen: 'PASS', network: 'denied-by-policy', inheritedDesktopContext: false, stderrBytes, root }));
} finally {
  clearTimeout(deadline);
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise(resolve => child.once('close', resolve));
    child.stdin.destroy(); kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 2000);
    await closed; clearTimeout(timer);
  }
  // Also remove descendants if the direct child exited before cleanup began.
  kill('SIGKILL');
  process.removeListener('exit', onExit);
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
  // Retain only this fresh diagnostic profile for inspection; never delete desktop state.
  if (fs.existsSync(outside)) fs.unlinkSync(outside);
}
