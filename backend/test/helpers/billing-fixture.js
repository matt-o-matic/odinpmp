// An in-memory Odin for the invoice-gen connection tests: a workspace with the Consulting module,
// a project with stories and tasks in two epics, people with and without billing rights, resource
// profiles and time entries, and helpers that act as the invoice-gen OAuth application.
import assert from 'node:assert/strict';

import request from 'supertest';

import { createApp } from '../../src/app.js';
import { createTokenService } from '../../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createInMemoryBillingRepository } from '../../src/modules/billing/billing.repository.js';
import { createInMemoryMetricsRepository } from '../../src/modules/metrics/metrics.repository.js';
import { createInMemoryProjectsRepository } from '../../src/modules/projects/projects.repository.js';
import { createInMemoryRankingRepository } from '../../src/modules/ranking/ranking.repository.js';
import { createInMemoryResourceFinanceRepository } from '../../src/modules/resource-finance/resource-finance.repository.js';
import { createInMemorySessionsRepository } from '../../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkspaceModulesRepository } from '../../src/modules/workspace-modules/workspace-modules.repository.js';

export const TENANT = 'tenant-northwind';
export const PROJECT = 'project-sow';
export const OTHER_PROJECT = 'project-internal';

export const users = [
  { authMethod: 'basic', email: 'grace@northwind.example', id: 'grace', memberships: [{ role: 'admin', tenantId: TENANT }], name: 'Grace Admin', password: 'Secret123!' },
  { authMethod: 'basic', email: 'mia@northwind.example', id: 'mia', memberships: [{ role: 'manager', tenantId: TENANT }], name: 'Mia Manager', password: 'Secret123!' },
  // Project manager on the SOW project only.
  { authMethod: 'basic', email: 'pat@northwind.example', id: 'pat', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Pat Doe', password: 'Secret123!' },
  // A member, and a contributor who edits the plan but has no billing rights.
  { authMethod: 'basic', email: 'carol@northwind.example', id: 'carol', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Carol Member', password: 'Secret123!' },
  { authMethod: 'basic', email: 'dan@northwind.example', id: 'dan', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Dan Contributor', password: 'Secret123!' },
  { authMethod: 'basic', email: 'oscar@other.example', id: 'oscar', memberships: [{ role: 'admin', tenantId: 'tenant-other' }], name: 'Oscar Outsider', password: 'Secret123!' },
];

const story = (id, name, tasks = []) => ({ description: '', id, name, status: 'Not Started', tasks: tasks.map(([taskId, taskName]) => ({ description: '', id: taskId, name: taskName, status: 'Not Started' })) });

export const projectSeed = {
  projectMemberships: {
    [PROJECT]: [{ id: 'pat', role: 'manager' }, { id: 'carol', role: 'user' }, { id: 'dan', role: 'contributor' }],
    [OTHER_PROJECT]: [{ id: 'pat', role: 'manager' }],
  },
  projects: [
    {
      description: 'Initech phase 2', endDate: null, id: PROJECT, name: 'Initech delivery', startDate: null, status: 'In Progress', tenantId: TENANT, updatedAt: '2026-11-01T00:00:00.000Z',
      epics: [
        { description: '', id: 'epic-a', name: 'Discovery', status: 'Not Started', stories: [story('story-a1', 'Discovery workshop', [['task-a1a', 'Prep deck'], ['task-a1b', 'Run workshop']]), story('story-a2', 'Interviews')] },
        { description: '', id: 'epic-b', name: 'Build', status: 'Not Started', stories: [story('story-b1', 'Data model', [['task-b1a', 'Schema']]), story('story-b2', 'Unmapped work')] },
      ],
    },
    { description: '', endDate: null, epics: [], id: OTHER_PROJECT, name: 'Internal', startDate: null, status: 'In Progress', tenantId: TENANT, updatedAt: '2026-11-01T00:00:00.000Z' },
  ],
};

export const AGREEMENT = {
  id: 41, title: 'Initech phase 2', status: 'executed', rateCents: 15000, url: 'https://invoices.example/agreements/41', executedAt: '2026-11-02T15:00:00Z',
  milestones: [{ id: 101, name: 'Discovery', shortLabel: 'Disc', hours: 40 }, { id: 102, name: 'Build', shortLabel: 'Build', hours: 80 }],
};

export function linkBody(overrides = {}) {
  return { customer: { id: 12, name: 'Initech' }, lineOfBusiness: { id: 3, name: '' }, agreement: AGREEMENT, sourceUpdatedAt: '2026-11-02T15:00:01Z', ...overrides };
}

export async function billingFixture({ consulting = true } = {}) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['northwind.example'], id: TENANT, name: 'Northwind' }, { domains: ['other.example'], id: 'tenant-other', name: 'Other' }],
    users,
  });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: structuredClone(projectSeed) });
  const resourceFinanceRepository = createInMemoryResourceFinanceRepository();
  const billingRepository = createInMemoryBillingRepository({ recordChanges: (entries) => projectRepository.recordProjectChanges(entries), resourceFinanceRepository });
  const workspaceModulesRepository = createInMemoryWorkspaceModulesRepository({ seed: consulting ? [TENANT, 'tenant-other'].map((tenantId) => ({ enabled: true, moduleKey: 'consulting', tenantId })) : [] });
  const tokenService = createTokenService({ issuer: 'test', secret: 'billing-test-secret-that-is-long-enough' });
  const sessionsRepository = createInMemorySessionsRepository();
  const tokens = new Map();
  for (const user of users) {
    const token = tokenService.signSessionToken({ ...user, tenantId: user.memberships[0].tenantId });
    const decoded = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({ expiryDate: new Date(decoded.exp * 1000), token, userId: user.id });
    tokens.set(user.id, token);
  }
  const app = createApp({
    agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, authRepository, billingRepository, domainEventSweepIntervalMs: 0,
    frontendAppUrl: 'https://odin.example/app', invoiceGenBaseUrl: 'https://invoices.example',
    metricsRepository: createInMemoryMetricsRepository(), projectRepository, rankingRepository: createInMemoryRankingRepository({ authRepository, projectRepository }),
    resourceFinanceRepository, sessionsRepository, tokenService, workspaceModulesRepository,
  });
  const as = (id) => `Bearer ${tokens.get(id)}`;
  const api = {
    delete: (id, path, body = {}) => request(app).delete(path).set('Authorization', as(id)).send(body),
    get: (id, path) => request(app).get(path).set('Authorization', as(id)),
    patch: (id, path, body = {}) => request(app).patch(path).set('Authorization', as(id)).send(body),
    post: (id, path, body = {}) => request(app).post(path).set('Authorization', as(id)).send(body),
    put: (id, path, body = {}) => request(app).put(path).set('Authorization', as(id)).send(body),
  };

  /** Registers an OAuth application as a workspace admin, and returns a client for its token. */
  async function application({ name = 'invoice-gen', projectIds = [PROJECT], scopes = ['projects.read', 'billing.read', 'billing.write'] } = {}) {
    const created = await api.post('grace', '/api/integrations/oauth-applications', { name, projectIds, scopes });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const basic = Buffer.from(`${created.body.value.clientId}:${created.body.clientSecret}`).toString('base64');
    const exchanged = await request(app).post('/api/v1/oauth/token').set('Authorization', `Basic ${basic}`).type('form').send({ grant_type: 'client_credentials', scope: scopes.join(' ') });
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    const bearer = `Bearer ${exchanged.body.access_token}`;
    const send = (method, path, body, key) => {
      let call = request(app)[method](`/api/v1${path}`).set('Authorization', bearer);
      if (key) call = call.set('Idempotency-Key', key);
      return body === undefined ? call : call.send(body);
    };
    return {
      application: created.body.value, basic, clientSecret: created.body.clientSecret, token: exchanged.body.access_token,
      delete: (path, key) => send('delete', path, undefined, key),
      get: (path) => send('get', path),
      post: (path, body, key) => send('post', path, body, key),
      put: (path, body, key) => send('put', path, body, key),
    };
  }

  const resources = {
    carol: await resourceFinanceRepository.createResource({ input: { billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', email: null, location: '', name: 'Carol Member', poolId: null, roles: [], skills: [], status: 'active', userId: 'carol' }, tenantId: TENANT }),
    pat: await resourceFinanceRepository.createResource({ input: { billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', email: null, location: '', name: 'Pat Doe', poolId: null, roles: [], skills: [], status: 'active', userId: 'pat' }, tenantId: TENANT }),
  };

  /** A time entry, approved and billable unless told otherwise. */
  async function entry({ billable = true, hours = 1, note = 'Logged', projectId = PROJECT, resource = 'carol', status = 'approved', workDate = '2026-11-03', workItemId = null } = {}) {
    return resourceFinanceRepository.createTimeEntry({ input: { billable, hours, note, periodId: null, projectId, resourceId: resources[resource].id, status, workDate, workItemId }, tenantId: TENANT });
  }

  async function changes(projectId = PROJECT) {
    const { entries } = await projectRepository.listProjectChanges({ afterSeq: 0, projectId, settleMs: 0, tenantId: TENANT });
    return entries;
  }

  return { api, app, application, billingRepository, changes, entry, projectRepository, resourceFinanceRepository, resources, tokens, workspaceModulesRepository };
}
