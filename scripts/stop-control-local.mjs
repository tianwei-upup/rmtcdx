import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') throw new Error('On Windows use scripts/stop-control-local.ps1');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.runtime/control-processes.json');
if (fs.existsSync(file)) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const allowed = new Set(['cloud.mjs', 'client.mjs'].map(name => path.join(root, 'control/src', name)));
  for (const entry of entries.reverse()) {
    if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 || !allowed.has(entry.entry)) throw new Error('Invalid local process metadata');
    let command;
    try { command = execFileSync('ps', ['-p', String(entry.pid), '-o', 'command='], { encoding: 'utf8' }).trim(); }
    catch (error) { if (error.status === 1) continue; throw error; }
    if (!command.endsWith(' ' + entry.entry)) throw new Error(`PID ${entry.pid} no longer belongs to the local relay; refusing to stop it`);
    try { process.kill(entry.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  fs.unlinkSync(file);
}
console.log('Local relay/client stop requested; the Codex bridge remains running');
