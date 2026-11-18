import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyWorkItemStatus,
  isLeafWorkItem,
  normalizeActualHours,
  summarizeWorkProgress,
} from '../src/lib/projects/work-progress.js';

test('actual hours round to the hundredth and total across work items', () => {
  assert.equal(normalizeActualHours(''), null);
  assert.equal(normalizeActualHours('2.344'), 2.34);
  assert.equal(normalizeActualHours(-2), 0);

  const summary = summarizeWorkProgress('story', {
    status: 'In Progress',
    tasks: [{ actualHours: 2.5, status: 'Completed' }, { actualHours: 1.25, status: 'In Progress' }, { status: 'Not Started' }],
  });
  assert.deepEqual(summary.actual, { hours: 3.75, itemCount: 2 });
});

function bucket(summary, key) {
  return summary.buckets.find((entry) => entry.key === key);
}

test('a completed story without tasks shows a full done bar', () => {
  const summary = summarizeWorkProgress('story', { status: 'Completed', targetHourEstimate: 16, tasks: [] });

  assert.equal(summary.percentComplete, 100);
  assert.equal(bucket(summary, 'done').share, 100);
  assert.equal(bucket(summary, 'done').itemCount, 1);
  assert.equal(summary.itemCount, 1);
});

test('progress weights items by estimate and credits in-flight work by its percent complete', () => {
  const summary = summarizeWorkProgress('story', {
    status: 'In Progress',
    tasks: [
      { status: 'Completed', targetHourEstimate: 30 },
      { percentComplete: 25, status: 'In Progress', targetHourEstimate: 8 },
      { status: 'Review', targetHourEstimate: 10 },
      { status: 'Not Started', points: 1 },
      { status: 'At Risk' },
    ],
  });

  // Earned 30 + 2 + 8 + 0 + 8 = 48 of 30 + 8 + 10 + 8 + 16 = 72 hours.
  assert.equal(summary.totalHours, 72);
  assert.equal(summary.earnedHours, 48);
  assert.equal(summary.percentComplete, 67);
  assert.equal(summary.inFlightEarnedHours, 18);
  assert.deepEqual(
    summary.buckets.map(({ hours, itemCount, key }) => [key, hours, itemCount]),
    [['done', 48, 1], ['active', 6, 1], ['review', 2, 1], ['risk', 8, 1], ['backlog', 8, 1]],
  );
  assert.deepEqual(summary.assumptions, { defaultEstimateCount: 1, defaultPercentCount: 2, pointsEstimateCount: 1 });
});

test('a completed story counts its open tasks as done', () => {
  const summary = summarizeWorkProgress('epic', {
    stories: [
      { status: 'Completed', tasks: [{ status: 'In Progress' }, { status: 'Not Started' }] },
      { status: 'Not Started', tasks: [{ status: 'Not Started' }] },
    ],
  });

  assert.equal(bucket(summary, 'done').itemCount, 2);
  assert.equal(summary.percentComplete, 67);
});

test('percent complete stays below 100 until every hour is earned', () => {
  const tasks = Array.from({ length: 199 }, () => ({ status: 'Completed', targetHourEstimate: 1 }));
  tasks.push({ status: 'Not Started', targetHourEstimate: 1 });

  assert.equal(summarizeWorkProgress('story', { status: 'In Progress', tasks }).percentComplete, 99);
  assert.equal(summarizeWorkProgress('project', { epics: [] }).percentComplete, 0);
});

test('isLeafWorkItem treats childless stories and epics as single work items', () => {
  assert.equal(isLeafWorkItem('story', { tasks: [] }), true);
  assert.equal(isLeafWorkItem('story', { tasks: [{}] }), false);
  assert.equal(isLeafWorkItem('epic', { stories: [] }), true);
  assert.equal(isLeafWorkItem('task', {}), true);
  assert.equal(isLeafWorkItem('project', { epics: [] }), false);
});

test('completing a story completes its open tasks and undoing it restores them', () => {
  const memory = new Map();
  const story = {
    id: 'story-1',
    status: 'In Progress',
    tasks: [
      { boardColumn: 'doing', id: 'task-1', status: 'In Progress' },
      { boardColumn: null, id: 'task-2', status: 'Completed' },
      { boardColumn: null, id: 'task-3', status: 'Not Started' },
    ],
  };

  applyWorkItemStatus('story', story, 'Completed', memory);
  assert.deepEqual(story.tasks.map((task) => task.status), ['Completed', 'Completed', 'Completed']);
  assert.equal(story.tasks[0].boardColumn, null);

  applyWorkItemStatus('story', story, 'Review', memory);
  assert.equal(story.status, 'Review');
  assert.deepEqual(story.tasks.map((task) => task.status), ['In Progress', 'Completed', 'Not Started']);
  assert.equal(story.tasks[0].boardColumn, 'doing');
  assert.equal(memory.size, 0);
});

test('changing a task or epic status never cascades', () => {
  const epic = { id: 'epic-1', status: 'In Progress', stories: [{ id: 'story-1', status: 'In Progress', tasks: [] }] };
  applyWorkItemStatus('epic', epic, 'Completed');
  assert.equal(epic.stories[0].status, 'In Progress');
});
