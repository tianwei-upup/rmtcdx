import { object, identifier, fail, QUEUE_OPERATIONS } from './contracts.mjs';

// An explicit single-project grant, never a wildcard or a catalog-derived grant.
export function queueTestScope(value) {
  if (value == null) return null;
  object(value, ['mode', 'deviceId', 'projectId', 'conversationId']);
  if (value.mode !== 'dedicated-test') fail('dedicated_queue_scope_required');
  for (const key of ['deviceId', 'projectId', 'conversationId']) identifier(value[key]);
  return Object.freeze({ ...value });
}
export const SCOPED_QUEUE_OPERATIONS = ['projects.sync', 'directory.sync', 'sessions.sync', ...QUEUE_OPERATIONS];
