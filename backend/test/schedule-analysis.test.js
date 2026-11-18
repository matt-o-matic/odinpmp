import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addWorkingDays,
  analyzeProjectSchedule,
  workingDaysBetween,
} from '../src/modules/governance/schedule-analysis.js';

const weekdayCalendar = {
  holidays: [],
  hoursPerDay: 8,
  timezone: 'America/New_York',
  workingDays: [1, 2, 3, 4, 5],
};

function projectWithTasks(tasks, overrides = {}) {
  return {
    endDate: '2026-07-31',
    epics: [{
      id: 'epic-1',
      name: 'Delivery',
      stories: [{ id: 'story-1', name: 'Launch', tasks }],
    }],
    id: 'project-1',
    startDate: '2026-07-06',
    ...overrides,
  };
}

test('working-day calendar excludes weekends and holidays and supports date projection', () => {
  const calendar = { ...weekdayCalendar, holidays: ['2026-07-06'] };
  assert.equal(workingDaysBetween('2026-07-03', '2026-07-06', calendar), 0);
  assert.equal(workingDaysBetween('2026-07-03', '2026-07-07', calendar), 1);
  assert.equal(workingDaysBetween('2026-07-03', '2026-07-07', calendar, { inclusive: true }), 2);
  assert.equal(addWorkingDays('2026-07-03', 1, calendar), '2026-07-07');
  assert.equal(addWorkingDays('2026-07-05', 0, calendar), '2026-07-07');
});

test('schedule analysis honors FS, SS, FF, and SF dependency semantics with lag', () => {
  const task = (id, end = '2026-07-06') => ({ id, name: id, targetEndDate: end, targetStartDate: '2026-07-06' });
  const project = projectWithTasks([
    task('a', '2026-07-07'), task('fs'), task('ss'), task('ff'), task('sf'),
  ]);
  const analysis = analyzeProjectSchedule(project, [
    { dependencyType: 'FS', lagDays: 0, predecessorId: 'a', successorId: 'fs' },
    { dependencyType: 'SS', lagDays: 1, predecessorId: 'a', successorId: 'ss' },
    { dependencyType: 'FF', lagDays: 0, predecessorId: 'a', successorId: 'ff' },
    { dependencyType: 'SF', lagDays: 2, predecessorId: 'a', successorId: 'sf' },
  ], { calendar: weekdayCalendar });
  const timings = new Map(analysis.itemTimings.map((item) => [item.id, item]));

  assert.equal(timings.get('a').durationWorkingDays, 2);
  assert.equal(timings.get('fs').startOffsetWorkingDays, 2);
  assert.equal(timings.get('ss').startOffsetWorkingDays, 1);
  assert.equal(timings.get('ff').startOffsetWorkingDays, 1);
  assert.equal(timings.get('sf').startOffsetWorkingDays, 1);
  assert.equal(analysis.forecastFinish, '2026-07-08');
  assert.deepEqual(analysis.criticalPathIds, ['a', 'fs']);
  assert.equal(timings.get('a').totalFloatWorkingDays, 0);
});

test('schedule analysis reports immutable baseline, scope, and linked milestone variance', () => {
  const project = projectWithTasks([
    { id: 'kept', name: 'Kept task', targetEndDate: '2026-07-13', targetStartDate: '2026-07-06' },
    { id: 'added', name: 'Added task', targetEndDate: '2026-07-14', targetStartDate: '2026-07-13' },
  ], { endDate: '2026-08-03' });
  const baseline = {
    capturedAt: '2026-07-01T12:00:00.000Z',
    id: 'baseline-1',
    name: 'Approved plan',
    snapshot: {
      calendar: weekdayCalendar,
      items: [
        { id: 'epic-1', name: 'Delivery', targetEndDate: null, targetStartDate: null, type: 'epic' },
        { id: 'story-1', name: 'Launch', targetEndDate: null, targetStartDate: null, type: 'story' },
        { id: 'kept', name: 'Kept task', targetEndDate: '2026-07-10', targetStartDate: '2026-07-06', type: 'task' },
        { id: 'removed', name: 'Removed task', targetEndDate: '2026-07-10', targetStartDate: '2026-07-06', type: 'task' },
      ],
      milestones: [{ id: 'milestone-1', targetDate: '2026-07-10', title: 'Ready', workItemId: 'kept' }],
      project: { endDate: '2026-07-31', startDate: '2026-07-06' },
    },
  };
  const analysis = analyzeProjectSchedule(project, [], {
    baseline,
    calendar: { ...weekdayCalendar, holidays: ['2026-07-13'] },
    milestones: [{ id: 'milestone-1', targetDate: '2026-07-13', title: 'Ready', workItemId: 'kept' }],
  });

  assert.equal(analysis.baselineVariance.baselineId, 'baseline-1');
  assert.equal(analysis.baselineVariance.itemVariances[0].finishVarianceWorkingDays, 1);
  assert.equal(analysis.baselineVariance.milestoneVariances[0].varianceWorkingDays, 1);
  assert.equal(analysis.baselineVariance.projectFinishVarianceWorkingDays, 1);
  assert.equal(analysis.baselineVariance.scopeAddedCount, 1);
  assert.equal(analysis.baselineVariance.scopeRemovedCount, 1);
  assert.equal(analysis.milestoneForecasts[0].forecastDate, '2026-07-10');
});
