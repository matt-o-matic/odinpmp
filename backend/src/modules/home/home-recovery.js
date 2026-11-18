import { createHash } from 'node:crypto';

import { BEHIND_BELOW_DONE_SHARE } from '../../lib/projects/health-signals.js';
import { estimateHoursFor } from '../../lib/projects/work-progress.js';
import { governanceItemCreateSchema } from '../governance/governance.schema.js';
import { addDays, dateOnly, shortDate } from './home-dates.js';

// Recovery proposals (hybrid, user decision 2026-10-12): when someone is behind, Home lists
// rule-based ways back on track straight away, without calling AI. Choosing one stages it
// into an AI Workspace session (home.service.js), where Odin explains it and the person
// applies or rejects it. Nothing here changes anything.
//
// A proposal's id hashes what it would change (items and their versions, destinations), so
// the same data gives the same id and any change to that data retires it. Staging recomputes
// the proposals and accepts only an id that still exists and that the person may apply.

export const PROPOSAL_LIMIT = 3;
const MOVE_ITEM_LIMIT = 5;
const MILESTONE_LOOKAHEAD_DAYS = 30;
const CLOSED_MILESTONE_STATUSES = new Set(['achieved', 'cancelled', 'missed']);

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function proposalId(parts) {
  return `rp_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)}`;
}

function unitShort(unit, value) {
  return unit === 'points' ? `${round(value)} pts` : `${round(value)} ${value === 1 ? 'item' : 'items'}`;
}

function firstName(name) {
  return String(name ?? '').trim().split(/\s+/)[0] || 'They';
}

function describeItems(items) {
  if (items.length === 1) return `“${items[0].name}”`;
  const types = new Set(items.map((item) => item.itemType));
  const noun = types.size === 1 ? (types.has('story') ? 'stories' : 'tasks') : 'items';
  return `${items.length} ${noun}`;
}

/**
 * What a move or split expects to find when the person applies it: each item's version,
 * sprint and status now, and the sprint it moves work into. The apply refuses with 409 if any
 * of it changed (assistant-recovery-actions.js).
 */
function expectedState(items, destination) {
  return {
    items: items.map((item) => ({ id: item.id, name: item.name, sprintId: item.sprintId ?? null, status: item.status, version: item.version })),
    openSprintIds: destination ? [destination.id] : [],
  };
}

/** The standing the proposals work on: one person, or the sprint as a whole. */
function standingFor(entry, subject) {
  return subject.scope === 'person' ? entry.evaluation.people.find((person) => person.id === subject.personId) ?? null : entry.evaluation.total;
}

/** Points (or items) to move out so the closed share reaches the threshold. */
function shortfallToClear(standing) {
  return Math.max(0, standing.assigned - standing.closed / BEHIND_BELOW_DONE_SHARE);
}

function weightFor(entry) {
  return (item) => (entry.evaluation.unit === 'points' ? item.points : 1);
}

function moveScopeProposal(entry, subject) {
  const { ctx, leaves, nextSprint, sprint } = entry;
  const standing = standingFor(entry, subject);
  if (!standing) return null;
  const weight = weightFor(entry);
  const need = shortfallToClear(standing);
  const candidates = leaves
    .filter((item) => item.notStarted && weight(item) > 0 && (subject.scope !== 'person' || item.assigneeId === subject.personId))
    // Lowest priority first, then the biggest, so the fewest items move.
    .sort((left, right) => right.priority - left.priority || weight(right) - weight(left) || left.name.localeCompare(right.name));
  const picked = [];
  let freed = 0;
  for (const item of candidates) {
    if (picked.length >= MOVE_ITEM_LIMIT || (picked.length > 0 && freed >= need)) break;
    picked.push(item);
    freed += weight(item);
  }
  if (picked.length === 0) return null;
  const destination = nextSprint ? nextSprint.name : 'the backlog';
  const clears = freed >= need;
  const assignments = picked.map((item) => ({ itemId: item.id, itemType: item.itemType, sprintId: nextSprint?.id ?? null }));
  return {
    detail: 'Not started, lowest priority first.',
    id: proposalId(['move-scope', ctx.project.id, sprint.id, subject.personId ?? null, picked.map((item) => [item.id, item.version]).sort(), nextSprint?.id ?? null]),
    impact: { days: null, points: round(freed), text: clears ? (subject.scope === 'person' ? 'Brings the work back over the line.' : 'Brings the sprint back within reach.') : `Frees ${unitShort(entry.evaluation.unit, freed)}.` },
    stage: {
      createPayload: { expected: expectedState(picked, nextSprint), input: { assignments } },
      name: `Move ${describeItems(picked)} to ${destination}`,
      rationaleSummary: `Moves ${picked.map((item) => `“${item.name}”`).join(', ')} out of ${sprint.name} to ${destination}.`,
      targetId: sprint.id,
      targetType: 'sprint',
      type: 'sprint_items_move',
    },
    summary: `Move ${describeItems(picked)} (${unitShort(entry.evaluation.unit, freed)}) to ${destination}`,
    type: 'move-scope',
  };
}

function reassignProposal(entry, subject) {
  const { ctx, evaluation, leaves, load, sprint } = entry;
  const weight = weightFor(entry);
  const behindPeople = evaluation.people.filter((person) => person.behind);
  const person = subject.scope === 'person'
    ? evaluation.people.find((candidate) => candidate.id === subject.personId)
    // The same order as the status panel: furthest under the line, in points, first.
    : behindPeople.sort((left, right) => (right.threshold - right.closed) - (left.threshold - left.closed) || left.id.localeCompare(right.id))[0];
  if (!person?.behind) return null;
  const item = leaves
    .filter((leaf) => leaf.assigneeId === person.id && leaf.notStarted && weight(leaf) > 0)
    .sort((left, right) => weight(right) - weight(left) || right.priority - left.priority || left.name.localeCompare(right.name))[0];
  if (!item) return null;
  const points = weight(item);
  const hours = estimateHoursFor(item).hours;
  const freeHours = (userId) => {
    const staffed = load.get(userId);
    return staffed ? round(staffed.capacityLeft - staffed.hoursLeft) : null;
  };
  // Someone on the sprint who stays on track after taking the item, and has the hours.
  const teammate = evaluation.people
    .filter((candidate) => candidate.id !== person.id && !candidate.behind && candidate.closed >= (candidate.assigned + points) * BEHIND_BELOW_DONE_SHARE)
    .filter((candidate) => freeHours(candidate.id) == null || freeHours(candidate.id) >= hours)
    .sort((left, right) => (right.closed / BEHIND_BELOW_DONE_SHARE - right.assigned) - (left.closed / BEHIND_BELOW_DONE_SHARE - left.assigned)
      || (freeHours(right.id) ?? 0) - (freeHours(left.id) ?? 0)
      || left.id.localeCompare(right.id))[0];
  if (!teammate) return null;
  const teammateName = ctx.members.get(teammate.id) || 'a teammate';
  const free = freeHours(teammate.id);
  return {
    detail: free != null
      ? `${firstName(teammateName)} has ${free} free hours this sprint.`
      : `${firstName(teammateName)} has closed ${unitShort(entry.evaluation.unit, teammate.closed)} of ${unitShort(entry.evaluation.unit, teammate.assigned)}.`,
    id: proposalId(['reassign', ctx.project.id, sprint.id, item.id, item.version, person.id, teammate.id]),
    impact: { days: null, points: round(points), text: `Frees ${unitShort(entry.evaluation.unit, points)}.` },
    stage: {
      createPayload: { input: { assigneeId: teammate.id, expectedVersion: item.version } },
      name: `Reassign “${item.name}” to ${teammateName}`,
      rationaleSummary: `Assigns “${item.name}” to ${teammateName} instead of ${ctx.members.get(person.id) || 'its current assignee'}.`,
      targetId: item.id,
      targetType: 'assignment',
      type: 'assignee_change',
    },
    summary: `Reassign “${item.name}” to ${teammateName}`,
    type: 'reassign',
  };
}

function splitStoryProposal(entry, subject) {
  const { ctx, nextSprint, sprint } = entry;
  // A split keeps the moved tasks in their sprint unless it names another (projects
  // repository splitStory), so a split only frees points when there is a next sprint.
  if (!nextSprint) return null;
  const weight = weightFor(entry);
  let best = null;
  for (const story of ctx.items) {
    if (story.itemType !== 'story' || story.leaf || !story.open) continue;
    const tasks = ctx.items.filter((item) => item.itemType === 'task' && item.storyId === story.id);
    const inSprint = tasks.filter((task) => task.sprintId === sprint.id && !task.cancelled);
    const movable = inSprint.filter((task) => task.notStarted && (subject.scope !== 'person' || task.assigneeId === subject.personId));
    const started = inSprint.filter((task) => !task.notStarted);
    if (movable.length === 0 || started.length === 0) continue;
    const freed = movable.reduce((sum, task) => sum + weight(task), 0);
    if (freed > 0 && (!best || freed > best.freed)) best = { freed, movable, story, tasks };
  }
  if (!best) return null;
  const { freed, movable, story, tasks } = best;
  return {
    detail: `Move ${movable.length} of ${tasks.length} tasks to a new story in ${nextSprint.name}.`,
    id: proposalId(['split-story', ctx.project.id, sprint.id, story.id, story.version, movable.map((task) => [task.id, task.version]).sort(), nextSprint.id]),
    impact: { days: null, points: round(freed), text: `Frees ${unitShort(entry.evaluation.unit, freed)}.` },
    stage: {
      createPayload: {
        expected: expectedState([story, ...movable], nextSprint),
        input: {
          assigneeId: story.assigneeId,
          name: `${story.name} (follow-up)`.slice(0, 200),
          priority: story.priority,
          sprintId: nextSprint.id,
          status: 'Not Started',
          taskIds: movable.map((task) => task.id),
        },
      },
      name: `Split “${story.name}”`,
      rationaleSummary: `Moves ${movable.map((task) => `“${task.name}”`).join(', ')} to a new story, “${story.name} (follow-up)”, in ${nextSprint.name}.`,
      targetId: story.id,
      targetType: 'story_split',
      type: 'story_split',
    },
    summary: `Split “${story.name}” and finish the started part`,
    type: 'split-story',
  };
}

function shiftMilestoneProposal(entry, today) {
  const { ctx, sprint } = entry;
  const milestones = new Map((ctx.governance?.milestones ?? []).map((milestone) => [milestone.id, milestone]));
  const horizon = addDays(today, MILESTONE_LOOKAHEAD_DAYS);
  const late = (ctx.analysis?.milestoneForecasts ?? [])
    .map((forecast) => ({ forecast, milestone: milestones.get(forecast.id) }))
    .filter(({ forecast, milestone }) => {
      const target = dateOnly(forecast.targetDate);
      return milestone
        && !CLOSED_MILESTONE_STATUSES.has(String(milestone.status ?? '').toLowerCase())
        && target && target >= today && target <= horizon
        && Number(forecast.varianceWorkingDays) > 0
        && dateOnly(forecast.forecastDate);
    })
    .sort((left, right) => String(left.forecast.targetDate).localeCompare(String(right.forecast.targetDate)));
  const pick = late[0];
  if (!pick) return null;
  const { forecast, milestone } = pick;
  const target = dateOnly(forecast.targetDate);
  const next = dateOnly(forecast.forecastDate);
  const days = Number(forecast.varianceWorkingDays);
  return {
    detail: `Forecast is ${days} working ${days === 1 ? 'day' : 'days'} late.`,
    id: proposalId(['shift-milestone', ctx.project.id, sprint.id, milestone.id, milestone.version, next]),
    impact: { days, points: null, text: 'Removes the variance.' },
    stage: {
      createPayload: { input: { expectedVersion: milestone.version, targetDate: next } },
      name: `Move milestone “${milestone.title}” to ${shortDate(next)}`,
      rationaleSummary: `Moves the “${milestone.title}” target date from ${shortDate(target)} to ${shortDate(next)}, its schedule forecast.`,
      targetId: milestone.id,
      targetType: 'milestone',
      type: 'milestone_shift',
    },
    summary: `Shift milestone “${milestone.title}” from ${shortDate(target)} to ${shortDate(next)}`,
    type: 'shift-milestone',
  };
}

function raiseRiskProposal(entry, subject, viewer) {
  const { ctx, evaluation, sprint } = entry;
  const standing = standingFor(entry, subject);
  if (!standing) return null;
  const projected = evaluation.elapsed > 0 ? Math.min(standing.assigned, standing.closed / evaluation.elapsed) : standing.assigned;
  const shortfall = Math.max(1, Math.round(standing.assigned - projected));
  const unitWord = evaluation.unit === 'points' ? 'points' : 'items';
  const title = `${sprint.name} may not finish about ${shortfall} ${unitWord}`;
  const exists = (ctx.governance?.items ?? []).some((item) => item.kind === 'risk' && item.title === title && ['open', 'monitoring'].includes(item.status));
  if (exists) return null;
  const description = `${standing.closed} of ${standing.assigned} ${unitWord} closed with ${Math.round(evaluation.elapsed * 100)}% of ${sprint.name}'s working days gone. Raised from Home.`;
  const input = governanceItemCreateSchema.parse({ description, dueDate: dateOnly(sprint.endDate), impact: 'high', kind: 'risk', ownerId: viewer.id, probability: 'high', status: 'open', title });
  return {
    detail: 'Makes the delay visible to the project.',
    id: proposalId(['raise-risk', ctx.project.id, sprint.id, subject.personId ?? null, title]),
    impact: { days: null, points: null, text: 'Makes the delay visible to the project.' },
    stage: {
      createPayload: { input },
      name: `Raise a risk: ${title}`,
      rationaleSummary: `Records a high-impact risk, owned by ${viewer.name || 'you'}, due ${shortDate(input.dueDate ?? sprint.endDate)}.`,
      targetId: sprint.id,
      targetType: 'governance_item',
      type: 'governance_item_create',
    },
    summary: `Raise a risk: ${title}`,
    type: 'raise-risk',
  };
}

/**
 * Every rule-based proposal for one behind subject in one sprint, in the order Home offers
 * them, each marked permitted when the viewer may apply it (plan edit rights).
 */
export function generateRecoveryProposals({ entry, subject, today, viewer }) {
  const permitted = Boolean(entry.ctx.canEdit);
  return [
    moveScopeProposal(entry, subject),
    reassignProposal(entry, subject),
    splitStoryProposal(entry, subject),
    shiftMilestoneProposal(entry, today),
    raiseRiskProposal(entry, subject, viewer),
  ].filter(Boolean).map((proposal) => ({
    ...proposal,
    applyVia: 'ai-workspace',
    blockedReason: permitted ? null : `Needs edit rights on ${entry.ctx.project.name}.`,
    permitted,
    projectId: entry.ctx.project.id,
    sprintId: entry.sprint.id,
  }));
}

/**
 * The proposals Home shows: those the viewer may apply, up to PROPOSAL_LIMIT, and when there
 * is room one more they may not, marked as such, so they know what to ask for.
 */
export function selectProposals(proposals) {
  const allowed = proposals.filter((proposal) => proposal.permitted).slice(0, PROPOSAL_LIMIT);
  const blocked = proposals.filter((proposal) => !proposal.permitted);
  return allowed.length < PROPOSAL_LIMIT && blocked.length > 0 ? [...allowed, blocked[0]] : allowed;
}

/** A proposal as the client sees it: without the staged action. */
export function presentProposal({ stage: _stage, ...proposal }) {
  return proposal;
}
