// Read-only research probe. Run directly from a Codex desktop tool with the
// bundled Node runtime; do not wrap it in another Node process. No app-server
// is started, no tool outside READ_TOOLS can be invoked, and no text is saved.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_FRAME = 8 * 1024 * 1024;
const READ_TOOLS = new Set(['list_projects', 'list_threads', 'read_thread']);
const fail = code => Object.assign(new Error(code), { code });

export class DesktopReadProbe {
  #socket;
  #pending = new Map();
  #buffer = Buffer.alloc(0);
  #nextId = 1;

  async connect(endpoint) {
    if (!endpoint || !path.isAbsolute(endpoint)) throw fail('app_tools_pipe_required');
    const stat = fs.lstatSync(endpoint);
    if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail('unsafe_app_tools_pipe');
    this.#socket = net.createConnection(endpoint);
    this.#socket.on('data', chunk => this.#receive(chunk));
    this.#socket.on('error', () => this.#abort('app_tools_socket_error'));
    this.#socket.on('close', () => this.#abort('app_tools_pipe_closed'));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(fail('app_tools_connect_timeout')); }, 5000);
      const done = error => {
        clearTimeout(timer);
        this.#socket.off('connect', connected);
        this.#socket.off('error', errored);
        error ? reject(fail('app_tools_connect_failed')) : resolve();
      };
      const connected = () => done();
      const errored = error => done(error);
      this.#socket.once('connect', connected);
      this.#socket.once('error', errored);
    });
  }

  #abort(code) {
    for (const entry of this.#pending.values()) entry.reject(fail(code));
    this.#pending.clear();
    this.#buffer = Buffer.alloc(0);
  }

  #receive(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const size = this.#buffer.readUInt32LE(0);
      if (size > MAX_FRAME) { this.#abort('app_tools_frame_too_large'); this.close(); return; }
      if (this.#buffer.length < size + 4) return;
      const frame = this.#buffer.subarray(4, size + 4);
      this.#buffer = this.#buffer.subarray(size + 4);
      let response;
      try { response = JSON.parse(frame.toString('utf8')); }
      catch { this.#abort('app_tools_invalid_json'); this.close(); return; }
      const pending = this.#pending.get(response.id);
      if (!pending) continue;
      this.#pending.delete(response.id);
      if (response.error) pending.reject(fail('app_tools_rpc_rejected'));
      else pending.resolve(response.result);
    }
  }

  #request(method, params) {
    if (!this.#socket || this.#socket.destroyed) return Promise.reject(fail('app_tools_not_connected'));
    const id = this.#nextId++;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    if (payload.length > MAX_FRAME) return Promise.reject(fail('app_tools_request_too_large'));
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length);
    payload.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const finish = callback => value => { clearTimeout(timer); callback(value); };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(fail('app_tools_request_timeout'));
        // These requests are read-only. Closing is sufficient; never retry writes.
        this.close();
      }, 15000);
      this.#pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      this.#socket.write(frame, error => {
        if (error) { this.#pending.get(id)?.reject(fail('app_tools_write_failed')); this.#pending.delete(id); }
      });
    });
  }

  async catalog() {
    const result = await this.#request('tools/list', { threadStartKind: 'all' });
    if (!Array.isArray(result?.tools)) throw fail('app_tools_catalog_invalid');
    return result.tools.filter(tool => tool.namespace === 'codex_app').map(tool => tool.name);
  }

  async call(tool, args, callerThreadId) {
    if (!READ_TOOLS.has(tool)) throw fail('read_only_probe');
    if (!callerThreadId?.trim()) throw fail('desktop_caller_context_required');
    const result = await this.#request('tools/call', {
      namespace: 'codex_app', tool, arguments: args,
      callerSource: 'codex', hostId: 'local', threadId: callerThreadId,
      callId: `rmtcdx-read-probe-${randomUUID()}`,
      // The bundled MCP server also supplies a correlation ID when no turn ID
      // is provided. This is not a claim that a new Codex turn was created.
      turnId: `mcp-turn-rmtcdx-read-probe-${randomUUID()}`
    });
    if (result?.success !== true) throw fail('app_tool_failed');
    const content = result.contentItems?.filter(item => item.type === 'inputText') ?? [];
    if (content.length !== 1) throw fail('app_tool_result_invalid');
    return JSON.parse(content[0].text);
  }

  close() { this.#socket?.destroy(); this.#abort('app_tools_client_closed'); }
}

export async function probe({ endpoint = process.env.CODEX_APP_TOOLS_PIPE_PATH, callerThreadId = process.env.CODEX_THREAD_ID, threadId } = {}) {
  if (!callerThreadId?.trim()) throw fail('desktop_caller_context_required');
  const client = new DesktopReadProbe();
  try {
    await client.connect(endpoint);
    const tools = await client.catalog();
    for (const name of READ_TOOLS) if (!tools.includes(name)) throw fail('required_read_tool_missing');
    const projects = await client.call('list_projects', {}, callerThreadId);
    const threads = await client.call('list_threads', { limit: 50 }, callerThreadId);
    const target = threadId ?? callerThreadId;
    const read = await client.call('read_thread', { threadId: target, hostId: 'local', turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 200 }, callerThreadId);
    if (read.thread?.id !== target) throw fail('read_thread_identity_mismatch');
    // Only structural evidence is retained. Project paths, names, previews,
    // prompts, messages and tool output never enter this report.
    return {
      checkedAt: new Date().toISOString(), transport: 'desktop-app-tools-native-pipe',
      localProjects: projects.projects?.filter(project => project.projectKind === 'local').length,
      totalProjects: projects.projects?.length,
      pinnedThreads: threads.pinnedThreads?.length,
      recentThreads: threads.threads?.length,
      sampleThreadId: target, returnedThreadId: read.thread.id,
      returnedTurns: read.turns?.length,
      returnedItems: read.turns?.reduce((total, turn) => total + (turn.items?.length ?? 0), 0),
      itemTypes: [...new Set((read.turns ?? []).flatMap(turn => (turn.items ?? []).map(item => item.type)))],
      readHasMore: read.page?.hasMore,
      unavailableHosts: threads.unavailableHosts?.length,
      writeToolAdvertised: tools.includes('send_message_to_thread'),
      writeCalls: 0, executionProcessesStarted: 0
    };
  } finally { client.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  let output;
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--thread-id=')) options.threadId = argument.slice(12);
    else if (argument.startsWith('--output=')) output = argument.slice(9);
    else throw fail('unknown_probe_argument');
  }
  try {
    const report = await probe(options);
    if (output) {
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    }
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'probe_failed' }));
    process.exitCode = 1;
  }
}
