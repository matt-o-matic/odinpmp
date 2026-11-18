import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveEventBus } from '../src/lib/events/live-event-bus.js';
import {
  buildJobLogContext,
  buildOperationLogContext,
  buildRequestLogContext,
  logBackendError,
  logBackendEvent,
} from '../src/lib/logging/backend-logger.js';

test('buildRequestLogContext includes request and route identifiers', () => {
  const context = buildRequestLogContext({
    auth: {
      user: {
        id: 'user-123',
        memberships: [{ tenantId: 'tenant-456' }],
      },
    },
    body: { answer: 'yes' },
    method: 'PATCH',
    originalUrl: '/api/projects/project-1/clarifications/clarification-2',
    params: { clarificationId: 'clarification-2', projectId: 'project-1' },
    query: { focus: 'mail' },
    requestId: 'req-789',
    res: { headersSent: false },
    route: { path: '/api/projects/:projectId/clarifications/:clarificationId' },
  });

  assert.deepEqual(context, {
    bodyKeys: ['answer'],
    headersSent: false,
    method: 'PATCH',
    params: { clarificationId: 'clarification-2', projectId: 'project-1' },
    query: { focus: 'mail' },
    requestId: 'req-789',
    route: '/api/projects/project-1/clarifications/clarification-2',
    routePattern: '/api/projects/:projectId/clarifications/:clarificationId',
    tenantId: 'tenant-456',
    userId: 'user-123',
  });
});

test('buildOperationLogContext and buildJobLogContext normalize metadata', () => {
  const operationContext = buildOperationLogContext('assistant.turn', {
    projectId: 'project-1',
    sessionId: 'session-2',
  });
  const jobContext = buildJobLogContext('mail-queue', {
    emailId: 'email-3',
  });

  assert.deepEqual(operationContext, {
    operation: 'assistant.turn',
    projectId: 'project-1',
    sessionId: 'session-2',
  });
  assert.deepEqual(jobContext, {
    emailId: 'email-3',
    job: 'mail-queue',
  });
});

test('createLiveEventBus logs listener failures and continues fanout', () => {
  const bus = createLiveEventBus();
  const calls = [];
  const logEntries = [];
  const errorEntries = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  console.log = (entry) => {
    logEntries.push(JSON.parse(entry));
  };
  console.error = (entry) => {
    errorEntries.push(JSON.parse(entry));
  };

  try {
    bus.subscribe('project:123', () => {
      throw new Error('listener exploded');
    });
    bus.subscribe('project:123', (event) => {
      calls.push(event.type);
    });

    bus.publish('project:123', { type: 'project.invalidated' });
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  assert.deepEqual(calls, ['project.invalidated']);
  assert.equal(logEntries.length, 0);
  assert.equal(errorEntries.length, 1);
  assert.equal(errorEntries[0].level, 'warn');
  assert.equal(errorEntries[0].message, 'Live event listener failed.');
  assert.equal(errorEntries[0].context.channel, 'project:123');
  assert.equal(errorEntries[0].context.eventType, 'project.invalidated');
  assert.equal(errorEntries[0].error.message, 'listener exploded');
});

test('logBackendEvent writes info to stdout and warning/error entries to stderr', () => {
  const stdoutEntries = [];
  const stderrEntries = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  console.log = (entry) => {
    stdoutEntries.push(JSON.parse(entry));
  };
  console.error = (entry) => {
    stderrEntries.push(JSON.parse(entry));
  };

  try {
    logBackendEvent({
      context: buildOperationLogContext('metrics.record', {
        userId: 'user-123',
      }),
      level: 'info',
      message: 'Metrics recorded.',
    });
    logBackendError({
      context: buildOperationLogContext('users.updateProfile', {
        userId: 'user-123',
      }),
      error: new Error('avatar exploded'),
      level: 'warn',
      message: 'Users repository operation failed.',
    });
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  assert.equal(stdoutEntries.length, 1);
  assert.equal(stdoutEntries[0].level, 'info');
  assert.equal(stdoutEntries[0].message, 'Metrics recorded.');
  assert.equal(stdoutEntries[0].context.operation, 'metrics.record');

  assert.equal(stderrEntries.length, 1);
  assert.equal(stderrEntries[0].level, 'warn');
  assert.equal(stderrEntries[0].message, 'Users repository operation failed.');
  assert.equal(stderrEntries[0].context.operation, 'users.updateProfile');
  assert.equal(stderrEntries[0].error.message, 'avatar exploded');
});
