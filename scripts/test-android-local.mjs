import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { device: { type: 'string' }, config: { type: 'string' } } });
if (!values.device) throw new Error('Pass --device <adb serial>; no device is selected automatically');
const adb = process.env.ADB ?? (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb') : 'adb');
const serial = values.device;
if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(serial)) throw new Error('Invalid adb serial');
const run = args => execFileSync(adb, ['-s', serial, ...args], { cwd: root, encoding: 'utf8' });
const directory = path.join(root, '.runtime', `${serial}-local`);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const config = values.config ? JSON.parse(fs.readFileSync(path.resolve(values.config), 'utf8')) : null;
if (config && config.cloudUrl !== 'http://127.0.0.1:3220') throw new Error('This runner only tests the local loopback relay');
const testClass = config ? 'CloudSmokeTest' : 'RemoteSmokeTest';
let stoppedClient;
let transportError;
let handling = false;
let stopRequested = false;
let recoveryRequested = false;
const processFile = path.join(root, '.runtime/control-processes.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checkpoint = message => fs.appendFileSync(path.join(directory, 'transport.log'), `${new Date().toISOString()} ${message}\n`);

async function stopClient() {
  const entries = JSON.parse(fs.readFileSync(processFile, 'utf8'));
  const entry = entries.find(value => value.name === `${config.deviceId}-client`);
  const expected = path.join(root, 'control/src/client.mjs');
  if (!entry || entry.entry !== expected || !Number.isSafeInteger(entry.pid) || entry.pid <= 0) throw new Error('Unexpected local client metadata');
  if (process.platform === 'win32') throw new Error('Reconnect injection currently requires macOS/Linux');
  const command = execFileSync('ps', ['-p', String(entry.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  if (!command.endsWith(' ' + expected)) throw new Error('Client PID no longer matches; refusing to stop it');
  process.kill(entry.pid, 'SIGTERM');
  stoppedClient = entry;
  checkpoint('Stopped only the local device client; phone network and Codex bridge remain running');
}

async function restoreClient() {
  if (!stoppedClient) return;
  const configFile = path.join(root, `.runtime/${config.deviceId}-client.json`);
  const lock = path.join(root, `.runtime/${config.deviceId}-receipts.json.lock`);
  for (let i = 0; i < 50 && fs.existsSync(lock); i++) await sleep(100);
  if (fs.existsSync(lock)) throw new Error('Old receipt writer is still active');
  const stdout = fs.openSync(path.join(root, `.runtime/${config.deviceId}-client.stdout.log`), 'a');
  const stderr = fs.openSync(path.join(root, `.runtime/${config.deviceId}-client.stderr.log`), 'a');
  const child = spawn(process.execPath, [stoppedClient.entry], { cwd: root,
    env: { ...process.env, RMT_CLIENT_CONFIG: configFile }, detached: true, stdio: ['ignore', stdout, stderr] });
  fs.closeSync(stdout); fs.closeSync(stderr);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  const entries = JSON.parse(fs.readFileSync(processFile, 'utf8'));
  const entry = entries.find(value => value.name === stoppedClient.name);
  entry.pid = child.pid;
  fs.writeFileSync(processFile, JSON.stringify(entries, null, 2));
  stoppedClient = undefined;
  checkpoint('Restarted the same local client with its original credentials and receipts');
}

try {
  if (run(['get-state']).trim() !== 'device') throw new Error('Selected device is unavailable');
  run(['reverse', 'tcp:3220', 'tcp:3220']);
  for (const apk of ['debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk']) {
    console.log(run(['install', '-r', path.join(root, 'android/app/build/outputs/apk', apk)]).trim());
  }
  if (config) {
    run(['shell', 'run-as', 'com.liutw.codexremote', 'mkdir', '-p', 'files']);
    execFileSync(adb, ['-s', serial, 'shell', "run-as com.liutw.codexremote sh -c 'cat > files/cloud-test.json'"],
      { input: JSON.stringify(config), stdio: ['pipe', 'pipe', 'pipe'] });
    run(['shell', 'run-as', 'com.liutw.codexremote', 'chmod', '600', 'files/cloud-test.json']);
  }
  const logFile = path.join(directory, `${testClass}.log`);
  fs.writeFileSync(logFile, '');
  const child = spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'class',
    `com.liutw.codexremote.${testClass}`, 'com.liutw.codexremote.test/android.test.InstrumentationTestRunner']);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); fs.appendFileSync(logFile, chunk); process.stdout.write(chunk); });
  const timer = setInterval(async () => {
    if (handling || transportError || !config?.reconnectCheck) return;
    handling = true;
    try {
      if (!stopRequested && output.includes('READY_LOCAL_CLIENT_STOP')) { stopRequested = true; await stopClient(); }
      if (stopRequested && !recoveryRequested && output.includes('OFFLINE_OBSERVED')) { recoveryRequested = true; await restoreClient(); }
    } catch (error) { transportError = error; }
    finally { handling = false; }
  }, 250);
  const timeout = setTimeout(() => { child.kill('SIGTERM'); run(['shell', 'am', 'force-stop', 'com.liutw.codexremote']); }, 600_000);
  let exitCode;
  try { exitCode = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); }
  finally { clearInterval(timer); clearTimeout(timeout); while (handling) await sleep(100); }
  if (transportError) throw transportError;
  if (exitCode !== 0 || !/^OK \(\d+ tests?\)\s*$/m.test(output)) throw new Error(`Instrumentation failed; inspect ${logFile}`);
  if (config?.reconnectCheck && !recoveryRequested) throw new Error('Requested reconnect check was not exercised');
  if (config) run(['pull', '/sdcard/Android/data/com.liutw.codexremote/files/cloud-smoke.png', path.join(directory, 'cloud-smoke.png')]);
  fs.writeFileSync(path.join(directory, `${testClass}-result.json`), JSON.stringify({ result: 'PASS', serial, testClass,
    localOnly: true, reconnect: recoveryRequested, completedAt: new Date().toISOString() }, null, 2));
} finally {
  await restoreClient();
  if (config) run(['shell', 'run-as', 'com.liutw.codexremote', 'rm', '-f', 'files/cloud-test.json']);
}
