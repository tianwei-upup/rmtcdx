// Research fixture only: a fresh offline executor, never the running desktop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
// Reuse the checked-out upstream dependency only for this research fixture.
const WebSocket = createRequire(import.meta.url)('../services/rmtcdx/node_modules/ws');

if (process.platform !== 'darwin') throw new Error('macos_probe_only');
const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/rmt-shared-'));
fs.chmodSync(root, 0o700);
const home = path.join(root, 'home'), profile = path.join(home, '.codex'), workspace = path.join(root, 'workspace');
for (const dir of [profile, workspace, path.join(root, 'tmp')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const binary = fs.realpathSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
const socket = path.join(root, 'executor.sock'), policy = path.join(root, 'isolation.sb');
// Codex UDS deliberately uses a fixed per-uid physical directory, independently
// of HOME/TMPDIR. Grant only our random rendezvous hash and its own lock.
const socketRoot = path.join(fs.realpathSync('/tmp'), 'codex-daemon-' + process.getuid());
const socketRootExisted = fs.existsSync(socketRoot);
if (socketRootExisted) {
  const stat = fs.lstatSync(socketRoot);
  assert(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700);
}
const physicalSocket = path.join(socketRoot, crypto.createHash('sha256').update(socket).digest('hex'));
assert(!fs.existsSync(physicalSocket)); assert(!fs.existsSync(physicalSocket + '.lock'));
const q = JSON.stringify;
fs.writeFileSync(policy, `(version 1)
(allow default)
(deny network*)
(allow network* (local unix-socket (subpath ${q(root)})) (remote unix-socket (subpath ${q(root)})) (local unix-socket (literal ${q(physicalSocket)})) (remote unix-socket (literal ${q(physicalSocket)})))
(deny file-write*)
(allow file-write* (subpath ${q(root)}) (literal "/dev/null"))
(allow file-write-create (literal ${q(socketRoot)}))
(allow file-write* (literal ${q(physicalSocket)}) (literal ${q(physicalSocket + '.lock')}))
(deny file-read* (subpath ${q(path.join(os.homedir(), '.codex'))}) (subpath ${q(path.join(os.homedir(), 'Library/Keychains'))}))
`, { mode: 0o600 });
const env = { HOME: home, CODEX_HOME: profile, TMPDIR: path.join(root, 'tmp'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
const args = command => ['-f', policy, binary, ...command];
const children = new Set();
const groupSignal = (child, signal) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
const onExit = () => { for (const child of children) groupSignal(child, 'SIGKILL'); };
const onInterrupt = () => { onExit(); process.exit(130); };
process.once('exit', onExit); process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
let stderrBytes = 0;
function launch(command) {
  const child = spawn('/usr/bin/sandbox-exec', args(command), { cwd: workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) onExit(); });
  return child;
}
async function close(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise(resolve => child.once('close', resolve));
    groupSignal(child, 'SIGTERM');
    const timer = setTimeout(() => groupSignal(child, 'SIGKILL'), 1000);
    await closed; clearTimeout(timer);
  }
  groupSignal(child, 'SIGKILL'); children.delete(child);
}
const clients = new Set();
function client(name) {
  // The CLI proxy is a raw byte pipe; the UDS endpoint still needs a WebSocket handshake.
  assert.equal(fs.realpathSync(socket), physicalSocket);
  const ws = new WebSocket('ws://localhost/rpc', { createConnection: () => net.createConnection(socket), handshakeTimeout: 3000, maxPayload: 2 * 1024 * 1024 });
  const pending = new Map(); let sequence = 0, bytes = 0;
  const rejectAll = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  opened.catch(() => {});
  ws.on('error', rejectAll); ws.on('close', () => rejectAll(new Error('client_disconnected')));
  ws.on('message', data => {
    bytes += data.length;
    if (bytes > 2 * 1024 * 1024) { rejectAll(new Error('client_output_limit')); ws.terminate(); return; }
    try {
      const message = JSON.parse(data.toString()), item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error('probe_rpc_error_' + message.error.code + ':' + String(message.error.message).slice(0, 250))); else item.resolve(message.result);
    } catch (error) { rejectAll(error); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('rpc_timeout_' + method)); }, 6000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const value = { request, async initialize() {
    await opened;
    const result = await request('initialize', { clientInfo: { name, version: '0.1.0' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized', params: {} })); return result;
  }, async close() { rejectAll(new Error('probe_closed')); ws.terminate(); clients.delete(value); } };
  clients.add(value); return value;
}

let report;
try {
  const network = spawnSync('/usr/bin/sandbox-exec', ['-f', policy, process.execPath, '-e', "const n=require('net');const s=n.createServer();s.on('error',e=>process.exit(e.code==='EPERM'?0:2));s.listen(0,'127.0.0.1',()=>{s.close();process.exit(3)});"], { cwd: workspace, env, encoding: 'utf8', timeout: 3000 });
  assert.equal(network.status, 0, 'TCP must be denied');
  // proxy is attach-only: a missing socket must not bootstrap another executor.
  const absent = spawnSync('/usr/bin/sandbox-exec', args(['app-server', 'proxy', '--sock', socket]), { cwd: workspace, env, encoding: 'utf8', timeout: 3000 });
  assert.notEqual(absent.status, 0); assert.equal(absent.error, undefined); assert.equal(fs.existsSync(socket), false);
  const server = launch(['app-server', '--listen', 'unix://' + socket]);
  server.on('error', () => {}); server.stdout.resume();
  const end = Date.now() + 5000;
  while (!fs.existsSync(socket)) {
    if (Date.now() >= end || server.exitCode !== null || server.signalCode !== null) throw new Error('fixture_socket_unavailable');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const a = client('rmtcdx_fixture_desktop'), b = client('rmtcdx_fixture_apk');
  await a.initialize(); await b.initialize();
  const empty = await b.request('thread/list', { limit: 1 }); assert.deepEqual(empty.data, []);
  // Synthetic legacy history only: no desktop database or original rollout is copied.
  const id = crypto.randomUUID(), timestamp = new Date().toISOString();
  const fixture = path.join(profile, 'sessions', 'rollout-' + id + '.jsonl'); fs.mkdirSync(path.dirname(fixture), { mode: 0o700 });
  const rows = [
    { type: 'session_meta', payload: { id, timestamp, cwd: workspace, originator: 'rmtcdx_offline_fixture', cli_version: '0.162.0-alpha.17.2', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'fixture-turn', model_context_window: 100000, collaboration_mode_kind: 'default' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic history marker: shared-fixture-42', images: [], local_images: [], text_elements: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic history marker: shared-fixture-42' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic completed response.' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Synthetic completed response.' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fixture-turn', last_agent_message: 'Synthetic completed response.' } }
  ];
  fs.writeFileSync(fixture, rows.map(row => JSON.stringify({ timestamp, ...row })).join('\n') + '\n', { mode: 0o600 });
  const created = await a.request('thread/resume', { threadId: id, path: fixture, cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never' });
  assert.equal(created.thread.id, id);
  const loaded = await b.request('thread/loaded/list', {}); assert(loaded.data.includes(id));
  const resumed = await b.request('thread/resume', { threadId: id, cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never' });
  assert.equal(resumed.thread.id, id);
  assert(JSON.stringify(resumed.thread.turns).includes('shared-fixture-42'));
  await b.request('thread/name/set', { threadId: id, name: 'rmtcdx shared fixture' });
  assert.equal((await a.request('thread/read', { threadId: id })).thread.name, 'rmtcdx shared fixture');
  await b.close(); assert.equal(server.exitCode, null);
  assert((await a.request('thread/loaded/list', {})).data.includes(id));
  const c = client('rmtcdx_fixture_apk_reconnect'); await c.initialize();
  assert((await c.request('thread/loaded/list', {})).data.includes(id));
  assert.equal((await c.request('thread/read', { threadId: id })).thread.name, 'rmtcdx shared fixture');
  await c.close(); await a.close(); assert.equal(server.exitCode, null);
  report = { mode: 'offline-isolated-shared-executor', binarySha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), missingProxyDoesNotStartServer: 'PASS', twoClientsShareLoadedThread: 'PASS', resumePreservesThreadId: 'PASS', metadataVisibleAcrossClients: 'PASS', detachDoesNotStopServer: 'PASS', reconnectPreservesLoadedThread: 'PASS', tcpDenied: 'PASS', inference: 'NOT_EXECUTED', existingDesktop: 'NOT_CONNECTED', stderrBytes, root };
} finally {
  for (const value of [...clients]) await value.close();
  for (const child of [...children].reverse()) await close(child);
  for (const file of [physicalSocket, physicalSocket + '.lock']) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  // Remove the reserved directory only if this fixture created it and it is empty.
  if (!socketRootExisted) { try { fs.rmdirSync(socketRoot); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; } }
  process.removeListener('exit', onExit); process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
}
console.log(JSON.stringify({ ...report, fixtureChildrenStopped: 'PASS' }));
