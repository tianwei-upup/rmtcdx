import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertIsolatedNativeRuntime } from '../src/runtime-isolation.mjs';
import { startAgent } from '../src/agent.mjs';
import { nativeAdapter } from '../src/codex-adapter.mjs';

test('default native agent refuses before any state file, pairing or Codex process is created', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt-isolation-'));
  try {
    const stateFile = path.join(dir, 'never-created', 'agent.json');
    await assert.rejects(startAgent({ origin: 'https://127.0.0.1:1', deviceId: 'mac', stateFile, projects: [] }), /native_runtime_suspended_pending_isolation/);
    assert.equal(fs.existsSync(path.dirname(stateFile)), false);
    await assert.rejects(nativeAdapter([]), /native_runtime_suspended_pending_isolation/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('isolated runtime requires explicit distinct HOME, exact CODEX_HOME and no inherited desktop context or shared files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt-isolation-'));
  const desktopHome = path.join(dir, 'desktop'), runtimeHome = path.join(dir, 'runtime');
  const profile = path.join(runtimeHome, '.codex'); fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(path.join(desktopHome, '.codex'), { recursive: true });
  const options = { desktopHome, env: { CODEX_HOME: profile } };
  try {
    assert.equal(assertIsolatedNativeRuntime(runtimeHome, options), fs.realpathSync(runtimeHome));
    assert.throws(() => assertIsolatedNativeRuntime(desktopHome, options), /native_runtime_shares_desktop/);
    assert.throws(() => assertIsolatedNativeRuntime(runtimeHome, { ...options, env: {} }), /native_runtime_codex_home_mismatch/);
    for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_SQLITE_HOME']) assert.throws(() => assertIsolatedNativeRuntime(runtimeHome, { ...options, env: { ...options.env, [key]: 'inherited' } }), /native_runtime_inherits_desktop_context/);
    const original = path.join(desktopHome, '.codex/state.sqlite'); fs.writeFileSync(original, 'fixture');
    const alias = path.join(profile, 'state.sqlite'); fs.symlinkSync(original, alias);
    assert.throws(() => assertIsolatedNativeRuntime(runtimeHome, options), /native_runtime_shared_file/); fs.unlinkSync(alias);
    fs.linkSync(original, alias); assert.throws(() => assertIsolatedNativeRuntime(runtimeHome, options), /native_runtime_shared_file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
