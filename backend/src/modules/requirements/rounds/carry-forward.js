import { numberPins } from './annotation-shapes.js';

// Carry-forward (package-spec.md section 6). When a new round publishes for a track,
// every open or carried annotation from the track's earlier rounds is compared with the new
// package by screen id and content hash:
//   - same id, same hash: the annotation moves to the new round as 'carried', keeping its id
//     and thread and taking the next display number there;
//   - same id, different hash: it stays in its round as 'outdated', for its author or an
//     admin or manager to carry forward or close;
//   - id missing: it stays in its round as 'superseded'.

export const CARRY_FORWARD_ACTOR = 'system:carry-forward';
const LIVE_STATUSES = new Set(['open', 'carried']);

async function packageScreens(deps, cache, { packageId, projectId, tenantId }) {
  if (!cache.has(packageId)) {
    const pkg = await deps.packagesRepository.getPackage({ packageId, projectId, tenantId });
    cache.set(packageId, new Map((pkg?.screens ?? []).map((screen) => [screen.screenId, screen])));
  }
  return cache.get(packageId);
}

/**
 * Applies the transitions for a newly published `round` of package `pkg`. Returns the ids
 * per outcome: `{ carried, outdated, superseded }`.
 */
export async function applyCarryForward(deps, { now, pkg, projectId, round, tenantId }) {
  const outcome = { carried: [], outdated: [], superseded: [] };
  const rounds = await deps.roundsRepository.listRounds({ projectId, tenantId, track: round.track });
  const earlier = rounds.filter((item) => item.id !== round.id && item.number < round.number);
  if (earlier.length === 0) return outcome;

  const numberById = new Map(rounds.map((item) => [item.id, item.number]));
  const annotations = (await deps.roundsRepository.listAnnotations({ projectId, roundIds: earlier.map((item) => item.id), tenantId }))
    .filter((annotation) => LIVE_STATUSES.has(annotation.status))
    .sort((left, right) => (numberById.get(left.roundId) - numberById.get(right.roundId))
      || String(left.screenId).localeCompare(String(right.screenId))
      || (Number(left.number ?? 0) - Number(right.number ?? 0)));
  if (annotations.length === 0) return outcome;

  const cache = new Map();
  const next = new Map(pkg.screens.map((screen) => [screen.screenId, screen]));
  for (const annotation of annotations) {
    const target = next.get(annotation.screenId);
    if (!target) {
      outcome.superseded.push(annotation.id);
      continue;
    }
    const previous = (await packageScreens(deps, cache, { packageId: annotation.packageId, projectId, tenantId })).get(annotation.screenId);
    if (previous && previous.contentHash === target.contentHash) outcome.carried.push(annotation.id);
    else outcome.outdated.push(annotation.id);
  }

  await deps.roundsRepository.setAnnotationStatuses({ annotationIds: outcome.outdated, now, status: 'outdated' });
  await deps.roundsRepository.setAnnotationStatuses({ annotationIds: outcome.superseded, now, status: 'superseded' });
  for (const annotationId of outcome.carried) {
    await deps.roundsRepository.moveAnnotation({
      annotationId,
      changedBy: CARRY_FORWARD_ACTOR,
      now,
      numberShapes: numberPins,
      status: 'carried',
      toPackageId: pkg.id,
      toPackageVersion: pkg.version,
      toRoundId: round.id,
    });
  }
  return outcome;
}
