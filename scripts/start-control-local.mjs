import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pairDevice } from '../control/src/client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime');
const base = 'http://127.0.0.1:3220';
fs.mkdirSync(runtime, { recursive: true });
if (await fetch(`${base}/healthz`).then(() => true, () => false)) throw new Error('Port 3220 is occupied; stop the existing control service first.');
const health = await fetch('http://127.0.0.1:3210/healthz').then(r => r.json());
if (!health.ok || health.codex?.mode !== 'real' || !health.codex?.ready) throw new Error('Start the real local bridge before the relay.');
const authFile = path.join(runtime, 'control-admin.json');
const credentials = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, 'utf8')) : { username: 'admin', password: crypto.randomBytes(32).toString('base64url') };
fs.writeFileSync(authFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
const children = [];
function launch(name, entry, env) {
  const out = fs.openSync(path.join(runtime, `${name}.stdout.log`), 'a');
  const err = fs.openSync(path.join(runtime, `${name}.stderr.log`), 'a');
  try {
    const child = spawn(process.execPath, [entry], { cwd: root, env: { ...process.env, ...env }, detached: true, windowsHide: true, stdio: ['ignore', out, err] });
    child.unref();
    children.push({ name, pid: child.pid, entry });
    return child;
  } finally { fs.closeSync(out); fs.closeSync(err); }
}
try {
  launch('control', path.join(root, 'control/src/cloud.mjs'), {
    RMT_HOST: '127.0.0.1', RMT_PORT: '3220', RMT_PUBLIC_URL: base,
    RMT_ADMIN_USERNAME: credentials.username, RMT_ADMIN_PASSWORD: credentials.password,
    RMT_ADMIN_PASSWORD_HASH: '', RMT_STATE_FILE: path.join(runtime, 'cloud-state.json')
  });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (await fetch(`${base}/healthz`).then(r => r.ok, () => false)) { ready = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!ready) throw new Error('Cloud startup failed; inspect .runtime/control.stderr.log');
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  if (!login.ok) throw new Error('Local cloud login failed');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/pairing`, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'windows', name: '家庭 Windows' }) });
  const pairing = await response.json();
  if (!response.ok) throw new Error(pairing.message);
  const configFile = path.join(runtime, 'windows-client.json');
  await pairDevice({ serverUrl: base, deviceId: 'windows', code: pairing.code, configFile });
  launch('windows-client', path.join(root, 'control/src/client.mjs'), { RMT_CLIENT_CONFIG: configFile });
  fs.writeFileSync(path.join(runtime, 'control-processes.json'), JSON.stringify(children, null, 2));
  for (let i = 0; i < 60; i++) {
    const response = await fetch(`${base}/devices/windows/healthz`, { headers: { Cookie: cookie } });
    const value = await response.json();
    if (response.ok && value.codex?.mode === 'real' && value.codex?.ready) {
      console.log(`PASS: local cloud -> Windows client -> real Codex at ${base}`);
      console.log('Login credentials: .runtime/control-admin.json (not printed)');
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Windows relay did not become ready');
} catch (error) {
  for (const child of children.reverse()) { try { process.kill(child.pid); } catch {} }
  throw error;
}
