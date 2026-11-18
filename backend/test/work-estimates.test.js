import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyProjectEstimateRollups,
  childEstimateTotals,
  estimateOverrideFlag,
} from '../src/lib/projects/work-estimates.js';

test('childEstimateTotals adds only entered values and counts unestimated children', () => {
  assert.deepEqual(
    childEstimateTotals([{ points: 2, targetHourEstimate: 16 }, { points: 3 }, {}]),
    { childCount: 3, hours: 16, points: 5, unestimatedCount: 1 },
  );
  assert.deepEqual(childEstimateTotals([{}, { points: '' }]), { childCount: 2, hours: null, points: null, unestimatedCount: 2 });
});

test('rollups flow from tasks through stories to epics unless an item is overridden', () => {
  const project = {
    epics: [{
      points: 99,
      stories: [
        { points: 1, targetHourEstimate: 1, tasks: [{ points: 2, targetHourEstimate: 16 }, { points: 1, targetHourEstimate: 8 }] },
        { estimateOverride: true, points: 5, targetHourEstimate: 40, tasks: [{ points: 1, targetHourEstimate: 8 }] },
        { points: 3, targetHourEstimate: 24, tasks: [] },
      ],
      targetHourEstimate: 999,
    }],
  };

  applyProjectEstimateRollups(project);
  const [story, overridden, childless] = project.epics[0].stories;

  assert.deepEqual([story.points, story.targetHourEstimate], [3, 24]);
  assert.deepEqual([overridden.points, overridden.targetHourEstimate], [5, 40]);
  assert.deepEqual([childless.points, childless.targetHourEstimate], [3, 24]);
  assert.deepEqual([project.epics[0].points, project.epics[0].targetHourEstimate], [11, 88]);
});

test('estimateOverrideFlag reads booleans and stored tinyint values', () => {
  assert.equal(estimateOverrideFlag(true), 1);
  assert.equal(estimateOverrideFlag(1), 1);
  assert.equal(estimateOverrideFlag('1'), 1);
  assert.equal(estimateOverrideFlag(false), 0);
  assert.equal(estimateOverrideFlag(undefined), 0);
});
