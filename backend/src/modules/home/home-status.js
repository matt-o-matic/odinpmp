import { BEHIND_BELOW_DONE_SHARE, BEHIND_FROM_ELAPSED } from '../../lib/projects/health-signals.js';
import { dayWord } from './home-dates.js';
import { HOME_LENS } from './home-lenses.js';

// The line or panel above Focus now: whether the viewer (My work), their team's sprints
// (Team) or the workspace (Workspace) is behind, under the rule in health-signals.js. Overdue
// critical-path work, blockers and schedule variance rank in Focus now instead; they are not
// what "behind" means here.

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function percent(share) {
  return Math.round(share * 100);
}

function unitWord(unit) {
  return unit === 'points' ? 'points' : 'items';
}

function shortUnit(unit) {
  return unit === 'points' ? 'pts' : 'items';
}

function projectedShortfall(evaluation, standing) {
  const projected = evaluation.elapsed > 0 ? Math.min(standing.assigned, standing.closed / evaluation.elapsed) : standing.assigned;
  return round(Math.max(0, standing.assigned - projected));
}

/** How far under the line a standing is, as a share of what is assigned. */
function shortfallShare(standing) {
  return standing.assigned > 0 ? (standing.threshold - standing.closed) / standing.assigned : 0;
}

function ruleEvidence(entry) {
  const { evaluation } = entry;
  return [
    {
      label: `From ${percent(BEHIND_FROM_ELAPSED)}% of a sprint's working days, anyone who has closed less than ${percent(BEHIND_BELOW_DONE_SHARE)}% of the ${unitWord(evaluation.unit)} assigned to them is behind.`,
      rule: 'behind.rule',
      values: { behindBelowDoneShare: BEHIND_BELOW_DONE_SHARE, behindFromElapsed: BEHIND_FROM_ELAPSED },
    },
    {
      label: `${evaluation.daysGone} of ${evaluation.sprintDays} working days are gone (${percent(evaluation.elapsed)}%).`,
      rule: 'behind.elapsed',
      values: { daysGone: evaluation.daysGone, elapsed: round(evaluation.elapsed, 4), sprintDays: evaluation.sprintDays },
    },
  ];
}

function panelSprint(entry, standing) {
  const { evaluation, summary } = entry;
  return {
    ...summary,
    committedPoints: standing.assigned,
    donePct: standing.assigned > 0 ? Math.round((standing.closed / standing.assigned) * 100) : 0,
    donePoints: standing.closed,
    threshold: standing.threshold,
    willNotFinishPoints: projectedShortfall(evaluation, standing),
  };
}

function personStatus(entry, viewer, today) {
  const { evaluation, summary } = entry;
  const standing = evaluation.people.find((person) => person.id === viewer.id);
  const unit = shortUnit(evaluation.unit);
  const shortfall = projectedShortfall(evaluation, standing);
  return {
    evidence: [
      ...ruleEvidence(entry),
      { label: `You closed ${standing.closed} of the ${standing.assigned} ${unitWord(evaluation.unit)} assigned to you; half is ${standing.threshold}.`, rule: 'behind.person', values: { assigned: standing.assigned, closed: standing.closed, threshold: standing.threshold } },
      { label: `At this pace about ${shortfall} ${unit} won't finish by ${dayWord(summary.endDate, today)}.`, rule: 'behind.projection', values: { willNotFinish: shortfall } },
    ],
    headline: `You're behind in ${summary.name}`,
    kind: 'behind',
    people: [],
    say: `You've closed ${standing.closed} of your ${standing.assigned} ${unit}. At this pace about ${shortfall} ${unit} won't finish by ${dayWord(summary.endDate, today)}.`,
    scope: 'person',
    sprint: panelSprint(entry, standing),
  };
}

function teamStatus(entry, members, today) {
  const { evaluation, summary } = entry;
  const unit = shortUnit(evaluation.unit);
  const behindPeople = evaluation.people
    .filter((person) => person.behind)
    // Furthest under the line, in points, first.
    .sort((left, right) => (right.threshold - right.closed) - (left.threshold - left.closed) || left.id.localeCompare(right.id))
    .map((person) => ({ ...person, name: members.get(person.id) || 'Unknown person' }));
  const names = behindPeople.map((person) => `${person.name} (${person.closed} of ${person.assigned} ${unit})`).join(', ');
  const total = evaluation.total;
  const evidence = [
    ...ruleEvidence(entry),
    { label: `The sprint closed ${total.closed} of ${total.assigned} ${unitWord(evaluation.unit)}; half is ${total.threshold}.`, rule: 'behind.sprint', values: { assigned: total.assigned, closed: total.closed, threshold: total.threshold } },
    ...behindPeople.map((person) => ({ label: `${person.name} closed ${person.closed} of ${person.assigned}; half is ${person.threshold}.`, rule: 'behind.person', values: { assigned: person.assigned, closed: person.closed, personId: person.id, threshold: person.threshold } })),
  ];
  if (total.behind) {
    const shortfall = projectedShortfall(evaluation, total);
    evidence.push({ label: `At this pace about ${shortfall} ${unit} won't finish by ${dayWord(summary.endDate, today)}.`, rule: 'behind.projection', values: { willNotFinish: shortfall } });
  }
  return {
    evidence,
    headline: total.behind ? `${summary.name} is behind` : `${behindPeople.length === 1 ? '1 person is' : `${behindPeople.length} people are`} behind in ${summary.name}`,
    kind: 'behind',
    people: behindPeople,
    say: [
      total.behind ? `At this pace about ${projectedShortfall(evaluation, total)} ${unit} will not finish by ${dayWord(summary.endDate, today)}.` : '',
      names ? `Behind: ${names}.` : '',
    ].filter(Boolean).join(' '),
    scope: total.behind ? 'sprint' : 'team',
    sprint: panelSprint(entry, total),
  };
}

function isBehindEntry(entry) {
  return entry.evaluation.total.behind || entry.evaluation.people.some((person) => person.behind);
}

function onTrack(say, entry = null) {
  return { evidence: [], headline: 'On track.', kind: 'on-track', people: [], say, scope: null, sprint: entry ? entry.summary : null };
}

const NONE = Object.freeze({ evidence: [], headline: '', kind: 'none', people: [], say: '', scope: null, sprint: null });

/**
 * The status for a lens, and the subject recovery proposals work on (null when nothing is
 * behind or the lens offers no proposals). `sprints` are evaluateActiveSprints results for
 * the projects the lens covers.
 */
export function buildHomeStatus({ lens, members, sprints, today, viewer }) {
  if (lens === HOME_LENS.WORKSPACE) {
    const behind = sprints.filter(isBehindEntry);
    if (behind.length > 0) {
      return {
        status: { ...NONE, headline: `${behind.length} ${behind.length === 1 ? 'sprint is' : 'sprints are'} behind across the workspace.`, kind: 'behind', say: 'Their managers see recovery options on their home.', scope: 'workspace' },
        subject: null,
      };
    }
    return { status: sprints.length > 0 ? onTrack('No sprint in the workspace is behind.') : NONE, subject: null };
  }

  if (lens === HOME_LENS.TEAM) {
    const behind = sprints.filter(isBehindEntry).sort((left, right) => Number(right.evaluation.total.behind) - Number(left.evaluation.total.behind)
      || right.evaluation.people.filter((person) => person.behind).length - left.evaluation.people.filter((person) => person.behind).length
      || shortfallShare(right.evaluation.total) - shortfallShare(left.evaluation.total));
    const worst = behind[0];
    if (!worst) return { status: sprints.length > 0 ? onTrack('No sprint on your projects is behind.') : NONE, subject: null };
    const status = teamStatus(worst, members, today);
    const subject = worst.evaluation.total.behind
      ? { scope: 'sprint' }
      : { personId: status.people[0].id, personName: status.people[0].name, scope: 'person' };
    return { status: { ...status, otherBehindSprints: behind.length - 1 }, subject: { entry: worst, subject } };
  }

  const mine = sprints
    .map((entry) => ({ entry, standing: entry.evaluation.people.find((person) => person.id === viewer.id) }))
    .filter(({ standing }) => standing && standing.assigned > 0);
  const behind = mine.filter(({ standing }) => standing.behind).sort((left, right) => shortfallShare(right.standing) - shortfallShare(left.standing));
  if (behind[0]) {
    return {
      status: { ...personStatus(behind[0].entry, viewer, today), otherBehindSprints: behind.length - 1 },
      subject: { entry: behind[0].entry, subject: { personId: viewer.id, personName: viewer.name, scope: 'person' } },
    };
  }
  const main = mine.sort((left, right) => right.standing.assigned - left.standing.assigned)[0]?.entry;
  if (!main) return { status: NONE, subject: null };
  return { status: onTrack(`${main.summary.name} is ${main.summary.donePct}% done with ${main.summary.elapsedPct}% of the time gone.`, main), subject: null };
}
