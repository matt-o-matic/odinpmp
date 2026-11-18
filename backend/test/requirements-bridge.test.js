import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequirementsAssistantBridge } from '../src/modules/requirements/requirements-bridge.js';

test('older-route activity on a tracked topic publishes a live update and schedules a summary refresh', async () => {
  const published = [];
  const noted = [];
  const bridge = createRequirementsAssistantBridge({
    liveEventBus: { publish: (channel, event) => published.push({ channel, event }) },
    requirementsRepository: { listAccessLinks: async () => [] },
    summaries: { noteTopicActivity: (input) => noted.push(input) },
  });

  bridge.onTrackedTopicActivity({ projectId: 'project-1', reason: 'comment-created', tenantId: 'tenant-1', topicId: 'topic-1' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(published.map(({ channel, event }) => [channel, event.type, event.topicIds]), [
    ['project:project-1', 'requirements.topics.invalidated', ['topic-1']],
  ]);
  assert.deepEqual(noted, [{ projectId: 'project-1', reason: 'comment-created', tenantId: 'tenant-1', topicIds: ['topic-1'] }]);
});

test('a failing link lookup never fails the caller', async () => {
  const bridge = createRequirementsAssistantBridge({
    liveEventBus: { publish: () => {} },
    requirementsRepository: { listAccessLinks: async () => { throw new Error('database down'); } },
  });
  assert.doesNotThrow(() => bridge.onTrackedTopicActivity({ projectId: 'p', reason: 'comment-created', tenantId: 't', topicId: 'x' }));
  await new Promise((resolve) => setImmediate(resolve));
});

test('activity without a topic id does nothing', () => {
  const published = [];
  const bridge = createRequirementsAssistantBridge({ liveEventBus: { publish: (...args) => published.push(args) }, requirementsRepository: {} });
  bridge.onTrackedTopicActivity({ projectId: 'p', reason: 'comment-created', tenantId: 't', topicId: '' });
  assert.equal(published.length, 0);
});
