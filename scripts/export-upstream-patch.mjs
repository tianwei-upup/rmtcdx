import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, 'services/rmtcdx');
let patch = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: upstream, encoding: 'utf8' });
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: upstream, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
for (const file of untracked) {
  if (!/^apps\/(bridge|web)\/(src|test)\/[A-Za-z0-9_./-]+\.(ts|tsx)$/.test(file)) throw new Error(`Unreviewed new upstream file: ${file}`);
  const content = fs.readFileSync(path.join(upstream, file), 'utf8').replace(/\r\n/g, '\n');
  const lines = content.replace(/\n$/, '').split('\n');
  patch += `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`;
  if (!content.endsWith('\n')) patch += '\\ No newline at end of file\n';
}
const destination = path.join(root, 'patches/remote-control.patch');
fs.writeFileSync(destination, patch);
console.log(`Exported ${untracked.length} new files and tracked changes to patches/remote-control.patch`);
