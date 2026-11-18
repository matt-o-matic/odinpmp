import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { loadEnv } from '../src/config/env.js';
import { createDefaultAiConfig } from '../src/lib/ai/ai-capability-config.js';
import { HttpError } from '../src/lib/errors/http-error.js';
import { createRequirementsAiService } from '../src/modules/requirements/ai/requirements-ai-service.js';
import { requirementsDraftQuestionsInstructions } from '../src/modules/requirements/ai/requirements-draft-questions.js';
import { extractBriefLines, isDuplicatePrompt } from '../src/modules/requirements/requirements-topics.js';
import { BRIEF, createRequirementsTestApp, PROJECT_ID, ROLE_USERS, TENANT_ID } from './helpers/requirements-test-app.js';

function stubAi(output) {
  return {
    calls: [],
    provider: 'stub',
    async draftQuestions(input) {
      this.calls.push(input);
      return typeof output === 'function' ? output(input) : output;
    },
  };
}

const PRODUCTION_ENV = {
  CLAMAV_ENABLED: 'true',
  CLAMAV_SOCKET_PATH: '/var/run/clamav/clamd.ctl',
  CONNECTOR_CREDENTIAL_ENCRYPTION_KEY: 'c'.repeat(32),
  FRONTEND_APP_URL: 'https://app.example.com/app',
  JWT_SECRET: 'a'.repeat(32),
  NODE_ENV: 'production',
  OBJECT_STORAGE_BUCKET: 'odin-production',
  OBJECT_STORAGE_PROVIDER: 's3',
  OBJECT_STORAGE_REGION: 'us-east-1',
  WEBHOOK_SIGNING_MASTER_SECRET: 'b'.repeat(32),
};

test('brief lines cite zero-based list positions and named text fields', () => {
  const lines = extractBriefLines(BRIEF);
  assert.deepEqual(lines.map((line) => line.ref), [
    'brief:requirements:0',
    'brief:requirements:1',
    'brief:constraints:0',
    'brief:objective',
  ]);
  assert.equal(lines[1].label, 'Requirement 2');
  assert.deepEqual(extractBriefLines({}), []);
});

test('duplicate detection ignores case, punctuation, filler words, plurals, and typos but not shared framing', () => {
  assert.equal(isDuplicatePrompt('How do clients cancel a booking?', 'how do clients cancel a booking'), true);
  assert.equal(isDuplicatePrompt('How do clients cancel a booking?', 'How can a client cancel their booking?'), true);
  assert.equal(isDuplicatePrompt('How do clients cancel a booking?', 'How do clients cancle a booking?'), true);
  assert.equal(isDuplicatePrompt('Which payment provider do we integrate?', 'Which payment provider should we integrate with?'), true);
  assert.equal(isDuplicatePrompt('How do clients cancel a booking?', 'Which payment provider do we integrate?'), false);
  assert.equal(isDuplicatePrompt('Who approves refunds?', 'Who approves discounts?'), false);
  assert.equal(isDuplicatePrompt(
    'Which systems, data, and integrations does "Clients can book a visit online" depend on?',
    'Which systems, data, and integrations does "Clients can reschedule or cancel a visit" depend on?',
  ), false);
  assert.equal(isDuplicatePrompt('', 'anything'), false);
});

test('AC-01 drafting creates open, unassigned topics that cite the brief, skips duplicates, and is visible to stakeholders at once', async () => {
  const ai = stubAi({
    questions: [
      {
        prompt: 'Can clients reschedule online, and up to how long before the visit?',
        rationale: 'The brief does not say when changes stop being allowed.',
        recommendation: 'Allow online changes up to 24 hours before the visit.',
        settles: 'Reschedule cut-off',
        sourceRef: 'brief:requirements:1',
        suggestedOwnerRole: 'Operations lead',
      },
      {
        prompt: 'How do clients cancel a booking?',
        rationale: 'Duplicate of an existing topic.',
        recommendation: 'Cancel from the booking page.',
        settles: 'Cancellation',
        sourceRef: 'brief:requirements:1',
        suggestedOwnerRole: 'Operations lead',
      },
      {
        prompt: 'Which phone browsers must booking support?',
        rationale: 'The constraint names phones but not browsers.',
        recommendation: 'Support the current Safari and Chrome on phones.',
        settles: 'Supported browsers',
        sourceRef: 'brief:constraints:0',
        suggestedOwnerRole: 'Product owner',
      },
      {
        prompt: 'Which phone browsers must booking support?',
        rationale: 'Repeated in the same batch.',
        recommendation: 'Support the current Safari and Chrome on phones.',
        settles: 'Supported browsers',
        sourceRef: 'brief:constraints:0',
        suggestedOwnerRole: 'Product owner',
      },
      {
        prompt: 'What does the made-up line mean?',
        rationale: 'Cites a line that does not exist.',
        recommendation: 'Nothing.',
        settles: 'Nothing',
        sourceRef: 'brief:requirements:9',
        suggestedOwnerRole: 'Nobody',
      },
      {
        prompt: 'Do clients get a reminder before the visit?',
        rationale: 'Comes with no recommended default.',
        settles: 'Reminders',
        sourceRef: 'brief:requirements:0',
        suggestedOwnerRole: 'Operations lead',
      },
    ],
  });
  const harness = await createRequirementsTestApp({ requirementsAiService: ai });
  await harness.seedBrief();
  const stakeholder = await harness.seedStakeholder();
  const { token } = await harness.createLink(stakeholder.id);
  const existing = await harness.createTopic({ prompt: 'How do clients cancel a booking?' }, { track: 'architecture' });
  const events = harness.recordEvents(`project:${PROJECT_ID}`);

  const response = await harness.as('member').post('/tracks/experience/draft-questions');
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.provider, 'stub');
  assert.equal(response.body.created.length, 2);
  assert.deepEqual(response.body.skipped.map((entry) => entry.reason), ['duplicate', 'duplicate', 'unknown-source', 'no-recommendation']);
  assert.equal(response.body.skipped[0].duplicateOf, existing.id);

  const [call] = ai.calls;
  assert.equal(call.track, 'experience');
  assert.equal(call.tenantId, TENANT_ID);
  assert.equal(call.projectName, 'Client booking');
  assert.deepEqual(call.briefLines.map((line) => line.ref), ['brief:requirements:0', 'brief:requirements:1', 'brief:constraints:0', 'brief:objective']);
  assert.deepEqual(call.existingTopics.map((topic) => topic.prompt), ['How do clients cancel a booking?']);

  for (const topic of response.body.created) {
    assert.equal(topic.track, 'experience');
    assert.equal(topic.origin, 'brief-draft');
    assert.equal(topic.status, 'open');
    assert.equal(topic.state, 'open');
    assert.equal(topic.owner, null);
    assert.deepEqual(topic.assignments, []);
    assert.equal(topic.createdBy.ref, `user:${ROLE_USERS.member.id}`);
    assert.equal(topic.createdBy.name, ROLE_USERS.member.name);
    assert.equal(Object.keys(topic).some((key) => /^ai|drafted|generated/i.test(key)), false, 'no AI label');
  }
  const reschedule = response.body.created.find((topic) => topic.sourceRef === 'brief:requirements:1');
  assert.equal(reschedule.settles, 'Reschedule cut-off');
  assert.equal(reschedule.rationale, 'Recommended: Allow online changes up to 24 hours before the visit. The brief does not say when changes stop being allowed.');
  assert.equal(reschedule.suggestedOwnerRole, 'Operations lead');
  const record = harness.assistantRepository.state.projectClarifications.find((item) => item.id === reschedule.id);
  assert.equal(record.lifecycleState, 'committed');
  assert.equal(record.linkedSection, 'brief');
  assert.ok(events.events.some((event) => event.type === 'requirements.topics.invalidated' && event.reason === 'topics-drafted'));

  const register = await harness.as('viewer').get('/tracks/experience/topics');
  assert.equal(register.body.topics.length, 2);

  // Q-13a: stakeholders see drafted questions immediately, next to every other unassigned
  // open topic, and can comment, but not change status.
  const portal = await harness.portal(token).get();
  assert.deepEqual(
    new Set(portal.body.topics.open.map((topic) => topic.id)),
    new Set([existing.id, ...response.body.created.map((topic) => topic.id)]),
  );
  const comment = await harness.portal(token).post(`/topics/${reschedule.id}/comments`, { body: 'Up to 24 hours before.' });
  assert.equal(comment.status, 201);
  assert.equal((await harness.portal(token).patch(`/topics/${reschedule.id}`, { status: 'resolved' })).status, 404);
  assert.equal((await harness.as('viewer').get(`/topics/${reschedule.id}`)).body.topic.status, 'open');

  // Running it again with the same output creates nothing new.
  const again = await harness.as('member').post('/tracks/experience/draft-questions');
  assert.equal(again.status, 201);
  assert.equal(again.body.created.length, 0);
});

test('malformed or failing AI output adds no topics and returns a retryable error', async () => {
  for (const [label, service, expected] of [
    ['missing questions', stubAi({ items: [] }), 'ai_output_invalid'],
    ['empty prompt', stubAi({ questions: [{ prompt: '', sourceRef: 'brief:requirements:0' }] }), 'ai_output_invalid'],
    ['wrong type', stubAi('not json'), 'ai_output_invalid'],
    ['provider error', stubAi(() => { throw new Error('socket hang up'); }), 'ai_request_failed'],
  ]) {
    const harness = await createRequirementsTestApp({ requirementsAiService: service });
    await harness.seedBrief();
    const response = await harness.as('member').post('/tracks/experience/draft-questions');
    assert.equal(response.status, 502, label);
    assert.equal(response.body.error, expected, label);
    assert.equal(response.body.details.retryable, true, label);
    assert.equal(harness.assistantRepository.state.projectClarifications.length, 0, `${label}: nothing created`);
  }
});

test('drafting reports ai_not_configured, an empty brief, and viewer access clearly', async () => {
  const unconfigured = await createRequirementsTestApp();
  await unconfigured.seedBrief();
  const missing = await unconfigured.as('member').post('/tracks/experience/draft-questions');
  assert.equal(missing.status, 503);
  assert.equal(missing.body.error, 'ai_not_configured');

  const declined = await createRequirementsTestApp({
    requirementsAiService: stubAi(() => { throw new HttpError(503, 'No key'); }),
  });
  await declined.seedBrief();
  const declinedResponse = await declined.as('member').post('/tracks/experience/draft-questions');
  assert.equal(declinedResponse.status, 503);
  assert.equal(declinedResponse.body.error, 'ai_not_configured');

  const noKey = await createRequirementsTestApp({ requirementsAiService: createRequirementsAiService({ defaultApiKey: '', provider: 'openai' }) });
  await noKey.seedBrief();
  const noKeyResponse = await noKey.as('member').post('/tracks/architecture/draft-questions');
  assert.equal(noKeyResponse.status, 503);
  assert.equal(noKeyResponse.body.error, 'ai_not_configured');

  const ai = stubAi({ questions: [] });
  const noBrief = await createRequirementsTestApp({ requirementsAiService: ai });
  const empty = await noBrief.as('member').post('/tracks/experience/draft-questions');
  assert.equal(empty.status, 409);
  assert.equal(empty.body.error, 'brief_empty');
  assert.equal(ai.calls.length, 0);

  assert.equal((await noBrief.as('viewer').post('/tracks/experience/draft-questions')).status, 404);
});

test('the local fixture provider drafts one question per uncovered requirement or constraint line', async () => {
  const harness = await createRequirementsTestApp({ requirementsAiService: createRequirementsAiService({ provider: 'local-fixture' }) });
  await harness.seedBrief();
  await harness.createTopic({ prompt: 'How should online booking feel on a phone?', sourceRef: 'brief:requirements:0' });

  const first = await harness.as('member').post('/tracks/experience/draft-questions');
  assert.equal(first.status, 201);
  assert.equal(first.body.provider, 'local-fixture');
  assert.deepEqual(first.body.created.map((topic) => topic.sourceRef).sort(), ['brief:constraints:0', 'brief:requirements:1']);

  const architecture = await harness.as('member').post('/tracks/architecture/draft-questions');
  assert.deepEqual(architecture.body.created.map((topic) => topic.sourceRef).sort(), ['brief:constraints:0', 'brief:requirements:0', 'brief:requirements:1']);
  assert.ok(architecture.body.created.every((topic) => topic.suggestedOwnerRole === 'Product owner'), 'drafted questions go to a client role');
  assert.ok(architecture.body.created.every((topic) => topic.rationale.startsWith('Recommended: ')), 'each drafted question carries a recommended default');

  const repeat = await harness.as('member').post('/tracks/experience/draft-questions');
  assert.equal(repeat.body.created.length, 0);

  assert.throws(() => createRequirementsAiService({ nodeEnv: 'production', provider: 'local-fixture' }), /not allowed in production/);
  assert.throws(() => createRequirementsAiService({ provider: 'mystery' }), /Unknown REQUIREMENTS_AI_PROVIDER/);
});

test('the OpenAI provider uses the requirementsDraftQuestions capability with structured output', async () => {
  const requests = [];
  const service = createRequirementsAiService({
    defaultApiKey: 'sk-local-test',
    defaultModel: 'gpt-6.1-sol',
    openAiFactory: () => ({
      responses: {
        async create(params) {
          requests.push(params);
          return {
            id: 'resp_1',
            output_text: JSON.stringify({
              questions: [{ prompt: 'Which phone browsers must booking support?', rationale: 'r', recommendation: 'Current Safari and Chrome.', settles: 's', sourceRef: 'brief:constraints:0', suggestedOwnerRole: 'Product owner' }],
            }),
            status: 'completed',
          };
        },
      },
    }),
    provider: 'openai',
    tenantsRepository: {
      async getOpenAiConfig() {
        const config = createDefaultAiConfig('gpt-6.1-sol');
        config.capabilities.requirementsDraftQuestions = { enabledTools: [], model: 'gpt-6-luna', reasoningEffort: 'low' };
        return config;
      },
    },
  });
  const harness = await createRequirementsTestApp({ requirementsAiService: service });
  await harness.seedBrief();

  const response = await harness.as('member').post('/tracks/experience/draft-questions');
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.provider, 'openai');
  assert.equal(response.body.created.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'gpt-6-luna');
  assert.equal(requests[0].instructions, requirementsDraftQuestionsInstructions);
  assert.equal(requests[0].text.format.name, 'requirements_draft_questions');
  const input = JSON.parse(requests[0].input[0].content[0].text);
  assert.equal(input.track, 'experience');
  assert.deepEqual(Object.keys(input).sort(), ['maxQuestions', 'track', 'untrustedContent'], 'all human text sits under untrustedContent');
  assert.equal(input.untrustedContent.trust, 'untrusted');
  assert.equal(input.untrustedContent.briefLines[0].sourceRef, 'brief:requirements:0');
});

test('docs/ai-prompts-inventory.md carries the draft-questions prompt verbatim', async () => {
  const inventory = await readFile(new URL('../../docs/ai-prompts-inventory.md', import.meta.url), 'utf8');
  assert.ok(inventory.replace(/\r\n/g, '\n').includes(requirementsDraftQuestionsInstructions));
  assert.ok(inventory.includes('requirementsDraftQuestions'));
});

test('REQUIREMENTS_AI_PROVIDER defaults to openai, accepts local-fixture outside production, and is refused in production', () => {
  assert.equal(loadEnv({ NODE_ENV: 'test' }).requirementsAiProvider, 'openai');
  assert.equal(loadEnv({ NODE_ENV: 'test', REQUIREMENTS_AI_PROVIDER: '' }).requirementsAiProvider, 'openai');
  assert.equal(loadEnv({ NODE_ENV: 'test', REQUIREMENTS_AI_PROVIDER: 'local-fixture' }).requirementsAiProvider, 'local-fixture');
  assert.equal(loadEnv({ NODE_ENV: 'test', REQUIREMENTS_AI_PROVIDER: 'local-fixture' }).requirementsAiProvider, 'local-fixture');
  assert.throws(() => loadEnv({ NODE_ENV: 'test', REQUIREMENTS_AI_PROVIDER: 'anthropic' }), /REQUIREMENTS_AI_PROVIDER/);
  assert.equal(loadEnv({ NODE_ENV: 'test', ...PRODUCTION_ENV, REQUIREMENTS_AI_PROVIDER: 'openai' }).requirementsAiProvider, 'openai');
  assert.throws(
    () => loadEnv({ NODE_ENV: 'test', ...PRODUCTION_ENV, REQUIREMENTS_AI_PROVIDER: 'local-fixture' }),
    /REQUIREMENTS_AI_PROVIDER: local-fixture is for local development only/,
  );
});
