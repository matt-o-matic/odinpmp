import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { actorRefOf, loadPeople, personName } from '../rounds/round-views.js';
import { topicComments } from '../requirements-topics.js';
import { mentionedActors, portalMentionKey, resolveMentions } from './mention-tokens.js';

// Who can be tagged where, and what saving a comment with tags does.
//
// - Team, topic: project members and project stakeholders. Tagging a stakeholder who can't
//   see the topic adds them as a collaborator (the caller does that before saving).
// - Team, annotation: project members and the round's active stakeholder reviewers.
// - Portal, topic: the topic's assignees and everyone who has commented on it.
// - Portal, annotation: the annotation's author, its thread, and the round's publisher.
// The writer is never in their own list.

function sameActor(left, right) {
  return left.actorType === right.actorType && String(left.actorId) === String(right.actorId);
}

function addPerson(people, person) {
  if (!person.actorId || !['user', 'stakeholder'].includes(person.actorType)) return;
  if (people.some((entry) => sameActor(entry, person))) return;
  people.push({ ...person, name: String(person.name ?? '').trim() || (person.actorType === 'stakeholder' ? 'Stakeholder' : 'Team member') });
}

async function projectMembers(deps, { projectId, tenantId }) {
  const valid = await deps.projectRepository?.getValidUsers?.({ projectId, tenantId });
  return (valid?.project_users ?? []).filter((entry) => entry?.id);
}

/**
 * Whether a stakeholder can open a topic in the portal: assigned to it, or the topic has no
 * assignees at all (requirements-portal.service.js portalVisibility).
 */
export function stakeholderSeesTopic(clarification, stakeholderId) {
  if (!clarification || clarification.status === 'dismissed') return false;
  const assignments = clarification.assignments ?? [];
  return assignments.length === 0 || assignments.some((assignment) => assignment.actorType === 'stakeholder' && assignment.actorId === stakeholderId);
}

/** People the team may tag on a topic. Stakeholders carry `seesTopic`. */
export async function teamTopicPeople(deps, { author, clarification, projectId, tenantId }) {
  const [members, stakeholders] = await Promise.all([
    projectMembers(deps, { projectId, tenantId }),
    deps.assistantRepository?.listProjectStakeholders?.({ projectId, tenantId }) ?? [],
  ]);
  const people = [];
  for (const member of members) addPerson(people, { actorId: String(member.id), actorType: 'user', detail: 'Team', name: member.name });
  for (const stakeholder of stakeholders ?? []) {
    addPerson(people, {
      actorId: stakeholder.id,
      actorType: 'stakeholder',
      detail: stakeholder.roleTitle ? `Stakeholder · ${stakeholder.roleTitle}` : 'Stakeholder',
      name: stakeholder.name,
      seesTopic: stakeholderSeesTopic(clarification, stakeholder.id),
    });
  }
  return people.filter((person) => !sameActor(person, author));
}

/** People a stakeholder may tag on a topic they can see. */
export function portalTopicPeople({ author, clarification }) {
  const people = [];
  for (const assignment of clarification?.assignments ?? []) {
    addPerson(people, { actorId: assignment.actorId, actorType: assignment.actorType, detail: assignment.actorType === 'stakeholder' ? 'Stakeholder' : 'Team', name: assignment.label });
  }
  for (const comment of topicComments(clarification)) {
    if (comment.deletedAt || comment.isDeleted) continue;
    addPerson(people, { actorId: comment.actorId, actorType: comment.actorType, detail: comment.actorType === 'stakeholder' ? 'Stakeholder' : 'Team', name: comment.authorName });
  }
  return people.filter((person) => !sameActor(person, author));
}

/** People the team may tag in an annotation thread. */
export async function teamAnnotationPeople(deps, { author, projectId, round, tenantId }) {
  const [members, people] = await Promise.all([projectMembers(deps, { projectId, tenantId }), loadPeople(deps, { projectId, tenantId })]);
  const list = [];
  for (const member of members) addPerson(list, { actorId: String(member.id), actorType: 'user', detail: 'Team', name: member.name });
  for (const reviewer of round?.reviewers ?? []) {
    if (reviewer.removedAt || reviewer.actorType !== 'stakeholder') continue;
    addPerson(list, { actorId: reviewer.actorId, actorType: 'stakeholder', detail: 'Reviewer', name: personName(people, actorRefOf('stakeholder', reviewer.actorId), reviewer.name) });
  }
  return list.filter((person) => !sameActor(person, author));
}

/** People a stakeholder may tag in an annotation thread: its author, its thread, the round's publisher. */
export async function portalAnnotationPeople(deps, { annotation, author, comments = [], projectId, round, tenantId }) {
  const people = await loadPeople(deps, { projectId, tenantId });
  const list = [];
  const add = (actorType, actorId, fallback) => addPerson(list, {
    actorId,
    actorType,
    detail: actorType === 'stakeholder' ? 'Stakeholder' : 'Team',
    name: personName(people, actorRefOf(actorType, actorId), fallback),
  });
  if (annotation) add(annotation.authorType, annotation.authorId, annotation.authorName);
  for (const comment of comments) {
    if (!comment.deletedAt) add(comment.authorType, comment.authorId, comment.authorName);
  }
  const [publisherType, publisherId] = String(round?.publishedBy ?? '').split(':');
  if (publisherId) add(publisherType, publisherId, '');
  return list.filter((person) => !sameActor(person, author));
}

/** The picker list: refs are actor refs for the team and portal keys for the portal. */
export function presentMentionables(people, { audience = 'team', projectId = '' } = {}) {
  return people
    .map((person) => {
      const actorRef = `${person.actorType}:${person.actorId}`;
      return {
        detail: person.detail ?? '',
        kind: person.actorType === 'stakeholder' ? 'stakeholder' : 'team',
        name: person.name,
        ref: audience === 'portal' ? `person:${portalMentionKey(projectId, actorRef)}` : actorRef,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Resolves the tags in a body being saved. Returns the body to store and the people it
 * tags. With `previousBody` (an edit), `added` holds only people the edit adds.
 */
export function prepareMentions(body, { audience = 'team', people = [], previousBody = '', projectId = '' } = {}) {
  const resolved = resolveMentions(body, { audience, people, projectId });
  const before = new Set(mentionedActors(previousBody).map((entry) => entry.actorRef));
  return { ...resolved, added: resolved.mentioned.filter((entry) => !before.has(entry.actorRef)) };
}

/**
 * The people a new comment on a topic is news for: the topic's owner, and everyone who has
 * commented on it. `[{ actorType, actorId, actorRef, owner }]`.
 */
export function topicFollowers(clarification) {
  const followers = [];
  const add = (actorType, actorId, owner) => {
    if (!actorId || !['user', 'stakeholder'].includes(actorType)) return;
    const actorRef = `${actorType}:${actorId}`;
    const existing = followers.find((entry) => entry.actorRef === actorRef);
    if (existing) existing.owner ||= owner;
    else followers.push({ actorId: String(actorId), actorRef, actorType, owner });
  };
  for (const assignment of clarification?.assignments ?? []) {
    if (assignment.role === 'primary') add(assignment.actorType, assignment.actorId, true);
  }
  for (const comment of topicComments(clarification)) {
    if (!comment.deletedAt && !comment.isDeleted) add(comment.actorType, comment.actorId, false);
  }
  return followers;
}

/**
 * Records a new comment on a topic for the digests of the topic's owner and the people who
 * commented on it before, as a reply. Anyone the comment tags already has a mention for it,
 * which the digest shows instead. `clarification` is the topic as it was before the comment.
 */
export async function recordTopicReplies(deps, { author, clarification, commentId, projectId, skip = [], tenantId, topicId }) {
  if (!commentId) return [];
  return recordMentions(deps, {
    author,
    projectId,
    reason: 'reply',
    recipients: topicFollowers(clarification),
    skip,
    source: { commentId, topicId, type: 'topic' },
    tenantId,
  });
}

/**
 * Records mentions for the mention digest. A failure here never undoes the comment: it is
 * logged, and those people are not emailed. `reason` is 'mention' for people the comment
 * tags and 'reply' for a topic's followers (recordTopicReplies).
 */
export async function recordMentions(deps, { author, projectId, reason = 'mention', recipients = [], skip = [], source, tenantId }) {
  const skipped = new Set(skip);
  const targets = recipients.filter((recipient) => !skipped.has(recipient.actorRef) && !sameActor(recipient, author));
  if (!targets.length || !deps.mentionsRepository?.recordMentions) return [];
  try {
    return await deps.mentionsRepository.recordMentions({
      author,
      projectId,
      reason,
      recipients: targets,
      scheduledAt: typeof deps.clock === 'function' ? deps.clock() : new Date(),
      source,
      tenantId,
    });
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.recordMentions', { commentId: source?.commentId, projectId, tenantId }),
      error,
      level: 'warn',
      message: 'Mentions could not be recorded; the comment was saved without notifying them.',
    });
    return [];
  }
}
