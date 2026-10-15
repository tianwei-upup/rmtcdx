import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class JsonStore {
  constructor(file, initial) {
    this.file = path.resolve(file); this.lock = this.file + '.lock';
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try { this.fd = fs.openSync(this.lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(this.lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid state lock');
      try { process.kill(pid, 0); throw new Error('State already in use'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      fs.unlinkSync(this.lock); this.fd = fs.openSync(this.lock, 'wx', 0o600);
    }
    fs.writeFileSync(this.fd, String(process.pid));
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') { this.close(); throw error; } this.data = initial; }
  }
  save() {
    const value = JSON.stringify(this.data);
    if (Buffer.byteLength(value) > 32 * 1024 * 1024) throw new Error('Metadata capacity reached');
    const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
  }
  close() { if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; fs.unlinkSync(this.lock); } }
}
