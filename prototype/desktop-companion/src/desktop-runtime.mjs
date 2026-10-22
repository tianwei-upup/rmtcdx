import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Explicitly verified builds only. NativeHistoryQueue independently checks the
// complete SQLite schema and migrations before every actual queue write.
export const DESKTOP_CLI_VERSIONS = Object.freeze(['0.163.0-alpha.10.2', '0.163.0-alpha.11.1']);
const exec = promisify(execFile);
export function assertDesktopCliVersion(version) {
  if (!DESKTOP_CLI_VERSIONS.includes(version)) throw Object.assign(Error('desktop_build_changed'), {
    code: 'desktop_build_changed', desktopVersion: version, supportedVersions: DESKTOP_CLI_VERSIONS
  });
  return version;
}
export async function checkDesktopRuntime({
  readVersion = () => JSON.parse(fs.readFileSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-package.json', 'utf8')).version,
  run = exec
} = {}) {
  const version = assertDesktopCliVersion(readVersion());
  const { stdout } = await run('/bin/ps', ['-axo', 'uid=,pid=,comm='], { timeout: 5000 });
  const matches = stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter(m => m && Number(m[1]) === process.getuid() && m[3] === '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
  if (matches.length !== 1) throw Object.assign(Error('original_desktop_unavailable'), { code: 'original_desktop_unavailable' });
  return { version, desktopPid: Number(matches[0][2]) };
}

// Runtime admission failures must be observable for every affected Inbox;
// a healthy cloud heartbeat does not prove the desktop can accept a message.
export async function runReceiverTick({ checkDesktop, ids, receive, unavailable }) {
  const targets = [...ids];
  try { await checkDesktop(); }
  catch (error) { for (const id of targets) await unavailable(id, error); return; }
  for (const id of targets) {
    try { await receive(id); }
    catch (error) { await unavailable(id, error); }
  }
}
