import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeProjects } from '../src/lib/projects/project-merge.js';
import { createProjectStore } from '../src/lib/projects/project-store.js';
import {
  applyEstimateRollups,
  childEstimateTotals,
  usesChildEstimates,
} from '../src/lib/projects/work-estimates.js';

function createProject() {
  return {
    epics: [{
      estimateOverride: false,
      id: 'epic-1',
      name: 'Filing',
      points: 40,
      stories: [
        {
          estimateOverride: false,
          id: 'story-1',
          name: 'Transmit',
          points: 99,
          targetHourEstimate: 999,
          tasks: [
            { id: 'task-1', name: 'Adapter', points: 2, targetHourEstimate: 16, version: 1 },
            { id: 'task-2', name: 'Receipts', points: 3, targetHourEstimate: 24, version: 1 },
            { id: 'task-3', name: 'Unsized', points: null, targetHourEstimate: null, version: 1 },
          ],
          version: 1,
        },
        { estimateOverride: false, id: 'story-2', name: 'Corrections', points: 5, targetHourEstimate: 40, tasks: [], version: 1 },
      ],
      targetHourEstimate: 400,
      version: 1,
    }],
    id: 'project-1',
    name: 'ACA',
    status: 'In Progress',
    tenantId: 'tenant-1',
    updatedAt: '2026-10-07T12:00:00.000Z',
  };
}

test('items with children take their direct children totals; childless items keep their own', () => {
  const project = applyEstimateRollups(createProject());
  const [story, childless] = project.epics[0].stories;

  assert.deepEqual([story.points, story.targetHourEstimate], [5, 40]);
  assert.deepEqual([childless.points, childless.targetHourEstimate], [5, 40]);
  assert.deepEqual([project.epics[0].points, project.epics[0].targetHourEstimate], [10, 80]);
  assert.equal(childEstimateTotals(story.tasks).unestimatedCount, 1);
});

test('an overridden item keeps its estimate and still feeds its parent', () => {
  const project = createProject();
  Object.assign(project.epics[0].stories[0], { estimateOverride: true, points: 8, targetHourEstimate: 70 });

  applyEstimateRollups(project);

  assert.deepEqual([project.epics[0].stories[0].points, project.epics[0].stories[0].targetHourEstimate], [8, 70]);
  assert.deepEqual([project.epics[0].points, project.epics[0].targetHourEstimate], [13, 110]);
  assert.equal(usesChildEstimates(project.epics[0].stories[0]), false);
  assert.equal(usesChildEstimates(project.epics[0].stories[1]), false);
});

test('saving a re-estimated task does not write rolled-up parent totals', async () => {
  const calls = [];
  const saved = applyEstimateRollups(createProject());
  const store = createProjectStore({
    apiClient: {
      async createProjectItem() { throw new Error('unexpected create'); },
      async deleteProjectItem() { throw new Error('unexpected delete'); },
      async updateProjectItem(projectId, itemId) {
        calls.push(itemId);
        return { project: saved };
      },
    },
    authSession: { state: { token: 'session-token' } },
  });
  store.state.activeProject = JSON.parse(JSON.stringify(saved));
  const draft = JSON.parse(JSON.stringify(saved));
  draft.epics[0].stories[0].tasks[0].points = 3;
  applyEstimateRollups(draft);

  await store.saveProjectItems('project-1', draft);

  assert.deepEqual(calls, ['task-1']);
});

test('concurrent task re-estimates merge without conflicts on parent totals', () => {
  const base = applyEstimateRollups(createProject());
  const mine = applyEstimateRollups(Object.assign(JSON.parse(JSON.stringify(base)), {}));
  mine.epics[0].stories[0].tasks[0].points = 3;
  applyEstimateRollups(mine);
  const theirs = JSON.parse(JSON.stringify(base));
  theirs.epics[0].stories[0].tasks[1].points = 5;
  applyEstimateRollups(theirs);

  const { conflicts, merged } = mergeProjects({ base, mine, theirs });
  applyEstimateRollups(merged);

  assert.deepEqual(conflicts, []);
  assert.equal(merged.epics[0].stories[0].points, 8);
  assert.equal(merged.epics[0].points, 13);
});
