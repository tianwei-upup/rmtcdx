import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..'), source = path.join(root, 'services/rmtcdx');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rmtagt-patch-'));
try {
  const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: source, maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', temporary], { input: archive });
  const patch = fs.readFileSync(path.join(root, 'patches/remote-control.patch'));
  execFileSync('git', ['apply', '--check', '-'], { cwd: temporary, input: patch });
  execFileSync('git', ['apply', '-'], { cwd: temporary, input: patch });
  const changed = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: source, encoding: 'utf8' });
  const added = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: source, encoding: 'utf8' });
  const files = [...new Set((changed + '\n' + added).trim().split('\n').filter(Boolean))];
  for (const file of files) assert.deepEqual(fs.readFileSync(path.join(source, file)), fs.readFileSync(path.join(temporary, file)), file);
  console.log(JSON.stringify({ ok: true, replayedFiles: files.length }));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
