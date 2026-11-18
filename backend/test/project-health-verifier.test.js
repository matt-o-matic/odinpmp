import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyProjectHealth } from '../src/modules/governance/project-health-verifier.js';

const project = {
  endDate: '2026-07-31',
  epics: [{ id: 'epic-1', stories: [{ id: 'story-1', tasks: [
    { id: 'task-1', targetEndDate: '2026-07-05', targetStartDate: '2026-07-01' },
    { id: 'task-2', targetEndDate: '2026-07-10', targetStartDate: '2026-07-06' },
  ] }] }],
};

test('project health verifier returns evidence for a passing PM state', () => {
  const result = verifyProjectHealth({
    now: new Date('2026-07-11T12:00:00Z'),
    project,
    snapshot: {
      dependencies: [{ id: 'dep-1', predecessorId: 'task-1', successorId: 'task-2' }],
      items: [{ dueDate: '2026-07-20', id: 'risk-1', impact: 'high', kind: 'risk', status: 'monitoring', title: 'Vendor' }],
      milestones: [{ id: 'milestone-1', status: 'planned', targetDate: '2026-07-31', title: 'Launch' }],
    },
  });

  assert.equal(result.verifier, 'project_health.v1');
  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCheckIds, []);
  assert.deepEqual(result.evidence.schedule.criticalPathIds, ['task-1', 'task-2']);
});

test('project health verifier fails with precise schedule, milestone, and governance evidence', () => {
  const result = verifyProjectHealth({
    now: new Date('2026-07-11T12:00:00Z'),
    project,
    snapshot: {
      dependencies: [
        { id: 'dep-cycle-a', predecessorId: 'task-1', successorId: 'task-2' },
        { id: 'dep-cycle-b', predecessorId: 'task-2', successorId: 'task-1' },
        { id: 'dep-missing', predecessorId: 'missing', successorId: 'task-1' },
      ],
      items: [
        { dueDate: '2026-07-01', id: 'risk-1', impact: 'critical', kind: 'risk', status: 'open', title: 'Launch blocker' },
      ],
      milestones: [{ id: 'milestone-1', status: 'at_risk', targetDate: '2026-07-01', title: 'Readiness' }],
    },
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failedCheckIds, [
    'schedule.no_cycles',
    'schedule.valid_references',
    'milestones.not_overdue',
    'governance.no_open_critical_risks',
    'governance.no_overdue_actions',
  ]);
  assert.equal(result.checks.find((entry) => entry.id === 'schedule.valid_references').evidence[0].dependencyId, 'dep-missing');
});
