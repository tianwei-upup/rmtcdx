/** UI-only state. Native frames and network requests never enter this model. */
export class ConversationState {
  constructor(id, title = '新聊天') {
    this.id = id; this.title = title; this.messages = []; this.draft = ''; this.files = [];
    this.status = 'idle'; this.turnId = null; this.sending = false; this.cursor = null; this.approvals = [];
    this.finished = new Set(); this.events = new Set(); this.revision = 0; this.loaded = false;
  }
  optimistic(text, images = []) {
    const message = { id: 'local-' + crypto.randomUUID(), role: 'user', text, images, pending: true };
    this.messages.push(message); this.sending = true; this.status = 'submitting'; return message;
  }
  accepted(turnId) {
    this.sending = false;
    this.messages.filter(m => m.pending).forEach(m => { m.pending = false; });
    if (!this.finished.has(turnId)) { this.turnId = turnId; this.status = 'running'; }
  }
  event(event) {
    if (event.conversationId !== this.id || this.events.has(event.eventId)) return false;
    this.events.add(event.eventId); if (this.events.size > 512) this.events.delete(this.events.values().next().value);
    this.revision++;
    if (event.type === 'turn.started' && !this.finished.has(event.turnId)) { this.turnId = event.turnId; this.status = 'running'; }
    if (event.type === 'assistant.delta' && !this.finished.has(event.turnId)) {
      let message = this.messages.find(m => m.id === 'stream-' + event.turnId);
      if (!message) { message = { id: 'stream-' + event.turnId, role: 'assistant', text: '', streaming: true }; this.messages.push(message); }
      message.text += event.text;
    }
    if (event.type === 'turn.finished') {
      this.finished.add(event.turnId); if (this.finished.size > 128) this.finished.delete(this.finished.values().next().value);
      this.messages.filter(m => m.id === 'stream-' + event.turnId).forEach(m => { m.streaming = false; });
      if (!this.turnId || this.turnId === event.turnId) { this.turnId = null; this.status = event.status; }
    }
    if (event.type === 'approval.pending') this.status = 'approval';
    return true;
  }
  snapshot(value, appendOlder = false, revision = this.revision) {
    // A stale read must never replace deltas delivered while the snapshot was in flight.
    if (!appendOlder && revision !== this.revision) return false;
    const normalized = value.messages.map(m => ({ ...m, images: [] }));
    if (appendOlder) { const ids = new Set(this.messages.map(m => m.id)); this.messages = [...normalized.filter(m => !ids.has(m.id)), ...this.messages]; }
    else {
      // Preserve local attachment previews when native history only carries text.
      const originals = this.messages.filter(m => m.role === 'user' && m.images?.length);
      for (const message of normalized) { const match = originals.find(m => m.text === message.text); if (match) message.images = match.images; }
      this.messages = normalized;
      const active = value.activeTurnId ?? null;
      const alreadyFinished = active && this.finished.has(active);
      this.turnId = alreadyFinished ? null : active;
      this.status = alreadyFinished ? this.status : value.conversation.status;
    }
    this.title = value.conversation.title || '新聊天'; this.cursor = value.nextCursor; this.approvals = value.approvals; this.loaded = true; return true;
  }
}
export const nearBottom = (top, height, viewport) => height - top - viewport < 100;
export function safeLink(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } }

export function mergeConversations(remote, known, projectId, search = '') {
 const query = search.toLowerCase(), seen = new Set(remote.map(c => c.id));
 const missing = known.filter(c => c.id && c.projectId === projectId && !seen.has(c.id) && (!query || c.title.toLowerCase().includes(query)));
 return [...missing.map(c => ({ id: c.id, projectId: c.projectId, title: c.title, status: c.status })), ...remote];
}

// Origin-local storage, separately scoped per computer. No Codex or server writes.
export class ProjectPins {
  constructor(storage) { this.storage = storage; }
  key(deviceId) { return 'rmt-project-pins:v1:' + deviceId; }
  read(deviceId) { try { const value = JSON.parse(this.storage.getItem(this.key(deviceId)) || '[]'); return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string'))] : []; } catch { return []; } }
  toggle(deviceId, id) { const pins = this.read(deviceId); this.storage.setItem(this.key(deviceId), JSON.stringify(pins.includes(id) ? pins.filter(p => p !== id) : [id, ...pins])); }
  order(projects, deviceId) { const pins = this.read(deviceId), byId = new Map(projects.map(p => [p.id, p])); return [...pins.filter(id => byId.has(id)).map(id => byId.get(id)), ...projects.filter(p => !pins.includes(p.id))]; }
}

// Directory metadata lives in RAM independently of sidebar visibility.
export class DirectoryCache {
  constructor(fetcher, { now = () => Date.now(), ttl = 30000 } = {}) { this.fetcher = fetcher; this.now = now; this.ttl = ttl; this.projects = []; this.entries = new Map(); this.known = new Map(); this.syncedAt = 0; this.pending = null; }
  get(id) { return this.entries.get(id) ?? { conversations: [], nextCursor: null, loaded: false }; }
  remember(c) { if (!c?.id || !c.projectId) return; this.known.set(c.id, { value: { id: c.id, projectId: c.projectId, title: c.title || '新聊天', status: c.status || 'idle' }, expires: this.now() + 300000 }); }
  conversations(id) { const list = this.get(id).conversations, ids = new Set(list.map(c => c.id)); return [...[...this.known.values()].filter(c => c.expires > this.now() && c.value.projectId === id && !ids.has(c.value.id)).map(c => c.value), ...list]; }
  append(id, value) { const old = this.get(id), ids = new Set(old.conversations.map(c => c.id)); this.entries.set(id, { conversations: [...old.conversations, ...value.conversations.filter(c => !ids.has(c.id))], nextCursor: value.nextCursor, loaded: true }); }
  refresh(force = false) {
    if (this.pending) return this.pending;
    if (!force && this.syncedAt && this.now() - this.syncedAt < this.ttl) return Promise.resolve(this);
    this.pending = (async () => {
      const value = await this.fetcher();
      this.projects = value.projects;
      this.entries = new Map(value.directories.map(d => [d.projectId, { conversations: d.conversations, nextCursor: d.nextCursor, loaded: true }]));
      this.syncedAt = this.now();
      const projects = new Set(this.projects.map(p => p.id));
      for (const [id, c] of this.known) if (c.expires <= this.now() || !projects.has(c.value.projectId)) this.known.delete(id);
      return this;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}
