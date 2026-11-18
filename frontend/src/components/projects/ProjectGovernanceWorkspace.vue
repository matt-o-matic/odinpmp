<script setup>
import { computed, reactive, ref, watch } from 'vue';

import { apiClient } from '../../lib/auth/index.js';
import { mergeRecord, recordsDiffer } from '../../lib/projects/project-merge.js';
import ProjectLiveUpdateNotice from './ProjectLiveUpdateNotice.vue';
import {
  flattenProjectWorkItems,
  goalChangeAccess,
  goalChangesLabel,
  goalConstraintsFromDraft,
  goalOwnerName,
  governanceItemCounts,
  governanceKindLabel,
  selectGovernanceItems,
} from '../../lib/projects/project-governance.js';

const props = defineProps({
  currentUserId: { default: '', type: String },
  project: { default: null, type: Object },
  projectId: { required: true, type: String },
  refreshVersion: { default: 0, type: Number },
  token: { default: '', type: String },
  users: { default: () => [], type: Array },
});
const emit = defineEmits(['error', 'message']);

const activeTab = ref('register');
const loading = ref(false);
const saving = ref(false);
const snapshot = ref({ dependencies: [], items: [], milestones: [], scheduleBaselines: [], workingCalendar: null });
const analysis = ref(null);
const goals = ref([]);
const query = ref('');
const kindFilter = ref('all');
const statusFilter = ref('all');
const sort = ref('updated_desc');
const page = ref(1);
const pageSize = 10;
const editor = ref(null);
const deleteTarget = ref(null);

const blankItem = () => ({
  description: '', dueDate: null, impact: 'medium', kind: 'risk', ownerId: null,
  probability: 'medium', responsePlan: '', status: 'open', title: '',
});
const blankMilestone = () => ({ status: 'planned', targetDate: props.project?.endDate ?? '', title: '', workItemId: null });
const blankDependency = () => ({ dependencyType: 'FS', lagDays: 0, predecessorId: '', successorId: '' });
const blankGoal = () => ({ allowWebResearch: false, autoApply: false, escalationAfterRuns: 1, escalationEmail: false, escalationWebhook: false, maxAttempts: 5, status: 'active', successMeasure: '', title: '', verifierOperator: 'all', verifierPredicates: [], verifierType: '' });
const blankMonitor = () => ({ conditionPath: '', conditionValue: '', eventType: 'governance.changed', intervalMinutes: 30, maxRuns: null, nextRunAt: '', title: '', triggerType: 'schedule' });
const blankCalendar = () => ({ holidaysText: '', hoursPerDay: 8, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', workingDays: [1, 2, 3, 4, 5] });
const blankBaseline = () => ({ name: '', note: '' });
const itemDraft = reactive(blankItem());
const milestoneDraft = reactive(blankMilestone());
const dependencyDraft = reactive(blankDependency());
const goalDraft = reactive(blankGoal());
const monitorDraft = reactive(blankMonitor());
const calendarDraft = reactive(blankCalendar());
const baselineDraft = reactive(blankBaseline());

const workItems = computed(() => flattenProjectWorkItems(props.project));
const workItemLabels = computed(() => new Map(workItems.value.map((item) => [item.id, item.label])));
const counts = computed(() => governanceItemCounts(snapshot.value.items));
const selectedItems = computed(() => selectGovernanceItems(snapshot.value.items, {
  kind: kindFilter.value,
  page: page.value,
  pageSize,
  query: query.value,
  sort: sort.value,
  status: statusFilter.value,
}));
// Whether the goal under edit may make changes, and whether this user may decide that.
const goalAccess = computed(() => goalChangeAccess(
  editor.value?.mode === 'edit' ? recordFor('goal', editor.value.id) : null,
  props.currentUserId,
));
const goalEditorOwnerName = computed(() => goalOwnerName(editor.value?.mode === 'edit' ? recordFor('goal', editor.value.id) : null, props.users));
const criticalPathLabels = computed(() => (analysis.value?.criticalPathIds ?? [])
  .map((id) => workItemLabels.value.get(id) ?? id));

watch([query, kindFilter, statusFilter, sort], () => { page.value = 1; });
watch(() => [props.projectId, props.token], () => loadGovernance(), { immediate: true });
watch(() => props.refreshVersion, () => loadGovernance({ live: true }));

async function loadGovernance({ live = false } = {}) {
  if (!props.projectId || !props.token) return;
  loading.value = !live;
  const keepCalendar = live && calendarDirty.value;
  const keepEditor = live && editorDirty.value;
  // Live refreshes come from someone else's change, so they load in the background.
  const client = live ? apiClient.passive : apiClient;
  try {
    const [governance, schedule, goalResult] = await Promise.all([
      client.getProjectGovernance(props.projectId, props.token),
      client.getProjectScheduleAnalysis(props.projectId, props.token),
      client.getAgentGoals(props.projectId, props.token),
    ]);
    snapshot.value = {
      dependencies: governance.dependencies ?? [],
      items: governance.items ?? [],
      milestones: governance.milestones ?? [],
      scheduleBaselines: governance.scheduleBaselines ?? [],
      workingCalendar: governance.workingCalendar ?? null,
    };
    reconcileCalendar(calendarFromRecord(governance.workingCalendar), keepCalendar);
    analysis.value = schedule.analysis ?? null;
    goals.value = await Promise.all((goalResult.goals ?? []).map(async (goal) => {
      const [detail, monitors, notifications] = await Promise.all([
        client.getAgentGoal(goal.id, props.token),
        client.getAgentGoalMonitors(goal.id, props.token),
        client.getAgentGoalNotifications(goal.id, props.token),
      ]);
      return { ...goal, monitors: monitors.monitors ?? [], notifications: notifications.notifications ?? [], runs: detail.runs ?? [] };
    }));
    reconcileEditor(keepEditor);
  } catch (error) {
    emit('error', error.message ?? 'Unable to load project governance.');
  } finally {
    loading.value = false;
  }
}

// ── Live updates ─────────────────────────────────────────────
// A refresh never overwrites a form with unsaved edits. When the record under edit changed
// elsewhere, the user merges the incoming values into their edits or discards their edits.
const CALENDAR_FIELDS = ['holidaysText', 'hoursPerDay', 'timezone', 'workingDays'];
const calendarBase = ref(null);
const editorConflict = ref(null);
const calendarConflict = ref(null);

function calendarFromRecord(calendar) {
  return {
    ...blankCalendar(),
    holidaysText: (calendar?.holidays ?? []).join('\n'),
    hoursPerDay: Number(calendar?.hoursPerDay ?? 8),
    timezone: calendar?.timezone ?? blankCalendar().timezone,
    workingDays: [...(calendar?.workingDays ?? [1, 2, 3, 4, 5])],
  };
}

function plainCalendarDraft() {
  return JSON.parse(JSON.stringify(Object.fromEntries(CALENDAR_FIELDS.map((field) => [field, calendarDraft[field]]))));
}

const calendarDirty = computed(() => Boolean(calendarBase.value) && recordsDiffer(plainCalendarDraft(), calendarBase.value, CALENDAR_FIELDS));
const editorDirty = computed(() => (
  editor.value?.mode === 'edit'
  && Boolean(editor.value.base)
  && recordsDiffer(plainDraft(editor.value.type), editor.value.base, draftFields(editor.value.type))
));

function reconcileCalendar(theirs, keepLocal) {
  if (keepLocal) {
    if (recordsDiffer(theirs, calendarBase.value, CALENDAR_FIELDS)) calendarConflict.value = { theirs };
    return;
  }
  Object.assign(calendarDraft, theirs);
  calendarBase.value = JSON.parse(JSON.stringify(theirs));
  calendarConflict.value = null;
}

function recordFor(type, id) {
  if (type === 'goal') return goals.value.find((goal) => goal.id === id) ?? null;
  const records = { dependency: snapshot.value.dependencies, item: snapshot.value.items, milestone: snapshot.value.milestones }[type] ?? [];
  return records.find((record) => record.id === id) ?? null;
}

function reconcileEditor(keepLocal) {
  const current = editor.value;
  if (current?.mode !== 'edit' || !DRAFT_BLANKS[current.type]) return;

  const record = recordFor(current.type, current.id);
  if (!record) {
    if (keepLocal) {
      editorConflict.value = { deleted: true };
    } else {
      editor.value = null;
      emit('message', 'The record you were viewing was deleted by someone else.');
    }
    return;
  }

  if (record.version === current.version) return;
  const theirs = draftFromRecord(current.type, record);
  if (keepLocal) {
    editorConflict.value = { theirs, version: record.version };
    return;
  }
  Object.assign(draftFor(current.type), theirs);
  editor.value = { ...current, base: JSON.parse(JSON.stringify(theirs)), version: record.version };
}

function editorMerge(resolutions = {}) {
  const current = editor.value;
  return mergeRecord({
    base: current.base,
    fields: draftFields(current.type),
    keyPrefix: current.type,
    label: plainDraft(current.type).title || 'This record',
    mine: plainDraft(current.type),
    resolutions,
    theirs: editorConflict.value.theirs,
  });
}

function calendarMerge(resolutions = {}) {
  return mergeRecord({
    base: calendarBase.value,
    fieldLabels: { holidaysText: 'Holidays', hoursPerDay: 'Hours per day', workingDays: 'Working days' },
    fields: CALENDAR_FIELDS,
    keyPrefix: 'calendar',
    label: 'Working calendar',
    mine: plainCalendarDraft(),
    resolutions,
    theirs: calendarConflict.value.theirs,
  });
}

const activeLiveConflict = computed(() => {
  if (editorConflict.value && editor.value) {
    if (editorConflict.value.deleted) {
      return { allowMerge: false, conflicts: [], discardLabel: 'Close editor', kind: 'editor', message: 'Someone else deleted the record you are editing.' };
    }
    return { allowMerge: true, conflicts: editorMerge().conflicts, discardLabel: 'Discard my edits', kind: 'editor', message: 'The record you are editing was updated by someone else.' };
  }
  if (calendarConflict.value) {
    return { allowMerge: true, conflicts: calendarMerge().conflicts, discardLabel: 'Discard my edits', kind: 'calendar', message: 'The working calendar was updated while you were editing it.' };
  }
  return null;
});

function applyLiveMerge(resolutions) {
  const active = activeLiveConflict.value;
  if (active?.kind === 'editor') {
    const current = editor.value;
    const { theirs, version } = editorConflict.value;
    Object.assign(draftFor(current.type), editorMerge(resolutions).merged);
    editor.value = { ...current, base: JSON.parse(JSON.stringify(theirs)), version };
    editorConflict.value = null;
  } else if (active?.kind === 'calendar') {
    const { theirs } = calendarConflict.value;
    Object.assign(calendarDraft, calendarMerge(resolutions).merged);
    calendarBase.value = JSON.parse(JSON.stringify(theirs));
    calendarConflict.value = null;
  }
  emit('message', 'Merged the latest changes into your edits. Save when ready.');
}

function discardLiveEdits() {
  const active = activeLiveConflict.value;
  if (active?.kind === 'editor') {
    if (editorConflict.value.deleted) {
      editor.value = null;
    } else {
      const current = editor.value;
      const { theirs, version } = editorConflict.value;
      Object.assign(draftFor(current.type), theirs);
      editor.value = { ...current, base: JSON.parse(JSON.stringify(theirs)), version };
    }
    editorConflict.value = null;
  } else if (active?.kind === 'calendar') {
    reconcileCalendar(calendarConflict.value.theirs, false);
  }
}

watch(editor, (next, previous) => {
  if (next?.id !== previous?.id || next?.type !== previous?.type) editorConflict.value = null;
});
watch(editorDirty, (dirty) => {
  if (!dirty && editorConflict.value && !editorConflict.value.deleted) discardLiveEdits();
});
watch(calendarDirty, (dirty) => {
  if (!dirty && calendarConflict.value) discardLiveEdits();
});

function blockSaveForLiveConflict() {
  if (!activeLiveConflict.value) return false;
  emit('error', 'This changed while you were editing. Merge or discard the incoming changes before saving.');
  return true;
}

function openCreate(type) {
  deleteTarget.value = null;
  if (type === 'item') Object.assign(itemDraft, blankItem());
  if (type === 'milestone') Object.assign(milestoneDraft, blankMilestone());
  if (type === 'dependency') Object.assign(dependencyDraft, blankDependency());
  if (type === 'goal') Object.assign(goalDraft, blankGoal());
  if (type === 'monitor') Object.assign(monitorDraft, blankMonitor());
  editor.value = { mode: 'create', type };
}

const DRAFT_BLANKS = {
  dependency: blankDependency,
  goal: blankGoal,
  item: blankItem,
  milestone: blankMilestone,
};

function draftFor(type) {
  return { dependency: dependencyDraft, goal: goalDraft, item: itemDraft, milestone: milestoneDraft, monitor: monitorDraft }[type];
}

function draftFields(type) {
  return Object.keys(DRAFT_BLANKS[type]?.() ?? {});
}

function plainDraft(type) {
  const draft = draftFor(type);
  return JSON.parse(JSON.stringify(Object.fromEntries(draftFields(type).map((field) => [field, draft[field]]))));
}

// Builds the form values for editing a record, without touching the live form.
function draftFromRecord(type, record) {
  const blank = DRAFT_BLANKS[type]();
  if (type !== 'goal') {
    return JSON.parse(JSON.stringify({ ...blank, ...Object.fromEntries(Object.keys(blank).filter((field) => field in record).map((field) => [field, record[field]])) }));
  }
  const root = record.success?.plan?.root ?? {};
  const operator = Array.isArray(root.any) ? 'any' : 'all';
  const expressions = root[operator] ?? [];
  return {
    ...blank,
    allowWebResearch: Boolean(record.constraints?.allowWebResearch),
    autoApply: goalChangeAccess(record).makesChanges,
    escalationAfterRuns: Number(record.constraints?.escalation?.afterRuns ?? 1),
    escalationEmail: record.constraints?.escalation?.email === true || record.constraints?.escalation?.channels?.includes('email'),
    escalationWebhook: record.constraints?.escalation?.webhook === true || record.constraints?.escalation?.channels?.includes('webhook'),
    maxAttempts: Number(record.constraints?.maxAttempts ?? 5),
    status: record.status,
    successMeasure: String(record.success?.measure ?? ''),
    title: record.title,
    verifierOperator: operator,
    verifierPredicates: expressions.map((expression) => {
      const predicate = expression.not ?? expression;
      return { checkId: predicate.checkId ?? '', id: predicate.id ?? '', negate: Boolean(expression.not), type: predicate.type ?? 'project_health.v1' };
    }),
    verifierType: String(record.success?.verifier?.type ?? ''),
  };
}

function openEdit(type, record) {
  deleteTarget.value = null;
  const draft = draftFromRecord(type, record);
  Object.assign(draftFor(type), draft);
  editor.value = { base: JSON.parse(JSON.stringify(draft)), id: record.id, mode: 'edit', type, version: record.version };
}

function openMonitorCreate(goal) {
  Object.assign(monitorDraft, blankMonitor());
  editor.value = { goalId: goal.id, mode: 'create', type: 'monitor' };
}

function closeEditor() {
  editor.value = null;
}

async function runMutation(operation, successMessage) {
  saving.value = true;
  try {
    await operation();
    editor.value = null;
    deleteTarget.value = null;
    calendarConflict.value = null;
    await loadGovernance();
    emit('message', successMessage);
  } catch (error) {
    emit('error', error.message ?? 'Unable to update project governance.');
  } finally {
    saving.value = false;
  }
}

async function saveItem() {
  if (blockSaveForLiveConflict()) return;
  const payload = {
    description: itemDraft.description,
    dueDate: itemDraft.dueDate || null,
    impact: itemDraft.impact,
    kind: itemDraft.kind,
    ownerId: itemDraft.ownerId || null,
    probability: itemDraft.kind === 'risk' ? itemDraft.probability : null,
    responsePlan: itemDraft.responsePlan,
    status: itemDraft.status,
    title: itemDraft.title,
  };
  await runMutation(
    () => editor.value.mode === 'edit'
      ? apiClient.updateProjectGovernanceItem(props.projectId, editor.value.id, { ...payload, expectedVersion: editor.value.version }, props.token)
      : apiClient.createProjectGovernanceItem(props.projectId, payload, props.token),
    editor.value.mode === 'edit' ? 'Governance record updated.' : 'Governance record created.',
  );
}

async function saveMilestone() {
  if (blockSaveForLiveConflict()) return;
  const payload = {
    status: milestoneDraft.status,
    targetDate: milestoneDraft.targetDate,
    title: milestoneDraft.title,
    workItemId: milestoneDraft.workItemId || null,
  };
  await runMutation(
    () => editor.value.mode === 'edit'
      ? apiClient.updateProjectMilestone(props.projectId, editor.value.id, { ...payload, expectedVersion: editor.value.version }, props.token)
      : apiClient.createProjectMilestone(props.projectId, payload, props.token),
    editor.value.mode === 'edit' ? 'Milestone updated.' : 'Milestone created.',
  );
}

async function saveDependency() {
  if (blockSaveForLiveConflict()) return;
  const payload = {
    dependencyType: dependencyDraft.dependencyType,
    lagDays: Number(dependencyDraft.lagDays),
    predecessorId: dependencyDraft.predecessorId,
    successorId: dependencyDraft.successorId,
  };
  await runMutation(
    () => editor.value.mode === 'edit'
      ? apiClient.updateProjectDependency(props.projectId, editor.value.id, { ...payload, expectedVersion: editor.value.version }, props.token)
      : apiClient.createProjectDependency(props.projectId, payload, props.token),
    editor.value.mode === 'edit' ? 'Dependency updated.' : 'Dependency created.',
  );
}

async function saveGoal() {
  if (blockSaveForLiveConflict()) return;
  const verifierExpressions = goalDraft.verifierPredicates
    .filter((predicate) => predicate.id && predicate.checkId && predicate.type)
    .map((predicate) => {
      const leaf = { checkId: predicate.checkId, criteria: {}, id: predicate.id, type: predicate.type };
      return predicate.negate ? { not: leaf } : leaf;
    });
  const payload = {
    constraints: goalConstraintsFromDraft(goalDraft, goalAccess.value),
    projectId: props.projectId,
    scope: { projectIds: [props.projectId] },
    success: {
      measure: goalDraft.successMeasure,
      ...(verifierExpressions.length ? { plan: { root: { [goalDraft.verifierOperator]: verifierExpressions }, version: 'verifier-plan.v1' } } : {}),
      ...(!verifierExpressions.length && goalDraft.verifierType ? { verifier: { criteria: {}, requiredCheckIds: [], type: goalDraft.verifierType } } : {}),
    },
    title: goalDraft.title,
  };
  if (editor.value.mode === 'edit') payload.status = goalDraft.status;
  await runMutation(
    () => editor.value.mode === 'edit'
      ? apiClient.updateAgentGoal(editor.value.id, { ...payload, expectedVersion: editor.value.version }, props.token)
      : apiClient.createAgentGoal(payload, props.token),
    editor.value.mode === 'edit' ? 'Autonomous goal updated.' : 'Autonomous goal created.',
  );
}

function addVerifierPredicate() {
  goalDraft.verifierPredicates.push({ checkId: '', id: `predicate-${goalDraft.verifierPredicates.length + 1}`, negate: false, type: 'project_health.v1' });
}

function removeVerifierPredicate(index) {
  goalDraft.verifierPredicates.splice(index, 1);
}

function goalCompletionLabel(goal) {
  if (goal.success?.plan?.version === 'verifier-plan.v1') return 'composable verifier plan';
  return goal.success?.verifier?.type || 'manual completion';
}
function goalEscalationLabel(goal) {
  const channels = goal.constraints?.escalation?.channels ?? ['in_app'];
  return `escalation: ${channels.join(', ')}`;
}

async function saveMonitor() {
  const condition = monitorDraft.triggerType === 'event' && monitorDraft.conditionPath
    ? { [monitorDraft.conditionPath]: monitorDraft.conditionValue }
    : {};
  await runMutation(
    () => apiClient.createAgentGoalMonitor(editor.value.goalId, {
      condition,
      eventType: monitorDraft.triggerType === 'event' ? monitorDraft.eventType : null,
      intervalMinutes: monitorDraft.triggerType === 'schedule' ? Number(monitorDraft.intervalMinutes) : null,
      nextRunAt: monitorDraft.triggerType === 'schedule' && monitorDraft.nextRunAt ? new Date(monitorDraft.nextRunAt).toISOString() : null,
      payload: { focus: 'project governance and delivery health' },
      stop: { maxRuns: monitorDraft.maxRuns ? Number(monitorDraft.maxRuns) : null },
      title: monitorDraft.title,
      triggerType: monitorDraft.triggerType,
    }, props.token),
    'Goal monitor created.',
  );
}

async function saveWorkingCalendar() {
  if (blockSaveForLiveConflict()) return;
  const holidays = [...new Set(calendarDraft.holidaysText
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean))];
  await runMutation(() => apiClient.updateProjectWorkingCalendar(props.projectId, {
    expectedVersion: snapshot.value.workingCalendar?.version ?? null,
    holidays,
    hoursPerDay: Number(calendarDraft.hoursPerDay),
    timezone: calendarDraft.timezone,
    workingDays: [...calendarDraft.workingDays].map(Number).sort((left, right) => left - right),
  }, props.token), 'Working calendar updated.');
}

async function captureScheduleBaseline() {
  await runMutation(() => apiClient.createProjectScheduleBaseline(props.projectId, {
    name: baselineDraft.name,
    note: baselineDraft.note,
  }, props.token), 'Immutable schedule baseline captured.');
  Object.assign(baselineDraft, blankBaseline());
}

async function runGoal(goal) {
  await runMutation(() => apiClient.runAgentGoal(goal.id, props.token), 'Goal run queued in its durable assistant conversation.');
}

async function toggleMonitor(monitor) {
  await runMutation(() => apiClient.updateAgentGoalMonitor(monitor.id, { enabled: !monitor.enabled, expectedVersion: monitor.version }, props.token), monitor.enabled ? 'Monitor paused.' : 'Monitor resumed.');
}

async function acknowledgeNotification(notification) {
  await runMutation(
    () => apiClient.updateAgentGoalNotification(notification.id, { expectedVersion: notification.version, status: 'read' }, props.token),
    'Goal attention marked as read.',
  );
}

function requestDelete(type, record) {
  editor.value = null;
  deleteTarget.value = { id: record.id, title: record.title ?? 'Dependency', type, version: record.version };
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  await runMutation(async () => {
    if (target.type === 'item') return apiClient.deleteProjectGovernanceItem(props.projectId, target.id, target.version, props.token);
    if (target.type === 'milestone') return apiClient.deleteProjectMilestone(props.projectId, target.id, target.version, props.token);
    return apiClient.deleteProjectDependency(props.projectId, target.id, target.version, props.token);
  }, `${target.type === 'dependency' ? 'Dependency' : target.type === 'milestone' ? 'Milestone' : 'Governance record'} deleted.`);
}

function workItemLabel(id) {
  return workItemLabels.value.get(id) ?? id ?? 'Unlinked';
}
</script>

<template>
  <section class="governance-workspace" aria-labelledby="governance-heading">
    <header class="governance-header">
      <div>
        <h1 id="governance-heading">Governance &amp; schedule</h1>
        <p>Manage RAID, decisions, change requests, milestones, and dependency health.</p>
      </div>
      <button class="btn btn-outline-secondary btn-sm" type="button" :disabled="loading" @click="loadGovernance()">
        <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
        Refresh
      </button>
    </header>

    <div class="governance-metrics" aria-label="Governance summary">
      <article><span>Open risks</span><strong>{{ counts.risk }}</strong></article>
      <article><span>Issues</span><strong>{{ counts.issue }}</strong></article>
      <article><span>Milestones</span><strong>{{ snapshot.milestones.length }}</strong></article>
      <article><span>Dependencies</span><strong>{{ snapshot.dependencies.length }}</strong></article>
      <article :class="{ 'governance-metric--warning': (analysis?.cyclicItemIds?.length ?? 0) > 0 }">
        <span>Schedule</span><strong>{{ analysis?.passed ? 'Healthy' : 'Cycle found' }}</strong>
      </article>
    </div>

    <section class="schedule-strip" aria-label="Schedule analysis">
      <div><span>Forecast finish</span><strong>{{ analysis?.forecastFinish ?? 'Not scheduled' }}</strong></div>
      <div><span>Forecast variance</span><strong>{{ analysis?.forecastVarianceDays == null ? '—' : `${analysis.forecastVarianceDays} days` }}</strong></div>
      <div><span>Critical duration</span><strong>{{ analysis?.totalDurationDays ?? 0 }} days</strong></div>
      <div class="schedule-strip__path"><span>Critical path</span><strong>{{ criticalPathLabels.join(' → ') || 'No dated path' }}</strong></div>
    </section>

    <nav class="governance-tabs" aria-label="Governance sections">
      <button v-for="tab in [{ id: 'register', label: 'Register' }, { id: 'milestones', label: 'Milestones' }, { id: 'dependencies', label: 'Dependencies' }, { id: 'schedule', label: 'Schedule controls' }, { id: 'automation', label: 'Automation' }]"
        :key="tab.id" type="button" :aria-current="activeTab === tab.id ? 'page' : undefined"
        :class="{ 'governance-tabs__button--active': activeTab === tab.id }" @click="activeTab = tab.id; closeEditor()">
        {{ tab.label }}
      </button>
    </nav>

    <div v-if="loading" class="governance-empty" role="status">Loading governance data…</div>

    <div v-else class="governance-layout">
      <main>
        <template v-if="activeTab === 'register'">
          <div class="governance-toolbar">
            <label class="governance-search"><span class="visually-hidden">Search register</span><input v-model="query" type="search" placeholder="Search register" /></label>
            <label><span class="visually-hidden">Record type</span><select v-model="kindFilter"><option value="all">All types</option><option value="risk">Risks</option><option value="issue">Issues</option><option value="assumption">Assumptions</option><option value="decision">Decisions</option><option value="change_request">Change requests</option></select></label>
            <label><span class="visually-hidden">Record status</span><select v-model="statusFilter"><option value="all">All statuses</option><option value="open">Open</option><option value="monitoring">Monitoring</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select></label>
            <label><span class="visually-hidden">Sort records</span><select v-model="sort"><option value="updated_desc">Recently updated</option><option value="impact_desc">Highest impact</option><option value="due_asc">Due date</option><option value="title_asc">Title</option></select></label>
            <button class="btn btn-primary btn-sm" type="button" @click="openCreate('item')"><i class="bi bi-plus-lg" aria-hidden="true"></i> Add record</button>
          </div>
          <div class="governance-table-wrap">
            <table class="governance-table">
              <thead><tr><th>Type / title</th><th>Status</th><th>Exposure</th><th>Due</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
              <tbody>
                <tr v-for="item in selectedItems.items" :key="item.id">
                  <td><span class="governance-kind">{{ governanceKindLabel(item.kind) }}</span><strong>{{ item.title }}</strong><small v-if="item.description">{{ item.description }}</small></td>
                  <td><span class="governance-status">{{ item.status }}</span></td>
                  <td>{{ item.kind === 'risk' && item.probability ? `${item.probability} / ${item.impact}` : item.impact }}</td>
                  <td>{{ item.dueDate ?? '—' }}</td>
                  <td class="governance-row-actions"><button type="button" aria-label="Edit record" @click="openEdit('item', item)"><i class="bi bi-pencil" aria-hidden="true"></i></button><button type="button" aria-label="Delete record" @click="requestDelete('item', item)"><i class="bi bi-trash" aria-hidden="true"></i></button></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="selectedItems.total === 0" class="governance-empty">No records match these filters.</div>
          <footer v-else class="governance-pagination"><span>{{ selectedItems.total }} records</span><div><button type="button" :disabled="selectedItems.page <= 1" aria-label="Previous page" @click="page -= 1"><i class="bi bi-chevron-left"></i></button><span>Page {{ selectedItems.page }} of {{ selectedItems.pageCount }}</span><button type="button" :disabled="selectedItems.page >= selectedItems.pageCount" aria-label="Next page" @click="page += 1"><i class="bi bi-chevron-right"></i></button></div></footer>
        </template>

        <template v-else-if="activeTab === 'milestones'">
          <div class="governance-toolbar governance-toolbar--end"><button class="btn btn-primary btn-sm" type="button" @click="openCreate('milestone')"><i class="bi bi-plus-lg"></i> Add milestone</button></div>
          <div class="governance-list">
            <article v-for="milestone in snapshot.milestones" :key="milestone.id">
              <div><span class="governance-status">{{ milestone.status }}</span><strong>{{ milestone.title }}</strong><small>{{ milestone.targetDate }}<template v-if="milestone.workItemId"> · {{ workItemLabel(milestone.workItemId) }}</template></small></div>
              <div class="governance-row-actions"><button type="button" aria-label="Edit milestone" @click="openEdit('milestone', milestone)"><i class="bi bi-pencil"></i></button><button type="button" aria-label="Delete milestone" @click="requestDelete('milestone', milestone)"><i class="bi bi-trash"></i></button></div>
            </article>
          </div>
          <div v-if="snapshot.milestones.length === 0" class="governance-empty">No milestones have been defined.</div>
        </template>

        <template v-else-if="activeTab === 'dependencies'">
          <div class="governance-toolbar governance-toolbar--end"><button class="btn btn-primary btn-sm" type="button" @click="openCreate('dependency')"><i class="bi bi-plus-lg"></i> Add dependency</button></div>
          <div class="governance-list">
            <article v-for="dependency in snapshot.dependencies" :key="dependency.id">
              <div><span class="governance-kind">{{ dependency.dependencyType }}</span><strong>{{ workItemLabel(dependency.predecessorId) }} → {{ workItemLabel(dependency.successorId) }}</strong><small>{{ dependency.lagDays === 0 ? 'No lag' : `${dependency.lagDays} day lag` }}</small></div>
              <div class="governance-row-actions"><button type="button" aria-label="Edit dependency" @click="openEdit('dependency', dependency)"><i class="bi bi-pencil"></i></button><button type="button" aria-label="Delete dependency" @click="requestDelete('dependency', dependency)"><i class="bi bi-trash"></i></button></div>
            </article>
          </div>
          <div v-if="snapshot.dependencies.length === 0" class="governance-empty">No dependencies have been defined.</div>
        </template>

        <template v-else-if="activeTab === 'schedule'">
          <div class="schedule-controls">
            <form class="schedule-control-card" aria-labelledby="working-calendar-heading" @submit.prevent="saveWorkingCalendar">
              <div><h2 id="working-calendar-heading">Working calendar</h2><p>Use working days and holidays for forecasts, critical path, float, and variance.</p></div>
              <label for="schedule-timezone">Time zone</label><input id="schedule-timezone" v-model.trim="calendarDraft.timezone" required placeholder="America/New_York" />
              <label for="schedule-hours">Hours per working day</label><input id="schedule-hours" v-model.number="calendarDraft.hoursPerDay" required type="number" min="0.5" max="24" step="0.5" />
              <fieldset><legend>Working days</legend><div class="schedule-weekdays"><label v-for="day in [{ value: 0, label: 'Sun' }, { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' }, { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }]" :key="day.value"><input v-model="calendarDraft.workingDays" type="checkbox" :value="day.value" /> {{ day.label }}</label></div></fieldset>
              <label for="schedule-holidays">Holidays</label><textarea id="schedule-holidays" v-model="calendarDraft.holidaysText" rows="5" placeholder="One YYYY-MM-DD date per line"></textarea>
              <button class="btn btn-primary btn-sm" type="submit" :disabled="saving || calendarDraft.workingDays.length === 0">Save calendar</button>
            </form>

            <section class="schedule-control-card" aria-labelledby="schedule-baseline-heading">
              <div><h2 id="schedule-baseline-heading">Schedule baselines</h2><p>Capture an immutable approved plan before dates, scope, or milestones change.</p></div>
              <form class="schedule-baseline-form" @submit.prevent="captureScheduleBaseline">
                <label for="schedule-baseline-name">Baseline name</label><input id="schedule-baseline-name" v-model.trim="baselineDraft.name" required maxlength="160" placeholder="Approved launch plan" />
                <label for="schedule-baseline-note">Approval note</label><textarea id="schedule-baseline-note" v-model.trim="baselineDraft.note" rows="3" maxlength="2000"></textarea>
                <button class="btn btn-primary btn-sm" type="submit" :disabled="saving">Capture baseline</button>
              </form>
              <div v-if="analysis?.baselineVariance" class="schedule-variance" aria-label="Latest baseline variance">
                <strong>{{ analysis.baselineVariance.baselineName }}</strong>
                <span>Finish {{ analysis.baselineVariance.projectFinishVarianceWorkingDays ?? 0 }} working days</span>
                <span>{{ analysis.baselineVariance.scopeAddedCount }} added / {{ analysis.baselineVariance.scopeRemovedCount }} removed</span>
                <span>{{ analysis.baselineVariance.itemVariances.length }} changed items</span>
              </div>
              <div class="schedule-baseline-list">
                <article v-for="baseline in snapshot.scheduleBaselines" :key="baseline.id">
                  <strong>{{ baseline.name }}</strong><small>{{ new Date(baseline.capturedAt).toLocaleString() }} · immutable v{{ baseline.version }}</small><p v-if="baseline.note">{{ baseline.note }}</p>
                </article>
              </div>
              <div v-if="snapshot.scheduleBaselines.length === 0" class="governance-empty">No schedule baseline has been captured.</div>
            </section>
          </div>
        </template>

        <template v-else>
          <div class="governance-toolbar governance-toolbar--end"><button class="btn btn-primary btn-sm" type="button" @click="openCreate('goal')"><i class="bi bi-plus-lg"></i> Add autonomous goal</button></div>
          <div class="governance-list governance-list--goals">
            <article v-for="goal in goals" :key="goal.id">
              <div class="governance-goal__content">
                <div><span class="governance-status">{{ goal.status }}</span><strong>{{ goal.title }}</strong><small>{{ goalChangesLabel(goal) }} · {{ goal.success?.measure || 'No success measure defined' }} · {{ goal.runs.length }} run{{ goal.runs.length === 1 ? '' : 's' }} · {{ goalCompletionLabel(goal) }} · {{ goalEscalationLabel(goal) }}</small></div>
                <div v-if="goal.monitors.length > 0" class="governance-monitor-list">
                  <div v-for="monitor in goal.monitors" :key="monitor.id">
                    <span><i :class="monitor.triggerType === 'schedule' ? 'bi bi-clock' : 'bi bi-lightning'" aria-hidden="true"></i> {{ monitor.title }}</span>
                    <small>{{ monitor.enabled ? (monitor.triggerType === 'schedule' ? `Every ${monitor.intervalMinutes} minutes` : monitor.eventType) : 'Paused' }} · {{ monitor.runCount }} run{{ monitor.runCount === 1 ? '' : 's' }}</small>
                    <button type="button" :aria-label="monitor.enabled ? `Pause ${monitor.title}` : `Resume ${monitor.title}`" @click="toggleMonitor(monitor)"><i :class="monitor.enabled ? 'bi bi-pause' : 'bi bi-play'" aria-hidden="true"></i></button>
                  </div>
                </div>
                <div v-if="goal.notifications.some((notification) => notification.status === 'unread')" class="governance-attention-list" aria-label="Goal attention">
                  <div v-for="notification in goal.notifications.filter((item) => item.status === 'unread')" :key="notification.id" :class="`governance-attention governance-attention--${notification.severity}`">
                    <span><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> <strong>{{ notification.title }}</strong><small>{{ notification.message }}</small></span>
                    <button type="button" :aria-label="`Mark ${notification.title} as read`" @click="acknowledgeNotification(notification)"><i class="bi bi-check2" aria-hidden="true"></i></button>
                  </div>
                </div>
              </div>
              <div class="governance-row-actions"><button type="button" :disabled="goal.status !== 'active'" aria-label="Run goal now" @click="runGoal(goal)"><i class="bi bi-play-fill"></i></button><button type="button" aria-label="Add goal monitor" @click="openMonitorCreate(goal)"><i class="bi bi-alarm"></i></button><button type="button" aria-label="Edit autonomous goal" @click="openEdit('goal', goal)"><i class="bi bi-pencil"></i></button></div>
            </article>
          </div>
          <div v-if="goals.length === 0" class="governance-empty">No autonomous goals have been defined for this project.</div>
        </template>
      </main>

      <aside v-if="editor || deleteTarget" class="governance-editor" aria-live="polite">
        <template v-if="deleteTarget">
          <h2>Delete {{ deleteTarget.type }}</h2>
          <p>This permanently removes <strong>{{ deleteTarget.title }}</strong>. This action is separately confirmed.</p>
          <div class="governance-editor__actions"><button class="btn btn-outline-secondary btn-sm" type="button" @click="deleteTarget = null">Cancel</button><button class="btn btn-danger btn-sm" type="button" :disabled="saving" @click="confirmDelete">Delete</button></div>
        </template>

        <form v-else-if="editor?.type === 'item'" @submit.prevent="saveItem">
          <h2>{{ editor.mode === 'edit' ? 'Edit record' : 'New governance record' }}</h2>
          <label for="governance-item-kind">Type</label><select id="governance-item-kind" v-model="itemDraft.kind"><option value="risk">Risk</option><option value="issue">Issue</option><option value="assumption">Assumption</option><option value="decision">Decision</option><option value="change_request">Change request</option></select>
          <label for="governance-item-title">Title</label><input id="governance-item-title" v-model.trim="itemDraft.title" required maxlength="240" />
          <label for="governance-item-description">Description</label><textarea id="governance-item-description" v-model="itemDraft.description" rows="4"></textarea>
          <div class="governance-editor__row"><div><label for="governance-item-status">Status</label><select id="governance-item-status" v-model="itemDraft.status"><option value="open">Open</option><option value="monitoring">Monitoring</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select></div><div><label for="governance-item-impact">Impact</label><select id="governance-item-impact" v-model="itemDraft.impact"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></div></div>
          <div class="governance-editor__row"><div v-if="itemDraft.kind === 'risk'"><label for="governance-item-probability">Probability</label><select id="governance-item-probability" v-model="itemDraft.probability"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div><div><label for="governance-item-due-date">Due date</label><input id="governance-item-due-date" v-model="itemDraft.dueDate" type="date" /></div></div>
          <label for="governance-item-owner">Owner ID</label><input id="governance-item-owner" v-model.trim="itemDraft.ownerId" placeholder="Optional user ID" />
          <label for="governance-item-response">Response / outcome</label><textarea id="governance-item-response" v-model="itemDraft.responsePlan" rows="3"></textarea>
          <div class="governance-editor__actions"><button class="btn btn-outline-secondary btn-sm" type="button" @click="closeEditor">Cancel</button><button class="btn btn-primary btn-sm" type="submit" :disabled="saving">Save</button></div>
        </form>

        <form v-else-if="editor?.type === 'milestone'" @submit.prevent="saveMilestone">
          <h2>{{ editor.mode === 'edit' ? 'Edit milestone' : 'New milestone' }}</h2>
          <label for="governance-milestone-title">Title</label><input id="governance-milestone-title" v-model.trim="milestoneDraft.title" required maxlength="240" />
          <label for="governance-milestone-date">Target date</label><input id="governance-milestone-date" v-model="milestoneDraft.targetDate" required type="date" />
          <label for="governance-milestone-status">Status</label><select id="governance-milestone-status" v-model="milestoneDraft.status"><option value="planned">Planned</option><option value="at_risk">At risk</option><option value="achieved">Achieved</option><option value="missed">Missed</option></select>
          <label for="governance-milestone-work-item">Linked work item</label><select id="governance-milestone-work-item" v-model="milestoneDraft.workItemId"><option :value="null">No linked item</option><option v-for="item in workItems" :key="item.id" :value="item.id">{{ item.label }}</option></select>
          <div class="governance-editor__actions"><button class="btn btn-outline-secondary btn-sm" type="button" @click="closeEditor">Cancel</button><button class="btn btn-primary btn-sm" type="submit" :disabled="saving">Save</button></div>
        </form>

        <form v-else-if="editor?.type === 'dependency'" @submit.prevent="saveDependency">
          <h2>{{ editor.mode === 'edit' ? 'Edit dependency' : 'New dependency' }}</h2>
          <label for="governance-dependency-predecessor">Predecessor</label><select id="governance-dependency-predecessor" v-model="dependencyDraft.predecessorId" required><option value="" disabled>Select work item</option><option v-for="item in workItems" :key="item.id" :value="item.id">{{ item.label }}</option></select>
          <label for="governance-dependency-successor">Successor</label><select id="governance-dependency-successor" v-model="dependencyDraft.successorId" required><option value="" disabled>Select work item</option><option v-for="item in workItems" :key="item.id" :value="item.id" :disabled="item.id === dependencyDraft.predecessorId">{{ item.label }}</option></select>
          <div class="governance-editor__row"><div><label for="governance-dependency-type">Type</label><select id="governance-dependency-type" v-model="dependencyDraft.dependencyType"><option value="FS">Finish to start</option><option value="SS">Start to start</option><option value="FF">Finish to finish</option><option value="SF">Start to finish</option></select></div><div><label for="governance-dependency-lag">Lag days</label><input id="governance-dependency-lag" v-model.number="dependencyDraft.lagDays" type="number" min="-365" max="365" /></div></div>
          <div class="governance-editor__actions"><button class="btn btn-outline-secondary btn-sm" type="button" @click="closeEditor">Cancel</button><button class="btn btn-primary btn-sm" type="submit" :disabled="saving">Save</button></div>
        </form>

        <form v-else-if="editor?.type === 'goal'" @submit.prevent="saveGoal">
          <h2>{{ editor.mode === 'edit' ? 'Edit autonomous goal' : 'New autonomous goal' }}</h2>
          <label for="agent-goal-title">Title</label><input id="agent-goal-title" v-model.trim="goalDraft.title" required maxlength="255" />
          <label for="agent-goal-success">Success measure</label><textarea id="agent-goal-success" v-model.trim="goalDraft.successMeasure" required rows="3"></textarea>
          <label v-if="editor.mode === 'edit'" for="agent-goal-status">Status</label><select v-if="editor.mode === 'edit'" id="agent-goal-status" v-model="goalDraft.status"><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select>
          <label for="agent-goal-attempts">Maximum attempts per run</label><input id="agent-goal-attempts" v-model.number="goalDraft.maxAttempts" type="number" min="1" max="20" />
          <label for="agent-goal-verifier">Completion verifier</label><select id="agent-goal-verifier" v-model="goalDraft.verifierType"><option value="">Manual completion</option><option value="project_health.v1">Project health</option><option value="resource_finance.v1">Resource and finance</option><option value="workflow.v1">Workflow and SLA</option><option value="integration.v1">Integration delivery</option><option value="communication.v1">Communication delivery</option></select>
          <small class="form-text">Automatic completion requires every selected verifier check to pass from current source-system evidence.</small>
          <fieldset class="governance-predicate-plan"><legend>Composable verifier plan</legend><label for="agent-goal-verifier-operator">Predicate result</label><select id="agent-goal-verifier-operator" v-model="goalDraft.verifierOperator"><option value="all">All predicates must pass</option><option value="any">Any predicate may pass</option></select><div v-for="(predicate, index) in goalDraft.verifierPredicates" :key="`${predicate.id}-${index}`" class="governance-predicate-row"><label :for="`goal-predicate-type-${index}`">Verifier</label><select :id="`goal-predicate-type-${index}`" v-model="predicate.type"><option value="project_health.v1">Project health</option><option value="resource_finance.v1">Resource and finance</option><option value="workflow.v1">Workflow and SLA</option><option value="integration.v1">Integration delivery</option><option value="communication.v1">Communication delivery</option></select><label :for="`goal-predicate-id-${index}`">Predicate id</label><input :id="`goal-predicate-id-${index}`" v-model.trim="predicate.id" maxlength="128" /><label :for="`goal-predicate-check-${index}`">Check id</label><input :id="`goal-predicate-check-${index}`" v-model.trim="predicate.checkId" maxlength="128" placeholder="schedule.no_cycles" /><label class="governance-check"><input v-model="predicate.negate" type="checkbox" /> Negate result</label><button class="btn btn-sm btn-outline-danger" type="button" :aria-label="`Remove predicate ${predicate.id || index + 1}`" @click="removeVerifierPredicate(index)">Remove</button></div><button class="btn btn-sm btn-outline-secondary" type="button" @click="addVerifierPredicate">Add predicate</button></fieldset>
          <p v-if="goalAccess.readOnly" class="form-text mb-2">Watches only. Monitors the assistant sets up never make changes.</p>
          <template v-else-if="goalAccess.owner">
            <label class="governance-check"><input v-model="goalDraft.autoApply" type="checkbox" aria-describedby="agent-goal-auto-apply-help" /> Let this goal make changes on its own</label>
            <small id="agent-goal-auto-apply-help" class="form-text d-block">Its runs happen with nobody watching and act as you. They can change anything you can.</small>
          </template>
          <p v-else class="form-text mb-2">{{ goalAccess.makesChanges ? `Makes changes on its own (set by ${goalEditorOwnerName}).` : `Watches only. Only ${goalEditorOwnerName} can let it make changes.` }}</p>
          <label class="governance-check"><input v-model="goalDraft.allowWebResearch" type="checkbox" /> Allow external web research for goal runs</label>
          <fieldset><legend>Escalation delivery</legend><label for="agent-goal-escalation-runs">Escalate after failed runs</label><input id="agent-goal-escalation-runs" v-model.number="goalDraft.escalationAfterRuns" type="number" min="1" max="100000" /><label class="governance-check"><input v-model="goalDraft.escalationEmail" type="checkbox" /> Email the goal owner</label><label class="governance-check"><input v-model="goalDraft.escalationWebhook" type="checkbox" /> Send signed goal-attention webhooks</label></fieldset>
          <p v-if="goalAccess.makesChanges && !goalAccess.owner" class="form-text mb-0">Saving stops this goal making changes on its own. Only {{ goalEditorOwnerName }} can turn that back on.</p>
          <div class="governance-editor__actions"><button class="btn btn-outline-secondary btn-sm" type="button" @click="closeEditor">Cancel</button><button class="btn btn-primary btn-sm" type="submit" :disabled="saving">Save</button></div>
        </form>

        <form v-else-if="editor?.type === 'monitor'" @submit.prevent="saveMonitor">
          <h2>New goal monitor</h2>
          <label for="agent-monitor-title">Title</label><input id="agent-monitor-title" v-model.trim="monitorDraft.title" required maxlength="255" />
          <label for="agent-monitor-trigger">Trigger</label><select id="agent-monitor-trigger" v-model="monitorDraft.triggerType"><option value="schedule">Recurring schedule</option><option value="event">Project event</option></select>
          <template v-if="monitorDraft.triggerType === 'schedule'">
            <label for="agent-monitor-interval">Interval minutes</label><input id="agent-monitor-interval" v-model.number="monitorDraft.intervalMinutes" required type="number" min="5" max="525600" />
            <label for="agent-monitor-next-run">First run</label><input id="agent-monitor-next-run" v-model="monitorDraft.nextRunAt" type="datetime-local" />
          </template>
          <template v-else>
            <label for="agent-monitor-event">Event</label><select id="agent-monitor-event" v-model="monitorDraft.eventType"><option value="governance.changed">Governance changed</option><option value="workflow.transitioned">Workflow transitioned</option><option value="workflow.sla.overdue">Workflow SLA overdue</option></select>
            <label for="agent-monitor-condition-path">Condition field</label><select id="agent-monitor-condition-path" v-model="monitorDraft.conditionPath"><option value="">Any matching event</option><option value="change.impact">Governance impact</option><option value="change.kind">Governance register type</option><option value="change.status">Governance status</option><option value="entityType">Entity type</option><option value="itemType">Workflow item type</option><option value="toState">Workflow destination state</option><option value="transitionKey">Workflow transition</option></select>
            <label v-if="monitorDraft.conditionPath" for="agent-monitor-condition-value">Condition value</label><input v-if="monitorDraft.conditionPath" id="agent-monitor-condition-value" v-model.trim="monitorDraft.conditionValue" required />
          </template>
          <label for="agent-monitor-max-runs">Stop after runs</label><input id="agent-monitor-max-runs" v-model.number="monitorDraft.maxRuns" type="number" min="1" placeholder="No limit" />
          <div class="governance-editor__actions"><button class="btn btn-outline-secondary btn-sm" type="button" @click="closeEditor">Cancel</button><button class="btn btn-primary btn-sm" type="submit" :disabled="saving">Save</button></div>
        </form>
      </aside>
    </div>
    <ProjectLiveUpdateNotice
      :allow-merge="activeLiveConflict?.allowMerge ?? true"
      :busy="saving"
      :conflicts="activeLiveConflict?.conflicts ?? []"
      :discard-label="activeLiveConflict?.discardLabel ?? 'Discard my edits'"
      :message="activeLiveConflict?.message ?? ''"
      :visible="Boolean(activeLiveConflict)"
      @discard="discardLiveEdits"
      @merge="applyLiveMerge"
    />
  </section>
</template>

<style scoped>
.governance-workspace { padding: 1rem; color: var(--bs-body-color); }
.governance-header { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; margin-bottom:1rem; }
.governance-header h1 { margin:0; font-size:1.25rem; line-height:1.2; }
.governance-header p { margin:.25rem 0 0; color:var(--bs-secondary-color); font-size:.875rem; }
.governance-metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:.5rem; margin-bottom:.75rem; }
.governance-metrics article,.schedule-strip { border:1px solid var(--bs-border-color); border-radius:.5rem; background:var(--bs-body-bg); }
.governance-metrics article { padding:.75rem; display:flex; flex-direction:column; gap:.25rem; }
.governance-metrics span,.schedule-strip span { color:var(--bs-secondary-color); font-size:.75rem; }
.governance-metrics strong { font-size:1rem; line-height:1.2; }
.governance-metric--warning { border-color:var(--bs-warning)!important; }
.schedule-strip { display:grid; grid-template-columns:repeat(3,minmax(8rem,1fr)) minmax(15rem,2fr); gap:.75rem; padding:.75rem; margin-bottom:1rem; }
.schedule-strip div { display:flex; flex-direction:column; gap:.25rem; min-width:0; }
.schedule-strip strong { font-size:.875rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.governance-tabs { display:flex; gap:.25rem; overflow-x:auto; border-bottom:1px solid var(--bs-border-color); margin-bottom:.75rem; }
.governance-tabs button { min-height:2.75rem; padding:.5rem .75rem; border:0; border-bottom:2px solid transparent; background:transparent; color:var(--bs-secondary-color); font-size:.875rem; }
.governance-tabs__button--active { color:var(--bs-body-color)!important; border-bottom-color:var(--bs-primary)!important; font-weight:600; }
.governance-layout { display:grid; grid-template-columns:minmax(0,1fr) minmax(18rem,24rem); gap:1rem; align-items:start; }
.governance-layout > main,.governance-editor { min-width:0; }
.governance-layout main:only-child { grid-column:1/-1; }
.governance-toolbar { display:grid; grid-template-columns:minmax(12rem,1fr) repeat(3,minmax(8rem,auto)) auto; gap:.5rem; margin-bottom:.75rem; }
.governance-toolbar--end { display:flex; justify-content:flex-end; }
.governance-toolbar input,.governance-toolbar select,.governance-editor input,.governance-editor select,.governance-editor textarea { width:100%; min-height:2.75rem; border:1px solid var(--bs-border-color); border-radius:.375rem; background:var(--bs-body-bg); color:var(--bs-body-color); padding:.5rem .625rem; font-size:.875rem; }
.schedule-controls { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.75rem; }
.schedule-control-card { display:flex; flex-direction:column; align-items:stretch; gap:.4rem; min-width:0; padding:1rem; border:1px solid var(--bs-border-color); border-radius:.5rem; background:var(--bs-body-bg); }
.schedule-control-card h2 { margin:0; font-size:1rem; }
.schedule-control-card p { margin:.25rem 0 0; color:var(--bs-secondary-color); font-size:.8rem; }
.schedule-control-card > label,.schedule-baseline-form > label { margin-top:.25rem; font-size:.75rem; font-weight:600; }
.schedule-control-card input,.schedule-control-card textarea { width:100%; min-height:2.75rem; padding:.5rem .625rem; border:1px solid var(--bs-border-color); border-radius:.375rem; background:var(--bs-body-bg); color:var(--bs-body-color); font-size:.875rem; }
.schedule-control-card fieldset { min-width:0; margin:.25rem 0; padding:.5rem; border:1px solid var(--bs-border-color); border-radius:.375rem; }
.schedule-control-card legend { float:none; width:auto; margin:0; padding:0 .25rem; font-size:.75rem; font-weight:600; }
.schedule-weekdays { display:flex; flex-wrap:wrap; gap:.35rem .75rem; }
.schedule-weekdays label { display:flex; align-items:center; gap:.25rem; min-height:2rem; font-size:.8rem; }
.schedule-weekdays input { width:1rem; min-height:1rem; margin:0; }
.schedule-control-card > .btn,.schedule-baseline-form > .btn { align-self:flex-end; min-height:2.75rem; margin-top:.35rem; }
.schedule-baseline-form { display:flex; flex-direction:column; gap:.25rem; }
.schedule-variance { display:grid; grid-template-columns:minmax(0,1fr) repeat(3,auto); gap:.5rem; align-items:center; margin-top:.5rem; padding:.625rem; border-radius:.375rem; background:var(--bs-tertiary-bg); font-size:.75rem; }
.schedule-baseline-list { display:grid; gap:.4rem; margin-top:.35rem; }
.schedule-baseline-list article { padding:.625rem; border:1px solid var(--bs-border-color); border-radius:.375rem; }
.schedule-baseline-list small { display:block; margin-top:.2rem; color:var(--bs-secondary-color); font-size:.75rem; }
.schedule-baseline-list p { overflow-wrap:anywhere; }
.governance-table-wrap { overflow-x:auto; border:1px solid var(--bs-border-color); border-radius:.5rem; }
.governance-table { width:100%; border-collapse:collapse; font-size:.875rem; }
.governance-table th { position:sticky; top:0; background:var(--bs-tertiary-bg); text-align:left; font-size:.75rem; color:var(--bs-secondary-color); }
.governance-table th,.governance-table td { padding:.625rem .75rem; border-bottom:1px solid var(--bs-border-color); vertical-align:top; }
.governance-table td:first-child { min-width:18rem; }
.governance-table td strong,.governance-list strong { display:block; margin-top:.25rem; line-height:1.25; }
.governance-table small,.governance-list small { display:block; color:var(--bs-secondary-color); margin-top:.25rem; max-width:70ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.governance-kind,.governance-status { display:inline-flex; padding:.125rem .375rem; border-radius:999px; background:var(--bs-tertiary-bg); font-size:.75rem; text-transform:capitalize; }
.governance-row-actions { display:flex; justify-content:flex-end; gap:.25rem; white-space:nowrap; }
.governance-row-actions button,.governance-pagination button { width:2.75rem; height:2.75rem; border:1px solid var(--bs-border-color); border-radius:.375rem; background:transparent; color:var(--bs-body-color); }
.governance-row-actions button:focus-visible,.governance-pagination button:focus-visible,.governance-tabs button:focus-visible { outline:3px solid color-mix(in srgb,var(--bs-primary) 40%,transparent); outline-offset:2px; }
.governance-pagination { display:flex; justify-content:space-between; align-items:center; padding:.5rem 0; color:var(--bs-secondary-color); font-size:.875rem; }
.governance-pagination div { display:flex; align-items:center; gap:.5rem; }
.governance-list { display:grid; gap:.5rem; }
.governance-list article { display:flex; align-items:center; justify-content:space-between; gap:.75rem; padding:.75rem; border:1px solid var(--bs-border-color); border-radius:.5rem; }
.governance-list--goals article { align-items:flex-start; }
.governance-goal__content { display:grid; gap:.625rem; min-width:0; flex:1; }
.governance-monitor-list { display:grid; gap:.25rem; }
.governance-monitor-list > div { display:grid; grid-template-columns:minmax(0,1fr) minmax(10rem,auto) 2.75rem; align-items:center; gap:.5rem; padding:.375rem .5rem; border-radius:.375rem; background:var(--bs-tertiary-bg); font-size:.875rem; }
.governance-monitor-list small { margin:0; text-align:right; }
.governance-monitor-list button { width:2.75rem; height:2.75rem; border:0; border-radius:.375rem; background:transparent; color:var(--bs-body-color); }
.governance-attention-list { display:grid; gap:.4rem; margin-top:.5rem; }
.governance-attention { display:grid; grid-template-columns:minmax(0,1fr) 2.75rem; align-items:center; gap:.5rem; padding:.55rem; border:1px solid var(--bs-warning-border-subtle); border-radius:.4rem; background:var(--bs-warning-bg-subtle); }
.governance-attention--critical { border-color:var(--bs-danger-border-subtle); background:var(--bs-danger-bg-subtle); }
.governance-attention span { display:grid; gap:.15rem; min-width:0; }
.governance-attention small { margin:0; overflow-wrap:anywhere; }
.governance-attention button { width:2.75rem; height:2.75rem; border:0; border-radius:.375rem; background:transparent; color:var(--bs-body-color); }
.governance-empty { padding:1.5rem; text-align:center; color:var(--bs-secondary-color); font-size:.875rem; }
.governance-editor { position:sticky; top:10rem; border:1px solid var(--bs-border-color); border-radius:.5rem; background:var(--bs-body-bg); padding:1rem; box-shadow:0 .5rem 1.5rem rgba(0,0,0,.08); }
.governance-editor h2 { margin:0 0 .75rem; font-size:1.125rem; }
.governance-editor label { display:block; margin:.25rem 0; font-size:.75rem; font-weight:600; }
.governance-editor input,.governance-editor select,.governance-editor textarea { margin-bottom:.5rem; }
.governance-editor .governance-check { display:flex; flex-direction:row; align-items:center; gap:.5rem; min-height:2.75rem; }
.governance-editor .governance-check input { width:1.125rem; min-height:1.125rem; margin:0; }
.governance-predicate-plan { display:grid; gap:.5rem; margin:.75rem 0; padding:.75rem; border:1px solid var(--bs-border-color); border-radius:.5rem; }
.governance-predicate-plan legend { float:none; width:auto; margin:0; padding:0 .25rem; font-size:.875rem; font-weight:700; }
.governance-predicate-row { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:.25rem .5rem; padding:.625rem; border-radius:.375rem; background:var(--bs-tertiary-bg); }
.governance-predicate-row .governance-check,.governance-predicate-row button { align-self:end; }
.governance-editor__row { display:grid; grid-template-columns:1fr 1fr; gap:.5rem; }
.governance-editor__actions { display:flex; justify-content:flex-end; gap:.5rem; margin-top:1rem; }
@media (max-width: 62rem) { .governance-metrics { grid-template-columns:repeat(3,1fr); } .schedule-strip { grid-template-columns:repeat(2,1fr); } .schedule-controls { grid-template-columns:minmax(0,1fr); } .governance-layout { grid-template-columns:minmax(0,1fr); } .governance-editor { position:static; grid-row:1; width:100%; max-width:100%; } .governance-toolbar { grid-template-columns:minmax(0,1fr) minmax(0,1fr); } .governance-search { grid-column:1/-1; } }
@media (max-width: 40rem) { .governance-workspace { width:100%; max-width:100%; overflow-x:hidden; padding:.75rem .5rem; } .governance-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .schedule-strip { grid-template-columns:minmax(0,1fr); } .schedule-variance { grid-template-columns:minmax(0,1fr); } .governance-toolbar { grid-template-columns:minmax(0,1fr); } .governance-search { grid-column:auto; } .governance-toolbar .btn { min-height:2.75rem; } .governance-table th:nth-child(3),.governance-table td:nth-child(3),.governance-table th:nth-child(4),.governance-table td:nth-child(4) { display:none; } .governance-editor__row,.governance-predicate-row { grid-template-columns:minmax(0,1fr); } .governance-list--goals article { flex-direction:column; } .governance-list--goals .governance-row-actions { width:100%; } .governance-monitor-list > div { grid-template-columns:minmax(0,1fr) 2.75rem; } .governance-monitor-list small { grid-column:1; text-align:left; } .governance-monitor-list button { grid-column:2; grid-row:1/3; } }
</style>
