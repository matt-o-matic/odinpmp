import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, BROWSER_SESSION_MARKER, createApiClient } from '../src/lib/api/client.js';

test('cookie-authenticated mutations include credentials and the CSRF cookie header without bearer auth', async () => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.document = { cookie: 'odin_csrf=signed-csrf-token; theme=dark' };
  globalThis.fetch = async (_url, options) => {
    calls.push(options);
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };

  try {
    const client = createApiClient({ baseUrl: 'http://localhost:3001' });
    await client.createProject({ name: 'Cookie project' }, BROWSER_SESSION_MARKER);
  } finally {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }

  assert.equal(calls[0].credentials, 'include');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].headers['X-CSRF-Token'], 'signed-csrf-token');
});

test('authenticated 401 responses trigger the unauthorized handler', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async json() {
      return { error: 'Session is no longer valid.' };
    },
  });

  const client = createApiClient({
    baseUrl: 'http://localhost:3001',
  });
  client.setUnauthorizedHandler((error) => {
    calls.push({
      message: error.message,
      status: error.status,
    });
  });

  try {
    await assert.rejects(
      client.getProjects('expired-token'),
      (error) => error instanceof ApiError && error.status === 401,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(calls, [
    {
      message: 'Session is no longer valid.',
      status: 401,
    },
  ]);
});

test('unauthenticated 401 responses do not trigger the unauthorized handler', async () => {
  const previousFetch = globalThis.fetch;
  let unauthorizedCalls = 0;

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async json() {
      return { error: 'Invalid email or password.' };
    },
  });

  const client = createApiClient({
    baseUrl: 'http://localhost:3001',
  });
  client.setUnauthorizedHandler(() => {
    unauthorizedCalls += 1;
  });

  try {
    await assert.rejects(
      client.login({
        email: 'ada@example.com',
        password: 'wrong-password',
      }),
      (error) => error instanceof ApiError && error.status === 401,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(unauthorizedCalls, 0);
});

test('file content requests include bearer auth and return blobs', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      authorization: options.headers.Authorization,
      method: options.method ?? 'GET',
      url: String(url),
    });

    return {
      headers: {
        get(name) {
          return name === 'Content-Type' ? 'text/plain' : null;
        },
      },
      ok: true,
      status: 200,
      async blob() {
        return new Blob(['hello'], { type: 'text/plain' });
      },
    };
  };

  const client = createApiClient({
    baseUrl: 'http://localhost:3001',
  });

  let result;
  try {
    result = await client.getFileContent('file-1', 'session-token');
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(await result.blob.text(), 'hello');
  assert.equal(result.contentType, 'text/plain');
  assert.deepEqual(calls, [
    {
      authorization: 'Bearer session-token',
      method: 'GET',
      url: 'http://localhost:3001/api/files/file-1/content',
    },
  ]);
});

test('request timeouts surface as 408 ApiError responses', async () => {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (_url, { signal } = {}) => new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  const client = createApiClient({
    baseUrl: 'http://localhost:3001',
  });

  try {
    await assert.rejects(
      client.getCurrentUser('token', {
        skipAuthRedirect: true,
        timeoutMs: 10,
      }),
      (error) => error instanceof ApiError && error.status === 408 && error.message === 'Request timed out.',
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('project archive client methods call the archive endpoints', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      body: options.body ? JSON.parse(options.body) : null,
      method: options.method ?? 'GET',
      url: String(url),
    });

    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true };
      },
    };
  };

  const client = createApiClient({
    baseUrl: 'http://localhost:3001',
  });

  try {
    await client.exportProject('project-1', 'token');
    await client.inspectProjectImport({ base64OdinProject: 'abc' }, 'token');
    await client.importProject({ base64OdinProject: 'abc', userMappings: [] }, 'token');
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(calls, [
    {
      body: null,
      method: 'GET',
      url: 'http://localhost:3001/api/projects/project-1/export',
    },
    {
      body: { base64OdinProject: 'abc' },
      method: 'POST',
      url: 'http://localhost:3001/api/projects/import/inspect',
    },
    {
      body: { base64OdinProject: 'abc', userMappings: [] },
      method: 'POST',
      url: 'http://localhost:3001/api/projects/import',
    },
  ]);
});

test('project governance client methods preserve versioned mutation contracts', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ body: options.body ? JSON.parse(options.body) : null, method: options.method ?? 'GET', url: String(url) });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try {
    await client.getProjectGovernance('project-1', 'token');
    await client.getProjectScheduleAnalysis('project-1', 'token');
    await client.updateProjectWorkingCalendar('project-1', { expectedVersion: 1, timezone: 'UTC' }, 'token');
    await client.createProjectScheduleBaseline('project-1', { name: 'Approved plan' }, 'token');
    await client.createProjectGovernanceItem('project-1', { kind: 'risk', title: 'Risk' }, 'token');
    await client.updateProjectGovernanceItem('project-1', 'item-1', { expectedVersion: 2, title: 'Updated' }, 'token');
    await client.deleteProjectGovernanceItem('project-1', 'item-1', 3, 'token');
    await client.createProjectDependency('project-1', { predecessorId: 'a', successorId: 'b' }, 'token');
    await client.updateProjectDependency('project-1', 'dependency-1', { dependencyType: 'SS', expectedVersion: 1, predecessorId: 'a', successorId: 'b' }, 'token');
    await client.deleteProjectDependency('project-1', 'dependency-1', 4, 'token');
    await client.createProjectMilestone('project-1', { targetDate: '2026-09-01', title: 'Launch' }, 'token');
    await client.updateProjectMilestone('project-1', 'milestone-1', { expectedVersion: 1, status: 'achieved' }, 'token');
    await client.deleteProjectMilestone('project-1', 'milestone-1', 2, 'token');
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(calls.map(({ method, url }) => [method, new URL(url).pathname]), [
    ['GET', '/api/projects/project-1/governance'],
    ['GET', '/api/projects/project-1/governance/schedule-analysis'],
    ['PUT', '/api/projects/project-1/governance/working-calendar'],
    ['POST', '/api/projects/project-1/governance/schedule-baselines'],
    ['POST', '/api/projects/project-1/governance/items'],
    ['PATCH', '/api/projects/project-1/governance/items/item-1'],
    ['DELETE', '/api/projects/project-1/governance/items/item-1'],
    ['POST', '/api/projects/project-1/governance/dependencies'],
    ['PATCH', '/api/projects/project-1/governance/dependencies/dependency-1'],
    ['DELETE', '/api/projects/project-1/governance/dependencies/dependency-1'],
    ['POST', '/api/projects/project-1/governance/milestones'],
    ['PATCH', '/api/projects/project-1/governance/milestones/milestone-1'],
    ['DELETE', '/api/projects/project-1/governance/milestones/milestone-1'],
  ]);
  assert.deepEqual(calls[6].body, { expectedVersion: 3 });
  assert.deepEqual(calls[9].body, { expectedVersion: 4 });
  assert.deepEqual(calls[12].body, { expectedVersion: 2 });
});

test('project item client exposes granular version and restore contracts', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ body: options.body ? JSON.parse(options.body) : null, method: options.method ?? 'GET', url: String(url) });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try {
    await client.createProjectItem('project-1', { item: { name: 'Story' }, itemType: 'story', parentId: 'epic-1' }, 'token');
    await client.updateProjectItem('project-1', 'story-1', { expectedVersion: 1, patch: { name: 'Updated' } }, 'token');
    await client.deleteProjectItem('project-1', 'story-1', { expectedVersion: 2 }, 'token');
    await client.listProjectItemRevisions('project-1', 'story-1', 'token', { limit: 50 });
    await client.restoreProjectItem('project-1', 'story-1', { expectedVersion: 3, revisionId: 'revision-1', state: 'before' }, 'token');
  } finally { globalThis.fetch = previousFetch; }
  assert.deepEqual(calls.map(({ method, url }) => [method, `${new URL(url).pathname}${new URL(url).search}`]), [
    ['POST', '/api/projects/project-1/items'],
    ['PATCH', '/api/projects/project-1/items/story-1'],
    ['DELETE', '/api/projects/project-1/items/story-1'],
    ['GET', '/api/projects/project-1/items/story-1/revisions?limit=50'],
    ['POST', '/api/projects/project-1/items/story-1/restore'],
  ]);
  assert.deepEqual(calls[4].body, { expectedVersion: 3, revisionId: 'revision-1', state: 'before' });
});

test('agent goal client methods preserve lifecycle and monitor versions', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ body: options.body ? JSON.parse(options.body) : null, method: options.method ?? 'GET', url: String(url) });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try {
    await client.getAgentGoals('project 1', 'token');
    await client.getAgentGoal('goal-1', 'token');
    await client.createAgentGoal({ projectId: 'project-1', title: 'Goal' }, 'token');
    await client.updateAgentGoal('goal-1', { expectedVersion: 1, status: 'paused' }, 'token');
    await client.runAgentGoal('goal-1', 'token');
    await client.getAgentGoalMonitors('goal-1', 'token');
    await client.getAgentGoalNotifications('goal-1', 'token');
    await client.updateAgentGoalNotification('notification-1', { expectedVersion: 1, status: 'read' }, 'token');
    await client.searchAgentMemory({ limit: 10, projectIds: ['project-1'], query: 'vendor decision', types: ['decision'] }, 'token');
    await client.createAgentMemory({ content: 'Evidence', memoryType: 'decision', title: 'Decision' }, 'token');
    await client.forgetAgentMemory('memory-1', 1, 'token');
    await client.updateAgentMemoryGovernance('memory-1', { expectedVersion: 1, legalHold: true }, 'token');
    await client.purgeExpiredAgentMemory({ cutoffAt: '2026-07-11T00:00:00Z' }, 'token');
    await client.browseAgentMemory({ limit: 25, offset: 0, project: '', query: 'vendor', sensitivities: [], types: ['decision', 'fact'] }, 'token');
    await client.correctAgentMemory('memory-1', { content: 'Fixed', expectedVersion: 2 }, 'token');
    await client.createAgentGoalMonitor('goal-1', { intervalMinutes: 30, title: 'Monitor', triggerType: 'schedule' }, 'token');
    await client.updateAgentGoalMonitor('monitor-1', { enabled: false, expectedVersion: 1 }, 'token');
  } finally { globalThis.fetch = previousFetch; }
  assert.deepEqual(calls.map(({ method, url }) => [method, new URL(url).pathname + new URL(url).search]), [
    ['GET', '/api/agent-goals?projectId=project%201'],
    ['GET', '/api/agent-goals/goal-1'],
    ['POST', '/api/agent-goals'],
    ['PATCH', '/api/agent-goals/goal-1'],
    ['POST', '/api/agent-goals/goal-1/runs'],
    ['GET', '/api/agent-goals/goal-1/monitors'],
    ['GET', '/api/agent-goals/goal-1/notifications'],
    ['PATCH', '/api/agent-goals/notifications/notification-1'],
    ['GET', '/api/agent-memory?limit=10&query=vendor+decision&projectIds=project-1&types=decision'],
    ['POST', '/api/agent-memory'],
    ['DELETE', '/api/agent-memory/memory-1'],
    ['PATCH', '/api/agent-memory/memory-1/governance'],
    ['POST', '/api/agent-memory/purge-expired'],
    ['GET', '/api/agent-memory/browse?limit=25&offset=0&query=vendor&types=decision%2Cfact'],
    ['PATCH', '/api/agent-memory/memory-1'],
    ['POST', '/api/agent-goals/goal-1/monitors'],
    ['PATCH', '/api/agent-goals/monitors/monitor-1'],
  ]);
});

test('portfolio client methods preserve filters and optimistic versions', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ body: options.body ? JSON.parse(options.body) : null, method: options.method ?? 'GET', url: String(url) });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try {
    await client.getPortfolioWorkspace({ limit: 25, offset: 25, query: 'growth plan', sort: 'score', status: 'active' }, 'token');
    await client.createPortfolioNode({ kind: 'portfolio', name: 'Growth' }, 'token');
    await client.updatePortfolioNode('node-1', { expectedVersion: 2, name: 'Growth portfolio' }, 'token');
    await client.deletePortfolioNode('node-1', 3, 'token');
    await client.createStrategyObjective({ title: 'Increase activation' }, 'token');
    await client.updateStrategyObjective('objective-1', { currentValue: 40, expectedVersion: 1 }, 'token');
    await client.deleteStrategyObjective('objective-1', 2, 'token');
    await client.createPortfolioAlignment({ portfolioNodeId: 'node-1', projectId: 'project-1' }, 'token');
    await client.updatePortfolioAlignment('alignment-1', { expectedVersion: 4, scenario: 'constrained' }, 'token');
    await client.deletePortfolioAlignment('alignment-1', 5, 'token');
    await client.createPortfolioPlan({ name: 'Funded plan' }, 'token');
    await client.updatePortfolioPlan('plan-1', { expectedVersion: 1, status: 'submitted' }, 'token');
    await client.deletePortfolioPlan('plan-1', 2, 'token');
    await client.capturePortfolioBaseline({ name: 'Approval baseline' }, 'token');
  } finally { globalThis.fetch = previousFetch; }
  assert.deepEqual(calls.map(({ method, url }) => [method, new URL(url).pathname + new URL(url).search]), [
    ['GET', '/api/portfolio?limit=25&offset=25&query=growth+plan&sort=score&status=active'],
    ['POST', '/api/portfolio/nodes'],
    ['PATCH', '/api/portfolio/nodes/node-1'],
    ['DELETE', '/api/portfolio/nodes/node-1'],
    ['POST', '/api/portfolio/objectives'],
    ['PATCH', '/api/portfolio/objectives/objective-1'],
    ['DELETE', '/api/portfolio/objectives/objective-1'],
    ['POST', '/api/portfolio/alignments'],
    ['PATCH', '/api/portfolio/alignments/alignment-1'],
    ['DELETE', '/api/portfolio/alignments/alignment-1'],
    ['POST', '/api/portfolio/plans'],
    ['PATCH', '/api/portfolio/plans/plan-1'],
    ['DELETE', '/api/portfolio/plans/plan-1'],
    ['POST', '/api/portfolio/baselines'],
  ]);
  assert.deepEqual(calls[3].body, { expectedVersion: 3 });
  assert.deepEqual(calls[6].body, { expectedVersion: 2 });
  assert.deepEqual(calls[9].body, { expectedVersion: 5 });
  assert.deepEqual(calls[12].body, { expectedVersion: 2 });
});

test('resource and finance client methods preserve bounded filters and optimistic versions', async () => {
  const previousFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ body: options.body ? JSON.parse(options.body) : null, method: options.method ?? 'GET', url: String(url) }); return { blob: async () => new Blob(['receipt']), headers: new Headers({ 'Content-Type': 'application/pdf' }), ok: true, status: 200, async json() { return { ok: true }; } }; };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try {
    await client.getResourceFinanceWorkspace({ limit: 25, projectId: 'project 1', scenario: 'baseline' }, 'token');
    const specs = [
      ['createResourcePool', ['Pool'], 'updateResourcePool', ['pool-1', { expectedVersion: 1 }], 'deleteResourcePool', ['pool-1', 2]],
      ['createEnterpriseResource', ['Resource'], 'updateEnterpriseResource', ['resource-1', { expectedVersion: 1 }], 'deleteEnterpriseResource', ['resource-1', 2]],
      ['createResourceCalendarEntry', ['Calendar'], 'updateResourceCalendarEntry', ['calendar-1', { expectedVersion: 1 }], 'deleteResourceCalendarEntry', ['calendar-1', 2]],
      ['createResourceAllocation', ['Allocation'], 'updateResourceAllocation', ['allocation-1', { expectedVersion: 1 }], 'deleteResourceAllocation', ['allocation-1', 2]],
      ['createProjectFinancialEntry', ['Finance'], 'updateProjectFinancialEntry', ['finance-1', { expectedVersion: 1 }], 'deleteProjectFinancialEntry', ['finance-1', 2]],
      ['createProjectTimeEntry', ['Time'], 'updateProjectTimeEntry', ['time-1', { expectedVersion: 1 }], 'deleteProjectTimeEntry', ['time-1', 2]],
      ['createProjectExpense', ['Expense'], 'updateProjectExpense', ['expense-1', { expectedVersion: 1 }], 'deleteProjectExpense', ['expense-1', 2]],
      ['createResourceRate', ['Rate'], 'updateResourceRate', ['rate-1', { expectedVersion: 1 }], 'deleteResourceRate', ['rate-1', 2]],
      ['createTimesheetPeriod', ['Period'], 'updateTimesheetPeriod', ['period-1', { expectedVersion: 1 }], 'deleteTimesheetPeriod', ['period-1', 2]],
      ['createExpenseReceipt', ['Receipt'], 'updateExpenseReceipt', ['receipt-1', { expectedVersion: 1 }], 'deleteExpenseReceipt', ['receipt-1', 2]],
      ['createExchangeRate', ['FX'], 'updateExchangeRate', ['fx-1', { expectedVersion: 1 }], 'deleteExchangeRate', ['fx-1', 2]],
      ['createAccountingPeriod', ['Period'], 'updateAccountingPeriod', ['accounting-1', { expectedVersion: 1 }], 'deleteAccountingPeriod', ['accounting-1', 2]],
      ['createFinancePolicy', ['Policy'], 'updateFinancePolicy', ['policy-1', { expectedVersion: 1 }], 'deleteFinancePolicy', ['policy-1', 2]],
    ];
    for (const [createName, createArgs, updateName, updateArgs, deleteName, deleteArgs] of specs) {
      await client[createName]({ title: createArgs[0] }, 'token');
      await client[updateName](...updateArgs, 'token');
      await client[deleteName](...deleteArgs, 'token');
    }
    await client.levelResourceAllocation('allocation-1', { expectedVersion: 3, hours: 12, targetResourceId: 'resource-2' }, 'token');
    await client.uploadExpenseReceipt('expense-1', { contentBase64: 'YQ==', contentType: 'application/pdf', fileName: 'receipt.pdf' }, 'token');
    await client.downloadExpenseReceipt('receipt-1', 'token');
  } finally { globalThis.fetch = previousFetch; }
  assert.equal(new URL(calls[0].url).pathname + new URL(calls[0].url).search, '/api/resource-planning?limit=25&projectId=project+1&scenario=baseline');
  assert.equal(calls.length, 43);
  assert.deepEqual(calls.slice(1, 40).map((call) => call.method), Array(13).fill(['POST', 'PATCH', 'DELETE']).flat());
  assert.ok(calls.filter((call) => call.method === 'DELETE').every((call) => call.body.expectedVersion === 2));
  assert.equal(new URL(calls[40].url).pathname, '/api/resource-planning/allocations/allocation-1/level');
  assert.deepEqual(calls[40].body, { expectedVersion: 3, hours: 12, targetResourceId: 'resource-2' });
  assert.equal(new URL(calls[41].url).pathname, '/api/resource-planning/expenses/expense-1/receipt-content');
  assert.equal(new URL(calls[42].url).pathname, '/api/resource-planning/expense-receipts/receipt-1/content');
});

test('workflow client methods preserve project filters and optimistic versions', async () => {
  const previousFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ body: options.body ? JSON.parse(options.body) : null, method: options.method ?? 'GET', url: String(url) }); return { ok: true, status: 200, async json() { return { ok: true }; } }; };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try {
    await client.getWorkflowWorkspace({ projectId: 'project 1', query: 'delivery' }, 'token');
    await client.createWorkflowDefinition({ name: 'Delivery' }, 'token'); await client.updateWorkflowDefinition('workflow-1', { expectedVersion: 1 }, 'token'); await client.deleteWorkflowDefinition('workflow-1', 2, 'token');
    await client.createWorkflowBinding({ projectId: 'project-1' }, 'token'); await client.updateWorkflowBinding('binding-1', { expectedVersion: 1 }, 'token'); await client.deleteWorkflowBinding('binding-1', 2, 'token');
    await client.requestWorkflowApproval({ projectId: 'project-1' }, 'token'); await client.decideWorkflowApproval('approval-1', { expectedVersion: 1, status: 'approved' }, 'token'); await client.createProjectBaseline({ name: 'Plan', projectId: 'project-1' }, 'token');
    await client.createProjectTemplate({ name: 'Starter' }, 'token'); await client.updateProjectTemplate('template-1', { expectedVersion: 1 }, 'token'); await client.deleteProjectTemplate('template-1', 2, 'token');
    await client.createCustomFieldDefinition({ name: 'Evidence' }, 'token'); await client.updateCustomFieldDefinition('field-1', { expectedVersion: 1 }, 'token'); await client.deleteCustomFieldDefinition('field-1', 2, 'token');
    await client.writeCustomFieldValue({ fieldId: 'field-1' }, 'token'); await client.deleteCustomFieldValue('value-1', 2, 'token');
    await client.getWorkflowDefinition('workflow 1', 'token'); await client.listWorkflowTemplates({ kind: 'work_item', status: 'active' }, 'token');
  } finally { globalThis.fetch = previousFetch; }
  assert.equal(new URL(calls[0].url).pathname + new URL(calls[0].url).search, '/api/workflows?projectId=project+1&query=delivery');
  assert.deepEqual(calls.filter((call) => call.method === 'DELETE').map((call) => call.body), Array(5).fill({ expectedVersion: 2 }));
  assert.equal(new URL(calls[18].url).pathname, '/api/workflows/definitions/workflow%201');
  assert.equal(new URL(calls[19].url).pathname + new URL(calls[19].url).search, '/api/workflows/templates?kind=work_item&status=active');
  assert.equal(calls.length, 20);
});

test('reporting client methods preserve bounded filters, versions, and export contracts', async () => {
  const previousFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ body: options.body ? JSON.parse(options.body) : null, method: options.method ?? 'GET', url: String(url) }); return { ok: true, status: 200, async json() { return { ok: true }; } }; };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try {
    await client.getReportingWorkspace({ limit: 25, projectId: 'project 1', query: 'delivery' }, 'token'); await client.getStandardDashboards('project 1', 'token'); await client.searchEnterprise({ query: 'launch plan', types: 'project,risk' }, 'token'); await client.refreshEnterpriseSearch('token');
    await client.createSavedView({ name: 'View' }, 'token'); await client.updateSavedView('view-1', { expectedVersion: 1 }, 'token'); await client.deleteSavedView('view-1', 2, 'token');
    await client.createReportDefinition({ name: 'Report' }, 'token'); await client.updateReportDefinition('report-1', { expectedVersion: 1 }, 'token'); await client.deleteReportDefinition('report-1', 2, 'token'); await client.runReport('report-1', { format: 'xlsx' }, 'token');
    await client.createReportSubscription({ reportId: 'report-1' }, 'token'); await client.updateReportSubscription('subscription-1', { expectedVersion: 1 }, 'token'); await client.deleteReportSubscription('subscription-1', 2, 'token'); await client.getBiFeed('risk', { limit: 100 }, 'token');
  } finally { globalThis.fetch = previousFetch; }
  assert.equal(new URL(calls[0].url).pathname + new URL(calls[0].url).search, '/api/reporting?limit=25&projectId=project+1&query=delivery'); assert.equal(new URL(calls[1].url).pathname + new URL(calls[1].url).search, '/api/reporting/dashboards?projectId=project%201'); assert.equal(new URL(calls[2].url).search, '?query=launch+plan&types=project%2Crisk'); assert.deepEqual(calls.filter((call) => call.method === 'DELETE').map((call) => call.body), Array(3).fill({ expectedVersion: 2 })); assert.equal(calls.length, 15);
});

test('tenant switch client uses the authenticated session endpoint', async () => {
  const previousFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ body: JSON.parse(options.body), method: options.method, url: String(url) }); return { ok: true, status: 200, async json() { return { ok: true }; } }; };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try { await client.switchTenant('tenant-2', 'token'); } finally { globalThis.fetch = previousFetch; }
  assert.equal(new URL(calls[0].url).pathname, '/api/auth/switch-tenant');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { tenantId: 'tenant-2' });
});

test('enterprise SSO discovery encodes the email as a public request', async () => {
  const previousFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ method: options.method ?? 'GET', url: String(url) }); return { ok: true, status: 200, async json() { return { configured: true, mode: 'saml' }; } }; };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try { await client.discoverEnterpriseSso('user+delivery@example.com'); } finally { globalThis.fetch = previousFetch; }
  assert.equal(new URL(calls[0].url).pathname + new URL(calls[0].url).search, '/api/auth/sso/discover?email=user%2Bdelivery%40example.com');
  assert.equal(calls[0].method, 'GET');
});

test('identity client methods preserve versions and governed credential operations', async () => {
  const previousFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ body: options.body ? JSON.parse(options.body) : null, method: options.method ?? 'GET', url: String(url) }); return { ok: true, status: 200, async json() { return { ok: true }; } }; };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try {
    await client.getIdentityWorkspace({ limit: 100 }, 'token'); await client.saveIdentityPolicy({ expectedVersion: 0 }, 'token');
    await client.createVerifiedDomain({ domain: 'example.com' }, 'token'); await client.verifyIdentityDomain('domain-1', { expectedVersion: 1, proof: 'proof' }, 'token'); await client.deleteIdentityDomain('domain-1', 2, 'token');
    await client.createCustomRole({ key: 'analyst' }, 'token'); await client.updateCustomRole('role-1', { expectedVersion: 1 }, 'token'); await client.deleteCustomRole('role-1', 2, 'token');
    await client.createIdentityGroup({ name: 'Analysts' }, 'token'); await client.updateIdentityGroup('group-1', { expectedVersion: 1 }, 'token'); await client.addIdentityGroupMember('group-1', 'user one', 'token'); await client.removeIdentityGroupMember('group-1', 'user one', 'token'); await client.deleteIdentityGroup('group-1', 2, 'token');
    await client.createAccessReview({ name: 'Review' }, 'token'); await client.decideAccessReviewItem('item-1', { decision: 'approve', expectedVersion: 1 }, 'token');
    await client.createAccessReviewCampaign({ name: 'Quarterly review' }, 'token'); await client.updateAccessReviewCampaign('campaign-1', { enabled: false, expectedVersion: 1 }, 'token');
    await client.createServiceAccount({ name: 'Automation' }, 'token'); await client.updateServiceAccount('account-1', { expectedVersion: 1 }, 'token'); await client.rotateServiceAccountCredential('account-1', { expectedVersion: 2 }, 'token');
    await client.requestImpersonation({ targetUserId: 'user-1' }, 'token'); await client.decideImpersonation('grant-1', { decision: 'approved', expectedVersion: 1 }, 'token'); await client.activateImpersonation('grant-1', 'token'); await client.endImpersonation('grant-1', 3, 'impersonation-token'); await client.saveBreakGlassPolicy({ enabled: true, expectedVersion: 0 }, 'token'); await client.startBreakGlass({ email: 'admin@example.com', password: 'secret', reason: 'Identity provider outage incident.' }); await client.verifyBreakGlass({ challengeToken: 'challenge', code: '123456' });
  } finally { globalThis.fetch = previousFetch; }
  assert.equal(new URL(calls[0].url).pathname + new URL(calls[0].url).search, '/api/identity?limit=100');
  assert.deepEqual(calls.filter((call) => call.method === 'DELETE').map((call) => call.body), [{ expectedVersion: 2 }, { expectedVersion: 2 }, null, { expectedVersion: 2 }]);
  assert.equal(new URL(calls[11].url).pathname, '/api/identity/groups/group-1/members/user%20one');
  assert.equal(new URL(calls[15].url).pathname, '/api/identity/access-review-campaigns');
  assert.equal(new URL(calls[16].url).pathname, '/api/identity/access-review-campaigns/campaign-1');
  assert.equal(new URL(calls[22].url).pathname, '/api/identity/impersonation-requests/grant-1/activate');
  assert.deepEqual(calls[23].body, { expectedVersion: 3 });
  assert.equal(new URL(calls[24].url).pathname, '/api/identity/break-glass-policy');
  assert.deepEqual(calls.slice(25).map((call) => new URL(call.url).pathname), ['/api/auth/break-glass/start', '/api/auth/break-glass/verify']);
  assert.equal(calls.length, 27);
});

test('integration client methods preserve bounded filters, optimistic versions, rotation, and replay', async () => {
  const previousFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ body: options.body ? JSON.parse(options.body) : null, method: options.method ?? 'GET', url: String(url) }); return { ok: true, status: 200, async json() { return { ok: true }; } }; };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try {
    await client.getIntegrationWorkspace({ limit: 100, offset: 25 }, 'token');
    await client.createOAuthApplication({ name: 'Client' }, 'token'); await client.updateOAuthApplication('app-1', { expectedVersion: 1 }, 'token'); await client.rotateOAuthApplicationCredential('app-1', 2, 'token');
    await client.createWebhookSubscription({ name: 'Hook' }, 'token'); await client.updateWebhookSubscription('hook-1', { expectedVersion: 1 }, 'token'); await client.rotateWebhookSigningSecret('hook-1', 2, 'token'); await client.replayWebhookDelivery('delivery-1', 3, 'token');
    await client.getConnectorWorkspace({ limit: 50, offset: 5 }, 'token'); await client.createConnectorConnection({ name: 'GitHub' }, 'token'); await client.updateConnectorConnection('connector-1', { expectedVersion: 1 }, 'token');
    await client.createConnectorMapping({ connectionId: 'connector-1' }, 'token'); await client.resolveConnectorConflict('conflict-1', { expectedVersion: 1 }, 'token'); await client.createConnectorSyncRun('connector-1', { idempotencyKey: 'sync-001' }, 'token');
    await client.applyConnectorEvent('event-1', 2, 'token');
  } finally { globalThis.fetch = previousFetch; }
  assert.equal(new URL(calls[0].url).pathname + new URL(calls[0].url).search, '/api/integrations?limit=100&offset=25');
  assert.deepEqual(calls.slice(1, 8).map((call) => call.method), ['POST', 'PATCH', 'POST', 'POST', 'PATCH', 'POST', 'POST']);
  assert.deepEqual(calls[3].body, { expectedVersion: 2 }); assert.deepEqual(calls[7].body, { expectedVersion: 3 });
  assert.equal(new URL(calls[8].url).pathname + new URL(calls[8].url).search, '/api/connectors?limit=50&offset=5');
  assert.deepEqual(calls.slice(9).map((call) => call.method), ['POST', 'PATCH', 'POST', 'POST', 'POST', 'POST']);
  assert.equal(new URL(calls[11].url).pathname, '/api/connectors/mappings');
  assert.equal(new URL(calls[12].url).pathname, '/api/connectors/conflicts/conflict-1/resolve');
  assert.equal(new URL(calls[13].url).pathname, '/api/connectors/connections/connector-1/sync-runs');
  assert.equal(new URL(calls[14].url).pathname, '/api/connectors/events/event-1/apply');
  assert.deepEqual(calls[14].body, { expectedVersion: 2 });
});

test('compliance and ticket configuration client methods call their endpoints', async () => {
  const previousFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ body: options.body ? JSON.parse(options.body) : null, method: options.method ?? 'GET', url: String(url) });
    return { headers: { get: () => 'application/json' }, ok: true, status: 200, async blob() { return new Blob(['{}']); }, async json() { return { ok: true }; } };
  };
  const client = createApiClient({ baseUrl: 'http://localhost:3001' });
  try {
    await client.getComplianceWorkspace('token');
    await client.updateCompliancePolicy({ expectedVersion: 1 }, 'token');
    await client.createComplianceAuditExport({ endDate: '2026-07-11', startDate: '2026-07-10' }, 'token');
    const download = await client.downloadComplianceAuditExport('export-1', 'token');
    assert.ok(download.blob instanceof Blob);
    await client.createComplianceLegalHold({ resourceId: 'project-1', resourceType: 'project' }, 'token');
    await client.releaseComplianceLegalHold('hold-1', { expectedVersion: 2, reason: 'Released by counsel.' }, 'token');
    await client.createComplianceControlAttestation({ controlKey: 'legal_hold' }, 'token');
    await client.createPrivacyErasureRequest({ subjectUserId: 'user-2' }, 'token');
    await client.executePrivacyErasureRequest('request-1', { expectedVersion: 1 }, 'token');
    await client.getProjectTicketConfig('project-1', 'token');
    await client.saveTicketConfig('releases', { entries: [], expectedRevision: 'abc' }, 'token');
  } finally { globalThis.fetch = previousFetch; }
  assert.deepEqual(calls.map(({ method, url }) => [method, new URL(url).pathname]), [
    ['GET', '/api/compliance'],
    ['PUT', '/api/compliance/policy'],
    ['POST', '/api/compliance/audit-exports'],
    ['GET', '/api/compliance/audit-exports/export-1/content'],
    ['POST', '/api/compliance/legal-holds'],
    ['POST', '/api/compliance/legal-holds/hold-1/release'],
    ['POST', '/api/compliance/control-attestations'],
    ['POST', '/api/compliance/privacy-erasure-requests'],
    ['POST', '/api/compliance/privacy-erasure-requests/request-1/execute'],
    ['GET', '/api/projects/project-1/ticket-config'],
    ['PUT', '/api/tenants/ticket-config/releases'],
  ]);
  assert.deepEqual(calls[5].body, { expectedVersion: 2, reason: 'Released by counsel.' });
  assert.deepEqual(calls[8].body, { expectedVersion: 1 });
  assert.deepEqual(calls[10].body, { entries: [], expectedRevision: 'abc' });
});
