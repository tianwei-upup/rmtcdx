import crypto from 'node:crypto';

export const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) && !['constructor', '__proto__', 'prototype'].includes(value);
export function fail(code, status = 400) { throw Object.assign(new Error(code), { code, status }); }
export function object(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('invalid_fields');
}
export function string(value, max = 100, min = 1) { if (typeof value !== 'string' || value.length < min || value.length > max) fail('invalid_string'); return value; }
export function identifier(value) { if (!id(value)) fail('invalid_id'); return value; }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const READS = new Set(['projects.sync', 'directory.sync', 'sessions.sync', 'conversation.snapshot']);
export const OPERATIONS = ['projects.sync', 'directory.sync', 'sessions.sync', 'conversation.snapshot', 'conversation.create', 'turn.start', 'turn.cancel', 'approval.resolve', 'attachment.stage'];
export const QUEUE_OPERATIONS = ['queue.enqueue', 'queue.status', 'queue.cancel', 'queue.consumer.stop'];
export const SUPPORTED_OPERATIONS = [...OPERATIONS, ...QUEUE_OPERATIONS];
READS.add('queue.status');
function queueReceipt(value, conversationId) {
  object(value, ['intentId','threadId','state','revision','cancelRequested','consumerTurnId','sessionId','outcomeUncertain','resolution','result','text'], ['intentId','threadId','state','revision','cancelRequested','consumerTurnId','sessionId','outcomeUncertain']);
  if(value.text!==undefined) string(value.text,16000);
  identifier(value.intentId); if (value.threadId !== conversationId) fail('queue_scope_mismatch');
  if (!['queued','leased','completed','cancelled','unknown'].includes(value.state) || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.cancelRequested !== 'boolean') fail('invalid_queue_receipt');
  if (value.consumerTurnId !== null) identifier(value.consumerTurnId); if (value.sessionId !== null) identifier(value.sessionId);
  if (typeof value.outcomeUncertain !== 'boolean' || value.state === 'unknown' && !value.outcomeUncertain || value.resolution !== undefined && (value.resolution !== 'abandoned_unknown' || value.state !== 'cancelled' || !value.outcomeUncertain) || value.outcomeUncertain && !['unknown','cancelled'].includes(value.state)) fail('invalid_queue_uncertainty');
  if (value.state === 'queued' && (value.consumerTurnId !== null || value.sessionId !== null)) fail('invalid_queue_receipt');
  if (value.state === 'completed') string(value.result,16000); else if (value.result !== undefined) fail('invalid_queue_result');
}
function queueConsumer(value) {
  if (value === null) return;
  object(value,['sessionId','consumerTurnId','state','waiting','expiresAt','maxJobs','takenJobs','stopReason']);
  identifier(value.sessionId); identifier(value.consumerTurnId);
  if (!['active','stopping','closed'].includes(value.state) || typeof value.waiting !== 'boolean' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0 || !Number.isSafeInteger(value.maxJobs) || value.maxJobs < 1 || value.maxJobs > 100 || !Number.isSafeInteger(value.takenJobs) || value.takenJobs < 0 || value.takenJobs > value.maxJobs) fail('invalid_queue_consumer');
  if (value.stopReason !== null) string(value.stopReason,100);
}
function page(value) {
  if (value.pageSize !== undefined && (!Number.isInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 100)) fail('invalid_page_size');
  if (value.cursor != null) string(value.cursor, 1000);
}
function conversation(value) {
  object(value, ['id', 'projectId', 'title', 'status', 'updatedAt'], ['id', 'projectId', 'title', 'status']);
  identifier(value.id); identifier(value.projectId); string(value.title, 200, 0);
  if (!['idle', 'running', 'completed', 'failed', 'interrupted'].includes(value.status)) fail('invalid_conversation_status');
  if (value.updatedAt !== undefined && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)) fail('invalid_timestamp');
}
export function input(operation, value) {
  if (QUEUE_OPERATIONS.includes(operation)) {
    const keys = operation === 'queue.enqueue' ? ['conversationId','intentId','text'] : operation === 'queue.cancel' ? ['conversationId','intentId','expectedRevision'] : operation === 'queue.consumer.stop' ? ['conversationId','sessionId'] : ['conversationId','intentId'];
    object(value, keys, operation === 'queue.status' ? ['conversationId'] : keys); identifier(value.conversationId);
    if (value.intentId !== undefined) { identifier(value.intentId); if (!/^[a-zA-Z0-9-]{1,80}$/.test(value.intentId)) fail('invalid_queue_intent'); }
    if (operation === 'queue.enqueue' && !string(value.text,16000).trim()) fail('invalid_queue_text');
    if (operation === 'queue.cancel' && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) fail('invalid_queue_revision');
    if (value.sessionId !== undefined) identifier(value.sessionId);
    return structuredClone(value);
  }
  if (operation === 'projects.sync' || operation === 'directory.sync') { object(value, []); return {}; }
  if (operation === 'sessions.sync') {
    object(value, ['projectId', 'cursor', 'pageSize', 'search', 'archived'], ['projectId']); identifier(value.projectId); page(value);
    if (value.search !== undefined) string(value.search, 100, 0);
    if (value.archived !== undefined && typeof value.archived !== 'boolean') fail('invalid_archived');
    return structuredClone(value);
  }
  if (operation === 'conversation.snapshot') {
    object(value, ['conversationId', 'cursor', 'pageSize'], ['conversationId']); identifier(value.conversationId); page(value); return structuredClone(value);
  }
  if (operation === 'attachment.stage') {
    object(value, ['conversationId', 'attachmentId', 'mime', 'base64']); identifier(value.conversationId); identifier(value.attachmentId);
    validateImage(value.mime, value.base64); return structuredClone(value);
  }
  if (operation === 'turn.cancel') { object(value, ['conversationId', 'turnId']); identifier(value.conversationId); identifier(value.turnId); return structuredClone(value); }
  if (operation === 'approval.resolve') {
    object(value, ['conversationId', 'approvalId', 'decision']); identifier(value.conversationId); identifier(value.approvalId);
    // Remote permission elevation is unavailable in the read-only local validation profile.
    if (!['decline', 'cancel'].includes(value.decision)) fail('invalid_approval_decision');
    return structuredClone(value);
  }
  if (operation === 'turn.start') {
    object(value, ['conversationId', 'text', 'attachmentIds']); identifier(value.conversationId); string(value.text, 16000, 0);
    if (!Array.isArray(value.attachmentIds) || value.attachmentIds.length > 5 || !value.text.trim() && !value.attachmentIds.length) fail('invalid_turn');
    value.attachmentIds.forEach(identifier); return structuredClone(value);
  }
  if (operation !== 'conversation.create') fail('unsupported_operation');
  object(value, ['projectId']); identifier(value.projectId);
  return structuredClone(value);
}
export function output(operation, value) {
  if (QUEUE_OPERATIONS.includes(operation)) {
    const keys = operation === 'queue.status' ? ['conversationId','receipts','consumer'] : operation === 'queue.consumer.stop' ? ['conversationId','consumer'] : ['conversationId','receipt'];
    object(value,keys); identifier(value.conversationId);
    if (operation === 'queue.status') {
      if (!Array.isArray(value.receipts) || value.receipts.length > 100 || new Set(value.receipts.map(r=>r.intentId)).size !== value.receipts.length) fail('invalid_queue_receipts');
      value.receipts.forEach(r=>queueReceipt(r,value.conversationId)); queueConsumer(value.consumer);
    } else if (operation === 'queue.consumer.stop') queueConsumer(value.consumer);
    else queueReceipt(value.receipt,value.conversationId);
    return structuredClone(value);
  }
  if (operation === 'directory.sync') {
    object(value, ['projects', 'directories']); output('projects.sync', { projects: value.projects });
    if (!Array.isArray(value.directories) || value.directories.length !== value.projects.length || new Set(value.projects.map(p => p.id)).size !== value.projects.length) fail('invalid_directory');
    const projects = new Set(value.projects.map(p => p.id)), seen = new Set(), threads = new Set();
    for (const entry of value.directories) {
      object(entry, ['projectId', 'conversations', 'nextCursor']);
      if (!projects.has(entry.projectId) || seen.has(entry.projectId)) fail('invalid_directory'); seen.add(entry.projectId);
      output('sessions.sync', { conversations: entry.conversations, nextCursor: entry.nextCursor });
      for (const c of entry.conversations) { if (c.projectId !== entry.projectId || threads.has(c.id)) fail('invalid_directory'); threads.add(c.id); }
    }
    return structuredClone(value);
  }
  if (operation === 'sessions.sync') {
    object(value, ['conversations', 'nextCursor']);
    if (!Array.isArray(value.conversations) || value.conversations.length > 100) fail('invalid_conversations');
    value.conversations.forEach(conversation); if (value.nextCursor !== null) string(value.nextCursor, 1000); return structuredClone(value);
  }
  if (operation === 'conversation.snapshot') {
    object(value, ['conversation', 'messages', 'approvals', 'nextCursor', 'assets', 'activeTurnId'], ['conversation', 'messages', 'approvals', 'nextCursor', 'assets']);
    if (value.activeTurnId != null) identifier(value.activeTurnId); conversation(value.conversation);
    if (!Array.isArray(value.messages) || value.messages.length > 100 || !Array.isArray(value.approvals) || value.approvals.length > 20 || !Array.isArray(value.assets) || value.assets.length > 5) fail('invalid_snapshot');
    for (const message of value.messages) {
      object(message, ['id', 'role', 'text', 'attachmentIds', 'kind'], ['id', 'role', 'text', 'attachmentIds']); identifier(message.id); string(message.text, 65536, 0);
      if (!['user', 'assistant', 'system'].includes(message.role) || !Array.isArray(message.attachmentIds) || message.attachmentIds.length > 5) fail('invalid_message');
      // Optional provenance label so the UI can distinguish tool output from
      // assistant prose without widening the existing role set.
      if (message.kind !== undefined && !['text', 'reasoning', 'command', 'fileChange', 'mcpToolCall', 'webSearch', 'plan', 'imageGeneration'].includes(message.kind)) fail('invalid_message_kind');
      message.attachmentIds.forEach(identifier);
    }
    for (const approval of value.approvals) {
      object(approval, ['id', 'kind', 'summary', 'questions'], ['id', 'kind', 'summary']); identifier(approval.id); string(approval.kind, 40); string(approval.summary, 4000, 0);
      if (approval.questions !== undefined) {
        if (!Array.isArray(approval.questions) || approval.questions.length > 10) fail('invalid_questions');
        for (const question of approval.questions) { object(question, ['id', 'label', 'options']); identifier(question.id); string(question.label, 2000); if (!Array.isArray(question.options) || question.options.length > 20) fail('invalid_options'); question.options.forEach(value => string(value, 500)); }
      }
    }
    if (value.assets.length) fail('assets_not_supported_yet');
    if (value.nextCursor !== null) string(value.nextCursor, 1000);
    return structuredClone(value);
  }
  if (operation === 'attachment.stage') { object(value, ['conversationId', 'attachmentId', 'status']); identifier(value.conversationId); identifier(value.attachmentId); if (value.status !== 'staged') fail('invalid_attachment_status'); return structuredClone(value); }
  if (operation === 'turn.cancel') { object(value, ['conversationId', 'turnId', 'status']); identifier(value.conversationId); identifier(value.turnId); if (value.status !== 'interrupt_requested') fail('invalid_turn_status'); return structuredClone(value); }
  if (operation === 'approval.resolve') { object(value, ['conversationId', 'approvalId', 'status']); identifier(value.conversationId); identifier(value.approvalId); if (value.status !== 'resolved') fail('invalid_approval_status'); return structuredClone(value); }
  if (operation === 'turn.start') { object(value, ['conversationId', 'turnId', 'status']); identifier(value.conversationId); identifier(value.turnId); if (value.status !== 'running') fail('invalid_turn_status'); return structuredClone(value); }
  if (operation === 'projects.sync') {
    object(value, ['projects']);
    if (!Array.isArray(value.projects) || value.projects.length > 1000) fail('invalid_projects');
    for (const project of value.projects) { object(project, ['id', 'name', 'available'], ['id', 'name']); identifier(project.id); string(project.name, 100); if (project.available !== undefined && typeof project.available !== 'boolean') fail('invalid_projects'); }
    return structuredClone(value);
  }
  if (operation !== 'conversation.create') fail('unsupported_operation');
  object(value, ['conversation']);
  conversation(value.conversation);
  return structuredClone(value);
}

export function businessEvent(value) {
  const base = ['eventId', 'type', 'jobId', 'conversationId', 'turnId'];
  if (value?.type === 'assistant.delta') { object(value, [...base, 'text']); string(value.text, 8192, 0); }
  else if (value?.type === 'turn.finished') { object(value, [...base, 'status']); if (!['completed', 'interrupted', 'failed'].includes(value.status)) fail('invalid_turn_status'); }
  else if (value?.type === 'turn.started' || value?.type === 'approval.pending') object(value, base);
  else fail('unsupported_event');
  ['eventId', 'jobId', 'conversationId', 'turnId'].forEach(key => identifier(value[key]));
  return structuredClone(value);
}

export function validateImage(mime, base64) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime) || typeof base64 !== 'string' || base64.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail('invalid_image');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== base64) fail('invalid_image');
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) fail('image_type_mismatch'); return bytes;
}
