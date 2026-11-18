import { readFile } from 'node:fs/promises';

import { createInMemoryAssistantRepository } from '../../src/modules/assistant/assistant.repository.js';
import { createInMemoryRequirementsRepository } from '../../src/modules/requirements/requirements.repository.js';
import { createRequirementsSummaryEngine } from '../../src/modules/requirements/summary/summary-engine.js';
import { summaryOutputSchema } from '../../src/modules/requirements/summary/summary-output.js';

// Replay evaluation for the owner-weighted summary rules (interactions review, 2026-10-16).
// Each case is a made-up discussion that reproduces one pattern the review found. A case
// runs `runsPerCase` times, each in fresh in-memory repositories, and the oracle checks
// every run against the case's expectations plus whether the blocking count is stable
// across runs. Needs a real provider to be meaningful; the local fixture only exercises
// the harness.

const CASES_URL = new URL('./replay-cases.json', import.meta.url);
const TENANT_ID = 'tenant-summary-replay';
const PROJECT_ID = 'project-summary-replay';
const TOPIC_ID = 'topic-summary-replay';
const RELATED_TOPIC_ID = 'topic-summary-replay-related';

export async function loadReplayCases() {
  return JSON.parse(await readFile(CASES_URL, 'utf8'));
}

function topicRecord(id, topic) {
  return {
    blockingArea: topic.settles,
    createdBy: 'user:eval',
    id,
    linkedSection: 'clarifications',
    prompt: topic.prompt,
    rationale: topic.rationale ?? '',
    sourceRef: null,
    suggestedOwnerRole: topic.suggestedOwnerRole ?? '',
    topicOrigin: 'manual',
    track: topic.track,
  };
}

/** Seeds one case into fresh repositories and runs one forced refresh. */
export async function runReplayCaseOnce({ summaryAi, testCase }) {
  const assistantRepository = createInMemoryAssistantRepository();
  const requirementsRepository = createInMemoryRequirementsRepository({ assistantRepository });
  const scope = { projectId: PROJECT_ID, tenantId: TENANT_ID };

  const people = new Map();
  for (const person of testCase.people) {
    if (person.kind === 'stakeholder') {
      const stakeholder = await assistantRepository.createProjectStakeholder({
        ...scope,
        value: { email: `${person.key}@client.example`, name: person.name, roleTitle: person.roleTitle ?? 'Stakeholder' },
      });
      people.set(person.key, { actorId: stakeholder.id, actorType: 'stakeholder', name: person.name });
    } else {
      people.set(person.key, { actorId: `user-${person.key}`, actorType: 'user', name: person.name });
    }
  }

  const topics = [topicRecord(TOPIC_ID, testCase.topic)];
  if ((testCase.relatedDecisions ?? []).length > 0) {
    topics.push(topicRecord(RELATED_TOPIC_ID, { prompt: 'Related question', settles: 'Related', track: testCase.topic.track }));
  }
  await requirementsRepository.createTopics({ ...scope, topics });

  const assignments = [
    ...(testCase.owner ? [{ key: testCase.owner, role: 'primary' }] : []),
    ...(testCase.required ?? []).map((key) => ({ key, role: 'required' })),
    ...(testCase.assigned ?? []).map((key) => ({ key, role: 'collaborator' })),
  ].map(({ key, role }) => {
    const person = people.get(key);
    return { actorId: person.actorId, actorType: person.actorType, label: person.name, role };
  });
  if (assignments.length > 0) {
    await assistantRepository.updateProjectClarification({ ...scope, clarificationId: TOPIC_ID, patch: { assignments } });
  }

  for (const [index, entry] of (testCase.relatedDecisions ?? []).entries()) {
    await requirementsRepository.createDecision({
      ...scope,
      decision: {
        decidedAt: new Date(Date.UTC(2026, 9, 15, 12, index)).toISOString(),
        decidedBy: 'user:eval',
        decidedByName: 'Eval Manager',
        kind: 'topic',
        outcome: entry.outcome ?? 'agreed',
        sources: [],
        statement: entry.statement,
        topicId: RELATED_TOPIC_ID,
        track: testCase.topic.track,
      },
    });
  }

  const commentIdByKey = new Map();
  for (const entry of testCase.comments) {
    const author = people.get(entry.author);
    const created = await assistantRepository.addProjectClarificationComment({
      ...scope,
      clarificationId: TOPIC_ID,
      comment: {
        actorId: author.actorId,
        actorType: author.actorType,
        authorName: author.name,
        body: entry.body,
        parentCommentId: entry.replyTo ? commentIdByKey.get(entry.replyTo) : null,
        source: 'comment',
      },
      preserveStatus: true,
    });
    commentIdByKey.set(entry.key, created.id);
  }
  for (const entry of testCase.comments) {
    for (const [vote, voters] of Object.entries(entry.votes ?? {})) {
      for (const voter of voters) {
        const actor = people.get(voter);
        await assistantRepository.voteProjectClarificationComment({
          ...scope,
          actorId: actor.actorId,
          actorType: actor.actorType,
          clarificationId: TOPIC_ID,
          commentId: commentIdByKey.get(entry.key),
          vote,
        });
      }
    }
  }

  // Project admins come from the project's users, as the topic loader reads them.
  const projectRepository = {
    async getValidUsers() {
      const users = testCase.people.filter((person) => person.kind !== 'stakeholder').map((person) => ({
        id: people.get(person.key).actorId,
        name: person.name,
        role: (testCase.admins ?? []).includes(person.key) ? 'admin' : 'user',
      }));
      return { project_users: users, tenant_users: users };
    },
  };
  const engine = createRequirementsSummaryEngine({ assistantRepository, projectRepository, requirementsRepository, summaryAi });
  try {
    const result = await engine.refreshNow({ ...scope, scopeId: TOPIC_ID, scopeType: 'topic' });
    return {
      commentRefByKey: new Map([...commentIdByKey].map(([key, id]) => [key, `comment:${id}`])),
      result,
      run: result?.summary ?? null,
    };
  } finally {
    engine.stop();
  }
}

export async function runReplayCase({ runs = 3, summaryAi, testCase }) {
  const outcomes = [];
  for (let index = 0; index < runs; index += 1) outcomes.push(await runReplayCaseOnce({ summaryAi, testCase }));
  return outcomes;
}

function check(name, passed, detail = '') {
  return { detail, name, passed: Boolean(passed) };
}

function textOf(entries, fields) {
  return entries.map((entry) => fields.map((field) => String(entry?.[field] ?? '')).join(' ')).join(' \n ').toLowerCase();
}

/** Deterministic oracle for one case's runs. */
export function evaluateReplayCase({ outcomes, testCase }) {
  const expect = testCase.expect ?? {};
  const checks = [];
  outcomes.forEach((outcome, index) => {
    const prefix = `run${index + 1}`;
    const output = outcome.run?.output ?? null;
    checks.push(check(`${prefix}:run-ok`, outcome.run?.status === 'ok', `status ${outcome.run?.status ?? outcome.result?.status ?? 'none'}`));
    const parsed = summaryOutputSchema.safeParse(output);
    checks.push(check(`${prefix}:schema-valid`, parsed.success));
    const outstanding = output?.outstanding ?? [];
    const blocking = outstanding.filter((entry) => entry.blocking === true);
    if (expect.maxBlocking !== undefined) {
      checks.push(check(`${prefix}:max-blocking`, blocking.length <= expect.maxBlocking, JSON.stringify(blocking.map((entry) => entry.item))));
    }
    if (expect.minBlocking !== undefined) {
      checks.push(check(`${prefix}:min-blocking`, blocking.length >= expect.minBlocking, `${blocking.length} blocking`));
    }
    if (expect.blockingCites) {
      const wanted = expect.blockingCites.map((key) => outcome.commentRefByKey.get(key));
      checks.push(check(`${prefix}:blocking-cites`, blocking.some((entry) => (entry.sources ?? []).some((ref) => wanted.includes(ref))), JSON.stringify(blocking)));
    }
    if (expect.proposedAnswer !== undefined) {
      const has = Boolean(String(output?.proposedAnswer ?? '').trim());
      checks.push(check(`${prefix}:proposed-answer`, has === expect.proposedAnswer, String(output?.proposedAnswer ?? '')));
    }
    if (expect.proposedAnswerStatus) {
      checks.push(check(`${prefix}:proposed-answer-status`, output?.proposedAnswerStatus === expect.proposedAnswerStatus, String(output?.proposedAnswerStatus)));
    }
    if (expect.noDivergent) {
      checks.push(check(`${prefix}:no-divergent`, (output?.divergent ?? []).length === 0, JSON.stringify((output?.divergent ?? []).map((entry) => entry.issue))));
    }
    if (expect.forbiddenTerms) {
      const raised = `${textOf(outstanding, ['item'])} \n ${textOf(output?.underExplored ?? [], ['area', 'suggestedQuestion', 'why'])}`;
      const found = expect.forbiddenTerms.filter((term) => raised.includes(term.toLowerCase()));
      checks.push(check(`${prefix}:not-raised-again`, found.length === 0, found.join(', ')));
    }
    if (expect.outstandingTerms) {
      // Each entry is a list of alternatives; one of them must appear in the outstanding items.
      const raised = textOf(outstanding, ['item']);
      const missing = expect.outstandingTerms.filter((terms) => ![terms].flat().some((term) => raised.includes(term.toLowerCase())));
      checks.push(check(`${prefix}:still-open`, missing.length === 0, missing.map((terms) => [terms].flat().join('|')).join(', ')));
    }
    if (expect.forbiddenAnswerTerms) {
      const answer = String(output?.proposedAnswer ?? '').toLowerCase();
      const found = expect.forbiddenAnswerTerms.filter((term) => answer.includes(term.toLowerCase()));
      checks.push(check(`${prefix}:answer-claims-nothing-unsaid`, found.length === 0, found.join(', ')));
    }
  });
  const counts = outcomes.map((outcome) => (outcome.run?.output?.outstanding ?? []).filter((entry) => entry.blocking === true).length);
  checks.push(check('stable-blocking', new Set(counts).size <= 1, `blocking counts ${counts.join(', ')}`));
  return { caseId: testCase.id, checks, passed: checks.every((entry) => entry.passed) };
}
