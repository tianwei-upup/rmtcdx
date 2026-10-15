import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const reject = code => { throw Object.assign(new Error(code), { code }); };
const contains = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };

// Native execution remains suspended until independent storage, session import,
// process lifecycle and resource limits have been verified together.
export function assertNativeExecutionAllowed() { reject('native_runtime_suspended_pending_isolation'); }

// Fail closed: a tool's read-only sandbox does not isolate Codex's own state.
// No profile is created or copied by this guard.
export function assertIsolatedNativeRuntime(runtimeHome = process.env.RMT_CODEX_RUNTIME_HOME, { env = process.env, desktopHome = os.homedir() } = {}) {
  if (!runtimeHome || !path.isAbsolute(runtimeHome)) reject('native_runtime_isolation_required');
  const runtime = fs.realpathSync(runtimeHome), desktop = fs.realpathSync(desktopHome);
  const desktopProfile = path.join(desktop, '.codex');
  if (runtime === desktop || contains(runtime, desktopProfile) || contains(desktopProfile, runtime)) reject('native_runtime_shares_desktop');
  const profile = path.join(runtime, '.codex');
  if (!env.CODEX_HOME || fs.realpathSync(env.CODEX_HOME) !== profile) reject('native_runtime_codex_home_mismatch');
  if (env.CODEX_HOME_DIR && fs.realpathSync(env.CODEX_HOME_DIR) !== runtime) reject('native_runtime_codex_home_mismatch');
  if (Object.keys(env).some(key => key.startsWith('CODEX_') && !['CODEX_HOME', 'CODEX_HOME_DIR'].includes(key))) reject('native_runtime_inherits_desktop_context');
  let entries = 0;
  function inspect(file) {
    if (++entries > 50000) reject('native_runtime_profile_too_large');
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) reject('native_runtime_shared_file');
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) inspect(path.join(file, name));
  }
  inspect(profile);
  return runtime;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assertNativeExecutionAllowed(); assertIsolatedNativeRuntime(); }
  catch (error) { console.error('rmtcdx native startup blocked: ' + (error.code || 'native_runtime_profile_invalid')); process.exitCode = 1; }
}
