import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FOCUS_MAX,
  FOCUS_MIN,
  REASONS,
  approvalCandidates,
  buildTabs,
  ownWorkCandidates,
  pastSlaItemIds,
  rankHomeItems,
  requirementsCandidates,
  scheduleCandidates,
} from '../src/modules/home/home-focus.js';
import { flattenProjectItems } from '../src/modules/home/home-items.js';

// Monday 2026-10-12.
const TODAY = '2026-10-12';
const NOW = new Date('2026-10-12T15:00:00.000Z');

function contextFor(project, { analysis = null, canEdit = true, myItems = null, projectRole = 'manager', relations = [], sprints = [] } = {}) {
  const items = flattenProjectItems(project);
  return {
    analysis, calendar: null, canEdit, governance: null, items, itemsById: new Map(items.map((item) => [item.id, item])),
    managed: true, members: new Map(), myItems, project: { id: project.id, name: project.name }, projectRole, relations, sprints,
  };
}

function project(stories, tickets = []) {
  return { epics: [{ id: 'epic-1', name: 'Epic', stories }], id: 'project-1', name: 'Portal', tickets };
}

const candidate = (id, reasons, sort = {}) => ({ id, reasons, sort, tabs: ['all'], title: id });

test('reasons use fixed wording', () => {
  assert.equal(REASONS.blocks(1).label, 'Blocks 1 person');
  assert.equal(REASONS.blocks(2).label, 'Blocks 2 people');
  assert.equal(REASONS.overdue(2, false).label, 'Overdue 2d');
  assert.equal(REASONS.sprintEnds('Fri').label, 'Sprint ends Fri');
  assert.equal(REASONS.pastSla().label, 'Past SLA');
  assert.equal(REASONS.requiredReviewer(true).label, 'Required reviewer');
  assert.equal(REASONS.s1().label, 'S1 ticket');
  // Overdue is tier 1 on the critical path and tier 2 off it.
  assert.equal(REASONS.overdue(2, true).tier, 1);
  assert.equal(REASONS.overdue(2, false).tier, 2);
});

test('ranking orders by tier, then people blocked, due date, priority and float', () => {
  const { focus, items } = rankHomeItems([
    candidate('later-due', [REASONS.dueSoon('tomorrow')], { due: '2026-10-13' }),
    candidate('blocks-one', [REASONS.blocks(1)], { blocks: 1, due: '2026-10-01' }),
    candidate('blocks-three', [REASONS.blocks(3)], { blocks: 3 }),
    candidate('sooner-due', [REASONS.dueSoon('today')], { due: '2026-10-12' }),
    candidate('low-priority', [REASONS.inProgress()], { priority: 6 }),
    candidate('high-priority', [REASONS.inProgress()], { priority: 2 }),
    candidate('less-float', [REASONS.inProgress()], { float: 0, priority: 2 }),
    candidate('nothing', []),
  ]);
  assert.deepEqual(items.map((item) => [item.id, item.tier, item.rank]), [
    ['blocks-three', 1, 1],
    ['blocks-one', 1, 2],
    ['sooner-due', 2, 3],
    ['later-due', 2, 4],
    ['less-float', 3, 5],
    ['high-priority', 3, 6],
    ['low-priority', 3, 7],
    ['nothing', 4, 8],
  ]);
  // Four urgent items already reach the minimum, so tier 3 waits in its tabs.
  assert.deepEqual(focus.map((item) => item.id), ['blocks-three', 'blocks-one', 'sooner-due', 'later-due']);
  assert.ok(items[0].tabs.includes('focus'));
  assert.equal(items[4].tabs.includes('focus'), false);
});

test('focus holds at most five, and tops up from tier 3 to three', () => {
  const urgent = Array.from({ length: 7 }, (_, index) => candidate(`urgent-${index}`, [REASONS.s1()]));
  assert.equal(rankHomeItems(urgent).focus.length, FOCUS_MAX);

  const { focus } = rankHomeItems([
    candidate('urgent', [REASONS.pastSla()]),
    candidate('next-1', [REASONS.highPriority()], { priority: 1 }),
    candidate('next-2', [REASONS.highPriority()], { priority: 2 }),
    candidate('next-3', [REASONS.highPriority()], { priority: 2 }),
  ]);
  assert.equal(focus.length, FOCUS_MIN);
  assert.deepEqual(focus.map((item) => item.id), ['urgent', 'next-1', 'next-2']);
});

test('a row shows at most two reasons, best tier first', () => {
  const { items } = rankHomeItems([candidate('busy', [REASONS.inProgress(), REASONS.sprintEnds('Fri'), REASONS.overdue(2, false), REASONS.blocks(2)])]);
  assert.deepEqual(items[0].reasons, [
    { code: 'blocks', count: 2, label: 'Blocks 2 people' },
    { code: 'overdue', count: 2, label: 'Overdue 2d', tone: 'hot' },
  ]);
  assert.equal(items[0].sort, undefined);
});

test('own work earns reasons from blockers, the critical path, SLAs, severity, dates and the sprint', () => {
  const ctx = contextFor(project([
    { assigneeId: 'me', id: 'late-path', name: 'Late on the path', status: 'In Progress', targetEndDate: '2026-10-08' },
    { assigneeId: 'me', id: 'late', name: 'Late elsewhere', status: 'Not Started', targetEndDate: '2026-10-10' },
    { assigneeId: 'me', id: 'due-today', name: 'Due today', status: 'Not Started', targetEndDate: TODAY },
    { assigneeId: 'me', id: 'due-friday', name: 'Due Friday', status: 'Not Started', targetEndDate: '2026-10-16' },
    { assigneeId: 'me', id: 'sprint-work', name: 'Sprint work', sprintId: 'sprint-1', status: 'In Progress' },
    { assigneeId: 'me', id: 'urgent', name: 'Urgent', priority: 1, status: 'Not Started' },
    { assigneeId: 'me', id: 'done', name: 'Done', status: 'Completed', targetEndDate: '2026-10-01' },
    { assigneeId: 'other', id: 'theirs', name: 'Theirs', status: 'Not Started' },
    { assigneeId: 'other', id: 'blocked', name: 'Blocked', status: 'Not Started' },
  ], [
    { assigneeId: 'me', id: 'ticket-s1', name: 'Crash', severity: 'S1', status: 'triage' },
    { assigneeId: 'me', id: 'ticket-closed', name: 'Old', severity: 'S1', status: 'closed' },
    { assigneeId: 'me', id: 'ticket-rejected', name: 'Not a bug', severity: 'S1', status: 'rejected' },
  ]), {
    analysis: { criticalPathIds: ['late-path'], dependencyCount: 1, itemTimings: [] },
    relations: [{ fromItemId: 'late-path', relationType: 'blocks', toItemId: 'blocked' }, { fromItemId: 'late-path', relationType: 'affects', toItemId: 'theirs' }],
    sprints: [{ endDate: '2026-10-14', id: 'sprint-1', name: 'Sprint 1', status: 'active' }],
  });
  const histories = [
    { itemId: 'due-friday', occurredAt: '2026-10-01T00:00:00.000Z', projectId: 'project-1', sequenceId: 1, slaDueAt: '2026-10-05T00:00:00.000Z', toState: 'Not Started' },
  ];
  const byId = Object.fromEntries(ownWorkCandidates(ctx, { histories, now: NOW, today: TODAY, viewerId: 'me' }).map((entry) => [entry.id, entry.reasons.map((reason) => `${reason.label}/${reason.tier}`)]));
  assert.deepEqual(byId, {
    'item:due-friday': ['Past SLA/1'],
    'item:due-today': ['Due today/2'],
    'item:late': ['Overdue 2d/2'],
    'item:late-path': ['Blocks 1 person/1', 'Overdue 4d/1'],
    'item:sprint-work': ['Sprint ends Wed/2', 'In progress/3'],
    'item:ticket-s1': ['S1 ticket/1'],
    'item:urgent': ['High priority/3'],
  });
});

test('the latest transition decides whether an item is past its SLA', () => {
  const ctx = contextFor(project([{ assigneeId: 'me', id: 'item-1', name: 'Item', status: 'Review' }]));
  const later = { itemId: 'item-1', occurredAt: '2026-10-09T00:00:00.000Z', projectId: 'project-1', sequenceId: 2, slaDueAt: '2026-10-20T00:00:00.000Z', toState: 'Review' };
  const earlier = { itemId: 'item-1', occurredAt: '2026-10-01T00:00:00.000Z', projectId: 'project-1', sequenceId: 1, slaDueAt: '2026-10-02T00:00:00.000Z', toState: 'Review' };
  assert.equal(pastSlaItemIds(ctx, [earlier, later], NOW).size, 0);
  assert.deepEqual([...pastSlaItemIds(ctx, [earlier], NOW)], ['item-1']);
  // A state the item has since left does not count.
  assert.equal(pastSlaItemIds(ctx, [{ ...earlier, toState: 'In Progress' }], NOW).size, 0);
});

test('requirements items rank by kind, and a required review due soon is tier 2', () => {
  const ctx = contextFor(project([]), {
    myItems: {
      groups: {
        answer: [{ id: 'topic-a', title: 'How should refunds appear?', track: 'experience' }],
        decide: [{ id: 'topic-d', kind: 'topic', title: 'Can approvers see history?', track: 'experience' }],
        drafts: [{ id: 'package-1', title: 'Settings screens', track: 'experience' }],
        review: [
          { id: 'round-2', meta: { dueAt: '2026-10-14T17:00:00.000Z', required: true }, title: 'Round 2', track: 'experience' },
          { id: 'round-3', meta: { dueAt: '2026-10-30T17:00:00.000Z', required: true }, title: 'Round 3', track: 'architecture' },
        ],
      },
    },
  });
  const entries = requirementsCandidates(ctx, { lens: 'my-work', today: TODAY });
  assert.deepEqual(entries.map((entry) => [entry.title, entry.reasons.map((reason) => `${reason.label}/${reason.tier}`), entry.tabs]), [
    ['Decide: Can approvers see history?', ['Decision waiting/2'], ['requirements', 'all']],
    ['Answer: How should refunds appear?', ['Question for you/3'], ['requirements', 'all']],
    ['Review round 2', ['Required reviewer/2'], ['requirements', 'all']],
    ['Review round 3', ['Required reviewer/3'], ['requirements', 'all']],
    ['Finish draft: Settings screens', [], ['requirements', 'all']],
  ]);
  assert.deepEqual(entries[2].link, { name: 'project-requirements-round-review', params: { projectId: 'project-1', roundId: 'round-2' } });
  // In the team view decisions go to Decide.
  assert.deepEqual(requirementsCandidates(ctx, { lens: 'team', today: TODAY })[0].tabs, ['decide', 'all']);
});

test('approvals are offered only to people who may decide them', () => {
  const ctx = contextFor(project([{ assigneeId: 'sam', id: 'item-1', name: 'Release 2.4', status: 'Review' }]), { projectRole: 'contributor' });
  const workflowSnapshot = {
    approvals: [
      { expiresAt: '2026-10-12T12:00:00.000Z', fromState: 'Review', id: 'approval-late', itemId: 'item-1', itemType: 'story', projectId: 'project-1', requestedBy: 'sam', status: 'pending', toState: 'Completed', transitionKey: 'ship' },
      { expiresAt: null, fromState: 'Review', id: 'approval-mine', itemId: 'item-1', itemType: 'story', projectId: 'project-1', requestedBy: 'me', status: 'pending', toState: 'Completed', transitionKey: 'ship' },
      { expiresAt: null, fromState: 'Review', id: 'approval-done', itemId: 'item-1', itemType: 'story', projectId: 'project-1', requestedBy: 'sam', status: 'approved', toState: 'Completed', transitionKey: 'ship' },
    ],
    bindings: [{ itemType: 'story', projectId: 'project-1', workflowId: 'workflow-1' }],
    workflows: [{
      id: 'workflow-1',
      states: [{ key: 'Review', label: 'Review' }, { key: 'Completed', label: 'Completed' }],
      transitions: [{ approvalRequired: true, approverRoles: ['manager'], fromState: 'Review', key: 'ship', toState: 'Completed' }],
    }],
  };
  // A contributor in a member workspace role may not decide a manager-only approval.
  assert.deepEqual(approvalCandidates([ctx], { now: NOW, tenantRole: 'user', viewerId: 'me', workflowSnapshot }), []);
  const managerCtx = { ...ctx, projectRole: 'manager' };
  const entries = approvalCandidates([managerCtx], { now: NOW, tenantRole: 'user', viewerId: 'me', workflowSnapshot });
  assert.deepEqual(entries.map((entry) => [entry.id, entry.title, entry.reasons[0].label]), [['approval:approval-late', 'Approve: Release 2.4 to Completed', 'Past SLA']]);
  // Without plan edit rights nothing is offered.
  assert.deepEqual(approvalCandidates([{ ...managerCtx, canEdit: false }], { now: NOW, tenantRole: 'user', viewerId: 'me', workflowSnapshot }), []);
});

test('tabs count every item and list each tab’s items', () => {
  const { items } = rankHomeItems([
    { ...candidate('a', [REASONS.s1()]), tabs: ['assigned', 'all'] },
    { ...candidate('b', [REASONS.decision()]), tabs: ['requirements', 'all'] },
    { ...candidate('c', []), tabs: ['assigned', 'all'] },
  ]);
  const { tabs } = buildTabs('my-work', items);
  assert.deepEqual(tabs.map((tab) => [tab.key, tab.label, tab.count]), [['focus', 'Focus now', 2], ['assigned', 'Assigned', 2], ['requirements', 'Requirements', 1], ['all', 'All', 3]]);
});

test('schedule slips on a managed project rank as tier 1 work for its manager', () => {
  const ctx = {
    ...contextFor(project([])),
    analysis: {
      forecastVarianceDays: 4,
      milestoneForecasts: [
        { forecastDate: '2026-11-02', id: 'milestone-pilot', targetDate: '2026-10-28', title: 'Pilot ready', varianceWorkingDays: 3 },
        { forecastDate: '2026-10-21', id: 'milestone-done', targetDate: '2026-10-20', title: 'Kickoff', varianceWorkingDays: 1 },
        { forecastDate: '2027-01-08', id: 'milestone-far', targetDate: '2026-12-20', title: 'Launch', varianceWorkingDays: 9 },
        { forecastDate: '2026-10-26', id: 'milestone-early', targetDate: '2026-10-30', title: 'Beta', varianceWorkingDays: -3 },
      ],
    },
    governance: {
      items: [],
      milestones: [
        { id: 'milestone-pilot', status: 'planned' },
        { id: 'milestone-done', status: 'achieved' },
        { id: 'milestone-far', status: 'planned' },
        { id: 'milestone-early', status: 'planned' },
      ],
    },
    project: { endDate: '2026-12-04', id: 'project-1', name: 'Portal' },
  };
  const entries = scheduleCandidates(ctx, { today: TODAY });
  assert.deepEqual(entries.map((entry) => [entry.title, entry.reasons.map((reason) => `${reason.label}/${reason.tier}`), entry.tabs]), [
    ['Bring Portal back to its Dec 4 end date', ['Slips 4d/1'], ['team', 'all']],
    ['Milestone “Pilot ready” forecasts 3 working days late', ['Slips 3d/1'], ['team', 'all']],
  ]);
  assert.deepEqual(scheduleCandidates({ ...ctx, analysis: null }, { today: TODAY }), []);
});
