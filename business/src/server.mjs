import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TaskBoard } from './tasks.mjs';
import { JsonStore } from './storage.mjs';
import { object, identifier, string, fingerprint, fail, id, OPERATIONS, businessEvent, output, validateImage } from './contracts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const equal = (a, b) => crypto.timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
function originUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('invalid_origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) fail('https_required');
  return url.origin;
}
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
async function body(req, limit = 4 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > limit) { req.resume(); fail('payload_too_large', 413); } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail('invalid_json'); }
}

export async function createBusinessServer(options = {}) {
  const origin = originUrl(options.origin ?? process.env.RMT_BUSINESS_ORIGIN ?? 'http://127.0.0.1:3230');
  const password = options.password ?? process.env.RMT_BUSINESS_PASSWORD;
  if (typeof password !== 'string' || password.length < 24) fail('admin_password_required');
  const username = options.username ?? 'admin';
  const salt = crypto.randomBytes(16); const passwordHash = crypto.scryptSync(password, salt, 64);
  const store = new JsonStore(options.stateFile ?? process.env.RMT_BUSINESS_STATE ?? path.resolve(here, '../../.runtime/business/server.json'),
    { version: 1, devices: {}, jobs: [], projects: {}, conversations: {}, turns: {}, scopes: {} });
  if (store.data.version !== 1 || !Array.isArray(store.data.jobs) || ['devices', 'projects', 'conversations', 'turns', 'scopes'].some(key => !store.data[key] || Array.isArray(store.data[key]) || typeof store.data[key] !== 'object')) { store.close(); fail('invalid_metadata'); }
  const board = new TaskBoard({ store, leaseMs: options.leaseMs });
  const sessions = new Map(), pairs = new Map(), failures = new Map(), heartbeats = new Map();
  const waiting = new Set();
  const attachments = new Map();
  const directories = new Map(), snapshots = new Map(), eventLogs = new Map(), subscribers = new Set();
  const cookieName = origin.startsWith('https:') ? '__Host-rmt-business' : 'rmt-business';
  let closing = false;
  const authenticated = req => {
    const value = (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const session = value && sessions.get(digest(value));
    return session && session.expires > Date.now();
  };
  function device(req) {
    if (req.headers.origin) fail('agent_origin_rejected', 403);
    const deviceId = identifier(req.headers['x-device-id']);
    const value = Object.hasOwn(store.data.devices, deviceId) ? store.data.devices[deviceId] : null;
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!value || value.revoked || !token || !equal(digest(token), value.tokenHash)) fail('device_unauthorized', 401);
    return deviceId;
  }
  function hasDevice(deviceId) { if (!id(deviceId) || !Object.hasOwn(store.data.devices, deviceId) || store.data.devices[deviceId].revoked) fail('device_not_found', 404); }
  function submit(deviceId, operation, value, intentId) {
    hasDevice(deviceId);
    // An accepted intent remains queryable even while its executor is offline.
    if ([...board.jobs.values()].some(job => job.intentId === intentId)) return board.submit(deviceId, operation, value, intentId);
    const heartbeat = heartbeats.get(deviceId);
    if (!heartbeat?.ready || heartbeat.at < Date.now() - 25_000) fail('device_offline', 409);
    const job = board.submit(deviceId, operation, value, intentId);
    if (!Object.hasOwn(store.data.scopes, job.id)) { store.data.scopes[job.id] = { ...(value.projectId ? { projectId: value.projectId } : {}), ...(value.conversationId ? { conversationId: value.conversationId } : {}), ...(value.attachmentId ? { attachmentId: value.attachmentId } : {}) }; store.save(); }
    return job;
  }
  function ownedConversation(conversationId, deviceId) {
    const value = Object.hasOwn(store.data.conversations, conversationId) ? store.data.conversations[conversationId] : null;
    if (!value || deviceId && value.deviceId !== deviceId) fail('conversation_not_found', 404);
    hasDevice(value.deviceId); return value;
  }
  function project(deviceId, projectId) { if (!(store.data.projects[deviceId] ?? []).some(p => p.id === projectId)) fail('project_not_registered', 404); }
  function publish(deviceId, value) {
    const log = eventLogs.get(deviceId) ?? { epoch: crypto.randomUUID(), next: 0, events: [] };
    log.expires = Date.now() + 300000;
    const entry = { ...value, seq: ++log.next, epoch: log.epoch };
    log.events.push(entry);
    while (log.events.length > 256 || Buffer.byteLength(JSON.stringify(log.events)) > 1024 * 1024) log.events.shift();
    eventLogs.set(deviceId, log);
    for (const subscriber of subscribers) if (subscriber.deviceId === deviceId) {
      if (subscriber.res.writableLength > 1024 * 1024) subscriber.res.destroy();
      else subscriber.res.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`);
    }
    return entry;
  }
  function validateResult(job, value) {
    const result = output(job.operation, value), scope = store.data.scopes[job.id] ?? {};
    const candidates = result.directories?.flatMap(d => d.conversations) ?? result.conversations ?? (result.conversation ? [result.conversation] : []);
    for (const conversation of candidates) {
      if (job.operation === 'directory.sync') { if (!result.projects.some(p => p.id === conversation.projectId)) fail('result_scope_mismatch', 409); }
      else project(job.deviceId, conversation.projectId);
      if (scope.projectId && conversation.projectId !== scope.projectId || scope.conversationId && conversation.id !== scope.conversationId) fail('result_scope_mismatch', 409);
      if (Object.hasOwn(store.data.conversations, conversation.id) && (store.data.conversations[conversation.id].deviceId !== job.deviceId || job.operation !== 'directory.sync' && store.data.conversations[conversation.id].projectId !== conversation.projectId)) fail('conversation_collision', 409);
    }
    if (['turn.start', 'turn.cancel', 'approval.resolve', 'attachment.stage'].includes(job.operation) && result.conversationId !== scope.conversationId) fail('result_scope_mismatch', 409);
    if (job.operation === 'attachment.stage' && result.attachmentId !== scope.attachmentId) fail('result_scope_mismatch', 409);
    if (job.operation === 'turn.start') { const turn = store.data.turns[result.turnId]; if (turn && (turn.jobId !== job.id || turn.conversationId !== result.conversationId)) fail('turn_collision', 409); }
    if (candidates.some(c => !Object.hasOwn(store.data.conversations, c.id)) && Object.keys(store.data.conversations).length >= 20000) fail('conversation_capacity', 507);
    return result;
  }
  function cacheProjection(cache, key, value) {
    cache.set(key, { value, expires: Date.now() + 300000 });
    for (const entries of [directories, snapshots]) while (entries.size > 500 || [...directories.values(), ...snapshots.values()].reduce((n, item) => n + Buffer.byteLength(JSON.stringify(item.value)), 0) > 32 * 1024 * 1024) { if (!entries.size) break; entries.delete(entries.keys().next().value); }
  }
  function projectResult(job) {
    const result = job.result;
    if (!result) return;
    if (job.operation === 'projects.sync') store.data.projects[job.deviceId] = result.projects;
    if (job.operation === 'directory.sync') { store.data.projects[job.deviceId] = result.projects; for (const entry of result.directories) cacheProjection(directories, job.deviceId + ':' + entry.projectId, { conversations: entry.conversations, nextCursor: entry.nextCursor }); }
    if (job.operation === 'sessions.sync') cacheProjection(directories, job.deviceId + ':' + store.data.scopes[job.id].projectId, result);
    for (const conversation of result.directories?.flatMap(d => d.conversations) ?? result.conversations ?? (result.conversation ? [result.conversation] : [])) store.data.conversations[conversation.id] = { id: conversation.id, deviceId: job.deviceId, projectId: conversation.projectId };
    if (job.operation === 'conversation.snapshot') cacheProjection(snapshots, result.conversation.id, result);
    if (job.operation === 'turn.start') {
      const previous = store.data.turns[result.turnId];
      if (!previous) store.data.turns[result.turnId] = { id: result.turnId, conversationId: result.conversationId, deviceId: job.deviceId, status: 'running', jobId: job.id };
    }
    if (job.operation === 'attachment.stage') { const attachment = attachments.get(result.attachmentId); if (attachment) attachment.staged = true; }
    store.save();
  }
  const handler = async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY'); res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const url = new URL(req.url, origin), p = url.pathname, method = req.method;
      if (method === 'GET' && (['/', '/app.js', '/style.css', '/chat-state.mjs', '/markdown.mjs', '/business-client.mjs'].includes(p) || /^\/devices\/[A-Za-z0-9_-]+\/$/.test(p))) {
        const filename = p === '/' || p.startsWith('/devices/') ? 'index.html' : p.slice(1);
        const content = fs.readFileSync(path.resolve(here, '../dist', filename));
        res.writeHead(200, { 'content-type': /\.(mjs|js)$/.test(filename) ? 'text/javascript; charset=utf-8' : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' });
        return res.end(content);
      }
      if (method === 'GET' && /^\/icons\/(sidebar-simple|caret-down|note-pencil|dots-three-vertical|plus|x|arrow-up|arrow-down|stop|magnifying-glass|gear|copy|arrow-clockwise|push-pin)\.svg$/.test(p)) {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' });
        return res.end(fs.readFileSync(path.resolve(here, '../dist', p.slice(1))));
      }
      if (p === '/healthz' && method === 'GET') return json(res, 200, { ok: !board.broken, service: 'rmtagt-business', protocolVersion: 1 });
      if (p === '/api/login' && method === 'POST') {
        if (req.headers.origin !== origin) fail('origin_rejected', 403);
        const address = req.socket.remoteAddress, previous = failures.get(address), attempt = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 60_000 };
        if (attempt.count >= 5) fail('login_rate_limited', 429);
        attempt.count++; failures.set(address, attempt);
        const data = await body(req, 4096); object(data, ['username', 'password']);
        if (typeof data.password !== 'string' || !equal(String(data.username), username) || !crypto.timingSafeEqual(crypto.scryptSync(data.password, salt, 64), passwordHash)) fail('invalid_credentials', 401);
        if (sessions.size >= 1000) fail('session_capacity', 429);
        failures.delete(address); const token = secret(); sessions.set(digest(token), { expires: Date.now() + 43_200_000 });
        return json(res, 200, { ok: true }, { 'set-cookie': `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${origin.startsWith('https:') ? '; Secure' : ''}` });
      }
      if (p === '/api/agent/pair' && method === 'POST') {
        if (req.headers.origin) fail('agent_origin_rejected', 403);
        const data = await body(req, 4096); object(data, ['deviceId', 'code']); identifier(data.deviceId); string(data.code, 100);
        const pair = pairs.get(digest(data.code));
        if (!pair || pair.expires < Date.now() || pair.id !== data.deviceId) fail('pairing_invalid', 401);
        pairs.delete(digest(data.code)); const token = secret();
        store.data.devices[data.deviceId] = { id: data.deviceId, name: pair.name, tokenHash: digest(token), revoked: false };
        store.save(); heartbeats.delete(data.deviceId);
        return json(res, 200, { deviceId: data.deviceId, token });
      }
      if (p.startsWith('/api/agent/')) {
        const deviceId = device(req);
        if (p === '/api/agent/heartbeat' && method === 'POST') {
          const data = await body(req, 16384); object(data, ['active', 'ready']);
          if (!Array.isArray(data.active) || data.active.length > 10 || typeof data.ready !== 'boolean') fail('invalid_heartbeat');
          heartbeats.set(deviceId, { at: Date.now(), ready: data.ready });
          for (const lease of data.active) { object(lease, ['id', 'leaseToken']); try { board.ack(deviceId, identifier(lease.id), string(lease.leaseToken)); } catch (error) { if (error.code !== 'invalid_lease') throw error; } }
          return json(res, 200, { ok: true, reconcile: [...board.jobs.values()].filter(job => job.deviceId === deviceId && job.state === 'unknown').slice(0, 100).map(job => ({ id: job.id, intentId: job.intentId, fingerprint: job.fingerprint })) });
        }
        if (p === '/api/agent/tasks/claim' && method === 'POST') {
          const data = await body(req, 4096); object(data, ['accepts']);
          if (!Array.isArray(data.accepts) || !data.accepts.length || data.accepts.length > OPERATIONS.length || data.accepts.some(value => !OPERATIONS.includes(value))) fail('invalid_capabilities');
          const until = Date.now() + (options.claimWaitMs ?? 20_000); waiting.add(res);
          try {
            do {
              const task = board.claim(deviceId, data.accepts);
              if (task) return json(res, 200, { task });
              if (res.destroyed || closing) return;
              await new Promise(resolve => setTimeout(resolve, 100));
            } while (Date.now() < until);
            return json(res, 200, { task: null });
          } finally { waiting.delete(res); }
        }
        if (p === '/api/agent/events' && method === 'POST') {
          const event = businessEvent(await body(req, 32768)); ownedConversation(event.conversationId, deviceId);
          const job = board.get(event.jobId), scope = store.data.scopes[event.jobId];
          if (job.deviceId !== deviceId || job.operation !== 'turn.start' || scope?.conversationId !== event.conversationId || !['running', 'succeeded', 'unknown'].includes(job.state)) fail('event_not_owned', 403);
          const previous = store.data.turns[event.turnId];
          if (previous && (previous.conversationId !== event.conversationId || previous.jobId !== event.jobId)) fail('turn_collision', 409);
          if (!previous && event.type !== 'turn.started') fail('turn_not_started', 409);
          const duplicate = eventLogs.get(deviceId)?.events.some(value => value.eventId === event.eventId);
          if (!duplicate) {
            if (!previous) store.data.turns[event.turnId] = { id: event.turnId, conversationId: event.conversationId, deviceId, jobId: event.jobId, status: 'running' };
            if (event.type === 'turn.finished') store.data.turns[event.turnId].status = event.status;
            store.save(); publish(deviceId, event);
          }
          return json(res, 200, { ok: true });
        }
        const jobRoute = /^\/api\/agent\/tasks\/([A-Za-z0-9_-]+)\/(ack|result|reconcile)$/.exec(p);
        if (jobRoute && method === 'POST') {
          const data = await body(req); const [, jobId, action] = jobRoute;
          if (action === 'ack') { object(data, ['leaseToken']); board.ack(deviceId, jobId, string(data.leaseToken)); return json(res, 200, { ok: true }); }
          object(data, ['leaseToken', 'state', 'result', 'code', 'fingerprint'], ['state']);
          const before = board.get(jobId); if (before.deviceId !== deviceId) fail('job_not_found', 404);
          let job;
          if (action === 'reconcile') { if (!['succeeded', 'rejected'].includes(data.state)) fail('invalid_reconciliation'); if (data.state === 'succeeded') validateResult(before, data.result); job = board.reconcile(deviceId, jobId, string(data.fingerprint), data.result, data.state, data.code); }
          else if (data.state === 'succeeded') job = board.complete(deviceId, jobId, string(data.leaseToken), validateResult(before, data.result));
          else job = board.reject(deviceId, jobId, string(data.leaseToken), data.state, data.code);
          projectResult(job);
          return json(res, 200, { id: job.id, state: job.state });
        }
        fail('endpoint_not_found', 404);
      }
      if (p.startsWith('/api/')) {
        if (!authenticated(req)) fail('login_required', 401);
        if (!['GET', 'HEAD'].includes(method) && req.headers.origin !== origin) fail('origin_rejected', 403);
        if (p === '/api/devices' && method === 'GET') return json(res, 200, { devices: Object.values(store.data.devices).filter(d => !d.revoked).map(d => ({ id: d.id, name: d.name, online: (heartbeats.get(d.id)?.at ?? 0) > Date.now() - 25_000, ready: heartbeats.get(d.id)?.ready ?? false })) });
        if (p === '/api/pairing' && method === 'POST') {
          const data = await body(req, 4096); object(data, ['deviceId', 'name']); identifier(data.deviceId); string(data.name, 80);
          if (pairs.size >= 100 || Object.keys(store.data.devices).length >= 20 && !Object.hasOwn(store.data.devices, data.deviceId)) fail('device_capacity', 429);
          for (const [key, value] of pairs) if (value.id === data.deviceId) pairs.delete(key);
          const code = secret(); pairs.set(digest(code), { id: data.deviceId, name: data.name, expires: Date.now() + 300_000 });
          return json(res, 201, { deviceId: data.deviceId, code });
        }
        const sync = /^\/api\/devices\/([A-Za-z0-9_-]+)\/sync$/.exec(p);
        if (sync && method === 'POST') {
          const data = await body(req, 4096); object(data, ['resource', 'clientIntentId', 'projectId', 'cursor', 'pageSize', 'search', 'archived'], ['resource', 'clientIntentId']);
          if (data.resource === 'projects') { object(data, ['resource', 'clientIntentId']); return json(res, 202, submit(sync[1], 'projects.sync', {}, data.clientIntentId)); }
          if (data.resource === 'directory') { object(data, ['resource', 'clientIntentId']); return json(res, 202, submit(sync[1], 'directory.sync', {}, data.clientIntentId)); }
          if (data.resource !== 'sessions') fail('invalid_resource'); project(sync[1], data.projectId);
          const { resource: _, clientIntentId, ...value } = data;
          return json(res, 202, submit(sync[1], 'sessions.sync', value, clientIntentId));
        }
        const projects = /^\/api\/devices\/([A-Za-z0-9_-]+)\/projects$/.exec(p);
        if (projects && method === 'GET') { hasDevice(projects[1]); return json(res, 200, { projects: store.data.projects[projects[1]] ?? [] }); }
        const conversations = /^\/api\/devices\/([A-Za-z0-9_-]+)\/conversations$/.exec(p);
        if (conversations && method === 'POST') {
          const data = await body(req, 4096); object(data, ['projectId', 'clientIntentId']); project(conversations[1], data.projectId);
          return json(res, 202, submit(conversations[1], 'conversation.create', { projectId: data.projectId }, data.clientIntentId));
        }
        if (conversations && method === 'GET') {
          hasDevice(conversations[1]); const cached = directories.get(conversations[1] + ':' + url.searchParams.get('projectId'));
          if (!cached || cached.expires < Date.now()) fail('catalog_refresh_required', 409);
          return json(res, 200, cached.value);
        }
        const upload = /^\/api\/conversations\/([A-Za-z0-9_-]+)\/attachments$/.exec(p);
        if (upload && method === 'POST') {
          const conversation = ownedConversation(upload[1]);
          const data = await body(req, 2900000); object(data, ['clientIntentId', 'mime', 'base64']); validateImage(data.mime, data.base64);
          if (attachments.size >= 100 || [...attachments.values()].reduce((n, a) => n + a.base64.length, data.base64.length) > 16 * 1024 * 1024) fail('attachment_capacity', 507);
          const attachmentId = digest(upload[1] + ':' + identifier(data.clientIntentId)).slice(0, 40);
          const job = submit(conversation.deviceId, 'attachment.stage', { conversationId: upload[1], attachmentId, mime: data.mime, base64: data.base64 }, data.clientIntentId);
          if (!attachments.has(attachmentId)) attachments.set(attachmentId, { conversationId: upload[1], mime: data.mime, base64: data.base64, expires: Date.now() + 300000, staged: false });
          return json(res, 202, job);
        }
        const critical = /^\/api\/conversations\/([A-Za-z0-9_-]+)\/(interrupt|approvals)$/.exec(p);
        if (critical && method === 'POST') {
          const conversation = ownedConversation(critical[1]);
          const data = await body(req, 8192);
          object(data, critical[2] === 'interrupt' ? ['clientIntentId', 'turnId'] : ['clientIntentId', 'approvalId', 'decision']);
          const { clientIntentId, ...value } = data;
          if (critical[2] === 'interrupt') {
            const turn = store.data.turns[value.turnId];
            if (!turn || turn.conversationId !== critical[1] || turn.status !== 'running') fail('turn_not_running', 409);
          }
          return json(res, 202, submit(conversation.deviceId, critical[2] === 'interrupt' ? 'turn.cancel' : 'approval.resolve', { conversationId: critical[1], ...value }, clientIntentId));
        }
        const conversationRoute = /^\/api\/conversations\/([A-Za-z0-9_-]+)\/(snapshots|messages|turns)$/.exec(p);
        if (conversationRoute) {
          const [, conversationId, action] = conversationRoute, conversation = ownedConversation(conversationId);
          if (action === 'messages' && method === 'GET') {
            const snapshot = snapshots.get(conversationId); if (!snapshot || snapshot.expires < Date.now()) fail('snapshot_required', 409);
            return json(res, 200, snapshot.value);
          }
          if (method === 'POST' && ['snapshots', 'turns'].includes(action)) {
            const data = await body(req, 32768); object(data, action === 'turns' ? ['clientIntentId', 'text', 'attachmentIds'] : ['clientIntentId', 'pageSize', 'cursor'], ['clientIntentId']);
            const { clientIntentId, ...value } = data;
            if (action === 'turns') for (const id of value.attachmentIds ?? []) { const attachment = attachments.get(id); if (!attachment || attachment.conversationId !== conversationId || !attachment.staged || attachment.expires < Date.now()) fail('attachment_not_staged', 409); }
            return json(res, 202, submit(conversation.deviceId, action === 'turns' ? 'turn.start' : 'conversation.snapshot', { ...value, conversationId }, clientIntentId));
          }
        }
        const activity = /^\/api\/devices\/([A-Za-z0-9_-]+)\/(activity|events)$/.exec(p);
        if (activity && method === 'GET') {
          hasDevice(activity[1]); const log = eventLogs.get(activity[1]), since = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0);
          if (!Number.isSafeInteger(since) || since < 0) fail('invalid_event_cursor');
          const events = log?.events.filter(event => event.seq > since) ?? [];
          if (activity[2] === 'activity') return json(res, 200, { epoch: log?.epoch ?? null, events });
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
          res.write(`data: ${JSON.stringify({ type: 'snapshot.required', epoch: log?.epoch ?? null })}\n\n`);
          for (const event of events) res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
          const subscriber = { deviceId: activity[1], res, req }; subscribers.add(subscriber); req.on('close', () => subscribers.delete(subscriber));
          return;
        }
        const job = /^\/api\/jobs\/([A-Za-z0-9_-]+)$/.exec(p);
        if (job && method === 'GET') return json(res, 200, board.get(job[1]));
        fail('endpoint_not_found', 404);
      }
      fail('endpoint_not_found', 404);
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? 500, { code: error.code ?? 'internal_error' });
      else res.destroy();
    }
  };
  const tls = options.tls ?? (process.env.RMT_BUSINESS_TLS_KEY && process.env.RMT_BUSINESS_TLS_CERT ? { key: fs.readFileSync(process.env.RMT_BUSINESS_TLS_KEY), cert: fs.readFileSync(process.env.RMT_BUSINESS_TLS_CERT) } : null);
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  if (origin.startsWith('https:') && !tls) { store.close(); fail('tls_configuration_required'); }
  server.requestTimeout = 35_000; server.headersTimeout = 10_000;
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
  server.on('connect', (_req, socket) => socket.destroy());
  const sweep = setInterval(() => {
    for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
    for (const [key, value] of pairs) if (value.expires < Date.now()) pairs.delete(key);
    for (const [key, value] of failures) if (value.until < Date.now()) failures.delete(key);
    try { board.sweep(); } catch { /* Board fails closed; no sensitive payload is logged. */ }
    for (const cache of [directories, snapshots, attachments]) for (const [key, value] of cache) if (value.expires < Date.now()) cache.delete(key);
    for (const [key, log] of eventLogs) if (log.expires < Date.now()) eventLogs.delete(key);
    for (const subscriber of subscribers) { if (!authenticated(subscriber.req)) { subscriber.res.end(); subscribers.delete(subscriber); continue; } if (subscriber.res.writableLength > 1024 * 1024) subscriber.res.destroy(); else subscriber.res.write(': heartbeat\n\n'); }
  }, 5000); sweep.unref();
  return { server, origin, listen: (port = Number(process.env.RMT_BUSINESS_PORT ?? 3230), host = process.env.RMT_BUSINESS_HOST ?? '127.0.0.1') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); }); }),
    async close() { closing = true; clearInterval(sweep); for (const subscriber of subscribers) subscriber.res.end(); for (const res of waiting) if (!res.writableEnded) json(res, 503, { code: 'server_stopping' }); await new Promise(resolve => server.close(resolve)); store.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await createBusinessServer(); const address = await service.listen();
  console.log(JSON.stringify({ event: 'business.listening', origin: service.origin, port: address.port }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void service.close(); });
}
