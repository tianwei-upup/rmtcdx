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
