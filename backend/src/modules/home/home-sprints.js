import { estimateHoursFor } from '../../lib/projects/work-progress.js';
import { evaluateSprintPeople } from '../../lib/projects/health-signals.js';
import { dateOnly } from './home-dates.js';
import { sprintLeaves } from './home-items.js';

// Active sprints on the projects Home read, each judged with the behind rule from
// lib/projects/health-signals.js: per person and for the sprint as a whole.

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/** The sprint work moves into: the next one not completed, by start date then order. */
export function nextSprintFor(sprints, sprint) {
  const later = sprints
    .filter((candidate) => candidate.id !== sprint.id && !['active', 'completed', 'closed'].includes(String(candidate.status ?? '').toLowerCase()))
    .filter((candidate) => {
      const start = dateOnly(candidate.startDate);
      const end = dateOnly(sprint.endDate);
      return start && end ? start >= end : Number(candidate.sortOrder ?? 0) > Number(sprint.sortOrder ?? 0);
    })
    .sort((left, right) => String(dateOnly(left.startDate) ?? '9999').localeCompare(String(dateOnly(right.startDate) ?? '9999'))
      || Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0));
  return later[0] ?? null;
}

/**
 * Hours of open sprint work against the hours of capacity left, per staffed person.
 * Capacity left is the sprint capacity times the share of working days not yet gone.
 */
export function sprintLoad({ elapsed, leaves, staffing }) {
  const load = new Map();
  for (const entry of staffing ?? []) {
    const capacity = Number(entry.capacityHours);
    if (!entry.userId || !Number.isFinite(capacity) || capacity <= 0) continue;
    load.set(entry.userId, { capacityLeft: round(capacity * Math.max(0, 1 - elapsed)), hoursLeft: 0, userId: entry.userId });
  }
  for (const item of leaves) {
    const entry = load.get(item.assigneeId);
    if (entry && item.open) entry.hoursLeft = round(entry.hoursLeft + estimateHoursFor(item).hours);
  }
  return load;
}

/** Every active sprint on the given projects with its people judged, newest start first. */
export function evaluateActiveSprints(contexts, today) {
  const results = [];
  for (const ctx of contexts) {
    for (const sprint of ctx.sprints) {
      if (String(sprint.status ?? '').toLowerCase() !== 'active') continue;
      const leaves = sprintLeaves(ctx.items, sprint.id);
      const evaluation = evaluateSprintPeople({ calendar: ctx.calendar, items: leaves, sprint, today });
      if (!evaluation) continue;
      const { total } = evaluation;
      const projected = evaluation.elapsed > 0 ? Math.min(total.assigned, total.closed / evaluation.elapsed) : total.assigned;
      results.push({
        ctx,
        evaluation,
        leaves,
        load: sprintLoad({ elapsed: evaluation.elapsed, leaves, staffing: sprint.staffing }),
        nextSprint: nextSprintFor(ctx.sprints, sprint),
        sprint,
        summary: {
          behind: total.behind,
          committedPoints: total.assigned,
          donePct: total.assigned > 0 ? Math.round((total.closed / total.assigned) * 100) : 0,
          donePoints: total.closed,
          elapsedPct: Math.round(evaluation.elapsed * 100),
          endDate: dateOnly(sprint.endDate),
          id: sprint.id,
          name: sprint.name ?? 'Sprint',
          projectId: ctx.project.id,
          projectName: ctx.project.name,
          projectedPoints: round(projected),
          startDate: dateOnly(sprint.startDate),
          threshold: total.threshold,
          unit: evaluation.unit,
          willNotFinishPoints: round(Math.max(0, total.assigned - projected)),
        },
      });
    }
  }
  return results.sort((left, right) => String(right.summary.startDate ?? '').localeCompare(String(left.summary.startDate ?? '')));
}
