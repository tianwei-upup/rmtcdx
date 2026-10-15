import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_BODY = 4 * 1024 * 1024;
export const MAX_RESPONSE = 32 * 1024 * 1024;
// A valid JSON response embedded in a JSON string can double in size.
export const MAX_FRAME = 2 * MAX_RESPONSE + 64 * 1024;
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const secret = () => crypto.randomBytes(32).toString('base64url');
export const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export const validRequestId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(value);
export function equalSecret(a, b) {
  return crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export function trustedUrl(value, protocols = ['https:']) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('URL must be an origin without credentials');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!protocols.includes(url.protocol) && !(local && url.protocol === 'http:')) throw new Error('HTTPS required except loopback');
  return url;
}
export function allowedApi(method, input) {
  let url;
  try { url = new URL(input, 'http://bridge'); } catch { return false; }
  if (url.origin !== 'http://bridge' || input.includes('\\') || /%2f|%5c|%2e/i.test(input)) return false;
  const p = url.pathname;
  const id = '[a-zA-Z0-9_-]+';
  const patterns = {
    GET: ['account/rate-limits', 'codex/models', 'notifications/config', 'repos', `repos/${id}`, 'sessions', 'sessions/search', `sessions/${id}`, `sessions/${id}/messages`, `sessions/${id}/codex/requests`, `runs/${id}`],
    POST: ['sessions', `repos/${id}/select`, `sessions/${id}/(?:select|archive|restore|read)`, `sessions/${id}/files/preview`, 'runs', `runs/${id}/interrupt`, `codex/requests/${id}/respond`],
    PATCH: [`sessions/${id}`]
  };
  return (patterns[method] ?? []).some(pattern => new RegExp(`^/api/${pattern}$`).test(p));
}
export function sendFrame(ws, frame) {
  if (ws.readyState !== 1) return false;
  const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
  if (Buffer.byteLength(data) + ws.bufferedAmount > MAX_FRAME) { ws.close(1013, 'Backpressure'); return false; }
  ws.send(data);
  return true;
}
export function json(res, code, value, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
export async function readBody(req, max = MAX_BODY) {
  let size = 0;
  const chunks = [];
  // Keep the HTTP connection alive long enough to return an explicit 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) { req.resume(); throw Object.assign(new Error('Payload too large'), { status: 413 }); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
// Single-process store. Lock prevents accidentally running two writers against one file.
export class Store {
  constructor(file, initial) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.lock = this.file + '.lock';
    try { this.fd = fs.openSync(this.lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(this.lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid state lock; inspect manually');
      try { process.kill(pid, 0); throw new Error('State is already in use'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      fs.unlinkSync(this.lock);
      this.fd = fs.openSync(this.lock, 'wx', 0o600);
    }
    fs.writeFileSync(this.fd, String(process.pid));
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') { this.close(); throw error; } this.data = initial; }
  }
  save() {
    const data = JSON.stringify(this.data);
    if (Buffer.byteLength(data) > 64 * 1024 * 1024) throw new Error('State capacity reached; manual rotation required');
    const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
  }
  close() {
    if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; fs.unlinkSync(this.lock); }
  }
}
