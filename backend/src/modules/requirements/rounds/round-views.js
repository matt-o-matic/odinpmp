import { createHash } from 'node:crypto';

import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { manifestDirections, manifestQuestions, manifestScreens } from './round-manifest.js';
import { DIMENSION_PREFIX, OVERALL_DIMENSION } from './rounds.repository.js';

// Shared read models for rounds: people, verdict grids, progress, and how annotations and
// their threads are shown to the team and to the stakeholder portal.

export function actorRefOf(actorType, actorId) {
  return `${actorType === 'stakeholder' ? 'stakeholder' : 'user'}:${actorId}`;
}

/** Opaque, stable per-person key for the portal, which never shows user or stakeholder ids. */
export function portalPersonKey(projectId, actorRef) {
  return `person:${createHash('sha256').update(`${projectId}|${actorRef}`, 'utf8').digest('hex').slice(0, 20)}`;
}

/** Map(actorRef -> { name, email }) for project users and stakeholders. */
export async function loadPeople(deps, { projectId, tenantId }) {
  const people = new Map();
  try {
    const [valid, stakeholders] = await Promise.all([
      deps.projectRepository?.getValidUsers?.({ projectId, tenantId }) ?? null,
      deps.assistantRepository?.listProjectStakeholders?.({ projectId, tenantId }) ?? [],
    ]);
    for (const entry of [...(valid?.tenant_users ?? []), ...(valid?.project_users ?? [])]) {
      if (entry?.id) people.set(`user:${entry.id}`, { email: entry.email ?? '', name: entry.name ?? '' });
    }
    for (const stakeholder of stakeholders ?? []) {
      if (stakeholder?.id) people.set(`stakeholder:${stakeholder.id}`, { email: stakeholder.email ?? '', name: stakeholder.name ?? '' });
    }
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.rounds.loadPeople', { projectId, tenantId }),
      error,
      level: 'warn',
      message: 'Round people could not be resolved.',
    });
  }
  return people;
}

export function personName(people, actorRef, fallback = '') {
  return people.get(actorRef)?.name || fallback || (actorRef.startsWith('stakeholder:') ? 'Stakeholder' : 'Team member');
}

/** Map(`${actorRef}|${screenId}` -> { id, overall, dimensions, stay, change, mixed, updatedAt }). */
export function collectScreenVerdicts(rows = []) {
  const verdicts = new Map();
  const dimensionRows = [];
  for (const row of rows) {
    if (row.targetType !== 'screen') continue;
    if (row.dimension !== OVERALL_DIMENSION) {
      dimensionRows.push(row);
      continue;
    }
    verdicts.set(`${actorRefOf(row.actorType, row.actorId)}|${row.targetId}`, {
      change: row.changeNote,
      dimensions: {},
      id: row.id,
      mixed: row.mixedNote,
      overall: row.value,
      stay: row.keepNote,
      updatedAt: row.updatedAt,
    });
  }
  for (const row of dimensionRows) {
    const verdict = verdicts.get(`${actorRefOf(row.actorType, row.actorId)}|${row.targetId}`);
    if (verdict && row.dimension.startsWith(DIMENSION_PREFIX)) verdict.dimensions[row.dimension.slice(DIMENSION_PREFIX.length)] = row.value;
  }
  return verdicts;
}

/** Map(`${actorRef}|${directionId}` -> { id, stance, remix, updatedAt }). */
export function collectDirectionStances(rows = []) {
  const stances = new Map();
  for (const row of rows) {
    if (row.targetType !== 'direction' || row.dimension !== OVERALL_DIMENSION) continue;
    stances.set(`${actorRefOf(row.actorType, row.actorId)}|${row.targetId}`, {
      id: row.id,
      remix: row.keepNote,
      stance: row.value,
      updatedAt: row.updatedAt,
    });
  }
  return stances;
}

/** The public shape of one verdict: notes and dimensions only when given. */
export function presentVerdict(verdict) {
  if (!verdict) return null;
  return {
    ...(verdict.change ? { change: verdict.change } : {}),
    dimensions: { ...verdict.dimensions },
    ...(verdict.mixed ? { mixed: verdict.mixed } : {}),
    overall: verdict.overall,
    ...(verdict.stay ? { stay: verdict.stay } : {}),
    updatedAt: verdict.updatedAt,
  };
}

export function presentStance(stance) {
  if (!stance) return null;
  return { ...(stance.remix ? { remix: stance.remix } : {}), stance: stance.stance, updatedAt: stance.updatedAt };
}

/**
 * One reviewer's progress. Directions count once they have a stance, screens once they have
 * an overall verdict (Undecided included: it is a choice), questions once answered in this
 * round. Anything else is "Not reviewed".
 */
export function computeProgress({ actorRef, answers = [], manifest, removedQuestionIds = null, screenVerdicts, stances }) {
  const directions = manifestDirections(manifest);
  const screens = manifestScreens(manifest);
  // Removed questions no longer need an answer, so they are not part of anyone's progress.
  const questions = manifestQuestions(manifest).filter((question) => !removedQuestionIds?.has(question.id));
  const answered = new Set(answers.filter((answer) => actorRefOf(answer.actorType, answer.actorId) === actorRef).map((answer) => answer.questionId));
  const part = (list, done) => ({ done: list.filter(done).length, total: list.length });
  const progress = {
    directions: part(directions, (direction) => stances.has(`${actorRef}|${direction.id}`)),
    questions: part(questions, (question) => answered.has(question.id)),
    screens: part(screens, (screen) => screenVerdicts.has(`${actorRef}|${screen.id}`)),
  };
  progress.done = progress.directions.done + progress.screens.done + progress.questions.done;
  progress.total = progress.directions.total + progress.screens.total + progress.questions.total;
  return progress;
}

function presentComment(comment, { audience, people, presentBody = null, projectId, viewerRef }) {
  const ref = actorRefOf(comment.authorType, comment.authorId);
  return {
    authorName: personName(people, ref, comment.authorName),
    authorRef: audience === 'portal' ? portalPersonKey(projectId, ref) : ref,
    body: comment.deletedAt ? '' : (presentBody ? presentBody(comment.body ?? '') : comment.body),
    createdAt: comment.createdAt,
    deletedAt: comment.deletedAt,
    editedAt: comment.editedAt,
    id: comment.id,
    isDeleted: Boolean(comment.deletedAt),
    isMine: ref === viewerRef,
    parentCommentId: comment.parentCommentId,
  };
}

/**
 * An annotation for the review screens. `round` is the round being viewed; annotations from
 * an earlier round (outdated ones) carry their own round id and number and offer carry and
 * close actions to their author and to admins and managers.
 */
export function presentAnnotation(annotation, {
  audience = 'team',
  canModerate = false,
  comments = [],
  people = new Map(),
  // Rewrites each thread comment's body; the portal uses it to hide ids inside mention tags.
  presentBody = null,
  projectId,
  round,
  roundNumbers = new Map(),
  snapshotUrl = () => null,
  viewerRef = null,
}) {
  const ref = actorRefOf(annotation.authorType, annotation.authorId);
  const isMine = ref === viewerRef;
  const open = round?.status === 'open';
  const inRound = annotation.roundId === round?.id;
  const author = isMine || canModerate;
  return {
    actions: {
      carry: open && !inRound && annotation.status === 'outdated' && author,
      changeStatus: open && inRound && author,
      close: open && !inRound && annotation.status === 'outdated' && author,
      comment: open,
      delete: open && inRound && (isMine || (audience === 'team' && canModerate)),
      edit: open && inRound && isMine,
    },
    anchor: annotation.anchor ?? {},
    authorName: personName(people, ref, annotation.authorName),
    authorRef: audience === 'portal' ? portalPersonKey(projectId, ref) : ref,
    carriedFromRoundId: annotation.carriedFromRoundId,
    category: annotation.category,
    color: annotation.shapes?.[0]?.style?.color ?? null,
    createdAt: annotation.createdAt,
    elementHint: annotation.elementHint,
    id: annotation.id,
    isMine,
    number: annotation.number,
    packageVersion: annotation.packageVersion,
    roundId: annotation.roundId,
    roundNumber: roundNumbers.get(annotation.roundId) ?? null,
    screenId: annotation.screenId,
    shapes: annotation.shapes,
    snapshotFileId: annotation.snapshotFileId,
    snapshotUrl: annotation.snapshotFileId ? snapshotUrl(annotation.snapshotFileId) : null,
    stateKey: annotation.stateKey,
    status: annotation.status,
    statusChangedAt: annotation.statusChangedAt,
    thread: comments
      .filter((comment) => comment.annotationId === annotation.id)
      .map((comment) => presentComment(comment, { audience, people, presentBody, projectId, viewerRef })),
    updatedAt: annotation.updatedAt,
  };
}

export { presentComment };
