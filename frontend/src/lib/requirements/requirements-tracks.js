// Tracks, pipeline stages, and brief-line labels for the Requirements workspace.
// Pure helpers: the views pass in API payloads and get display values back.

export const REQUIREMENTS_TRACKS = Object.freeze(['experience', 'architecture']);

// Review is project-wide: one round open at a time, for screens and prototypes, with questions
// from either track. It has its own tab; packages and rounds are stored on this track.
export const REVIEW_TRACK = 'experience';

/** The Review tab, optionally with a query (such as { round } from an invitation link). */
export function reviewLocation(projectId, query = null) {
  return { name: 'project-requirements-review', params: { projectId }, ...(query ? { query } : {}) };
}

const TRACK_META = Object.freeze({
  architecture: { chipClass: 'rq-chip--arch', icon: 'bi-list-check', label: 'Functional' },
  experience: { chipClass: 'rq-chip--exp', icon: 'bi-window', label: 'Experience' },
});

export function isRequirementsTrack(value) {
  return REQUIREMENTS_TRACKS.includes(value);
}

export function trackLabel(track) {
  return TRACK_META[track]?.label ?? 'Requirements';
}

export function trackIcon(track) {
  return TRACK_META[track]?.icon ?? 'bi-list-check';
}

export function trackChipClass(track) {
  return TRACK_META[track]?.chipClass ?? 'rq-chip--neutral';
}

// The pipeline stages double as the track's subtabs. Review is the one
// project-wide stage: from either track it opens the same Review tab.
export const REQUIREMENTS_STAGES = Object.freeze([
  { id: 'brief', label: 'Brief', number: '01' },
  { id: 'discuss', label: 'Discuss', number: '02' },
  { id: 'review', label: 'Review', number: '03' },
  { id: 'decide', label: 'Decide', number: '04' },
  { id: 'plan', label: 'Plan & work', number: '05' },
]);

/** Where a stage opens: the track's own stage, or for Review the project's Review tab. */
export function stageLocation(projectId, track, stageId) {
  return stageId === 'review'
    ? reviewLocation(projectId)
    : { name: 'project-requirements-track', params: { projectId, stage: stageId, track } };
}

export const DEFAULT_STAGE = 'discuss';

export function normalizeStage(value) {
  return REQUIREMENTS_STAGES.some((stage) => stage.id === value) ? value : DEFAULT_STAGE;
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  const value = Number(count) || 0;
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

/**
 * One-line status for a pipeline stage, from the `GET /requirements` overview. `tone` picks
 * the status dot: done (green), attention (orange), active (blue), idle (no dot).
 */
export function describeStage(stageId, stages = {}) {
  if (stageId === 'brief') {
    const brief = stages.brief ?? {};
    const total = Number(brief.totalLines) || 0;
    const covered = Number(brief.coveredLines) || 0;
    if (total === 0) return { status: 'No brief yet', tone: 'idle' };
    const status = `${covered} of ${plural(total, 'line')} covered`;
    if (covered >= total) return { status, tone: 'done' };
    return { status, tone: covered === 0 ? 'attention' : 'active' };
  }

  if (stageId === 'discuss') {
    const discuss = stages.discuss ?? {};
    const total = Number(discuss.total) || 0;
    const ready = Number(discuss.ready) || 0;
    const open = Number(discuss.open) || 0;
    if (total === 0) return { status: 'No topics yet', tone: 'idle' };
    const status = `${plural(total, 'topic')} · ${ready} ready`;
    if (ready > 0) return { status, tone: 'attention' };
    return { status, tone: open > 0 ? 'active' : 'done' };
  }

  if (stageId === 'review') {
    const round = stages.review?.latestRound ?? null;
    if (!round) return { status: 'No rounds yet', tone: 'idle' };
    if (round.status === 'open') {
      return {
        status: `Round ${round.number} open · ${round.reviewersSubmitted ?? 0} of ${round.reviewersTotal ?? 0} in`,
        tone: 'active',
      };
    }
    if (round.status === 'closed') return { status: `Round ${round.number} closed`, tone: 'done' };
    return { status: `Round ${round.number} draft`, tone: 'idle' };
  }

  if (stageId === 'decide') {
    const decide = stages.decide ?? {};
    const decided = Number(decide.decided) || 0;
    const waiting = (Number(decide.waiting) || 0) + (Number(decide.proposedPreferences) || 0);
    if (decided === 0 && waiting === 0) return { status: 'Nothing to decide yet', tone: 'idle' };
    if (waiting > 0) return { status: `${decided} decided · ${waiting} waiting`, tone: 'attention' };
    return { status: `${decided} decided`, tone: 'done' };
  }

  if (stageId === 'plan') {
    const plan = stages.plan?.latestPlan ?? null;
    if (!plan) return { status: 'Not started', tone: 'idle' };
    const status = `Plan v${plan.version} ${plan.status === 'approved' ? 'approved' : plan.status || 'draft'}`;
    return { status, tone: plan.status === 'approved' ? 'done' : 'active' };
  }

  return { status: '', tone: 'idle' };
}

const BRIEF_SECTION_LABELS = Object.freeze({
  assumptions: 'Assumption',
  benefits: 'Benefits',
  constraints: 'Constraint',
  currentState: 'Current state',
  dependencies: 'Dependency',
  objective: 'Objective',
  proposedSolution: 'Proposed solution',
  requirements: 'Requirement',
  successMetrics: 'Success metric',
});

/** Parses `brief:requirements:0` or `brief:objective`. Returns null for anything else. */
export function parseBriefRef(ref) {
  const match = /^brief:([A-Za-z]+)(?::(\d+))?$/.exec(String(ref ?? '').trim());
  if (!match) return null;
  return { index: match[2] == null ? null : Number(match[2]), section: match[1] };
}

/**
 * Label for a brief citation, matching the backend's line labels: list sections are
 * zero-based in the ref and one-based for people ("Requirement 1"); text sections use the
 * field name ("Objective").
 */
export function briefRefLabel(ref) {
  const parsed = parseBriefRef(ref);
  if (!parsed) return '';
  const label = BRIEF_SECTION_LABELS[parsed.section] ?? parsed.section;
  return parsed.index == null ? label : `${label} ${parsed.index + 1}`;
}

/** One-based position of a ref in the overview's brief lines, or null when it is not there. */
export function briefLineNumber(ref, lines = []) {
  const index = (lines ?? []).findIndex((line) => line?.ref === ref);
  return index < 0 ? null : index + 1;
}

/** "brief line 4" when the line is in the brief, else the section label, else ''. */
export function briefCitation(ref, lines = []) {
  if (!parseBriefRef(ref)) return '';
  const number = briefLineNumber(ref, lines);
  return number == null ? briefRefLabel(ref) : `brief line ${number}`;
}
