// Binding between the validated attach transport and the upstream Codex client.
//
// This module is deliberately separate from attach-adapter.mjs: the adapter is
// covered by anti-regression tests that forbid it from importing the suspended
// bridge runtime, so the real client factory is injected from here once a
// transport has been validated.
//
// Attach mode never spawns a Codex process and never reads CODEX_HOME. The
// upstream WebSocketTransport dials only the resolved endpoint, and the
// upstream client is configured to fail closed instead of restarting: losing
// the endpoint must never create a second executor writing the same profile.
import { WebSocketTransport, RealCodexClient } from '../../services/rmtcdx/apps/bridge/dist/business-runtime.js';
import { CodexAdapter } from './codex-adapter.mjs';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Builds the client factory consumed by attachAdapter(). The returned factory
 * receives the value from resolveTransport(): a Unix socket alias, a direct
 * Unix socket, or a validated ws URL.
 */
export function attachClientFactory({ emit = () => {}, attachmentDir = null } = {}) {
  return (resolved, projects) => {
    const options = resolved.kind === 'ws'
      ? { url: resolved.url }
      : { url: 'ws://localhost/rpc', socketPath: resolved.physical ?? resolved.path };
    const transport = new WebSocketTransport({ ...options, logger: silent });
    const client = new RealCodexClient(silent, undefined, undefined, transport);
    return new CodexAdapter(client, projects, emit, attachmentDir);
  };
}
