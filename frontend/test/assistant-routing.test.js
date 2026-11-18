import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAssistantRouteQuery,
  createAssistantRouteSignature,
  parseAssistantRouteQuery,
} from '../src/lib/assistant/assistant-routing.js';

test('parseAssistantRouteQuery prefers an explicit session id when present', () => {
  const parsed = parseAssistantRouteQuery({
    assistant: '1',
    assistantMode: 'project-context',
    assistantProjectId: 'project-42',
    assistantSessionId: 'session-9',
  });

  assert.deepEqual(parsed, {
    fresh: false,
    mode: 'project-context',
    open: true,
    projectId: 'project-42',
    sessionId: 'session-9',
  });
  assert.equal(createAssistantRouteSignature(parsed), 'session:session-9');
});

test('buildAssistantRouteQuery preserves unrelated query params while supporting explicit sessions and fresh context', () => {
  const explicitSession = buildAssistantRouteQuery(
    {
      filter: 'active',
      page: '2',
    },
    {
      open: true,
      sessionId: 'session-9',
    },
  );

  assert.deepEqual(explicitSession, {
    assistant: '1',
    assistantSessionId: 'session-9',
    filter: 'active',
    page: '2',
  });

  const freshProject = buildAssistantRouteQuery(explicitSession, {
    fresh: true,
    mode: 'project-context',
    open: true,
    projectId: 'project-42',
  });

  assert.deepEqual(freshProject, {
    assistant: '1',
    assistantFresh: '1',
    assistantMode: 'project-context',
    assistantProjectId: 'project-42',
    filter: 'active',
    page: '2',
  });
  assert.equal(createAssistantRouteSignature(parseAssistantRouteQuery(freshProject)), 'project-context:project-42:fresh');

  const closed = buildAssistantRouteQuery(freshProject, {
    open: false,
  });

  assert.deepEqual(closed, {
    filter: 'active',
    page: '2',
  });
  assert.equal(createAssistantRouteSignature(parseAssistantRouteQuery(closed)), 'closed');
});
