import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBusinessServer } from '../business/src/server.mjs';
import { startAgent } from '../business/src/agent.mjs';
import { assertIsolatedNativeRuntime, assertNativeExecutionAllowed } from '../business/src/runtime-isolation.mjs';
assertNativeExecutionAllowed();
const root = path.resolve(import.meta.dirname, '..'), runtime = path.join(root, '.runtime/business');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const configFile = path.join(runtime, 'local.json');
if (!fs.existsSync(configFile)) {
  if (!process.env.RMT_BUSINESS_LAN_IP) throw new Error('Set RMT_BUSINESS_LAN_IP to the LAN address included in the TLS certificate');
  fs.writeFileSync(configFile, JSON.stringify({ origin: `https://${process.env.RMT_BUSINESS_LAN_IP}:3230`, password: crypto.randomBytes(32).toString('base64url'), deviceId: 'mac' }), { mode: 0o600 });
}
const config = JSON.parse(fs.readFileSync(configFile));
const nativeRuntimeHome = assertIsolatedNativeRuntime(config.nativeRuntimeHome);
const service = await createBusinessServer({ origin: config.origin, password: config.password, stateFile: path.join(runtime, 'server.json'), tls: { key: fs.readFileSync(path.join(runtime, 'tls/server.key')), cert: fs.readFileSync(path.join(runtime, 'tls/server.pem')) } });
await service.listen(3230, '0.0.0.0');
const login = await fetch(config.origin + '/api/login', { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: config.password }) });
if (!login.ok) throw new Error('local_login_failed');
const cookie = login.headers.get('set-cookie').split(';')[0];
const workerState = path.join(runtime, 'agent.json');
let pairCode;
if (!fs.existsSync(workerState)) {
  const pair = await fetch(config.origin + '/api/pairing', { method: 'POST', headers: { origin: config.origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: config.deviceId, name: 'Mac' }) });
  if (!pair.ok) throw new Error('local_pairing_failed');
  pairCode = (await pair.json()).code;
}
const agentConfig = { origin: config.origin, deviceId: config.deviceId, stateFile: workerState, nativeRuntimeHome, projects: [{ id: 'rmtagt-compat', name: '本地隔离验证', path: path.join(root, '.runtime/compat-workspace') }], ...(pairCode ? { pairCode } : {}) };
const agent = await startAgent(agentConfig);
console.log(JSON.stringify({ event: 'business.local.ready', origin: config.origin, deviceId: config.deviceId, credentialsFile: configFile, mode: 'real-read-only' }));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { if (stopping) return; stopping = true; await service.close(); await agent.stop(); process.exit(0); });
