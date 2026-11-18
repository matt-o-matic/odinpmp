import assert from 'node:assert/strict';
import test from 'node:test';

import { flattenProjectItems } from '../src/modules/home/home-items.js';
import { generateRecoveryProposals, PROPOSAL_LIMIT, presentProposal, selectProposals } from '../src/modules/home/home-recovery.js';
import { evaluateActiveSprints } from '../src/modules/home/home-sprints.js';

// Monday 2026-10-12, halfway through Sprint 14 (Monday Oct 5 to Friday Oct 16).
const TODAY = '2026-10-12';
const viewer = { id: 'user-sam', name: 'Sam Ortiz' };
const leaf = (id, assigneeId, points, status, extra = {}) => ({ assigneeId, id, name: id, points, priority: 4, sprintId: 'sprint-14', status, version: 3, ...extra });

function sprintEntry({ canEdit = true, governance = null, analysis = null, stories, sprints } = {}) {
  const project = { epics: [{ id: 'epic-1', name: 'Epic', stories }], id: 'project-1', name: 'Portal', tickets: [] };
  const items = flattenProjectItems(project);
  const ctx = {
    analysis, calendar: null, canEdit, governance, items, itemsById: new Map(items.map((item) => [item.id, item])),
    managed: true, members: new Map([['user-sam', 'Sam Ortiz'], ['user-dana', 'Dana Reyes'], ['user-lee', 'Lee Park']]),
    myItems: null, project: { id: 'project-1', name: 'Portal' }, projectRole: 'manager', relations: [],
    sprints: sprints ?? [
      { endDate: '2026-10-16', id: 'sprint-14', name: 'Sprint 14', sortOrder: 1, staffing: [], startDate: '2026-10-05', status: 'active' },
      { endDate: '2026-10-30', id: 'sprint-15', name: 'Sprint 15', sortOrder: 2, staffing: [], startDate: '2026-10-19', status: 'planned' },
    ],
  };
  return evaluateActiveSprints([ctx], TODAY)[0];
}

// Sam: 30 points, 7 closed (behind, line 15). Dana: 20 points, 16 closed.
const baseStories = () => [
  leaf('sso', 'user-sam', 5, 'Not Started'),
  { assigneeId: 'user-sam', id: 'kanban', name: 'kanban', sprintId: 'sprint-14', status: 'In Progress', tasks: [
    leaf('kv1', 'user-sam', 7, 'Completed'),
    leaf('kv2', 'user-sam', 2, 'Not Started'),
    leaf('kv3', 'user-sam', 3, 'Not Started'),
  ] },
  leaf('netsuite', 'user-sam', 8, 'Not Started', { priority: 6 }),
  leaf('export', 'user-sam', 5, 'Not Started', { priority: 7 }),
  leaf('redirect', 'user-dana', 16, 'Completed'),
  leaf('audit', 'user-dana', 4, 'In Progress'),
];

test('moving scope takes the lowest-priority unstarted work until the person is back over the line', () => {
  const entry = sprintEntry({ stories: baseStories() });
  const [move] = generateRecoveryProposals({ entry, subject: { personId: 'user-sam', scope: 'person' }, today: TODAY, viewer });
  assert.equal(move.type, 'move-scope');
  // Sam must shed 16 points (30 − 7 ÷ 0.5): export (priority 7), netsuite (6), then the
  // biggest at priority 4.
  assert.equal(move.summary, 'Move 3 stories (18 pts) to Sprint 15');
  assert.equal(move.impact.points, 18);
  assert.equal(move.impact.text, 'Brings the work back over the line.');
  assert.deepEqual(move.stage.createPayload.input.assignments, [
    { itemId: 'export', itemType: 'story', sprintId: 'sprint-15' },
    { itemId: 'netsuite', itemType: 'story', sprintId: 'sprint-15' },
    { itemId: 'sso', itemType: 'story', sprintId: 'sprint-15' },
  ]);
  assert.equal(move.stage.type, 'sprint_items_move');
});

test('without a next sprint, scope moves to the backlog and splitting is not offered', () => {
  const entry = sprintEntry({ sprints: [{ endDate: '2026-10-16', id: 'sprint-14', name: 'Sprint 14', sortOrder: 1, staffing: [], startDate: '2026-10-05', status: 'active' }], stories: baseStories() });
  const proposals = generateRecoveryProposals({ entry, subject: { personId: 'user-sam', scope: 'person' }, today: TODAY, viewer });
  assert.equal(proposals[0].summary, 'Move 3 stories (18 pts) to the backlog');
  assert.equal(proposals[0].stage.createPayload.input.assignments[0].sprintId, null);
  assert.equal(proposals.some((proposal) => proposal.type === 'split-story'), false);
});

test('reassigning picks a teammate who stays on track and has the hours', () => {
  const stories = baseStories();
  const sprints = [
    { endDate: '2026-10-16', id: 'sprint-14', name: 'Sprint 14', sortOrder: 1, staffing: [{ capacityHours: 100, userId: 'user-dana' }], startDate: '2026-10-05', status: 'active' },
    { endDate: '2026-10-30', id: 'sprint-15', name: 'Sprint 15', sortOrder: 2, staffing: [], startDate: '2026-10-19', status: 'planned' },
  ];
  // Dana has 50 hours left and 32 of work (audit, 4 points): 18 free, short of netsuite's 64.
  let entry = sprintEntry({ sprints, stories });
  let proposals = generateRecoveryProposals({ entry, subject: { personId: 'user-sam', scope: 'person' }, today: TODAY, viewer });
  assert.equal(proposals.some((proposal) => proposal.type === 'reassign'), false);

  sprints[0].staffing[0].capacityHours = 240;
  entry = sprintEntry({ sprints, stories });
  proposals = generateRecoveryProposals({ entry, subject: { personId: 'user-sam', scope: 'person' }, today: TODAY, viewer });
  const reassign = proposals.find((proposal) => proposal.type === 'reassign');
  assert.equal(reassign.summary, 'Reassign “netsuite” to Dana Reyes');
  assert.equal(reassign.detail, 'Dana has 88 free hours this sprint.');
  assert.deepEqual(reassign.stage.createPayload.input, { assigneeId: 'user-dana', expectedVersion: 3 });
  assert.equal(reassign.stage.type, 'assignee_change');
});

test('splitting moves a started story’s unstarted tasks into a follow-up story in the next sprint', () => {
  const entry = sprintEntry({ stories: baseStories() });
  const split = generateRecoveryProposals({ entry, subject: { personId: 'user-sam', scope: 'person' }, today: TODAY, viewer }).find((proposal) => proposal.type === 'split-story');
  assert.equal(split.summary, 'Split “kanban” and finish the started part');
  assert.equal(split.detail, 'Move 2 of 3 tasks to a new story in Sprint 15.');
  assert.equal(split.impact.points, 5);
  assert.deepEqual(split.stage.createPayload.input, { assigneeId: 'user-sam', name: 'kanban (follow-up)', priority: 4, sprintId: 'sprint-15', status: 'Not Started', taskIds: ['kv2', 'kv3'] });
});

test('a milestone due within 30 days that forecasts late can shift to its forecast', () => {
  const governance = {
    items: [],
    milestones: [
      { id: 'milestone-pilot', status: 'planned', targetDate: '2026-10-28', title: 'Pilot ready', version: 2 },
      { id: 'milestone-done', status: 'achieved', targetDate: '2026-10-20', title: 'Kickoff', version: 1 },
      { id: 'milestone-far', status: 'planned', targetDate: '2026-12-20', title: 'Launch', version: 1 },
    ],
  };
  const analysis = {
    milestoneForecasts: [
      { forecastDate: '2026-11-02', id: 'milestone-pilot', targetDate: '2026-10-28', title: 'Pilot ready', varianceWorkingDays: 3 },
      { forecastDate: '2026-10-27', id: 'milestone-done', targetDate: '2026-10-20', title: 'Kickoff', varianceWorkingDays: 5 },
      { forecastDate: '2026-12-30', id: 'milestone-far', targetDate: '2026-12-20', title: 'Launch', varianceWorkingDays: 6 },
    ],
  };
  const entry = sprintEntry({ analysis, governance, stories: baseStories() });
  const shift = generateRecoveryProposals({ entry, subject: { scope: 'sprint' }, today: TODAY, viewer }).find((proposal) => proposal.type === 'shift-milestone');
  assert.equal(shift.summary, 'Shift milestone “Pilot ready” from Oct 28 to Nov 2');
  assert.equal(shift.detail, 'Forecast is 3 working days late.');
  assert.deepEqual(shift.impact, { days: 3, points: null, text: 'Removes the variance.' });
  assert.deepEqual(shift.stage.createPayload.input, { expectedVersion: 2, targetDate: '2026-11-02' });
});

test('raising a risk is offered once, owned by the viewer', () => {
  const entry = sprintEntry({ governance: { items: [], milestones: [] }, stories: baseStories() });
  const risk = generateRecoveryProposals({ entry, subject: { personId: 'user-sam', scope: 'person' }, today: TODAY, viewer }).find((proposal) => proposal.type === 'raise-risk');
  // 7 points in half the time projects 14 of 30.
  assert.equal(risk.summary, 'Raise a risk: Sprint 14 may not finish about 16 points');
  assert.equal(risk.stage.type, 'governance_item_create');
  assert.equal(risk.stage.createPayload.input.ownerId, 'user-sam');
  assert.equal(risk.stage.createPayload.input.dueDate, '2026-10-16');
  assert.equal(risk.stage.createPayload.input.kind, 'risk');

  const raised = sprintEntry({ governance: { items: [{ kind: 'risk', status: 'open', title: 'Sprint 14 may not finish about 16 points' }], milestones: [] }, stories: baseStories() });
  assert.equal(generateRecoveryProposals({ entry: raised, subject: { personId: 'user-sam', scope: 'person' }, today: TODAY, viewer }).some((proposal) => proposal.type === 'raise-risk'), false);
});

test('without edit rights every proposal is marked not permitted, and only one is shown', () => {
  const entry = sprintEntry({ canEdit: false, stories: baseStories() });
  const proposals = generateRecoveryProposals({ entry, subject: { personId: 'user-sam', scope: 'person' }, today: TODAY, viewer });
  assert.ok(proposals.length > 1);
  assert.ok(proposals.every((proposal) => proposal.permitted === false && proposal.blockedReason === 'Needs edit rights on Portal.'));
  assert.deepEqual(selectProposals(proposals).map((proposal) => proposal.type), ['move-scope']);

  const allowed = generateRecoveryProposals({ entry: sprintEntry({ stories: baseStories() }), subject: { personId: 'user-sam', scope: 'person' }, today: TODAY, viewer });
  const mixed = [{ ...allowed[0], permitted: false }, ...allowed.slice(1)];
  const shown = selectProposals(mixed);
  assert.equal(shown.length, PROPOSAL_LIMIT);
  assert.ok(shown.every((proposal) => proposal.permitted));
  assert.equal(presentProposal(shown[0]).stage, undefined);
});

test('proposal ids are stable for the same data and change when that data does', () => {
  const ids = (stories) => generateRecoveryProposals({ entry: sprintEntry({ stories }), subject: { personId: 'user-sam', scope: 'person' }, today: TODAY, viewer }).map((proposal) => proposal.id);
  const first = ids(baseStories());
  assert.deepEqual(ids(baseStories()), first);
  const edited = baseStories();
  edited[3].version = 4;
  const next = ids(edited);
  assert.notEqual(next[0], first[0], 'a moved item changed, so the move proposal is new');
  assert.equal(next[2], first[2], 'the split does not touch that item');
});
