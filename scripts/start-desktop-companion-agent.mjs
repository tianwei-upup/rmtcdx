// Connect an already-running test companion to the existing business service.
// This script never launches Codex or restores the suspended native adapter.
import fs from 'node:fs';
import path from 'node:path';
import { startAgent } from '../business/src/agent.mjs';
import { CompanionBusinessAdapter } from '../prototype/desktop-companion/src/business-adapter.mjs';

const root = path.resolve(import.meta.dirname, '..');
const runtime = path.join(root, '.runtime/desktop-companion-acceptance');
const base = JSON.parse(fs.readFileSync(path.join(root, '.runtime/business-ecs/local.json'), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(path.join(runtime, 'test-session.json'), 'utf8'));
const config = { origin: base.origin, deviceId: 'mac-companion', runtime: path.join(root, '.runtime/desktop-companion-mcp/run'), threadId: fixture.threadId };
if (!config.origin.startsWith('https://')) throw Error('https_required');
const stateFile = path.join(runtime, 'agent.json'); let pairCode;
if (!fs.existsSync(stateFile)) {
  const login = await fetch(config.origin + '/api/login', { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: base.password }), signal: AbortSignal.timeout(15000) });
  if (!login.ok) throw Error('business_login_failed');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const pair = await fetch(config.origin + '/api/pairing', { method: 'POST', headers: { origin: config.origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: config.deviceId, name: 'Mac 伴随验收' }), signal: AbortSignal.timeout(15000) });
  if (!pair.ok) throw Error('business_pairing_failed');
  pairCode = (await pair.json()).code;
}
const agent = await startAgent({ origin: config.origin, deviceId: config.deviceId, stateFile, pairCode,
  adapter: new CompanionBusinessAdapter({ runtime: config.runtime, threadIds: [config.threadId], ledgerFile: path.join(runtime, 'remote-prompts.json') }) });
console.log(JSON.stringify({ event: 'companion.business.ready', deviceId: config.deviceId }));
fs.writeFileSync(path.join(runtime, 'remote-public.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void agent.stop());
