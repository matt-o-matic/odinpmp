import { requireDecisionRights } from '../../lib/auth/decision-rights.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { normalizeAssignmentRole } from '../assistant/assignment-roles.js';
import { summarySourceRefs } from './requirements-topics.js';
import {
  deleteTopicForUser,
  getTopicForUser,
  recordDecisionForUser,
  updateTopicForUser,
} from './requirements.service.js';

// One action over many topics from the register (POST /topics/bulk). Each topic goes through
// the same function, checks and notifications as the single-topic routes, and the response
// reports every topic: done, skipped (with the reason a person would see), or failed. One
// topic never stops the others.

const RIGHTS_ACTIONS = new Set(['agree', 'defer', 'dismiss', 'reopen']);
const OPEN_STATES = new Set(['open', 'ready']);

const SKIP_MESSAGES = Object.freeze({
  already_dismissed: 'Already dismissed.',
  has_decision: 'Already has a decision. Replace it on the topic page.',
  is_dismissed: 'Dismissed. Reopen it first.',
  no_proposed_answer: 'No Odin proposed answer to agree to yet.',
  not_dismissed: 'Not dismissed, so there is nothing to reopen.',
  topic_has_activity: 'Has comments, decisions, stakeholders or files, so it can only be dismissed.',
  topic_has_answers: 'Reviewers already answered it in a review round, so it can only be dismissed.',
  unchanged: 'Already has these people.',
});

class Skip extends Error {
  constructor(code) {
    super(SKIP_MESSAGES[code] ?? code);
    this.code = code;
  }
}

const key = (person) => `${person.actorType}:${person.actorId}`;

/** The assignments a topic ends up with after a bulk people change, or null when nothing changes. */
export function bulkAssignments(current = [], { add = [], owner, remove = [] } = {}) {
  const removed = new Set(remove.map(key));
  const currentOwner = current.find((assignment) => assignment.role === 'primary') ?? null;
  const nextOwner = owner === undefined
    ? (currentOwner && !removed.has(key(currentOwner)) ? currentOwner : null)
    : owner;
  const labels = new Map(current.map((assignment) => [key(assignment), assignment.label ?? '']));
  // People already on the topic keep their role (required or not); people added are asked for input.
  const roles = new Map(current.filter((assignment) => assignment.role !== 'primary').map((assignment) => [key(assignment), normalizeAssignmentRole(assignment.role)]));
  const next = nextOwner ? [{ actorId: nextOwner.actorId, actorType: nextOwner.actorType, label: labels.get(key(nextOwner)) ?? '', role: 'primary' }] : [];
  const seen = new Set(next.map(key));
  const involve = [
    ...current.filter((assignment) => assignment.role !== 'primary'),
    ...add,
  ];
  for (const person of involve) {
    if (seen.has(key(person)) || removed.has(key(person))) continue;
    seen.add(key(person));
    next.push({ actorId: person.actorId, actorType: person.actorType, label: labels.get(key(person)) ?? '', role: roles.get(key(person)) ?? 'collaborator' });
  }
  const signature = (list) => list.map((assignment) => `${normalizeAssignmentRole(assignment.role)}:${key(assignment)}`).sort().join('|');
  return signature(next) === signature(current) ? null : next;
}

async function runOne(deps, { input, projectId, topicId, user }) {
  if (input.action === 'delete') {
    try {
      await deleteTopicForUser(deps, { projectId, topicId, user });
      return;
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 409) {
        throw new Skip(error.details?.activity?.answers > 0 ? 'topic_has_answers' : 'topic_has_activity');
      }
      throw error;
    }
  }

  const { topic } = await getTopicForUser(deps, { projectId, topicId, user });
  switch (input.action) {
    case 'dismiss':
      if (topic.state === 'dismissed') throw new Skip('already_dismissed');
      if (!OPEN_STATES.has(topic.state)) throw new Skip('has_decision');
      await updateTopicForUser(deps, { input: { status: 'dismissed' }, projectId, topicId, user });
      return;
    case 'reopen':
      if (topic.state !== 'dismissed') throw new Skip('not_dismissed');
      await updateTopicForUser(deps, { input: { status: 'open' }, projectId, topicId, user });
      return;
    case 'agree':
    case 'defer': {
      if (topic.state === 'dismissed') throw new Skip('is_dismissed');
      if (topic.decision) throw new Skip('has_decision');
      const summary = topic.summary ?? null;
      const proposedAnswer = String(summary?.output?.proposedAnswer ?? '').trim();
      if (input.action === 'agree' && !proposedAnswer) throw new Skip('no_proposed_answer');
      await recordDecisionForUser(deps, {
        input: {
          outcome: input.action === 'agree' ? 'agreed' : 'deferred',
          sourceSummaryId: summary?.id ?? '',
          sources: summarySourceRefs(summary?.output),
          statement: input.action === 'agree' ? proposedAnswer : input.statement,
          supersedesId: '',
          topicId,
        },
        projectId,
        user,
      });
      return;
    }
    case 'assign': {
      const assignments = bulkAssignments(topic.assignments ?? [], input.assign);
      if (!assignments) throw new Skip('unchanged');
      await updateTopicForUser(deps, { input: { assignments }, projectId, topicId, user });
      return;
    }
    default:
      throw new HttpError(400, 'Unknown bulk action.');
  }
}

export async function bulkTopicActionForUser(deps, { input, projectId, user }) {
  if (RIGHTS_ACTIONS.has(input.action)) {
    const tenantId = user?.memberships?.[0]?.tenantId ?? null;
    await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  }
  const results = [];
  for (const topicId of [...new Set(input.topicIds)]) {
    try {
      await runOne(deps, { input, projectId, topicId, user });
      results.push({ status: 'done', topicId });
    } catch (error) {
      if (error instanceof Skip) {
        results.push({ code: error.code, message: error.message, status: 'skipped', topicId });
      } else if (error instanceof HttpError && error.statusCode < 500) {
        results.push({ code: error.details?.code ?? `http_${error.statusCode}`, message: error.message, status: 'failed', topicId });
      } else {
        // Earlier topics are already saved, so report this one and carry on rather than fail the request.
        logBackendError({
          context: buildOperationLogContext('requirements.topics.bulk', { action: input.action, projectId, topicId, userId: user?.id ?? null }),
          error,
          message: 'A bulk topic action failed for one topic.',
        });
        results.push({ code: 'internal_error', message: 'Odin could not complete this one. Try it again.', status: 'failed', topicId });
      }
    }
  }
  const count = (status) => results.filter((result) => result.status === status).length;
  return { action: input.action, counts: { done: count('done'), failed: count('failed'), skipped: count('skipped') }, ok: true, results };
}
