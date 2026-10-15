import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { CodexAdapter } from '../src/codex-adapter.mjs';

test('direct adapter enforces local cwd, read-only execution and domain-only event projections', async () => {
  class Native extends EventEmitter {
    async readThread(id) { return { id, cwd: id === 'foreign' ? '/' : os.tmpdir(), status: { type: 'idle' }, turns: [{ items: [{ id: 'native:message', type: 'agentMessage', text: 'response' }] }] }; }
    listPendingRequests() { return []; }
    async createThread() { return { threadId: 'owned' }; }
    async startRun(params) { this.params = params; return { turnId: 'turn-one' }; }
  }
  const native = new Native(), events = [];
  const adapter = new CodexAdapter(native, [{ id: 'fixture', name: 'Fixture', path: os.tmpdir() }], event => events.push(event));
  assert.equal((await adapter.execute('conversation.create', { projectId: 'fixture' }, 'job')).conversation.id, 'owned');
  await assert.rejects(adapter.execute('turn.start', { conversationId: 'foreign', text: 'x', attachmentIds: [] }, 'job'), /precondition_rejected/);
  await adapter.execute('turn.start', { conversationId: 'owned', text: 'safe', attachmentIds: [] }, 'job');
  assert.equal(native.params.codex.sandbox, 'read-only');
  native.emit('event', { type: 'item.delta', kind: 'commandExecution.output', turnId: 'turn-one', delta: 'PRIVATE COMMAND' });
  native.emit('event', { type: 'item.delta', kind: 'agentMessage.text', turnId: 'turn-one', delta: 'answer' });
  assert.deepEqual(events.map(e => e.type), ['turn.started', 'assistant.delta']);
  assert(!JSON.stringify(events).includes('PRIVATE COMMAND'));
  const snapshot = await adapter.execute('conversation.snapshot', { conversationId: 'owned' }, 'read');
  assert.equal(snapshot.messages[0].text, 'response');
  assert.match(snapshot.messages[0].id, /^[a-f0-9]+$/);
});

test('new unmaterialized thread snapshots return empty history only for locally created threads', async () => {
  class Native extends EventEmitter {
    async createThread() { return { threadId: 'new-thread' }; }
    async readThread(id, options) { if (options.includeTurns) throw new Error('list_turns is not supported yet'); return { id, cwd: os.tmpdir(), status: { type: 'idle' } }; }
    listPendingRequests() { return []; }
  }
  const adapter = new CodexAdapter(new Native(), [{ id: 'fixture', name: 'Fixture', path: os.tmpdir() }]);
  await adapter.execute('conversation.create', { projectId: 'fixture' }, 'create');
  assert.deepEqual((await adapter.execute('conversation.snapshot', { conversationId: 'new-thread' }, 'snapshot')).messages, []);
  await assert.rejects(adapter.execute('conversation.snapshot', { conversationId: 'existing-thread' }, 'snapshot'), /list_turns/);
});

test('conversation snapshots start at newest messages and page backwards in chronological order', async () => {
  class Native extends EventEmitter {
    async readThread(id) { return { id, cwd: os.tmpdir(), status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: Array.from({ length: 65 }, (_, n) => ({ id: 'item-' + n, type: 'agentMessage', text: 'message-' + n })) }] }; }
    listPendingRequests() { return []; }
  }
  const adapter = new CodexAdapter(new Native(), [{ id: 'fixture', name: 'Fixture', path: os.tmpdir() }]);
  const latest = await adapter.execute('conversation.snapshot', { conversationId: 'thread', pageSize: 30 }, 'job');
  assert.equal(latest.messages[0].text, 'message-35'); assert.equal(latest.messages.at(-1).text, 'message-64');
  const older = await adapter.execute('conversation.snapshot', { conversationId: 'thread', pageSize: 30, cursor: latest.nextCursor }, 'job');
  assert.equal(older.messages[0].text, 'message-5'); assert.equal(older.messages.at(-1).text, 'message-34');
});

test('snapshot projection keeps commands, patches, tool calls and reasoning with provenance labels', async () => {
  class Native extends EventEmitter {
    async readThread(id) {
      return { id, cwd: os.tmpdir(), status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [
        { id: 'i1', type: 'userMessage', content: [{ type: 'text', text: 'do the thing' }] },
        { id: 'i2', type: 'reasoning', summary: ['Checked the parser'], content: ['Parser stability matters.'] },
        { id: 'i3', type: 'agentMessage', text: 'done' },
        { id: 'i4', type: 'commandExecution', command: 'npm test', aggregatedOutput: '12 tests passed', exitCode: 0 },
        { id: 'i5', type: 'fileChange', changes: [{ path: 'src/a.ts', kind: { type: 'update' } }] },
        { id: 'i6', type: 'mcpToolCall', server: 'linear', tool: 'list_issues', status: 'completed' },
        { id: 'i7', type: 'webSearch', query: 'codex compatibility' },
        { id: 'i8', type: 'plan', text: '1. extract\n2. test' },
        { id: 'i9', type: 'imageView', path: '/Users/someone/private/screenshot.png' }
      ] }] };
    }
    listPendingRequests() { return []; }
    async listThreads() { return []; }
  }
  const adapter = new CodexAdapter(new Native(), [{ id: 'fixture', name: 'Fixture', path: os.tmpdir() }]);
  const snapshot = await adapter.execute('conversation.snapshot', { conversationId: 'thread', pageSize: 100 }, 'job');
  const kinds = snapshot.messages.map(message => message.kind);
  assert.deepEqual(kinds, ['text', 'reasoning', 'text', 'command', 'fileChange', 'mcpToolCall', 'webSearch', 'plan']);
  assert.equal(snapshot.messages[0].role, 'user');
  assert.match(snapshot.messages[3].text, /\$ npm test/);
  assert.match(snapshot.messages[3].text, /12 tests passed/);
  assert.match(snapshot.messages[4].text, /update src\/a\.ts/);
  // A local path must never leak into the projection.
  assert.equal(JSON.stringify(snapshot).includes('private/screenshot.png'), false);
});

test('directory listing includes archived sessions that an ordinary list omits', async () => {
  const root = os.tmpdir();
  class Native extends EventEmitter {
    async listThreads(params) {
      return params?.archived
        ? [{ id: 'archived-thread', cwd: root, name: 'Old chat' }]
        : [{ id: 'live-thread', cwd: root, name: 'Live chat' }];
    }
    listPendingRequests() { return []; }
  }
  const adapter = new CodexAdapter(new Native(), [{ id: 'fixture', name: 'Fixture', path: root }]);
  const directory = await adapter.execute('directory.sync', {}, 'job');
  assert.deepEqual(directory.directories[0].conversations.map(c => c.id), ['live-thread', 'archived-thread']);
  // An explicit archived query returns only archived sessions.
  const archived = await adapter.execute('sessions.sync', { projectId: 'fixture', archived: true }, 'job');
  assert.deepEqual(archived.conversations.map(c => c.id), ['archived-thread']);
});
