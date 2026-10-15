import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { failure } from './app-tools.mjs';

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw failure('unsafe_runtime');
}
export function readPrivate(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw failure('unsafe_state_file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function writePrivate(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
export function acquireOwner(runtime) {
  privateDirectory(runtime);
  const file = path.join(runtime, 'owner.json'), token = crypto.randomUUID();
  const mutexFile = path.join(runtime, 'owner-lock.sqlite');
  try { fs.closeSync(fs.openSync(mutexFile, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(mutexFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw failure('unsafe_owner_lock');
  const mutex = new DatabaseSync(mutexFile);
  // Kernel-backed SQLite lock avoids a check/unlink race when two processes
  // concurrently recover a stale owner. Process death releases the lock.
  try { mutex.exec('BEGIN EXCLUSIVE'); }
  catch { mutex.close(); throw failure('companion_already_running'); }
  try {
    const previous = readPrivate(file, null);
    if (previous) {
      // New owners are proven absent by the kernel lock, even after PID reuse.
      // Only a legacy owner predating the mutex needs a conservative PID check.
      if (previous.lockVersion !== 1) {
        try { process.kill(previous.pid, 0); throw failure('companion_already_running'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      fs.rmSync(file);
      fs.rmSync(path.join(runtime, 'control.sock'), { force: true });
    }
    writePrivate(file, { pid: process.pid, token, lockVersion: 1, startedAt: new Date().toISOString() });
  } catch (error) { mutex.close(); throw error; }
  return () => {
    try {
      if (readPrivate(file, null)?.token === token) {
        fs.rmSync(path.join(runtime, 'control.sock'), { force: true }); fs.rmSync(file);
      }
    } finally { mutex.close(); }
  };
}
