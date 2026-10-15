import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpServer } from '../src/mcp.mjs';

test('SDK initialize/list/call enforce controller metadata and tool schema', async t => {
  let calls = 0;
  const service = { scope: { callerThreadId: 'controller' }, execute: async request => { calls++; return { operation: request.operation, ready: true }; } };
  const server = createMcpServer(service), client = new Client({ name: 'acceptance', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(a); await client.connect(b);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 11);
  assert.match(client.getInstructions(), /dedicated test chats/);
  const denied = await client.callTool({ name: 'companion_status', arguments: {} }); assert.equal(denied.isError, true); assert.equal(calls, 0);
  const allowed = await client.callTool({ name: 'companion_status', arguments: {}, _meta: { 'x-codex-turn-metadata': { thread_id: 'controller', turn_id: 'actual-turn' } } });
  assert.equal(allowed.structuredContent.ready, true); assert.equal(calls, 1);
  const malformed = await client.callTool({ name: 'companion_send_test', arguments: { threadId: '../../other', text: 'x', intentId: 'one' }, _meta: { 'x-codex-turn-metadata': { thread_id: 'controller' } } });
  assert.equal(malformed.isError, true); assert.equal(calls, 1);
  const sessionId = '12345678-1234-4234-8234-123456789abc';
  const deniedPull = await client.callTool({ name: 'companion_inbox_take', arguments: { sessionId, waitMs: 0 } });
  assert.equal(deniedPull.isError, true); assert.equal(calls, 1);
  const missingTurn = await client.callTool({ name: 'companion_inbox_take', arguments: { sessionId, waitMs: 0 }, _meta: { 'x-codex-turn-metadata': { thread_id: 'controller' } } });
  assert.equal(missingTurn.isError, true); assert.equal(calls, 1);
  const pulled = await client.callTool({ name: 'companion_inbox_take', arguments: { sessionId, waitMs: 0 }, _meta: { 'x-codex-turn-metadata': { thread_id: 'controller', turn_id: 'actual-turn' } } });
  assert.equal(pulled.structuredContent.operation, 'inbox_take'); assert.equal(calls, 2);
});
