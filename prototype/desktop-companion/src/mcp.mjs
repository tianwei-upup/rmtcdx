import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function createMcpServer(service) {
  const server = new McpServer({ name: 'rmtcdx-companion', version: '0.4.0' }, {
    instructions: 'Only user-authorized dedicated test chats are enabled. Never retry an unknown send with a new intent ID. A busy/unknown thread stays blocked until its original turn is resolved. Production project access remains disabled until desktop admission and restart acceptance pass.',
    maxToolInputElements: 100
  });
  const tool = (name, description, inputSchema, operation, readOnlyHint) => server.registerTool(name, {
    description, inputSchema, annotations: { readOnlyHint, destructiveHint: false, idempotentHint: !['send', 'inbox_open', 'inbox_take'].includes(operation), openWorldHint: false }
  }, async (args, extra) => {
    try {
      const metadata = extra._meta?.['x-codex-turn-metadata'];
      const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
      const caller = parsed?.thread_id ?? extra._meta?.['openai/threadId'];
      if (caller !== service.scope.callerThreadId) return { isError: true, content: [{ type: 'text', text: 'caller_scope_mismatch: use the dedicated controller chat.' }] };
      if (operation.startsWith('inbox_') && (typeof parsed?.turn_id !== 'string' || !parsed.turn_id.trim())) return { isError: true, content: [{ type: 'text', text: 'caller_turn_required: inbox leases must bind to the actual desktop turn.' }] };
      const value = await service.execute({ ...args, operation, consumerTurnId: parsed?.turn_id ?? null, signal: extra.signal });
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: `${error.code ?? 'operation_failed'}: inspect companion_status; do not resend an unknown intent.` }] }; }
  });
  tool('companion_status', 'Get service readiness, test scope, durable turn holds and production gate.', {}, 'status', true);
  tool('companion_snapshot', 'Read one page of an allowed dedicated test chat. Follow page.nextCursor when hasMore is true.', { threadId: z.string().uuid(), cursor: z.string().max(4000).optional() }, 'snapshot', true);
  tool('companion_receipt', 'Inspect a persistent intent receipt without sending or retrying a message.', { threadId: z.string().uuid(), intentId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/) }, 'receipt', true);
  tool('companion_reconnect', 'Reconnect the existing desktop native pipe and reconcile acknowledged turns; never resend writes.', {}, 'reconnect', false);
  tool('companion_send_test', 'Send to an allowed idle test chat at most once per intent. Reject busy chats; holds span the full turn. Desktop simultaneous input is not atomically gated, so this tool remains test-only.', { threadId: z.string().uuid(), intentId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/), text: z.string().min(1).max(16000) }, 'send', false);
  tool('companion_inbox_open', 'Explicitly enter bounded continuous consumption in THIS desktop turn. Keep the returned sessionId. Repeatedly take with waitMs=20000 while continuePolling is true, until stopped, deadline or job limit. Never wake or start another desktop turn automatically.', { windowMs: z.number().int().min(1000).max(600000).default(120000), maxJobs: z.number().int().min(1).max(100).default(10) }, 'inbox_open', false);
  tool('companion_inbox_take', 'Pull one test job for the exact consumption session. Empty plus continuePolling=true means keep waiting in this same turn. Check cancellation before work and completion. Complete or acknowledge cancellation before taking another. Stopped/blocked ends consumption; never replay unknown work.', { sessionId: z.string().uuid(), waitMs: z.number().int().min(0).max(20000).default(0) }, 'inbox_take', false);
  tool('companion_inbox_complete', 'Record a pulled job result using its exact intent and lease token. Only the dedicated controller caller is allowed. A completed result is idempotent; unknown jobs require manual reconciliation and are never replayed.', { intentId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/), leaseToken: z.string().uuid(), result: z.string().min(1).max(16000) }, 'inbox_complete', false);
  const lease = { intentId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/), leaseToken: z.string().uuid() };
  tool('companion_inbox_checkpoint', 'Read a lease and cancelRequested. If cancellation is requested, stop that job and acknowledge cancellation; never interrupt the native desktop turn.', lease, 'inbox_checkpoint', true);
  tool('companion_inbox_ack_cancel', 'Cooperatively acknowledge cancellation of a leased job in its original consumer turn. No native turn interruption or automatic replay occurs.', lease, 'inbox_ack_cancel', false);
  tool('companion_inbox_close', 'Stop this consumption session, preserving queued jobs. Any leased job still requires explicit completion or cancellation acknowledgement. Reopening requires an explicit open call.', { sessionId: z.string().uuid() }, 'inbox_close', false);
  return server;
}
