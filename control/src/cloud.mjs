import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAX_RESPONSE, MAX_FRAME, hash, secret, validId, validRequestId, equalSecret, trustedUrl, allowedApi, sendFrame, json, readBody, Store } from './common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC = path.resolve(HERE, '../../services/rmtcdx/apps/bridge/web-dist');
const DEVICE_PATH = /^\/devices\/([a-zA-Z0-9_-]{1,80})(\/.*)?$/;

export async function createCloud(options = {}) {
  const origin = trustedUrl(options.publicUrl ?? process.env.RMT_PUBLIC_URL ?? 'http://127.0.0.1:3220').origin;
  const username = options.username ?? process.env.RMT_ADMIN_USERNAME ?? 'admin';
  const password = options.password ?? process.env.RMT_ADMIN_PASSWORD;
  const passwordHash = options.passwordHash ?? process.env.RMT_ADMIN_PASSWORD_HASH;
  if (!passwordHash && (!password || password.length < 24)) throw new Error('Set RMT_ADMIN_PASSWORD (at least 24 characters) or RMT_ADMIN_PASSWORD_HASH (scrypt:salt:hash)');
  if (passwordHash && !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)) throw new Error('Invalid scrypt password hash');
  const salt = passwordHash ? passwordHash.split(':')[1] : crypto.randomBytes(16).toString('hex');
  const digest = passwordHash ? Buffer.from(passwordHash.split(':')[2], 'hex') : crypto.scryptSync(password, salt, 64);
  const store = new Store(options.stateFile ?? process.env.RMT_STATE_FILE ?? path.resolve(HERE, '../.state/cloud.json'), { version: 1, devices: {} });
  if (store.data?.version !== 1 || !store.data.devices || typeof store.data.devices !== 'object' || Array.isArray(store.data.devices) || Object.entries(store.data.devices).some(([id, d]) => !validId(id) || d?.id !== id || typeof d.name !== 'string' || !/^[a-f0-9]{64}$/.test(d.tokenHash))) {
    store.close(); throw new Error('Invalid cloud metadata; refusing to start');
  }
  const devices = new Map();
  const sessions = new Map();
  const pairing = new Map();
  const pending = new Map();
  const loginAttempts = new Map();
  const staticDir = path.resolve(options.staticDir ?? process.env.RMT_STATIC_DIR ?? DEFAULT_STATIC);
  const timeoutMs = options.timeoutMs ?? 35_000;
  const secureCookie = origin.startsWith('https:');
  const cookieName = secureCookie ? '__Host-rmtagt' : 'rmtagt';
  let closed = false;
  const authenticated = req => {
    const value = (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const key = value && hash(value);
    const session = key && sessions.get(key);
    if (!session || session.expires <= Date.now()) { if (key) sessions.delete(key); return false; }
    return key;
  };
  const sameOrigin = req => req.headers.origin === origin;
  const cookie = (token, maxAge) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const hasDevice = id => Object.hasOwn(store.data.devices, id) && !store.data.devices[id].revoked;
  const failPending = (id, generation) => {
    for (const [key, p] of pending) {
      if (p.deviceId !== id || p.generation !== generation) continue;
      clearTimeout(p.timer); pending.delete(key);
      json(p.res, 503, { message: p.mutation ? 'Connection lost; operation outcome unknown. Reuse the same request ID to query receipt.' : 'Device disconnected', state: p.mutation ? 'unknown' : 'offline', requestId: p.requestId });
    }
  };
  const broadcast = (device, payload) => { for (const ws of device.browsers) sendFrame(ws, payload); };
  const closeDevice = (id, reason = 'Device disconnected') => {
    const device = devices.get(id);
    if (!device) return;
    device.socket.close(4001, reason);
    failPending(id, device.generation);
    for (const ws of device.browsers) { sendFrame(ws, { type: 'backend.degraded', reason }); ws.close(1012, reason); }
    device.browsers.clear();
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('cache-control', 'no-store');
    if (secureCookie) res.setHeader('strict-transport-security', 'max-age=31536000');
    try {
      const url = new URL(req.url, origin);
      const method = req.method;
      if (url.pathname === '/healthz' && method === 'GET') return json(res, 200, { ok: true, service: 'rmtagt-control' });
      if (url.pathname === '/api/login' && method === 'POST') {
        if (!sameOrigin(req)) return json(res, 403, { message: 'Origin rejected' });
        const key = req.socket.remoteAddress;
        const now = Date.now();
        const failures = loginAttempts.get(key) ?? { count: 0, until: now + 60_000 };
        if (failures.until < now) { failures.count = 0; failures.until = now + 60_000; }
        if (failures.count >= 5) return json(res, 429, { message: 'Try again later' });
        failures.count++; loginAttempts.set(key, failures);
        const body = JSON.parse(await readBody(req, 4096)) ?? {};
        const supplied = typeof body.password === 'string' ? body.password : '';
        if (!equalSecret(String(body.username ?? ''), username) || !crypto.timingSafeEqual(crypto.scryptSync(supplied, salt, 64), digest)) return json(res, 401, { message: 'Invalid credentials' });
        loginAttempts.delete(key);
        if (sessions.size >= 1000) return json(res, 429, { message: 'Session capacity reached' });
        const token = secret();
        sessions.set(hash(token), { expires: now + 12 * 3600_000 });
        return json(res, 200, { ok: true }, { 'set-cookie': cookie(token, 12 * 3600) });
      }
      // Pairing is device-facing: a 256-bit, expiring single-use code is the credential.
      if (url.pathname === '/api/pair' && method === 'POST') {
        const body = JSON.parse(await readBody(req, 4096)) ?? {};
        const key = hash(String(body.code ?? ''));
        const pair = pairing.get(key);
        if (!pair || pair.expires <= Date.now()) return json(res, 401, { message: 'Invalid or expired pairing code' });
        pairing.delete(key);
        if (!validId(body.deviceId) || body.deviceId !== pair.deviceId) return json(res, 400, { message: 'Device ID mismatch; generate a new pairing code' });
        const token = secret();
        closeDevice(body.deviceId, 'Device paired again');
        store.data.devices[body.deviceId] = { id: body.deviceId, name: pair.name, tokenHash: hash(token), createdAt: new Date().toISOString(), revoked: false };
        store.save();
        return json(res, 200, { deviceId: body.deviceId, token });
      }
      if (url.pathname === '/' && method === 'GET') return renderHome(res, safeNext(url.searchParams.get('next'), origin));
      const session = authenticated(req);
      if (!session) {
        const page = DEVICE_PATH.exec(url.pathname);
        if (method === 'GET' && page && !/^\/(?:api(?:\/|$)|ws$|healthz$)/.test(page[2] ?? '/')) {
          res.writeHead(302, { location: '/?next=' + encodeURIComponent(url.pathname + url.search) });
          return res.end();
        }
        return json(res, 401, { message: 'Login required' });
      }
      if (!['GET', 'HEAD'].includes(method) && !sameOrigin(req)) return json(res, 403, { message: 'Origin rejected' });
      if (url.pathname === '/api/logout' && method === 'POST') {
        sessions.delete(session);
        for (const d of devices.values()) for (const ws of d.browsers) if (ws.sessionKey === session) ws.close(4003, 'Logged out');
        return json(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) });
      }
      if (url.pathname === '/api/devices' && method === 'GET') return json(res, 200, { devices: Object.values(store.data.devices).filter(d => !d.revoked).map(d => ({ id: d.id, name: d.name, online: devices.get(d.id)?.socket.readyState === 1, createdAt: d.createdAt })) });
      if (url.pathname === '/api/pairing' && method === 'POST') {
        const body = JSON.parse(await readBody(req, 4096)) ?? {};
        if (!validId(body.deviceId) || typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 80) return json(res, 400, { message: 'deviceId and name required' });
        for (const [key, value] of pairing) if (value.deviceId === body.deviceId) pairing.delete(key);
        if (pairing.size >= 100) return json(res, 429, { message: 'Pairing capacity reached' });
        const code = secret();
        const expires = Date.now() + (options.pairingTtlMs ?? 5 * 60_000);
        pairing.set(hash(code), { deviceId: body.deviceId, name: body.name, expires });
        return json(res, 201, { code, deviceId: body.deviceId, expiresAt: new Date(expires).toISOString() });
      }
      const revoke = /^\/api\/devices\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (revoke && method === 'DELETE') {
        if (!hasDevice(revoke[1])) return json(res, 404, { message: 'Device not found' });
        store.data.devices[revoke[1]].revoked = true;
        store.save();
        closeDevice(revoke[1], 'Device revoked');
        return json(res, 200, { ok: true });
      }
      const match = DEVICE_PATH.exec(url.pathname);
      if (match) {
        const [, deviceId, route = '/'] = match;
        if (!hasDevice(deviceId)) return json(res, 404, { message: 'Device not found' });
        if ((allowedApi(method, route + url.search)) || (route === '/healthz' && method === 'GET')) {
          const device = devices.get(deviceId);
          if (!device || device.socket.readyState !== 1) return json(res, 503, { message: 'Device offline', state: 'offline' });
          const body = await readBody(req);
          const mutation = !['GET', 'HEAD'].includes(method);
          const requestId = req.headers['x-request-id'] ?? crypto.randomUUID();
          if (!validRequestId(requestId)) return json(res, 400, { message: 'Invalid x-request-id' });
          if (pending.size >= 200) return json(res, 429, { message: 'Too many requests' });
          const id = crypto.randomUUID();
          const timer = setTimeout(() => {
            pending.delete(id);
            json(res, 504, { message: mutation ? 'Operation outcome unknown; retry with the same request ID' : 'Device request timed out', state: mutation ? 'unknown' : 'timeout', requestId });
          }, timeoutMs);
          pending.set(id, { res, timer, deviceId, generation: device.generation, mutation, requestId });
          res.on('close', () => { if (pending.has(id)) { clearTimeout(timer); pending.delete(id); } });
          res.setHeader('x-request-id', requestId);
          if (!sendFrame(device.socket, { type: 'http', id, requestId, method, path: route + url.search, body })) { clearTimeout(timer); pending.delete(id); return json(res, 503, { message: 'Device unavailable', state: 'unknown', requestId }); }
          return;
        }
        if (route.startsWith('/api') || route === '/ws') return json(res, 404, { message: 'Endpoint not permitted' });
        if (method === 'GET') return serveFile(res, path.join(staticDir, 'index.html'));
      }
      if (url.pathname.startsWith('/assets/') && method === 'GET') {
        const relative = decodeURIComponent(url.pathname).slice(1);
        const file = path.resolve(staticDir, relative);
        if (!file.startsWith(staticDir + path.sep)) return json(res, 403, { message: 'Invalid asset path' });
        return serveFile(res, file);
      }
      if (['/favicon.svg', '/favicon.ico', '/icon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest', '/push-sw.js'].includes(url.pathname) && method === 'GET') return serveFile(res, path.join(staticDir, url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg' ? 'icon.svg' : url.pathname.slice(1)));
      return json(res, 404, { message: 'Not found' });
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? (error instanceof SyntaxError ? 400 : 500), { message: error.status === 413 ? 'Payload too large' : error instanceof SyntaxError ? 'Invalid JSON' : 'Request failed' });
      else res.destroy();
    }
  });
  server.requestTimeout = 45_000;
  server.headersTimeout = 15_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const reject = (code = 401) => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    try {
    let url;
    try { url = new URL(req.url, origin); } catch { reject(400); return; }
    if (url.pathname === '/agent/connect') {
      const deviceId = req.headers['x-device-id'];
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!validId(deviceId) || !hasDevice(deviceId) || !token || !equalSecret(hash(token), store.data.devices[deviceId].tokenHash)) return reject();
      // The agent authenticates with its own token. Browser Origin-bearing requests are forbidden.
      if (req.headers.origin) return reject(403);
      wss.handleUpgrade(req, socket, head, ws => attachAgent(deviceId, ws));
      return;
    }
    const match = /^\/devices\/([a-zA-Z0-9_-]+)\/ws$/.exec(url.pathname);
    const session = authenticated(req);
    if (!session || !sameOrigin(req)) return reject(403);
    if (!match || !hasDevice(match[1])) return reject(404);
    const d = devices.get(match[1]);
    if (!d || d.socket.readyState !== 1) return reject(503);
    wss.handleUpgrade(req, socket, head, ws => {
      ws.sessionKey = session;
      d.browsers.add(ws);
      ws.on('error', () => {});
      ws.on('close', () => d.browsers.delete(ws));
      if (d.mode === 'real') sendFrame(ws, { type: 'hello', mode: 'real' });
      const since = Number(url.searchParams.get('since'));
      const epoch = url.searchParams.get('epoch');
      if (epoch && epoch === d.epoch && Number.isSafeInteger(since) && since >= 0 && since >= (d.events[0]?.seq ?? 1) - 1 && since <= d.lastSeq) {
        for (const event of d.events) if (event.seq > since) sendFrame(ws, browserEvent(event));
      } else sendFrame(ws, { type: 'backend.degraded', reason: 'relay.snapshot-required: reload sessions, messages, runs and pending approvals' });
      ws.on('message', raw => {
        try {
          const event = JSON.parse(raw.toString());
          if (event.type === 'ping') return sendFrame(ws, { type: 'pong', ts: new Date().toISOString() });
          // session.read is advisory; mutation APIs carry durable request IDs.
          if (event.type === 'session.read' && validId(event.sessionId)) sendFrame(d.socket, { type: 'browser', event: { type: 'session.read', sessionId: event.sessionId } });
          else ws.close(1008, 'Unsupported event');
        } catch { ws.close(1008, 'Invalid event'); }
      });
    });
    } catch { reject(400); }
  });
  function attachAgent(deviceId, ws) {
    const old = devices.get(deviceId);
    if (old) closeDevice(deviceId, 'Connection replaced');
    const d = { socket: ws, generation: crypto.randomUUID(), browsers: new Set(), epoch: old?.epoch, lastSeq: old?.lastSeq ?? 0, events: old?.events ?? [], eventBytes: old?.eventBytes ?? 0 };
    devices.set(deviceId, d);
    ws.on('error', () => {});
    ws.on('close', () => {
      if (devices.get(deviceId) !== d) return;
      failPending(deviceId, d.generation);
      for (const browser of d.browsers) { sendFrame(browser, { type: 'backend.degraded', reason: 'Device disconnected' }); browser.close(1012, 'Device disconnected'); }
      d.browsers.clear();
    });
    ws.on('message', raw => {
      if (devices.get(deviceId) !== d || !hasDevice(deviceId)) return ws.close(4003, 'Revoked');
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'agent.status') {
          if (msg.mode !== 'real' && msg.mode !== null) return ws.close(1008, 'Invalid status');
          d.mode = msg.mode ?? undefined;
          if (d.mode === 'real') broadcast(d, { type: 'hello', mode: 'real' });
          else broadcast(d, { type: 'backend.degraded', reason: 'Local bridge not ready in real mode' });
        } else if (msg.type === 'response') {
          const p = pending.get(msg.id);
          if (!p || p.deviceId !== deviceId || p.generation !== d.generation) return;
          if (!Number.isInteger(msg.status) || msg.status < 200 || msg.status > 599 || typeof msg.body !== 'string') return ws.close(1008, 'Invalid response');
          if (Buffer.byteLength(msg.body) > MAX_RESPONSE) {
            clearTimeout(p.timer); pending.delete(msg.id);
            json(p.res, p.mutation ? 503 : 413, { message: 'Bridge response exceeds 32 MiB limit', state: p.mutation ? 'unknown' : 'too_large', limitBytes: MAX_RESPONSE, requestId: p.requestId });
            return;
          }
          clearTimeout(p.timer); pending.delete(msg.id);
          p.res.writeHead(msg.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': p.requestId });
          p.res.end(msg.body);
        } else if (msg.type === 'event') {
          if (!validId(msg.epoch) || !Number.isSafeInteger(msg.seq) || msg.seq < 1 || !msg.event || typeof msg.event.type !== 'string') return ws.close(1008, 'Invalid event');
          if (d.epoch !== msg.epoch) { d.epoch = msg.epoch; d.lastSeq = 0; d.events = []; d.eventBytes = 0; broadcast(d, { type: 'backend.degraded', reason: 'relay.snapshot-required: agent restarted' }); }
          if (msg.seq <= d.lastSeq) return;
          if (msg.seq > d.lastSeq + 1) broadcast(d, { type: 'backend.degraded', reason: 'relay.snapshot-required: event gap' });
          d.lastSeq = msg.seq;
          if (msg.event.type === 'hello') d.mode = msg.event.mode;
          d.events.push(msg); d.eventBytes += raw.length;
          while (d.events.length > 256 || d.eventBytes > 4 * 1024 * 1024) { const removed = d.events.shift(); d.eventBytes -= Buffer.byteLength(JSON.stringify(removed)); }
          broadcast(d, browserEvent(msg));
        } else if (msg.type === 'bridge.offline') { d.mode = undefined; broadcast(d, { type: 'backend.degraded', reason: 'Local bridge disconnected' }); for (const b of d.browsers) b.close(1012, 'Bridge disconnected'); }
        else ws.close(1008, 'Unknown frame');
      } catch { ws.close(1008, 'Malformed frame'); }
    });
  }
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.sessionKey && (!sessions.has(ws.sessionKey) || sessions.get(ws.sessionKey).expires <= Date.now())) { ws.close(4003, 'Session expired'); continue; }
      if (ws.alive === false) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
    for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
    for (const [key, value] of pairing) if (value.expires <= Date.now()) pairing.delete(key);
    for (const [key, value] of loginAttempts) if (value.until < Date.now()) loginAttempts.delete(key);
  }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();
  wss.on('connection', () => {});
  // noServer does not emit connection automatically when using handleUpgrade callbacks.
  const originalUpgrade = wss.handleUpgrade.bind(wss);
  wss.handleUpgrade = (req, socket, head, cb) => originalUpgrade(req, socket, head, ws => { ws.alive = true; ws.on('pong', () => { ws.alive = true; }); cb(ws); });
  return {
    server,
    origin,
    listen: (port = Number(process.env.RMT_PORT ?? 3220), host = process.env.RMT_HOST ?? '127.0.0.1') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); }); }),
    async close() {
      if (closed) return; closed = true;
      clearInterval(heartbeat);
      for (const p of pending.values()) { clearTimeout(p.timer); json(p.res, 503, { message: 'Relay shutdown', state: p.mutation ? 'unknown' : 'offline', requestId: p.requestId }); }
      pending.clear();
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => server.close(resolve));
      store.close();
    }
  };
}

function browserEvent(frame) { return { ...frame.event, _relay: { epoch: frame.epoch, seq: frame.seq } }; }
function serveFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { message: 'Web assets not built; build services/rmtcdx first' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res);
}
function safeNext(value, origin) {
  if (typeof value !== 'string' || !/^\/devices\/[a-zA-Z0-9_-]{1,80}\//.test(value) || /\\|[\r\n]/.test(value)) return '';
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !DEVICE_PATH.test(url.pathname)) return '';
    return url.pathname + url.search;
  } catch { return ''; }
}
function renderHome(res, next = '') {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'` });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>rmtagt 设备</title><style>body{font:16px system-ui;max-width:560px;margin:40px auto;padding:0 20px;background:#f6f7fb;color:#182334}input,button,a{font:inherit;padding:12px;margin:5px 0;box-sizing:border-box}input,button{width:100%}a{display:block;background:white;border:1px solid #ddd;border-radius:8px;color:#124b87}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{cursor:pointer}</style><h1>rmtagt</h1><form id="login"><input name="username" value="admin" autocomplete="username" aria-label="用户名"><input name="password" type="password" placeholder="登录密码" autocomplete="current-password" required><button>登录</button></form><main hidden><h2>电脑</h2><div id="devices"></div><h2>绑定电脑</h2><form id="pair"><input name="deviceId" placeholder="设备 ID，例如 windows 或 mac" pattern="[a-zA-Z0-9_-]{1,80}" required><input name="name" placeholder="设备名称" maxlength="80" required><button>生成五分钟有效的配对码</button></form><pre id="code"></pre><button id="logout">退出登录</button></main><p role="status" id="status"></p><script nonce="${nonce}">const next=${JSON.stringify(next).replaceAll('<', '\\u003c')};const $=s=>document.querySelector(s);async function api(p,method='GET',body){const r=await fetch(p,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.message||r.status);return v}async function refresh(){try{const v=await api('/api/devices');if(next){location.assign(next);return}$('#login').hidden=true;$('main').hidden=false;$('#devices').replaceChildren(...v.devices.map(d=>{const a=document.createElement('a');a.textContent=d.name+' · '+(d.online?'在线':'离线');a.href='/devices/'+encodeURIComponent(d.id)+'/';return a}));}catch{}}$('#login').onsubmit=async e=>{e.preventDefault();try{await api('/api/login','POST',Object.fromEntries(new FormData(e.target)));$('#status').textContent='';await refresh()}catch(e){$('#status').textContent=e.message}};$('#pair').onsubmit=async e=>{e.preventDefault();try{const v=await api('/api/pairing','POST',Object.fromEntries(new FormData(e.target)));$('#code').textContent='设备 ID: '+v.deviceId+'\\n配对码: '+v.code+'\\n将配对码输入电脑客户端。不要分享此码。'}catch(e){$('#status').textContent=e.message}};$('#logout').onclick=async()=>{await api('/api/logout','POST');location.reload()};refresh();setInterval(refresh,10000);</script></html>`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cloud = await createCloud();
  const address = await cloud.listen();
  console.log(`rmtagt cloud listening on ${address.address}:${address.port}; public origin ${cloud.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cloud.close(); });
}
