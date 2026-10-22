// Filesystem metadata only. Never connect, start a daemon, or read credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function inspectExecutorSocket(advertised, { uid = process.getuid(), physicalRoot } = {}) {
  const unavailable = reason => ({ attachable: false, reason });
  if (!path.isAbsolute(advertised) || !physicalRoot || !path.isAbsolute(physicalRoot)) return unavailable('invalid_socket_path');
  try {
    const parent = path.dirname(advertised), parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.uid !== uid || (parentStat.mode & 0o077) !== 0) return unavailable('unsafe_advertised_parent');
    // Ancestors may legitimately contain symlinks: on macOS /tmp itself is a
    // symlink to /private/tmp. Resolve the parent once and use that canonical
    // form for both the alias and the physical target. Rejecting every
    // symlinked ancestor would make any endpoint under /tmp unattachable, and a
    // genuinely redirected parent still fails the ownership, permission and
    // alias checks below.
    const realParent = fs.realpathSync(parent);
    const canonical = path.join(realParent, path.basename(advertised));
    const stat = fs.lstatSync(advertised);
    let physical = advertised;
    if (stat.isSymbolicLink()) {
      const shared = fs.lstatSync(physicalRoot);
      if (!shared.isDirectory() || shared.uid !== uid || (shared.mode & 0o777) !== 0o700 || fs.realpathSync(physicalRoot) !== physicalRoot) return unavailable('unsafe_physical_parent');
      // The alias is keyed on the canonical advertised path, not the literal
      // string, so both the alias and the resolved physical path come from it.
      const expected = path.join(physicalRoot, crypto.createHash('sha256').update(canonical).digest('hex'));
      if (fs.readlinkSync(advertised) !== expected) return unavailable('unexpected_socket_alias');
      physical = expected;
    }
    const target = fs.lstatSync(physical);
    if (!target.isSocket() || target.uid !== uid || (target.mode & 0o077) !== 0) return unavailable('unsafe_socket');
    return { attachable: true, reason: 'metadata_checks_only', advertised, physical };
  } catch (error) {
    return unavailable(error.code === 'ENOENT' ? 'socket_missing' : 'socket_inspection_failed');
  }
}
