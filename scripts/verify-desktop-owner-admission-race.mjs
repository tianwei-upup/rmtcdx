// Executes the installed owner's start function in an isolated VM with a fake
// transport. Never imports the app, connects to its runtime, or changes a chat.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

function readAsarEntry(archive, name) {
  const fd = fs.openSync(archive, 'r');
  try {
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12)); fs.readSync(fd, header, 0, header.length, 16);
    let entry = JSON.parse(header.toString());
    for (const part of name.split('/')) entry = entry.files[part];
    assert.equal(entry.unpacked, undefined, 'source must be in the signed archive');
    const data = Buffer.alloc(entry.size);
    fs.readSync(fd, data, 0, data.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
    return data.toString('utf8');
  } finally { fs.closeSync(fd); }
}
const sourceEntry = 'webview/assets/app-shared-8340f229c2b3.js';
const bundle = readAsarEntry('/Applications/ChatGPT.app/Contents/Resources/app.asar', sourceEntry);
const begin = bundle.indexOf('async function Uun('), end = bundle.indexOf('function Wun(', begin);
assert.ok(begin >= 0 && end > begin, 'unsupported installed owner source');
const source = bundle.slice(begin, end);
assert.equal(source.match(/App context must wait until the current turn finishes/g)?.length, 2);
assert.ok(source.includes('await e.sendRequest(`thread/inject_items`'));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const latest = s => s.turns.at(-1);

function fixture({ busy = false, race = false } = {}) {
  const events = [], injectEntered = defer(), releaseInject = defer(), prepareEntered = defer(), releasePrepare = defer();
  const state = { id: 'test', cwd: '/dedicated-test', mode: 'default', turns: [], latestThreadSettings: {}, latestCollaborationMode: { settings: {} }, threadRuntimeStatus: { type: busy ? 'active' : 'idle' } };
  let serverActive = busy ? 'existing-turn' : null;
  if (busy) state.turns.push({ turnId: serverActive, status: 'inProgress', params: {}, items: [] });
  const manager = {
    getConversation: () => state, getHostId: () => 'local', getConversationCwd: () => state.cwd,
    getStreamRole: () => ({ role: 'owner' }), isConversationStreaming: () => true,
    waitForPendingThreadSettingsUpdate: async () => {},
    updateConversationState: (_, update) => update(state),
    requestClient: { getAppServerVersion: () => 'installed' }, logger: { error() {}, warning() {} },
    getThreadWorkspaceState: () => null,
    async sendRequest(method, params) {
      if (method === 'thread/inject_items') {
        events.push({ method, intent: 'remote' }); injectEntered.resolve();
        if (race) await releaseInject.promise;
        return {};
      }
      assert.equal(method, 'turn/start');
      const action = serverActive ? 'steer' : 'start';
      serverActive ??= `turn-${params.clientUserMessageId}`;
      events.push({ method, intent: params.clientUserMessageId, action, turnId: serverActive });
      return { turn: { id: serverActive, status: 'inProgress' } };
    }
  };
  const context = {
    _V: async () => undefined,
    BB: s => { if (s.unconfirmedTurnSubmissions?.length) throw Error('unconfirmed'); },
    Pun: (_, threadId, operation, intent) => ({
      request: { ...operation.request, clientUserMessageId: intent },
      async prepare() {
        if (race && intent === 'desktop') { prepareEntered.resolve(); await releasePrepare.promise; }
        return { request: { ...operation.request, clientUserMessageId: intent }, params: { ...operation.request, clientUserMessageId: intent }, workspaceCommit: {} };
      }, didStart: async () => {}
    }),
    jln: () => false, Mln: () => false, DM: () => false,
    _z: latest, oB: (s, turn) => s.turns.push(turn),
    zun: (s, intent, turnId) => (turnId == null ? null : s.turns.find(t => t.turnId === turnId)) ?? s.turns.find(t => t.turnId == null && t.params.clientUserMessageId === intent),
    sh: (s, turn) => { s.turns = s.turns.filter(t => t !== turn); },
    HB() {}, VB() {}, RNt: request => request, az: 30000,
    cz: class extends Error {}, lz: class extends Error {}, Date, Promise, Error,
  };
  const start = vm.runInNewContext(`(${source})`, context, { timeout: 1000 });
  const run = (intent, extraContext = {}) => start({
    manager, conversationId: 'test', operation: { request: { threadId: 'test', input: [{ type: 'text', text: `isolated-${intent}` }] }, context: extraContext },
    capabilities: {}, clientUserMessageId: intent, createId: () => crypto.randomUUID(), ownerWindowError: 'not-owner',
  }, { cancel() {}, dispatched() {}, accepted() {} });
  return { run, state, events, injectEntered, releaseInject, prepareEntered, releasePrepare };
}
const extraContext = { responseItems: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Isolated admission analysis.' }] }] };
const busy = fixture({ busy: true });
await assert.rejects(busy.run('remote', extraContext), /App context must wait until the current turn finishes/);
assert.equal(busy.events.length, 0);
const idle = fixture(); await idle.run('remote', extraContext);
assert.equal(idle.events.at(-1).action, 'start');

// A desktop start already preparing can complete while remote context injection
// is awaiting transport. Both calls execute the exact installed owner function.
const race = fixture({ race: true });
const desktop = race.run('desktop'); await race.prepareEntered.promise;
const remote = race.run('remote', extraContext); await race.injectEntered.promise;
race.releasePrepare.resolve(); await desktop;
race.releaseInject.resolve(); await remote;
assert.equal(race.events.at(-1).intent, 'remote');
assert.equal(race.events.at(-1).action, 'steer');
const report = {
  recordedAt: new Date().toISOString(), sourceEntry,
  bundleSha256: crypto.createHash('sha256').update(bundle).digest('hex'),
  functionSha256: crypto.createHash('sha256').update(source).digest('hex'),
  kind: 'installed_source_isolated_vm', liveDesktopMutations: 0,
  busyRejectedBeforeDispatch: true, idleStarted: true,
  atomicAdmissionPassed: false, counterexample: race.events,
  limitation: 'Fake app-server transport models the previously measured turn/start start-or-steer behavior; this is not a live desktop race test.'
};
const destination = path.resolve('.runtime/desktop-companion-mcp/owner-context-race.json');
fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
fs.writeFileSync(destination, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
