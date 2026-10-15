import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationState, nearBottom, safeLink, mergeConversations } from '../web/chat-state.mjs';
import { BusinessClient } from '../web/business-client.mjs';
const event = (type, extra = {}) => ({ eventId: crypto.randomUUID(), conversationId: 'conversation', turnId: 'turn', type, ...extra });
test('optimistic send and early finish never resurrect a completed turn or duplicate SSE deltas', () => {
  const state = new ConversationState('conversation'); state.optimistic('hello');
  state.event(event('turn.started')); const delta = event('assistant.delta', { text: 'answer' });
  state.event(delta); state.event(delta); state.event(event('turn.finished', { status: 'completed' }));
  state.accepted('turn');
  assert.equal(state.status, 'completed'); assert.equal(state.turnId, null);
  assert.deepEqual(state.messages.map(m => m.text), ['hello', 'answer']); assert.equal(state.sending, false);
  assert.equal(state.event(event('assistant.delta', { text: 'late' })), true);
  assert.equal(state.messages.at(-1).text, 'answer');
});
test('stale snapshots cannot replace live output; older pages prepend without duplicates and retain drafts', () => {
  const state = new ConversationState('conversation'); state.draft = 'unsent';
  const revision = state.revision; state.event(event('assistant.delta', { text: 'streaming' }));
  const value = { conversation: { title: 'Chat', status: 'idle' }, messages: [{ id: 'one', role: 'user', text: 'old' }], nextCursor: null, approvals: [] };
  assert.equal(state.snapshot(value, false, revision), false); assert.equal(state.messages[0].text, 'streaming');
  state.snapshot(value); state.snapshot({ ...value, messages: [{ id: 'zero', role: 'user', text: 'earlier' }, value.messages[0]] }, true);
  assert.deepEqual(state.messages.map(m => m.id), ['zero', 'one']); assert.equal(state.draft, 'unsent');
  assert.equal(nearBottom(200, 1000, 400), false); assert.equal(nearBottom(550, 1000, 400), true);
  assert.equal(safeLink('javascript:alert(1)'), null); assert.equal(safeLink('file:///private'), null);
});
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values }; };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
test('lost write acknowledgement retains intent across login failure and never creates a second identity', async () => {
  const saved = storage(), ids = []; let mode = 'network';
  const client = new BusinessClient({ storage: saved, sleep: async () => {}, fetcher: async (route, options) => {
    if (route === '/turns') { ids.push(JSON.parse(options.body).clientIntentId); if (mode === 'network') throw new Error('network'); if (mode === 'login') return response({ code: 'login_required' }, 401); return response({ id: 'job' }); }
    return response({ state: 'succeeded', resultAvailable: true, result: { turnId: 'turn' } });
  } });
  await assert.rejects(client.job('/turns', { text: 'PRIVATE' }, { writing: true }), e => e.uncertain);
  mode = 'login'; await assert.rejects(client.job('/turns', { text: 'PRIVATE' }, { writing: true }), e => e.uncertain);
  mode = 'online'; assert.equal((await client.job('/turns', { text: 'PRIVATE' }, { writing: true })).turnId, 'turn');
  assert.equal(new Set(ids).size, 1); assert.equal(saved.values.size, 0);
});
test('intent storage contains hashes instead of prompts or image bodies, and definitive offline rejection releases it', async () => {
  const saved = storage(); const client = new BusinessClient({ storage: saved, fetcher: async () => { throw new Error('network'); } });
  await assert.rejects(client.job('/images', { base64: 'PRIVATE_IMAGE', text: 'PRIVATE_PROMPT' }, { writing: true }));
  assert(!JSON.stringify([...saved.values]).includes('PRIVATE_'));
  client.fetcher = async () => response({ code: 'device_offline' }, 409);
  await assert.rejects(client.job('/images', { base64: 'PRIVATE_IMAGE', text: 'PRIVATE_PROMPT' }, { writing: true }));
  assert.equal(saved.values.size, 0);
});

test('a delayed native snapshot cannot resurrect a turn already interrupted by the user', () => {
 const state = new ConversationState('conversation'); state.event(event('turn.started'));
 state.event(event('turn.finished', { status: 'interrupted' }));
 state.snapshot({ conversation: { title: 'Chat', status: 'running' }, activeTurnId: 'turn', messages: [], nextCursor: null, approvals: [] });
 assert.equal(state.turnId, null); assert.equal(state.status, 'interrupted');
});

test('recently created conversations stay in the drawer while the native index catches up', () => {
 const created = { id: 'new', title: '新对话', projectId: 'allowed', status: 'running' };
 const remote = [{ id: 'old', title: '旧对话', projectId: 'allowed' }];
 assert.deepEqual(mergeConversations(remote, [created], 'allowed').map(c => c.id), ['new', 'old']);
 assert.equal(mergeConversations(remote, [created], 'different').length, 1);
 assert.equal(mergeConversations(remote, [created], 'allowed', '没有匹配').length, 1);
 assert.equal(mergeConversations([created], [created], 'allowed').length, 1);
});
