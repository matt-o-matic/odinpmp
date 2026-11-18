import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cascadeStoryCompletion,
  completionFor,
  estimateHoursFor,
  normalizePercentComplete,
  workProgressPercent,
} from '../src/lib/projects/work-progress.js';

test('estimateHoursFor prefers hours, then points at 8h each, then the 16h default', () => {
  assert.deepEqual(estimateHoursFor({ points: 2, targetHourEstimate: 6 }), { hours: 6, source: 'hours' });
  assert.deepEqual(estimateHoursFor({ points: 3, targetHourEstimate: null }), { hours: 24, source: 'points' });
  assert.deepEqual(estimateHoursFor({ points: null, targetHourEstimate: 0 }), { hours: 16, source: 'default' });
  assert.deepEqual(estimateHoursFor({}), { hours: 16, source: 'default' });
});

test('completionFor uses the percent complete for in-flight work and status defaults otherwise', () => {
  assert.equal(completionFor({ status: 'Completed', percentComplete: 10 }).percent, 100);
  assert.equal(completionFor({ status: 'Not Started', percentComplete: 40 }).percent, 0);
  assert.deepEqual(completionFor({ status: 'In Progress', percentComplete: 30 }), { assumed: false, percent: 30, status: 'In Progress' });
  assert.deepEqual(completionFor({ status: 'In Progress' }), { assumed: true, percent: 50, status: 'In Progress' });
  assert.equal(completionFor({ status: 'At Risk' }).percent, 50);
  assert.equal(completionFor({ status: 'Review' }).percent, 80);
  assert.equal(completionFor({ status: 'In Progress' }, { forceCompleted: true }).percent, 100);
});

test('normalizePercentComplete clamps and rounds', () => {
  assert.equal(normalizePercentComplete(''), null);
  assert.equal(normalizePercentComplete(null), null);
  assert.equal(normalizePercentComplete(140), 100);
  assert.equal(normalizePercentComplete(-5), 0);
  assert.equal(normalizePercentComplete('37.6'), 38);
});

test('workProgressPercent weights leaves by estimate', () => {
  const story = {
    status: 'In Progress',
    tasks: [
      { status: 'Completed', targetHourEstimate: 30 },
      { percentComplete: 25, status: 'In Progress', targetHourEstimate: 8 },
      { status: 'Not Started', points: 1 },
      { status: 'In Progress' },
    ],
  };

  // Earned 30 + 2 + 0 + 8 of 30 + 8 + 8 + 16 hours.
  assert.equal(workProgressPercent('story', story), 64.5);
});

test('a completed story without tasks is fully complete and counts as its own work item', () => {
  const epic = {
    stories: [
      { status: 'Completed', targetHourEstimate: 16, tasks: [] },
      { status: 'Not Started', targetHourEstimate: 16, tasks: [] },
    ],
  };

  assert.equal(workProgressPercent('story', epic.stories[0]), 100);
  assert.equal(workProgressPercent('epic', epic), 50);
  assert.equal(workProgressPercent('project', { epics: [epic, { stories: [], status: 'Completed' }] }), 66.7);
  assert.equal(workProgressPercent('project', { epics: [] }), 0);
});

test('a completed story counts its tasks as completed', () => {
  const story = { status: 'Completed', tasks: [{ status: 'Not Started' }, { status: 'In Progress' }] };
  assert.equal(workProgressPercent('story', story), 100);
});

test('cascadeStoryCompletion completes open tasks only when a story becomes completed', () => {
  const previous = [{
    stories: [
      { id: 'story-a', status: 'In Progress', tasks: [] },
      { id: 'story-b', status: 'Completed', tasks: [] },
    ],
  }];
  const next = [{
    stories: [
      { id: 'story-a', status: 'Completed', tasks: [{ id: 'task-1', status: 'In Progress' }, { id: 'task-2', status: 'Completed' }] },
      { id: 'story-b', status: 'Completed', tasks: [{ id: 'task-3', status: 'In Progress' }] },
      { id: 'story-new', status: 'Completed', tasks: [{ id: 'task-4', status: 'Not Started' }] },
    ],
  }];

  assert.deepEqual(cascadeStoryCompletion(previous, next), ['task-1', 'task-4']);
  assert.equal(next[0].stories[0].tasks[0].status, 'Completed');
  // A task reopened under an already completed story stays open.
  assert.equal(next[0].stories[1].tasks[0].status, 'In Progress');
});
