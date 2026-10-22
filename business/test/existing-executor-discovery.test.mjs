import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectExecutorSocket } from '../src/existing-executor-discovery.mjs';

test('socket discovery is passive and rejects missing, regular, public and unexpected alias paths', async () => {
  // Darwin UDS paths are short; the platform temp directory may exceed that limit.
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'rmt-d-'));
  const dir = path.join(root, 'control'), physicalRoot = path.join(root, 'physical');
  for (const p of [dir, physicalRoot]) fs.mkdirSync(p, { mode: 0o700 });
  const advertised = path.join(dir, 'rpc.sock');
  const options = { physicalRoot };
  let connects = 0;
  const server = net.createServer(() => { connects++; });
  try {
    assert.equal(inspectExecutorSocket(advertised, options).reason, 'socket_missing');
    assert.equal(fs.existsSync(advertised), false);
    fs.writeFileSync(advertised, 'not a socket');
    assert.equal(inspectExecutorSocket(advertised, options).reason, 'unsafe_socket');
    fs.unlinkSync(advertised);
    const physical = path.join(physicalRoot, crypto.createHash('sha256').update(advertised).digest('hex'));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(physical, resolve); });
    fs.chmodSync(physical, 0o600); fs.symlinkSync(physical, advertised);
    assert.equal(inspectExecutorSocket(advertised, options).attachable, true);
    fs.chmodSync(physical, 0o666);
    assert.equal(inspectExecutorSocket(advertised, options).reason, 'unsafe_socket'); fs.chmodSync(physical, 0o600);
    fs.chmodSync(dir, 0o777);
    assert.equal(inspectExecutorSocket(advertised, options).reason, 'unsafe_advertised_parent'); fs.chmodSync(dir, 0o700);
    fs.unlinkSync(advertised); fs.symlinkSync(path.join(root, 'other'), advertised);
    assert.equal(inspectExecutorSocket(advertised, options).reason, 'unexpected_socket_alias');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(connects, 0);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a symlinked advertised parent resolves the alias from the canonical path', async () => {
  // Build an explicit symlinked parent so the fixture does not rely on the
  // platform making /tmp a symlink, which only macOS does.
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'rmt-alias-'));
  const realRoot = fs.realpathSync(root);
  const linkRoot = path.join(path.dirname(realRoot), path.basename(realRoot) + '-link');
  fs.symlinkSync(realRoot, linkRoot);
  const realDir = path.join(realRoot, 'control');
  const physicalRoot = path.join(realRoot, 'physical');
  for (const p of [realDir, physicalRoot]) fs.mkdirSync(p, { mode: 0o700 });
  // Address the directory through the symlinked prefix, not the canonical one.
  const advertised = path.join(linkRoot, 'control', 'rpc.sock');
  const canonical = path.join(realDir, 'rpc.sock');
  assert.notEqual(path.dirname(advertised), path.dirname(canonical), 'fixture must exercise a symlinked parent');

  const options = { physicalRoot };
  const server = net.createServer(() => {});
  const aliasFor = value => path.join(physicalRoot, crypto.createHash('sha256').update(value).digest('hex'));
  const canonicalPhysical = aliasFor(canonical);
  const literalPhysical = aliasFor(advertised);
  try {
    fs.writeFileSync(literalPhysical, '');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(canonicalPhysical, resolve); });
    fs.chmodSync(canonicalPhysical, 0o600);

    // An alias derived from the literal path must be rejected.
    fs.symlinkSync(literalPhysical, advertised);
    assert.equal(inspectExecutorSocket(advertised, options).reason, 'unexpected_socket_alias');
    fs.unlinkSync(advertised);

    // An alias derived from the canonical path is the genuine one and must be accepted.
    fs.symlinkSync(canonicalPhysical, advertised);
    const result = inspectExecutorSocket(advertised, options);
    assert.equal(result.attachable, true, `expected attachable, got ${result.reason}`);
    assert.equal(result.physical, canonicalPhysical);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(linkRoot, { force: true });
  }
});
