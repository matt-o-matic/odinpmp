// Display and form rules for the link-only task pages (/access/:token): the hub's projects,
// the board and list of the person's epics, stories and tasks, the forms, and what each error
// means for the page. Everything here is plain data in, plain data out, so the pages and the
// tests share one set of rules.

import { buildKanbanMovePatch, resolveKanbanColumn } from '../projects/kanban-placement.js';
import { itemTypeMeta } from '../projects/work-item-relations.js';
import { classifyPortalError, isLinkProblem } from '../requirements/portal-view.js';
import { requirementsErrorCode } from '../requirements/requirements-errors.js';

export const ALL_SPRINTS = '';
export const NO_SPRINT = 'none';
// Matches the item editor's bounds for logged hours.
export const MAX_TASK_HOURS = 100000;
export const MAX_ENTRY_HOURS = 24;
export const TASK_NAME_MAX_LENGTH = 200;
export const TASK_DESCRIPTION_MAX_LENGTH = 5000;
export const TIME_NOTE_MAX_LENGTH = 2000;

function list(value) {
  return Array.isArray(value) ? value : [];
}

function errorCode(error) {
  return requirementsErrorCode(error);
}

/**
 * An item's type as the app shows it: its icon, its label ("Story"), and the word for sentences
 * ("story"). A type the page doesn't know reads as "item".
 */
export function itemTypeText(itemType) {
  const meta = itemTypeMeta(itemType);
  return { icon: meta.icon, label: meta.label, noun: meta.label.toLowerCase() };
}

/** What an item sits under, for its card and detail: a task's story, a story's epic, or null. */
export function itemParent(item) {
  if (!item?.parentName) return null;
  if (item.itemType === 'task') return { ...itemTypeText('story'), epicName: item.epicName || '', name: item.parentName };
  if (item.itemType === 'story') return { ...itemTypeText('epic'), epicName: '', name: item.parentName };
  return null;
}

// ---- Errors ----------------------------------------------------------------------------

/**
 * What a failed request means for the whole page: the link's own problems (`not-found`,
 * `expired`, `revoked`, `rate-limited`, `failed`) as on the requirements portal, plus
 * `no-project` when the link still works but this project is no longer shared.
 */
export function classifyAccessError(error) {
  if (errorCode(error) === 'no_project_access') return { kind: 'no-project' };
  return classifyPortalError(error);
}

/** The page-level problem behind a write error, or null when the page itself still works. */
export function pageProblemFor(error) {
  if (isLinkProblem(error) || errorCode(error) === 'no_project_access') return classifyAccessError(error);
  return null;
}

// Refusals the server explains: the workflow refuses a status change (409, or 403 for a role
// the step needs), or a story can't be completed because completing it would also complete
// someone else's open tasks (409). The server's message says why; these are the words when it
// doesn't. `{item}` is the item's type ("story").
const REFUSALS = Object.freeze({
  story_has_others_open_tasks: 'Other people still have open tasks on this story, so it can’t be completed here. Ask the project team.',
  workflow_approval_required: 'That status change needs approval from the project team first.',
  workflow_required_fields_missing: 'The project needs more details on this {item} before it can move to that status. Ask the project team.',
  workflow_transition_not_allowed: 'The project’s workflow doesn’t allow moving this {item} to that status.',
  workflow_transition_role_denied: 'You can’t make that status change. Ask the project team.',
});

const PLAIN_MESSAGES = Object.freeze({
  column_not_found: 'That column is no longer on the board. The board now shows the current columns.',
  comment_empty: 'Write a comment first.',
  not_your_task: 'This {item} is no longer assigned to you, so you can’t change it.',
  status_not_allowed: 'That status isn’t on this board any more. The board now shows the current columns.',
  story_not_available: 'You can no longer add tasks to this story.',
  task_not_found: 'This {item} is no longer there.',
  time_entry_not_found: 'That time entry is no longer there.',
});

// After these, what the page shows is out of date, so it reads the board again.
const RELOAD_CODES = new Set(['column_not_found', 'not_your_task', 'status_not_allowed', 'story_not_available', 'task_not_found', 'time_entry_not_found', 'version_conflict']);

function withItem(text, itemType) {
  return text.replaceAll('{item}', itemTypeText(itemType).noun);
}

/** The server's own sentence (`error`, or `details.message`), when it is one and not a code. */
function serverMessage(error) {
  const data = error?.data ?? {};
  const text = typeof data.error === 'string' ? data.error.trim() : '';
  if (text && !/^[a-z]+(?:_[a-z]+)+$/.test(text) && text !== 'Request failed.') return text;
  const details = data.details && !Array.isArray(data.details) ? data.details : {};
  return typeof details.message === 'string' ? details.message.trim() : '';
}

/**
 * A write error in plain words, naming the item by its type (`itemType`: "this story"; an
 * unknown type reads "this item"). `conflict` is set only for a version conflict: someone else
 * changed the item first, so the page reloads and shows their change. `reload` means the page
 * is out of date and should read the board again. `problem` is set when the link or project
 * stopped working and the page should show its explanation screen instead.
 */
export function describeAccessWriteError(error, { itemType = '' } = {}) {
  const problem = pageProblemFor(error);
  const code = errorCode(error);
  const status = Number(error?.status) || 0;
  const result = (message, extra = {}) => ({ code, conflict: false, message, problem: null, reload: RELOAD_CODES.has(code), ...extra });
  if (problem) return { code, conflict: false, message: '', problem, reload: false };
  if (code === 'version_conflict') {
    return result(withItem('Someone else changed this {item} while you were working on it. It now shows their changes.', itemType), { conflict: true });
  }
  if (REFUSALS[code]) return result(serverMessage(error) || withItem(REFUSALS[code], itemType));
  // A closed or locked timesheet period.
  if (status === 423) return result(serverMessage(error) || 'That timesheet period is closed, so its time can’t change.');
  if (PLAIN_MESSAGES[code]) return result(withItem(PLAIN_MESSAGES[code], itemType));
  if (code === 'rate_limited' || status === 429) return result('Too many changes in a short time. Wait a moment, then try again.');
  if (status === 400) {
    const data = error?.data ?? {};
    const first = Array.isArray(data.details) ? data.details[0] : null;
    const detail = String(first?.message ?? '').trim();
    return { ...result(detail || serverMessage(error) || 'Check the values and try again.'), code: code || 'invalid_request' };
  }
  if (status === 403 || status === 409) return result(serverMessage(error) || 'That change wasn’t saved.');
  return result('That didn’t save. Check your connection and try again.');
}

// ---- Hub -------------------------------------------------------------------------------

/** Projects the link opens, each with Tasks, Requirements, or both. */
export function hubProjects(hub) {
  return list(hub?.projects).filter((project) => project?.id && (project.tasks || project.requirements));
}

/** With exactly one project shared, and only its tasks, the hub opens it directly. */
export function directTasksProjectId(hub) {
  const projects = hubProjects(hub);
  if (projects.length !== 1) return null;
  const [project] = projects;
  return project.tasks && !project.requirements ? project.id : null;
}

/** One line under a hub row: what the person can see there. */
export function hubProjectSummary(project) {
  const parts = [];
  if (project?.tasks?.scope === 'all') parts.push('All work (you update yours)');
  else if (project?.tasks) parts.push('Your work');
  if (project?.requirements) parts.push('Requirements');
  return parts.join(' · ');
}

/** The header's link line: "Link works until Nov 12", or "Link active" while access lasts. */
export function accessLinkText(link, { locale } = {}) {
  if (!link) return '';
  const until = formatDateTime(link.expiresAt, { locale });
  return until ? `Link works until ${until}` : 'Link active';
}

function formatDateTime(value, { locale } = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date);
}

// ---- Filters ---------------------------------------------------------------------------

/** The Mine / Everyone switch only exists with Everyone's work; Mine is the default. */
export function showsEveryoneFilter(scope) {
  return scope === 'all';
}

/** The epics, stories and tasks the Mine / Everyone switch and the sprint filter leave. */
export function filterTasks(items, { mineOnly = false, sprintId = ALL_SPRINTS } = {}) {
  return list(items).filter((item) => (!mineOnly || item.mine) && sprintMatches(item.sprintId, sprintId));
}

function sprintMatches(itemSprintId, sprintId) {
  if (sprintId === ALL_SPRINTS || sprintId == null) return true;
  if (sprintId === NO_SPRINT) return !itemSprintId;
  return itemSprintId === sprintId;
}

/** "All sprints", each sprint (the active one marked), and "No sprint" when an item has none. */
export function sprintOptions(sprints, items = []) {
  const options = [{ label: 'All sprints', value: ALL_SPRINTS }];
  for (const sprint of list(sprints)) {
    if (!sprint?.id) continue;
    options.push({ label: sprint.status === 'active' ? `${sprint.name} (current)` : sprint.name || 'Untitled sprint', value: sprint.id });
  }
  if (list(items).some((item) => !item.sprintId)) options.push({ label: 'No sprint', value: NO_SPRINT });
  return options;
}

/** Why the board or list is empty, in words that point at the filter to change. */
export function emptyTasksText({ mineOnly = false, sprintId = ALL_SPRINTS, total = 0 } = {}) {
  if (!total) return 'Nothing here yet.';
  if (mineOnly && sprintId !== ALL_SPRINTS) return 'You have no work in this sprint. Choose Everyone or another sprint to see more.';
  if (mineOnly) return 'You have no work on this project. Choose Everyone to see the rest.';
  return 'Nothing in this sprint.';
}

// ---- Board -----------------------------------------------------------------------------

/**
 * The board's columns with their cards (epics, stories and tasks alike), placed the way the
 * app's board places cards: by `boardColumn` when that column accepts the status, else the
 * first column that does. Cards whose status no column accepts come back as `unplaced`.
 */
export function boardColumns(columns, items) {
  const placed = list(columns).map((column) => ({ ...column, items: [], statuses: list(column.statuses) }));
  const unplaced = [];
  for (const item of list(items)) {
    const column = resolveKanbanColumn(item, placed);
    if (column) column.items.push(item);
    else unplaced.push(item);
  }
  return { columns: placed, unplaced };
}

/**
 * The PATCH a drop sends: the column it landed in, and the column's default status when the
 * column does not accept the item's current status (the app's board does the same). A drop
 * back into the same column, or of someone else's card, sends nothing.
 */
export function boardDropPatch(task, column, fromColumnKey = null) {
  if (!task?.mine || !column?.key || column.key === fromColumnKey) return null;
  const move = buildKanbanMovePatch(task, column);
  const patch = { boardColumn: move.boardColumn, expectedVersion: task.version };
  if (move.status && move.status !== task.status) patch.status = move.status;
  return patch;
}

/** Applies a change to one item in the list, for showing a move before the save returns. */
export function applyTaskChange(items, itemId, change) {
  return list(items).map((item) => (item.id === itemId ? { ...item, ...change } : item));
}

/** Statuses the detail's status control offers: every column's, in board order, plus the item's own. */
export function statusChoices(columns, currentStatus = '') {
  const statuses = [];
  for (const column of list(columns)) statuses.push(...list(column.statuses));
  if (currentStatus) statuses.push(currentStatus);
  return [...new Set(statuses.map((status) => String(status ?? '').trim()).filter(Boolean))];
}

// ---- List ------------------------------------------------------------------------------

/**
 * The list's groups. Epics come first in a group of their own. Then each story, in the
 * stories' order, with the story itself first when it is shown as an item, then its tasks.
 * Stories with nothing to show are left out; items whose story is missing go in a last group.
 */
export function groupTasksByStory(stories, items) {
  const epics = [];
  const byStory = new Map();
  for (const item of list(items)) {
    if (item.itemType === 'epic') {
      epics.push(item);
      continue;
    }
    const key = item.storyId ?? '';
    const entries = byStory.get(key) ?? [];
    // A story's own card leads its group.
    if (item.itemType === 'story' && item.id === key) entries.unshift(item);
    else entries.push(item);
    byStory.set(key, entries);
  }
  const groups = [];
  if (epics.length) groups.push({ items: epics, key: 'epics', story: null, title: 'Epics' });
  for (const story of list(stories)) {
    const storyItems = byStory.get(story.id);
    if (!storyItems?.length) continue;
    groups.push({ items: storyItems, key: story.id, story, title: story.name || 'Untitled story' });
    byStory.delete(story.id);
  }
  const orphans = [...byStory.values()].flat();
  if (orphans.length) groups.push({ items: orphans, key: 'no-story', story: null, title: 'Other work' });
  return groups;
}

export function storiesForNewTask(stories) {
  return list(stories).filter((story) => story?.canAddTask);
}

// ---- Display ---------------------------------------------------------------------------

/** "Nov 3" for a YYYY-MM-DD date, read as a calendar day rather than UTC midnight. */
export function formatDay(value, { locale } = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date);
}

/** Today as YYYY-MM-DD in local time, the default day for logging time. */
export function todayInputValue(now = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const DONE_PATTERN = /^(completed?|done|closed|resolved|cancell?ed)\b/i;

/**
 * A status as people read it. Boards on a workflow use state keys (`in_progress`), which read
 * as "In progress"; names such as "In Progress" stay as they are.
 */
export function statusLabel(status) {
  const text = String(status ?? '').trim();
  if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(text)) return text;
  const words = text.replace(/[_-]+/g, ' ');
  return `${words[0].toUpperCase()}${words.slice(1)}`;
}

/** "Due Nov 3", with "overdue" in the words (not just the color) once the day has passed. */
export function dueText(task, { locale, now = new Date() } = {}) {
  const day = formatDay(task?.targetEndDate, { locale });
  if (!day) return { overdue: false, text: '' };
  const overdue = String(task.targetEndDate).slice(0, 10) < todayInputValue(now) && !DONE_PATTERN.test(statusLabel(task.status));
  return { overdue, text: overdue ? `Overdue, due ${day}` : `Due ${day}` };
}

export function formatHours(value) {
  if (value === '' || value == null) return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return `${Math.round(number * 100) / 100} h`;
}

/** "8 h estimate · 3 h left" from whichever of the two is set. */
export function hoursText(task) {
  const parts = [];
  const estimate = formatHours(task?.targetHourEstimate);
  const remaining = formatHours(task?.remainingHours);
  if (estimate) parts.push(`${estimate} estimate`);
  if (remaining) parts.push(`${remaining} left`);
  return parts.join(' · ');
}

/** A tone and icon for a status chip. The status text is always shown too. */
export function statusTone(status) {
  const text = statusLabel(status);
  if (DONE_PATTERN.test(text)) return { icon: 'bi-check2-circle', tone: 'ok' };
  if (/risk|block|hold|stuck/i.test(text)) return { icon: 'bi-exclamation-triangle', tone: 'warn' };
  if (/^(not started|to ?do|new|backlog|open)\b/i.test(text) || !text) return { icon: 'bi-circle', tone: 'neutral' };
  return { icon: 'bi-play-circle', tone: 'active' };
}

// ---- Forms -----------------------------------------------------------------------------

/** Parses an hours field. Blank is null unless the field is required. */
export function parseHours(value, { label = 'Hours', max = MAX_TASK_HOURS, positive = false, required = false, whole = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return required ? { error: `Enter the ${label.toLowerCase()}.` } : { value: null };
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) return { error: `${label} must be a number, 0 or more.` };
  if (positive && number <= 0) return { error: `${label} must be more than 0.` };
  if (whole && !Number.isInteger(number)) return { error: `${label} must be whole hours.` };
  if (number > max) return { error: `${label} can be at most ${max}.` };
  return { value: Math.round(number * 100) / 100 };
}

/** The status and remaining-hours form for an item assigned to the person, from the item as shown. */
export function taskUpdateForm(task) {
  return {
    baseRemaining: task?.remainingHours ?? null,
    baseStatus: task?.status ?? '',
    baseVersion: task?.version ?? null,
    remainingHours: task?.remainingHours == null ? '' : String(task.remainingHours),
    status: task?.status ?? '',
  };
}

/**
 * The PATCH for the status and remaining-hours form, against the version the form started
 * from. Only changed fields are sent; `payload` is null when nothing changed.
 */
export function buildTaskUpdate(form) {
  const remaining = parseHours(form?.remainingHours, { label: 'Remaining hours' });
  if (remaining.error) return { errors: { remainingHours: remaining.error }, payload: null };
  const payload = { expectedVersion: form.baseVersion };
  if (form.status && form.status !== form.baseStatus) payload.status = form.status;
  const base = form.baseRemaining == null ? null : Number(form.baseRemaining);
  if (remaining.value !== base) payload.remainingHours = remaining.value;
  return { errors: {}, payload: Object.keys(payload).length > 1 ? payload : null };
}

export function timeEntryForm(now = new Date()) {
  return { hours: '', note: '', remainingHours: '', workDate: todayInputValue(now) };
}

export function buildTimeEntry(form) {
  const errors = {};
  const workDate = String(form?.workDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) errors.workDate = 'Choose the day you worked.';
  const hours = parseHours(form?.hours, { label: 'Hours', max: MAX_ENTRY_HOURS, positive: true, required: true });
  if (hours.error) errors.hours = hours.error;
  const note = String(form?.note ?? '').trim();
  if (note.length > TIME_NOTE_MAX_LENGTH) errors.note = `Keep the note under ${TIME_NOTE_MAX_LENGTH} characters.`;
  const remaining = parseHours(form?.remainingHours, { label: 'Remaining hours' });
  if (remaining.error) errors.remainingHours = remaining.error;
  if (Object.keys(errors).length) return { errors, payload: null };
  const payload = { hours: hours.value, workDate };
  if (note) payload.note = note;
  if (remaining.value != null) payload.remainingHours = remaining.value;
  return { errors, payload };
}

/** Only entries still waiting for approval can be deleted from the link. */
// Time on an invoice stays as billed (invoice-gen E-06).
export function canDeleteTimeEntry(entry) {
  return String(entry?.status ?? '') === 'submitted' && !entry?.invoiced;
}

export function timeEntryStatusLabel(status) {
  const labels = { approved: 'Approved', rejected: 'Rejected', submitted: 'Submitted' };
  return labels[status] ?? (status ? `${String(status)[0].toUpperCase()}${String(status).slice(1)}` : '');
}

export function newTaskForm(storyId = '') {
  return { description: '', estimate: '', name: '', storyId };
}

export function buildNewTask(form, stories = []) {
  const errors = {};
  if (!list(stories).some((story) => story.id === form?.storyId)) errors.storyId = 'Choose the story this task belongs to.';
  const name = String(form?.name ?? '').trim();
  if (!name) errors.name = 'Give the task a name.';
  else if (name.length > TASK_NAME_MAX_LENGTH) errors.name = `Task names can be up to ${TASK_NAME_MAX_LENGTH} characters.`;
  const description = String(form?.description ?? '').trim();
  if (description.length > TASK_DESCRIPTION_MAX_LENGTH) errors.description = `Keep the description under ${TASK_DESCRIPTION_MAX_LENGTH} characters.`;
  const estimate = parseHours(form?.estimate, { label: 'Estimate', whole: true });
  if (estimate.error) errors.estimate = estimate.error;
  if (Object.keys(errors).length) return { errors, payload: null };
  const payload = { name };
  if (description) payload.description = description;
  if (estimate.value != null) payload.targetHourEstimate = estimate.value;
  return { errors, payload };
}
