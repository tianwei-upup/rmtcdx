// Passive check only. A positive result is not authorization to connect.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectExecutorSocket } from '../business/src/existing-executor-discovery.mjs';
const bundle = '/Applications/ChatGPT.app/Contents/Resources/codex-cli';
const version = JSON.parse(fs.readFileSync(path.join(bundle, 'codex-package.json'))).version;
const binary = path.join(bundle, 'CodexCLI.app/Contents/MacOS/codex');
const processRows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\n');
const appServers = processRows.flatMap(row => {
  const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
  if (!match || !match[3].startsWith(binary + ' ') || !/\sapp-server(?:\s|$)/.test(match[3])) return [];
  // Do not print command lines, environment variables or configuration overrides.
  const listener = match[3].match(/--listen(?:=|\s+)(\S+)/)?.[1];
  return [{ pid: Number(match[1]), parentPid: Number(match[2]), explicitListen: listener ? listener.startsWith('unix://') ? 'unix' : listener.startsWith('ws://') ? 'websocket' : 'other' : 'absent' }];
});
const physicalRoot = path.join(fs.realpathSync('/tmp'), 'codex-daemon-' + process.getuid());
const endpoint = inspectExecutorSocket(path.join(os.homedir(), '.codex/app-server-control/app-server-control.sock'), { physicalRoot });
console.log(JSON.stringify({ mode: 'passive-filesystem-process-check', bundledVersion: version, appServers, endpoint, connected: false, started: false, changedDesktop: false, next: endpoint.attachable ? 'verify_listener_owner_and_version_before_any_connection' : 'keep_existing_desktop_untouched' }));
