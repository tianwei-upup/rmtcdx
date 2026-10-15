import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { desktopProjects } from '../src/projects.mjs';
import { CodexAdapter } from '../src/codex-adapter.mjs';
import { ProjectPins } from '../web/chat-state.mjs';

test('desktop discovery preserves logical projects sharing a directory and unavailable roots without writing Codex', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt-projects-')), file = path.join(dir, 'state.json');
  try {
    const state = { 'local-projects': { a: { name: 'A', rootPaths: [dir] }, b: { name: 'B', rootPaths: [dir] }, c: { name: 'Missing', rootPaths: [path.join(dir, 'gone')] } }, 'project-order': ['b', 'a', 'c'], 'thread-project-assignments': { t: { projectKind: 'local', projectId: 'b' } }, 'electron-saved-workspace-roots': ['/stale-deleted-project'] };
    const bytes = JSON.stringify(state); fs.writeFileSync(file, bytes);
    const values = desktopProjects(file); assert.deepEqual(values.map(p => p.id), ['b', 'a', 'c']);
    assert.deepEqual(values[0].threadIds, ['t']); assert.equal(values[2].available, false);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    state['local-projects'].d = { name: 'New', rootPaths: [dir] }; fs.writeFileSync(file, JSON.stringify(state));
    assert.equal(desktopProjects(file).length, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('session ownership respects explicit project assignment, worktrees and durable remote-created mappings', async () => {
  const root = fs.realpathSync(os.tmpdir());
  let projects = [{ id: 'a', name: 'A', path: root, threadIds: ['worktree'] }, { id: 'b', name: 'B', path: root, threadIds: ['assigned'] }];
  const threads = [{ id: 'assigned', cwd: root }, { id: 'unassigned', cwd: root }, { id: 'worktree', cwd: '/' }, { id: 'remote', cwd: root }];
  let reads = 0;
  class Native extends EventEmitter { async listThreads() { reads++; return [...threads, threads[0]]; } async readThread(id) { return threads.find(t => t.id === id); } }
  const adapter = new CodexAdapter(new Native(), () => projects, undefined, null, { remote: 'b' });
  const list = async projectId => (await adapter.execute('sessions.sync', { projectId }, 'job')).conversations.map(c => c.id);
  assert.deepEqual(await list('a'), ['unassigned', 'worktree']); assert.deepEqual(await list('b'), ['assigned', 'remote']);
  // Two projects share one cached catalog: a single active read plus a single
  // archived read, with repeated native pages deduplicated.
  assert.equal(reads, 4, 'project switches reuse one bounded native catalog (active + archived) and deduplicate repeated native pages');
  assert.equal((await adapter.owned('worktree')).project.id, 'a');
  projects = [...projects, { id: 'c', name: 'C', path: root }];
  assert.equal((await adapter.execute('projects.sync', {}, 'job')).projects.length, 3);
});

test('pins survive client recreation, stay per device and never reorder the source catalog', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const pins = new ProjectPins(storage), catalog = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  pins.toggle('mac', 'c'); pins.toggle('mac', 'b');
  assert.deepEqual(new ProjectPins(storage).order(catalog, 'mac').map(p => p.id), ['b', 'c', 'a']);
  assert.deepEqual(pins.order(catalog, 'windows'), catalog); assert.deepEqual(catalog.map(p => p.id), ['a', 'b', 'c']);
  pins.toggle('mac', 'b'); assert.deepEqual(pins.order(catalog, 'mac').map(p => p.id), ['c', 'a', 'b']);
  assert.deepEqual(pins.order([{ id: 'a' }], 'mac'), [{ id: 'a' }]);
  storage.setItem(pins.key('mac'), 'broken'); assert.deepEqual(pins.read('mac'), []);
});

test('one directory job groups all projects with a single native list read and bounded pages', async () => {
  const root = fs.realpathSync(os.tmpdir()); let reads = 0;
  class Native extends EventEmitter { async listThreads() { reads++; return [...Array.from({ length: 115 }, (_, n) => ({ id: 'thread-' + n, cwd: root, name: 'Chat ' + n })), { id: 'other', cwd: root }]; } }
  const adapter = new CodexAdapter(new Native(), [{ id: 'a', name: 'A', path: root }, { id: 'b', name: 'B', path: root, threadIds: ['other'] }]);
  const value = await adapter.execute('directory.sync', {}, 'batch');
  // One read for the active catalog plus one for archived sessions, which an
  // ordinary list omits; the drawer must not silently lose that history.
  assert.equal(reads, 2); assert.equal(value.projects.length, 2);
  assert.equal(value.directories[0].conversations.length, 100); assert(value.directories[0].nextCursor);
  assert.deepEqual(value.directories[1].conversations.map(c => c.id), ['other']);
});
