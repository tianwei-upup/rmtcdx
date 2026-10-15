import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { MAX_BODY, MAX_RESPONSE, MAX_FRAME, hash, validId, validRequestId, localRelayUrl, allowedApi, allowedUpload, imageContentType, sendFrame, readBody, readBytes, Store } from './common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const jsonBody = value => JSON.stringify(value);
export async function pairDevice({ serverUrl, deviceId, code, configFile }) {
  const base = localRelayUrl(serverUrl);
  if (!validId(deviceId) || typeof code !== 'string' || code.length < 32) throw new Error('Valid device ID and pairing code required');
  const response = await fetch(new URL('/api/pair', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId, code }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? 'Pairing failed');
  if (!validId(result.deviceId) || typeof result.token !== 'string' || result.token.length < 32) throw new Error('Invalid pairing response');
  const file = path.resolve(configFile);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Token exists only in the local user configuration. Cloud stores a hash.
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ serverUrl: base.origin, deviceId: result.deviceId, token: result.token }), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return { serverUrl: base.origin, deviceId: result.deviceId, token: result.token };
}

export function createClient(options) {
  const base = localRelayUrl(options.serverUrl);
  if (!validId(options.deviceId) || typeof options.token !== 'string' || options.token.length < 32) throw new Error('Invalid client configuration');
  const bridgePort = options.bridgePort ?? Number(process.env.RMT_BRIDGE_PORT ?? 3210);
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) throw new Error('Invalid bridge port');
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`;
  const relayUrl = new URL('/agent/connect', base);
  relayUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const store = new Store(options.receiptFile ?? path.resolve(HERE, `../.client/${options.deviceId}-receipts.json`), { version: 1, receipts: {} });
  if (store.data?.version !== 1 || !store.data.receipts || typeof store.data.receipts !== 'object' || Array.isArray(store.data.receipts)) { store.close(); throw new Error('Invalid receipt metadata; refusing to start'); }
  const inflight = new Map();
  let relay;
  let bridge;
  let bridgeMode;
  let stopping = false;
  let reconnectTimer;
  let bridgeTimer;
  let attempt = 0;
  let activeReads = 0;
  let activeHistoryReads = 0;
  let activeCatalogReads = 0;
  let activeWrites = 0;
  const readQueue = [];
  const abort = new AbortController();
  let sequence = 0;
  let epoch = crypto.randomUUID();
  let eventBytes = 0;
  const events = [];
  const status = options.onStatus ?? (() => {});
  // Large catalog/history reads must leave one slot for run polling and health.
  const priorityRead = message => message.path === '/healthz' || /^\/api\/runs\/[a-zA-Z0-9_-]+$/.test(message.path);
  const catalogRead = message => /^\/api\/(?:repos|sessions(?:\/search)?)(?:\?|$)/.test(message.path);
  const canRead = message => activeReads < 4 && (priorityRead(message) || activeHistoryReads < 3) && (!catalogRead(message) || activeCatalogReads < 2);
  function respond(current, message, result) {
    if (relay !== current || current.readyState !== 1) return;
    let frame = { type: 'response', id: message.id, ...result };
    if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME) frame = { type: 'response', id: message.id, status: message.method === 'GET' ? 413 : 503, body: jsonBody({ message: 'Response exceeds relay frame limit', state: message.method === 'GET' ? 'too_large' : 'unknown', requestId: message.requestId }) };
    sendFrame(current, frame);
  }
  function cancelQueuedReads(current, notify = false) {
    for (let index = readQueue.length - 1; index >= 0; index--) {
      if (readQueue[index].current !== current) continue;
      clearTimeout(readQueue[index].timer);
      if (notify) respond(current, readQueue[index].message, { status: 503, body: jsonBody({ message: 'Local bridge disconnected; queued read cancelled', state: 'offline' }) });
      readQueue.splice(index, 1);
    }
  }
  function pumpReads() {
    while (activeReads < 4 && readQueue.length) {
      let index = readQueue.findIndex(queued => priorityRead(queued.message));
      if (index < 0) index = readQueue.findIndex(queued => !catalogRead(queued.message) && canRead(queued.message));
      if (index < 0) index = readQueue.findIndex(queued => canRead(queued.message));
      if (index < 0) break;
      const [queued] = readQueue.splice(index, 1);
      clearTimeout(queued.timer);
      if (relay === queued.current && queued.current.readyState === 1 && !stopping) dispatch(queued.current, queued.message);
    }
  }
  function dispatch(current, message) {
    const read = message.method === 'GET';
    if (read) { activeReads++; if (!priorityRead(message)) activeHistoryReads++; if (catalogRead(message)) activeCatalogReads++; } else activeWrites++;
    void execute(message).then(result => respond(current, message, result)).catch(() => {
      respond(current, message, { status: 503, body: jsonBody({ message: read ? 'Read request failed' : 'Operation outcome unknown; inspect local state before retry', state: read ? 'error' : 'unknown', requestId: message.requestId }) });
    }).finally(() => {
      if (read) { activeReads--; if (!priorityRead(message)) activeHistoryReads--; if (catalogRead(message)) activeCatalogReads--; pumpReads(); } else activeWrites--;
    });
  }
  function schedule(current, message) {
    if (message.method !== 'GET') {
      if (activeWrites >= 2) return respond(current, message, { status: 429, body: jsonBody({ message: 'Device write capacity reached; no command executed', state: 'busy' }) });
      dispatch(current, message);
      return;
    }
    message.body = ''; // GET bodies are unused and must not consume queue capacity.
    if (canRead(message) && (priorityRead(message) || !catalogRead(message) || !readQueue.length)) return dispatch(current, message);
    if (readQueue.length >= 64) return respond(current, message, { status: 429, body: jsonBody({ message: 'Device read queue full; no request dispatched', state: 'busy' }) });
    const queued = { current, message };
    queued.timer = setTimeout(() => {
      const index = readQueue.indexOf(queued);
      if (index < 0) return;
      readQueue.splice(index, 1);
      respond(current, message, { status: 504, body: jsonBody({ message: 'Read queue wait timed out; no request dispatched', state: 'timeout' }) });
    }, options.readQueueTimeoutMs ?? 10_000);
    readQueue.push(queued);
  }
  function event(data) {
    const frame = { type: 'event', epoch, seq: ++sequence, event: data };
    events.push(frame); eventBytes += Buffer.byteLength(JSON.stringify(frame));
    while (events.length > 512 || eventBytes > 4 * 1024 * 1024) eventBytes -= Buffer.byteLength(JSON.stringify(events.shift()));
    if (relay) sendFrame(relay, frame);
  }
  function connectBridge() {
    if (stopping) return;
    bridge = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws`, { maxPayload: MAX_FRAME, perMessageDeflate: false });
    const current = bridge;
    current.on('open', () => {
      bridgeMode = undefined;
      // A bridge restart invalidates active-run state and cached event continuity.
      epoch = crypto.randomUUID(); sequence = 0; events.length = 0; eventBytes = 0;
      event({ type: 'backend.degraded', reason: 'relay.snapshot-required: local bridge connected; reload current state' });
      status('bridge.connected');
    });
    current.on('message', raw => {
      if (bridge !== current) return;
      try {
        const payload = JSON.parse(raw.toString());
        if (payload?.type === 'hello') {
          bridgeMode = payload.mode;
          if (bridgeMode !== 'real') {
            event({ type: 'backend.degraded', reason: 'Local bridge rejected: CODEX_MODE=real is required' });
            status('bridge.rejected-mode');
            current.close(1008, 'Real Codex mode required');
            return;
          }
        }
        if (payload && typeof payload.type === 'string') event(payload);
      }
      catch { current.close(1008, 'Malformed bridge event'); }
    });
    current.on('error', () => {});
    current.on('close', () => {
      if (bridge !== current || stopping) return;
      bridgeMode = undefined;
      if (relay) cancelQueuedReads(relay, true);
      if (relay) sendFrame(relay, { type: 'bridge.offline' });
      status('bridge.offline');
      bridgeTimer = setTimeout(connectBridge, options.reconnectMs ?? 2000);
    });
  }
  function connectRelay() {
    if (stopping) return;
    relay = new WebSocket(relayUrl, { headers: { authorization: `Bearer ${options.token}`, 'x-device-id': options.deviceId }, maxPayload: MAX_FRAME, handshakeTimeout: 10_000, perMessageDeflate: false });
    const current = relay;
    current.on('open', () => {
      attempt = 0;
      current.alive = true;
      sendFrame(current, { type: 'agent.status', mode: bridgeMode === 'real' ? 'real' : null });
      for (const frame of events) sendFrame(current, frame);
      if (!bridge || bridge.readyState !== 1) sendFrame(current, { type: 'bridge.offline' });
      status('relay.connected');
    });
    current.on('pong', () => { current.alive = true; });
    current.on('error', () => {});
    current.on('message', raw => {
      if (relay !== current) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'browser') {
          if (message.event?.type === 'session.read' && validId(message.event.sessionId) && bridge) sendFrame(bridge, { type: 'session.read', sessionId: message.event.sessionId });
          return;
        }
        if (message.type !== 'http' || !validId(message.id) || !validRequestId(message.requestId) || typeof message.body !== 'string' || !(allowedApi(message.method, message.path) || (message.method === 'GET' && message.path === '/healthz'))) return current.close(1008, 'Invalid request');
        if (Buffer.byteLength(message.body) > MAX_BODY) { sendFrame(current, { type: 'response', id: message.id, status: 413, body: jsonBody({ message: 'Request payload too large', state: 'too_large', limitBytes: MAX_BODY }) }); return; }
        schedule(current, message);
      } catch { current.close(1008, 'Malformed request'); }
    });
    current.on('close', (code) => {
      cancelQueuedReads(current);
      if (relay !== current || stopping) return;
      status(code === 4001 || code === 4003 ? 'relay.revoked-or-replaced' : 'relay.offline');
      // Revocation/replacement is terminal: a replacement must not create an endless takeover loop.
      if (code === 4001 || code === 4003) return;
      reconnectTimer = setTimeout(connectRelay, options.reconnectMs ?? Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)) + Math.random() * 500);
    });
  }
  async function requestBridge(message) {
    if (message.path !== '/healthz' && bridgeMode !== 'real') return { status: 503, body: jsonBody({ message: 'Local bridge is not connected in real mode', state: 'offline' }) };
    try {
      // Native HTTP bypasses OS/environment proxy settings for the loopback bridge.
      return await new Promise((resolve, reject) => {
        const request = http.request(bridgeOrigin + message.path, { method: message.method, headers: { 'content-type': 'application/json', 'x-request-id': message.requestId }, signal: AbortSignal.any([AbortSignal.timeout(options.bridgeTimeoutMs ?? 30_000), abort.signal]) }, async response => {
          try {
            if (allowedUpload(message.path) && response.statusCode === 200) {
              const contentType = imageContentType(response.headers['content-type']);
              if (!contentType) { response.resume(); return resolve({ status: 502, body: jsonBody({ message: 'Bridge returned an unsupported image type' }) }); }
              resolve({ status: 200, body: (await readBytes(response, MAX_RESPONSE)).toString('base64'), encoding: 'base64', contentType });
            } else resolve({ status: response.statusCode, body: await readBody(response, MAX_RESPONSE) });
          }
          catch (error) { reject(error); }
        });
        request.on('error', reject);
        request.end(message.method === 'GET' ? undefined : message.body || '{}');
      });
    } catch (error) {
      if (error.status === 413 && message.method === 'GET') return { status: 413, body: jsonBody({ message: 'Bridge response exceeds 32 MiB limit', state: 'too_large', limitBytes: MAX_RESPONSE }) };
      return { status: 503, body: jsonBody({ message: message.method === 'GET' ? 'Local bridge unavailable' : 'Operation outcome unknown; do not issue a new request ID', state: message.method === 'GET' ? 'offline' : 'unknown', requestId: message.requestId }) };
    }
  }
  async function execute(message) {
    if (message.method === 'GET') return requestBridge(message);
    const fingerprint = hash(`${message.method}\n${message.path}\n${message.body}`);
    const previous = Object.hasOwn(store.data.receipts, message.requestId) ? store.data.receipts[message.requestId] : undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { status: 409, body: jsonBody({ message: 'Request ID reused for different operation', state: 'conflict' }) };
      if (inflight.has(message.requestId)) return inflight.get(message.requestId);
      return previous.result ? { ...previous.result, receipt: 'complete' } : { status: 409, body: jsonBody({ message: 'Previous operation outcome unknown; manual reconciliation required', state: 'unknown', requestId: message.requestId }) };
    }
    if (bridgeMode !== 'real') return { status: 503, body: jsonBody({ message: 'Local bridge is not connected in real mode; no command executed', state: 'offline' }) };
    if (Object.keys(store.data.receipts).length >= 10000) return { status: 507, body: jsonBody({ message: 'Receipt store full; no command executed. Manual receipt archival required.' }) };
    // Write unknown BEFORE dispatch. Crash or timeout cannot silently repeat a mutation.
    store.data.receipts[message.requestId] = { fingerprint, state: 'unknown', createdAt: new Date().toISOString() };
    store.save();
    const promise = (async () => {
      const result = await requestBridge(message);
      let outcome;
      try { outcome = JSON.parse(result.body); } catch { /* Bridge may return non-JSON errors. */ }
      // Bridge HTTP 5xx may occur after a side effect; freeze as unknown, never automatically rerun.
      if (result.status < 500 && outcome?.state !== 'unknown') {
        store.data.receipts[message.requestId].state = 'complete';
        store.data.receipts[message.requestId].result = result;
        store.save();
        return { ...result, receipt: 'complete' };
      } else {
        result.status = 503;
        result.body = jsonBody({ message: 'Operation outcome unknown; manual reconciliation required', state: 'unknown', requestId: message.requestId });
      }
      return result;
    })();
    inflight.set(message.requestId, promise);
    try { return await promise; } finally { inflight.delete(message.requestId); }
  }
  const heartbeat = setInterval(() => {
    if (relay?.readyState === 1) {
      if (relay.alive === false) relay.terminate();
      else { relay.alive = false; relay.ping(); }
    }
  }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();
  connectBridge();
  connectRelay();
  return {
    get connected() { return relay?.readyState === 1; },
    async close() {
      stopping = true;
      if (relay) cancelQueuedReads(relay);
      clearInterval(heartbeat); clearTimeout(reconnectTimer); clearTimeout(bridgeTimer);
      abort.abort(); relay?.terminate(); bridge?.terminate();
      await Promise.allSettled([...inflight.values()]);
      store.close();
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configFile = path.resolve(process.env.RMT_CLIENT_CONFIG ?? path.resolve(HERE, '../.client/config.json'));
  if (process.argv[2] === 'pair') {
    // Environment variables keep pairing secrets out of command history.
    await pairDevice({ serverUrl: process.env.RMT_SERVER_URL, deviceId: process.env.RMT_DEVICE_ID, code: process.env.RMT_PAIR_CODE, configFile });
    console.log(`Device paired; configuration saved to ${configFile}`);
  } else {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const client = createClient({ ...config, receiptFile: process.env.RMT_RECEIPT_FILE ?? path.join(path.dirname(configFile), `${config.deviceId}-receipts.json`), onStatus: value => console.log(`[${new Date().toISOString()}] ${value}`) });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void client.close(); });
  }
}
