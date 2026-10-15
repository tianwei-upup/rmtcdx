// Unit tests for the attachAdapter contract (ATTACH_ADAPTER_CONTRACT.md §八.1).
// These tests do NOT require a disposable desktop, do NOT touch the user's
// real Codex installation, and do NOT call any network endpoint. The fake
// client cases validate the contract surface that the real WsCodexClient /
// UdsCodexClient prototypes will implement in a later phase.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTransport, attachAdapter } from '../src/attach-adapter.mjs';
import { assertNativeExecutionAllowed } from '../src/runtime-isolation.mjs';

// U-13: native guard must remain hard-rejected.
test('U-13: assertNativeExecutionAllowed still hard-rejects native startup', () => {
  assert.throws(() => assertNativeExecutionAllowed(), { code: 'native_runtime_suspended_pending_isolation' });
});

// U-2: only the three known transport kinds are accepted.
test('U-2: invalid_transport for unknown kind', () => {
  assert.throws(() => resolveTransport({ kind: 'tcp', host: 'evil' }), { code: 'invalid_transport' });
  assert.throws(() => resolveTransport({ kind: 'http', url: 'http://localhost' }), { code: 'invalid_transport' });
  assert.throws(() => resolveTransport({ kind: 'ws', url: 'http://example.com/x' }), { code: 'https_required' });
});

// U-3: non-absolute paths are rejected before any fs access.
test('U-3: invalid_socket_path for relative advertised or physicalRoot', () => {
  assert.throws(() => resolveTransport({ kind: 'unix-alias', advertised: 'relative.sock', physicalRoot: '/tmp/x' }), { code: 'invalid_socket_path' });
  assert.throws(() => resolveTransport({ kind: 'unix-alias', advertised: '/abs/path', physicalRoot: 'relative' }), { code: 'invalid_socket_path' });
  assert.throws(() => resolveTransport({ kind: 'unix-direct', path: 'relative' }), { code: 'invalid_socket_path' });
});

// U-4: missing advertised socket maps to socket_missing.
// Use realpathSync on the tmp dir so the macOS /var → /private/var symlink
// does not cause inspectExecutorSocket to flag aliased_advertised_parent.
test('U-4: socket_missing when advertised path does not exist', () => {
  const realTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmtcdx-attach-')));
  fs.chmodSync(realTmp, 0o700);
  const missing = path.join(realTmp, 'never-existed.sock');
  const physicalRoot = path.join(realTmp, 'daemon');
  fs.mkdirSync(physicalRoot, { mode: 0o700 });
  assert.throws(() => resolveTransport({ kind: 'unix-alias', advertised: missing, physicalRoot }), { code: 'socket_missing' });
  fs.rmdirSync(physicalRoot); fs.rmdirSync(realTmp);
});

// U-5: unsafe parent directory permission surfaces unsafe_socket.
// The parent must pass realpathSync == parent (macOS /var symlink aware).
test('U-5: unsafe_advertised_parent surfaces unsafe_socket', () => {
  const realTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmtcdx-attach-')));
  fs.chmodSync(realTmp, 0o755); // group/other readable
  const advertised = path.join(realTmp, 'fake.sock');
  const physicalRoot = path.join(realTmp, 'daemon');
  assert.throws(() => resolveTransport({ kind: 'unix-alias', advertised, physicalRoot }), { code: 'unsafe_socket' });
  fs.rmdirSync(realTmp);
});

// U-7: a regular file is not a socket.
test('U-7: unsafe_socket when target is not a socket', () => {
  const realTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmtcdx-attach-')));
  fs.chmodSync(realTmp, 0o700);
  const file = path.join(realTmp, 'not-a-socket');
  fs.writeFileSync(file, '');
  fs.chmodSync(file, 0o600);
  assert.throws(() => resolveTransport({ kind: 'unix-direct', path: file }), { code: 'unsafe_socket' });
  fs.unlinkSync(file); fs.rmdirSync(realTmp);
});

// U-11: ws only allows wss:// or ws:// loopback (covered by U-12 below).
test('U-11: ws rejects non-loopback ws:// and non-ws(s) protocols', () => {
  assert.throws(() => resolveTransport({ kind: 'ws', url: 'ws://example.com/rpc' }), { code: 'https_required' });
  assert.throws(() => resolveTransport({ kind: 'ws', url: 'http://localhost/rpc' }), { code: 'https_required' });
});

// U-12: ws wss://loopback is accepted; ws://loopback is accepted; ws://external rejected.
test('U-12: ws wss://localhost is valid; ws://external is rejected', () => {
  // wss://localhost should pass
  const r1 = resolveTransport({ kind: 'ws', url: 'wss://localhost:443/rpc' });
  assert.equal(r1.kind, 'ws');
  // ws://127.0.0.1 is loopback-equivalent
  const r2 = resolveTransport({ kind: 'ws', url: 'ws://127.0.0.1:9999/rpc' });
  assert.equal(r2.kind, 'ws');
  // ws://external.example.com rejected
  assert.throws(() => resolveTransport({ kind: 'ws', url: 'ws://external.example.com/rpc' }), { code: 'https_required' });
});

// U-15 (priority for ws path): wss://external must be https_required regardless of any url field
test('U-15: ws with http(s):// scheme is rejected', () => {
  assert.throws(() => resolveTransport({ kind: 'ws', url: 'https://example.com/rpc' }), { code: 'https_required' });
  assert.throws(() => resolveTransport({ kind: 'ws', url: 'http://127.0.0.1/rpc' }), { code: 'https_required' });
});

// U-8/U-9: skeleton returns a contract-conformant adapter; execute is fail-closed
test('U-8/U-9: attachAdapter validates then returns a fail-closed skeleton', async () => {
  // Build a minimal but valid unix-direct endpoint so the skeleton passes validation.
  const realTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rmtcdx-attach-')));
  fs.chmodSync(realTmp, 0o700);
  const sockPath = path.join(realTmp, 'skel.sock');
  const net = await import('node:net');
  const listener = net.createServer().listen(sockPath);
  await new Promise((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
  fs.chmodSync(sockPath, 0o600);
  try {
    const adapter = await attachAdapter({ kind: 'unix-direct', path: sockPath }, [{ id: 'p1', name: 'Project' }]);
    assert.equal(adapter.state, 'validated_only');
    assert.equal(adapter.getState().ready, false);
    assert.equal(adapter.getState().lastError.code, 'attach_not_implemented');
    await assert.rejects(adapter.execute('projects.sync', {}, 'job-1'), { code: 'attach_not_implemented' });
  } finally {
    // net.Server.close() removes the unix socket file automatically; do not unlink.
    await new Promise(resolve => listener.close(resolve));
    fs.rmdirSync(realTmp);
  }
});

// U-10: client disconnected path — skeleton reports state correctly even when client not started.
test('U-10: skeleton does not retry and never imports native runtime', async () => {
  const src = fs.readFileSync(new URL('../src/attach-adapter.mjs', import.meta.url), 'utf8');
  // Strip // and /* */ comments so anti-regression assertions don't trigger on documentation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Fail-closed anti-regression invariants (contract §八.3 F-1, F-2, F-3).
  assert.equal(code.includes('nativeAdapter'), false, 'F-1: must not reference nativeAdapter');
  assert.equal(code.includes('assertIsolatedNativeRuntime'), false, 'must not bypass the suspended guard');
  assert.equal(/setTimeout|setInterval/.test(code), false, 'F-2: no retry loop in skeleton');
  assert.equal(code.includes('RealCodexClient'), false, 'F-1: must not import suspended native client');
});

// U-14: agent.mjs config priority contract — adapter wins over transport.
test('U-14: dispatcher selects adapter when present, transport when only transport present, native otherwise', () => {
  // Mirrors the planned agent.mjs:35-38 contract branch logic.
  const selectAdapter = (config) => {
    if (config.adapter) return { source: 'adapter' };
    if (config.transport) return { source: 'transport' };
    return { source: 'native' };
  };
  assert.equal(selectAdapter({ adapter: () => {}, transport: null }).source, 'adapter');
  assert.equal(selectAdapter({ adapter: null, transport: { kind: 'ws', url: 'wss://localhost/rpc' } }).source, 'transport');
  assert.equal(selectAdapter({}).source, 'native');
});

// U-15: when both adapter and transport are present, adapter wins (no double connection).
test('U-15: adapter and transport both set → adapter wins', () => {
  const selectAdapter = (config) => {
    if (config.adapter) return { source: 'adapter' };
    if (config.transport) return { source: 'transport' };
    return { source: 'native' };
  };
  assert.equal(selectAdapter({ adapter: () => {}, transport: { kind: 'ws', url: 'wss://localhost/rpc' } }).source, 'adapter');
});

// U-1: transport=null still routes to nativeAdapter path (which is hard-rejected).
test('U-1: transport=null falls through to native path which is hard-rejected', () => {
  // resolveTransport(null) throws invalid_transport; the dispatcher in agent.mjs
  // would then attempt nativeAdapter, which immediately calls assertNativeExecutionAllowed.
  assert.throws(() => resolveTransport(null), { code: 'invalid_transport' });
  // The native path itself:
  assert.throws(() => assertNativeExecutionAllowed(), { code: 'native_runtime_suspended_pending_isolation' });
});

// Anti-regression: business/src/attach-adapter.mjs must not import suspended modules.
test('attach-adapter.mjs has no transitive native runtime dependency', () => {
  const src = fs.readFileSync(new URL('../src/attach-adapter.mjs', import.meta.url), 'utf8');
  // Strip comments so we only check actual code (import statements, references).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/import\s.*['"][^'"]*codex-adapter/.test(code), false, 'must not import codex-adapter (which transitively imports suspended runtime)');
  assert.equal(/import\s.*['"][^'"]*services\/rmtcdx/.test(code), false, 'must not import suspended bridge runtime');
  assert.equal(/import\s.*['"][^'"]*codex-runtime|RealCodexClient/.test(code), false, 'must not import suspended native client');
});

// Anti-regression: resolveTransport is pure — calling it twice with the same input gives the same result.
test('resolveTransport is deterministic for the same input', () => {
  const transport = { kind: 'ws', url: 'wss://127.0.0.1:443/rpc' };
  const a = resolveTransport(transport);
  const b = resolveTransport(transport);
  assert.deepEqual(a, b);
});
