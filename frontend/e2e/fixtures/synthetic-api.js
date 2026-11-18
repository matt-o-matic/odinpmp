import { expect } from '@playwright/test';

import { syntheticHomePayload } from './home-api.js';

const API_ORIGIN = 'http://localhost:3001';
const TOKEN = `synthetic.${Buffer.from(JSON.stringify({
  email: 'demo@example.com',
  exp: 4_102_444_800,
  name: 'Synthetic Demo',
  role: 'member',
  sub: 'user-synthetic',
  tenantId: 'tenant-synthetic',
})).toString('base64url')}.signature`;

export const syntheticUser = {
  email: 'demo@example.com',
  id: 'user-synthetic',
  name: 'Synthetic Demo',
  preferences: { twoFactorEnabled: false },
  role: 'member',
  scopes: [],
  tenantId: 'tenant-synthetic',
  tenantName: 'Synthetic Workspace',
};

export const syntheticProject = {
  assistantState: { brief: {} },
  description: 'Synthetic browser acceptance fixture.',
  endDate: '2026-09-30',
  epics: [{
    id: 'epic-synthetic',
    name: 'Delivery',
    status: 'In Progress',
    version: 1,
    stories: [{
      id: 'story-synthetic',
      name: 'Release pilot',
      status: 'In Progress',
      version: 2,
      targetEndDate: '2026-08-20',
      targetStartDate: '2026-08-10',
      tasks: [{
        id: 'task-synthetic',
        name: 'Validate rollout',
        status: 'Not Started',
        version: 1,
        targetEndDate: '2026-08-28',
        targetStartDate: '2026-08-21',
      }],
    }],
  }],
  id: 'project-synthetic',
  name: 'Synthetic Delivery Plan',
  rank: 1,
  role: 'member',
  startDate: '2026-07-10',
  status: 'In Progress',
  tenantId: 'tenant-synthetic',
};

function json(route, body, status = 200) {
  return route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    status,
  });
}

export async function installSyntheticApi(page, { admin = false, agentGoals: extraAgentGoals = [], capabilities = [], approvedImpersonation = false, assistantChat = null, assistantReply = 'Synthetic Project is on track.', preferences = {}, ssoMode = 'none', tenantUsers: extraTenantUsers = [], timeEntries: extraTimeEntries = [] } = {}) {
  let authenticated = false;
  const activeUser = { ...syntheticUser, capabilities: [...capabilities], preferences: { ...syntheticUser.preferences, ...preferences }, ...(admin ? { role: 'admin' } : {}) };
  const impersonatedUser = { ...syntheticUser, capabilities: [], email: 'target@example.com', id: 'target-synthetic', name: 'Target User', role: 'member' };
  // Assistant chats: one optional seeded chat, plus any created during the test. A message gets
  // a finished reply straight away, since the event streams are empty here.
  const assistantChats = new Map(assistantChat ? [[assistantChat.id, structuredClone(assistantChat)]] : []);
  const unexpectedRequests = [];
  let governance = {
    dependencies: [{
      dependencyType: 'FS', id: 'dependency-synthetic', lagDays: 0,
      predecessorId: 'story-synthetic', successorId: 'task-synthetic', version: 1,
    }],
    items: [{
      createdAt: '2026-07-10T12:00:00.000Z', description: 'Vendor capacity may constrain the pilot.',
      dueDate: '2026-08-01', id: 'risk-synthetic', impact: 'high', kind: 'risk', ownerId: 'user-synthetic',
      probability: 'medium', responsePlan: 'Confirm capacity and retain a backup vendor.', status: 'monitoring',
      title: 'Vendor capacity', updatedAt: '2026-07-10T12:00:00.000Z', version: 1,
    }],
    milestones: [{
      id: 'milestone-synthetic', status: 'planned', targetDate: '2026-08-28', title: 'Pilot ready',
      version: 1, workItemId: 'task-synthetic',
    }],
    scheduleBaselines: [],
    workingCalendar: {
      holidays: ['2026-07-03'], hoursPerDay: 8, timezone: 'America/New_York',
      version: 1, workingDays: [1, 2, 3, 4, 5],
    },
  };
  let agentGoals = [{
    constraints: { allowWebResearch: false, maxAttempts: 5 }, id: 'goal-synthetic', ownerUserId: syntheticUser.id,
    projectId: syntheticProject.id, scope: { projectIds: [syntheticProject.id] }, status: 'active',
    success: { measure: 'No missed launch milestone' }, title: 'Protect launch readiness', version: 1,
  }, ...structuredClone(extraAgentGoals)];
  let goalMonitors = [{
    enabled: true, goalId: 'goal-synthetic', id: 'monitor-synthetic', intervalMinutes: 30,
    payload: { context: { focus: 'schedule health' }, sessionId: 'session-monitor' }, runCount: 2,
    title: 'Schedule health', triggerType: 'schedule', version: 1,
  }];
  let goalNotifications = [{
    evidence: { failedCheckIds: ['governance.no_open_critical_risks'] }, goalId: 'goal-synthetic', id: 'notification-synthetic',
    kind: 'verifier_failed', message: 'One required project-health check failed.', severity: 'critical',
    status: 'unread', title: 'Goal needs attention: Protect launch readiness', version: 1,
  }];
  const goalRuns = [];
  let portfolioNodes = [{
    description: 'Enterprise change portfolio.', governanceStage: 'active', id: 'portfolio-synthetic', kind: 'portfolio',
    name: 'Enterprise growth', parentId: null, rollup: { benefits: { USD: 750000 }, projectCount: 1, score: 82.5 },
    status: 'active', version: 1,
  }, {
    description: 'Customer delivery program.', governanceStage: 'delivery', id: 'program-synthetic', kind: 'program',
    name: 'Customer launch', parentId: 'portfolio-synthetic', rollup: { benefits: { USD: 750000 }, projectCount: 1, score: 82.5 },
    status: 'active', version: 1,
  }];
  let strategyObjectives = [{
    currentValue: 40, id: 'objective-synthetic', kind: 'objective', parentId: null, progressPercent: 40,
    status: 'active', targetValue: 100, title: 'Increase customer activation', unit: 'percent', version: 1,
  }];
  let portfolioAlignments = [{
    benefitUnit: 'USD', benefitValue: 750000, costScore: 30, demandStatus: 'active', id: 'alignment-synthetic',
    fundingCurrency: 'USD', objectiveId: 'objective-synthetic', portfolioNodeId: 'program-synthetic', projectId: syntheticProject.id,
    requestedFunding: 250000, requestedHours: 4000, riskScore: 25, scenario: 'baseline', strategicScore: 90, version: 1,
  }];
  let portfolioPlans = [{ decisionNote: '', fundingCurrency: 'USD', fundingLimit: 300000, id: 'plan-synthetic', name: 'Funded baseline', portfolioNodeId: 'portfolio-synthetic', resourceHoursLimit: 5000, scenario: 'baseline', status: 'submitted', version: 1 }];
  let portfolioBaselines = [{ capturedAt: '2026-07-11T12:00:00.000Z', capturedBy: syntheticUser.id, id: 'portfolio-baseline-synthetic', name: 'Steering baseline', portfolioNodeId: 'portfolio-synthetic', scenario: 'baseline', snapshot: { alignments: [{ id: 'alignment-synthetic', projectId: syntheticProject.id }], contentHash: 'c'.repeat(64), projects: [{ id: syntheticProject.id, name: syntheticProject.name, status: syntheticProject.status }] }, version: 1 }];
  let resourcePools = [{ description: 'Product and platform delivery.', id: 'pool-synthetic', managerId: syntheticUser.id, name: 'Engineering', status: 'active', version: 1 }];
  let enterpriseResources = [{ billRate: 220, capacityHoursPerWeek: 40, costRate: 140, currency: 'USD', id: 'resource-synthetic', location: 'Remote', name: 'Alex Engineer', poolId: 'pool-synthetic', roles: ['Engineer'], skills: [{ level: 5, name: 'Delivery' }], status: 'active', userId: syntheticUser.id, version: 1 }];
  let resourceCalendarEntries = [{ endDate: '2026-07-15', entryType: 'leave', hoursPerDay: 4, id: 'calendar-synthetic', note: 'Approved leave', resourceId: 'resource-synthetic', startDate: '2026-07-14', status: 'approved', version: 1 }];
  let resourceAllocations = [{ allocationPercent: 110, endDate: '2026-09-30', hoursPerWeek: 44, id: 'allocation-synthetic', projectId: syntheticProject.id, resourceId: 'resource-synthetic', role: 'Lead engineer', scenario: 'baseline', startDate: '2026-07-01', status: 'active', version: 1 }];
  let financialEntries = [{ amount: 500000, category: 'Delivery envelope', currency: 'USD', effectiveDate: '2026-07-01', entryKind: 'budget', id: 'finance-synthetic', note: '', projectId: syntheticProject.id, sourceId: null, sourceType: 'manual', status: 'approved', version: 1 }];
  let timeEntries = [{ billable: true, hours: 8, id: 'time-synthetic', note: '', projectId: syntheticProject.id, resourceId: 'resource-synthetic', status: 'approved', version: 1, workDate: '2026-07-10', workItemId: null }, ...structuredClone(extraTimeEntries)];
  let expenseEntries = [{ amount: 1200, category: 'Travel', currency: 'USD', expenseDate: '2026-07-09', id: 'expense-synthetic', note: '', projectId: syntheticProject.id, receiptReference: 'receipt-1', resourceId: 'resource-synthetic', status: 'approved', version: 1 }];
  let resourceRates = [{ billRate: 230, costRate: 145, currency: 'USD', effectiveEnd: null, effectiveStart: '2026-07-01', id: 'rate-synthetic', resourceId: 'resource-synthetic', status: 'approved', version: 1 }];
  let timesheetPeriods = [{ approvalDueDate: '2026-07-15', endDate: '2026-07-12', id: 'period-synthetic', name: 'July week two', startDate: '2026-07-06', status: 'open', version: 1 }];
  let expenseReceipts = [{ contentType: 'application/pdf', expenseId: 'expense-synthetic', fileName: 'travel.pdf', id: 'receipt-synthetic', sha256: 'a'.repeat(64), sizeBytes: 2048, status: 'active', storageKey: 'synthetic/travel.pdf', version: 1 }];
  let exchangeRates = [{ baseCurrency: 'USD', effectiveDate: '2026-07-01', id: 'fx-synthetic', quoteCurrency: 'EUR', rate: 0.91, source: 'Treasury', status: 'approved', version: 1 }];
  let accountingPeriods = []; let financePolicies = [];
  let workflowDefinitions = [{ description: 'Controlled project delivery.', id: 'workflow-synthetic', itemTypes: ['project'], name: 'Delivery lifecycle', states: [{ category: 'active', initial: true, key: 'In Progress', label: 'In progress', requiredFields: [], slaHours: 0, terminal: false }, { category: 'done', initial: false, key: 'Completed', label: 'Completed', requiredFields: [], slaHours: 24, terminal: true }], status: 'active', transitions: [{ allowedRoles: ['manager'], approvalRequired: true, approverRoles: ['admin'], fromState: 'In Progress', key: 'complete', requiredFields: [], toState: 'Completed' }], version: 1 }];
  let workflowBindings = [{ id: 'binding-synthetic', itemType: 'project', projectId: syntheticProject.id, version: 1, workflowId: 'workflow-synthetic' }];
  let workflowApprovals = [{ expiresAt: '2099-01-01T00:00:00.000Z', fromState: 'In Progress', id: 'approval-synthetic', itemId: syntheticProject.id, itemType: 'project', note: 'Ready for review', projectId: syntheticProject.id, requestedBy: 'requester-user', status: 'pending', toState: 'Completed', transitionKey: 'complete', version: 1 }];
  let projectBaselines = [{ capturedAt: '2026-07-10T12:00:00.000Z', createdBy: syntheticUser.id, id: 'baseline-synthetic', name: 'Approved delivery plan', note: 'Initial approved scope.', projectId: syntheticProject.id, version: 1 }];
  // Template payloads follow the typed schemas; the legacy row keeps the old free-form shape
  // the backend reports as needing an update.
  const storyFlow = { description: 'Ready, doing, done.', itemTypes: ['story', 'task'], states: [{ category: 'backlog', initial: true, key: 'ready', label: 'Ready', requiredFields: [], slaHours: 0, terminal: false }, { category: 'active', initial: false, key: 'doing', label: 'Doing', requiredFields: [], slaHours: 8, terminal: false }, { category: 'done', initial: false, key: 'done', label: 'Done', requiredFields: [], slaHours: 0, terminal: true }], transitions: [{ allowedRoles: [], approvalRequired: false, approverRoles: [], fromState: 'ready', key: 'start', requiredFields: [], toState: 'doing' }, { allowedRoles: ['manager'], approvalRequired: true, approverRoles: ['admin'], fromState: 'doing', key: 'finish', requiredFields: [], toState: 'done' }] };
  let projectTemplates = [
    { description: 'Standard delivery project.', id: 'template-synthetic', kind: 'project', name: 'Delivery starter', payload: { status: 'In Progress' }, payloadIssues: ["Unrecognized key(s) in object: 'status'"], payloadStatus: 'needs_update', status: 'active', version: 1 },
    { description: 'Story and task flow with an approval to finish.', id: 'template-workflow', kind: 'workflow', name: 'Story flow', payload: storyFlow, payloadIssues: [], payloadStatus: 'valid', status: 'active', version: 1 },
    { description: 'Discovery project with a starter outline.', id: 'template-project', kind: 'project', name: 'Discovery project', payload: { customFields: [{ description: '', fieldType: 'string', name: 'Research notes', options: [], required: false, scope: 'story' }], outline: { epics: [{ description: '', name: 'Discovery', points: null, stories: [{ description: '', name: 'Interview users', points: 3, tasks: [{ description: '', name: 'Book sessions', points: 1 }] }] }] }, workflowBindings: [{ itemType: 'story', sourceId: 'template-workflow', sourceKind: 'workflow_template' }] }, payloadIssues: [], payloadStatus: 'valid', status: 'active', version: 1 },
    { description: 'Time-boxed research story.', id: 'template-spike', kind: 'work_item', name: 'Research spike', payload: { acceptanceCriteria: 'Findings are written up.', category: null, customFieldDefaults: [], description: 'Investigate the options.', itemType: 'story', points: 3, priority: 2, severity: null }, payloadIssues: [], payloadStatus: 'valid', status: 'active', version: 1 },
    { description: 'Customer-facing outage.', id: 'template-outage', kind: 'work_item', name: 'Outage report', payload: { acceptanceCriteria: '', category: 'defect', customFieldDefaults: [], description: 'Impact, start time and affected customers.', itemType: 'ticket', points: null, priority: 1, severity: 'S1' }, payloadIssues: [], payloadStatus: 'valid', status: 'active', version: 1 },
  ];
  let customFields = [{ description: 'Evidence used for controlled completion.', fieldType: 'string', id: 'field-synthetic', name: 'Acceptance evidence', options: [], required: true, scope: 'project', status: 'active', version: 1 }];
  let customValues = [{ fieldId: 'field-synthetic', id: 'value-synthetic', itemId: syntheticProject.id, itemType: 'project', projectId: syntheticProject.id, value: 'Pilot acceptance recorded', version: 1 }];
  let workflowHistories = [{ fromState: 'Planned', id: 'history-synthetic', itemId: syntheticProject.id, itemType: 'project', occurredAt: '2026-07-10T12:00:00.000Z', projectId: syntheticProject.id, slaDueAt: '2099-01-02T12:00:00.000Z', slaEventEnqueuedAt: null, toState: 'In Progress', transitionEventEnqueuedAt: '2026-07-10T12:00:01.000Z', transitionKey: 'start', userId: syntheticUser.id, version: 1 }];
  let reportDefinitions = [{ columns: ['projectId', 'projectName', 'status'], dataset: 'project', description: 'Current project delivery status.', filters: {}, groupBy: [], id: 'report-synthetic', name: 'Project status', ownerUserId: syntheticUser.id, projectId: null, status: 'active', version: 1, visibility: 'tenant', visualization: 'table' }];
  let savedViews = [{ columns: ['title', 'documentType'], filters: { status: 'active' }, id: 'view-synthetic', name: 'Active delivery records', ownerUserId: syntheticUser.id, projectId: syntheticProject.id, sort: [], surface: 'global_search', version: 1, visibility: 'project' }];
  let reportSubscriptions = [{ deliveryChannel: 'in_app', enabled: true, format: 'csv', id: 'subscription-synthetic', lastRunAt: null, nextRunAt: '2099-01-01T12:00:00.000Z', ownerUserId: syntheticUser.id, recipients: [], reportId: 'report-synthetic', schedule: { intervalMinutes: 1440, timezone: 'America/New_York' }, version: 1 }];
  let reportRuns = []; let reportSnapshots = [];
  let identityPolicy = { defaultRoleKey: 'user', jitEnabled: false, loginEnforcement: 'optional', provider: { issuer: '' }, ssoMode: 'none', version: 1 };
  let breakGlassPolicy = { enabled: false, maxSessionMinutes: 15, userIds: [], version: 1 };
  let identityDomains = [{ domain: 'synthetic.example.com', id: 'domain-synthetic', status: 'verified', verificationMethod: 'manual', verifiedAt: '2026-07-11T12:00:00.000Z', version: 1 }];
  let identityRoles = []; let identityGroups = []; let identityGroupMemberships = []; let accessReviewCampaigns = []; let accessReviewCampaignRuns = []; let accessReviews = []; let accessReviewItems = [];
  let serviceAccounts = []; let serviceCredentials = []; let impersonationGrants = approvedImpersonation ? [{ approvedBy: 'admin-reviewer', expiresAt: '2099-01-01T00:00:00.000Z', id: 'impersonation-approved', reason: 'Investigate an authorized support incident.', requesterUserId: syntheticUser.id, status: 'approved', targetUserId: impersonatedUser.id, version: 2 }] : []; const domainProofs = new Map();
  let oauthApplications = [{ clientId: 'odin_client_synthetic', createdAt: '2026-07-11T12:00:00.000Z', enabled: true, id: 'oauth-synthetic', lastUsedAt: null, name: 'Portfolio reader', projectIds: [syntheticProject.id], scopes: ['projects.read'], version: 1 }];
  let webhookSubscriptions = [{ createdAt: '2026-07-11T12:00:00.000Z', description: 'Governance lifecycle events.', enabled: true, eventTypes: ['governance.changed'], id: 'webhook-synthetic', lastDeliveredAt: null, lastFailureAt: '2026-07-11T12:01:00.000Z', name: 'Delivery receiver', signingKeyVersion: 1, url: 'https://hooks.example.com/odin', version: 1 }];
  let webhookDeliveries = [{ attempts: 8, createdAt: '2026-07-11T12:00:00.000Z', eventId: 'event-synthetic', eventType: 'governance.changed', id: 'delivery-synthetic', lastError: 'HTTP 503', responseCode: 503, status: 'dead', subscriptionId: 'webhook-synthetic', updatedAt: '2026-07-11T12:01:00.000Z', version: 2 }];
  const connectorCatalog = [
    { authTypes: ['oauth2', 'pat', 'webhook'], capabilities: ['issues', 'projects', 'webhooks'], key: 'jira', name: 'Jira' },
    { authTypes: ['oauth2', 'pat', 'webhook'], capabilities: ['issues', 'pull_requests', 'webhooks'], key: 'github', name: 'GitHub' },
    { authTypes: ['oauth2', 'pat', 'webhook'], capabilities: ['channels', 'messages', 'events'], key: 'slack', name: 'Slack' },
  ];
  let connectorConnections = [{ authType: 'webhook', conflictPolicy: 'manual', createdAt: '2026-07-11T12:00:00.000Z', id: '11111111-1111-4111-8111-111111111111', name: 'Engineering Jira', projectIds: [syntheticProject.id], provider: 'jira', scopes: ['issues'], status: 'active', syncDirection: 'bidirectional', updatedAt: '2026-07-11T12:00:00.000Z', version: 1 }];
  let connectorMappings = [{ connectionId: connectorConnections[0].id, externalId: 'JIRA-100', id: 'mapping-synthetic', objectType: 'issue', odinId: 'task-synthetic', projectId: syntheticProject.id, version: 1 }];
  let connectorConflicts = [{ connectionId: connectorConnections[0].id, id: '22222222-2222-4222-8222-222222222222', note: 'Both systems changed this issue.', objectType: 'issue', status: 'open', version: 1 }];
  let connectorEvents = [{ connectionId: connectorConnections[0].id, eventType: 'issues.updated', externalEventId: 'jira-event-1', id: 'event-connector-synthetic', status: 'pending', updatedAt: '2026-07-11T12:02:00.000Z', version: 1 }];
  let connectorRuns = [];
  const searchDocuments = [{ content: 'Synthetic browser acceptance fixture launch delivery plan.', documentType: 'project', facets: { status: 'In Progress' }, id: 'search-project', indexedAt: '2026-07-11T12:00:00.000Z', projectId: syntheticProject.id, sourceId: syntheticProject.id, title: syntheticProject.name, updatedAt: '2026-07-11T12:00:00.000Z', url: `/projects/${syntheticProject.id}` }, { content: 'Vendor capacity may constrain the pilot.', documentType: 'risk', facets: { impact: 'high', status: 'monitoring' }, id: 'search-risk', indexedAt: '2026-07-11T12:00:00.000Z', projectId: syntheticProject.id, sourceId: 'risk-synthetic', title: 'Vendor capacity', updatedAt: '2026-07-11T12:00:00.000Z', url: `/projects/${syntheticProject.id}?tab=governance` }];

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method === 'GET' && path === '/api/auth/sso/discover') return json(route, ssoMode === 'none' ? { configured: false, mode: 'none' } : { configured: true, enforced: true, mode: ssoMode, tenantId: '11111111-1111-4111-8111-111111111111' });

    if (method === 'POST' && path === '/api/auth/break-glass/start') {
      return json(route, { challengeToken: 'synthetic-break-glass-challenge', ok: true, requiresTwoFactor: true }, 202);
    }
    if (method === 'POST' && path === '/api/auth/break-glass/verify') {
      authenticated = true;
      return json(route, { breakGlass: { expiresAt: '2099-01-01T00:15:00.000Z', policyVersion: 1, reason: 'Synthetic identity provider outage incident.' }, ok: true, session: { token: 'synthetic-break-glass-token', user: { ...activeUser, role: 'admin' } } });
    }
    if (method === 'POST' && path === '/api/auth/login') {
      authenticated = true;
      return json(route, { session: { refreshToken: '', token: TOKEN, user: activeUser } });
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      authenticated = false;
      return json(route, {});
    }
    if (method === 'POST' && path === '/api/auth/refresh') {
      return authenticated
        ? json(route, { session: { refreshToken: '', token: TOKEN, user: activeUser } })
        : json(route, { error: 'Authentication required.' }, 401);
    }
    if (method === 'GET' && path === '/api/auth/me') {
      return authenticated ? json(route, { user: activeUser }) : json(route, { error: 'Authentication required.' }, 401);
    }
    // Home after sign-in; e2e/home.acceptance.spec.js installs richer payloads.
    if (method === 'GET' && path === '/api/home') return json(route, syntheticHomePayload());
    if (method === 'PUT' && path === '/api/home/lens') return json(route, { lens: request.postDataJSON()?.lens, ok: true });
    // The navigation reads the workspace's modules; Consulting is off unless a spec switches it on
    // (./engagements-api.js).
    if (method === 'GET' && path === '/api/workspace/modules') {
      const consulting = { enabled: false, key: 'consulting', label: 'Consulting' };
      return json(route, activeUser.role === 'admin'
        ? { canManage: true, modules: [{ ...consulting, impact: { openEngagements: 0 }, updatedAt: null, updatedBy: null, version: 0 }] }
        : { canManage: false, modules: [consulting] });
    }
    // The top bar's Chat badge (docs/odin-chat/plan.md); e2e/fixtures/chat-api.js has the rest.
    if (method === 'GET' && path === '/api/chat/unread') return json(route, { channels: 0, directMessages: 0, mentions: 0, ok: true, unread: 0 });
    if (method === 'GET' && path === '/api/projects') return json(route, { projects: [syntheticProject] });
    if (method === 'GET' && path === `/api/projects/${syntheticProject.id}`) return json(route, { project: syntheticProject });
    if (method === 'GET' && path === `/api/projects/${syntheticProject.id}/comments`) return json(route, { comments: [] });
    if (method === 'GET' && path === `/api/projects/${syntheticProject.id}/files`) return json(route, { canWrite: true, files: [], ok: true });
    // The project's files as folders; file-tree specs install their own (./file-tree-api.js).
    if (method === 'GET' && path === `/api/projects/${syntheticProject.id}/file-tree`) {
      return json(route, { canManage: true, channels: [], ok: true, project: { id: syntheticProject.id, name: syntheticProject.name }, rootFileCount: 0 });
    }
    if (method === 'GET' && path === `/api/projects/${syntheticProject.id}/file-storage`) return json(route, { canDeleteVersions: false, maxUploadBytes: 1_073_741_824, ok: true, storage: { bytes: 0, files: 0, versions: 0 }, uploadsByParts: true });
    // The top bar's Work menu lists recent tickets; ticket specs install their own list.
    if (method === 'GET' && path === '/api/projects/tickets') return json(route, { nextCursor: null, ok: true, tickets: [], total: 0 });
    // The ticket list asks for each project's automated review checks.
    if (method === 'GET' && path === `/api/projects/${syntheticProject.id}/tickets/awaiting-review`) return json(route, { ok: true, tickets: [] });
    // The Resources tab asks who has task access.
    if (method === 'GET' && path === `/api/resource-planning/projects/${syntheticProject.id}/task-access`) return json(route, { entries: [], ok: true });
    // Item detail panels read relations; specs that exercise them install their own handler.
    if (method === 'GET' && new RegExp(`^/api/projects/${syntheticProject.id}/items/[^/]+/relations$`).test(path)) return json(route, { canEdit: false, ok: true, relations: [] });
    const projectItemRevisionMatch = path.match(new RegExp(`^/api/projects/${syntheticProject.id}/items/([^/]+)/revisions$`));
    if (method === 'GET' && projectItemRevisionMatch) {
      const itemId = projectItemRevisionMatch[1];
      return json(route, { itemId, revisions: [{
        action: 'update', actorUserId: syntheticUser.id,
        after: { itemType: 'story', node: { id: itemId, name: 'Release pilot', status: 'In Progress', version: 2 }, parentId: 'epic-synthetic', position: 0 },
        before: { itemType: 'story', node: { id: itemId, name: 'Pilot release', status: 'Not Started', version: 1 }, parentId: 'epic-synthetic', position: 0 },
        createdAt: '2026-07-11T12:00:00.000Z', id: 'revision-synthetic', itemId, itemType: 'story', projectId: syntheticProject.id, versionAfter: 2, versionBefore: 1,
      }] });
    }
    const projectItemRestoreMatch = path.match(new RegExp(`^/api/projects/${syntheticProject.id}/items/([^/]+)/restore$`));
    if (method === 'POST' && projectItemRestoreMatch) {
      const restoredProject = structuredClone(syntheticProject);
      const story = restoredProject.epics[0].stories.find((item) => item.id === projectItemRestoreMatch[1]);
      if (story && request.postDataJSON().state === 'before') Object.assign(story, { name: 'Pilot release', status: 'Not Started', version: 3 });
      return json(route, { item: story, ok: true, project: restoredProject, revision: { action: 'restore', versionAfter: 3 } });
    }
    if (method === 'GET' && path === `/api/projects/${syntheticProject.id}/valid-users`) {
      return json(route, { project_users: [syntheticUser], tenant_users: [syntheticUser, ...extraTenantUsers], validStatusTypes: {}, validTaskTypes: {} });
    }
    if (method === 'GET' && path === `/api/projects/${syntheticProject.id}/governance`) {
      return json(route, { ok: true, ...structuredClone(governance) });
    }
    if (method === 'GET' && path === `/api/projects/${syntheticProject.id}/governance/schedule-analysis`) {
      return json(route, { analysis: {
        baselineVariance: governance.scheduleBaselines.length ? {
          baselineCapturedAt: governance.scheduleBaselines[0].capturedAt, baselineId: governance.scheduleBaselines[0].id,
          baselineName: governance.scheduleBaselines[0].name, itemVariances: [], milestoneVariances: [],
          projectFinishVarianceWorkingDays: 0, projectStartVarianceWorkingDays: 0, scopeAddedCount: 0, scopeRemovedCount: 0,
        } : null,
        calendar: structuredClone(governance.workingCalendar),
        criticalPathIds: ['story-synthetic', 'task-synthetic'], cyclicItemIds: [], dependencyCount: governance.dependencies.length,
        forecastFinish: '2026-08-28', forecastVarianceDays: -33, itemTimings: [], milestoneForecasts: [], passed: true, totalDurationDays: 19, workItemCount: 3,
      }, ok: true });
    }
    if (method === 'GET' && path === '/api/portfolio') {
      const query = String(url.searchParams.get('query') ?? '').toLowerCase();
      const status = String(url.searchParams.get('status') ?? '');
      const limit = Number(url.searchParams.get('limit') ?? 25);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const matchingNodes = portfolioNodes.filter((node) => (!query || `${node.name} ${node.description}`.toLowerCase().includes(query)) && (!status || node.status === status));
      return json(route, {
        alignments: structuredClone(portfolioAlignments), analysis: { comparisons: portfolioPlans.map((plan) => ({ benefitByUnit: { USD: 750000 }, deferred: [], fundingCurrency: plan.fundingCurrency, fundingLimit: plan.fundingLimit, planId: plan.id, resourceHoursLimit: plan.resourceHoursLimit, scenario: plan.scenario, selected: portfolioAlignments.filter((item) => item.scenario === plan.scenario).map((item) => ({ alignmentId: item.id, priorityScore: 85, projectId: item.projectId })), totalFunding: 250000, totalResourceHours: 4000, utilization: { fundingPercent: Math.round(250000 / plan.fundingLimit * 100), resourcePercent: Math.round(4000 / plan.resourceHoursLimit * 100) } })) }, baselines: structuredClone(portfolioBaselines), canApprove: true, canManage: true, limit,
        nodes: structuredClone(matchingNodes.slice(offset, offset + limit)), objectives: structuredClone(strategyObjectives),
        offset, plans: structuredClone(portfolioPlans), projects: [syntheticProject], total: matchingNodes.length,
      });
    }
    if (method === 'POST' && path === '/api/portfolio/nodes') {
      const value = { ...request.postDataJSON(), id: `portfolio-node-${portfolioNodes.length + 1}`, rollup: { benefits: {}, projectCount: 0, score: 0 }, version: 1 };
      portfolioNodes.push(value);
      return json(route, { ok: true, value }, 201);
    }
    const portfolioNodeMatch = path.match(/^\/api\/portfolio\/nodes\/([^/]+)$/);
    if (portfolioNodeMatch && method === 'PATCH') {
      const index = portfolioNodes.findIndex((item) => item.id === portfolioNodeMatch[1]);
      const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON();
      portfolioNodes[index] = { ...portfolioNodes[index], ...input, version: portfolioNodes[index].version + 1 };
      return json(route, { ok: true, value: portfolioNodes[index] });
    }
    if (portfolioNodeMatch && method === 'DELETE') {
      portfolioNodes = portfolioNodes.filter((item) => item.id !== portfolioNodeMatch[1]);
      return json(route, { ok: true });
    }
    if (method === 'POST' && path === '/api/portfolio/objectives') {
      const input = request.postDataJSON();
      const value = { ...input, id: `objective-${strategyObjectives.length + 1}`, progressPercent: input.targetValue ? Math.round(input.currentValue / input.targetValue * 100) : 0, version: 1 };
      strategyObjectives.push(value);
      return json(route, { ok: true, value }, 201);
    }
    const objectiveMatch = path.match(/^\/api\/portfolio\/objectives\/([^/]+)$/);
    if (objectiveMatch && method === 'PATCH') {
      const index = strategyObjectives.findIndex((item) => item.id === objectiveMatch[1]);
      const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON();
      strategyObjectives[index] = { ...strategyObjectives[index], ...input, version: strategyObjectives[index].version + 1 };
      return json(route, { ok: true, value: strategyObjectives[index] });
    }
    if (objectiveMatch && method === 'DELETE') {
      strategyObjectives = strategyObjectives.filter((item) => item.id !== objectiveMatch[1]);
      return json(route, { ok: true });
    }
    if (method === 'POST' && path === '/api/portfolio/alignments') {
      const value = { ...request.postDataJSON(), id: `alignment-${portfolioAlignments.length + 1}`, version: 1 };
      portfolioAlignments.push(value);
      return json(route, { ok: true, value }, 201);
    }
    const alignmentMatch = path.match(/^\/api\/portfolio\/alignments\/([^/]+)$/);
    if (alignmentMatch && method === 'PATCH') {
      const index = portfolioAlignments.findIndex((item) => item.id === alignmentMatch[1]);
      const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON();
      portfolioAlignments[index] = { ...portfolioAlignments[index], ...input, version: portfolioAlignments[index].version + 1 };
      return json(route, { ok: true, value: portfolioAlignments[index] });
    }
    if (alignmentMatch && method === 'DELETE') {
      portfolioAlignments = portfolioAlignments.filter((item) => item.id !== alignmentMatch[1]);
      return json(route, { ok: true });
    }
    if (method === 'POST' && path === '/api/portfolio/plans') { const value = { ...request.postDataJSON(), decidedAt: null, decidedBy: null, id: `plan-${portfolioPlans.length + 1}`, version: 1 }; portfolioPlans.push(value); return json(route, { ok: true, value }, 201); }
    const planMatch = path.match(/^\/api\/portfolio\/plans\/([^/]+)$/);
    if (planMatch && method === 'PATCH') { const index = portfolioPlans.findIndex((item) => item.id === planMatch[1]); const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON(); portfolioPlans[index] = { ...portfolioPlans[index], ...input, version: portfolioPlans[index].version + 1 }; return json(route, { ok: true, value: portfolioPlans[index] }); }
    if (planMatch && method === 'DELETE') { portfolioPlans = portfolioPlans.filter((item) => item.id !== planMatch[1]); return json(route, { ok: true }); }
    if (method === 'POST' && path === '/api/portfolio/baselines') { const input = request.postDataJSON(); const value = { ...input, capturedAt: new Date().toISOString(), capturedBy: syntheticUser.id, id: `portfolio-baseline-${portfolioBaselines.length + 1}`, snapshot: { alignments: structuredClone(portfolioAlignments), contentHash: 'd'.repeat(64), projects: [syntheticProject] }, version: 1 }; portfolioBaselines.push(value); return json(route, { ok: true, value }, 201); }
    if (method === 'GET' && path === '/api/resource-planning') {
      const query = String(url.searchParams.get('query') ?? '').toLowerCase();
      const projectId = String(url.searchParams.get('projectId') ?? '');
      const scenario = String(url.searchParams.get('scenario') ?? 'baseline');
      const resources = enterpriseResources.filter((item) => !query || `${item.name} ${item.location} ${item.roles.join(' ')} ${item.skills.map((skill) => skill.name).join(' ')}`.toLowerCase().includes(query));
      const resourceIds = new Set(resources.map((item) => item.id));
      const allocations = resourceAllocations.filter((item) => resourceIds.has(item.resourceId) && (!projectId || item.projectId === projectId) && (!scenario || item.scenario === scenario));
      const capacity = resources.map((item) => {
        const allocatedHours = allocations.filter((allocation) => ['approved', 'active'].includes(allocation.status)).reduce((sum, allocation) => sum + allocation.hoursPerWeek, 0);
        return { allocatedHours, availableHours: item.capacityHoursPerWeek, overallocated: allocatedHours > item.capacityHoursPerWeek, resourceId: item.id, utilizationPercent: item.capacityHoursPerWeek ? Math.round(allocatedHours / item.capacityHoursPerWeek * 10000) / 100 : 0 };
      });
      const visibleFinancial = financialEntries.filter((item) => !projectId || item.projectId === projectId);
      const visibleExpenses = expenseEntries.filter((item) => !projectId || item.projectId === projectId);
      const visibleTime = timeEntries.filter((item) => !projectId || item.projectId === projectId);
      return json(route, {
        analysis: { financialPerformance: [{ actualCost: 1200, budget: 500000, costPerformanceIndex: 2.1, currency: 'USD', earnedValue: 250000, estimateAtCompletion: 2400, margin: 118800, marginPercent: 99, plannedValue: 200000, projectId: syntheticProject.id, projectedCost: 1200, reporting: null, revenue: 120000, schedulePerformanceIndex: 1.25, thresholds: { budgetExceeded: false, forecastExceeded: false, fundingGap: false, negativeMargin: false } }], forecasts: [{ completionPercent: 50, projectId: syntheticProject.id, projectedWeeksRemaining: 8, remainingAllocationHours: 352, scheduleProgressPercent: 40, weeklyVelocityHours: 44 }], levelingRecommendations: [{ allocationId: 'allocation-synthetic', fromResourceId: 'resource-synthetic', hours: 4, projectId: syntheticProject.id, score: 5, toResourceId: 'resource-2', weekStart: '2026-07-06' }], scenarios: [{ allocatedHoursPerWeek: 44, currencyBreakdown: [{ currency: 'USD', projectedWeeklyCost: 6380, projectedWeeklyMargin: 3740, projectedWeeklyRevenue: 10120 }], projectedWeeklyCost: 6380, projectedWeeklyMargin: 3740, projectedWeeklyRevenue: 10120, reportingTotals: { currency: 'USD', projectedWeeklyCost: 6380, projectedWeeklyMargin: 3740, projectedWeeklyRevenue: 10120 }, scenario: 'baseline' }], skillMatches: [], weekly: [{ availableHours: 40, demandHours: 44, overallocatedHours: 4, resourceId: 'resource-synthetic', utilizationPercent: 110, weekStart: '2026-07-06' }] },
        accountingPeriods: structuredClone(accountingPeriods), allocations: structuredClone(allocations), calendarEntries: structuredClone(resourceCalendarEntries.filter((item) => resourceIds.has(item.resourceId))),
        canManageFinance: true, canManageResources: true, capacity, exchangeRates: structuredClone(exchangeRates), expenseReceipts: structuredClone(expenseReceipts.filter((item) => visibleExpenses.some((expense) => expense.id === item.expenseId))), expenses: structuredClone(visibleExpenses), financePolicies: structuredClone(financePolicies), financialEntries: structuredClone(visibleFinancial),
        financialRollup: { byCurrency: { USD: visibleFinancial.reduce((sum, item) => sum + item.amount, 0) + visibleExpenses.reduce((sum, item) => sum + item.amount, 0) }, byKind: { budget: visibleFinancial.filter((item) => item.entryKind === 'budget').reduce((sum, item) => sum + item.amount, 0) }, expenseByCurrency: { USD: visibleExpenses.reduce((sum, item) => sum + item.amount, 0) } },
        limit: 50, offset: 0, pools: structuredClone(resourcePools), projects: [syntheticProject], resourceRates: structuredClone(resourceRates), resources: structuredClone(resources),
        users: [{ email: syntheticUser.email, id: syntheticUser.id, name: syntheticUser.name }, { email: 'riley@example.com', id: 'user-riley', name: 'Riley Planner' }],
        timeEntries: structuredClone(visibleTime), timeRollup: { approvedHours: visibleTime.filter((item) => item.status === 'approved').reduce((sum, item) => sum + item.hours, 0), submittedHours: visibleTime.filter((item) => item.status === 'submitted').reduce((sum, item) => sum + item.hours, 0) }, timesheetPeriods: structuredClone(timesheetPeriods), total: resources.length,
      });
    }
    const resourceCollections = {
      'accounting-periods': { records: () => accountingPeriods, set: (value) => { accountingPeriods = value; }, prefix: 'accounting' },
      allocations: { records: () => resourceAllocations, set: (value) => { resourceAllocations = value; }, prefix: 'allocation' },
      'calendar-entries': { records: () => resourceCalendarEntries, set: (value) => { resourceCalendarEntries = value; }, prefix: 'calendar' },
      expenses: { records: () => expenseEntries, set: (value) => { expenseEntries = value; }, prefix: 'expense' },
      'finance-policies': { records: () => financePolicies, set: (value) => { financePolicies = value; }, prefix: 'policy' },
      'financial-entries': { records: () => financialEntries, set: (value) => { financialEntries = value; }, prefix: 'finance' },
      'resource-rates': { records: () => resourceRates, set: (value) => { resourceRates = value; }, prefix: 'rate' },
      'timesheet-periods': { records: () => timesheetPeriods, set: (value) => { timesheetPeriods = value; }, prefix: 'period' },
      'expense-receipts': { records: () => expenseReceipts, set: (value) => { expenseReceipts = value; }, prefix: 'receipt' },
      'exchange-rates': { records: () => exchangeRates, set: (value) => { exchangeRates = value; }, prefix: 'fx' },
      pools: { records: () => resourcePools, set: (value) => { resourcePools = value; }, prefix: 'pool' },
      resources: { records: () => enterpriseResources, set: (value) => { enterpriseResources = value; }, prefix: 'resource' },
      'time-entries': { records: () => timeEntries, set: (value) => { timeEntries = value; }, prefix: 'time' },
    };
    const allocationLevelMatch = path.match(/^\/api\/resource-planning\/allocations\/([^/]+)\/level$/);
    if (allocationLevelMatch && method === 'POST') {
      const input = request.postDataJSON(); const index = resourceAllocations.findIndex((item) => item.id === allocationLevelMatch[1]); const source = resourceAllocations[index];
      const movedPercent = Math.round(source.allocationPercent * input.hours / source.hoursPerWeek * 100) / 100;
      const sourceAllocation = { ...source, allocationPercent: Math.round((source.allocationPercent - movedPercent) * 100) / 100, hoursPerWeek: source.hoursPerWeek - input.hours, version: source.version + 1 };
      const targetAllocation = { ...source, allocationPercent: movedPercent, hoursPerWeek: input.hours, id: `allocation-${resourceAllocations.length + 1}`, resourceId: input.targetResourceId, version: 1 };
      resourceAllocations = resourceAllocations.map((item, itemIndex) => itemIndex === index ? sourceAllocation : item).concat(targetAllocation);
      return json(route, { ok: true, value: { movedHours: input.hours, sourceAllocation, targetAllocation } });
    }
    const receiptUploadMatch = path.match(/^\/api\/resource-planning\/expenses\/([^/]+)\/receipt-content$/);
    if (receiptUploadMatch && method === 'POST') {
      const input = request.postDataJSON(); const value = { contentType: input.contentType, expenseId: receiptUploadMatch[1], fileName: input.fileName, id: `receipt-${expenseReceipts.length + 1}`, sha256: 'c'.repeat(64), sizeBytes: Buffer.from(input.contentBase64, 'base64').length, status: 'active', storageKey: `synthetic-receipt-${expenseReceipts.length + 1}`, version: 1 };
      expenseReceipts = [...expenseReceipts, value]; return json(route, { ok: true, value }, 201);
    }
    const teamMatch = path.match(/^\/api\/resource-planning\/projects\/([^/]+)\/team$/);
    if (teamMatch && method === 'GET') {
      const allocations = resourceAllocations.filter((item) => item.projectId === teamMatch[1]);
      const live = new Set(allocations.filter((item) => ['proposed', 'approved', 'active', 'held'].includes(item.status)).map((item) => item.resourceId));
      const people = enterpriseResources.filter((item) => live.has(item.id)).map((item) => ({ assigneeId: item.userId || `resource:${item.id}`, resource: structuredClone(item) }));
      return json(route, { allocations: structuredClone(allocations), canManage: true, canSeeRates: true, directory: structuredClone(enterpriseResources), people, projectId: teamMatch[1], users: [{ email: syntheticUser.email, id: syntheticUser.id, name: syntheticUser.name }, { email: 'riley@example.com', id: 'user-riley', name: 'Riley Planner' }] });
    }
    const resourceCreateMatch = path.match(/^\/api\/resource-planning\/([^/]+)$/);
    if (resourceCreateMatch && resourceCollections[resourceCreateMatch[1]] && method === 'POST') {
      const collection = resourceCollections[resourceCreateMatch[1]]; const records = collection.records();
      const value = { ...request.postDataJSON(), id: `${collection.prefix}-${records.length + 1}`, version: 1 };
      collection.set([...records, value]);
      return json(route, { ok: true, value }, 201);
    }
    const resourceRecordMatch = path.match(/^\/api\/resource-planning\/([^/]+)\/([^/]+)$/);
    if (resourceRecordMatch && resourceCollections[resourceRecordMatch[1]] && method === 'PATCH') {
      const collection = resourceCollections[resourceRecordMatch[1]]; const records = collection.records(); const index = records.findIndex((item) => item.id === resourceRecordMatch[2]);
      const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON(); const value = { ...records[index], ...input, version: records[index].version + 1 };
      collection.set(records.map((item, itemIndex) => itemIndex === index ? value : item));
      return json(route, { ok: true, value });
    }
    if (resourceRecordMatch && resourceCollections[resourceRecordMatch[1]] && method === 'DELETE') {
      const collection = resourceCollections[resourceRecordMatch[1]]; collection.set(collection.records().filter((item) => item.id !== resourceRecordMatch[2]));
      return json(route, { ok: true });
    }
    if (method === 'GET' && path === '/api/workflows') {
      const query = String(url.searchParams.get('query') ?? '').toLowerCase(); const status = String(url.searchParams.get('status') ?? ''); const projectId = String(url.searchParams.get('projectId') ?? '');
      const workflows = workflowDefinitions.filter((item) => (!query || `${item.name} ${item.description}`.toLowerCase().includes(query)) && (!status || item.status === status));
      const scoped = (item) => !projectId || item.projectId === projectId;
      return json(route, { approvals: structuredClone(workflowApprovals.filter(scoped)), baselines: structuredClone(projectBaselines.filter(scoped)), bindings: structuredClone(workflowBindings.filter(scoped)), canManage: true, customFields: structuredClone(customFields), customValues: structuredClone(customValues.filter(scoped)), histories: structuredClone(workflowHistories.filter(scoped)), limit: 50, offset: 0, projects: [syntheticProject], templates: structuredClone(projectTemplates), total: workflows.length, workflows: structuredClone(workflows) });
    }
    if (method === 'GET' && path === '/api/workflows/templates') {
      const kind = String(url.searchParams.get('kind') ?? ''); const status = String(url.searchParams.get('status') ?? '');
      return json(route, { templates: structuredClone(projectTemplates.filter((item) => (!kind || item.kind === kind) && (!status || item.status === status))) });
    }
    const workflowDefinitionMatch = path.match(/^\/api\/workflows\/definitions\/([^/]+)$/);
    if (workflowDefinitionMatch && method === 'GET') {
      const value = workflowDefinitions.find((item) => item.id === workflowDefinitionMatch[1]);
      return value ? json(route, { canManage: true, value: structuredClone(value) }) : json(route, { error: 'Workflow record not found.' }, 404);
    }
    const workflowCollections = {
      definitions: { records: () => workflowDefinitions, set: (value) => { workflowDefinitions = value; }, prefix: 'workflow' },
      bindings: { records: () => workflowBindings, set: (value) => { workflowBindings = value; }, prefix: 'binding' },
      templates: { records: () => projectTemplates, set: (value) => { projectTemplates = value; }, prefix: 'template' },
      'custom-fields': { records: () => customFields, set: (value) => { customFields = value; }, prefix: 'field' },
    };
    const workflowCreateMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
    if (workflowCreateMatch && workflowCollections[workflowCreateMatch[1]] && method === 'POST') {
      const collection = workflowCollections[workflowCreateMatch[1]]; const records = collection.records(); const value = { ...request.postDataJSON(), id: `${collection.prefix}-${records.length + 1}`, version: 1, ...(collection.prefix === 'template' ? { payloadIssues: [], payloadStatus: 'valid' } : {}) }; collection.set([...records, value]); return json(route, { ok: true, value }, 201);
    }
    const workflowRecordMatch = path.match(/^\/api\/workflows\/([^/]+)\/([^/]+)$/);
    if (workflowRecordMatch && workflowCollections[workflowRecordMatch[1]] && method === 'PATCH') {
      const collection = workflowCollections[workflowRecordMatch[1]]; const records = collection.records(); const index = records.findIndex((item) => item.id === workflowRecordMatch[2]); const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON(); const value = { ...records[index], ...input, ...(collection.prefix === 'template' && input.payload ? { payloadIssues: [], payloadStatus: 'valid' } : {}), version: records[index].version + 1 }; collection.set(records.map((item, itemIndex) => itemIndex === index ? value : item)); return json(route, { ok: true, value });
    }
    if (workflowRecordMatch && workflowCollections[workflowRecordMatch[1]] && method === 'DELETE') { const collection = workflowCollections[workflowRecordMatch[1]]; collection.set(collection.records().filter((item) => item.id !== workflowRecordMatch[2])); return json(route, { ok: true }); }
    if (method === 'POST' && path === '/api/workflows/approvals') { const value = { ...request.postDataJSON(), id: `approval-${workflowApprovals.length + 1}`, requestedBy: syntheticUser.id, status: 'pending', version: 1 }; workflowApprovals.push(value); return json(route, { ok: true, value }, 201); }
    const approvalDecisionMatch = path.match(/^\/api\/workflows\/approvals\/([^/]+)\/decision$/);
    if (approvalDecisionMatch && method === 'POST') { const index = workflowApprovals.findIndex((item) => item.id === approvalDecisionMatch[1]); const input = request.postDataJSON(); workflowApprovals[index] = { ...workflowApprovals[index], decisionNote: input.decisionNote, status: input.status, version: workflowApprovals[index].version + 1 }; return json(route, { ok: true, value: workflowApprovals[index] }); }
    if (method === 'POST' && path === '/api/workflows/baselines') { const value = { ...request.postDataJSON(), capturedAt: new Date().toISOString(), createdBy: syntheticUser.id, id: `baseline-${projectBaselines.length + 1}`, version: 1 }; projectBaselines.push(value); return json(route, { ok: true, value }, 201); }
    if (method === 'PUT' && path === '/api/workflows/custom-values') { const input = request.postDataJSON(); const index = customValues.findIndex((item) => item.projectId === input.projectId && item.itemId === input.itemId && item.fieldId === input.fieldId); const value = { ...input, id: index < 0 ? `value-${customValues.length + 1}` : customValues[index].id, version: index < 0 ? 1 : customValues[index].version + 1 }; if (index < 0) customValues.push(value); else customValues[index] = value; return json(route, { ok: true, value }); }
    const customValueMatch = path.match(/^\/api\/workflows\/custom-values\/([^/]+)$/);
    if (customValueMatch && method === 'DELETE') { customValues = customValues.filter((item) => item.id !== customValueMatch[1]); return json(route, { ok: true }); }
    if (method === 'GET' && path === '/api/reporting') {
      const query = String(url.searchParams.get('query') ?? '').toLowerCase(); const reports = reportDefinitions.filter((item) => !query || `${item.name} ${item.description}`.toLowerCase().includes(query));
      return json(route, { canManage: true, datasetColumns: { executive: ['projectId','projectName','status','openRiskCount'], portfolio: ['projectId','projectName','demandStatus','scenario','benefitValue'], project: ['projectId','projectName','status','startDate','endDate','progressPercent','epicCount','storyCount','taskCount'], work_items: ['projectId','projectName','itemType','itemId','name','status'], sprint: ['projectId','projectName','sprintId','sprintName','status'], resource: ['resourceId','resourceName','capacityHoursPerWeek','allocatedHoursPerWeek','utilizationPercent','overallocated'], financial: ['projectId','projectName','entryId','entryKind','amount','currency'], risk: ['projectId','projectName','itemId','kind','title','impact','status'], agent_governance: ['projectId','projectName','goalId','title','status','runCount'], workflow: ['projectId','projectName','itemType','itemId','transitionKey','fromState','toState','slaDueAt'] }, latestSnapshots: {}, limit: 25, offset: 0, projects: [syntheticProject], reports: structuredClone(reports), runs: structuredClone(reportRuns), subscriptions: structuredClone(reportSubscriptions), total: reports.length, views: structuredClone(savedViews) });
    }
    if (method === 'GET' && path === '/api/reporting/dashboards') return json(route, { agentGovernance: { activeGoalCount: 1, goalCount: 1, runCount: 2, unreadNotificationCount: 1 }, asOf: '2026-07-11T12:00:00.000Z', executive: { actualCost: 0, allocatedHoursPerWeek: 44, budget: 500000, byStatus: { 'In Progress': 1 }, forecast: 0, pendingApprovals: 1, projectCount: 1 }, financial: { authorized: true, byCurrency: { USD: 500000 }, byKind: { budget: 500000 } }, freshness: { rowLevelSecurity: 'visible-project-set', source: 'transactional-read-model' }, portfolio: { alignmentCount: 1, benefitValue: 750000, byDemandStatus: { active: 1 }, byScenario: { baseline: 1 } }, project: { byStatus: { 'In Progress': 1 }, epicCount: 1, projectCount: 1, storyCount: 1, taskCount: 1, workItemCount: 3 }, resource: { averageUtilizationPercent: 110, overallocatedCount: 1, resourceCount: 1 }, risk: { byImpact: { high: 1 }, criticalOpenCount: 0, openCount: 1, total: 1 }, sprint: { activeCount: 0, byStatus: {}, total: 0 }, workflow: { overdueSlaCount: 0, pendingApprovalCount: 1, transitionCount: 1 } });
    if (method === 'GET' && path === '/api/reporting/search') { const query = String(url.searchParams.get('query') ?? '').toLowerCase(); const records = searchDocuments.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(query)); return json(route, { facetCounts: { impact: { high: 1 }, status: { 'In Progress': 1, monitoring: 1 } }, indexedFreshness: '2026-07-11T12:00:00.000Z', limit: 25, offset: 0, records, total: records.length }); }
    if (method === 'POST' && path === '/api/reporting/search/refresh') return json(route, { indexed: searchDocuments.length, ok: true, refreshedAt: new Date().toISOString() });
    const reportingCollections = { reports: { records: () => reportDefinitions, set: (value) => { reportDefinitions = value; }, prefix: 'report' }, views: { records: () => savedViews, set: (value) => { savedViews = value; }, prefix: 'view' }, subscriptions: { records: () => reportSubscriptions, set: (value) => { reportSubscriptions = value; }, prefix: 'subscription' } };
    const reportingCreateMatch = path.match(/^\/api\/reporting\/(reports|views|subscriptions)$/);
    if (reportingCreateMatch && method === 'POST') { const collection = reportingCollections[reportingCreateMatch[1]]; const records = collection.records(); const value = { ...request.postDataJSON(), id: `${collection.prefix}-${records.length + 1}`, ownerUserId: syntheticUser.id, version: 1 }; collection.set([...records, value]); return json(route, { ok: true, value }, 201); }
    const reportingRecordMatch = path.match(/^\/api\/reporting\/(reports|views|subscriptions)\/([^/]+)$/);
    if (reportingRecordMatch && method === 'PATCH') { const collection = reportingCollections[reportingRecordMatch[1]]; const records = collection.records(); const index = records.findIndex((item) => item.id === reportingRecordMatch[2]); const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON(); const value = { ...records[index], ...input, ...(collection.prefix === 'template' && input.payload ? { payloadIssues: [], payloadStatus: 'valid' } : {}), version: records[index].version + 1 }; collection.set(records.map((item, itemIndex) => itemIndex === index ? value : item)); return json(route, { ok: true, value }); }
    if (reportingRecordMatch && method === 'DELETE') { const collection = reportingCollections[reportingRecordMatch[1]]; collection.set(collection.records().filter((item) => item.id !== reportingRecordMatch[2])); return json(route, { ok: true }); }
    const runReportMatch = path.match(/^\/api\/reporting\/reports\/([^/]+)\/run$/);
    if (runReportMatch && method === 'POST') { const report = reportDefinitions.find((item) => item.id === runReportMatch[1]); const row = { projectId: syntheticProject.id, projectName: syntheticProject.name, status: syntheticProject.status, startDate: syntheticProject.startDate, endDate: syntheticProject.endDate, progressPercent: 33.33, epicCount: 1, storyCount: 1, taskCount: 1 }; const rows = [{ ...Object.fromEntries(report.columns.map((column) => [column, row[column] ?? null])) }]; const run = { error: '', format: 'json', id: `run-${reportRuns.length + 1}`, reportId: report.id, rowCount: rows.length, startedAt: new Date().toISOString(), status: 'completed', version: 2 }; reportRuns.push(run); reportSnapshots.push({ data: rows, id: `snapshot-${reportSnapshots.length + 1}`, reportId: report.id, runId: run.id }); return json(route, { content: JSON.stringify(rows, null, 2), contentEncoding: 'utf8', contentType: 'application/json', extension: 'json', filename: 'report.json', format: 'json', freshness: { asOf: new Date().toISOString(), rowLevelSecurity: 'visible-project-set' }, ok: true, rows, runId: run.id, snapshotId: reportSnapshots.at(-1).id }); }
    if (method === 'GET' && path === '/api/identity') return json(route, { accessReviewCampaignRuns: structuredClone(accessReviewCampaignRuns), accessReviewCampaigns: structuredClone(accessReviewCampaigns), accessReviewItems: structuredClone(accessReviewItems), accessReviews: structuredClone(accessReviews), breakGlassPolicy: structuredClone(breakGlassPolicy), credentials: structuredClone(serviceCredentials), domains: structuredClone(identityDomains), groupMemberships: structuredClone(identityGroupMemberships), groups: structuredClone(identityGroups), impersonationGrants: structuredClone(impersonationGrants), policy: structuredClone(identityPolicy), roles: structuredClone(identityRoles), serviceAccounts: structuredClone(serviceAccounts), total: identityDomains.length + identityRoles.length + identityGroups.length + accessReviewCampaigns.length + serviceAccounts.length });
    if (method === 'PUT' && path === '/api/identity/policy') { const input = request.postDataJSON(); identityPolicy = { ...input, version: identityPolicy.version + 1 }; return json(route, { ok: true, value: identityPolicy }); }
    if (method === 'PUT' && path === '/api/identity/break-glass-policy') { const input = request.postDataJSON(); breakGlassPolicy = { ...input, version: breakGlassPolicy.version + 1 }; return json(route, { ok: true, value: breakGlassPolicy }); }
    if (method === 'POST' && path === '/api/identity/domains') { const input = request.postDataJSON(); const proof = `odin-domain-synthetic-${identityDomains.length + 1}`; const value = { ...input, id: `domain-${identityDomains.length + 1}`, status: 'pending', verifiedAt: null, version: 1 }; identityDomains.push(value); domainProofs.set(value.id, proof); return json(route, { ok: true, value, verification: { dnsValue: proof, token: proof } }, 201); }
    const identityDomainVerify = path.match(/^\/api\/identity\/domains\/([^/]+)\/verify$/);
    if (identityDomainVerify && method === 'POST') { const index = identityDomains.findIndex((item) => item.id === identityDomainVerify[1]); const input = request.postDataJSON(); if (input.proof !== domainProofs.get(identityDomainVerify[1])) return json(route, { error: 'Domain verification proof did not match.' }, 409); identityDomains[index] = { ...identityDomains[index], status: 'verified', verifiedAt: new Date().toISOString(), version: identityDomains[index].version + 1 }; return json(route, { ok: true, value: identityDomains[index] }); }
    if (method === 'POST' && path === '/api/identity/roles') { const input = request.postDataJSON(); const value = { ...input, id: `role-${identityRoles.length + 1}`, version: 1 }; identityRoles.push(value); return json(route, { ok: true, value }, 201); }
    if (method === 'POST' && path === '/api/identity/groups') { const input = request.postDataJSON(); const value = { ...input, id: `group-${identityGroups.length + 1}`, version: 1 }; identityGroups.push(value); return json(route, { ok: true, value }, 201); }
    if (method === 'POST' && path === '/api/identity/service-accounts') { const input = request.postDataJSON(); const value = { ...input, enabled: true, id: `service-${serviceAccounts.length + 1}`, version: 1 }; const secret = `odin_sa_synthetic_${serviceAccounts.length + 1}`; serviceAccounts.push(value); serviceCredentials.push({ accountId: value.id, id: `credential-${serviceCredentials.length + 1}`, prefix: `odin_sa_synthetic`, revokedAt: null, version: 1 }); return json(route, { credential: serviceCredentials.at(-1), ok: true, secret, value }, 201); }
    const identityRotate = path.match(/^\/api\/identity\/service-accounts\/([^/]+)\/rotate$/);
    if (identityRotate && method === 'POST') { const account = serviceAccounts.find((item) => item.id === identityRotate[1]); account.version += 1; for (const credential of serviceCredentials.filter((item) => item.accountId === account.id)) credential.revokedAt = new Date().toISOString(); const credential = { accountId: account.id, id: `credential-${serviceCredentials.length + 1}`, prefix: 'odin_sa_rotated', revokedAt: null, version: 1 }; serviceCredentials.push(credential); return json(route, { credential, ok: true, secret: 'odin_sa_rotated_once', value: account }); }
    if (method === 'POST' && path === '/api/identity/access-reviews') { const input = request.postDataJSON(); const value = { ...input, id: `review-${accessReviews.length + 1}`, status: 'open', version: 1 }; accessReviews.push(value); for (const group of identityGroups) accessReviewItems.push({ access: { groupId: group.id }, decision: 'pending', id: `review-item-${accessReviewItems.length + 1}`, reviewId: value.id, subjectId: syntheticUser.id, subjectType: 'user', version: 1 }); for (const account of serviceAccounts) accessReviewItems.push({ access: { enabled: account.enabled, scopes: account.scopes }, decision: 'pending', id: `review-item-${accessReviewItems.length + 1}`, reviewId: value.id, subjectId: account.id, subjectType: 'service_account', version: 1 }); return json(route, { ok: true, value }, 201); }
    if (method === 'POST' && path === '/api/identity/access-review-campaigns') { const input = request.postDataJSON(); const value = { ...input, id: `campaign-${accessReviewCampaigns.length + 1}`, lastRunAt: null, runCount: 0, version: 1 }; accessReviewCampaigns.push(value); return json(route, { ok: true, value }, 201); }
    const reviewCampaign = path.match(/^\/api\/identity\/access-review-campaigns\/([^/]+)$/);
    if (reviewCampaign && method === 'PATCH') { const index = accessReviewCampaigns.findIndex((item) => item.id === reviewCampaign[1]); const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON(); accessReviewCampaigns[index] = { ...accessReviewCampaigns[index], ...input, version: accessReviewCampaigns[index].version + 1 }; return json(route, { ok: true, value: accessReviewCampaigns[index] }); }
    const reviewDecision = path.match(/^\/api\/identity\/access-review-items\/([^/]+)\/decision$/);
    if (reviewDecision && method === 'POST') { const index = accessReviewItems.findIndex((item) => item.id === reviewDecision[1]); const input = request.postDataJSON(); accessReviewItems[index] = { ...accessReviewItems[index], decision: input.decision, version: accessReviewItems[index].version + 1 }; return json(route, { ok: true, value: accessReviewItems[index] }); }
    if (method === 'POST' && path === '/api/identity/impersonation-requests') { const input = request.postDataJSON(); const value = { ...input, id: `impersonation-${impersonationGrants.length + 1}`, requesterUserId: syntheticUser.id, status: 'pending', version: 1 }; impersonationGrants.push(value); return json(route, { ok: true, value }, 201); }
    const impersonationDecision = path.match(/^\/api\/identity\/impersonation-requests\/([^/]+)\/decision$/);
    if (impersonationDecision && method === 'POST') { const index = impersonationGrants.findIndex((item) => item.id === impersonationDecision[1]); const input = request.postDataJSON(); impersonationGrants[index] = { ...impersonationGrants[index], status: input.decision, version: impersonationGrants[index].version + 1 }; return json(route, { ok: true, value: impersonationGrants[index] }); }
    const impersonationActivate = path.match(/^\/api\/identity\/impersonation-requests\/([^/]+)\/activate$/);
    if (impersonationActivate && method === 'POST') { const index = impersonationGrants.findIndex((item) => item.id === impersonationActivate[1]); impersonationGrants[index] = { ...impersonationGrants[index], status: 'active', version: impersonationGrants[index].version + 1 }; return json(route, { expiresAt: '2099-01-01T00:15:00.000Z', grant: impersonationGrants[index], ok: true, session: { token: 'synthetic-impersonation-token', user: impersonatedUser } }); }
    const impersonationEnd = path.match(/^\/api\/identity\/impersonation-requests\/([^/]+)\/end$/);
    if (impersonationEnd && method === 'POST') { const index = impersonationGrants.findIndex((item) => item.id === impersonationEnd[1]); impersonationGrants[index] = { ...impersonationGrants[index], endedAt: new Date().toISOString(), status: 'ended', version: impersonationGrants[index].version + 1 }; return json(route, { ok: true, value: impersonationGrants[index] }); }
    if (method === 'GET' && path === '/api/integrations') { const health = webhookSubscriptions.map((item) => ({ dead: webhookDeliveries.filter((delivery) => delivery.subscriptionId === item.id && delivery.status === 'dead').length, lastDeliveredAt: item.lastDeliveredAt, lastFailureAt: item.lastFailureAt, pending: webhookDeliveries.filter((delivery) => delivery.subscriptionId === item.id && ['pending','processing'].includes(delivery.status)).length, status: !item.enabled ? 'disabled' : webhookDeliveries.some((delivery) => delivery.subscriptionId === item.id && delivery.status === 'dead') ? 'degraded' : 'healthy', subscriptionId: item.id })); return json(route, { applications: structuredClone(oauthApplications), deliveries: structuredClone(webhookDeliveries), health, subscriptions: structuredClone(webhookSubscriptions), total: oauthApplications.length + webhookSubscriptions.length + webhookDeliveries.length }); }
    if (method === 'POST' && path === '/api/integrations/oauth-applications') { const input = request.postDataJSON(); const value = { ...input, clientId: `odin_client_synthetic_${oauthApplications.length + 1}`, createdAt: new Date().toISOString(), enabled: true, id: `oauth-${oauthApplications.length + 1}`, lastUsedAt: null, version: 1 }; oauthApplications.push(value); return json(route, { clientSecret: 'odin_oauth_secret_shown_once', ok: true, value }, 201); }
    const oauthUpdate = path.match(/^\/api\/integrations\/oauth-applications\/([^/]+)$/); if (oauthUpdate && method === 'PATCH') { const index = oauthApplications.findIndex((item) => item.id === oauthUpdate[1]); const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON(); oauthApplications[index] = { ...oauthApplications[index], ...input, version: oauthApplications[index].version + 1 }; return json(route, { ok: true, value: oauthApplications[index] }); }
    const oauthRotate = path.match(/^\/api\/integrations\/oauth-applications\/([^/]+)\/rotate$/); if (oauthRotate && method === 'POST') { const item = oauthApplications.find((record) => record.id === oauthRotate[1]); item.version += 1; return json(route, { clientSecret: 'odin_oauth_secret_rotated_once', ok: true, value: item }); }
    if (method === 'POST' && path === '/api/integrations/webhooks') { const input = request.postDataJSON(); const value = { ...input, createdAt: new Date().toISOString(), enabled: true, id: `webhook-${webhookSubscriptions.length + 1}`, lastDeliveredAt: null, lastFailureAt: null, signingKeyVersion: 1, version: 1 }; webhookSubscriptions.push(value); return json(route, { ok: true, signingSecret: 'odin_whsec_shown_once', value }, 201); }
    const webhookUpdate = path.match(/^\/api\/integrations\/webhooks\/([^/]+)$/); if (webhookUpdate && method === 'PATCH') { const index = webhookSubscriptions.findIndex((item) => item.id === webhookUpdate[1]); const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON(); webhookSubscriptions[index] = { ...webhookSubscriptions[index], ...input, version: webhookSubscriptions[index].version + 1 }; return json(route, { ok: true, value: webhookSubscriptions[index] }); }
    const webhookRotate = path.match(/^\/api\/integrations\/webhooks\/([^/]+)\/rotate$/); if (webhookRotate && method === 'POST') { const item = webhookSubscriptions.find((record) => record.id === webhookRotate[1]); item.signingKeyVersion += 1; item.version += 1; return json(route, { ok: true, signingSecret: 'odin_whsec_rotated_once', value: item }); }
    const deliveryReplay = path.match(/^\/api\/integrations\/webhook-deliveries\/([^/]+)\/replay$/); if (deliveryReplay && method === 'POST') { const item = webhookDeliveries.find((record) => record.id === deliveryReplay[1]); item.attempts = 0; item.status = 'pending'; item.version += 1; return json(route, { ok: true, value: item }); }
    if (method === 'GET' && path === '/api/connectors') { const health = connectorConnections.map((item) => ({ connectionId: item.id, failures: 0, pending: [...connectorEvents, ...connectorRuns].filter((record) => record.connectionId === item.id && record.status === 'pending').length, status: item.status === 'active' ? 'healthy' : item.status })); return json(route, { catalog: structuredClone(connectorCatalog), conflicts: structuredClone(connectorConflicts), connections: structuredClone(connectorConnections), events: structuredClone(connectorEvents), health, mappings: structuredClone(connectorMappings), runs: structuredClone(connectorRuns), total: connectorConnections.length }); }
    if (method === 'POST' && path === '/api/connectors/connections') { const input = request.postDataJSON(); const value = { ...input, createdAt: new Date().toISOString(), id: `33333333-3333-4333-8333-${String(connectorConnections.length + 1).padStart(12, '0')}`, updatedAt: new Date().toISOString(), version: 1 }; connectorConnections.push(value); return json(route, { inboundSecret: 'odin_connector_shown_once', ok: true, value }, 201); }
    const connectorUpdate = path.match(/^\/api\/connectors\/connections\/([^/]+)$/); if (connectorUpdate && method === 'PATCH') { const index = connectorConnections.findIndex((item) => item.id === connectorUpdate[1]); const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON(); connectorConnections[index] = { ...connectorConnections[index], ...input, updatedAt: new Date().toISOString(), version: connectorConnections[index].version + 1 }; return json(route, { ok: true, value: connectorConnections[index] }); }
    if (method === 'POST' && path === '/api/connectors/mappings') { const input = request.postDataJSON(); const value = { ...input, id: `mapping-${connectorMappings.length + 1}`, version: 1 }; connectorMappings.push(value); return json(route, { ok: true, value }, 201); }
    const connectorConflict = path.match(/^\/api\/connectors\/conflicts\/([^/]+)\/resolve$/); if (connectorConflict && method === 'POST') { const item = connectorConflicts.find((record) => record.id === connectorConflict[1]); item.status = 'resolved'; item.version += 1; return json(route, { ok: true, value: item }); }
    const connectorSync = path.match(/^\/api\/connectors\/connections\/([^/]+)\/sync-runs$/); if (connectorSync && method === 'POST') { const input = request.postDataJSON(); const run = { connectionId: connectorSync[1], direction: input.direction, id: `run-${connectorRuns.length + 1}`, idempotencyKey: input.idempotencyKey, status: 'pending', updatedAt: new Date().toISOString(), version: 1 }; connectorRuns.push(run); return json(route, { duplicate: false, ok: true, run }, 202); }
    if (method === 'GET' && path === '/api/agent-goals') return json(route, { goals: structuredClone(agentGoals), ok: true });
    if (method === 'POST' && path === '/api/agent-goals') {
      const input = request.postDataJSON();
      const goal = { ...input, id: `goal-${agentGoals.length + 1}`, ownerUserId: syntheticUser.id, status: 'active', version: 1 };
      agentGoals.push(goal);
      return json(route, { goal, ok: true }, 201);
    }
    const goalMatch = path.match(/^\/api\/agent-goals\/([^/]+)$/);
    if (goalMatch && method === 'GET') {
      const goal = agentGoals.find((item) => item.id === goalMatch[1]);
      return json(route, { goal, ok: true, runs: goalRuns.filter((run) => run.goalId === goal.id) });
    }
    if (goalMatch && method === 'PATCH') {
      const index = agentGoals.findIndex((item) => item.id === goalMatch[1]);
      const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON();
      agentGoals[index] = { ...agentGoals[index], ...input, version: agentGoals[index].version + 1 };
      return json(route, { goal: agentGoals[index], ok: true });
    }
    const goalRunMatch = path.match(/^\/api\/agent-goals\/([^/]+)\/runs$/);
    if (goalRunMatch && method === 'POST') {
      const run = { goalId: goalRunMatch[1], id: `run-${goalRuns.length + 1}`, status: 'queued' };
      goalRuns.push(run);
      return json(route, { created: true, ok: true, run, session: { id: `session-${run.id}` } }, 202);
    }
    const goalMonitorsMatch = path.match(/^\/api\/agent-goals\/([^/]+)\/monitors$/);
    if (goalMonitorsMatch && method === 'GET') return json(route, { goal: agentGoals.find((item) => item.id === goalMonitorsMatch[1]), monitors: structuredClone(goalMonitors.filter((monitor) => monitor.goalId === goalMonitorsMatch[1])), ok: true });
    if (goalMonitorsMatch && method === 'POST') {
      const input = request.postDataJSON();
      const monitor = { ...input, enabled: true, goalId: goalMonitorsMatch[1], id: `monitor-${goalMonitors.length + 1}`, payload: { context: input.payload, sessionId: `monitor-session-${goalMonitors.length + 1}` }, runCount: 0, version: 1 };
      goalMonitors.push(monitor);
      return json(route, { monitor, ok: true, session: { id: monitor.payload.sessionId } }, 201);
    }
    const goalNotificationsMatch = path.match(/^\/api\/agent-goals\/([^/]+)\/notifications$/);
    if (goalNotificationsMatch && method === 'GET') return json(route, { notifications: structuredClone(goalNotifications.filter((notification) => notification.goalId === goalNotificationsMatch[1])), ok: true });
    const notificationMatch = path.match(/^\/api\/agent-goals\/notifications\/([^/]+)$/);
    if (notificationMatch && method === 'PATCH') {
      const index = goalNotifications.findIndex((notification) => notification.id === notificationMatch[1]);
      const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON();
      goalNotifications[index] = { ...goalNotifications[index], ...input, version: goalNotifications[index].version + 1 };
      return json(route, { notification: goalNotifications[index], ok: true });
    }
    const monitorMatch = path.match(/^\/api\/agent-goals\/monitors\/([^/]+)$/);
    if (monitorMatch && method === 'PATCH') {
      const index = goalMonitors.findIndex((item) => item.id === monitorMatch[1]);
      const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON();
      goalMonitors[index] = { ...goalMonitors[index], ...input, version: goalMonitors[index].version + 1 };
      return json(route, { monitor: goalMonitors[index], ok: true });
    }
    if (method === 'POST' && path === `/api/projects/${syntheticProject.id}/governance/items`) {
      const input = request.postDataJSON();
      const value = { ...input, createdAt: new Date().toISOString(), id: `item-${governance.items.length + 1}`, updatedAt: new Date().toISOString(), version: 1 };
      governance.items.push(value);
      return json(route, { ok: true, value }, 201);
    }
    if (method === 'PUT' && path === `/api/projects/${syntheticProject.id}/governance/working-calendar`) {
      const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON();
      governance.workingCalendar = { ...input, version: Number(governance.workingCalendar?.version ?? 0) + 1 };
      return json(route, { ok: true, value: structuredClone(governance.workingCalendar) });
    }
    if (method === 'POST' && path === `/api/projects/${syntheticProject.id}/governance/schedule-baselines`) {
      const input = request.postDataJSON();
      const value = {
        ...input, capturedAt: new Date().toISOString(), createdBy: syntheticUser.id,
        id: `schedule-baseline-${governance.scheduleBaselines.length + 1}`,
        snapshot: { capturedSchema: 'schedule-baseline.v1' }, version: 1,
      };
      governance.scheduleBaselines.unshift(value);
      return json(route, { ok: true, value: structuredClone(value) }, 201);
    }
    const itemMatch = path.match(new RegExp(`^/api/projects/${syntheticProject.id}/governance/items/([^/]+)$`));
    if (itemMatch && method === 'PATCH') {
      const index = governance.items.findIndex((item) => item.id === itemMatch[1]);
      const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON();
      governance.items[index] = { ...governance.items[index], ...input, version: governance.items[index].version + 1 };
      return json(route, { ok: true, value: governance.items[index] });
    }
    if (itemMatch && method === 'DELETE') {
      governance.items = governance.items.filter((item) => item.id !== itemMatch[1]);
      return json(route, { ok: true, value: true });
    }
    if (method === 'POST' && path === `/api/projects/${syntheticProject.id}/governance/milestones`) {
      const value = { ...request.postDataJSON(), id: `milestone-${governance.milestones.length + 1}`, version: 1 };
      governance.milestones.push(value);
      return json(route, { ok: true, value }, 201);
    }
    const milestoneMatch = path.match(new RegExp(`^/api/projects/${syntheticProject.id}/governance/milestones/([^/]+)$`));
    if (milestoneMatch && method === 'PATCH') {
      const index = governance.milestones.findIndex((item) => item.id === milestoneMatch[1]);
      const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON();
      governance.milestones[index] = { ...governance.milestones[index], ...input, version: governance.milestones[index].version + 1 };
      return json(route, { ok: true, value: governance.milestones[index] });
    }
    if (milestoneMatch && method === 'DELETE') {
      governance.milestones = governance.milestones.filter((item) => item.id !== milestoneMatch[1]);
      return json(route, { ok: true, value: true });
    }
    if (method === 'POST' && path === `/api/projects/${syntheticProject.id}/governance/dependencies`) {
      const value = { ...request.postDataJSON(), id: `dependency-${governance.dependencies.length + 1}`, version: 1 };
      governance.dependencies.push(value);
      return json(route, { ok: true, value }, 201);
    }
    const dependencyMatch = path.match(new RegExp(`^/api/projects/${syntheticProject.id}/governance/dependencies/([^/]+)$`));
    if (dependencyMatch && method === 'PATCH') {
      const index = governance.dependencies.findIndex((item) => item.id === dependencyMatch[1]);
      const { expectedVersion: _expectedVersion, ...input } = request.postDataJSON();
      governance.dependencies[index] = { ...governance.dependencies[index], ...input, version: governance.dependencies[index].version + 1 };
      return json(route, { ok: true, value: governance.dependencies[index] });
    }
    if (dependencyMatch && method === 'DELETE') {
      governance.dependencies = governance.dependencies.filter((item) => item.id !== dependencyMatch[1]);
      return json(route, { ok: true, value: true });
    }
    if (method === 'GET' && path === `/api/assistant/projects/${syntheticProject.id}/clarifications`) {
      return json(route, { clarifications: [], stakeholders: [] });
    }
    if (method === 'GET' && path === '/api/assistant/chats') {
      const chats = [...assistantChats.values()].filter((chat) => chat.messages.length);
      const summary = (chat) => ({ createdAt: chat.createdAt, id: chat.id, lastMessagePreview: chat.messages.at(-1)?.content?.slice(0, 120) ?? '', pendingProposalCount: 0, projectId: chat.projectId, status: chat.run?.status ?? 'idle', title: chat.title, updatedAt: chat.updatedAt });
      return json(route, {
        general: chats.filter((chat) => !chat.projectId).map(summary),
        ok: true,
        projects: chats.some((chat) => chat.projectId) ? [{ chats: chats.filter((chat) => chat.projectId).map(summary), projectId: syntheticProject.id, projectName: syntheticProject.name, updatedAt: chats[0].updatedAt }] : [],
        projectsAvailable: [{ id: syntheticProject.id, name: syntheticProject.name }],
      });
    }
    if (method === 'POST' && path === '/api/assistant/chats') {
      const { projectId = null } = request.postDataJSON() ?? {};
      const chat = { createdAt: '2026-07-20T10:00:00.000Z', id: `chat-${assistantChats.size + 1}`, messages: [], pending: null, projectId, projectName: projectId ? syntheticProject.name : null, run: null, settings: { allowWebResearch: true }, title: 'New chat', updatedAt: '2026-07-20T10:00:00.000Z' };
      assistantChats.set(chat.id, chat);
      return json(route, { chat, ok: true }, 201);
    }
    const chatMatch = path.match(/^\/api\/assistant\/chats\/([^/]+)(?:\/(messages|proposals|confirmation|cancel|events))?$/);
    const undoMatch = path.match(/^\/api\/assistant\/chats\/([^/]+)\/messages\/([^/]+)\/undo$/);
    if (method === 'POST' && undoMatch && assistantChats.has(undoMatch[1])) {
      const chat = assistantChats.get(undoMatch[1]);
      const reply = chat.messages.find((entry) => entry.id === undoMatch[2] && entry.changes);
      if (!reply || reply.changes.status !== 'applied') return json(route, { error: 'Those changes were already undone.', ok: false }, 409);
      for (const record of reply.changes.records) {
        if (!record.undoable) { record.status = 'not_undoable'; record.note = 'This kind of change can\'t be undone here.'; } else record.status = 'undone';
      }
      reply.changes.status = reply.changes.records.every((record) => record.status === 'undone') ? 'undone' : 'partly_undone';
      const undone = reply.changes.records.filter((record) => record.status === 'undone');
      chat.messages.push({ activity: [], content: `Undid ${undone.length} changes.\n\n${undone.map((record) => `- ${record.label}`).join('\n')}`, createdAt: '2026-07-20T10:02:00.000Z', id: `message-${chat.messages.length + 1}`, role: 'assistant', undoOf: reply.id });
      return json(route, { chat, ok: true });
    }
    if (chatMatch && chatMatch[1] !== 'events' && assistantChats.has(chatMatch[1])) {
      const chat = assistantChats.get(chatMatch[1]);
      const [, , action] = chatMatch;
      if (method === 'GET' && !action) return json(route, { chat, ok: true });
      if (method === 'GET' && action === 'events') return route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 });
      if (method === 'PATCH' && !action) {
        Object.assign(chat, request.postDataJSON()?.title ? { title: request.postDataJSON().title } : {});
        return json(route, { chat, ok: true });
      }
      if (method === 'DELETE' && !action) {
        assistantChats.delete(chat.id);
        return json(route, { ok: true });
      }
      if (method === 'POST' && action === 'messages') {
        const { message } = request.postDataJSON();
        chat.messages.push({ content: message, createdAt: '2026-07-20T10:01:00.000Z', id: `message-${chat.messages.length + 1}`, role: 'user' });
        chat.messages.push({ activity: [{ callId: 'call-1', label: 'Read the project overview', name: 'odin_project_overview', ok: true }], content: assistantReply, createdAt: '2026-07-20T10:01:05.000Z', id: `message-${chat.messages.length + 1}`, role: 'assistant' });
        if (chat.title === 'New chat') chat.title = message.slice(0, 60);
        chat.run = { id: `run-${chat.messages.length}`, status: 'completed' };
        return json(route, { chat, ok: true }, 202);
      }
      if (method === 'POST' && action === 'proposals') {
        const { decision, itemIds = [], proposalId } = request.postDataJSON();
        const proposal = chat.messages.find((entry) => entry.proposal?.id === proposalId)?.proposal;
        for (const item of proposal?.items ?? []) if (item.status === 'pending' && (!itemIds.length || itemIds.includes(item.id))) item.status = decision === 'apply' ? 'applied' : 'dismissed';
        if (proposal) proposal.status = proposal.items.every((item) => item.status === 'applied') ? 'applied' : 'partial';
        return json(route, { chat, ok: true });
      }
    }
    if (method === 'GET' && (
      path === '/api/assistant/chats/events'
      || path === `/api/projects/${syntheticProject.id}/events`
      || path === '/api/workspace/events'
      || path === '/api/me/events'
    )) {
      return route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 });
    }

    // The top bar's bell (docs/odin-chat/plan.md): no notifications and no push unless a spec
    // installs fixtures/notifications-api.js.
    if (method === 'GET' && path === '/api/me/notifications') return json(route, { notifications: [], ok: true, unreadCount: 0 });
    if (method === 'GET' && path === '/api/me/push') return json(route, { available: false, ok: true, publicKey: '' });
    if (method === 'POST' && path === '/api/me/focus') return json(route, { focusedForMs: 60000, ok: true });

    // The project tab bar asks for the Requirements badge count on every project page.
    // Requirements specs install richer handlers from ./requirements-api.js.
    if (method === 'GET' && path === `/api/projects/${syntheticProject.id}/requirements/my-items`) {
      return json(route, { canDecide: false, counts: { answer: 0, decide: 0, drafts: 0, review: 0, total: 0 }, groups: { answer: [], decide: [], drafts: [], review: [] }, ok: true });
    }
    // The projects list asks for what is waiting on the user in each project.
    if (method === 'GET' && path === '/api/requirements/project-signals') {
      return json(route, { ok: true, projects: [{ projectId: syntheticProject.id, review: null, waiting: { answer: 0, decide: 0, drafts: 0, review: 0, total: 0 } }] });
    }

    // Each file's comment thread shows when its row opens (fixtures/channels-api.js has a full one).
    const commentsMatch = /^\/api\/projects\/[^/]+\/files\/([^/]+)\/(comments|mentionables)$/.exec(path);
    if (method === 'GET' && commentsMatch) {
      return json(route, commentsMatch[2] === 'comments' ? { canComment: true, comments: [], currentVersion: 1, fileId: commentsMatch[1], more: false, ok: true } : { ok: true, people: [] });
    }

    unexpectedRequests.push(`${method} ${path}`);
    return json(route, { error: 'Unexpected synthetic API request.' }, 501);
  });

  return {
    assertNoUnexpectedRequests() {
      expect(unexpectedRequests, `Unexpected API calls: ${unexpectedRequests.join(', ')}`).toEqual([]);
    },
    resetAuthentication() {
      authenticated = false;
    },
  };
}

/**
 * Opens the phone menu and waits for it to finish opening. It animates, and a press that lands
 * part way misses its target as the target moves.
 */
export async function openPhoneMenu(page) {
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(page.locator('#navbarSupportedContent.show:not(.collapsing)')).toBeVisible();
}

/**
 * Opens one of the top bar's menus (Work, Plan or Insights; docs/odin-chat/plan.md, layout A),
 * opening the phone menu first when the bar is collapsed. Returns the menu's list.
 */
export async function openTopMenu(page, name) {
  const toggle = page.getByRole('button', { exact: true, name });
  // On a phone, wait out a closing menu (a choice closes it) before opening it again.
  if (await page.getByRole('button', { name: 'Toggle navigation' }).isVisible()) {
    await expect(page.locator('#navbarSupportedContent.collapsing')).toHaveCount(0);
    if (!await page.locator('#navbarSupportedContent.show').count()) await openPhoneMenu(page);
  }
  await toggle.click();
  const menu = page.locator(`#${name.toLowerCase()}Menu + .dropdown-menu`);
  await expect(menu).toBeVisible();
  return menu;
}

export async function authenticateSyntheticUser(page) {
  await page.goto('/app/login');
  await page.getByLabel('Work email').fill('demo@example.com');
  await page.getByLabel('Password').fill('SyntheticPass123!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Synthetic$/ })).toBeVisible();
}
