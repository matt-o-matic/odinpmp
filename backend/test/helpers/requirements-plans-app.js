import request from 'supertest';

import { draftPlanWithLocalFixture, proposeWorkWithLocalFixture } from '../../src/modules/requirements/plans/plan-fixture.js';
import { listen } from './agent-test-utils.js';
import { createRequirementsTestApp, PROJECT_ID, TENANT_ID } from './requirements-test-app.js';

export { PROJECT_ID, ROLE_USERS, TENANT_ID } from './requirements-test-app.js';

/**
 * A plan AI stub. `draft` and `work` are outputs, functions of the call, or Errors to throw;
 * by default both follow the local fixture so tests get deterministic, valid output.
 */
export function stubPlanAi({ draft = null, work = null } = {}) {
  const ai = {
    calls: { draftPlan: [], proposeWork: [] },
    draft,
    provider: 'stub-provider',
    work,
    async draftPlan(args) {
      ai.calls.draftPlan.push(args);
      const value = typeof ai.draft === 'function' ? ai.draft(args) : ai.draft;
      if (value instanceof Error) throw value;
      return { model: 'stub-model', output: value ?? draftPlanWithLocalFixture(args.modelInput) };
    },
    async proposeWork(args) {
      ai.calls.proposeWork.push(args);
      const value = typeof ai.work === 'function' ? ai.work(args) : ai.work;
      if (value instanceof Error) throw value;
      return { model: 'stub-model', output: value ?? proposeWorkWithLocalFixture(args.modelInput) };
    },
  };
  return ai;
}

export const STATEMENTS = Object.freeze({
  architecture: 'Bookings are stored in the existing scheduling service.',
  deferred: 'SMS reminders wait until phase 2. Email only in phase 1.',
  first: 'Booking is the first task on the home screen.',
  oldPrice: 'Show the price only after a time is picked.',
  preference: 'One primary "Book a visit" action on the home screen.',
  price: 'Show a price range before tax on home; confirm the exact price with tax before payment.',
});

export async function createPlansTestApp({ requirementsAiService = stubPlanAi(), ...options } = {}) {
  const harness = await createRequirementsTestApp({ requirementsAiService, ...options });
  // Applying staged proposals calls the app's REST routes over loopback, as in production.
  await listen(harness.app);

  const assistant = (role) => ({
    get: (path) => request(harness.app).get(`/api/assistant${path}`).set('Authorization', `Bearer ${harness.tokens[role]}`),
    patch: (path, body = {}) => request(harness.app).patch(`/api/assistant${path}`).set('Authorization', `Bearer ${harness.tokens[role]}`).send(body),
    post: (path, body = {}) => request(harness.app).post(`/api/assistant${path}`).set('Authorization', `Bearer ${harness.tokens[role]}`).send(body),
  });

  function tick() {
    harness.clock.offsetMs += 1000;
  }

  async function expectStatus(response, status, label) {
    if (response.status !== status) {
      throw new Error(`${label} failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return response.body;
  }

  async function decide(topicId, { outcome = 'agreed', statement, supersedesId = '' }) {
    tick();
    const body = await expectStatus(
      await harness.as('projectManager').post('/decisions', { outcome, statement, supersedesId, topicId }),
      201,
      'Decision',
    );
    return body.decision;
  }

  /**
   * Experience decisions, labelled by decision time: D-01 agreed, D-02 decided then
   * superseded by D-04, D-03 deferred, D-05 an accepted preference. One Architecture
   * decision proves tracks stay apart.
   */
  async function seedDecisions() {
    const home = await harness.createTopic({ prompt: 'What is the first thing a client does on the home screen?' });
    const price = await harness.createTopic({ prompt: 'When does a client see the price?' });
    const reminders = await harness.createTopic({ prompt: 'Do we send SMS reminders?' });
    const storage = await harness.createTopic({ prompt: 'Where are bookings stored?' }, { track: 'architecture' });

    const first = await decide(home.id, { statement: STATEMENTS.first });
    const oldPrice = await decide(price.id, { outcome: 'decided', statement: STATEMENTS.oldPrice });
    const deferred = await decide(reminders.id, { outcome: 'deferred', statement: STATEMENTS.deferred });
    const priceDecision = await decide(price.id, { outcome: 'agreed', statement: STATEMENTS.price, supersedesId: oldPrice.id });
    tick();
    const preference = (await expectStatus(await harness.as('projectManager').post('/preferences/accept', {
      dimension: 'hierarchy',
      stance: 'keep',
      statement: STATEMENTS.preference,
      track: 'experience',
    }), 201, 'Preference')).decision;
    const architecture = await decide(storage.id, { statement: STATEMENTS.architecture });

    return {
      decisions: { architecture, deferred, first, oldPrice, preference, price: priceDecision },
      topics: { home, price, reminders, storage },
    };
  }

  async function draft({ role = 'editor', track = 'experience' } = {}) {
    return expectStatus(await harness.as(role).post(`/plans/${track}/draft`), 201, 'Draft plan');
  }

  async function approve(plan, { role = 'projectManager' } = {}) {
    return expectStatus(await harness.as(role).post(`/plans/${plan.id}/approve`, { revision: plan.revision }), 200, 'Approve plan');
  }

  async function proposeWork(plan, { role = 'editor' } = {}) {
    return expectStatus(await harness.as(role).post(`/plans/${plan.id}/propose-work`), 201, 'Propose work');
  }

  async function projectEpics() {
    const project = await harness.projectRepository.getProjectDetail({ projectId: PROJECT_ID, tenantId: TENANT_ID });
    return project?.epics ?? [];
  }

  return { ...harness, ai: requirementsAiService, approve, assistant, decide, draft, projectEpics, proposeWork, seedDecisions, tick };
}

/** Every key anywhere in a JSON value. */
export function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

/** No AI-drafted flag, provider, model, or audit record anywhere in a response. */
export function assertNoAiAttribution(assert, body) {
  const keys = [...collectKeys(body)];
  const flagged = keys.filter((key) => /^(ai|audit|provider|model|drafted|generated|origin|source$)/i.test(key) || /drafted|aiGenerated|byAi/i.test(key));
  assert.deepEqual(flagged, [], `unexpected attribution keys: ${flagged.join(', ')}`);
  const text = JSON.stringify(body);
  assert.equal(/stub-provider|stub-model|local-fixture/.test(text), false, 'provider and model never leave the server');
}
