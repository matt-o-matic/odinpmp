import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIREMENTS_STAGES,
  briefCitation,
  briefLineNumber,
  briefRefLabel,
  describeStage,
  isRequirementsTrack,
  normalizeStage,
  parseBriefRef,
  trackChipClass,
  trackLabel,
} from '../src/lib/requirements/requirements-tracks.js';

const lines = [
  { label: 'Requirement 1', ref: 'brief:requirements:0' },
  { label: 'Requirement 2', ref: 'brief:requirements:1' },
  { label: 'Constraint 1', ref: 'brief:constraints:0' },
  { label: 'Objective', ref: 'brief:objective' },
];

test('tracks and stages', () => {
  assert.equal(isRequirementsTrack('experience'), true);
  assert.equal(isRequirementsTrack('backend'), false);
  // The stored track stays `architecture`; it reads as Functional.
  assert.equal(trackLabel('architecture'), 'Functional');
  assert.equal(trackChipClass('experience'), 'rq-chip--exp');
  assert.deepEqual(REQUIREMENTS_STAGES.map((stage) => stage.label), ['Brief', 'Discuss', 'Review', 'Decide', 'Plan & work']);
  assert.equal(normalizeStage('decide'), 'decide');
  assert.equal(normalizeStage(undefined), 'discuss');
  assert.equal(normalizeStage('nonsense'), 'discuss');
});

test('sourceRef maps to the brief line label the backend uses (zero-based refs, one-based labels)', () => {
  assert.deepEqual(parseBriefRef('brief:requirements:0'), { index: 0, section: 'requirements' });
  assert.deepEqual(parseBriefRef('brief:objective'), { index: null, section: 'objective' });
  assert.equal(parseBriefRef('comment:1'), null);
  assert.equal(briefRefLabel('brief:requirements:1'), 'Requirement 2');
  assert.equal(briefRefLabel('brief:successMetrics:0'), 'Success metric 1');
  assert.equal(briefRefLabel('brief:currentState'), 'Current state');
  assert.equal(briefRefLabel(null), '');
});

test('brief citations use the line position in the brief when it is known', () => {
  assert.equal(briefLineNumber('brief:constraints:0', lines), 3);
  assert.equal(briefLineNumber('brief:requirements:9', lines), null);
  assert.equal(briefCitation('brief:constraints:0', lines), 'brief line 3');
  assert.equal(briefCitation('brief:requirements:9', lines), 'Requirement 10');
  assert.equal(briefCitation(null, lines), '');
});

test('stage status lines follow the overview', () => {
  const stages = {
    brief: { coveredLines: 7, totalLines: 7 },
    decide: { decided: 3, proposedPreferences: 1, waiting: 1 },
    discuss: { decided: 3, open: 5, ready: 2, total: 10 },
    plan: { latestPlan: null },
    review: { latestRound: { number: 2, reviewersSubmitted: 3, reviewersTotal: 5, status: 'open' } },
  };
  assert.deepEqual(describeStage('brief', stages), { status: '7 of 7 lines covered', tone: 'done' });
  assert.deepEqual(describeStage('discuss', stages), { status: '10 topics · 2 ready', tone: 'attention' });
  assert.deepEqual(describeStage('review', stages), { status: 'Round 2 open · 3 of 5 in', tone: 'active' });
  assert.deepEqual(describeStage('decide', stages), { status: '3 decided · 2 waiting', tone: 'attention' });
  assert.deepEqual(describeStage('plan', stages), { status: 'Not started', tone: 'idle' });
});

test('stage status lines for empty and finished tracks', () => {
  assert.deepEqual(describeStage('brief', { brief: { coveredLines: 0, totalLines: 0 } }), { status: 'No brief yet', tone: 'idle' });
  assert.deepEqual(describeStage('brief', { brief: { coveredLines: 0, totalLines: 1 } }), { status: '0 of 1 line covered', tone: 'attention' });
  assert.deepEqual(describeStage('discuss', { discuss: { total: 0 } }), { status: 'No topics yet', tone: 'idle' });
  assert.deepEqual(describeStage('discuss', { discuss: { open: 0, ready: 0, total: 1 } }), { status: '1 topic · 0 ready', tone: 'done' });
  assert.deepEqual(describeStage('review', { review: { latestRound: null } }), { status: 'No rounds yet', tone: 'idle' });
  assert.deepEqual(describeStage('review', { review: { latestRound: { number: 1, status: 'closed' } } }), { status: 'Round 1 closed', tone: 'done' });
  assert.deepEqual(describeStage('decide', { decide: { decided: 0, proposedPreferences: 0, waiting: 0 } }), { status: 'Nothing to decide yet', tone: 'idle' });
  assert.deepEqual(describeStage('decide', { decide: { decided: 6, proposedPreferences: 0, waiting: 0 } }), { status: '6 decided', tone: 'done' });
  assert.deepEqual(describeStage('plan', { plan: { latestPlan: { status: 'approved', version: 2 } } }), { status: 'Plan v2 approved', tone: 'done' });
});
