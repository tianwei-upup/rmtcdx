import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fingerprint, fail, input, output, validateImage } from './contracts.mjs';
import { assertIsolatedNativeRuntime, assertNativeExecutionAllowed } from './runtime-isolation.mjs';
const opaque = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 40);
export class CodexAdapter {
  constructor(client, projects, emit = () => {}, attachmentDir = null, conversationProjects = {}) {
    this.attachmentDir = attachmentDir; this.attachments = new Map(); this.client = client; this.emit = emit; this.runs = new Map(); this.starting = new Map();
    this.emptyCreated = new Set();
    this.projectSource = typeof projects === 'function' ? projects : () => projects;
    this.conversationProjects = new Map(Object.entries(conversationProjects));
    this.refreshProjects();
    client.on('event', event => this.event(event));
  }
  refreshProjects() {
    const canonical = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    this.projects = this.projectSource().map(p => ({ ...p, path: canonical(p.path), paths: (p.paths ?? [p.path]).map(canonical) }));
    this.projectAssignments = new Map(this.projects.flatMap(p => (p.threadIds ?? []).map(id => [id, p.id])));
    output('projects.sync', { projects: this.projects.map(({ id, name, available }) => ({ id, name, ...(available !== undefined ? { available } : {}) })) });
    if (new Set(this.projects.map(p => p.id)).size !== this.projects.length) fail('duplicate_project');
  }
  async start() { await this.client.start(); }
  async stop() { clearTimeout(this.threadCatalogTimer); this.threadCatalog = null; await this.client.stop(); }
  async threads(params) {
    const key = JSON.stringify(params);
    if (this.threadCatalog?.key === key && this.threadCatalog.expires > Date.now()) return this.threadCatalog.promise;
    clearTimeout(this.threadCatalogTimer);
    const batch = { key, expires: Infinity };
    batch.promise = this.client.listThreads(params).then(values => {
      batch.expires = Date.now() + 30000;
      if (this.threadCatalog === batch) { this.threadCatalogTimer = setTimeout(() => { if (this.threadCatalog === batch) this.threadCatalog = null; }, 30000); this.threadCatalogTimer.unref?.(); }
      // Native pagination may repeat an entry while desktop activity changes the index.
      // Prefer the first occurrence so an archived duplicate cannot override the live entry.
      const unique = new Map();
      for (const thread of values) if (!unique.has(thread.id)) unique.set(thread.id, thread);
      return [...unique.values()];
    }).catch(error => { if (this.threadCatalog === batch) this.threadCatalog = null; throw error; });
    this.threadCatalog = batch;
    return batch.promise;
  }
  /**
   * Projects one native turn item into zero or more bounded messages.
   *
   * Codex history carries far more than prose: commands, patches, tool calls
   * and reasoning. Dropping them made the snapshot look complete while losing
   * what actually happened, so each text-bearing item is projected with a
   * provenance label. Items whose payload is a local path or a binary artifact
   * are intentionally reduced to a short label and never expose the path.
   */
  projectItem(item) {
    const id = typeof item?.id === 'string' ? item.id : 'item';
    const emit = (role, kind, text) => {
      const value = typeof text === 'string' ? text : '';
      if (!value) return [];
      const out = [];
      // Contract caps a single message at 65536 chars.
      for (let offset = 0; offset < value.length; offset += 32000) out.push({ id: opaque(id + ':' + offset), role, kind, text: value.slice(offset, offset + 32000), attachmentIds: [] });
      return out;
    };
    if (item?.type === 'agentMessage') return emit('assistant', 'text', item.text);
    if (item?.type === 'userMessage') return emit('user', 'text', (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'));
    if (item?.type === 'plan') return emit('assistant', 'plan', item.text);
    if (item?.type === 'reasoning') {
      const parts = [...(item.summary ?? []), ...(item.content ?? [])].filter(part => typeof part === 'string' && part.trim());
      return emit('assistant', 'reasoning', parts.join('\n\n'));
    }
    if (item?.type === 'commandExecution') {
      const header = `$ ${String(item.command ?? '').trim()}`;
      const output = typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.trim() ? `\n${item.aggregatedOutput}` : '';
      const status = item.exitCode === undefined || item.exitCode === null ? '' : `\n[exit ${item.exitCode}]`;
      return emit('assistant', 'command', header + output + status);
    }
    if (item?.type === 'fileChange') {
      const changes = (item.changes ?? []).map(change => {
        const kind = change?.kind?.type ?? 'update';
        return `${kind} ${String(change?.path ?? '')}`;
      });
      return emit('assistant', 'fileChange', changes.join('\n'));
    }
    if (item?.type === 'mcpToolCall') return emit('assistant', 'mcpToolCall', `${String(item.server ?? 'mcp')} · ${String(item.tool ?? '')}${item.status ? ` (${item.status})` : ''}`);
    if (item?.type === 'webSearch') return emit('assistant', 'webSearch', `搜索：${String(item.query ?? '')}`);
    if (item?.type === 'imageGeneration') return emit('assistant', 'imageGeneration', `[已生成图片] ${String(item.revisedPrompt ?? '')}`.trim());
    // imageView carries a local path and other item types are not rendered.
    return [];
  }
  /**
   * Reads the active catalog plus archived sessions. Archived threads are
   * readable but excluded from an ordinary list, so without this the drawer
   * silently omits history the user can still open.
   */
  async catalogThreads(params = {}) {
    const active = await this.threads({ ...params, archived: false });
    let archived = [];
    try { archived = await this.threads({ ...params, archived: true }); }
    catch { archived = []; }
    const seen = new Set(active.map(thread => thread.id));
    // Tag the source list so the phone can tell archived threads apart.
    return [...active.map(thread => ({ ...thread, archived: false })), ...archived.filter(thread => !seen.has(thread.id)).map(thread => ({ ...thread, archived: true }))];
  }
  ready() { return this.client.getState().ready; }
  project(id) { return this.projects.find(p => p.id === id) ?? fail('precondition_rejected'); }
  projectForThread(thread) {
    const assigned = this.projectAssignments.get(thread.id) ?? this.conversationProjects.get(thread.id);
    if (assigned) return this.projects.find(p => p.id === assigned);
    let cwd; try { cwd = fs.realpathSync(thread.cwd); } catch { cwd = path.resolve(thread.cwd); }
    return this.projects.find(p => p.paths.includes(cwd));
  }
  async owned(id) {
    const thread = await this.client.readThread(id, { includeTurns: false });
    const project = this.projectForThread(thread);
    if (!project) fail('precondition_rejected');
    return { thread, project };
  }
  conversation(thread, project) {
    return { id: thread.id, projectId: project.id, title: String(thread.name || thread.preview || '新会话').slice(0, 200), status: thread.status?.type === 'active' ? 'running' : 'idle', updatedAt: Math.max(0, Math.floor(thread.updatedAt || Date.now() / 1000)), archived: thread.archived === true };
  }
  page(values, params, newest = false) {
    const version = fingerprint(values), size = params.pageSize ?? 30;
    let offset = 0, end = values.length;
    if (params.cursor) {
      let cursor; try { cursor = JSON.parse(Buffer.from(params.cursor, 'base64url')); } catch { fail('precondition_rejected'); }
      if (cursor.version !== version) fail('precondition_rejected');
      if (newest) { if (!Number.isSafeInteger(cursor.end) || cursor.end < 0 || cursor.end > values.length) fail('precondition_rejected'); end = cursor.end; }
      else { if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) fail('precondition_rejected'); offset = cursor.offset; }
    }
    if (newest) { offset = Math.max(0, end - size); return { values: values.slice(offset, end), nextCursor: offset > 0 ? Buffer.from(JSON.stringify({ version, end: offset })).toString('base64url') : null }; }
    return { values: values.slice(offset, offset + size), nextCursor: offset + size < values.length ? Buffer.from(JSON.stringify({ version, offset: offset + size })).toString('base64url') : null };
  }
  async execute(operation, params, jobId) {
    input(operation, params); this.refreshProjects(); let result;
    if (operation === 'projects.sync') { this.threadCatalog = null; result = { projects: this.projects.map(({ id, name, available }) => ({ id, name, ...(available !== undefined ? { available } : {}) })) }; }
    if (operation === 'directory.sync') {
      const threads = await this.catalogThreads({ limit: 100 }), grouped = new Map(this.projects.map(p => [p.id, []]));
      for (const thread of threads) { const project = this.projectForThread(thread); if (project) grouped.get(project.id).push(this.conversation(thread, project)); }
      result = { projects: this.projects.map(({ id, name, available }) => ({ id, name, ...(available !== undefined ? { available } : {}) })), directories: this.projects.map(p => { const page = this.page(grouped.get(p.id), { pageSize: 100 }); return { projectId: p.id, conversations: page.values, nextCursor: page.nextCursor }; }) };
    }
    if (operation === 'sessions.sync') {
      const project = this.project(params.projectId);
      const threads = params.archived === true ? (await this.threads({ archived: true, searchTerm: params.search, limit: 100 })).map(thread => ({ ...thread, archived: true })) : await this.catalogThreads({ searchTerm: params.search, limit: 100 });
      const values = threads.filter(t => this.projectForThread(t)?.id === project.id).map(t => this.conversation(t, project));
      const page = this.page(values, params); result = { conversations: page.values, nextCursor: page.nextCursor };
    }
    if (operation === 'conversation.create') {
      const project = this.project(params.projectId);
      if (project.available === false) fail('precondition_rejected');
      const created = await this.client.createThread(project.path, { sandbox: 'read-only', approvalPolicy: 'on-request' });
      this.conversationProjects.set(created.threadId, project.id);
      this.emptyCreated.add(created.threadId);
      const thread = await this.client.readThread(created.threadId, { includeTurns: false });
      result = { conversation: this.conversation(thread, project) };
    }
    if (operation === 'conversation.snapshot') {
      const { project } = await this.owned(params.conversationId);
      let thread;
      try { thread = await this.client.readThread(params.conversationId, { includeTurns: true }); }
      catch (error) { if (!this.emptyCreated.has(params.conversationId) || !/empty|not materialized|no rollout|^list_turns is not supported yet$/i.test(error.message)) throw error; thread = (await this.owned(params.conversationId)).thread; }
      const messages = [];
      for (const turn of thread.turns ?? []) for (const item of turn.items ?? []) for (const projected of this.projectItem(item)) messages.push(projected);
      const page = this.page(messages, params, true);
      result = { conversation: this.conversation(thread, project), messages: page.values, nextCursor: page.nextCursor, activeTurnId: [...(thread.turns ?? [])].reverse().find(t => t.status === 'inProgress')?.id ?? null, approvals: this.client.listPendingRequests(thread.id).slice(0, 20).map(request => ({ id: opaque(request.id), kind: request.type, summary: String(request.reason || request.command || '电脑端请求审批；只读验证仅支持拒绝或取消').slice(0, 4000) })), assets: [] };
    }
    if (operation === 'attachment.stage') {
      await this.owned(params.conversationId);
      if (!this.attachmentDir || this.attachments.size >= 100) fail('precondition_rejected');
      fs.mkdirSync(this.attachmentDir, { recursive: true, mode: 0o700 });
      const filename = path.join(this.attachmentDir, params.attachmentId + (params.mime === 'image/png' ? '.png' : params.mime === 'image/jpeg' ? '.jpg' : '.webp'));
      fs.writeFileSync(filename, validateImage(params.mime, params.base64), { mode: 0o600 });
      this.attachments.set(params.attachmentId, { filename, conversationId: params.conversationId, expires: Date.now() + 300000 });
      result = { conversationId: params.conversationId, attachmentId: params.attachmentId, status: 'staged' };
    }
    if (operation === 'turn.cancel') {
      const { thread } = await this.owned(params.conversationId);
      const native = await this.client.readThread(thread.id, { includeTurns: true });
      if (!(native.turns ?? []).some(turn => turn.id === params.turnId && turn.status === 'inProgress')) fail('precondition_rejected');
      await this.client.interruptRun(jobId, thread.id, params.turnId);
      result = { conversationId: thread.id, turnId: params.turnId, status: 'interrupt_requested' };
    }
    if (operation === 'approval.resolve') {
      await this.owned(params.conversationId);
      const request = this.client.listPendingRequests(params.conversationId).find(r => opaque(r.id) === params.approvalId);
      if (!request || !['command_approval', 'file_change_approval'].includes(request.type)) fail('precondition_rejected');
      await this.client.respondToRequest(request.id, { type: request.type, decision: params.decision });
      result = { conversationId: params.conversationId, approvalId: params.approvalId, status: 'resolved' };
    }
    if (operation === 'turn.start') {
      const { project, thread } = await this.owned(params.conversationId);
      if (thread.status?.type === 'active' || this.starting.has(thread.id)) fail('precondition_rejected');
      const images = params.attachmentIds.map(id => { const value = this.attachments.get(id); if (!value || value.conversationId !== thread.id || value.expires < Date.now()) fail('precondition_rejected'); return { type: 'localImage', path: value.filename }; });
      this.starting.set(thread.id, { jobId, buffered: [] });
      try {
        const native = await this.client.startRun({ sessionId: thread.id, runId: jobId, threadId: thread.id, cwd: thread.cwd,
          input: [{ type: 'text', text: params.text, text_elements: [] }, ...images], codex: { sandbox: 'read-only', approvalPolicy: 'on-request' } });
        const context = { jobId, conversationId: thread.id, turnId: native.turnId };
        this.emptyCreated.delete(thread.id);
        this.runs.set(native.turnId, context);
        this.publish(context, 'turn.started');
        for (const event of this.starting.get(thread.id).buffered) this.event(event);
        result = { conversationId: thread.id, turnId: native.turnId, status: 'running' };
      } finally { this.starting.delete(thread.id); }
    }
    return output(operation, result);
  }
  publish(context, type, extra = {}) { this.emit({ ...context, eventId: crypto.randomUUID(), type, ...extra }); }
  event(event) {
    const context = this.runs.get(event.turnId ?? event.request?.turnId);
    if (!context) { const starting = this.starting.get(event.sessionId); if (starting && starting.buffered.length < 256) starting.buffered.push(event); return; }
    if (event.type === 'item.delta' && event.kind === 'agentMessage.text') for (let i = 0; i < event.delta.length; i += 8192) this.publish(context, 'assistant.delta', { text: event.delta.slice(i, i + 8192) });
    if (['run.completed', 'run.interrupted', 'run.error'].includes(event.type)) {
      this.publish(context, 'turn.finished', { status: event.type === 'run.completed' ? 'completed' : event.type === 'run.interrupted' ? 'interrupted' : 'failed' });
      this.runs.delete(event.turnId);
    }
    if (event.type === 'request.created') this.publish(context, 'approval.pending');
  }
}
export async function nativeAdapter(projects, emit, attachmentDir, conversationProjects, runtimeHome) {
  assertNativeExecutionAllowed();
  const home = assertIsolatedNativeRuntime(runtimeHome);
  const { RealCodexClient } = await import('../../services/rmtcdx/apps/bridge/dist/business-runtime.js');
  // Native logs can contain command output or prompt text; keep them out of service logs.
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  return new CodexAdapter(new RealCodexClient(silent, undefined, home), projects, emit, attachmentDir, conversationProjects);
}
