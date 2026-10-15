import path from 'node:path';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppToolsClient } from './app-tools.mjs';
import { CompanionService } from './service.mjs';
import { acquireOwner, readPrivate } from './state.mjs';
import { serveLocal } from './local-server.mjs';
import { createMcpServer } from './mcp.mjs';
import { CompanionProxy } from './proxy.mjs';

const scope = z.object({
  version: z.literal(1), mode: z.literal('test'), callerThreadId: z.string().uuid(),
  threadIds: z.array(z.string().uuid()).min(1).max(10),
  expectedCwds: z.record(z.string().uuid(), z.string().startsWith('/')),
  runtime: z.string().startsWith('/')
}).strict().parse(readPrivate(path.resolve(process.argv[2]), null));
const runtime = path.resolve(scope.runtime);
let release, role = 'owner';
try { release = acquireOwner(runtime); }
catch (error) { if (error.code !== 'companion_already_running') throw error; role = 'proxy'; }
const log = event => process.stderr.write(JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event }) + '\n');
let service, mcp, closeLocal, monitor, stopping;
async function shutdown() {
  if (stopping) return stopping;
  stopping = (async () => {
    clearInterval(monitor); service?.stop(); await closeLocal?.(); await mcp?.close(); release?.();
    log({ event: 'companion.stopped' });
  })();
  return stopping;
}
try {
  // scope binds the actual dedicated controller identity authorized at installation.
  // The socket path is always fresh desktop-provided environment, never saved state.
  if (role === 'owner') {
    const client = new AppToolsClient({ endpoint: process.env.CODEX_APP_TOOLS_PIPE_PATH, callerThreadId: scope.callerThreadId });
    service = new CompanionService({ runtime, client, scope, log });
    closeLocal = await serveLocal(runtime, service, () => void shutdown());
  } else {
    service = new CompanionProxy({ runtime, scope });
    // Refuse a mismatched owner before offering tools. Unavailable owners remain
    // unavailable; no native sender is started as a fallback.
    for (let attempt = 0; ; attempt++) {
      try { await service.execute({ operation: 'status' }); break; }
      catch (error) {
        if (attempt >= 19 || error.code === 'owner_scope_mismatch') throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  mcp = createMcpServer(service);
  await mcp.connect(new StdioServerTransport());
  if (role === 'owner') await service.start();
  const parentPid = process.ppid;
  monitor = setInterval(() => { if (process.ppid !== parentPid) void shutdown(); }, 1000);
  process.stdin.once('end', () => void shutdown());
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutdown());
  log({ event: 'companion.mcp.started', mode: scope.mode, parentPid, role });
} catch (error) { log({ event: 'companion.start_failed', code: error.code ?? 'startup_failed' }); await shutdown(); process.exitCode = 1; }
