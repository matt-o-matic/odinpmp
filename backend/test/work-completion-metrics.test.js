import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectWorkItems,
  diffWorkCompletion,
  isWorkItemDone,
  loadWorkflowDoneStates,
  recordWorkCompletionMetrics,
} from '../src/modules/metrics/work-completion-metrics.js';
import { createInMemoryMetricsRepository } from '../src/modules/metrics/metrics.repository.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';

function project({ storyStatus = 'In Progress', tasks = [], tickets = [], storyExtra = {} } = {}) {
  return {
    epics: [{
      id: 'epic-1',
      status: 'In Progress',
      stories: [{ id: 'story-1', points: 99, status: storyStatus, tasks, ...storyExtra }],
    }],
    tickets,
  };
}

function task(id, status, extra = {}) {
  return { assigneeId: 'user-ada', id, points: 3, status, ...extra };
}

test('done means Completed for planning items and a done-category state for tickets', () => {
  assert.equal(isWorkItemDone('task', 'Completed'), true);
  assert.equal(isWorkItemDone('story', 'Review'), false);
  assert.equal(isWorkItemDone('ticket', 'closed'), true);
  assert.equal(isWorkItemDone('ticket', 'resolved'), false);
  assert.equal(isWorkItemDone('ticket', 'Completed'), false);
});

test('only items without children are leaves', () => {
  const items = collectWorkItems(project({ tasks: [task('task-1', 'Not Started')], tickets: [{ id: 'ticket-1', status: 'new' }] }));
  assert.deepEqual([...items.entries()].map(([id, entry]) => [id, entry.itemType, entry.leaf]), [
    ['epic-1', 'epic', false],
    ['story-1', 'story', false],
    ['task-1', 'task', true],
    ['ticket-1', 'ticket', true],
  ]);
});

test('completing a task credits its assignee with one item and its points', () => {
  const before = project({ tasks: [task('task-1', 'In Progress')] });
  const after = project({ tasks: [task('task-1', 'Completed')] });
  assert.deepEqual(diffWorkCompletion({ actorUserId: 'user-grace', after, before }), [
    { hoursLogged: 0, pointsCompleted: 3, tasksCompleted: 1, userId: 'user-ada' },
  ]);
});

test('reopening a completed task takes the credit back', () => {
  const before = project({ tasks: [task('task-1', 'Completed')] });
  const after = project({ tasks: [task('task-1', 'In Progress')] });
  assert.deepEqual(diffWorkCompletion({ actorUserId: 'user-grace', after, before }), [
    { hoursLogged: 0, pointsCompleted: -3, tasksCompleted: -1, userId: 'user-ada' },
  ]);
});

test('a repeated save that changes no status records nothing', () => {
  const snapshot = project({ storyStatus: 'Completed', tasks: [task('task-1', 'Completed'), task('task-2', 'Completed')] });
  assert.deepEqual(diffWorkCompletion({ actorUserId: 'user-grace', after: structuredClone(snapshot), before: snapshot }), []);
});

test('a story completion cascade credits each task, not the story whose points roll up', () => {
  const before = project({ tasks: [task('task-1', 'Completed'), task('task-2', 'Not Started'), task('task-3', 'In Progress', { assigneeId: 'user-alan', points: 5 })] });
  const after = project({ storyStatus: 'Completed', tasks: [task('task-1', 'Completed'), task('task-2', 'Completed'), task('task-3', 'Completed', { assigneeId: 'user-alan', points: 5 })] });
  assert.deepEqual(diffWorkCompletion({ actorUserId: 'user-grace', after, before }), [
    { hoursLogged: 0, pointsCompleted: 3, tasksCompleted: 1, userId: 'user-ada' },
    { hoursLogged: 0, pointsCompleted: 5, tasksCompleted: 1, userId: 'user-alan' },
  ]);
});

test('a story without tasks earns its own points', () => {
  const before = project({ storyExtra: { assigneeId: 'user-ada', points: 8 } });
  const after = project({ storyExtra: { assigneeId: 'user-ada', points: 8 }, storyStatus: 'Completed' });
  assert.deepEqual(diffWorkCompletion({ after, before }), [
    { hoursLogged: 0, pointsCompleted: 8, tasksCompleted: 1, userId: 'user-ada' },
  ]);
});

test('unassigned work credits the person who completed it, and nobody when there is no actor', () => {
  const before = project({ tasks: [task('task-1', 'In Progress', { assigneeId: null, points: null })] });
  const after = project({ tasks: [task('task-1', 'Completed', { assigneeId: null, points: null })] });
  assert.deepEqual(diffWorkCompletion({ actorUserId: 'user-grace', after, before }), [
    { hoursLogged: 0, pointsCompleted: 0, tasksCompleted: 1, userId: 'user-grace' },
  ]);
  assert.deepEqual(diffWorkCompletion({ after, before }), []);
});

test('reassigning done work moves its credit to the new assignee', () => {
  const before = project({ tasks: [task('task-1', 'Completed')] });
  const after = project({ tasks: [task('task-1', 'Completed', { assigneeId: 'user-alan' })] });
  assert.deepEqual(diffWorkCompletion({ actorUserId: 'user-grace', after, before }), [
    { hoursLogged: 0, pointsCompleted: -3, tasksCompleted: -1, userId: 'user-ada' },
    { hoursLogged: 0, pointsCompleted: 3, tasksCompleted: 1, userId: 'user-alan' },
  ]);
});

test('created and deleted items are ignored', () => {
  const before = project({ tasks: [task('task-1', 'Completed')] });
  const after = project({ tasks: [task('task-2', 'Completed')] });
  assert.deepEqual(diffWorkCompletion({ actorUserId: 'user-grace', after, before }), []);
});

test('closing a ticket credits its assignee', () => {
  const before = { tickets: [{ assigneeId: 'user-ada', id: 'ticket-1', points: 2, status: 'resolved' }] };
  const after = { tickets: [{ assigneeId: 'user-ada', id: 'ticket-1', points: 2, status: 'closed' }] };
  assert.deepEqual(diffWorkCompletion({ after, before }), [
    { hoursLogged: 0, pointsCompleted: 2, tasksCompleted: 1, userId: 'user-ada' },
  ]);
});

test('actual hours changes are recorded against the owner after the change', () => {
  const before = project({ storyExtra: { actualHours: 4, assigneeId: 'user-alan' }, tasks: [task('task-1', 'In Progress', { actualHours: 1.5 })] });
  const after = project({ storyExtra: { actualHours: 3, assigneeId: 'user-alan' }, tasks: [task('task-1', 'In Progress', { actualHours: 4 })] });
  assert.deepEqual(diffWorkCompletion({ after, before }), [
    { hoursLogged: 2.5, pointsCompleted: 0, tasksCompleted: 0, userId: 'user-ada' },
    { hoursLogged: -1, pointsCompleted: 0, tasksCompleted: 0, userId: 'user-alan' },
  ]);
});

test('recording writes each delta and keeps going when the repository fails', async () => {
  const repository = createInMemoryMetricsRepository();
  const before = project({ tasks: [task('task-1', 'In Progress'), task('task-2', 'In Progress', { assigneeId: 'user-alan' })] });
  const after = project({ tasks: [task('task-1', 'Completed'), task('task-2', 'Completed', { assigneeId: 'user-alan' })] });
  const failing = {
    async record(entry) {
      if (entry.userId === 'user-alan') throw new Error('metrics unavailable');
      return repository.record(entry);
    },
  };
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (entry) => logged.push(JSON.parse(entry));
  try {
    const deltas = await recordWorkCompletionMetrics({ actorUserId: 'user-grace', after, before, metricsRepository: failing, projectId: 'project-1', tenantId: 'tenant-1' });
    assert.equal(deltas.length, 2);
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(repository.rows.map((row) => [row.userId, row.projectId, row.tasksCompleted, row.pointsCompleted]), [['user-ada', 'project-1', 1, 3]]);
  assert.equal(logged[0].message, 'Contributor metrics could not be recorded.');
  assert.equal(logged[0].level, 'warn');
  assert.equal(logged[0].context.userId, 'user-alan');
});

test('recording is a no-op without a metrics repository, a project, or a baseline', async () => {
  const after = project({ tasks: [task('task-1', 'Completed')] });
  const before = project({ tasks: [task('task-1', 'In Progress')] });
  const repository = createInMemoryMetricsRepository();
  assert.deepEqual(await recordWorkCompletionMetrics({ after, before, metricsRepository: null, projectId: 'project-1', tenantId: 'tenant-1' }), []);
  assert.deepEqual(await recordWorkCompletionMetrics({ after, before, metricsRepository: repository, tenantId: 'tenant-1' }), []);
  assert.deepEqual(await recordWorkCompletionMetrics({ after, before: null, metricsRepository: repository, projectId: 'project-1', tenantId: 'tenant-1' }), []);
  assert.deepEqual(repository.rows, []);
});

async function taskWorkflowRepository(projectId = 'project-1') {
  const repository = createInMemoryWorkflowRepository();
  const state = (key, category, extra = {}) => ({ category, initial: false, key, label: key, requiredFields: [], slaHours: 0, terminal: false, ...extra });
  const workflow = await repository.createWorkflow({
    input: {
      description: '', itemTypes: ['task'], name: 'Delivery flow', status: 'active', transitions: [],
      states: [state('Doing', 'active', { initial: true }), state('Shipped', 'done', { terminal: true }), state('Dropped', 'cancelled', { terminal: true })],
    },
    tenantId: 'tenant-1',
  });
  await repository.createBinding({ input: { itemType: 'task', projectId, workflowId: workflow.id }, tenantId: 'tenant-1' });
  return repository;
}

test('a done-category state of the workflow bound to an item type counts as done', async () => {
  const doneStates = await loadWorkflowDoneStates({ projectId: 'project-1', tenantId: 'tenant-1', workflowRepository: await taskWorkflowRepository() });
  assert.equal(isWorkItemDone('task', 'Shipped', doneStates), true);
  assert.equal(isWorkItemDone('task', 'Dropped', doneStates), false, 'cancelled states earn nothing');
  assert.equal(isWorkItemDone('task', 'Doing', doneStates), false);
  // A status the bound workflow doesn't define, and types it doesn't cover, keep the default rule.
  assert.equal(isWorkItemDone('task', 'Completed', doneStates), true);
  assert.equal(isWorkItemDone('story', 'Shipped', doneStates), false);
  assert.equal(isWorkItemDone('ticket', 'closed', doneStates), true);

  const otherProject = await loadWorkflowDoneStates({ projectId: 'project-2', tenantId: 'tenant-1', workflowRepository: await taskWorkflowRepository() });
  assert.equal(isWorkItemDone('task', 'Shipped', otherProject), false, 'bindings are per project');
  assert.equal(await loadWorkflowDoneStates({ projectId: 'project-1', tenantId: 'tenant-1', workflowRepository: null }), null);
});

test('recording credits and reverses custom workflow done states through the bound workflow', async () => {
  const metricsRepository = createInMemoryMetricsRepository();
  const workflowRepository = await taskWorkflowRepository();
  const record = (from, to) => recordWorkCompletionMetrics({
    actorUserId: 'user-grace', after: project({ tasks: [task('task-1', to)] }), before: project({ tasks: [task('task-1', from)] }),
    metricsRepository, projectId: 'project-1', tenantId: 'tenant-1', workflowRepository,
  });

  assert.deepEqual(await record('Doing', 'Shipped'), [{ hoursLogged: 0, pointsCompleted: 3, tasksCompleted: 1, userId: 'user-ada' }]);
  assert.deepEqual(await record('Shipped', 'Doing'), [{ hoursLogged: 0, pointsCompleted: -3, tasksCompleted: -1, userId: 'user-ada' }]);
  assert.deepEqual(await record('Doing', 'Dropped'), []);
  // Without the workflow the same move earns nothing, as before.
  assert.deepEqual(diffWorkCompletion({ after: project({ tasks: [task('task-1', 'Shipped')] }), before: project({ tasks: [task('task-1', 'Doing')] }) }), []);
});
