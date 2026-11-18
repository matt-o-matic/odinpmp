import { createHash, randomUUID } from 'node:crypto';

import { resolveDecisionRights } from '../../../lib/auth/decision-rights.js';
import { PROJECT_CAPABILITIES } from '../../../lib/auth/project-capabilities.js';
import { HttpError } from '../../../lib/errors/http-error.js';
import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { readImageSize } from '../packages/image-size.js';
import { issuePackageGrant } from '../packages/packages.service.js';
import { isRemovedTopic, loadRemovedQuestionIds, QUESTION_REMOVED, questionRemovedError, questionTopicId } from '../removed-questions.js';
import { publishRequirementsChange, REQUIREMENTS_EVENTS } from '../requirements-events.js';
import { resolvePortalAccess } from '../requirements-portal.service.js';
import { findTopicComment, topicCommentsOpen } from '../requirements-topics.js';
import { numberPins, validateShapes } from './annotation-shapes.js';
import { publishRoundEvent, ROUND_EVENTS } from './round-events.js';
import {
  answerCommentBody,
  answerText,
  feedbackDimensions,
  manifestDirections,
  manifestQuestions,
  manifestScreens,
  validateAnswerValue,
} from './round-manifest.js';
import { inspectPng, snapshotStorageKey } from './round-snapshots.js';
import { requestRoundSummaryRefresh } from './round-summaries.js';
import {
  actorRefOf,
  collectDirectionStances,
  collectScreenVerdicts,
  computeProgress,
  loadPeople,
  personName,
  portalPersonKey,
  presentAnnotation,
  presentStance,
  presentVerdict,
} from './round-views.js';
import { DIMENSION_PREFIX, OVERALL_DIMENSION } from './rounds.repository.js';
import { requireRoundCapability, roundsClock, teamSnapshotPath } from './rounds.service.js';
import { toPortalMentions } from '../mentions/mention-tokens.js';
import { portalAnnotationPeople, prepareMentions, presentMentionables, recordMentions, recordTopicReplies, teamAnnotationPeople } from '../mentions/mentions.service.js';

// The review API. One service behind two route sets:
//   - team members through /api/projects/:projectId/requirements/rounds/:roundId/review,
//     with project.collaborate. Any collaborator may annotate and comment; directions,
//     verdicts, answers, and submit need an invitation to the round;
//   - stakeholders through /api/public/requirements/:token/rounds/:roundId, only for rounds
//     they are invited to, with a valid link.
// Closed rounds are read-only. Annotation saves are cheap: they publish a live event and
// ask the summary engine for a debounced refresh, never a model call per keypress.

const LAST_SEEN_INTERVAL_MS = 60_000;
const IMAGE_SIZE_CACHE_LIMIT = 1000;
const imageSizeCache = new Map();

function conflict(code, message, details = {}) {
  return new HttpError(409, message, { details: { code, ...details } });
}

function badRequest(code, message, details = {}) {
  return new HttpError(400, message, { details: { code, ...details } });
}

// ---------------------------------------------------------------------------
// Actors and context
// ---------------------------------------------------------------------------

/** A signed-in team member with project.collaborate. */
export async function teamReviewActor(deps, { projectId, user }) {
  const tenantId = await requireRoundCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const rights = await resolveDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  return {
    actorId: user.id,
    actorRef: actorRefOf('user', user.id),
    actorType: 'user',
    audience: 'team',
    canModerate: rights.allowed,
    name: user.name ?? '',
    projectId,
    tenantId,
  };
}

/** A stakeholder holding a valid requirements link. */
export async function portalReviewActor(deps, { token }) {
  const access = await resolvePortalAccess(deps, { token });
  return {
    actorId: access.stakeholder.id,
    actorRef: actorRefOf('stakeholder', access.stakeholder.id),
    actorType: 'stakeholder',
    audience: 'portal',
    canModerate: false,
    linkId: access.link.id,
    name: access.stakeholder.name ?? '',
    projectId: access.projectId,
    tenantId: access.tenantId,
    token,
    tokenId: access.tokenId,
  };
}

/**
 * Loads a round for an actor. Stakeholders see only rounds they are invited to (and not
 * removed from); every other round is 404 for them.
 */
export async function loadReviewContext(deps, actor, roundId) {
  const { projectId, tenantId } = actor;
  const round = await deps.roundsRepository.getRound({ projectId, roundId, tenantId });
  if (!round || round.status === 'draft') throw new HttpError(404, 'Round not found.');
  const reviewer = round.reviewers.find((item) => item.actorType === actor.actorType && item.actorId === actor.actorId && !item.removedAt) ?? null;
  if (actor.audience === 'portal' && !reviewer) throw new HttpError(404, 'Round not found.');
  const pkg = await deps.packagesRepository.getPackage({ packageId: round.packageId, projectId, tenantId });
  if (!pkg) throw new HttpError(404, 'Round not found.');
  return { actor, pkg, projectId, reviewer, round, tenantId };
}

function ensureOpen(ctx) {
  if (ctx.round.status !== 'open') throw conflict('round_closed', 'This round is closed. Its feedback is read-only.');
}

function ensureReviewer(ctx) {
  if (!ctx.reviewer) {
    throw new HttpError(403, 'Only invited reviewers can give verdicts, answers, and submit.', { details: { code: 'not_a_reviewer' } });
  }
}

function actorForEvents(ctx) {
  return ctx.actor.audience === 'team' ? { id: ctx.actor.actorId, name: ctx.actor.name } : { name: ctx.actor.name, type: 'stakeholder' };
}

async function notify(deps, ctx, { annotationId = null, reason, screenId = null, type = ROUND_EVENTS.review }) {
  await publishRoundEvent(deps, {
    actor: actorForEvents(ctx),
    annotationId,
    projectId: ctx.projectId,
    reason,
    round: ctx.round,
    screenId,
    tenantId: ctx.tenantId,
    type,
  });
}

function snapshotUrlFor(ctx) {
  if (ctx.actor.audience === 'portal') {
    return (snapshotId) => `/api/public/requirements/${encodeURIComponent(ctx.actor.token)}/rounds/${encodeURIComponent(ctx.round.id)}/snapshots/${encodeURIComponent(snapshotId)}`;
  }
  return (snapshotId) => teamSnapshotPath({ projectId: ctx.projectId, roundId: ctx.round.id, snapshotId });
}

function viewerRef(ctx) {
  return ctx.actor.actorRef;
}

/** The portal never sees actor ids, including those inside mention tags. */
function threadBodyPresenter(ctx) {
  return ctx.actor.audience === 'portal' ? (body) => toPortalMentions(body, ctx.projectId) : null;
}

function publicActorRef(ctx, actorRef) {
  return ctx.actor.audience === 'portal' ? portalPersonKey(ctx.projectId, actorRef) : actorRef;
}

async function myVerdicts(deps, ctx) {
  const rows = (await deps.roundsRepository.listVerdicts({ roundIds: [ctx.round.id] }))
    .filter((row) => row.actorType === ctx.actor.actorType && row.actorId === ctx.actor.actorId);
  return { screenVerdicts: collectScreenVerdicts(rows), stances: collectDirectionStances(rows) };
}

/** Questions of this round whose topic was deleted or dismissed; they no longer take answers. */
function removedQuestions(deps, ctx) {
  return loadRemovedQuestionIds(deps, { manifest: ctx.pkg.manifest, projectId: ctx.projectId, round: ctx.round, tenantId: ctx.tenantId });
}

async function myProgress(deps, ctx) {
  const [{ screenVerdicts, stances }, answers, removedQuestionIds] = await Promise.all([
    myVerdicts(deps, ctx),
    deps.roundsRepository.listAnswers({ roundIds: [ctx.round.id] }),
    removedQuestions(deps, ctx),
  ]);
  return computeProgress({ actorRef: ctx.actor.actorRef, answers, manifest: ctx.pkg.manifest, removedQuestionIds, screenVerdicts, stances });
}

/** Earlier rounds of the round's track, newest first. */
async function earlierRounds(deps, ctx) {
  const rounds = await deps.roundsRepository.listRounds({ projectId: ctx.projectId, tenantId: ctx.tenantId, track: ctx.round.track });
  return rounds.filter((round) => round.number < ctx.round.number).sort((left, right) => right.number - left.number);
}

/**
 * Annotations a reviewer sees in a round: the round's own (every reviewer's layer), plus
 * outdated ones from earlier rounds on screens this package still has, so their authors
 * can carry them forward or close them.
 */
async function visibleAnnotations(deps, ctx) {
  const earlier = await earlierRounds(deps, ctx);
  const screenIds = new Set(ctx.pkg.screens.map((screen) => screen.screenId));
  const [own, previous] = await Promise.all([
    deps.roundsRepository.listAnnotations({ projectId: ctx.projectId, roundIds: [ctx.round.id], tenantId: ctx.tenantId }),
    earlier.length > 0
      ? deps.roundsRepository.listAnnotations({ projectId: ctx.projectId, roundIds: earlier.map((round) => round.id), tenantId: ctx.tenantId })
      : [],
  ]);
  const outdated = previous.filter((annotation) => annotation.status === 'outdated' && screenIds.has(annotation.screenId));
  return {
    annotations: [...own, ...outdated],
    roundNumbers: new Map([[ctx.round.id, ctx.round.number], ...earlier.map((round) => [round.id, round.number])]),
  };
}

async function presentOne(deps, ctx, annotation, { people = null } = {}) {
  const [comments, resolvedPeople, rounds] = await Promise.all([
    deps.roundsRepository.listComments({ annotationIds: [annotation.id] }),
    people ?? loadPeople(deps, { projectId: ctx.projectId, tenantId: ctx.tenantId }),
    annotation.roundId === ctx.round.id ? [] : earlierRounds(deps, ctx),
  ]);
  return presentAnnotation(annotation, {
    audience: ctx.actor.audience,
    canModerate: ctx.actor.canModerate,
    comments,
    people: resolvedPeople,
    presentBody: threadBodyPresenter(ctx),
    projectId: ctx.projectId,
    round: ctx.round,
    roundNumbers: new Map([[ctx.round.id, ctx.round.number], ...rounds.map((round) => [round.id, round.number])]),
    snapshotUrl: snapshotUrlFor(ctx),
    viewerRef: viewerRef(ctx),
  });
}

// ---------------------------------------------------------------------------
// Review state
// ---------------------------------------------------------------------------

function grantDeps(deps) {
  return {
    clock: deps.clock,
    packagesRepository: deps.packagesRepository,
    reviewGrantSecret: deps.reviewGrantSecret,
    reviewPublicUrl: deps.reviewPublicUrl,
  };
}

async function issueGrant(deps, ctx) {
  try {
    return await issuePackageGrant(grantDeps(deps), {
      linkId: ctx.actor.linkId ?? null,
      packageId: ctx.pkg.id,
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
      tokenId: ctx.actor.tokenId ?? null,
      viewerRef: ctx.actor.actorRef,
    });
  } catch (error) {
    if (error?.details?.code === 'review_origin_not_configured') return null;
    throw error;
  }
}

/** Who published the round, by name only ("Mia asked you to review..."). Never an id. */
function publishedByOf(people, round) {
  return round?.publishedBy ? { name: personName(people, round.publishedBy) } : null;
}

function portalManifest(manifest) {
  // The generator block is an audit record and never shown to reviewers.
  const { basedOnRoundId: _based, generator: _generator, ...rest } = manifest ?? {};
  return rest;
}

export async function getReviewState(deps, ctx) {
  const now = roundsClock(deps);
  const { pkg, round } = ctx;
  const manifest = pkg.manifest;
  const earlier = await earlierRounds(deps, ctx);
  const [visible, people, grant, verdictRows, answers, previousAnswers, baseline, removed] = await Promise.all([
    visibleAnnotations(deps, ctx),
    loadPeople(deps, { projectId: ctx.projectId, tenantId: ctx.tenantId }),
    issueGrant(deps, ctx),
    deps.roundsRepository.listVerdicts({ roundIds: [round.id] }),
    deps.roundsRepository.listAnswers({ roundIds: [round.id] }),
    earlier.length > 0 ? deps.roundsRepository.listAnswers({ roundIds: earlier.map((item) => item.id) }) : [],
    deps.packagesRepository.findBaselinePackage?.({ beforeVersion: pkg.version, projectId: ctx.projectId, tenantId: ctx.tenantId, track: round.track }) ?? null,
    removedQuestions(deps, ctx),
  ]);
  const comments = await deps.roundsRepository.listComments({ annotationIds: visible.annotations.map((annotation) => annotation.id) });
  const mine = (row) => row.actorType === ctx.actor.actorType && row.actorId === ctx.actor.actorId;
  const myRows = verdictRows.filter(mine);
  const screenVerdicts = collectScreenVerdicts(myRows);
  const stances = collectDirectionStances(myRows);
  const myAnswers = answers.filter(mine);
  const actorRef = ctx.actor.actorRef;
  const questions = manifestQuestions(manifest);
  // Removed questions are listed without their answers: answers stay stored but are no longer asked for.
  const questionById = new Map(questions.filter((question) => !removed.has(question.id)).map((question) => [question.id, question]));
  const answeredHere = new Set(myAnswers.map((answer) => answer.questionId));

  // Answers carry forward by question id: shown as given on an earlier version, not re-submitted.
  const roundById = new Map(earlier.map((item) => [item.id, item]));
  const carriedAnswers = {};
  for (const answer of previousAnswers.filter(mine).sort((left, right) => roundById.get(right.roundId).number - roundById.get(left.roundId).number)) {
    const question = questionById.get(answer.questionId);
    if (!question || answeredHere.has(answer.questionId) || carriedAnswers[answer.questionId]) continue;
    if (!validateAnswerValue(question, answer.value).ok) continue;
    const source = roundById.get(answer.roundId);
    const sourcePackage = await deps.packagesRepository.getPackage({ packageId: source.packageId, projectId: ctx.projectId, tenantId: ctx.tenantId });
    carriedAnswers[answer.questionId] = {
      answeredAt: answer.updatedAt,
      packageVersion: sourcePackage?.version ?? null,
      roundId: source.id,
      roundNumber: source.number,
      text: answerText(question, answer.value),
      value: answer.value,
    };
  }

  if (ctx.reviewer && round.status === 'open') {
    const lastSeen = Date.parse(ctx.reviewer.lastSeenAt ?? '') || 0;
    if (now.valueOf() - lastSeen > LAST_SEEN_INTERVAL_MS) {
      await deps.roundsRepository.updateReviewer({ patch: { lastSeenAt: now }, projectId: ctx.projectId, reviewerId: ctx.reviewer.id, roundId: round.id, tenantId: ctx.tenantId });
    }
  }

  const baselineScreens = new Map((baseline?.screens ?? []).map((screen) => [screen.screenId, screen]));
  const stored = new Map(pkg.screens.map((screen) => [screen.screenId, screen]));
  return {
    annotations: visible.annotations.map((annotation) => presentAnnotation(annotation, {
      audience: ctx.actor.audience,
      canModerate: ctx.actor.canModerate,
      comments,
      people,
      presentBody: threadBodyPresenter(ctx),
      projectId: ctx.projectId,
      round,
      roundNumbers: visible.roundNumbers,
      snapshotUrl: snapshotUrlFor(ctx),
      viewerRef: actorRef,
    })),
    answers: Object.fromEntries(myAnswers.filter((answer) => questionById.has(answer.questionId)).map((answer) => [answer.questionId, {
      ...(answer.postedCommentId ? { postedCommentId: answer.postedCommentId } : {}),
      text: answerText(questionById.get(answer.questionId), answer.value),
      topicId: answer.topicId,
      updatedAt: answer.updatedAt,
      value: answer.value,
    }])),
    directions: Object.fromEntries(manifestDirections(manifest)
      .filter((direction) => stances.has(`${actorRef}|${direction.id}`))
      .map((direction) => [direction.id, presentStance(stances.get(`${actorRef}|${direction.id}`))])),
    grant: grant ? { expiresAt: grant.expiresAt } : null,
    me: {
      actorRef: publicActorRef(ctx, actorRef),
      canModerate: ctx.actor.canModerate,
      canSubmit: Boolean(ctx.reviewer) && round.status === 'open',
      isReviewer: Boolean(ctx.reviewer),
      name: ctx.actor.name,
      position: ctx.reviewer?.position ?? null,
      required: Boolean(ctx.reviewer?.required),
      submittedAt: ctx.reviewer?.submittedAt ?? null,
    },
    ok: true,
    package: {
      feedbackDimensions: feedbackDimensions(manifest, round.track),
      id: pkg.id,
      manifest: ctx.actor.audience === 'portal' ? portalManifest(manifest) : manifest,
      title: pkg.title,
      version: pkg.version,
    },
    previousAnswers: carriedAnswers,
    progress: computeProgress({ actorRef, answers, manifest, removedQuestionIds: removed, screenVerdicts, stances }),
    questions: questions.map((question) => ({
      help: question.help ?? '',
      id: question.id,
      kind: question.kind,
      options: question.options ?? [],
      prompt: question.prompt,
      removed: removed.has(question.id),
      scale: question.scale ?? null,
      topicId: questionTopicId(round, question),
    })),
    round: {
      closedAt: round.closedAt,
      dueAt: round.dueAt,
      id: round.id,
      note: round.note,
      number: round.number,
      outcome: round.outcome,
      packageVersion: pkg.version,
      publishedAt: round.publishedAt,
      publishedBy: publishedByOf(people, round),
      readOnly: round.status !== 'open',
      status: round.status,
      title: pkg.title,
      track: round.track,
    },
    screens: manifestScreens(manifest).map((screen) => {
      const record = stored.get(screen.id);
      const before = baselineScreens.get(screen.id);
      return {
        alt: screen.alt ?? '',
        change: !baseline ? null : !before ? 'new' : before.contentHash === record?.contentHash ? 'unchanged' : 'changed',
        changeNote: screen.changeNote ?? '',
        directionId: screen.directionId ?? null,
        entryUrl: grant?.entryUrls?.[screen.id] ?? null,
        height: screen.height ?? null,
        kind: screen.kind,
        rationale: screen.rationale ?? '',
        screenId: screen.id,
        states: screen.states ?? [],
        title: screen.title,
        viewport: screen.viewport ?? null,
        width: screen.width ?? null,
      };
    }),
    verdicts: Object.fromEntries(manifestScreens(manifest)
      .filter((screen) => screenVerdicts.has(`${actorRef}|${screen.id}`))
      .map((screen) => [screen.id, presentVerdict(screenVerdicts.get(`${actorRef}|${screen.id}`))])),
  };
}

export async function setPosition(deps, ctx, input) {
  ensureOpen(ctx);
  ensureReviewer(ctx);
  const position = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
  await deps.roundsRepository.updateReviewer({
    patch: { lastSeenAt: roundsClock(deps), position },
    projectId: ctx.projectId,
    reviewerId: ctx.reviewer.id,
    roundId: ctx.round.id,
    tenantId: ctx.tenantId,
  });
  return { ok: true, position };
}

// ---------------------------------------------------------------------------
// Directions and verdicts
// ---------------------------------------------------------------------------

function findDirection(ctx, directionId) {
  const direction = manifestDirections(ctx.pkg.manifest).find((item) => item.id === directionId);
  if (!direction) throw new HttpError(404, 'Direction not found.');
  return direction;
}

function findScreen(ctx, screenId) {
  const screen = manifestScreens(ctx.pkg.manifest).find((item) => item.id === screenId);
  if (!screen) throw new HttpError(404, 'Screen not found.');
  return screen;
}

async function replaceMyVerdict(deps, ctx, { rows, targetId, targetType }) {
  return deps.roundsRepository.replaceVerdict({
    actorId: ctx.actor.actorId,
    actorType: ctx.actor.actorType,
    now: roundsClock(deps),
    projectId: ctx.projectId,
    roundId: ctx.round.id,
    rows,
    targetId,
    targetType,
    tenantId: ctx.tenantId,
  });
}

export async function putDirection(deps, ctx, { directionId, input }) {
  ensureOpen(ctx);
  ensureReviewer(ctx);
  findDirection(ctx, directionId);
  const rows = await replaceMyVerdict(deps, ctx, {
    rows: [{ changeNote: '', dimension: OVERALL_DIMENSION, keepNote: input.remix, mixedNote: '', value: input.stance }],
    targetId: directionId,
    targetType: 'direction',
  });
  await notify(deps, ctx, { reason: 'direction-saved' });
  requestRoundSummaryRefresh(deps, { projectId: ctx.projectId, roundId: ctx.round.id, tenantId: ctx.tenantId });
  const stance = collectDirectionStances(rows).get(`${ctx.actor.actorRef}|${directionId}`);
  return { direction: presentStance(stance), directionId, ok: true, progress: await myProgress(deps, ctx) };
}

export async function deleteDirection(deps, ctx, { directionId }) {
  ensureOpen(ctx);
  ensureReviewer(ctx);
  findDirection(ctx, directionId);
  await replaceMyVerdict(deps, ctx, { rows: [], targetId: directionId, targetType: 'direction' });
  await notify(deps, ctx, { reason: 'direction-cleared' });
  requestRoundSummaryRefresh(deps, { projectId: ctx.projectId, roundId: ctx.round.id, tenantId: ctx.tenantId });
  return { direction: null, directionId, ok: true, progress: await myProgress(deps, ctx) };
}

export async function putVerdict(deps, ctx, { input, screenId }) {
  ensureOpen(ctx);
  ensureReviewer(ctx);
  findScreen(ctx, screenId);
  const allowed = new Set(feedbackDimensions(ctx.pkg.manifest, ctx.round.track).map((dimension) => dimension.key));
  const unknown = Object.keys(input.dimensions).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw badRequest('dimension_invalid', 'Rate only this package\'s feedback dimensions.', { dimensions: unknown });

  const rows = [
    { changeNote: input.change, dimension: OVERALL_DIMENSION, keepNote: input.stay, mixedNote: input.mixed, value: input.overall },
    ...Object.entries(input.dimensions).map(([key, value]) => ({ changeNote: '', dimension: `${DIMENSION_PREFIX}${key}`, keepNote: '', mixedNote: '', value })),
  ];
  const stored = await replaceMyVerdict(deps, ctx, { rows, targetId: screenId, targetType: 'screen' });
  await notify(deps, ctx, { reason: 'verdict-saved', screenId });
  requestRoundSummaryRefresh(deps, { projectId: ctx.projectId, roundId: ctx.round.id, screenId, tenantId: ctx.tenantId });
  const verdict = collectScreenVerdicts(stored).get(`${ctx.actor.actorRef}|${screenId}`);
  return { ok: true, progress: await myProgress(deps, ctx), screenId, verdict: presentVerdict(verdict) };
}

export async function deleteVerdict(deps, ctx, { screenId }) {
  ensureOpen(ctx);
  ensureReviewer(ctx);
  findScreen(ctx, screenId);
  await replaceMyVerdict(deps, ctx, { rows: [], targetId: screenId, targetType: 'screen' });
  await notify(deps, ctx, { reason: 'verdict-cleared', screenId });
  requestRoundSummaryRefresh(deps, { projectId: ctx.projectId, roundId: ctx.round.id, screenId, tenantId: ctx.tenantId });
  return { ok: true, progress: await myProgress(deps, ctx), screenId, verdict: null };
}

// ---------------------------------------------------------------------------
// Answers (posted into the linked topic's thread)
// ---------------------------------------------------------------------------

function findQuestion(ctx, questionId) {
  const question = manifestQuestions(ctx.pkg.manifest).find((item) => item.id === questionId);
  if (!question) throw new HttpError(404, 'Question not found.');
  return question;
}

/** The reviewer's stored answer to one question, or null. */
async function myAnswer(deps, ctx, questionId) {
  const answers = await deps.roundsRepository.listAnswers({ roundIds: [ctx.round.id] });
  return answers.find((item) => item.questionId === questionId && item.actorType === ctx.actor.actorType && item.actorId === ctx.actor.actorId) ?? null;
}

/** A question whose topic was deleted or dismissed takes no new answers, and its stored answers are kept. */
async function ensureQuestionAnswerable(deps, ctx, question) {
  if ((await removedQuestions(deps, ctx)).has(question.id)) throw questionRemovedError();
}

async function notifyTopic(deps, ctx, { reason, topicId }) {
  const track = await deps.requirementsRepository.getTopicTrack({ clarificationId: topicId, projectId: ctx.projectId, tenantId: ctx.tenantId });
  await publishRequirementsChange({
    actor: actorForEvents(ctx),
    liveEventBus: deps.liveEventBus,
    projectId: ctx.projectId,
    reason,
    requirementsRepository: deps.requirementsRepository,
    tenantId: ctx.tenantId,
    topicIds: [topicId],
    track,
    type: REQUIREMENTS_EVENTS.topics,
  });
  deps.requirementsSummaries?.noteTopicActivity?.({ projectId: ctx.projectId, reason, tenantId: ctx.tenantId, topicIds: [topicId] });
}

/**
 * The id of an answer's `index`-th topic comment: the answer's own id, then a stable UUID per
 * later comment (one is needed only after someone deleted the earlier comment). Saving and
 * clearing walk the same sequence, so a comment that an interrupted save posted but never
 * linked to the answer is still found.
 */
function answerCommentId(answerId, index) {
  if (index === 0) return answerId;
  const bytes = createHash('sha256').update(`${answerId}:${index}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The answer's comments in the topic thread: `live` (the reviewer's, not deleted, the linked
 * one first) and `nextId`, the first id in the sequence that no comment has taken yet.
 */
function answerComments(clarification, answer, actor) {
  const mine = (comment) => Boolean(comment) && !comment.deletedAt && comment.actorType === actor.actorType && comment.actorId === actor.actorId;
  const live = [];
  let nextId = null;
  for (let index = 0; nextId === null; index += 1) {
    const id = answerCommentId(answer.id, index);
    const comment = findTopicComment(clarification, id);
    if (!comment) nextId = id;
    else if (mine(comment)) live.push(comment);
  }
  const linked = answer.postedCommentId ? findTopicComment(clarification, answer.postedCommentId) : null;
  const ordered = mine(linked) ? [linked, ...live.filter((comment) => comment.id !== linked.id)] : live;
  return { live: ordered, nextId };
}

/**
 * Posts the answer into its topic's thread as the reviewer, or edits the comment it posted
 * before. Topics whose comments are closed (dismissed, or closed without a decision) keep
 * the answer in the round only. A topic deleted or dismissed since the answerable check
 * throws question_removed. Returns the answer with its posted comment id. Safe to repeat after a
 * failure: comment ids come from answerCommentId, so a retry links a comment an earlier
 * attempt posted instead of posting a second one.
 */
async function postAnswerToTopic(deps, ctx, { answer, question, topicId }) {
  if (!topicId) return answer;
  const { projectId, tenantId } = ctx;
  const clarification = await deps.assistantRepository.getProjectClarification({ clarificationId: topicId, projectId, tenantId });
  if (isRemovedTopic(clarification)) throw questionRemovedError();
  const decisions = await deps.requirementsRepository.listDecisions({ kind: 'topic', projectId, tenantId, topicId });
  if (!topicCommentsOpen({ hasActiveDecision: decisions.some((decision) => !decision.supersededById), status: clarification.status })) return answer;

  const body = answerCommentBody({ question, roundNumber: ctx.round.number, value: answer.value });
  const { live, nextId } = answerComments(clarification, answer, ctx.actor);
  const existing = live[0] ?? null;
  if (existing) {
    const edited = existing.body !== body;
    if (edited) {
      await deps.assistantRepository.updateProjectClarificationComment({ body, clarificationId: topicId, commentId: existing.id, preserveStatus: true, projectId, tenantId });
    }
    const linked = existing.id === answer.postedCommentId
      ? answer
      : await deps.roundsRepository.setAnswerComment({ answerId: answer.id, postedCommentId: existing.id });
    if (edited || linked !== answer) await notifyTopic(deps, ctx, { reason: 'round-answer-posted', topicId });
    return linked ?? answer;
  }
  const comment = await deps.assistantRepository.addProjectClarificationComment({
    clarificationId: topicId,
    comment: {
      id: nextId,
      actorId: ctx.actor.actorId,
      actorType: ctx.actor.actorType,
      authorName: ctx.actor.name || (ctx.actor.actorType === 'stakeholder' ? 'Stakeholder' : 'User'),
      body,
      source: 'round-answer',
    },
    preserveStatus: true,
    projectId,
    tenantId,
  });
  // No comment back means the topic was deleted after it was read above.
  if (!comment?.id) throw questionRemovedError();
  const updated = await deps.roundsRepository.setAnswerComment({ answerId: answer.id, postedCommentId: comment.id });
  await recordTopicReplies(deps, { author: annotationMentionAuthor(ctx), clarification, commentId: comment?.id, projectId, tenantId, topicId });
  await notifyTopic(deps, ctx, { reason: 'round-answer-posted', topicId });
  return updated ?? answer;
}

export async function putAnswer(deps, ctx, { input, questionId }) {
  ensureOpen(ctx);
  ensureReviewer(ctx);
  const question = findQuestion(ctx, questionId);
  const [, previous] = await Promise.all([ensureQuestionAnswerable(deps, ctx, question), myAnswer(deps, ctx, questionId)]);
  const checked = validateAnswerValue(question, input.value);
  if (!checked.ok) throw badRequest('answer_invalid', checked.message);
  const topicId = questionTopicId(ctx.round, question);
  const save = (value) => deps.roundsRepository.upsertAnswer({
    actorId: ctx.actor.actorId,
    actorType: ctx.actor.actorType,
    now: roundsClock(deps),
    projectId: ctx.projectId,
    questionId,
    roundId: ctx.round.id,
    tenantId: ctx.tenantId,
    topicId,
    value,
  });
  let answer = await save(checked.value);
  let postError = null;
  try {
    answer = await postAnswerToTopic(deps, ctx, { answer, question, topicId });
  } catch (error) {
    // The topic was deleted or dismissed after the answerable check. Put back what the
    // reviewer had before this save (nothing, for a first answer) rather than keep an
    // answer the round no longer asks for.
    if (error?.details?.code === QUESTION_REMOVED) {
      if (previous) await save(previous.value);
      else await deps.roundsRepository.deleteAnswer({ answerId: answer.id });
      throw error;
    }
    postError = error;
    logBackendError({
      context: buildOperationLogContext('requirements.rounds.postAnswer', { projectId: ctx.projectId, questionId, roundId: ctx.round.id, topicId }),
      error,
      level: 'warn',
      message: 'A round answer was saved but could not be posted to its topic.',
    });
  }
  await notify(deps, ctx, { reason: 'answer-saved' });
  requestRoundSummaryRefresh(deps, { projectId: ctx.projectId, roundId: ctx.round.id, tenantId: ctx.tenantId });
  // The answer is in the round, but its topic does not have it yet. Saving it again posts
  // it, so the reviewer's Retry finishes the job instead of being told it was saved.
  if (postError) throw new HttpError(503, 'Your answer could not be added to its topic. Try again.', { details: { code: 'answer_not_posted' } });
  return {
    answer: {
      ...(answer.postedCommentId ? { postedCommentId: answer.postedCommentId } : {}),
      text: answerText(question, answer.value),
      topicId: answer.topicId,
      updatedAt: answer.updatedAt,
      value: answer.value,
    },
    ok: true,
    progress: await myProgress(deps, ctx),
    questionId,
  };
}

export async function deleteAnswer(deps, ctx, { questionId }) {
  ensureOpen(ctx);
  ensureReviewer(ctx);
  await ensureQuestionAnswerable(deps, ctx, findQuestion(ctx, questionId));
  const answer = await myAnswer(deps, ctx, questionId);
  if (answer) {
    if (answer.topicId) {
      try {
        const clarification = await deps.assistantRepository.getProjectClarification({ clarificationId: answer.topicId, projectId: ctx.projectId, tenantId: ctx.tenantId });
        // Every comment the answer posted, linked or not (a save can fail after posting).
        const { live } = clarification ? answerComments(clarification, answer, ctx.actor) : { live: [] };
        for (const comment of live) {
          await deps.assistantRepository.deleteProjectClarificationComment({
            clarificationId: answer.topicId,
            commentId: comment.id,
            preserveStatus: true,
            projectId: ctx.projectId,
            tenantId: ctx.tenantId,
          });
        }
        if (live.length > 0) await notifyTopic(deps, ctx, { reason: 'topic-comment-deleted', topicId: answer.topicId });
      } catch (error) {
        logBackendError({
          context: buildOperationLogContext('requirements.rounds.clearAnswer', { projectId: ctx.projectId, questionId, roundId: ctx.round.id }),
          error,
          level: 'warn',
          message: 'The topic comment for a cleared round answer could not be removed.',
        });
        // Keep the answer, and the link to its comment, so clearing again can remove both.
        throw new HttpError(503, 'Your answer could not be removed from its topic. Try again.', { details: { code: 'answer_not_cleared' } });
      }
    }
    await deps.roundsRepository.deleteAnswer({ answerId: answer.id });
    await notify(deps, ctx, { reason: 'answer-cleared' });
    requestRoundSummaryRefresh(deps, { projectId: ctx.projectId, roundId: ctx.round.id, tenantId: ctx.tenantId });
  }
  return { answer: null, ok: true, progress: await myProgress(deps, ctx), questionId };
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

function extensionOf(path) {
  const name = String(path).split('/').pop() ?? '';
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
}

/** The actual pixel size of an image screen, read once from storage and cached. */
async function storedImageSize(deps, pkg, screen) {
  const key = `${pkg.id}:${screen.id}`;
  if (imageSizeCache.has(key)) return imageSizeCache.get(key);
  let size = null;
  try {
    const file = await deps.packagesRepository.getPackageFile?.({ packageId: pkg.id, path: screen.src });
    if (file?.storageKey && deps.packageStorage?.read) {
      const { bytes } = await deps.packageStorage.read(file.storageKey);
      size = readImageSize(bytes, extensionOf(screen.src));
    }
  } catch (_error) {
    size = null;
  }
  if (imageSizeCache.size >= IMAGE_SIZE_CACHE_LIMIT) imageSizeCache.delete(imageSizeCache.keys().next().value);
  imageSizeCache.set(key, size);
  return size;
}

/**
 * Source-pixel bounds for marks: an image screen's size (the larger of the manifest's and
 * the file's, since a size mismatch is only a warning), a snapshot's size, or a prototype's
 * declared viewport when the snapshot could not be captured.
 */
async function markBounds(deps, ctx, { screen, snapshot }) {
  if (screen.kind === 'image') {
    const actual = await storedImageSize(deps, ctx.pkg, screen);
    return {
      height: Math.max(Number(screen.height ?? 0), Number(actual?.height ?? 0)),
      width: Math.max(Number(screen.width ?? 0), Number(actual?.width ?? 0)),
    };
  }
  if (snapshot) return { height: snapshot.height, width: snapshot.width };
  return { height: Number(screen.viewport?.height ?? 0), width: Number(screen.viewport?.width ?? 0) };
}

async function loadAnnotationInRound(deps, ctx, annotationId, { allowEarlierOutdated = false } = {}) {
  const annotation = await deps.roundsRepository.getAnnotation({ annotationId });
  if (!annotation || annotation.projectId !== ctx.projectId || annotation.tenantId !== ctx.tenantId || annotation.deletedAt) {
    throw new HttpError(404, 'Annotation not found.');
  }
  if (annotation.roundId === ctx.round.id) return annotation;
  if (allowEarlierOutdated) {
    const earlier = await earlierRounds(deps, ctx);
    if (earlier.some((round) => round.id === annotation.roundId)) return annotation;
  }
  throw new HttpError(404, 'Annotation not found.');
}

function ensureAuthorOrModerator(ctx, annotation, { moderatorAllowed = true } = {}) {
  const mine = annotation.authorType === ctx.actor.actorType && annotation.authorId === ctx.actor.actorId;
  if (mine || (moderatorAllowed && ctx.actor.canModerate)) return;
  throw new HttpError(403, 'Only the author, or a project admin or manager, can do that.', { details: { code: 'not_author' } });
}

export async function upsertAnnotation(deps, ctx, { annotationId, input }) {
  ensureOpen(ctx);
  const { projectId, tenantId } = ctx;
  const screen = manifestScreens(ctx.pkg.manifest).find((item) => item.id === input.screenId);
  if (!screen) throw badRequest('screen_invalid', 'That screen is not part of this round.');
  if (input.category && !feedbackDimensions(ctx.pkg.manifest, ctx.round.track).some((dimension) => dimension.key === input.category)) {
    throw badRequest('category_invalid', 'Use one of this package\'s feedback dimensions as the category.');
  }

  const existing = await deps.roundsRepository.getAnnotation({ annotationId });
  if (existing) {
    if (existing.projectId !== projectId || existing.tenantId !== tenantId || existing.roundId !== ctx.round.id) {
      throw conflict('annotation_id_taken', 'That annotation id is already in use.');
    }
    if (existing.authorType !== ctx.actor.actorType || existing.authorId !== ctx.actor.actorId) throw new HttpError(404, 'Annotation not found.');
    if (existing.deletedAt && !input.restored) throw conflict('annotation_deleted', 'This annotation was deleted. Send restored: true to bring it back.');
    if (existing.screenId !== input.screenId) throw badRequest('screen_invalid', 'An annotation cannot move to another screen.');
  }

  // A prototype mark is drawn on a snapshot, or on a blank frame when the snapshot failed;
  // without either, no surface can show it. A save that leaves the snapshot out keeps the
  // one the mark already has.
  const prototype = screen.kind === 'prototype';
  const unavailable = Boolean(input.anchor?.snapshotUnavailable);
  const snapshotFileId = input.snapshotFileId || (prototype && !unavailable ? existing?.snapshotFileId ?? null : null);
  if (prototype && !snapshotFileId && !unavailable) {
    throw badRequest('snapshot_required', 'A mark on a prototype needs the snapshot it was drawn on.');
  }

  let snapshot = null;
  if (snapshotFileId) {
    if (!prototype) throw badRequest('snapshot_invalid', 'Only prototype screens have snapshots.');
    snapshot = await deps.roundsRepository.getSnapshot({ projectId, snapshotId: snapshotFileId, tenantId });
    const keepsOwn = existing?.snapshotFileId === snapshotFileId;
    if (!snapshot || (!keepsOwn && (snapshot.roundId !== ctx.round.id || (snapshot.screenId && snapshot.screenId !== screen.id)))) {
      throw badRequest('snapshot_invalid', 'That snapshot does not belong to this screen in this round.');
    }
  }

  const checked = validateShapes(input.shapes, await markBounds(deps, ctx, { screen, snapshot }));
  if (!checked.ok) throw badRequest('shapes_invalid', 'Some marks are not valid.', { issues: checked.issues });

  const fields = {
    anchor: input.anchor ?? {},
    category: input.category || null,
    elementHint: input.elementHint ?? null,
    schemaVersion: 1,
    snapshotFileId,
    stateKey: screen.kind === 'prototype' ? (input.stateKey || null) : null,
  };
  let annotation;
  if (existing) {
    annotation = await deps.roundsRepository.updateAnnotation({
      annotationId,
      now: roundsClock(deps),
      patch: { ...fields, ...(existing.deletedAt ? { deletedAt: null } : {}), shapes: numberPins(checked.shapes, existing.number) },
    });
  } else {
    annotation = await deps.roundsRepository.createAnnotation({
      annotation: {
        ...fields,
        authorId: ctx.actor.actorId,
        authorName: ctx.actor.name,
        authorType: ctx.actor.actorType,
        createdAt: roundsClock(deps),
        id: annotationId,
        packageId: ctx.pkg.id,
        packageVersion: ctx.pkg.version,
        projectId,
        roundId: ctx.round.id,
        screenId: screen.id,
        shapes: checked.shapes,
        status: 'open',
        tenantId,
      },
      numberShapes: numberPins,
    });
  }

  await notify(deps, ctx, { annotationId, reason: existing?.deletedAt ? 'annotation-restored' : 'annotation-saved', screenId: screen.id });
  requestRoundSummaryRefresh(deps, { projectId, roundId: ctx.round.id, screenId: screen.id, tenantId });
  return { annotation: await presentOne(deps, ctx, annotation), created: !existing, ok: true };
}

export async function deleteAnnotation(deps, ctx, { annotationId }) {
  ensureOpen(ctx);
  const annotation = await loadAnnotationInRound(deps, ctx, annotationId);
  // Admins and managers may delete any annotation on the team side; stakeholders their own.
  ensureAuthorOrModerator(ctx, annotation, { moderatorAllowed: ctx.actor.audience === 'team' });
  await deps.roundsRepository.updateAnnotation({ annotationId, now: roundsClock(deps), patch: { deletedAt: roundsClock(deps) } });
  await notify(deps, ctx, { annotationId, reason: 'annotation-deleted', screenId: annotation.screenId });
  requestRoundSummaryRefresh(deps, { projectId: ctx.projectId, roundId: ctx.round.id, screenId: annotation.screenId, tenantId: ctx.tenantId });
  return { deleted: { id: annotationId, number: annotation.number, screenId: annotation.screenId }, ok: true };
}

export async function setAnnotationStatus(deps, ctx, { annotationId, input }) {
  ensureOpen(ctx);
  const annotation = await loadAnnotationInRound(deps, ctx, annotationId);
  ensureAuthorOrModerator(ctx, annotation);
  if (!['open', 'resolved', 'carried'].includes(annotation.status)) {
    throw conflict('annotation_status_locked', 'Outdated and superseded annotations are carried forward or closed instead.');
  }
  const now = roundsClock(deps);
  const updated = annotation.status === input.status
    ? annotation
    : await deps.roundsRepository.updateAnnotation({ annotationId, now, patch: { status: input.status, statusChangedAt: now, statusChangedBy: ctx.actor.actorRef } });
  await notify(deps, ctx, { annotationId, reason: 'annotation-status-changed', screenId: annotation.screenId });
  requestRoundSummaryRefresh(deps, { projectId: ctx.projectId, roundId: ctx.round.id, screenId: annotation.screenId, tenantId: ctx.tenantId });
  return { annotation: await presentOne(deps, ctx, updated), ok: true };
}

/** Moves an outdated annotation from an earlier round into this (open) round. */
export async function carryAnnotation(deps, ctx, { annotationId }) {
  ensureOpen(ctx);
  const annotation = await loadAnnotationInRound(deps, ctx, annotationId, { allowEarlierOutdated: true });
  if (annotation.roundId === ctx.round.id || annotation.status !== 'outdated') {
    throw conflict('annotation_not_outdated', 'Only outdated annotations from an earlier round can be carried forward.');
  }
  ensureAuthorOrModerator(ctx, annotation);
  if (!ctx.pkg.screens.some((screen) => screen.screenId === annotation.screenId)) {
    throw conflict('screen_missing', 'This round no longer has that screen.');
  }
  const fromRoundId = annotation.roundId;
  const moved = await deps.roundsRepository.moveAnnotation({
    annotationId,
    changedBy: ctx.actor.actorRef,
    now: roundsClock(deps),
    numberShapes: numberPins,
    status: 'carried',
    toPackageId: ctx.pkg.id,
    toPackageVersion: ctx.pkg.version,
    toRoundId: ctx.round.id,
  });
  await notify(deps, ctx, { annotationId, reason: 'annotation-carried', screenId: annotation.screenId });
  const previous = await deps.roundsRepository.getRound({ projectId: ctx.projectId, roundId: fromRoundId, tenantId: ctx.tenantId });
  if (previous) {
    await publishRoundEvent(deps, {
      actor: actorForEvents(ctx), annotationId, projectId: ctx.projectId, reason: 'annotation-carried', round: previous, screenId: annotation.screenId, tenantId: ctx.tenantId, type: ROUND_EVENTS.review,
    });
  }
  requestRoundSummaryRefresh(deps, { projectId: ctx.projectId, roundId: ctx.round.id, screenId: annotation.screenId, tenantId: ctx.tenantId });
  return { annotation: await presentOne(deps, ctx, moved), ok: true };
}

/** Closes an outdated annotation where it is (status resolved). */
export async function closeOutdatedAnnotation(deps, ctx, { annotationId }) {
  ensureOpen(ctx);
  const annotation = await loadAnnotationInRound(deps, ctx, annotationId, { allowEarlierOutdated: true });
  if (annotation.roundId === ctx.round.id || annotation.status !== 'outdated') {
    throw conflict('annotation_not_outdated', 'Only outdated annotations from an earlier round can be closed here.');
  }
  ensureAuthorOrModerator(ctx, annotation);
  const now = roundsClock(deps);
  const closed = await deps.roundsRepository.updateAnnotation({ annotationId, now, patch: { status: 'resolved', statusChangedAt: now, statusChangedBy: ctx.actor.actorRef } });
  await notify(deps, ctx, { annotationId, reason: 'annotation-closed', screenId: annotation.screenId });
  return { annotation: await presentOne(deps, ctx, closed), ok: true };
}

// ---------------------------------------------------------------------------
// Annotation threads
// ---------------------------------------------------------------------------

async function loadOwnComment(deps, ctx, annotation, commentId) {
  const comment = await deps.roundsRepository.getComment({ commentId });
  if (!comment || comment.annotationId !== annotation.id || comment.authorType !== ctx.actor.actorType || comment.authorId !== ctx.actor.actorId) {
    throw new HttpError(404, 'Comment not found.');
  }
  if (comment.deletedAt) throw conflict('comment_deleted', 'This comment has already been removed.');
  return comment;
}

async function finishThreadChange(deps, ctx, annotation, reason) {
  await notify(deps, ctx, { annotationId: annotation.id, reason, screenId: annotation.screenId });
  requestRoundSummaryRefresh(deps, { projectId: ctx.projectId, roundId: ctx.round.id, screenId: annotation.screenId, tenantId: ctx.tenantId });
  const current = await deps.roundsRepository.getAnnotation({ annotationId: annotation.id });
  return presentOne(deps, ctx, current);
}

function annotationMentionAuthor(ctx) {
  return { actorId: ctx.actor.actorId, actorType: ctx.actor.actorType, name: ctx.actor.name };
}

async function annotationMentionPeople(deps, ctx, annotation) {
  const author = annotationMentionAuthor(ctx);
  if (ctx.actor.audience !== 'portal') {
    return teamAnnotationPeople(deps, { author, projectId: ctx.projectId, round: ctx.round, tenantId: ctx.tenantId });
  }
  const comments = await deps.roundsRepository.listComments({ annotationIds: [annotation.id] });
  return portalAnnotationPeople(deps, { annotation, author, comments, projectId: ctx.projectId, round: ctx.round, tenantId: ctx.tenantId });
}

/** People this reviewer may tag in an annotation's thread, for the comment box's picker. */
export async function listAnnotationMentionables(deps, ctx, { annotationId }) {
  const annotation = await loadAnnotationInRound(deps, ctx, annotationId);
  const people = await annotationMentionPeople(deps, ctx, annotation);
  return { ok: true, people: presentMentionables(people, { audience: ctx.actor.audience, projectId: ctx.projectId }) };
}

async function prepareAnnotationMentions(deps, ctx, annotation, body, previousBody = '') {
  if (!String(body ?? '').includes('@[')) return { added: [], body };
  const people = await annotationMentionPeople(deps, ctx, annotation);
  return prepareMentions(body, { audience: ctx.actor.audience, people, previousBody, projectId: ctx.projectId });
}

function recordAnnotationMentions(deps, ctx, annotation, commentId, recipients) {
  return recordMentions(deps, {
    author: annotationMentionAuthor(ctx),
    projectId: ctx.projectId,
    recipients,
    source: { annotationId: annotation.id, commentId, roundId: annotation.roundId, type: 'annotation' },
    tenantId: ctx.tenantId,
  });
}

export async function createAnnotationComment(deps, ctx, { annotationId, input }) {
  ensureOpen(ctx);
  const annotation = await loadAnnotationInRound(deps, ctx, annotationId);
  if (input.parentCommentId) {
    const parent = await deps.roundsRepository.getComment({ commentId: input.parentCommentId });
    if (!parent || parent.annotationId !== annotationId) throw new HttpError(400, 'Invalid parent comment.');
    if (parent.deletedAt) throw conflict('comment_deleted', 'Replies cannot be added to a removed comment.');
  }
  const tagged = await prepareAnnotationMentions(deps, ctx, annotation, input.body);
  const comment = await deps.roundsRepository.createComment({
    comment: {
      annotationId,
      authorId: ctx.actor.actorId,
      authorName: ctx.actor.name,
      authorType: ctx.actor.actorType,
      body: tagged.body,
      createdAt: roundsClock(deps),
      id: randomUUID(),
      parentCommentId: input.parentCommentId || null,
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
    },
  });
  await recordAnnotationMentions(deps, ctx, annotation, comment.id, tagged.added);
  const presented = await finishThreadChange(deps, ctx, annotation, 'annotation-comment-added');
  return { annotation: presented, comment: presented.thread.find((entry) => entry.id === comment.id) ?? null, ok: true };
}

export async function updateAnnotationComment(deps, ctx, { annotationId, commentId, input }) {
  ensureOpen(ctx);
  const annotation = await loadAnnotationInRound(deps, ctx, annotationId);
  const existing = await loadOwnComment(deps, ctx, annotation, commentId);
  const tagged = await prepareAnnotationMentions(deps, ctx, annotation, input.body, existing.body ?? '');
  const now = roundsClock(deps);
  await deps.roundsRepository.updateComment({ commentId, now, patch: { body: tagged.body, editedAt: now } });
  await recordAnnotationMentions(deps, ctx, annotation, commentId, tagged.added);
  const presented = await finishThreadChange(deps, ctx, annotation, 'annotation-comment-updated');
  return { annotation: presented, comment: presented.thread.find((entry) => entry.id === commentId) ?? null, ok: true };
}

export async function deleteAnnotationComment(deps, ctx, { annotationId, commentId }) {
  ensureOpen(ctx);
  const annotation = await loadAnnotationInRound(deps, ctx, annotationId);
  await loadOwnComment(deps, ctx, annotation, commentId);
  const now = roundsClock(deps);
  await deps.roundsRepository.updateComment({ commentId, now, patch: { deletedAt: now } });
  const presented = await finishThreadChange(deps, ctx, annotation, 'annotation-comment-deleted');
  return { annotation: presented, ok: true };
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export async function uploadSnapshot(deps, ctx, { bytes, query = {} }) {
  ensureOpen(ctx);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw badRequest('snapshot_invalid', 'Send the snapshot as a raw image/png body.');
  const png = inspectPng(bytes);
  if (!png.ok) throw badRequest(png.code, png.message);
  if (query.screenId) {
    const screen = manifestScreens(ctx.pkg.manifest).find((item) => item.id === query.screenId);
    if (!screen || screen.kind !== 'prototype') throw badRequest('screen_invalid', 'Snapshots belong to prototype screens of this round.');
  }
  if (!deps.packageStorage?.write) throw new HttpError(503, 'Snapshot storage is unavailable.');
  const id = randomUUID();
  const storageKey = snapshotStorageKey(id);
  await deps.packageStorage.write(storageKey, bytes);
  try {
    const snapshot = await deps.roundsRepository.createSnapshot({
      snapshot: {
        createdAt: roundsClock(deps),
        height: png.height,
        id,
        projectId: ctx.projectId,
        roundId: ctx.round.id,
        screenId: query.screenId || null,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        stateKey: query.stateKey || null,
        storageKey,
        tenantId: ctx.tenantId,
        uploadedBy: ctx.actor.actorRef,
        width: png.width,
      },
    });
    return { height: snapshot.height, ok: true, snapshotFileId: snapshot.id, url: snapshotUrlFor(ctx)(snapshot.id), width: snapshot.width };
  } catch (error) {
    await deps.packageStorage.delete?.(storageKey).catch(() => {});
    throw error;
  }
}

/**
 * Bytes of a snapshot that belongs to the round, or that an annotation visible in the
 * round uses (carried and outdated annotations keep their original snapshot).
 */
export async function readSnapshot(deps, { projectId, roundId, snapshotId, tenantId, visibleIn = null }) {
  const snapshot = await deps.roundsRepository.getSnapshot({ projectId, snapshotId, tenantId });
  if (!snapshot) throw new HttpError(404, 'Snapshot not found.');
  if (snapshot.roundId !== roundId) {
    const annotations = visibleIn ?? await deps.roundsRepository.listAnnotations({ includeDeleted: true, projectId, roundIds: [roundId], tenantId });
    if (!annotations.some((annotation) => annotation.snapshotFileId === snapshotId)) throw new HttpError(404, 'Snapshot not found.');
  }
  const { bytes } = await deps.packageStorage.read(snapshot.storageKey);
  if (!inspectPng(bytes).ok) throw new HttpError(404, 'Snapshot not found.');
  return { bytes, snapshot };
}

export async function readSnapshotForReview(deps, ctx, { snapshotId }) {
  const visible = await visibleAnnotations(deps, ctx);
  return readSnapshot(deps, { projectId: ctx.projectId, roundId: ctx.round.id, snapshotId, tenantId: ctx.tenantId, visibleIn: visible.annotations });
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export async function submitReview(deps, ctx) {
  ensureOpen(ctx);
  ensureReviewer(ctx);
  const submittedAt = ctx.reviewer.submittedAt ?? roundsClock(deps).toISOString();
  if (!ctx.reviewer.submittedAt) {
    await deps.roundsRepository.updateReviewer({
      patch: { lastSeenAt: submittedAt, submittedAt },
      projectId: ctx.projectId,
      reviewerId: ctx.reviewer.id,
      roundId: ctx.round.id,
      tenantId: ctx.tenantId,
    });
    const round = await deps.roundsRepository.getRound({ projectId: ctx.projectId, roundId: ctx.round.id, tenantId: ctx.tenantId });
    await notify(deps, { ...ctx, round }, { reason: 'review-submitted', type: ROUND_EVENTS.rounds });
  }
  const manifest = ctx.pkg.manifest;
  const [{ screenVerdicts, stances }, answers, removed] = await Promise.all([
    myVerdicts(deps, ctx),
    deps.roundsRepository.listAnswers({ roundIds: [ctx.round.id] }),
    removedQuestions(deps, ctx),
  ]);
  const actorRef = ctx.actor.actorRef;
  const answered = new Set(answers.filter((answer) => answer.actorType === ctx.actor.actorType && answer.actorId === ctx.actor.actorId).map((answer) => answer.questionId));
  return {
    ok: true,
    progress: computeProgress({ actorRef, answers, manifest, removedQuestionIds: removed, screenVerdicts, stances }),
    submittedAt,
    // What the reviewer gave; null is "Not reviewed" or "Not answered".
    summary: {
      directions: manifestDirections(manifest).map((direction) => ({ directionId: direction.id, stance: stances.get(`${actorRef}|${direction.id}`)?.stance ?? null })),
      questions: manifestQuestions(manifest).map((question) => (removed.has(question.id)
        ? { answered: false, questionId: question.id, removed: true }
        : { answered: answered.has(question.id), questionId: question.id })),
      screens: manifestScreens(manifest).map((screen) => ({ overall: screenVerdicts.get(`${actorRef}|${screen.id}`)?.overall ?? null, screenId: screen.id })),
    },
  };
}

// ---------------------------------------------------------------------------
// Portal inbox
// ---------------------------------------------------------------------------

export async function listPortalRounds(deps, actor) {
  const rounds = (await deps.roundsRepository.listRounds({ projectId: actor.projectId, tenantId: actor.tenantId }))
    .filter((round) => round.status !== 'draft');
  const invited = rounds
    .map((round) => ({ reviewer: round.reviewers.find((item) => item.actorType === 'stakeholder' && item.actorId === actor.actorId && !item.removedAt), round }))
    .filter((entry) => entry.reviewer);
  const people = invited.length > 0 ? await loadPeople(deps, { projectId: actor.projectId, tenantId: actor.tenantId }) : new Map();
  const result = [];
  for (const { reviewer, round } of invited) {
    const pkg = await deps.packagesRepository.getPackage({ packageId: round.packageId, projectId: actor.projectId, tenantId: actor.tenantId });
    if (!pkg) continue;
    const [verdicts, answers, removedQuestionIds] = await Promise.all([
      deps.roundsRepository.listVerdicts({ roundIds: [round.id] }),
      deps.roundsRepository.listAnswers({ roundIds: [round.id] }),
      loadRemovedQuestionIds(deps, { manifest: pkg.manifest, projectId: actor.projectId, round, tenantId: actor.tenantId }),
    ]);
    const mine = (row) => row.actorType === 'stakeholder' && row.actorId === actor.actorId;
    const rows = verdicts.filter(mine);
    result.push({
      closedAt: round.closedAt,
      dueAt: round.dueAt,
      id: round.id,
      note: round.note,
      number: round.number,
      packageVersion: pkg.version,
      progress: computeProgress({
        actorRef: actor.actorRef,
        answers: answers.filter(mine),
        manifest: pkg.manifest,
        removedQuestionIds,
        screenVerdicts: collectScreenVerdicts(rows),
        stances: collectDirectionStances(rows),
      }),
      publishedAt: round.publishedAt,
      publishedBy: publishedByOf(people, round),
      required: reviewer.required,
      status: round.status,
      submittedAt: reviewer.submittedAt,
      title: pkg.title,
      track: round.track,
    });
  }
  return {
    ok: true,
    rounds: result.sort((left, right) => (left.status === right.status ? String(right.publishedAt).localeCompare(String(left.publishedAt)) : left.status === 'open' ? -1 : 1)),
  };
}

