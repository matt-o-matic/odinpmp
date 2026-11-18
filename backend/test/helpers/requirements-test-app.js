import request from 'supertest';

import { createApp } from '../../src/app.js';
import { createTokenService } from '../../src/lib/auth/token-service.js';
import { createLiveEventBus } from '../../src/lib/events/live-event-bus.js';
import { createInMemoryAssistantRepository } from '../../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../../src/modules/projects/projects.repository.js';
import { createInMemoryRequirementsRepository } from '../../src/modules/requirements/requirements.repository.js';
import { createRequirementsPublicRateLimiter } from '../../src/modules/requirements/requirements-rate-limit.js';
import { createInMemorySessionsRepository } from '../../src/modules/sessions/sessions.repository.js';

export const TENANT_ID = 'tenant-acme';
export const PROJECT_ID = 'project-req';
export const OTHER_PROJECT_ID = 'project-other';

// Every role the requirements permission matrix distinguishes.
export const ROLE_USERS = Object.freeze({
  contributor: { id: 'user-contributor', name: 'Cora Contributor', projectRole: 'contributor', tenantRole: 'user' },
  editor: { id: 'user-editor', name: 'Eddie Editor', projectRole: 'editor', tenantRole: 'user' },
  member: { id: 'user-member', name: 'Mona Member', projectRole: 'member', tenantRole: 'user' },
  outsider: { id: 'user-outsider', name: 'Otto Outsider', projectRole: null, tenantRole: 'user' },
  projectAdmin: { id: 'user-padmin', name: 'Pat Admin', projectRole: 'admin', tenantRole: 'user' },
  projectManager: { id: 'user-pmanager', name: 'Pia Manager', projectRole: 'manager', tenantRole: 'user' },
  tenantAdmin: { id: 'user-tadmin', name: 'Tess Admin', projectRole: null, tenantRole: 'admin' },
  tenantManager: { id: 'user-tmanager', name: 'Theo Manager', projectRole: null, tenantRole: 'manager' },
  user: { id: 'user-plain', name: 'Uma User', projectRole: 'user', tenantRole: 'user' },
  viewer: { id: 'user-viewer', name: 'Vic Viewer', projectRole: 'viewer', tenantRole: 'user' },
});

export const BRIEF = Object.freeze({
  constraints: ['Bookings must work on phones without an app install'],
  name: 'Client booking',
  objective: 'Let clients book a visit without calling the office.',
  requirements: [
    'Clients can book a visit online',
    'Clients can reschedule or cancel a visit',
  ],
});

export const INBOUND_MAIL_SECRET = 'test-inbound-secret';
export const MAIL_REPLY_DOMAIN = 'reply.odin.test';

export async function createRequirementsTestApp({
  assistantAiService = undefined,
  clockOffsetMs = 0,
  mailRepository = undefined,
  rateLimiter = undefined,
  requirementsAiService = undefined,
  trustProxy = undefined,
} = {}) {
  const users = Object.values(ROLE_USERS);
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: TENANT_ID, name: 'Acme' }],
    users: users.map((entry) => ({
      authMethod: 'basic',
      email: `${entry.id}@acme.com`,
      id: entry.id,
      memberships: [{ role: entry.tenantRole, tenantId: TENANT_ID }],
      name: entry.name,
      password: 'Secret123!',
      preferences: { twoFactorEnabled: false },
    })),
  });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: {
        [OTHER_PROJECT_ID]: [{ id: ROLE_USERS.member.id, role: 'member' }],
        [PROJECT_ID]: users.filter((entry) => entry.projectRole).map((entry) => ({ id: entry.id, role: entry.projectRole })),
      },
      projects: [
        { epics: [], id: PROJECT_ID, name: 'Client booking', role: 'admin', status: 'In Progress', tenantId: TENANT_ID },
        { epics: [], id: OTHER_PROJECT_ID, name: 'Other project', role: 'admin', status: 'In Progress', tenantId: TENANT_ID },
      ],
    },
  });
  const assistantRepository = createInMemoryAssistantRepository();
  const requirementsRepository = createInMemoryRequirementsRepository({ assistantRepository });
  const liveEventBus = createLiveEventBus();
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const clock = { offsetMs: clockOffsetMs };

  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0,
    agentMonitorSweepIntervalMs: 0,
    assistantAiService,
    assistantRepository,
    assistantStaleRunSweepIntervalMs: 0,
    authRepository,
    domainEventSweepIntervalMs: 0,
    frontendAppUrl: 'http://localhost:5173/app',
    inboundMailWebhookSecret: INBOUND_MAIL_SECRET,
    liveEventBus,
    mailReplyDomain: MAIL_REPLY_DOMAIN,
    mailRepository,
    projectRepository,
    reportSubscriptionSweepIntervalMs: 0,
    reportingWarehouseSweepIntervalMs: 0,
    requirementsAiService,
    requirementsClock: () => new Date(Date.now() + clock.offsetMs),
    requirementsRateLimiter: rateLimiter ?? createRequirementsPublicRateLimiter({
      ip: { capacity: 10_000, refillPerSecond: 1_000 },
      link: { capacity: 10_000, refillPerSecond: 1_000 },
    }),
    requirementsRepository,
    sessionsRepository,
    tokenService,
    trustProxy,
    webhookSweepIntervalMs: 0,
    workflowAutomationSweepIntervalMs: 0,
  });

  const tokens = {};
  for (const [key, entry] of Object.entries(ROLE_USERS)) {
    const token = tokenService.signSessionToken({
      email: `${entry.id}@acme.com`,
      id: entry.id,
      name: entry.name,
      preferences: { twoFactorEnabled: false },
      role: entry.tenantRole,
      tenantId: TENANT_ID,
    });
    const decoded = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({
      expiryDate: new Date(decoded.exp * 1000),
      ipAddr: '127.0.0.1',
      locationName: 'Localhost',
      token,
      userAgent: 'test-agent',
      userId: entry.id,
    });
    tokens[key] = token;
  }

  const base = `/api/projects/${PROJECT_ID}/requirements`;
  const as = (role) => ({
    del: (path) => request(app).delete(`${base}${path}`).set('Authorization', `Bearer ${tokens[role]}`),
    get: (path) => request(app).get(`${base}${path}`).set('Authorization', `Bearer ${tokens[role]}`),
    patch: (path, body = {}) => request(app).patch(`${base}${path}`).set('Authorization', `Bearer ${tokens[role]}`).send(body),
    post: (path, body = {}) => request(app).post(`${base}${path}`).set('Authorization', `Bearer ${tokens[role]}`).send(body),
  });
  const portal = (token) => ({
    del: (path) => request(app).delete(`/api/public/requirements/${token}${path}`),
    get: (path = '') => request(app).get(`/api/public/requirements/${token}${path}`),
    patch: (path, body = {}) => request(app).patch(`/api/public/requirements/${token}${path}`).send(body),
    post: (path, body = {}) => request(app).post(`/api/public/requirements/${token}${path}`).send(body),
  });

  async function seedBrief(brief = BRIEF) {
    await assistantRepository.saveProjectAssistantState({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      value: { brief: { ...brief, committedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() },
    });
  }

  async function seedStakeholder({ email = 'jamie@client.example', name = 'Jamie Ortiz', roleTitle = 'Operations lead' } = {}) {
    return assistantRepository.createProjectStakeholder({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      value: { email, name, roleTitle },
    });
  }

  async function createTopic(body, { role = 'member', track = 'experience' } = {}) {
    const response = await as(role).post(`/tracks/${track}/topics`, body);
    if (response.status !== 201) {
      throw new Error(`Topic create failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body.topic;
  }

  async function createLink(stakeholderId, { role = 'projectManager' } = {}) {
    const response = await as(role).post('/links', { stakeholderId });
    if (response.status !== 201) {
      throw new Error(`Link create failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body;
  }

  function recordEvents(channel) {
    const events = [];
    const unsubscribe = liveEventBus.subscribe(channel, (event) => events.push(event));
    return { events, unsubscribe };
  }

  return {
    app,
    as,
    assistantRepository,
    authRepository,
    clock,
    createLink,
    createTopic,
    liveEventBus,
    portal,
    projectRepository,
    recordEvents,
    requirementsRepository,
    seedBrief,
    seedStakeholder,
    tokens,
  };
}
