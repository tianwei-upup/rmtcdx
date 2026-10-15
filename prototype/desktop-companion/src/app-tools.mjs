import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_FRAME = 8 * 1024 * 1024;
const TOOLS = new Set(['list_projects', 'list_threads', 'read_thread', 'send_message_to_thread']);
export const failure = code => Object.assign(new Error(code), { code });

export function encode(message) {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length > MAX_FRAME) throw failure('frame_too_large');
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
  return frame;
}

export class AppToolsClient {
  constructor({ endpoint, callerThreadId, timeoutMs = 20000 }) {
    if (!endpoint || !path.isAbsolute(endpoint)) throw failure('desktop_pipe_required');
    if (!callerThreadId?.trim()) throw failure('desktop_caller_required');
    this.endpoint = endpoint; this.callerThreadId = callerThreadId; this.timeoutMs = timeoutMs;
    this.pending = new Map(); this.nextId = 1; this.buffer = Buffer.alloc(0); this.socket = null;
  }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    const stat = fs.lstatSync(this.endpoint);
    if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw failure('unsafe_desktop_pipe');
    const socket = net.createConnection(this.endpoint); this.socket = socket;
    socket.on('data', chunk => {
      if (this.socket !== socket) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (size > MAX_FRAME) { this.close('frame_too_large'); return; }
        if (this.buffer.length < size + 4) return;
        let response;
        try { response = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8')); }
        catch { this.close('invalid_desktop_frame'); return; }
        this.buffer = this.buffer.subarray(size + 4);
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        response.error ? pending.reject(failure('desktop_rpc_rejected')) : pending.resolve(response.result);
      }
    });
    socket.on('error', () => { if (this.socket === socket) this.close('desktop_socket_error'); });
    socket.on('close', () => { if (this.socket === socket) this.close('desktop_pipe_closed'); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); done(failure('desktop_connect_timeout')); }, this.timeoutMs);
      const connected = () => done();
      const closed = () => done(failure('desktop_connection_rejected'));
      const errored = () => done(failure('desktop_connect_failed'));
      const done = error => {
        clearTimeout(timer); socket.off('connect', connected); socket.off('close', closed); socket.off('error', errored);
        error ? reject(error) : resolve();
      };
      socket.once('connect', connected); socket.once('close', closed); socket.once('error', errored);
    });
  }
  async request(method, params) {
    if (!this.socket || this.socket.destroyed) throw failure('desktop_not_connected');
    const id = this.nextId++, frame = encode({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const finish = callback => value => { clearTimeout(timer); callback(value); };
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('desktop_request_timeout')); this.close(); }, this.timeoutMs);
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      this.socket.write(frame, error => { if (error) this.close('desktop_write_failed'); });
    });
  }
  async catalog() { return (await this.request('tools/list', { threadStartKind: 'all' })).tools; }
  async tool(name, args) {
    if (!TOOLS.has(name)) throw failure('unsupported_desktop_tool');
    const result = await this.request('tools/call', {
      namespace: 'codex_app', tool: name, arguments: args, callerSource: 'codex', hostId: 'local',
      threadId: this.callerThreadId, callId: `rmtcdx-companion-${randomUUID()}`, turnId: `mcp-turn-rmtcdx-${randomUUID()}`
    });
    if (result?.success !== true) throw failure('desktop_tool_failed');
    const text = result.contentItems?.filter(item => item.type === 'inputText');
    if (text?.length !== 1) throw failure('invalid_desktop_tool_result');
    try { return JSON.parse(text[0].text); }
    catch { return { text: text[0].text }; }
  }
  close(code = 'desktop_client_closed') {
    const socket = this.socket; this.socket = null; socket?.destroy(); this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.reject(failure(code));
    this.pending.clear();
  }
}
