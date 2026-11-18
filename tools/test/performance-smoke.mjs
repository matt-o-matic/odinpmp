#!/usr/bin/env node
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { analyzeProjectSchedule } from '../../backend/src/modules/governance/schedule-analysis.js';
import { selectGovernanceItems } from '../../frontend/src/lib/projects/project-governance.js';

const scheduleLimitMs = Number(process.env.ODIN_TEST_SCHEDULE_LIMIT_MS ?? 2_000);
const registerLimitMs = Number(process.env.ODIN_TEST_REGISTER_LIMIT_MS ?? 1_000);
const taskCount = Number(process.env.ODIN_TEST_PERFORMANCE_TASKS ?? 10_000);
const registerCount = Number(process.env.ODIN_TEST_PERFORMANCE_REGISTER_ITEMS ?? 50_000);

const tasks = Array.from({ length: taskCount }, (_, index) => ({
  id: `task-${index}`,
  name: `Task ${index}`,
  targetEndDate: '2026-01-01',
  targetStartDate: '2026-01-01',
}));
const dependencies = tasks.slice(1).map((task, index) => ({
  dependencyType: 'FS', lagDays: 0, predecessorId: `task-${index}`, successorId: task.id,
}));
const scheduleStartedAt = performance.now();
const analysis = analyzeProjectSchedule({ epics: [{ id: 'epic', stories: [{ id: 'story', tasks }] }] }, dependencies);
const scheduleMs = performance.now() - scheduleStartedAt;
assert.equal(analysis.passed, true);
assert.equal(analysis.criticalPathIds.length, taskCount);
assert.ok(scheduleMs <= scheduleLimitMs, `Schedule analysis took ${scheduleMs.toFixed(1)}ms; limit is ${scheduleLimitMs}ms.`);

const register = Array.from({ length: registerCount }, (_, index) => ({
  description: `Synthetic portfolio risk ${index}`,
  id: `risk-${index}`,
  impact: index % 10 === 0 ? 'critical' : 'medium',
  kind: index % 3 === 0 ? 'risk' : 'issue',
  status: index % 5 === 0 ? 'resolved' : 'open',
  title: `Risk ${String(index).padStart(6, '0')}`,
  updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
}));
const registerStartedAt = performance.now();
const selected = selectGovernanceItems(register, {
  kind: 'risk', page: 10, pageSize: 50, query: 'portfolio risk', sort: 'impact_desc', status: 'open',
});
const registerMs = performance.now() - registerStartedAt;
assert.equal(selected.items.length, 50);
assert.ok(registerMs <= registerLimitMs, `Register query took ${registerMs.toFixed(1)}ms; limit is ${registerLimitMs}ms.`);

console.log(JSON.stringify({
  passed: true,
  register: { durationMs: Number(registerMs.toFixed(2)), itemCount: registerCount, limitMs: registerLimitMs },
  schedule: { dependencyCount: dependencies.length, durationMs: Number(scheduleMs.toFixed(2)), limitMs: scheduleLimitMs, taskCount },
}, null, 2));
