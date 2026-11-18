import { randomUUID } from 'node:crypto';

import { requireDecisionRights, resolveDecisionRights } from '../../../lib/auth/decision-rights.js';
import { hasProjectCapability, PROJECT_CAPABILITIES, requireProjectCapability } from '../../../lib/auth/project-capabilities.js';
import { HttpError } from '../../../lib/errors/http-error.js';
import { LIVE_EVENT_CHANNELS } from '../../../lib/events/live-event-bus.js';
import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { mentionedActors } from '../mentions/mention-tokens.js';
import { issuePackageGrant, PACKAGES_EVENT } from '../packages/packages.service.js';
import { loadRemovedQuestionIds } from '../removed-questions.js';
import { publishRequirementsChange, REQUIREMENTS_EVENTS } from '../requirements-events.js';
import { describeActorRef } from '../requirements-topics.js';
import { applyCarryForward } from './carry-forward.js';
import { closeRoundTopics } from './round-close-topics.js';
import { publishRoundEvent, ROUND_EVENTS } from './round-events.js';
import { loadReviewerMailStates, sendRoundEmail } from './round-invitations.js';
import {
  answerText,
  feedbackDimensions,
  manifestDirections,
  manifestQuestions,
  manifestScreens,
} from './round-manifest.js';
import {
  buildRoundSources,
  loadRoundFeedback,
  presentScopeSummary,
  ROUND_SCOPE,
  SCREEN_SCOPE,
  screenScopeId,
} from './round-summaries.js';
import {
  actorRefOf,
  collectDirectionStances,
  collectScreenVerdicts,
  computeProgress,
  loadPeople,
  personName,
  presentAnnotation,
  presentStance,
  presentVerdict,
} from './round-views.js';

// Rounds for the team (journeys 4, 6, 7, and 8): publish a draft package as the track's
// next round, invite reviewers, change the due date and reviewers, resend invitations,
// close with an outcome, read results and alignment, and export feedback for agents.
// Route middleware checks capabilities first, so viewers get 404 on every write before a
// body is read; the service checks again.

export const FEEDBACK_SCHEMA = 'odin.round-feedback/v1';
export const DEFAULT_FEEDBACK_PAGE_SIZE = 200;
const TOPIC_ORIGIN = 'package-question';

export function roundsClock(deps) {
  return deps.clock ? new Date(deps.clock()) : new Date();
}

function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId ?? null;
  if (!tenantId) throw new HttpError(404, 'Project not found.');
  return tenantId;
}

export async function requireRoundCapability(deps, { capability, projectId, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability, projectId, repository: deps.projectRepository, tenantId, user });
  return tenantId;
}

function userActor(user) {
  return user?.id ? { id: user.id, name: user.name ?? '' } : null;
}

function conflict(code, message, details = {}) {
  return new HttpError(409, message, { details: { code, ...details } });
}

export async function loadRound(deps, { projectId, roundId, tenantId }) {
  const round = await deps.roundsRepository.getRound({ projectId, roundId, tenantId });
  if (!round || round.status === 'draft') throw new HttpError(404, 'Round not found.');
  return round;
}

export async function loadRoundPackage(deps, { projectId, round, tenantId }) {
  const pkg = await deps.packagesRepository.getPackage({ packageId: round.packageId, projectId, tenantId });
  if (!pkg) throw new HttpError(404, 'Round not found.');
  return pkg;
}

function notifyPackages(deps, { packageId, projectId, reason, track }) {
  deps.liveEventBus?.publish(LIVE_EVENT_CHANNELS.project(projectId), { packageIds: [packageId], projectId, reason, track, type: PACKAGES_EVENT });
}

// ---------------------------------------------------------------------------
// Reviewers
// ---------------------------------------------------------------------------

/**
 * Checks a reviewer list: no duplicates; users need member access or above on the project
 * (Q-05: they review with project.collaborate); stakeholders must belong to the project.
 */
async function resolveReviewers(deps, { projectId, reviewers = [], tenantId }) {
  const seen = new Set();
  for (const reviewer of reviewers) {
    const key = `${reviewer.actorType}:${reviewer.actorId}`;
    if (seen.has(key)) throw new HttpError(400, 'Each reviewer can be listed once.');
    seen.add(key);
  }
  const needsUsers = reviewers.some((reviewer) => reviewer.actorType === 'user');
  const needsStakeholders = reviewers.some((reviewer) => reviewer.actorType === 'stakeholder');
  const valid = needsUsers ? await deps.projectRepository.getValidUsers({ projectId, tenantId }) : null;
  const tenantUsers = new Map((valid?.tenant_users ?? []).map((entry) => [entry.id, entry]));
  const stakeholders = needsStakeholders
    ? new Map((await deps.assistantRepository.listProjectStakeholders({ projectId, tenantId })).map((stakeholder) => [stakeholder.id, stakeholder]))
    : new Map();

  for (const reviewer of reviewers) {
    if (reviewer.actorType === 'stakeholder') {
      if (!stakeholders.has(reviewer.actorId)) throw new HttpError(400, 'A reviewer is not a stakeholder of this project.', { details: { actorId: reviewer.actorId, code: 'reviewer_invalid' } });
      continue;
    }
    const tenantUser = tenantUsers.get(reviewer.actorId);
    const access = tenantUser ? await deps.projectRepository.getProjectAccess({ projectId, tenantId, userId: reviewer.actorId }) : null;
    const allowed = Boolean(access?.exists) && hasProjectCapability({
      capability: PROJECT_CAPABILITIES.COLLABORATE,
      projectRole: access?.projectRole ?? null,
      tenantRole: tenantUser?.role ?? null,
    });
    if (!allowed) {
      throw new HttpError(400, 'A reviewer needs member access or above on this project.', { details: { actorId: reviewer.actorId, code: 'reviewer_invalid' } });
    }
  }
  return reviewers.map((reviewer) => ({ actorId: reviewer.actorId, actorType: reviewer.actorType, required: Boolean(reviewer.required) }));
}

/** Queues invitations for the given reviewer rows and records each one's mail status. */
async function inviteReviewers(deps, { kind = 'invitation', pkg, projectId, reviewerIds, round, tenantId, user }) {
  if (reviewerIds.length === 0) return round;
  const [project, validUsers] = await Promise.all([
    deps.projectRepository.getProjectDetail({ projectId, tenantId }),
    deps.projectRepository.getValidUsers({ projectId, tenantId }),
  ]);
  for (const reviewerId of reviewerIds) {
    const reviewer = round.reviewers.find((item) => item.id === reviewerId);
    if (!reviewer) continue;
    const fields = await sendRoundEmail(deps, {
      createdBy: actorRefOf('user', user.id),
      inviterName: user.name ?? '',
      kind,
      now: roundsClock(deps),
      pkg,
      projectId,
      projectName: project?.name ?? '',
      reviewer,
      round,
      tenantId,
      validUsers,
    });
    await deps.roundsRepository.updateReviewer({ patch: fields, projectId, reviewerId, roundId: round.id, tenantId });
  }
  return deps.roundsRepository.getRound({ projectId, roundId: round.id, tenantId });
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function roundCounts(round) {
  const active = round.reviewers.filter((reviewer) => !reviewer.removedAt);
  return {
    required: active.filter((reviewer) => reviewer.required).length,
    requiredSubmitted: active.filter((reviewer) => reviewer.required && reviewer.submittedAt).length,
    reviewers: active.length,
    submitted: active.filter((reviewer) => reviewer.submittedAt).length,
  };
}

function presentRoundSummary(round, { people = new Map(), pkg = null } = {}) {
  const describe = (ref) => {
    const actor = describeActorRef(ref);
    if (actor) actor.name = personName(people, ref);
    return actor;
  };
  return {
    closedAt: round.closedAt,
    closedBy: describe(round.closedBy),
    counts: roundCounts(round),
    dueAt: round.dueAt,
    id: round.id,
    note: round.note,
    number: round.number,
    outcome: round.outcome,
    outcomeDirectionId: round.outcomeDirectionId,
    packageId: round.packageId,
    packageVersion: pkg?.version ?? null,
    publishedAt: round.publishedAt,
    publishedBy: describe(round.publishedBy),
    reminder: round.reminderDaysBefore ? { daysBefore: round.reminderDaysBefore } : null,
    status: round.status,
    title: pkg?.title ?? '',
    track: round.track,
  };
}

async function presentReviewers(deps, { feedback = null, people, pkg, round }) {
  const [mail, removedQuestionIds] = await Promise.all([
    loadReviewerMailStates(deps, round.reviewers),
    feedback ? loadRemovedQuestionIds(deps, { manifest: pkg.manifest, projectId: round.projectId, round, tenantId: round.tenantId }) : null,
  ]);
  const screenVerdicts = feedback ? collectScreenVerdicts(feedback.verdicts) : null;
  const stances = feedback ? collectDirectionStances(feedback.verdicts) : null;
  return round.reviewers.map((reviewer) => {
    const actorRef = actorRefOf(reviewer.actorType, reviewer.actorId);
    return {
      actorId: reviewer.actorId,
      actorRef,
      actorType: reviewer.actorType,
      email: people.get(actorRef)?.email ?? '',
      id: reviewer.id,
      invitedAt: reviewer.invitedAt,
      lastSeenAt: reviewer.lastSeenAt,
      mail: mail.get(reviewer.id),
      name: personName(people, actorRef),
      progress: feedback ? computeProgress({ actorRef, answers: feedback.answers, manifest: pkg.manifest, removedQuestionIds, screenVerdicts, stances }) : null,
      remindedAt: reviewer.remindedAt,
      removedAt: reviewer.removedAt,
      required: reviewer.required,
      submittedAt: reviewer.submittedAt,
    };
  });
}

async function presentRoundDetail(deps, { projectId, round, tenantId, user }) {
  const [pkg, people, feedback, decisions] = await Promise.all([
    loadRoundPackage(deps, { projectId, round, tenantId }),
    loadPeople(deps, { projectId, tenantId }),
    loadRoundFeedback(deps, { projectId, round, tenantId }),
    deps.requirementsRepository.listDecisions({ kind: 'round', projectId, tenantId, track: round.track }),
  ]);
  const decision = decisions.find((item) => item.roundId === round.id && !item.supersededById) ?? null;
  const me = user ? round.reviewers.find((reviewer) => reviewer.actorType === 'user' && reviewer.actorId === user.id && !reviewer.removedAt) ?? null : null;
  return {
    ...presentRoundSummary(round, { people, pkg }),
    decision: decision
      ? { decidedAt: decision.decidedAt, decidedBy: { name: decision.decidedByName, ref: decision.decidedBy }, id: decision.id, statement: decision.statement }
      : null,
    me: me ? { reviewerId: me.id, submittedAt: me.submittedAt } : null,
    package: { id: pkg.id, status: pkg.status, title: pkg.title, version: pkg.version },
    questionTopics: round.questionTopics,
    reviewers: await presentReviewers(deps, { feedback, people, pkg, round }),
  };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * Resolves each manifest question to a topic. A question with a topicId must still resolve,
 * on either track: review is project-wide. One without reuses the topic an earlier round
 * created for the same question id, or gets a new open topic on the review's track.
 */
async function planQuestionTopics(deps, { pkg, previousRounds, projectId, tenantId, user }) {
  const questionTopics = {};
  const toCreate = [];
  const missing = [];
  const trackOf = (topicId) => deps.requirementsRepository.getTopicTrack({ clarificationId: topicId, projectId, tenantId });
  const latestFirst = [...previousRounds].sort((left, right) => right.number - left.number);
  for (const question of manifestQuestions(pkg.manifest)) {
    if (question.topicId) {
      if (await trackOf(question.topicId)) questionTopics[question.id] = question.topicId;
      else missing.push(question.id);
      continue;
    }
    let reused = null;
    for (const previous of latestFirst) {
      const topicId = previous.questionTopics?.[question.id];
      if (topicId && await trackOf(topicId)) {
        reused = topicId;
        break;
      }
    }
    if (reused) {
      questionTopics[question.id] = reused;
      continue;
    }
    const id = randomUUID();
    questionTopics[question.id] = id;
    toCreate.push({
      blockingArea: '',
      createdBy: actorRefOf('user', user.id),
      id,
      linkedSection: 'clarifications',
      prompt: question.prompt,
      rationale: question.help ?? '',
      sourceRef: `package:${pkg.id}:${question.id}`,
      topicOrigin: TOPIC_ORIGIN,
      track: pkg.track,
    });
  }
  return { missing, questionTopics, toCreate };
}

function defaultStatement({ directionTitle, outcome, round }) {
  const text = {
    abandoned: 'Round abandoned.',
    'changes-requested': 'Changes requested.',
    'direction-chosen': `Direction chosen: ${directionTitle}.`,
    'screens-accepted': 'Screens accepted.',
  }[outcome];
  return `Round ${round.number}: ${text}`;
}

function validateClose(pkg, input) {
  const directions = manifestDirections(pkg.manifest);
  if (input.outcome === 'direction-chosen') {
    const direction = directions.find((item) => item.id === input.directionId);
    if (!direction) throw new HttpError(400, 'Choose one of the round\'s directions.', { details: { code: 'direction_invalid' } });
    return direction;
  }
  if (input.directionId) throw new HttpError(400, 'Only "direction chosen" names a direction.', { details: { code: 'direction_invalid' } });
  return null;
}

/** Closes an open round and records a 'round' decision owned by the person closing it. */
async function closeRoundCore(deps, { input, projectId, round, tenantId, user }) {
  const pkg = await loadRoundPackage(deps, { projectId, round, tenantId });
  const direction = validateClose(pkg, input);
  const closedAt = roundsClock(deps);
  // One repository call: the round closes only if its decision is recorded too.
  const result = await deps.roundsRepository.closeRound({
    closedAt,
    closedBy: actorRefOf('user', user.id),
    decision: {
      decidedAt: closedAt,
      decidedBy: actorRefOf('user', user.id),
      decidedByName: user.name ?? '',
      kind: 'round',
      outcome: 'decided',
      roundId: round.id,
      sources: [`round:${round.id}`, ...(direction ? [`direction:${direction.id}`] : [])],
      statement: input.statement || defaultStatement({ directionTitle: direction?.title, outcome: input.outcome, round }),
      topicId: null,
      track: round.track,
    },
    outcome: input.outcome,
    outcomeDirectionId: direction?.id ?? null,
    projectId,
    roundId: round.id,
    tenantId,
  });
  if (!result) throw conflict('round_not_open', 'This round is already closed.');
  const { decision, round: closed } = result;
  // The round's questions close with it: nothing from the round stays waiting in Decide.
  const closedTopics = await closeRoundTopics(deps, { closedAt, projectId, round: closed, tenantId, user });
  const topicIds = [...closedTopics.decided, ...closedTopics.deferred];

  await publishRoundEvent(deps, { actor: userActor(user), projectId, reason: 'round-closed', round: closed, tenantId, type: ROUND_EVENTS.rounds });
  await publishRequirementsChange({
    actor: userActor(user),
    liveEventBus: deps.liveEventBus,
    projectId,
    reason: 'round-closed',
    requirementsRepository: deps.requirementsRepository,
    tenantId,
    topicIds,
    track: round.track,
    type: REQUIREMENTS_EVENTS.decisions,
  });
  if (topicIds.length > 0) deps.requirementsSummaries?.noteTopicActivity?.({ projectId, reason: 'decision-recorded', tenantId, topicIds });
  return { closedTopics: { decided: closedTopics.decided.length, deferred: closedTopics.deferred.length }, decision, round: closed };
}

export async function publishRoundForUser(deps, { input, projectId, user }) {
  const tenantId = await requireRoundCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const now = roundsClock(deps);
  const pkg = await deps.packagesRepository.getPackage({ packageId: input.packageId, projectId, tenantId });
  if (!pkg || pkg.status === 'withdrawn') throw new HttpError(404, 'Package not found.');
  if (pkg.status !== 'draft') throw conflict('package_not_draft', 'Only a draft package can be published as a round.', { packageStatus: pkg.status });
  if (input.dueAt && Date.parse(input.dueAt) <= now.valueOf()) throw new HttpError(400, 'Choose a due date in the future.');
  if (input.reminder && !input.dueAt) throw new HttpError(400, 'A reminder needs a due date.');

  // One round open at a time across the project, whatever track its package was stored on.
  const projectRounds = await deps.roundsRepository.listRounds({ projectId, tenantId, track: '' });
  const open = projectRounds.find((round) => round.status === 'open') ?? null;
  if (open && !input.closePrevious) {
    throw conflict('round_open', 'A review round is already open for this project. Close it before publishing another.', {
      openRoundId: open.id,
      openRoundNumber: open.number,
    });
  }
  if (open) {
    await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
    validateClose(await loadRoundPackage(deps, { projectId, round: open, tenantId }), input.closePrevious);
  }

  const reviewers = await resolveReviewers(deps, { projectId, reviewers: input.reviewers, tenantId });
  const plan = await planQuestionTopics(deps, { pkg, previousRounds: projectRounds, projectId, tenantId, user });
  if (plan.missing.length > 0) {
    throw conflict('question_topic_missing', 'Some questions link to topics that are gone.', { questionIds: plan.missing });
  }

  if (open) await closeRoundCore(deps, { input: input.closePrevious, projectId, round: open, tenantId, user });

  const claimed = await deps.packagesRepository.setPackageStatus({ from: 'draft', packageId: pkg.id, projectId, tenantId, to: 'published' });
  if (!claimed) throw conflict('package_not_draft', 'This package changed while it was being published. Reload it and try again.');

  const createdTopicIds = [];
  let round;
  try {
    if (plan.toCreate.length > 0) {
      await deps.requirementsRepository.createTopics({ projectId, tenantId, topics: plan.toCreate });
      createdTopicIds.push(...plan.toCreate.map((topic) => topic.id));
    }
    round = await deps.roundsRepository.createRound({
      projectId,
      reviewers: reviewers.map((reviewer) => ({ ...reviewer, invitedAt: now })),
      round: {
        dueAt: input.dueAt,
        id: randomUUID(),
        note: input.note,
        packageId: pkg.id,
        publishedAt: now,
        publishedBy: actorRefOf('user', user.id),
        questionTopics: plan.questionTopics,
        reminderDaysBefore: input.reminder?.daysBefore ?? null,
        track: pkg.track,
      },
      tenantId,
    });
  } catch (error) {
    await deps.packagesRepository.setPackageStatus({ from: 'published', packageId: pkg.id, projectId, tenantId, to: 'draft' }).catch(() => {});
    for (const topicId of createdTopicIds) {
      await deps.requirementsRepository.deleteTopic({ projectId, tenantId, topicId }).catch(() => {});
    }
    throw error;
  }

  let carried = { carried: [], outdated: [], superseded: [] };
  try {
    carried = await applyCarryForward(deps, { now, pkg: claimed, projectId, round, tenantId });
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.rounds.carryForward', { projectId, roundId: round.id, tenantId }),
      error,
      message: 'Carrying annotations forward failed.',
    });
  }

  round = await inviteReviewers(deps, { pkg: claimed, projectId, reviewerIds: round.reviewers.map((reviewer) => reviewer.id), round, tenantId, user });

  await publishRoundEvent(deps, { actor: userActor(user), projectId, reason: 'round-published', round, tenantId, type: ROUND_EVENTS.rounds });
  notifyPackages(deps, { packageId: pkg.id, projectId, reason: 'published', track: pkg.track });
  if (createdTopicIds.length > 0) {
    await publishRequirementsChange({
      actor: userActor(user),
      liveEventBus: deps.liveEventBus,
      projectId,
      reason: 'topics-created-from-package',
      requirementsRepository: deps.requirementsRepository,
      tenantId,
      topicIds: createdTopicIds,
      track: pkg.track,
    });
  }
  if (carried.carried.length + carried.outdated.length + carried.superseded.length > 0) {
    deps.liveEventBus?.publish(LIVE_EVENT_CHANNELS.project(projectId), {
      projectId, reason: 'annotations-carried-forward', roundId: round.id, track: round.track, type: ROUND_EVENTS.review,
    });
  }

  return {
    carryForward: { carried: carried.carried.length, outdated: carried.outdated.length, superseded: carried.superseded.length },
    createdTopicIds,
    ok: true,
    round: await presentRoundDetail(deps, { projectId, round, tenantId, user }),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listRoundsForUser(deps, { projectId, track = '', user }) {
  const tenantId = await requireRoundCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const [rounds, packages, people] = await Promise.all([
    deps.roundsRepository.listRounds({ projectId, tenantId, track }),
    deps.packagesRepository.listPackages({ projectId, tenantId, track }),
    loadPeople(deps, { projectId, tenantId }),
  ]);
  const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const published = rounds.filter((round) => round.status !== 'draft');
  // Who reviews each round, so a project's people lists can show their reviews.
  const mail = await loadReviewerMailStates(deps, published.flatMap((round) => round.reviewers.filter((reviewer) => !reviewer.removedAt)));
  return {
    ok: true,
    rounds: published
      .sort((left, right) => left.track.localeCompare(right.track) || right.number - left.number)
      .map((round) => {
        const mine = round.reviewers.find((reviewer) => reviewer.actorType === 'user' && reviewer.actorId === user.id && !reviewer.removedAt) ?? null;
        return {
          ...presentRoundSummary(round, { people, pkg: packageById.get(round.packageId) ?? null }),
          me: mine ? { reviewerId: mine.id, submittedAt: mine.submittedAt } : null,
          reviewers: round.reviewers.filter((reviewer) => !reviewer.removedAt).map((reviewer) => ({
            actorId: reviewer.actorId,
            actorType: reviewer.actorType,
            id: reviewer.id,
            invitedAt: reviewer.invitedAt,
            mailStatus: mail.get(reviewer.id)?.status ?? null,
            required: Boolean(reviewer.required),
            submittedAt: reviewer.submittedAt,
          })),
        };
      }),
    track: track || null,
  };
}

export async function getRoundForUser(deps, { projectId, roundId, user }) {
  const tenantId = await requireRoundCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const round = await loadRound(deps, { projectId, roundId, tenantId });
  const rights = await resolveDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  return { canClose: rights.allowed && round.status === 'open', ok: true, round: await presentRoundDetail(deps, { projectId, round, tenantId, user }) };
}

// ---------------------------------------------------------------------------
// Changes while open
// ---------------------------------------------------------------------------

function ensureOpen(round) {
  if (round.status !== 'open') throw conflict('round_closed', 'This round is closed. Its feedback is read-only.');
}

export async function updateRoundForUser(deps, { input, projectId, roundId, user }) {
  const tenantId = await requireRoundCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  let round = await loadRound(deps, { projectId, roundId, tenantId });
  ensureOpen(round);
  const now = roundsClock(deps);
  if (input.dueAt && Date.parse(input.dueAt) <= now.valueOf()) throw new HttpError(400, 'Choose a due date in the future.');
  const dueAfter = input.dueAt !== undefined ? input.dueAt : round.dueAt;
  const reminderAfter = input.reminder !== undefined ? input.reminder?.daysBefore ?? null : round.reminderDaysBefore;
  if (reminderAfter && !dueAfter) throw new HttpError(400, 'A reminder needs a due date.');

  const byId = new Map(round.reviewers.map((reviewer) => [reviewer.id, reviewer]));
  for (const id of [...(input.removeReviewerIds ?? []), ...(input.updateReviewers ?? []).map((entry) => entry.id)]) {
    if (!byId.has(id)) throw new HttpError(400, 'A reviewer in the request is not part of this round.', { details: { code: 'reviewer_invalid', reviewerId: id } });
  }
  const additions = input.addReviewers?.length
    ? await resolveReviewers(deps, { projectId, reviewers: input.addReviewers, tenantId })
    : [];

  const patch = {};
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
  if (input.note !== undefined) patch.note = input.note;
  if (input.reminder !== undefined) patch.reminderDaysBefore = input.reminder?.daysBefore ?? null;
  if (Object.keys(patch).length > 0) {
    if (!await deps.roundsRepository.updateRound({ patch, projectId, roundId, tenantId })) ensureOpen({ status: 'closed' });
  }

  const removedStakeholders = [];
  for (const reviewerId of input.removeReviewerIds ?? []) {
    const reviewer = byId.get(reviewerId);
    if (reviewer.removedAt) continue;
    await deps.roundsRepository.updateReviewer({ patch: { removedAt: now }, projectId, reviewerId, roundId, tenantId });
    if (reviewer.actorType === 'stakeholder') removedStakeholders.push(reviewer.actorId);
  }
  for (const entry of input.updateReviewers ?? []) {
    await deps.roundsRepository.updateReviewer({ patch: { required: entry.required }, projectId, reviewerId: entry.id, roundId, tenantId });
  }
  const added = additions.length > 0
    ? await deps.roundsRepository.addReviewers({ now, projectId, reviewers: additions, roundId, tenantId })
    : [];

  round = await loadRound(deps, { projectId, roundId, tenantId });
  if (added.length > 0) {
    const pkg = await loadRoundPackage(deps, { projectId, round, tenantId });
    round = await inviteReviewers(deps, { pkg, projectId, reviewerIds: added.map((reviewer) => reviewer.id), round, tenantId, user });
  }

  await publishRoundEvent(deps, {
    actor: userActor(user),
    extraStakeholderIds: removedStakeholders,
    projectId,
    reason: 'round-updated',
    round,
    tenantId,
    type: ROUND_EVENTS.rounds,
  });
  return { ok: true, round: await presentRoundDetail(deps, { projectId, round, tenantId, user }) };
}

export async function resendInvitationForUser(deps, { projectId, reviewerId, roundId, user }) {
  const tenantId = await requireRoundCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  let round = await loadRound(deps, { projectId, roundId, tenantId });
  ensureOpen(round);
  const reviewer = round.reviewers.find((item) => item.id === reviewerId && !item.removedAt);
  if (!reviewer) throw new HttpError(404, 'Reviewer not found.');
  const pkg = await loadRoundPackage(deps, { projectId, round, tenantId });
  round = await inviteReviewers(deps, { kind: 'invitation', pkg, projectId, reviewerIds: [reviewer.id], round, tenantId, user });
  await publishRoundEvent(deps, { actor: userActor(user), projectId, reason: 'invitation-resent', round, tenantId, type: ROUND_EVENTS.rounds });
  const detail = await presentRoundDetail(deps, { projectId, round, tenantId, user });
  return { ok: true, reviewer: detail.reviewers.find((item) => item.id === reviewer.id), round: detail };
}

export async function closeRoundForUser(deps, { input, projectId, roundId, user }) {
  const tenantId = tenantIdFor(user);
  await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  const round = await loadRound(deps, { projectId, roundId, tenantId });
  ensureOpen(round);
  const { closedTopics, decision, round: closed } = await closeRoundCore(deps, { input, projectId, round, tenantId, user });
  return {
    closedTopics,
    decision:{ decidedAt: decision.decidedAt, decidedBy: { name: decision.decidedByName, ref: decision.decidedBy }, id: decision.id, kind: decision.kind, statement: decision.statement },
    ok: true,
    round: await presentRoundDetail(deps, { projectId, round: closed, tenantId, user }),
  };
}

// ---------------------------------------------------------------------------
// Results and alignment (journey 6)
// ---------------------------------------------------------------------------

function latestActivity(values) {
  return values.reduce((max, value) => Math.max(max, Date.parse(value ?? '') || 0), 0);
}

/** Schedules a summary whose sources changed after its latest run when nothing is pending (after a restart). */
function catchUpSummary(deps, { activityMs, attempt, job, sourceCount }) {
  const engine = deps.requirementsSummaries;
  if (!engine?.requestRefresh || sourceCount === 0 || engine.isPending?.(job)) return;
  const lastRunMs = attempt ? Date.parse(attempt.createdAt ?? '') || 0 : 0;
  if (activityMs > lastRunMs) engine.requestRefresh(job);
}

export async function getRoundResultsForUser(deps, { projectId, roundId, user }) {
  const tenantId = await requireRoundCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const round = await loadRound(deps, { projectId, roundId, tenantId });
  const [pkg, people, feedback, summaries, attempts] = await Promise.all([
    loadRoundPackage(deps, { projectId, round, tenantId }),
    loadPeople(deps, { projectId, tenantId }),
    loadRoundFeedback(deps, { projectId, round, tenantId }),
    deps.requirementsRepository.listLatestSummaries({ projectId, tenantId }),
    deps.requirementsRepository.listLatestSummaryAttempts?.({ projectId, tenantId }) ?? [],
  ]);
  const manifest = pkg.manifest;
  const screens = manifestScreens(manifest);
  const screenVerdicts = collectScreenVerdicts(feedback.verdicts);
  const stances = collectDirectionStances(feedback.verdicts);
  const names = new Map([...people].map(([ref, person]) => [ref, person.name]));

  const reviewers = await presentReviewers(deps, { feedback, people, pkg, round });
  const gridRefs = new Set(reviewers.filter((reviewer) => !reviewer.removedAt).map((reviewer) => reviewer.actorRef));
  for (const key of screenVerdicts.keys()) gridRefs.add(key.slice(0, key.lastIndexOf('|')));

  const summaryFor = (scopeType, scopeId, screenId = null) => {
    const summary = summaries.find((item) => item.scopeType === scopeType && item.scopeId === scopeId) ?? null;
    const attempt = attempts.find((item) => item.scopeType === scopeType && item.scopeId === scopeId) ?? null;
    const { lookup, sources } = buildRoundSources({ feedback, manifest, people, round, screenFilter: screenId, track: round.track });
    const job = { projectId, scopeId, scopeType, tenantId };
    const activityMs = latestActivity([
      ...feedback.annotations.filter((item) => !screenId || item.screenId === screenId).map((item) => item.updatedAt),
      ...feedback.comments.map((item) => item.updatedAt),
      ...feedback.verdicts.filter((item) => !screenId || (item.targetType === 'screen' && item.targetId === screenId)).map((item) => item.updatedAt),
      ...(screenId ? [] : feedback.answers.map((item) => item.updatedAt)),
    ]);
    catchUpSummary(deps, { activityMs, attempt, job, sourceCount: sources.length });
    return presentScopeSummary(summary, { attempt, lookup, names, pending: Boolean(deps.requirementsSummaries?.isPending?.(job)) });
  };

  const annotationCounts = {};
  for (const screen of screens) {
    const counts = { carried: 0, open: 0, outdated: 0, resolved: 0, superseded: 0, total: 0 };
    for (const annotation of feedback.annotations.filter((item) => item.screenId === screen.id)) {
      counts[annotation.status] = (counts[annotation.status] ?? 0) + 1;
      counts.total += 1;
    }
    annotationCounts[screen.id] = counts;
  }

  return {
    annotationCounts,
    dimensions: feedbackDimensions(manifest, round.track),
    directions: manifestDirections(manifest).map((direction) => {
      const entries = [...stances].filter(([key]) => key.endsWith(`|${direction.id}`)).map(([key, stance]) => {
        const actorRef = key.slice(0, key.lastIndexOf('|'));
        return { actorRef, name: personName(people, actorRef), ...presentStance(stance) };
      });
      return {
        directionId: direction.id,
        remixNotes: entries.filter((entry) => entry.remix).map((entry) => ({ actorRef: entry.actorRef, name: entry.name, remix: entry.remix })),
        stances: entries,
        tallies: {
          acceptable: entries.filter((entry) => entry.stance === 'acceptable').length,
          preferred: entries.filter((entry) => entry.stance === 'preferred').length,
          rejected: entries.filter((entry) => entry.stance === 'rejected').length,
        },
        title: direction.title,
      };
    }),
    grid: [...gridRefs].map((actorRef) => ({
      actorRef,
      name: personName(people, actorRef),
      verdicts: Object.fromEntries(screens
        .filter((screen) => screenVerdicts.has(`${actorRef}|${screen.id}`))
        .map((screen) => {
          const verdict = screenVerdicts.get(`${actorRef}|${screen.id}`);
          return [screen.id, { ...presentVerdict(verdict), verdictId: verdict.id }];
        })),
    })),
    ok: true,
    questions: manifestQuestions(manifest).map((question) => ({
      answers: feedback.answers.filter((answer) => answer.questionId === question.id).map((answer) => {
        const actorRef = actorRefOf(answer.actorType, answer.actorId);
        return { actorRef, name: personName(people, actorRef), postedCommentId: answer.postedCommentId, text: answerText(question, answer.value), updatedAt: answer.updatedAt, value: answer.value };
      }),
      kind: question.kind,
      prompt: question.prompt,
      questionId: question.id,
      topicId: round.questionTopics?.[question.id] ?? question.topicId ?? null,
    })),
    reviewers,
    round: presentRoundSummary(round, { people, pkg }),
    screens: screens.map((screen) => ({ directionId: screen.directionId ?? null, kind: screen.kind, screenId: screen.id, title: screen.title })),
    summaries: {
      round: summaryFor(ROUND_SCOPE, round.id),
      screens: Object.fromEntries(screens.map((screen) => [screen.id, summaryFor(SCREEN_SCOPE, screenScopeId(round.id, screen.id), screen.id)])),
    },
  };
}

/** Runs a round's summary (or one screen's) now. Members and up. */
export async function refreshRoundSummaryForUser(deps, { input, projectId, roundId, user }) {
  const tenantId = await requireRoundCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const round = await loadRound(deps, { projectId, roundId, tenantId });
  const pkg = await loadRoundPackage(deps, { projectId, round, tenantId });
  if (input.screenId && !manifestScreens(pkg.manifest).some((screen) => screen.id === input.screenId)) throw new HttpError(404, 'Screen not found.');
  const engine = deps.requirementsSummaries;
  if (typeof engine?.refreshNow !== 'function') {
    throw new HttpError(503, 'ai_not_configured', { details: { code: 'ai_not_configured', message: 'Odin summaries are not configured on this server.' } });
  }
  const job = input.screenId
    ? { projectId, scopeId: screenScopeId(round.id, input.screenId), scopeType: SCREEN_SCOPE, tenantId }
    : { projectId, scopeId: round.id, scopeType: ROUND_SCOPE, tenantId };
  const result = await engine.refreshNow(job);
  if (result?.status === 'unavailable') {
    throw new HttpError(503, 'ai_not_configured', { details: { code: 'ai_not_configured', message: 'Odin summaries are not configured on this server.' } });
  }
  return {
    ok: true,
    outcome: result?.summary ? result.summary.status : (result?.reason ?? 'no-input'),
    scopeId: job.scopeId,
    scopeType: job.scopeType,
    summaryId: result?.summary?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Feedback export (package-spec.md section 8)
// ---------------------------------------------------------------------------

export function teamSnapshotPath({ projectId, roundId, snapshotId }) {
  return `/api/projects/${encodeURIComponent(projectId)}/requirements/rounds/${encodeURIComponent(roundId)}/snapshots/${encodeURIComponent(snapshotId)}`;
}

function encodeCursor(offset) {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const offset = Number(text.startsWith('o:') ? text.slice(2) : NaN);
    if (Number.isInteger(offset) && offset >= 0) return offset;
  } catch (_error) {
    // fall through
  }
  throw new HttpError(400, 'Invalid cursor.');
}

/**
 * Exactly the `odin.round-feedback/v1` shape. Fields nobody gave are omitted. Annotations
 * are paged (`limit`, default 200; `cursor` from `page.nextCursor`); every page repeats the
 * round, reviewers, directions, verdicts, answers, and summaries.
 */
/** Addresses for the package's image screens, on the review origin, or {} when it isn't configured. */
async function screenImageUrls(deps, { pkg, projectId, tenantId, user }) {
  try {
    const grant = await issuePackageGrant({
      clock: deps.clock,
      packagesRepository: deps.packagesRepository,
      reviewGrantSecret: deps.reviewGrantSecret,
      reviewPublicUrl: deps.reviewPublicUrl,
    }, { packageId: pkg.id, projectId, tenantId, viewerRef: actorRefOf('user', user.id) });
    return grant.entryUrls;
  } catch (error) {
    if (error?.details?.code === 'review_origin_not_configured') return {};
    throw error;
  }
}

/**
 * Everyone involved in a mark, once each, in this order: who posted it, who commented, and
 * who was tagged in a comment. A person who did more than one has every role.
 */
function markParticipants({ authorName, authorRef, thread }, people) {
  const byRef = new Map();
  const add = (ref, role, fallback) => {
    if (!ref) return;
    const entry = byRef.get(ref) ?? { name: personName(people, ref, fallback), ref, roles: [] };
    if (!entry.roles.includes(role)) entry.roles.push(role);
    byRef.set(ref, entry);
  };
  add(authorRef, 'posted', authorName);
  for (const comment of thread) add(comment.authorRef, 'commented', comment.authorName);
  for (const comment of thread) for (const actor of mentionedActors(comment.body)) add(actor.actorRef, 'tagged', actor.label);
  return [...byRef.values()];
}

/**
 * Every mark and comment in a round, and each reviewer's written screen notes, for the
 * team's "Marks and comments" view. Marks come in screen order, then by number, with their
 * shapes, the snapshot they sit on, and everyone involved. Image screens carry an address on
 * the review origin, so the view can show each mark on its screen. Comment labels (C1, C2,
 * ...) are the ones the round's Odin summary cites.
 */
export async function getRoundAnnotationsForUser(deps, { projectId, roundId, user }) {
  const tenantId = await requireRoundCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const round = await loadRound(deps, { projectId, roundId, tenantId });
  const [pkg, people, feedback] = await Promise.all([
    loadRoundPackage(deps, { projectId, round, tenantId }),
    loadPeople(deps, { projectId, tenantId }),
    loadRoundFeedback(deps, { projectId, round, tenantId }),
  ]);
  const imageUrls = await screenImageUrls(deps, { pkg, projectId, tenantId, user });
  const manifest = pkg.manifest;
  const screens = manifestScreens(manifest);
  const screenOrder = new Map(screens.map((screen, index) => [screen.id, index]));
  const dimensions = feedbackDimensions(manifest, round.track);
  const dimensionLabel = new Map(dimensions.map((dimension) => [dimension.key, dimension.label]));
  const { lookup } = buildRoundSources({ feedback, manifest, people, round, track: round.track });
  const stateLabels = new Map(screens.flatMap((screen) => (screen.states ?? []).map((state) => [`${screen.id}|${state.key}`, state.label || state.key])));

  const annotations = feedback.annotations
    .filter((annotation) => screenOrder.has(annotation.screenId))
    .sort((left, right) => (screenOrder.get(left.screenId) - screenOrder.get(right.screenId)) || (Number(left.number ?? 0) - Number(right.number ?? 0)))
    .map((annotation) => {
      const presented = presentAnnotation(annotation, { comments: feedback.comments, people, projectId, round });
      const thread = presented.thread
        .filter((comment) => !comment.isDeleted && String(comment.body ?? '').trim())
        .map((comment) => ({
          authorName: comment.authorName,
          authorRef: comment.authorRef,
          body: comment.body,
          createdAt: comment.createdAt,
          id: comment.id,
          label: lookup.get(`comment:${comment.id}`)?.label ?? '',
          parentCommentId: comment.parentCommentId ?? null,
        }));
      return {
        authorName: presented.authorName,
        authorRef: presented.authorRef,
        category: presented.category ?? null,
        categoryLabel: presented.category ? dimensionLabel.get(presented.category) ?? presented.category : '',
        color: presented.color,
        createdAt: presented.createdAt,
        elementText: String(annotation.elementHint?.text ?? '').trim(),
        id: presented.id,
        labels: (annotation.shapes ?? []).filter((shape) => shape.type === 'text' && String(shape.text ?? '').trim()).map((shape) => shape.text.trim()),
        lastActivityAt: [presented.createdAt, ...thread.map((comment) => comment.createdAt)].filter(Boolean).sort().at(-1) ?? null,
        note: String(annotation.anchor?.note ?? '').trim(),
        number: presented.number,
        participants: markParticipants({ authorName: presented.authorName, authorRef: presented.authorRef, thread }, people),
        screenId: presented.screenId,
        shapes: presented.shapes ?? [],
        snapshotUnavailable: Boolean(annotation.anchor?.snapshotUnavailable),
        snapshotUrl: presented.snapshotFileId ? teamSnapshotPath({ projectId, roundId: round.id, snapshotId: presented.snapshotFileId }) : null,
        stateKey: presented.stateKey ?? null,
        stateLabel: presented.stateKey ? stateLabels.get(`${presented.screenId}|${presented.stateKey}`) ?? presented.stateKey : '',
        status: presented.status,
        thread,
      };
    });

  const notes = [];
  for (const [key, verdict] of collectScreenVerdicts(feedback.verdicts)) {
    const separator = key.lastIndexOf('|');
    const actorRef = key.slice(0, separator);
    const screenId = key.slice(separator + 1);
    if (!screenOrder.has(screenId) || !(verdict.stay || verdict.change || verdict.mixed)) continue;
    notes.push({ actorRef, name: personName(people, actorRef), screenId, ...presentVerdict(verdict) });
  }
  notes.sort((left, right) => (screenOrder.get(left.screenId) - screenOrder.get(right.screenId)) || left.name.localeCompare(right.name));

  return {
    annotations,
    notes,
    ok: true,
    round: presentRoundSummary(round, { people, pkg }),
    screens: screens.map((screen) => ({
      height: screen.height ?? null,
      imageUrl: screen.kind === 'image' ? imageUrls[screen.id] ?? null : null,
      kind: screen.kind,
      screenId: screen.id,
      title: screen.title,
      viewport: screen.viewport ?? null,
      width: screen.width ?? null,
    })),
  };
}

export async function getRoundFeedbackForUser(deps, { projectId, query = {}, roundId, user }) {
  const tenantId = await requireRoundCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const round = await loadRound(deps, { projectId, roundId, tenantId });
  const [pkg, people, feedback, summaries] = await Promise.all([
    loadRoundPackage(deps, { projectId, round, tenantId }),
    loadPeople(deps, { projectId, tenantId }),
    loadRoundFeedback(deps, { projectId, round, tenantId }),
    deps.requirementsRepository.listLatestSummaries({ projectId, tenantId }),
  ]);
  const limit = query.limit ?? DEFAULT_FEEDBACK_PAGE_SIZE;
  const offset = decodeCursor(query.cursor);
  const base = String(deps.backendPublicUrl ?? '').replace(/\/+$/, '');
  const snapshotUrl = (snapshotId) => `${base}${teamSnapshotPath({ projectId, roundId: round.id, snapshotId })}`;
  const screens = manifestScreens(pkg.manifest);
  const screenOrder = new Map(screens.map((screen, index) => [screen.id, index]));
  const screenVerdicts = collectScreenVerdicts(feedback.verdicts);
  const stances = collectDirectionStances(feedback.verdicts);
  const split = (key) => [key.slice(0, key.lastIndexOf('|')), key.slice(key.lastIndexOf('|') + 1)];

  const annotations = [...feedback.annotations].sort((left, right) => ((screenOrder.get(left.screenId) ?? 99) - (screenOrder.get(right.screenId) ?? 99))
    || (Number(left.number ?? 0) - Number(right.number ?? 0)));
  const pageOfAnnotations = annotations.slice(offset, offset + limit);
  const roundSummary = summaries.find((item) => item.scopeType === ROUND_SCOPE && item.scopeId === round.id) ?? null;
  const screenSummaries = {};
  for (const screen of screens) {
    const summary = summaries.find((item) => item.scopeType === SCREEN_SCOPE && item.scopeId === screenScopeId(round.id, screen.id));
    if (summary?.output) screenSummaries[screen.id] = summary.output;
  }

  return {
    schema: FEEDBACK_SCHEMA,
    round: {
      ...(round.dueAt ? { dueAt: round.dueAt } : {}),
      id: round.id,
      number: round.number,
      packageVersion: pkg.version,
      status: round.status,
      track: round.track,
    },
    reviewers: round.reviewers.filter((reviewer) => !reviewer.removedAt).map((reviewer) => {
      const actorRef = actorRefOf(reviewer.actorType, reviewer.actorId);
      return { actorRef, name: personName(people, actorRef), required: reviewer.required, submittedAt: reviewer.submittedAt ?? null };
    }),
    directions: [...stances].map(([key, stance]) => {
      const [actorRef, directionId] = split(key);
      return { actorRef, directionId, ...(stance.remix ? { remix: stance.remix } : {}), stance: stance.stance };
    }),
    verdicts: [...screenVerdicts].map(([key, verdict]) => {
      const [actorRef, screenId] = split(key);
      return {
        actorRef,
        screenId,
        overall: verdict.overall,
        ...(Object.keys(verdict.dimensions).length > 0 ? { dimensions: { ...verdict.dimensions } } : {}),
        ...(verdict.stay ? { stay: verdict.stay } : {}),
        ...(verdict.change ? { change: verdict.change } : {}),
        ...(verdict.mixed ? { mixed: verdict.mixed } : {}),
      };
    }),
    annotations: pageOfAnnotations.map((annotation) => ({
      id: annotation.id,
      screenId: annotation.screenId,
      stateKey: annotation.stateKey ?? null,
      snapshotUrl: annotation.snapshotFileId ? snapshotUrl(annotation.snapshotFileId) : null,
      actorRef: actorRefOf(annotation.authorType, annotation.authorId),
      ...(annotation.category ? { category: annotation.category } : {}),
      status: annotation.status,
      elementHint: annotation.elementHint ?? null,
      shapes: annotation.shapes,
      thread: feedback.comments
        .filter((comment) => comment.annotationId === annotation.id && !comment.deletedAt)
        .map((comment) => ({ actorRef: actorRefOf(comment.authorType, comment.authorId), body: comment.body, createdAt: comment.createdAt })),
    })),
    answers: feedback.answers.map((answer) => ({
      actorRef: actorRefOf(answer.actorType, answer.actorId),
      questionId: answer.questionId,
      value: answer.value,
      ...(answer.postedCommentId ? { postedCommentId: answer.postedCommentId } : {}),
    })),
    summaries: {
      ...(roundSummary?.output ? { round: roundSummary.output } : {}),
      screens: screenSummaries,
    },
    page: {
      annotationsTotal: annotations.length,
      limit,
      nextCursor: offset + limit < annotations.length ? encodeCursor(offset + limit) : null,
    },
  };
}
