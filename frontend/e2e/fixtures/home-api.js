// Synthetic GET /api/home payloads (backend/src/modules/home) for the Home acceptance spec,
// and the quiet default every other spec sees after signing in.

export const HOME_AS_OF = '2026-10-12T15:00:00.000Z';
const PROJECT_ID = 'project-synthetic';
const PROJECT_NAME = 'Synthetic Delivery Plan';

const ok = (key) => ({ failedProjectIds: [], key, status: 'ok' });
const allSourcesOk = () => ['projects', 'workflows', 'sprints', 'governance', 'relations', 'requirements', 'alerts', 'leaderboard', 'changes'].map(ok);

function reason(code, label, extra = {}) {
  return { code, label, ...extra };
}

function row(id, title, reasons, { due = null, kind = 'work-item', projectName = PROJECT_NAME, rank, tabs } = {}) {
  return {
    due,
    id,
    kind,
    link: { name: 'project-detail', params: { projectId: PROJECT_ID }, query: { item: id.replace(/^[a-z]+:/, '') } },
    projectId: PROJECT_ID,
    projectName,
    rank,
    reasons,
    tabs,
    tier: reasons.some((entry) => entry.tone === 'hot') ? 1 : 2,
    title,
  };
}

const series = Array.from({ length: 30 }, (_, index) => ({
  count: [4, 6, 5, 8, 3, 2, 7, 9, 6, 8, 5, 4, 3, 9, 11, 7, 6, 8, 10, 5, 3, 4, 9, 12, 8, 7, 10, 9, 6, 11][index],
  date: new Date(Date.UTC(2026, 8, 13 + index)).toISOString().slice(0, 10),
}));

function rail({ counts, leaderboardMe = null, sprints }) {
  return {
    changeTrends: { days: 30, series, total: series.reduce((sum, point) => sum + point.count, 0), yesterday: 6 },
    counts,
    leaderboard: {
      days: 7,
      me: leaderboardMe,
      top: [
        { id: 'user-sam', isCurrentUser: false, name: 'Sam Ortiz', picture: null, points: 34, rank: 1, tasks: 9 },
        { id: 'user-lee', isCurrentUser: false, name: 'Lee Park', picture: null, points: 28, rank: 2, tasks: 7 },
        { id: 'user-dana', isCurrentUser: false, name: 'Dana Reyes', picture: null, points: 21, rank: 3, tasks: 6 },
      ],
    },
    sprints,
  };
}

function sprint(overrides = {}) {
  return {
    behind: true, committedPoints: 34, donePct: 47, donePoints: 16, elapsedPct: 70, endDate: '2026-10-16', id: 'sprint-14', idealPct: 70,
    link: { name: 'project-kanban', params: { projectId: PROJECT_ID } }, myItems: null, name: 'Sprint 14', peopleBehind: 1,
    projectId: PROJECT_ID, projectName: PROJECT_NAME, projectedPoints: 23, startDate: '2026-10-05', status: 'behind', threshold: 17, unit: 'points', willNotFinishPoints: 11,
    ...overrides,
  };
}

const proposals = [
  { applyVia: 'ai-workspace', blockedReason: null, detail: 'Lowest priority, not started.', id: 'rp_aaaaaaaaaaaaaaaa', impact: { days: null, points: 13, text: 'Brings the work back over the line.' }, permitted: true, projectId: PROJECT_ID, sprintId: 'sprint-14', summary: 'Move 2 stories (13 pts) to Sprint 15', type: 'move-scope' },
  { applyVia: 'ai-workspace', blockedReason: null, detail: 'Dana has 9 free hours this sprint.', id: 'rp_bbbbbbbbbbbbbbbb', impact: { days: null, points: 5, text: 'Frees 5 pts.' }, permitted: true, projectId: PROJECT_ID, sprintId: 'sprint-14', summary: 'Reassign “Map NetSuite cost centers” to Dana Reyes', type: 'reassign' },
  { applyVia: 'ai-workspace', blockedReason: null, detail: 'Move 3 of 5 tasks to a new story in Sprint 15.', id: 'rp_cccccccccccccccc', impact: { days: null, points: 3, text: 'Frees 3 pts.' }, permitted: true, projectId: PROJECT_ID, sprintId: 'sprint-14', summary: 'Split “Saved kanban views” and finish the started part', type: 'split-story' },
];

const behindEvidence = [
  { label: "From 50% of a sprint's working days, anyone who has closed less than 50% of the points assigned to them is behind.", rule: 'behind.rule', values: {} },
  { label: '5 of 10 working days are gone (50%).', rule: 'behind.elapsed', values: {} },
  { label: 'You closed 7 of the 30 points assigned to you; half is 15.', rule: 'behind.person', values: {} },
];

const memberFocus = [
  row('item:story-sso', 'Finish SSO discovery on the login screen', [reason('blocks', 'Blocks 2 people', { count: 2 }), reason('overdue', 'Overdue 2d', { count: 2, tone: 'hot' })], { due: { at: '2026-10-07', kind: 'due' }, rank: 1, tabs: ['focus', 'assigned', 'all'] }),
  row('item:ticket-safari', 'Fix upload failure on Safari 18', [reason('s1', 'S1 ticket', { tone: 'hot' })], { due: { at: '2026-10-12', kind: 'due' }, rank: 2, tabs: ['focus', 'assigned', 'all'] }),
  row('answer:topic-refunds', 'Answer: How should refunds appear in order history?', [reason('decision', 'Decision waiting')], { due: { at: '2026-10-13', kind: 'due' }, kind: 'answer', rank: 3, tabs: ['focus', 'requirements', 'all'] }),
  row('item:story-kanban', 'Saved kanban views per user', [reason('sprint-ends', 'Sprint ends Fri'), reason('in-progress', 'In progress')], { due: { at: '2026-10-16', kind: 'due' }, rank: 4, tabs: ['focus', 'assigned', 'all'] }),
  row('review:round-2', 'Review round 2', [reason('required-reviewer', 'Required reviewer')], { due: { at: '2026-10-14', kind: 'due' }, kind: 'review', rank: 5, tabs: ['focus', 'requirements', 'all'] }),
];

/** A member under half of their points at the halfway point. */
export function memberBehindHome() {
  const extra = row('item:story-export', 'CSV export', [], { rank: 6, tabs: ['assigned', 'all'] });
  return {
    asOf: HOME_AS_OF,
    focus: { items: memberFocus, total: 5 },
    items: [...memberFocus, extra],
    ok: true,
    rail: rail({
      counts: [
        { href: null, key: 'due-week', label: 'Due this week', note: '1 overdue', severity: 'danger', value: 4 },
        { href: null, key: 'waiting', label: 'Waiting on you', note: '2 reviews, 1 answer', severity: null, value: 3 },
        { href: null, key: 'in-review', label: 'Your items in review', note: 'waiting on a reviewer', severity: null, value: 2 },
        { href: null, key: 'alerts', label: 'Odin alerts', note: '1 critical', severity: 'danger', value: 1 },
      ],
      sprints: [sprint({ committedPoints: 34, donePoints: 21, myItems: { done: 1, total: 6 }, peopleBehind: 1, status: 'behind' })],
    }),
    recovery: { generatedAt: HOME_AS_OF, mode: 'hybrid', proposals, subject: { personId: 'user-synthetic', projectId: PROJECT_ID, scope: 'person', sprintId: 'sprint-14' } },
    sources: allSourcesOk(),
    status: {
      evidence: behindEvidence,
      headline: "You're behind in Sprint 14",
      kind: 'behind',
      otherBehindSprints: 0,
      people: [],
      say: "You've closed 7 of your 30 pts. At this pace about 16 pts won't finish by Fri.",
      scope: 'person',
      sprint: { committedPoints: 30, donePct: 23, donePoints: 7, elapsedPct: 50, endDate: '2026-10-16', id: 'sprint-14', name: 'Sprint 14', projectId: PROJECT_ID, projectName: PROJECT_NAME, threshold: 15, unit: 'points', willNotFinishPoints: 16 },
    },
    tabs: [
      { count: 5, key: 'focus', label: 'Focus now' },
      { count: 4, key: 'assigned', label: 'Assigned' },
      { count: 2, key: 'requirements', label: 'Requirements' },
      { count: 6, key: 'all', label: 'All' },
    ],
    viewer: { defaultLens: 'my-work', id: 'user-synthetic', lens: 'my-work', lenses: ['my-work'], managedProjectCount: 0, name: 'Synthetic Demo', projectCount: 4, projectsTruncated: false, tenantRole: 'member', twoFactorEnabled: true },
  };
}

/** A project manager's team view with a behind sprint, and their own view. */
export function managerHome(lens = 'team') {
  if (lens === 'my-work') {
    return {
      ...onTrackHome(),
      viewer: { defaultLens: 'team', id: 'user-synthetic', lens: 'my-work', lenses: ['my-work', 'team'], managedProjectCount: 4, name: 'Synthetic Demo', projectCount: 4, projectsTruncated: false, tenantRole: 'member', twoFactorEnabled: true },
    };
  }
  const focus = [
    row('team:story-sso', 'Unblock Sam on “Finish SSO discovery”', [reason('blocks', 'Blocks 2 people', { count: 2 }), reason('overdue', 'Overdue 2d', { count: 2, tone: 'hot' })], { due: { at: '2026-10-07', kind: 'due' }, kind: 'blocker', rank: 1, tabs: ['focus', 'team', 'all'] }),
    row('approval:release', 'Approve: Release 2.4 to Completed', [reason('past-sla', 'Past SLA', { tone: 'hot' })], { due: { at: '2026-10-12T12:00:00.000Z', kind: 'due' }, kind: 'approval', rank: 2, tabs: ['focus', 'decide', 'all'] }),
    row('risk:vendor', 'Respond to critical risk: Vendor capacity', [reason('critical-risk', 'Critical risk')], { due: { at: null, kind: 'owner' }, kind: 'risk', rank: 3, tabs: ['focus', 'team', 'all'] }),
    row('decide:history', 'Decide: Can approvers see prototype history?', [reason('decision', 'Decision waiting')], { kind: 'decision', rank: 4, tabs: ['focus', 'decide', 'all'] }),
  ];
  return {
    asOf: HOME_AS_OF,
    focus: { items: focus, total: 4 },
    items: focus,
    ok: true,
    rail: rail({
      counts: [
        { href: null, key: 'active-sprints', label: 'Active sprints', note: '1 at risk', severity: 'warn', value: 3 },
        { href: { name: 'workflows' }, key: 'approvals', label: 'Pending approvals', note: '1 past SLA', severity: 'warn', value: 4 },
        { href: null, key: 'critical-risks', label: 'Critical risks', note: 'of 9 open', severity: 'danger', value: 2 },
        { href: { name: 'resources' }, key: 'overallocated', label: 'Overallocated', note: 'people this sprint', severity: 'warn', value: 3 },
      ],
      leaderboardMe: { id: 'user-synthetic', isCurrentUser: true, name: 'Synthetic Demo', picture: null, points: 6, rank: 9, tasks: 2 },
      sprints: [
        sprint(),
        sprint({ behind: false, committedPoints: 20, donePoints: 18, elapsedPct: 85, endDate: '2026-10-19', id: 'sprint-3', idealPct: 85, name: 'Sprint 3', peopleBehind: 0, projectName: 'FaultLine Ingestion', status: 'on-track' }),
        sprint({ behind: false, committedPoints: 40, donePoints: 9, elapsedPct: 25, endDate: '2026-10-24', id: 'sprint-6', idealPct: 25, name: 'Sprint 6', peopleBehind: 0, projectName: 'Checkout Redesign', status: 'on-track' }),
      ],
    }),
    recovery: { generatedAt: HOME_AS_OF, mode: 'hybrid', proposals, subject: { personId: null, projectId: PROJECT_ID, scope: 'sprint', sprintId: 'sprint-14' } },
    sources: allSourcesOk(),
    status: {
      evidence: [...behindEvidence.slice(0, 2), { label: 'The sprint closed 16 of 34 points; half is 17.', rule: 'behind.sprint', values: {} }],
      headline: 'Sprint 14 is behind',
      kind: 'behind',
      otherBehindSprints: 0,
      people: [{ assigned: 30, behind: true, closed: 7, id: 'user-sam', name: 'Sam Ortiz', threshold: 15 }],
      say: 'At this pace about 11 pts will not finish by Fri. Behind: Sam Ortiz (7 of 30 pts).',
      scope: 'sprint',
      sprint: { committedPoints: 34, donePct: 47, donePoints: 16, elapsedPct: 70, endDate: '2026-10-16', id: 'sprint-14', name: 'Sprint 14', projectId: PROJECT_ID, projectName: PROJECT_NAME, threshold: 17, unit: 'points', willNotFinishPoints: 11 },
    },
    tabs: [
      { count: 4, key: 'focus', label: 'Focus now' },
      { count: 2, key: 'decide', label: 'Decide' },
      { count: 2, key: 'team', label: 'Team' },
      { count: 0, key: 'assigned', label: 'Assigned' },
      { count: 4, key: 'all', label: 'All' },
    ],
    viewer: { defaultLens: 'team', id: 'user-synthetic', lens: 'team', lenses: ['my-work', 'team'], managedProjectCount: 4, name: 'Synthetic Demo', projectCount: 4, projectsTruncated: false, tenantRole: 'member', twoFactorEnabled: true },
  };
}

/** A tenant admin's workspace view. */
export function adminHome() {
  const focus = [
    { ...row('impersonation:grant-1', 'Approve impersonation request: Alex Kim → Target User', [reason('expires', 'Expires in 4h', { tone: 'hot' }), reason('second-admin', 'Needs a second admin')], { due: { at: '2026-10-12T19:00:00.000Z', kind: 'expires' }, kind: 'impersonation', projectName: 'Identity', rank: 1, tabs: ['focus', 'approvals', 'identity', 'all'] }), link: { name: 'identity-admin' }, projectId: null },
    { ...row('webhook:delivery', 'Fix the dead webhook “Delivery receiver”', [reason('dead-webhook', '8 events not delivered', { count: 8, tone: 'hot' })], { due: { at: '2026-10-07T09:00:00.000Z', kind: 'since' }, kind: 'webhook', projectName: 'API & integrations', rank: 2, tabs: ['focus', 'integrations', 'all'] }), link: { name: 'integration-admin' }, projectId: null },
  ];
  return {
    asOf: HOME_AS_OF,
    focus: { items: focus, total: 2 },
    items: focus,
    ok: true,
    rail: rail({
      counts: [
        { href: { name: 'integration-admin' }, key: 'dead-webhooks', label: 'Dead webhooks', note: '8 failed deliveries', severity: 'danger', value: 1 },
        { href: { name: 'integration-admin' }, key: 'sync-conflicts', label: 'Sync conflicts', note: 'Engineering Jira', severity: 'warn', value: 1 },
        { href: { name: 'identity-admin' }, key: 'access-review', label: 'Access review', note: '18 of 42 · due Oct 20', severity: null, value: '43%' },
        { href: { name: 'admin' }, key: 'without-2fa', label: 'Without 2FA', note: 'of 41 members', severity: 'warn', value: 7 },
      ],
      sprints: [sprint()],
    }),
    recovery: { generatedAt: HOME_AS_OF, mode: 'hybrid', proposals: [], subject: null },
    sources: [...allSourcesOk(), ok('identity'), ok('integrations'), ok('connectors'), ok('members')],
    status: { evidence: [], headline: '1 sprint is behind across the workspace.', kind: 'behind', people: [], say: 'Their managers see recovery options on their home.', scope: 'workspace', sprint: null },
    tabs: [
      { count: 2, key: 'focus', label: 'Focus now' },
      { count: 1, key: 'approvals', label: 'Approvals' },
      { count: 1, key: 'integrations', label: 'Integrations' },
      { count: 1, key: 'identity', label: 'Identity' },
      { count: 2, key: 'all', label: 'All' },
    ],
    viewer: { defaultLens: 'workspace', id: 'user-synthetic', lens: 'workspace', lenses: ['my-work', 'workspace'], managedProjectCount: 0, name: 'Synthetic Demo', projectCount: 1, projectsTruncated: false, tenantRole: 'admin', twoFactorEnabled: true },
  };
}

/** Nothing behind: an on-track line and a short Focus list. */
export function onTrackHome() {
  const focus = [row('item:story-kanban', 'Saved kanban views per user', [reason('in-progress', 'In progress')], { due: { at: '2026-10-15', kind: 'due' }, rank: 1, tabs: ['focus', 'assigned', 'all'] })];
  return {
    ...memberBehindHome(),
    focus: { items: focus, total: 1 },
    items: focus,
    recovery: { generatedAt: HOME_AS_OF, mode: 'hybrid', proposals: [], subject: null },
    status: { evidence: [], headline: 'On track.', kind: 'on-track', people: [], say: 'Sprint 14 is 62% done with 60% of the time gone.', scope: null, sprint: null },
    tabs: [{ count: 1, key: 'focus', label: 'Focus now' }, { count: 1, key: 'assigned', label: 'Assigned' }, { count: 0, key: 'requirements', label: 'Requirements' }, { count: 1, key: 'all', label: 'All' }],
  };
}

/** The quiet default for specs that only pass through Home: no projects, nothing ranked. */
export function syntheticHomePayload(overrides = {}) {
  return {
    asOf: HOME_AS_OF,
    focus: { items: [], total: 0 },
    items: [],
    ok: true,
    rail: { changeTrends: { days: 30, series: series.map((point) => ({ ...point, count: 0 })), total: 0, yesterday: 0 }, counts: [], leaderboard: { days: 7, me: null, top: [] }, sprints: [] },
    recovery: { generatedAt: HOME_AS_OF, mode: 'hybrid', proposals: [], subject: null },
    sources: allSourcesOk(),
    status: { evidence: [], headline: '', kind: 'none', people: [], say: '', scope: null, sprint: null },
    tabs: [{ count: 0, key: 'focus', label: 'Focus now' }, { count: 0, key: 'assigned', label: 'Assigned' }, { count: 0, key: 'requirements', label: 'Requirements' }, { count: 0, key: 'all', label: 'All' }],
    viewer: { defaultLens: 'my-work', id: 'user-synthetic', lens: 'my-work', lenses: ['my-work'], managedProjectCount: 0, name: 'Synthetic Demo', projectCount: 1, projectsTruncated: false, tenantRole: 'member', twoFactorEnabled: false },
    ...overrides,
  };
}
