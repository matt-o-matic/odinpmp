// Demo data for the marketing screenshots. One story runs through every screen: the digital
// team at Harbor & Pine Outfitters is relaunching its customer portal (accounts, orders,
// returns and booking a bike or ski service at a shop). All people and companies are
// fictional and every email address uses example.com.

import { syntheticProject } from '../../../../frontend/e2e/fixtures/synthetic-api.js';

export const PROJECT_ID = syntheticProject.id;
export const PROJECT_NAME = 'Customer Portal Relaunch';
export const TENANT_NAME = 'Harbor & Pine Outfitters';

export const PEOPLE = {
  priya: { email: 'priya.natarajan@example.com', id: 'user-synthetic', name: 'Priya Natarajan', role: 'manager', title: 'Delivery lead' },
  sam: { email: 'sam.ortiz@example.com', id: 'user-sam', name: 'Sam Ortiz', role: 'member', title: 'Engineer' },
  lee: { email: 'lee.park@example.com', id: 'user-lee', name: 'Lee Park', role: 'member', title: 'Engineer' },
  dana: { email: 'dana.reyes@example.com', id: 'user-dana', name: 'Dana Reyes', role: 'member', title: 'Product designer' },
  marcus: { email: 'marcus.chen@example.com', id: 'user-marcus', name: 'Marcus Chen', role: 'admin', title: 'Engineering manager' },
  ava: { email: 'ava.lindqvist@example.com', id: 'user-ava', name: 'Ava Lindqvist', role: 'member', title: 'Customer care lead' },
};

const TEAM = [PEOPLE.priya, PEOPLE.sam, PEOPLE.lee, PEOPLE.dana, PEOPLE.marcus, PEOPLE.ava];

export function validUsersPayload() {
  const users = TEAM.map(({ email, id, name, role }) => ({ email, id, name, role }));
  return { project_users: users, tenant_users: users, validStatusTypes: {}, validTaskTypes: {} };
}

let sequence = 0;
function node(name, status, person, points, hours, extra = {}) {
  sequence += 1;
  return {
    actualHours: extra.actualHours ?? (status === 'Completed' ? hours : status === 'Not Started' ? 0 : Math.round(hours * 0.5)),
    assigneeId: person?.id ?? null,
    assigneeName: person?.name ?? '',
    description: extra.description ?? '',
    estimateOverride: false,
    name,
    percentComplete: null,
    points,
    priority: extra.priority ?? 3,
    sprintId: extra.sprintId ?? null,
    sprintSortOrder: extra.sprintId ? sequence : null,
    status,
    targetEndDate: extra.end ?? null,
    targetHourEstimate: hours,
    targetStartDate: extra.start ?? null,
    version: 3,
    ...extra.fields,
  };
}

function task(id, name, status, person, points, hours, extra) {
  return { ...node(name, status, person, points, hours, extra), id };
}

function story(id, name, status, person, points, hours, tasks, extra) {
  return { ...node(name, status, person, points, hours, extra), id, tasks };
}

function epic(id, name, status, stories, extra) {
  const points = stories.reduce((sum, entry) => sum + (entry.points ?? 0), 0);
  const hours = stories.reduce((sum, entry) => sum + (entry.targetHourEstimate ?? 0), 0);
  return { ...node(name, status, null, points, hours, extra), id, stories };
}

const S14 = { sprintId: 'sprint-14' };
const S15 = { sprintId: 'sprint-15' };

/** The project the workbench, kanban and Insights screens show. */
export function demoProject() {
  sequence = 0;
  const { priya, sam, lee, dana, marcus } = PEOPLE;
  return {
    assistantState: { brief: {} },
    description: 'Relaunch of the Harbor & Pine customer portal: accounts, orders, returns and service bookings, live before the holiday season.',
    endDate: '2026-12-04',
    id: PROJECT_ID,
    name: PROJECT_NAME,
    rank: 1,
    role: 'manager',
    startDate: '2026-07-13',
    status: 'In Progress',
    tenantId: 'tenant-synthetic',
    epics: [
      epic('epic-accounts', 'Accounts and sign-in', 'In Progress', [
        story('story-passwordless', 'Passwordless sign-in with email links', 'Completed', lee, 5, 16, [
          task('task-magic-link', 'Magic-link token service', 'Completed', lee, 3, 10),
          task('task-signin-email', 'Sign-in email template', 'Completed', dana, 2, 6),
        ], { end: '2026-09-12', start: '2026-08-31' }),
        story('story-sso', 'SSO discovery on the login screen', 'In Progress', sam, 8, 24, [
          task('task-idp-detect', 'Detect the customer’s identity provider', 'In Progress', sam, 3, 10, S14),
          task('task-idp-fallback', 'Fallback for unknown email domains', 'Not Started', sam, 2, 6, S14),
          task('task-sso-copy', 'Sign-in screen copy and errors', 'Review', dana, 2, 4, S14),
        ], { ...S14, end: '2026-10-07', priority: 1, start: '2026-09-28' }),
        story('story-wallet', 'Saved addresses and payment methods', 'Review', marcus, 5, 14, [
          task('task-address-book', 'Address book with default shipping', 'Completed', marcus, 3, 8, S14),
          task('task-card-vault', 'Tokenized card vault', 'Review', lee, 2, 6, S14),
        ], { ...S14, end: '2026-10-14', start: '2026-10-05' }),
      ], { end: '2026-10-16', start: '2026-08-17' }),
      epic('epic-orders', 'Orders and returns', 'In Progress', [
        story('story-history', 'Order history with tracking', 'In Progress', lee, 8, 26, [
          task('task-carrier-webhooks', 'Carrier tracking webhooks', 'In Progress', lee, 3, 10, S14),
          task('task-order-timeline', 'Order timeline component', 'Review', dana, 3, 8, S14),
          task('task-refund-status', 'Refund status in order history', 'Not Started', marcus, 2, 6, S14),
        ], { ...S14, end: '2026-10-16', priority: 2, start: '2026-10-05' }),
        story('story-returns', 'Start a return online', 'At Risk', sam, 13, 40, [
          task('task-return-reasons', 'Return reasons and prepaid labels', 'At Risk', sam, 5, 16, S14),
          task('task-store-dropoff', 'Store drop-off option', 'Not Started', lee, 3, 10, S14),
          task('task-return-email', 'Return confirmation email', 'Not Started', dana, 2, 6, S14),
          task('task-exchange', 'Exchange for a different size', 'Not Started', sam, 3, 8, S15),
        ], {
          ...S14,
          description: [
            'Customers start a return from their order history, choose a reason, and get a prepaid label or a store drop-off code.',
            '',
            '**Acceptance criteria**',
            '',
            '- Any item delivered in the last 60 days can be returned without calling customer care.',
            '- A return reason is required; “Other” asks for a short note.',
            '- The prepaid label arrives by email within a minute.',
            '- Store drop-off is offered only at stores on the new point-of-sale system.',
            '',
            'Exchanges for a different size come in Sprint 15.',
          ].join('\n'),
          end: '2026-10-16',
          fields: { acceptanceCriteria: 'A customer can return any item delivered in the last 60 days without calling customer care.' },
          priority: 1,
          start: '2026-10-05',
        }),
        story('story-export', 'CSV export of past orders', 'Not Started', marcus, 3, 8, [
          task('task-export-job', 'Background export job', 'Not Started', marcus, 3, 8, S15),
        ], S15),
      ], { end: '2026-11-06', start: '2026-09-14' }),
      epic('epic-service', 'Service bookings', 'In Progress', [
        story('story-book-service', 'Book a bike or ski service online', 'In Progress', dana, 8, 24, [
          task('task-service-catalog', 'Service catalog with price ranges', 'In Progress', dana, 3, 8, S14),
          task('task-slot-picker', 'Slot picker for workshop availability', 'Not Started', lee, 5, 16, S15),
        ], { ...S14, end: '2026-10-30', start: '2026-10-05' }),
        story('story-reminders', 'Pickup reminders by email', 'Not Started', sam, 3, 8, [
          task('task-reminder-schedule', 'Reminder schedule and template', 'Not Started', sam, 3, 8, S15),
        ], S15),
      ], { end: '2026-11-20', start: '2026-10-05' }),
      epic('epic-launch', 'Launch readiness', 'Not Started', [
        story('story-a11y', 'Accessibility audit and fixes', 'Not Started', dana, 5, 16, [
          task('task-a11y-audit', 'Audit checkout and returns flows', 'Not Started', dana, 3, 10),
        ]),
        story('story-load', 'Load test the order API', 'Not Started', marcus, 3, 10, [
          task('task-load-plan', 'Holiday traffic test plan', 'Not Started', priya, 1, 4),
        ]),
      ], { end: '2026-12-04', start: '2026-11-09' }),
    ],
  };
}

export function demoGovernance() {
  return {
    dependencies: [
      { dependencyType: 'FS', id: 'dependency-sso', lagDays: 0, predecessorId: 'story-sso', successorId: 'story-wallet', version: 1 },
      { dependencyType: 'FS', id: 'dependency-returns', lagDays: 0, predecessorId: 'story-history', successorId: 'story-returns', version: 1 },
    ],
    items: [
      { createdAt: '2026-09-22T12:00:00.000Z', description: 'The carrier tracking API allows 600 calls a minute; holiday volume could exceed it.', dueDate: '2026-10-24', id: 'risk-carrier', impact: 'high', kind: 'risk', ownerId: PEOPLE.lee.id, probability: 'medium', responsePlan: 'Batch tracking updates and cache the last status for 15 minutes.', status: 'monitoring', title: 'Carrier API rate limits', updatedAt: '2026-10-09T12:00:00.000Z', version: 2 },
      { createdAt: '2026-10-01T12:00:00.000Z', description: 'Store drop-off codes depend on the point-of-sale upgrade in all 14 stores.', dueDate: '2026-11-02', id: 'risk-pos', impact: 'high', kind: 'risk', ownerId: PEOPLE.marcus.id, probability: 'high', responsePlan: 'Launch returns with prepaid labels first; add drop-off per store as upgrades land.', status: 'open', title: 'Point-of-sale upgrade timing', updatedAt: '2026-10-10T12:00:00.000Z', version: 1 },
    ],
    milestones: [
      { id: 'milestone-beta', status: 'achieved', targetDate: '2026-10-05', title: 'Beta for store staff', version: 1, workItemId: 'story-passwordless' },
      { id: 'milestone-returns', status: 'planned', targetDate: '2026-10-30', title: 'Online returns live', version: 1, workItemId: 'story-returns' },
      { id: 'milestone-golive', status: 'planned', targetDate: '2026-12-04', title: 'Portal go-live', version: 1, workItemId: 'story-load' },
    ],
    scheduleBaselines: [],
    workingCalendar: { holidays: ['2026-11-26', '2026-11-27'], hoursPerDay: 8, timezone: 'America/New_York', version: 1, workingDays: [1, 2, 3, 4, 5] },
  };
}

export function demoScheduleAnalysis(governance) {
  return {
    baselineVariance: null,
    calendar: structuredClone(governance.workingCalendar),
    criticalPathIds: ['story-history', 'story-returns', 'story-a11y', 'story-load'],
    cyclicItemIds: [],
    dependencyCount: governance.dependencies.length,
    forecastFinish: '2026-12-07',
    forecastVarianceDays: 1,
    itemTimings: [],
    milestoneForecasts: [],
    passed: true,
    totalDurationDays: 104,
    workItemCount: 33,
  };
}

/** Comments on the returns story, shown in the item editor. */
export function demoComments() {
  return [
    {
      authorName: PEOPLE.ava.name, body: 'Customer care gets about 40 return calls a day in November. If drop-off codes slip, prepaid labels alone still take most of those calls away.', createdAt: '2026-10-09T14:12:00.000Z', id: 'comment-returns-1', itemId: 'story-returns', itemType: 'story', userId: PEOPLE.ava.id,
    },
    {
      authorName: PEOPLE.sam.name, body: 'Label generation works in staging. Return reasons need one more pass with Dana on the wording.', createdAt: '2026-10-10T16:40:00.000Z', id: 'comment-returns-2', itemId: 'story-returns', itemType: 'story', userId: PEOPLE.sam.id,
    },
  ];
}

const KANBAN_COLUMNS = [
  { defaultStatus: 'Not Started', key: 'to-do', name: 'To do', statuses: ['Not Started'] },
  { defaultStatus: 'In Progress', key: 'doing', name: 'In progress', statuses: ['In Progress', 'At Risk'] },
  { defaultStatus: 'Review', key: 'review', name: 'Review', statuses: ['Review'] },
  { defaultStatus: 'Completed', key: 'done', name: 'Done', statuses: ['Completed'] },
];

export function kanbanConfig() {
  return { config: { columns: KANBAN_COLUMNS, presets: [], swimlane: 'none' }, ok: true };
}

/** Sprint 14 as a board: every task in the sprint, plus finished work from earlier. */
export function kanbanBoard(project = demoProject()) {
  const cards = [];
  for (const epicNode of project.epics) {
    for (const storyNode of epicNode.stories) {
      for (const taskNode of storyNode.tasks) {
        if (taskNode.sprintId !== 'sprint-14' && !(taskNode.status === 'Completed' && epicNode.id === 'epic-accounts')) continue;
        cards.push({
          assigneeId: taskNode.assigneeId, assigneeName: taskNode.assigneeName, boardColumn: null, epicId: epicNode.id, epicName: epicNode.name,
          id: taskNode.id, issueType: 'task', name: taskNode.name, parentName: storyNode.name, points: taskNode.points,
          sprintId: taskNode.sprintId ?? 'sprint-13', status: taskNode.status, storyId: storyNode.id, targetHourEstimate: taskNode.targetHourEstimate,
        });
      }
    }
  }
  return {
    board: {
      cards,
      columns: KANBAN_COLUMNS,
      members: TEAM.slice(0, 5).map(({ id, name }) => ({ id, name })),
      sprints: [
        { endDate: '2026-10-02', id: 'sprint-13', name: 'Sprint 13', startDate: '2026-09-21', status: 'completed' },
        { endDate: '2026-10-16', id: 'sprint-14', name: 'Sprint 14', startDate: '2026-10-05', status: 'active' },
        { endDate: '2026-10-30', id: 'sprint-15', name: 'Sprint 15', startDate: '2026-10-19', status: 'planned' },
      ],
      swimlane: 'none',
    },
    ok: true,
  };
}

// --- Home ---------------------------------------------------------------------------------

export const HOME_AS_OF = '2026-10-12T15:00:00.000Z';
const ok = (key) => ({ failedProjectIds: [], key, status: 'ok' });
const reason = (code, label, extra = {}) => ({ code, label, ...extra });

function homeRow(id, title, reasons, { due = null, kind = 'work-item', projectName = PROJECT_NAME, rank, tabs }) {
  return {
    due, id, kind,
    link: { name: 'project-detail', params: { projectId: PROJECT_ID }, query: { item: id.replace(/^[a-z]+:/, '') } },
    projectId: PROJECT_ID, projectName, rank, reasons, tabs,
    tier: reasons.some((entry) => entry.tone === 'hot') ? 1 : 2,
    title,
  };
}

function homeSprint(overrides = {}) {
  return {
    behind: true, committedPoints: 34, donePct: 47, donePoints: 16, elapsedPct: 70, endDate: '2026-10-16', id: 'sprint-14', idealPct: 70,
    link: { name: 'project-kanban', params: { projectId: PROJECT_ID } }, myItems: null, name: 'Sprint 14', peopleBehind: 1,
    projectId: PROJECT_ID, projectName: PROJECT_NAME, projectedPoints: 23, startDate: '2026-10-05', status: 'behind', threshold: 17, unit: 'points', willNotFinishPoints: 11,
    ...overrides,
  };
}

/** Priya's team view: Sprint 14 is behind, with recovery options and a ranked list. */
export function demoHome() {
  const changes = [4, 6, 5, 8, 3, 2, 7, 9, 6, 8, 5, 4, 3, 9, 11, 7, 6, 8, 10, 5, 3, 4, 9, 12, 8, 7, 10, 9, 6, 11];
  const series = changes.map((count, index) => ({ count, date: new Date(Date.UTC(2026, 8, 13 + index)).toISOString().slice(0, 10) }));
  const focus = [
    homeRow('team:story-sso', 'Unblock Sam on “SSO discovery on the login screen”', [reason('blocks', 'Blocks 2 people', { count: 2 }), reason('overdue', 'Overdue 2d', { count: 2, tone: 'hot' })], { due: { at: '2026-10-07', kind: 'due' }, kind: 'blocker', rank: 1, tabs: ['focus', 'team', 'all'] }),
    homeRow('approval:history', 'Approve: Order history with tracking to Completed', [reason('past-sla', 'Past SLA', { tone: 'hot' })], { due: { at: '2026-10-12T12:00:00.000Z', kind: 'due' }, kind: 'approval', rank: 2, tabs: ['focus', 'decide', 'all'] }),
    homeRow('risk:pos', 'Respond to critical risk: Point-of-sale upgrade timing', [reason('critical-risk', 'Critical risk')], { due: { at: null, kind: 'owner' }, kind: 'risk', rank: 3, tabs: ['focus', 'team', 'all'] }),
    homeRow('decide:price', 'Decide: Should customers see a price range before they pick a time?', [reason('decision', 'Decision waiting'), reason('required-reviewer', '3 of 5 reviewers in')], { kind: 'decision', rank: 4, tabs: ['focus', 'decide', 'all'] }),
    homeRow('review:round-2', 'Review round 2: Service booking', [reason('required-reviewer', 'Required reviewer')], { due: { at: '2026-10-15', kind: 'due' }, kind: 'review', rank: 5, tabs: ['focus', 'decide', 'all'] }),
  ];
  const proposals = [
    { applyVia: 'ai-workspace', blockedReason: null, detail: 'Lowest priority and not started: “Refund status in order history” and “Return confirmation email”.', id: 'rp_aaaaaaaaaaaaaaaa', impact: { days: null, points: 13, text: 'Brings the sprint back over the line.' }, permitted: true, projectId: PROJECT_ID, sprintId: 'sprint-14', summary: 'Move 2 stories (13 pts) to Sprint 15', type: 'move-scope' },
    { applyVia: 'ai-workspace', blockedReason: null, detail: 'Lee has 9 free hours this sprint.', id: 'rp_bbbbbbbbbbbbbbbb', impact: { days: null, points: 5, text: 'Frees 5 pts.' }, permitted: true, projectId: PROJECT_ID, sprintId: 'sprint-14', summary: 'Reassign “Return reasons and prepaid labels” to Lee Park', type: 'reassign' },
    { applyVia: 'ai-workspace', blockedReason: null, detail: 'Move 2 of 4 tasks to a new story in Sprint 15.', id: 'rp_cccccccccccccccc', impact: { days: null, points: 3, text: 'Frees 3 pts.' }, permitted: true, projectId: PROJECT_ID, sprintId: 'sprint-14', summary: 'Split “Start a return online” and finish the started part', type: 'split-story' },
  ];
  return {
    asOf: HOME_AS_OF,
    focus: { items: focus, total: focus.length },
    items: focus,
    ok: true,
    rail: {
      changeTrends: { days: 30, series, total: series.reduce((sum, point) => sum + point.count, 0), yesterday: 6 },
      counts: [
        { href: null, key: 'active-sprints', label: 'Active sprints', note: '1 behind', severity: 'warn', value: 3 },
        { href: { name: 'workflows' }, key: 'approvals', label: 'Pending approvals', note: '1 past SLA', severity: 'warn', value: 4 },
        { href: null, key: 'critical-risks', label: 'Critical risks', note: 'of 9 open', severity: 'danger', value: 2 },
        { href: { name: 'resources' }, key: 'overallocated', label: 'Overallocated', note: 'people this sprint', severity: 'warn', value: 1 },
      ],
      leaderboard: {
        days: 7,
        me: { id: PEOPLE.priya.id, isCurrentUser: true, name: PEOPLE.priya.name, picture: null, points: 6, rank: 6, tasks: 2 },
        top: [
          { id: PEOPLE.lee.id, isCurrentUser: false, name: PEOPLE.lee.name, picture: null, points: 34, rank: 1, tasks: 9 },
          { id: PEOPLE.dana.id, isCurrentUser: false, name: PEOPLE.dana.name, picture: null, points: 28, rank: 2, tasks: 7 },
          { id: PEOPLE.marcus.id, isCurrentUser: false, name: PEOPLE.marcus.name, picture: null, points: 21, rank: 3, tasks: 6 },
        ],
      },
      sprints: [
        homeSprint(),
        homeSprint({ behind: false, committedPoints: 20, donePoints: 18, elapsedPct: 85, endDate: '2026-10-19', id: 'sprint-3', idealPct: 85, name: 'Sprint 3', peopleBehind: 0, projectName: 'Store Inventory Sync', status: 'on-track' }),
        homeSprint({ behind: false, committedPoints: 40, donePoints: 9, elapsedPct: 25, endDate: '2026-10-24', id: 'sprint-6', idealPct: 25, name: 'Sprint 6', peopleBehind: 0, projectName: 'Checkout Redesign', status: 'on-track' }),
      ],
    },
    recovery: { generatedAt: HOME_AS_OF, mode: 'hybrid', proposals, subject: { personId: null, projectId: PROJECT_ID, scope: 'sprint', sprintId: 'sprint-14' } },
    sources: ['projects', 'workflows', 'sprints', 'governance', 'relations', 'requirements', 'alerts', 'leaderboard', 'changes'].map(ok),
    status: {
      evidence: [
        { label: "From 50% of a sprint's working days, anyone who has closed less than 50% of the points assigned to them is behind.", rule: 'behind.rule', values: {} },
        { label: '7 of 10 working days are gone (70%).', rule: 'behind.elapsed', values: {} },
        { label: 'The sprint closed 16 of 34 points; half is 17.', rule: 'behind.sprint', values: {} },
      ],
      headline: 'Sprint 14 is behind',
      kind: 'behind',
      otherBehindSprints: 0,
      people: [{ assigned: 30, behind: true, closed: 7, id: PEOPLE.sam.id, name: PEOPLE.sam.name, threshold: 15 }],
      say: 'At this pace about 11 pts will not finish by Fri. Behind: Sam Ortiz (7 of 30 pts).',
      scope: 'sprint',
      sprint: { committedPoints: 34, donePct: 47, donePoints: 16, elapsedPct: 70, endDate: '2026-10-16', id: 'sprint-14', name: 'Sprint 14', projectId: PROJECT_ID, projectName: PROJECT_NAME, threshold: 17, unit: 'points', willNotFinishPoints: 11 },
    },
    tabs: [
      { count: 5, key: 'focus', label: 'Focus now' },
      { count: 3, key: 'decide', label: 'Decide' },
      { count: 2, key: 'team', label: 'Team' },
      { count: 0, key: 'assigned', label: 'Assigned' },
      { count: 5, key: 'all', label: 'All' },
    ],
    viewer: { defaultLens: 'team', id: PEOPLE.priya.id, lens: 'team', lenses: ['my-work', 'team'], managedProjectCount: 4, name: PEOPLE.priya.name, projectCount: 5, projectsTruncated: false, tenantRole: 'member', twoFactorEnabled: true },
  };
}

// --- Projects list ------------------------------------------------------------------------

export function demoProjectList() {
  const project = (id, name, status, extra = {}) => ({
    description: '', endDate: null, id, name, rank: null, role: 'manager', startDate: null, status, tenantId: 'tenant-synthetic', updatedAt: '2026-10-09T12:00:00.000Z', ...extra,
  });
  return [
    project(PROJECT_ID, PROJECT_NAME, 'In Progress', { endDate: '2026-12-04', rank: 1, startDate: '2026-07-13' }),
    project('p-checkout', 'Checkout Redesign', 'In Progress', { endDate: '2026-11-20', rank: 2, startDate: '2026-08-24' }),
    project('p-inventory', 'Store Inventory Sync', 'At Risk', { endDate: '2026-10-30', rank: 3, startDate: '2026-06-15' }),
    project('p-loyalty', 'Loyalty Program Launch', 'Planned', { endDate: '2027-03-31', rank: 4, startDate: '2026-11-02' }),
    project('p-scanners', 'Warehouse Scanner Rollout', 'Review', { endDate: '2026-10-23', rank: 5, startDate: '2026-07-06' }),
    project('p-reviews', 'Product Reviews and Q&A', 'In Progress', { endDate: '2026-11-13', rank: 6, startDate: '2026-09-08' }),
    project('p-mobile', 'Mobile App Refresh', 'Planned', { endDate: '2027-02-26', rank: 7, startDate: '2026-11-16' }),
    project('p-lockers', 'Store Pickup Lockers', 'Planned', { endDate: '2027-04-30', rank: 8, startDate: '2027-01-11' }),
    project('p-catalog', 'Holiday Catalog 2026', 'Completed', { endDate: '2026-09-30', rank: 9, startDate: '2026-06-01' }),
    project('p-giftcards', 'Gift Card Platform Retirement', 'Archived', { rank: 10 }),
  ];
}

export function demoProjectSignals() {
  const waiting = (counts) => ({ answer: 0, decide: 0, drafts: 0, review: 0, ...counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) });
  const at = (day, hour) => new Date(Date.UTC(2026, 9, day, hour, 0)).toISOString();
  return [
    { projectId: PROJECT_ID, review: { awaitingYou: true, dueAt: at(16, 1), id: 'round-2', number: 2, openCount: 1, required: true, reviewer: true, submitted: false, track: 'experience' }, waiting: waiting({ answer: 1, decide: 2, review: 1 }) },
    { projectId: 'p-checkout', review: { awaitingYou: false, dueAt: at(16, 21), id: 'round-checkout', number: 1, openCount: 1, required: false, reviewer: true, submitted: true, track: 'architecture' }, waiting: waiting({ answer: 1 }) },
    { projectId: 'p-inventory', review: null, waiting: waiting({ decide: 1 }) },
    { projectId: 'p-loyalty', review: null, waiting: waiting({}) },
    { projectId: 'p-scanners', review: null, waiting: waiting({}) },
    { projectId: 'p-reviews', review: null, waiting: waiting({ answer: 2 }) },
    { projectId: 'p-mobile', review: { awaitingYou: false, dueAt: null, id: 'round-mobile', number: 1, openCount: 1, required: false, reviewer: false, submitted: false, track: 'experience' }, waiting: waiting({}) },
    { projectId: 'p-lockers', review: null, waiting: waiting({}) },
    { projectId: 'p-catalog', review: null, waiting: waiting({}) },
  ];
}

// --- Leaderboard --------------------------------------------------------------------------

export function demoLeaderboard(days) {
  const rows = [
    [PEOPLE.lee, 62, 15, 58.5],
    [PEOPLE.dana, 54, 13, 49],
    [PEOPLE.marcus, 47, 11, 41.5],
    [PEOPLE.sam, 41, 10, 52],
    [{ id: 'user-nina', name: 'Nina Okafor' }, 33, 8, 30],
    [PEOPLE.priya, 26, 7, 22.5],
    [{ id: 'user-tomas', name: 'Tomas Varga' }, 21, 6, 18],
    [{ id: 'user-grace', name: 'Grace Whitfield' }, 17, 5, 14.5],
    [{ id: 'user-omar', name: 'Omar Siddiqui' }, 12, 4, 11],
    [{ id: 'user-julia', name: 'Julia Brandt' }, 8, 3, 7.5],
  ];
  const scale = days === 7 ? 0.3 : days === 90 ? 2.6 : 1;
  const leaderboard = rows.map(([person, points, tasks, hours], index) => ({
    hoursLogged: Math.round(hours * scale * 2) / 2,
    id: person.id,
    isCurrentUser: person.id === PEOPLE.priya.id,
    name: person.name,
    picture: null,
    points: Math.round(points * scale),
    rank: index + 1,
    tasksCompleted: Math.max(1, Math.round(tasks * scale)),
  }));
  return { contributorCount: 14, currentUser: leaderboard.find((row) => row.isCurrentUser), days, leaderboard, ok: true };
}
