// Dedicated-test MCP client. Used only until the desktop reloads project MCP config.
// This is not a replacement Codex executor or a login daemon.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readPrivate, writePrivate } from './state.mjs';
const scopeFile = path.resolve(process.argv[2]), scope = readPrivate(scopeFile);
if (process.env.CODEX_THREAD_ID !== scope.callerThreadId) throw Error('actual_controller_required');
let client, transport, stopping = false, starting = false, restarting = false, retryTimer, timer;
const runtime = path.dirname(scopeFile), endpoint = path.join(runtime, 'acceptance-host.sock');
const log = value => process.stdout.write(JSON.stringify(value) + '\n');
async function start() {
  if (starting || stopping) return; starting = true;
  try {
    client = new Client({ name: 'rmtcdx-dedicated-acceptance-host', version: '1' });
    transport = new StdioClientTransport({ command: process.execPath, args: [path.join(import.meta.dirname, 'mcp-server.mjs'), scopeFile], env: { CODEX_APP_TOOLS_PIPE_PATH: process.env.CODEX_APP_TOOLS_PIPE_PATH }, stderr: 'pipe' });
    transport.stderr.on('data', data => fs.appendFileSync(path.join(runtime, 'service.jsonl'), data, { mode: 0o600 }));
    client.onclose = () => { if (!stopping && !restarting) retryTimer = setTimeout(() => void start().catch(error => log({ event: 'acceptance.restart.failed', code: error.code ?? error.message })), 1000); };
    await client.connect(transport);
    const tools = await client.listTools();
    const status = await client.callTool({ name: 'companion_status', arguments: {}, _meta: { 'x-codex-turn-metadata': { thread_id: process.env.CODEX_THREAD_ID } } });
    writePrivate(path.join(runtime, 'mcp-handshake.json'), { pid: transport.pid, parentPid: process.pid, actualCaller: process.env.CODEX_THREAD_ID, tools: tools.tools.map(t => t.name), status, desktopConfigReloaded: false });
    log({ event: 'acceptance.mcp.ready', pid: transport.pid, tools: tools.tools.length });
  } finally { starting = false; }
}
const server = net.createServer(socket => {
  socket.setEncoding('utf8'); let buffer = '';
  socket.on('error', () => {});
  socket.on('data', data => {
    buffer += data; if (buffer.length > 16000) return socket.destroy();
    if (!buffer.includes('\n')) return;
    void (async () => {
      try {
        const request = JSON.parse(buffer.trim());
        if (request.operation === 'restart') {
          restarting = true; clearTimeout(retryTimer);
          try { await client.close(); await start(); } finally { restarting = false; }
        }
        else if (request.operation === 'status') {
          const result = await client.callTool({ name: 'companion_status', arguments: {}, _meta: { 'x-codex-turn-metadata': { thread_id: process.env.CODEX_THREAD_ID } } });
          socket.end(JSON.stringify(result) + '\n'); return;
        } else throw Error('unsupported_operation');
        socket.end(JSON.stringify({ restarted: true, pid: transport.pid }) + '\n');
      } catch (error) { socket.end(JSON.stringify({ error: error.code ?? error.message }) + '\n'); }
    })();
  });
});
if (fs.existsSync(endpoint)) throw Error('acceptance_host_exists');
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); }); fs.chmodSync(endpoint, 0o600);
const parent = process.ppid;
async function stop() { if (stopping) return; stopping = true; clearInterval(timer); clearTimeout(retryTimer); await client?.close(); server.close(); fs.rmSync(endpoint, { force: true }); }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());
timer = setInterval(() => { if (process.ppid !== parent) void stop(); }, 1000);
try { await start(); } catch (error) { log({ event: 'acceptance.mcp.failed', code: error.code ?? error.message }); await stop(); process.exitCode = 1; }
