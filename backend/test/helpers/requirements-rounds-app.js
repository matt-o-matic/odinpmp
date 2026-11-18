import request from 'supertest';

import { createApp } from '../../src/app.js';
import { createTokenService } from '../../src/lib/auth/token-service.js';
import { createLiveEventBus, LIVE_EVENT_CHANNELS } from '../../src/lib/events/live-event-bus.js';
import { createInMemoryAssistantRepository } from '../../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createInMemoryMailRepository } from '../../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../../src/modules/projects/projects.repository.js';
import { createInMemoryObjectStorage } from '../../src/modules/requirements/packages/package-storage.js';
import { createInMemoryPackagesRepository } from '../../src/modules/requirements/packages/packages.repository.js';
import { createInMemoryRequirementsRepository } from '../../src/modules/requirements/requirements.repository.js';
import { createRequirementsPublicRateLimiter } from '../../src/modules/requirements/requirements-rate-limit.js';
import { createInMemoryRoundsRepository } from '../../src/modules/requirements/rounds/rounds.repository.js';
import { createInMemorySessionsRepository } from '../../src/modules/sessions/sessions.repository.js';
import { buildZip, imageScreen, makePng, PROTOTYPE_HTML, prototypeScreen } from './review-packages.js';

// Harness for the review rounds tests (U4): in-memory repositories shared the way app.js
// shares them, an in-memory mail queue, package storage, a review origin URL for grants, a
// controllable clock, and an Odin summary stub that cites the first sources it is given.

export const TENANT_ID = 'tenant-acme';
export const PROJECT_ID = 'project-rounds';
export const OTHER_PROJECT_ID = 'project-other';
export const REVIEW_PUBLIC_URL = 'http://127.0.0.1:3902';
export const GRANT_SECRET = 'test-review-grant-secret-0123456789abcdef';

export const ROLE_USERS = Object.freeze({
  member: { id: 'user-member', name: 'Mona Member', projectRole: 'member', tenantRole: 'user' },
  outsider: { id: 'user-outsider', name: 'Otto Outsider', projectRole: null, tenantRole: 'user' },
  projectManager: { id: 'user-pmanager', name: 'Pia Manager', projectRole: 'manager', tenantRole: 'user' },
  reviewer: { id: 'user-reviewer', name: 'Ravi Reviewer', projectRole: 'member', tenantRole: 'user' },
  tenantAdmin: { id: 'user-tadmin', name: 'Tess Admin', projectRole: null, tenantRole: 'admin' },
  viewer: { id: 'user-viewer', name: 'Vic Viewer', projectRole: 'viewer', tenantRole: 'user' },
});

/** Summary stub: cites the first two sources, names their authors, proposes one preference. */
export function createStubSummaryAi() {
  const calls = [];
  return {
    calls,
    provider: 'stub',
    async summarize({ modelInput, scopeId, scopeType }) {
      calls.push({ modelInput, scopeId, scopeType });
      const refs = modelInput.citableSourceRefs;
      const authors = refs.slice(0, 2).map((ref) => modelInput.untrustedContent.sources.find((source) => source.ref === ref)?.author).filter(Boolean);
      return {
        model: 'stub-model',
        output: {
          aligned: [{ sources: refs.slice(0, 2), statement: `People agree on ${scopeType} ${refs.length} sources.`, supporters: [...new Set(authors)] }],
          divergent: [],
          feedbackThemes: [],
          insufficientInput: false,
          outstanding: [],
          proposedAnswer: '',
          proposedAnswerSources: [],
          proposedAnswerStatus: 'none',
          proposedPreferences: [{ dimension: 'hierarchy', sources: refs.slice(0, 1), stance: 'keep', statement: 'Keep the booking button first.' }],
          underExplored: [],
        },
      };
    },
  };
}

/**
 * A package for rounds: directions, three screens (two images and a prototype), four
 * questions, and a custom feedback dimension. `homeColor` changes the home image and `css`
 * the prototype, for carry-forward tests; `omit` drops screens.
 */
export function roundPackageFiles({
  css = 'body { color: #1d2a24; }',
  homeColor = [31, 77, 58],
  omit = [],
  priceTopicId = null,
  title = 'Client booking',
  track = 'experience',
} = {}) {
  const screens = [
    imageScreen('home', { directionId: 'action-first' }),
    prototypeScreen('booking', { directionId: 'schedule-first' }),
    imageScreen('gone'),
  ].filter((screen) => !omit.includes(screen.id));
  const sections = [
    { body: 'What we heard in round 1.', id: 'context', type: 'context' },
    {
      id: 'directions',
      items: [
        { id: 'action-first', summary: 'One booking button.', title: 'Action first' },
        { id: 'schedule-first', summary: 'Open on a calendar.', title: 'Schedule first' },
      ],
      type: 'directions',
    },
    { id: 'screens', items: screens, type: 'screens' },
    {
      id: 'questions',
      items: [
        {
          id: 'price-placement',
          kind: 'single',
          options: [{ id: 'range-on-home', label: 'A range on the home screen' }, { id: 'after-time', label: 'Only after a time is picked' }],
          prompt: 'Where should the price first appear?',
          ...(priceTopicId ? { topicId: priceTopicId } : {}),
        },
        { id: 'before-tax', kind: 'multi', options: [{ id: 'web', label: 'On the web' }, { id: 'email', label: 'In email' }, { id: 'sms', label: 'In texts' }], prompt: 'Where should prices say "before tax"?' },
        { help: 'Hours or days.', id: 'notice', kind: 'text', prompt: 'How much notice do clients need to reschedule?' },
        { id: 'speed', kind: 'scale', prompt: 'How quick did booking feel?', scale: { max: 5, maxLabel: 'Very quick', min: 1, minLabel: 'Slow' } },
      ],
      type: 'questions',
    },
  ];
  const files = {
    'manifest.json': JSON.stringify({
      feedbackDimensions: track === 'experience'
        ? ['type', 'density', 'hierarchy', { id: 'tone-of-voice', label: 'Tone of voice' }]
        : ['feasibility', 'risk'],
      schema: 'odin.review-package/v1',
      sections,
      summary: 'Round 2 tries a price range on the home screen.',
      title,
      track,
    }),
    'prototypes/booking/app.js': 'window.OdinReview && window.OdinReview.setState("start");',
    'prototypes/booking/index.html': PROTOTYPE_HTML,
    'prototypes/booking/styles.css': css,
    'screens/gone.png': makePng(320, 200, [200, 10, 10]),
    'screens/home.png': makePng(320, 200, homeColor),
  };
  if (omit.includes('gone')) delete files['screens/gone.png'];
  if (omit.includes('home')) delete files['screens/home.png'];
  if (omit.includes('booking')) {
    for (const path of Object.keys(files)) if (path.startsWith('prototypes/')) delete files[path];
  }
  return files;
}

export async function createRoundsTestApp({
  mailRepository = undefined,
  rateLimiter = undefined,
  reviewPublicUrl = REVIEW_PUBLIC_URL,
  reviewRateLimiter = undefined,
  summaryAi = undefined,
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
  const packagesRepository = createInMemoryPackagesRepository({ requirementsRepository });
  const roundsRepository = createInMemoryRoundsRepository({ requirementsRepository });
  const mail = mailRepository ?? createInMemoryMailRepository();
  const storage = createInMemoryObjectStorage();
  const liveEventBus = createLiveEventBus();
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const clock = { offsetMs: 0 };
  const stub = summaryAi === undefined ? createStubSummaryAi() : summaryAi;
  const generous = () => createRequirementsPublicRateLimiter({ ip: { capacity: 10_000, refillPerSecond: 1_000 }, link: { capacity: 10_000, refillPerSecond: 1_000 } });

  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0,
    agentMonitorSweepIntervalMs: 0,
    assistantRepository,
    assistantStaleRunSweepIntervalMs: 0,
    authRepository,
    backendPublicUrl: 'http://localhost:3001',
    domainEventSweepIntervalMs: 0,
    frontendAppUrl: 'http://localhost:5173/app',
    liveEventBus,
    mailRepository: mail,
    packagesRepository,
    projectRepository,
    reportSubscriptionSweepIntervalMs: 0,
    reportingWarehouseSweepIntervalMs: 0,
    requirementsAiService: stub,
    requirementsClock: () => new Date(Date.now() + clock.offsetMs),
    requirementsRateLimiter: rateLimiter ?? generous(),
    requirementsRepository,
    requirementsReviewRateLimiter: reviewRateLimiter ?? generous(),
    reviewGrantSecret: GRANT_SECRET,
    reviewPackageStorage: storage,
    reviewPublicUrl,
    roundsRepository,
    sessionsRepository,
    tokenService,
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
  const as = (role) => {
    const auth = (pending) => pending.set('Authorization', `Bearer ${tokens[role]}`);
    return {
      del: (path) => auth(request(app).delete(`${base}${path}`)),
      get: (path) => auth(request(app).get(`${base}${path}`)),
      patch: (path, body = {}) => auth(request(app).patch(`${base}${path}`)).send(body),
      post: (path, body = {}) => auth(request(app).post(`${base}${path}`)).send(body),
      put: (path, body = {}) => auth(request(app).put(`${base}${path}`)).send(body),
      raw: (method, path, bytes, contentType) => auth(request(app)[method](`${base}${path}`)).set('Content-Type', contentType).send(bytes),
    };
  };
  /** Review API for a team member on one round. */
  const team = (role, roundId) => {
    const client = as(role);
    const prefix = `/rounds/${roundId}/review`;
    return {
      del: (path = '') => client.del(`${prefix}${path}`),
      get: (path = '') => client.get(`${prefix}${path}`),
      patch: (path, body) => client.patch(`${prefix}${path}`, body),
      post: (path, body) => client.post(`${prefix}${path}`, body),
      put: (path, body) => client.put(`${prefix}${path}`, body),
      raw: (path, bytes, contentType = 'image/png') => client.raw('post', `${prefix}${path}`, bytes, contentType),
    };
  };
  /** Review API for a stakeholder link on one round. */
  const portal = (token, roundId = null) => {
    const prefix = `/api/public/requirements/${token}${roundId ? `/rounds/${roundId}` : ''}`;
    return {
      del: (path = '') => request(app).delete(`${prefix}${path}`),
      get: (path = '') => request(app).get(`${prefix}${path}`),
      patch: (path, body) => request(app).patch(`${prefix}${path}`).send(body),
      post: (path, body) => request(app).post(`${prefix}${path}`).send(body),
      put: (path, body) => request(app).put(`${prefix}${path}`).send(body),
      raw: (path, bytes, contentType = 'image/png') => request(app).post(`${prefix}${path}`).set('Content-Type', contentType).send(bytes),
    };
  };

  async function seedStakeholder({ email = 'jamie@client.example', name = 'Jamie Ortiz', roleTitle = 'Operations lead' } = {}) {
    return assistantRepository.createProjectStakeholder({ projectId: PROJECT_ID, tenantId: TENANT_ID, value: { email, name, roleTitle } });
  }

  async function createTopic(prompt, { role = 'member', track = 'experience' } = {}) {
    const response = await as(role).post(`/tracks/${track}/topics`, { prompt });
    if (response.status !== 201) throw new Error(`Topic create failed: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body.topic;
  }

  async function uploadPackage(files, { role = 'member', track = 'experience' } = {}) {
    const response = await as(role)
      .raw('post', `/packages/upload?track=${track}`, await buildZip(files), 'application/zip');
    if (response.status !== 201) throw new Error(`Upload failed: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body.package;
  }

  async function publish(body, { role = 'member' } = {}) {
    const response = await as(role).post('/rounds', body);
    if (response.status !== 201) throw new Error(`Publish failed: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  }

  /** Portal tokens from queued invitation emails, newest last: [{ token, roundId, recipient }]. */
  function portalLinksInMail() {
    return mail.state.queue.flatMap((row) => {
      const match = /\/requirements\/([A-Za-z0-9_-]{20,})\/rounds\/([0-9a-f-]{36})/.exec(row.body);
      return match ? [{ recipient: row.recipientEmail, roundId: match[2], targetId: row.targetId, token: match[1] }] : [];
    });
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
    clock,
    createTopic,
    liveEventBus,
    mail,
    packagesRepository,
    portal,
    portalLinksInMail,
    projectChannel: LIVE_EVENT_CHANNELS.project(PROJECT_ID),
    projectRepository,
    publish,
    recordEvents,
    requirementsRepository,
    roundsRepository,
    seedStakeholder,
    storage,
    summaries: app.locals.requirementsSummaries,
    summaryAi: stub,
    team,
    tokens,
    uploadPackage,
  };
}
