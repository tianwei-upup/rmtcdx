import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './storage.mjs';
import { nativeAdapter } from './codex-adapter.mjs';
import { OPERATIONS, READS } from './contracts.mjs';
import { assertIsolatedNativeRuntime, assertNativeExecutionAllowed } from './runtime-isolation.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function startAgent(config) {
  // Attach mode reuses an already-running app-server, so it neither spawns a
  // Codex process nor needs an isolated runtime HOME. The suspended native
  // guard still applies to everything that would create one.
  const attachMode = Boolean(config.transport);
  if (!config.adapter && !attachMode) assertNativeExecutionAllowed();
  const runtimeHome = config.adapter || attachMode ? null : assertIsolatedNativeRuntime(config.nativeRuntimeHome);
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) throw new Error('https_required');
  if (origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw new Error('invalid_origin');
  const store = new JsonStore(config.stateFile, { token: null, receipts: {}, events: [] });
  let stopped = false, active = null, processing = false;
  const log = config.log ?? (value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value })));
  let lastNetworkLog = 0;
  function diagnostic(event, error, task) {
    const now = Date.now(); if (!task && now - lastNetworkLog < 30000) return; if (!task) lastNetworkLog = now;
    const message = String(error?.message ?? '');
    const reason = /list_turns is not supported/.test(message) ? 'history_not_materialized' : /empty/.test(message) ? 'empty_rollout' : /fetch failed|timeout|abort/i.test(message) ? 'network_unavailable' : 'operation_failed';
    log({ event, reason, code: error?.code ?? null, status: error?.status ?? null, errorFingerprint: crypto.createHash('sha256').update(message).digest('hex').slice(0, 16), ...(task ? { jobId: task.id, operation: task.operation, state: store.data.receipts[task.id]?.state } : {}), nativeReady: adapter.ready() });
  }
  async function call(route, data, authenticated = true) {
    const response = await fetch(origin.origin + route, { method: 'POST', signal: AbortSignal.timeout(25000), headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${store.data.token}`, 'x-device-id': config.deviceId } : {}) }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.code ?? 'business_request_failed'), { status: response.status });
    return result;
  }
  try {
    if (!store.data.token) { if (!config.pairCode) throw new Error('pair_code_required'); const paired = await call('/api/agent/pair', { deviceId: config.deviceId, code: config.pairCode }, false); store.data.token = paired.token; store.save(); }
  } catch (error) { store.close(); throw error; }
  const emitEvent = event => {
    if (store.data.events.length >= 256 || Buffer.byteLength(JSON.stringify(store.data.events)) > 1024 * 1024) store.data.events.shift();
    store.data.events.push(event); store.save();
  };
  const attachmentDir = path.join(path.dirname(config.stateFile), 'attachments');
  const conversationProjects = Object.fromEntries(Object.values(store.data.receipts).filter(r => r.result?.conversation).map(r => [r.result.conversation.id, r.result.conversation.projectId]));
  // Precedence: injected adapter > validated attach transport > suspended native.
  // A configured transport that cannot be reached fails here instead of falling
  // back to a second executor.
  let adapter;
  if (config.adapter) adapter = config.adapter;
  else if (attachMode) {
    const { attachAdapter } = await import('./attach-adapter.mjs');
    const { attachClientFactory } = await import('./attach-client.mjs');
    adapter = await attachAdapter(config.transport, config.projects, emitEvent, attachmentDir, conversationProjects, {
      createClient: attachClientFactory({ emit: emitEvent, attachmentDir })
    });
  } else adapter = await nativeAdapter(config.projects, emitEvent, attachmentDir, conversationProjects, runtimeHome);
  const isReady = () => typeof adapter.ready === 'function' ? adapter.ready() : adapter.getState?.().ready === true;
  await adapter.start();
  async function heartbeat() {
    const value = await call('/api/agent/heartbeat', { active: active ? [{ id: active.id, leaseToken: active.leaseToken }] : [], ready: isReady() });
    for (const job of value.reconcile) {
      const receipt = store.data.receipts[job.id];
      if (receipt && receipt.fingerprint === job.fingerprint && ['succeeded', 'rejected'].includes(receipt.state)) await call(`/api/agent/tasks/${job.id}/reconcile`, { fingerprint: job.fingerprint, state: receipt.state, ...(receipt.result ? { result: receipt.result } : { code: receipt.code }) });
    }
  }
  async function maintenance() {
    if (processing || stopped) return; processing = true;
    try {
      await heartbeat();
      while (store.data.events.length && !stopped) {
        await call('/api/agent/events', store.data.events[0]); store.data.events.shift(); store.save();
      }
    } catch (error) { diagnostic('business.maintenance.failed', error); }
    finally { processing = false; }
  }
  await heartbeat();
  const timer = setInterval(maintenance, 5000);
  const loop = (async () => {
    while (!stopped) {
      try {
        const { task } = await call('/api/agent/tasks/claim', { accepts: OPERATIONS });
        if (!task || stopped) continue;
        active = task;
        await call(`/api/agent/tasks/${task.id}/ack`, { leaseToken: task.leaseToken });
        let receipt = store.data.receipts[task.id];
        if (!receipt) {
          // Persist BEFORE native side effects. An unknown receipt never executes again.
          receipt = { fingerprint: task.fingerprint, state: 'unknown', code: 'execution_unknown' };
          store.data.receipts[task.id] = receipt; store.save();
          try { receipt.result = await adapter.execute(task.operation, task.input, task.id); receipt.state = 'succeeded'; delete receipt.code; }
          catch (error) { diagnostic('business.execution.failed', error, task); receipt.state = error.code === 'precondition_rejected' || READS.has(task.operation) ? 'rejected' : 'unknown'; receipt.code = receipt.state === 'rejected' ? 'precondition_rejected' : 'execution_unknown'; }
          store.save();
        }
        await call(`/api/agent/tasks/${task.id}/result`, { leaseToken: task.leaseToken, state: receipt.state, ...(receipt.result ? { result: receipt.result } : { code: receipt.code }) });
        active = null; await maintenance();
      } catch (error) { diagnostic('business.worker.request_failed', error, active); active = null; if (!stopped) await delay(1500); }
    }
  })();
  return { async stop() { stopped = true; clearInterval(timer); await adapter.stop(); await loop; store.close(); }, adapter };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(fs.readFileSync(process.env.RMT_BUSINESS_AGENT_CONFIG, 'utf8'));
  const agent = await startAgent(config);
  console.log('Business worker ready (direct Codex stdio)');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void agent.stop().then(() => process.exit(0)); });
}
