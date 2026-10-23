import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Read only the desktop's project metadata. Never write its ordering or pins.
export function desktopProjects(file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.codex-global-state.json'), extras = []) {
  return desktopProjectsFromState(JSON.parse(fs.readFileSync(file, 'utf8')), extras);
}
export function desktopProjectsFromState(state, extras = []) {
  const records = state['local-projects'] ?? {};
  if (typeof records !== 'object' || Array.isArray(records)) throw new Error('desktop_projects_unavailable');
  const order = [...new Set([...(state['project-order'] ?? []), ...Object.keys(records)])];
  const assignments = state['thread-project-assignments'] ?? {};
  const canonical = root => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } };
  const projects = order.filter(id => Object.hasOwn(records, id)).map(id => {
    const record = records[id];
    const paths = [...new Set((record.rootPaths ?? []).filter(p => typeof p === 'string' && path.isAbsolute(p)).map(canonical))];
    if (!paths.length) return null;
    const primary = paths.find(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    return { id, name: String(record.name || path.basename(paths[0])).slice(0, 100), path: primary ?? paths[0], paths,
      available: Boolean(primary),
      threadIds: Object.entries(assignments).filter(([, a]) => a?.projectKind === 'local' && a.projectId === id).map(([threadId]) => threadId) };
  }).filter(Boolean);
  // Older desktops only know workspace roots. Preserve those without duplicating named projects.
  for (const root of state['local-projects'] ? [] : state['electron-saved-workspace-roots'] ?? []) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
    const resolved = canonical(root); if (projects.some(p => p.paths.includes(resolved))) continue;
    projects.push({ id: 'root-' + crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 32), name: String(state['electron-workspace-root-labels']?.[root] || path.basename(root)).slice(0, 100), path: resolved, paths: [resolved], available: fs.existsSync(resolved), threadIds: [] });
  }
  return [...projects, ...extras];
}
