import { control } from './control.mjs';
import { failure } from './app-tools.mjs';

// A second MCP frontend may attach to the same protected companion. It never
// becomes a second native writer or stops the owner when its stdio closes.
export class CompanionProxy {
  constructor({ runtime, scope, call = control }) { this.runtime = runtime; this.scope = scope; this.call = call; }
  async execute(request) {
    if (!['status', 'snapshot', 'receipt', 'send', 'reconnect', 'inbox_open', 'inbox_take', 'inbox_complete', 'inbox_checkpoint', 'inbox_ack_cancel', 'inbox_close'].includes(request.operation)) throw failure('unsupported_operation');
    const status = await this.call(this.runtime, { operation: 'status' });
    if (status.callerThreadId !== this.scope.callerThreadId || status.mode !== 'test' ||
        this.scope.threadIds.some(id => !status.allowedThreadIds.includes(id))) throw failure('owner_scope_mismatch');
    if (request.operation === 'status') return { ...status, mcpRole: 'proxy', mcpFrontendPid: process.pid };
    if (request.operation !== 'reconnect' && !request.operation.startsWith('inbox_') && !this.scope.threadIds.includes(request.threadId)) throw failure('test_thread_not_allowed');
    // AbortSignal cannot be serialized to the private socket. A proxy take is
    // nonblocking so cancellation never leaves a hidden long-poll claimant.
    const { signal, ...input } = request;
    if (signal?.aborted) throw failure('inbox_wait_cancelled');
    return this.call(this.runtime, { ...input, ...(request.operation === 'inbox_take' ? { waitMs: 0 } : {}) });
  }
  stop() {} // The frontend does not own the native service.
}
