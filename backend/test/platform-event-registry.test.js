import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_PLATFORM_EVENT_REGISTRY, PLATFORM_EVENT_TYPES } from '../src/modules/platform/platform-event-registry.js';

test('platform event registry owns every emitted public event with a stable schema URI', () => {
  assert.deepEqual(PLATFORM_EVENT_TYPES, ['agent.goal.attention', 'governance.changed', 'workflow.sla.overdue', 'workflow.transitioned']);
  assert.equal(DEFAULT_PLATFORM_EVENT_REGISTRY.list().length, 4);
  assert.equal(DEFAULT_PLATFORM_EVENT_REGISTRY.get('workflow.transitioned').schemaUri, 'urn:odin:event-schema:workflow.transitioned:1.0.0');
  const normalized = DEFAULT_PLATFORM_EVENT_REGISTRY.normalize({ eventType: 'workflow.transitioned', payload: { historyId: 'history-1', itemId: 'task-1', itemType: 'task', projectId: 'project-1', toState: 'done', transitionKey: 'complete' } });
  assert.equal(normalized.payload.schemaVersion, '1.0.0');
});

test('platform event registry rejects unknown, incomplete, and oversized payloads', () => {
  assert.throws(() => DEFAULT_PLATFORM_EVENT_REGISTRY.normalize({ eventType: 'unknown', payload: {} }), (error) => error.statusCode === 400);
  assert.throws(() => DEFAULT_PLATFORM_EVENT_REGISTRY.normalize({ eventType: 'governance.changed', payload: { action: 'created' } }), (error) => error.statusCode === 422);
  assert.throws(() => DEFAULT_PLATFORM_EVENT_REGISTRY.normalize({ eventType: 'governance.changed', payload: { action: 'created', entityType: 'governance_item', note: 'x'.repeat(70_000) } }), (error) => error.statusCode === 413);
});
