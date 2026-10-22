import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of ['src', 'web']) for (const file of fs.readdirSync(path.join(root, dir))) if (/\.(mjs|js)$/.test(file)) execFileSync(process.execPath, ['--check', path.join(root, dir, file)], { stdio: 'inherit' });
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
for (const file of ['index.html', 'style.css', 'app.js', 'chat-state.mjs', 'markdown.mjs', 'business-client.mjs', 'queue.html', 'queue.css', 'queue-app.js', 'queue-state.mjs','queue-live.mjs','catalog-live.mjs','desktop-live.mjs','desktop-history.mjs','desktop-merge.mjs']) fs.copyFileSync(path.join(root, 'web', file), path.join(root, 'dist', file));
console.log('Business service, worker and browser scripts checked; static assets built.');

const icons = ['sidebar-simple', 'caret-down', 'note-pencil', 'dots-three-vertical', 'plus', 'x', 'arrow-up', 'arrow-down', 'stop', 'magnifying-glass', 'gear', 'copy', 'arrow-clockwise', 'push-pin'];
fs.mkdirSync(path.join(root, 'dist/icons'), { recursive: true });
for (const icon of icons) { const source = path.join(root, 'node_modules/@phosphor-icons/core/assets/regular', icon + '.svg'); const target = path.join(root, 'dist/icons', icon + '.svg'); if (fs.existsSync(source)) fs.copyFileSync(source, target); else fs.accessSync(target); }
const license = path.join(root, 'node_modules/@phosphor-icons/core/LICENSE'); if (fs.existsSync(license)) fs.copyFileSync(license, path.join(root, 'dist/icons/LICENSE.txt')); else fs.accessSync(path.join(root, 'dist/icons/LICENSE.txt'));
