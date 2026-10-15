import fs from 'node:fs';
import path from 'node:path';
import { startAgent } from '../business/src/agent.mjs';
import { desktopProjects } from '../business/src/projects.mjs';
import { assertIsolatedNativeRuntime, assertNativeExecutionAllowed } from '../business/src/runtime-isolation.mjs';
assertNativeExecutionAllowed();
const root = path.resolve(import.meta.dirname, '..');
const runtime = path.resolve(root, process.env.RMT_BUSINESS_TEST_RUNTIME ?? '.runtime/business-ecs');
const config = JSON.parse(fs.readFileSync(path.join(runtime, 'local.json')));
const nativeRuntimeHome = assertIsolatedNativeRuntime(config.nativeRuntimeHome);
if (!config.origin.startsWith('https://')) throw new Error('https_required');
const stateFile = path.join(runtime, 'agent.json');
let pairCode;
if (!fs.existsSync(stateFile)) {
  const response = await fetch(config.origin + '/api/login', { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: config.password }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('remote_login_failed');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const pair = await fetch(config.origin + '/api/pairing', { method: 'POST', headers: { origin: config.origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: config.deviceId, name: 'Mac' }), signal: AbortSignal.timeout(15000) });
  if (!pair.ok) throw new Error('remote_pairing_failed');
  pairCode = (await pair.json()).code;
}
const agent = await startAgent({ origin: config.origin, deviceId: config.deviceId, stateFile, pairCode, nativeRuntimeHome,
  projects: () => desktopProjects(config.desktopStateFile ?? path.join(process.env.HOME, '.codex/.codex-global-state.json'), [{ id: 'rmtagt-compat', name: '隔离验证', path: path.join(root, '.runtime/compat-workspace') }]) });
console.log(JSON.stringify({ event: 'business.remote.agent.ready', origin: config.origin, deviceId: config.deviceId, mode: 'real-read-only' }));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { if (stopping) return; stopping = true; await agent.stop(); process.exit(0); });
