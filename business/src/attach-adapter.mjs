// Attach-only business adapter. Per ATTACH_ADAPTER_CONTRACT.md §一:
//   - never starts, stops or restarts the executor
//   - never falls back to nativeAdapter
//   - never imports the suspended native runtime path
//
// This file is the validation + resolution skeleton. The actual
// WsCodexClient / UdsCodexClient prototype is a separate deliverable
// (contract §十 item 2). Until then, the returned adapter is marked
// state = 'validated_only' and any execute() call surfaces
// attach_not_implemented so agent.mjs reports ready=false.
//
// Do not relax any of the following guards without re-reading
// docs/CODEX_RUNTIME_ISOLATION_AUDIT.md and the contract.
import path from 'node:path';
import fs from 'node:fs';
import { inspectExecutorSocket } from './existing-executor-discovery.mjs';

const fail = (code, status = 503) => {
  throw Object.assign(new Error(code), { code, status });
};

const INSECURE_LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// resolveTransport validates a transport descriptor without opening any
// socket. Returns a normalized endpoint on success; throws with a contract
// error code (ATTACH_ADAPTER_CONTRACT.md §五) on any failure.
export function resolveTransport(transport, { uid = process.getuid() } = {}) {
  if (!transport || typeof transport !== 'object') fail('invalid_transport', 400);
  if (transport.kind === 'unix-alias') {
    if (typeof transport.advertised !== 'string' || !path.isAbsolute(transport.advertised)) fail('invalid_socket_path', 400);
    if (typeof transport.physicalRoot !== 'string' || !path.isAbsolute(transport.physicalRoot)) fail('invalid_socket_path', 400);
    const result = inspectExecutorSocket(transport.advertised, { uid, physicalRoot: transport.physicalRoot });
    if (!result.attachable) {
      const unsafe = new Set(['unsafe_advertised_parent', 'unsafe_physical_parent', 'aliased_advertised_parent', 'unexpected_socket_alias', 'unsafe_socket', 'invalid_socket_path']);
      const code = result.reason === 'socket_missing' ? 'socket_missing' : unsafe.has(result.reason) ? 'unsafe_socket' : 'socket_inspection_failed';
      fail(code, 503);
    }
    return { kind: 'unix-alias', advertised: result.advertised, physical: result.physical };
  }
  if (transport.kind === 'unix-direct') {
    if (typeof transport.path !== 'string' || !path.isAbsolute(transport.path)) fail('invalid_socket_path', 400);
    let stat;
    try { stat = fs.lstatSync(transport.path); } catch (error) {
      if (error.code === 'ENOENT') fail('socket_missing', 503);
      fail('socket_inspection_failed', 503);
    }
    if (!stat.isSocket() || stat.uid !== uid || (stat.mode & 0o077) !== 0) fail('unsafe_socket', 503);
    return { kind: 'unix-direct', path: transport.path };
  }
  if (transport.kind === 'ws') {
    if (typeof transport.url !== 'string') fail('invalid_transport', 400);
    let url;
    try { url = new URL(transport.url); } catch { fail('invalid_transport', 400); }
    if (url.protocol === 'ws:' && !INSECURE_LOOPBACK.has(url.hostname)) fail('https_required', 400);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') fail('https_required', 400);
    return { kind: 'ws', url: transport.url };
  }
  fail('invalid_transport', 400);
}

// attachAdapter validates the transport, then returns an adapter bound to the
// injected client factory. Without a factory it stays the fail-closed skeleton
// required by contract §十, so an unvalidated or unimplemented path can never
// silently execute.
//
// Fail-closed guarantees for both shapes:
//   - never calls nativeAdapter and never imports the suspended native runtime;
//   - an unavailable endpoint surfaces as a failed start(), never a fallback;
//   - no retry loop; the injected client owns connection failures and must not
//     spawn a replacement executor.
export async function attachAdapter(
  transport,
  projects,
  emit = () => {},
  _attachmentDir = null,
  _conversationProjects = {},
  { uid = process.getuid(), createClient = null } = {}
) {
  if (!Array.isArray(projects)) fail('invalid_projects', 400);
  const resolved = resolveTransport(transport, { uid });

  if (!createClient) {
    return {
      resolved,
      projects,
      emit,
      state: 'validated_only',
      async start() {},
      async stop() {},
      on() {},
      getState() {
        return { ready: false, lastError: { code: 'attach_not_implemented', message: 'WsCodexClient prototype pending contract §十' } };
      },
      async execute() {
        throw Object.assign(new Error('attach_not_implemented'), { code: 'attach_not_implemented' });
      }
    };
  }

  const client = createClient(resolved, projects);
  return {
    resolved,
    projects,
    emit,
    client,
    state: 'connecting',
    async start() {
      await client.start();
      this.state = 'connected';
    },
    async stop() {
      this.state = 'stopped';
      await client.stop();
    },
    on(...args) {
      return client.on(...args);
    },
    getState() {
      // CodexAdapter exposes ready(); RealCodexClient exposes getState().
      // Both are supported so the injected factory can return either.
      if (typeof client.ready === 'function') return { ready: client.ready() === true };
      return client.getState();
    },
    async execute(operation, params, jobId) {
      return client.execute(operation, params, jobId);
    }
  };
}
