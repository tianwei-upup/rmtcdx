import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBusinessServer } from '../src/server.mjs';

const password = 'test-password-more-than-24-characters';

// A redeploy restarts the service, so a phone that already logged in must not
// be pushed back to the login screen.
test('a login session survives a service restart and the state file keeps only the digest', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt-session-'));
  const stateFile = path.join(directory, 'state.json');
  const origin = 'http://127.0.0.1:3230';
  try {
    const first = await createBusinessServer({ origin, password, stateFile });
    const firstAddress = await first.listen(0);
    const login = await fetch(`http://127.0.0.1:${firstAddress.port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ username: 'admin', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const token = cookie.slice(cookie.indexOf('=') + 1);
    assert.equal((await fetch(`http://127.0.0.1:${firstAddress.port}/api/devices`, { headers: { cookie } })).status, 200);
    await first.close();

    // The state file must not carry the token itself.
    const persisted = fs.readFileSync(stateFile, 'utf8');
    assert.equal(persisted.includes(token), false, 'the raw token must never be written to the state file');
    const stored = JSON.parse(persisted).sessions;
    assert.equal(Object.keys(stored).length, 1);
    assert.match(Object.keys(stored)[0], /^[0-9a-f]{64}$/);

    const second = await createBusinessServer({ origin, password, stateFile });
    try {
      const secondAddress = await second.listen(0);
      assert.equal((await fetch(`http://127.0.0.1:${secondAddress.port}/api/devices`, { headers: { cookie } })).status, 200,
        'the session must still authenticate after the restart');
      assert.equal((await fetch(`http://127.0.0.1:${secondAddress.port}/api/devices`, { headers: { cookie: 'rmt-business=not-a-session' } })).status, 401);
    } finally { await second.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an expired session is not restored from the state file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rmt-session-'));
  const stateFile = path.join(directory, 'state.json');
  const origin = 'http://127.0.0.1:3230';
  try {
    const first = await createBusinessServer({ origin, password, stateFile });
    const firstAddress = await first.listen(0);
    const login = await fetch(`http://127.0.0.1:${firstAddress.port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ username: 'admin', password }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await first.close();

    // Age the stored session past its expiry before the restart.
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const key of Object.keys(state.sessions)) state.sessions[key].expires = Date.now() - 1000;
    fs.writeFileSync(stateFile, JSON.stringify(state));

    const second = await createBusinessServer({ origin, password, stateFile });
    try {
      const secondAddress = await second.listen(0);
      assert.equal((await fetch(`http://127.0.0.1:${secondAddress.port}/api/devices`, { headers: { cookie } })).status, 401,
        'an expired session must not authenticate after the restart');
    } finally { await second.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
