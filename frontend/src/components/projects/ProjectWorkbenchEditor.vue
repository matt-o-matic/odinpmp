<script setup>
import { computed, ref, useId, watch } from 'vue';

import {
  buildTreeMetrics,
  formatDateRange,
} from '../../lib/projects/project-editor.js';
import {
  applyWorkItemStatus,
  COMPLETED_STATUS,
  DEFAULT_IN_FLIGHT_PERCENT,
  isLeafWorkItem,
  normalizeActualHours,
  normalizePercentComplete,
  normalizeRemainingHours,
  NOT_STARTED_STATUS,
} from '../../lib/projects/work-progress.js';
import { childEstimateTotals, childrenOf, usesChildEstimates } from '../../lib/projects/work-estimates.js';
import {
  buildProjectBriefMarkdown,
  projectBriefHasAnyContent,
} from '../../lib/projects/project-brief.js';
import { apiClient } from '../../lib/auth/index.js';
import { renderRichTextToHtml } from '../../lib/rich-content/html.js';
import { applyWorkItemTemplateToNode } from '../../lib/workflows/workflow-templates.js';
import WorkItemTemplatePicker from '../workflows/WorkItemTemplatePicker.vue';
import RichContentEditor from '../rich-content/RichContentEditor.vue';
import ProjectCommentsPanel from './ProjectCommentsPanel.vue';
import ProjectTaskTable from './ProjectTaskTable.vue';
import ProjectFilesPanel from './ProjectFilesPanel.vue';
import WorkItemRelations from './WorkItemRelations.vue';
import WorkProgressBar from './WorkProgressBar.vue';
import StoryBillingMilestoneField from './StoryBillingMilestoneField.vue';

const props = defineProps({
  activeDetail: {
    required: true,
    type: Object,
  },
  apiBaseUrl: {
    required: true,
    type: String,
  },
  // Project or workspace admin or manager with the Consulting module on: the story's SOW milestone.
  canManageBilling: {
    default: false,
    type: Boolean,
  },
  currentUserId: {
    default: '',
    type: String,
  },
  currentUserRole: {
    default: 'user',
    type: String,
  },
  hasUnsavedChanges: {
    default: false,
    type: Boolean,
  },
  projectStatusOptions: {
    required: true,
    type: Array,
  },
  projectId: {
    required: true,
    type: String,
  },
  projectSnapshot: {
    default: null,
    type: Object,
  },
  token: {
    default: '',
    type: String,
  },
  validUsers: {
    default: () => [],
    type: Array,
  },
  workStatusOptions: {
    required: true,
    type: Array,
  },
});

const emit = defineEmits(['add-story', 'add-task', 'remove-item', 'reassign-story', 'restored', 'select', 'split-story']);

const currentItem = computed(() => props.activeDetail.item);
const metrics = computed(() => buildTreeMetrics(props.activeDetail.type, currentItem.value));
const projectBrief = computed(() => currentItem.value?.assistantState?.brief ?? {});
const projectBriefMarkdown = computed(() => buildProjectBriefMarkdown(projectBrief.value));
const projectBriefHtml = computed(() => renderRichTextToHtml(projectBriefMarkdown.value, props.apiBaseUrl));
const projectBriefHasContent = computed(() => projectBriefHasAnyContent(projectBrief.value));
const editorTargetType = computed(() => props.activeDetail.type);
const editorTargetId = computed(() => {
  if (props.activeDetail.type === 'project') {
    return props.projectId;
  }

  return currentItem.value?.id ?? '';
});

const breadcrumb = computed(() => {
  if (props.activeDetail.type === 'epic') {
    return 'Project / Epic';
  }

  if (props.activeDetail.type === 'story') {
    return 'Project / Epic / Story';
  }

  if (props.activeDetail.type === 'task') {
    return 'Project / Epic / Story / Task';
  }

  return 'Project';
});

const summaryLine = computed(() => {
  if (!currentItem.value) {
    return '';
  }

  if (props.activeDetail.type === 'project' || props.activeDetail.type === 'epic') {
    return `${metrics.value.storyCount} stories, ${metrics.value.taskCount} tasks, ${metrics.value.completedPercent}% complete`;
  }

  if (props.activeDetail.type === 'story') {
    return `${metrics.value.taskCount} tasks, ${metrics.value.completedPercent}% complete`;
  }

  return formatDateRange(currentItem.value.targetStartDate, currentItem.value.targetEndDate);
});

const aiWorking = ref(false);
const aiError = ref('');
const historyOpen = ref(false);
const historyLoading = ref(false);
const historyError = ref('');
const historyRestoring = ref(false);
const itemRevisions = ref([]);

async function loadItemRevisions() {
  if (!props.token || !props.projectId || !currentItem.value?.id || props.activeDetail.type === 'project') return;
  historyLoading.value = true;
  historyError.value = '';
  try {
    const result = await apiClient.listProjectItemRevisions(props.projectId, currentItem.value.id, props.token);
    itemRevisions.value = result.revisions ?? [];
  } catch (error) {
    historyError.value = error.message ?? 'Unable to load item history.';
  } finally {
    historyLoading.value = false;
  }
}

async function toggleHistory() {
  historyOpen.value = !historyOpen.value;
  if (historyOpen.value) await loadItemRevisions();
}

async function restoreRevision(revision, state) {
  if (props.hasUnsavedChanges || historyRestoring.value) return;
  historyRestoring.value = true;
  historyError.value = '';
  try {
    const result = await apiClient.restoreProjectItem(props.projectId, currentItem.value.id, {
      expectedVersion: currentItem.value.version,
      revisionId: revision.id,
      state,
    }, props.token);
    emit('restored', result.project);
    itemRevisions.value = [];
    historyOpen.value = false;
  } catch (error) {
    historyError.value = error.message ?? 'Unable to restore this item revision.';
  } finally {
    historyRestoring.value = false;
  }
}

function formatRevisionDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unknown time' : date.toLocaleString();
}

const priorityOptions = [
  { label: 'Highest', value: 1 },
  { label: 'High', value: 2 },
  { label: 'Medium High', value: 3 },
  { label: 'Medium', value: 4 },
  { label: 'Medium Low', value: 5 },
  { label: 'Low', value: 6 },
  { label: 'Lowest', value: 7 },
];
const validUsers = computed(() => (Array.isArray(props.validUsers) ? props.validUsers : []));
const validUsersById = computed(() => new Map(validUsers.value.map((entry) => [entry.id, entry])));
const estimateInteractions = ref(new Map());
const currentEstimateKey = computed(() => currentItem.value?.id ?? '');
const currentEstimateInteractions = computed(() => estimateInteractions.value.get(currentEstimateKey.value) ?? {
  hours: false,
  points: false,
});
// An item with children shows its children's totals until someone types an estimate over
// them. The points/hours scale only checks estimates typed by hand.
const estimateChildren = computed(() => childrenOf(currentItem.value));
const estimateRollsUp = computed(() => usesChildEstimates(currentItem.value));
const estimateChildTotals = computed(() => childEstimateTotals(estimateChildren.value));
const estimateChildNouns = computed(() => (props.activeDetail.type === 'epic' ? ['story', 'stories'] : ['task', 'tasks']));
const childTotalActionLabel = computed(() => `Use ${estimateChildNouns.value[0]} total`);

function estimateSourceHint(field) {
  if (estimateChildren.value.length === 0) return null;
  const totals = estimateChildTotals.value;
  const [singular, plural] = estimateChildNouns.value;

  if (estimateRollsUp.value) {
    const missing = totals.unestimatedCount > 0 ? `; ${totals.unestimatedCount} without an estimate` : '';
    return { canReset: false, text: `Sum of ${totals.childCount} ${totals.childCount === 1 ? singular : plural}${missing}.` };
  }

  const total = field === 'points' ? totals.points : totals.hours;
  const totalText = total == null
    ? `${plural[0].toUpperCase()}${plural.slice(1)} have no estimates yet.`
    : `${plural[0].toUpperCase()}${plural.slice(1)} add up to ${total}${field === 'hours' ? 'h' : ''}.`;
  return { canReset: true, text: `Set by hand. ${totalText}` };
}

const pointsSourceHint = computed(() => estimateSourceHint('points'));
const hoursSourceHint = computed(() => estimateSourceHint('hours'));

function useChildEstimateTotals() {
  if (currentItem.value) currentItem.value.estimateOverride = false;
}

const estimateExpectedPoints = computed(() => pointsForEstimatedHours(currentItem.value?.targetHourEstimate));
const estimateConflict = computed(() => {
  if (estimateRollsUp.value) {
    return false;
  }

  if (!hasEstimateValue(currentItem.value?.points) || estimateExpectedPoints.value == null) {
    return false;
  }

  if (!currentEstimateInteractions.value.hours && !currentEstimateInteractions.value.points) {
    return false;
  }

  return Number(currentItem.value.points) !== estimateExpectedPoints.value;
});
const estimateConflictMessage = computed(() => {
  if (!estimateConflict.value) {
    return '';
  }

  return `${currentItem.value.targetHourEstimate}h maps to ${estimateExpectedPoints.value} point${estimateExpectedPoints.value === 1 ? '' : 's'}; current points are ${currentItem.value.points}.`;
});
const pointsFixHours = computed(() => maxHoursForStoryPoints(currentItem.value?.points));
const pointsConflictMessage = computed(() => {
  if (!estimateConflict.value) {
    return '';
  }

  if (pointsFixHours.value == null) {
    return `${currentItem.value.points} points is not on the estimate scale.`;
  }

  return `${currentItem.value.points} point${Number(currentItem.value.points) === 1 ? '' : 's'} should use up to ${pointsFixHours.value}h.`;
});

watch(
  currentItem,
  (item) => {
    if (item && !hasEstimateValue(item.priority)) {
      item.priority = 4;
    }
  },
  { immediate: true },
);

function hasEstimateValue(value) {
  return value !== '' && value != null && Number.isFinite(Number(value));
}

function normalizeEstimateInput(value) {
  if (value === '') {
    return null;
  }

  const nextValue = Number(value);
  return Number.isFinite(nextValue) ? nextValue : null;
}

function pointsForEstimatedHours(value) {
  if (!hasEstimateValue(value)) {
    return null;
  }

  const hours = Number(value);
  if (hours <= 8) return 1;
  if (hours <= 16) return 2;
  if (hours <= 24) return 3;
  if (hours <= 40) return 5;
  if (hours <= 80) return 10;
  return null;
}

function maxHoursForStoryPoints(value) {
  if (!hasEstimateValue(value)) {
    return null;
  }

  switch (Number(value)) {
    case 1:
      return 8;
    case 2:
      return 16;
    case 3:
      return 24;
    case 5:
      return 40;
    case 10:
      return 80;
    default:
      return null;
  }
}

function markEstimateInteraction(field) {
  if (!currentEstimateKey.value) {
    return;
  }

  const previous = estimateInteractions.value.get(currentEstimateKey.value) ?? { hours: false, points: false };
  estimateInteractions.value.set(currentEstimateKey.value, {
    ...previous,
    [field]: true,
  });
}

function updateTargetHours(event) {
  if (!currentItem.value) {
    return;
  }

  markEstimateInteraction('hours');
  currentItem.value.targetHourEstimate = normalizeEstimateInput(event?.target?.value ?? '');

  // Typing over a rolled-up estimate keeps both numbers as they are now, with no scale pairing.
  if (estimateChildren.value.length > 0) {
    currentItem.value.estimateOverride = true;
    return;
  }

  if (!currentEstimateInteractions.value.points && estimateExpectedPoints.value != null) {
    currentItem.value.points = estimateExpectedPoints.value;
  } else if (!currentEstimateInteractions.value.points && !hasEstimateValue(currentItem.value.targetHourEstimate)) {
    currentItem.value.points = null;
  }
}

function updatePoints(event) {
  if (!currentItem.value) {
    return;
  }

  markEstimateInteraction('points');
  currentItem.value.points = normalizeEstimateInput(event?.target?.value ?? '');

  if (estimateChildren.value.length > 0) {
    currentItem.value.estimateOverride = true;
    return;
  }

  if (!currentEstimateInteractions.value.hours && pointsFixHours.value != null) {
    currentItem.value.targetHourEstimate = pointsFixHours.value;
  } else if (!currentEstimateInteractions.value.hours && !hasEstimateValue(currentItem.value.points)) {
    currentItem.value.targetHourEstimate = null;
  }
}

function fixPointsFromHours() {
  if (currentItem.value && estimateExpectedPoints.value != null) {
    markEstimateInteraction('points');
    currentItem.value.points = estimateExpectedPoints.value;
  }
}

function fixHoursFromPoints() {
  if (currentItem.value && pointsFixHours.value != null) {
    markEstimateInteraction('hours');
    currentItem.value.targetHourEstimate = pointsFixHours.value;
  }
}

// Task statuses replaced by completing a story, kept so un-completing it before a save puts
// them back. Saving or reverting the draft makes the replacement final.
const storyCompletionMemory = new Map();

watch(
  () => props.hasUnsavedChanges,
  (hasChanges) => {
    if (!hasChanges) storyCompletionMemory.clear();
  },
);

function updateStatus(event) {
  applyWorkItemStatus(props.activeDetail.type, currentItem.value, String(event?.target?.value ?? ''), storyCompletionMemory);
}

const percentCompleteInputId = `work-item-percent-complete-${useId()}`;
const actualHoursInputId = `work-item-actual-hours-${useId()}`;
const remainingHoursInputId = `work-item-remaining-hours-${useId()}`;
// A single work item takes its own percent and logged hours; a story with tasks shows its
// tasks' totals instead.
const currentIsLeaf = computed(() => isLeafWorkItem(props.activeDetail.type, currentItem.value));
const percentCompleteLocked = computed(() => !currentIsLeaf.value || currentItem.value?.status === COMPLETED_STATUS);
const percentCompleteValue = computed(() => {
  if (!currentIsLeaf.value) return metrics.value.completedPercent;
  if (currentItem.value?.status === COMPLETED_STATUS) return 100;
  return currentItem.value?.percentComplete ?? '';
});
const percentCompletePlaceholder = computed(() => {
  const status = currentItem.value?.status ?? NOT_STARTED_STATUS;
  if (status === NOT_STARTED_STATUS) return '0';
  return `${DEFAULT_IN_FLIGHT_PERCENT[status] ?? DEFAULT_IN_FLIGHT_PERCENT['In Progress']} (default)`;
});
const actualHoursValue = computed(() => {
  if (currentIsLeaf.value) return currentItem.value?.actualHours ?? '';
  const actual = metrics.value.progress.actual;
  return actual.itemCount > 0 ? actual.hours : '';
});

function updatePercentComplete(event) {
  const item = currentItem.value;
  if (!item) return;
  item.percentComplete = normalizePercentComplete(event?.target?.value ?? '');
  // Recording progress on untouched work starts it.
  if (item.percentComplete > 0 && (item.status ?? NOT_STARTED_STATUS) === NOT_STARTED_STATUS) {
    applyWorkItemStatus(props.activeDetail.type, item, 'In Progress', storyCompletionMemory);
  }
}

function updateActualHours(event) {
  if (currentItem.value) {
    currentItem.value.actualHours = normalizeActualHours(event?.target?.value ?? '');
  }
}

// Remaining hours sit beside actual hours wherever those are typed in; blank clears them.
function updateRemainingHours(event) {
  if (currentItem.value) {
    currentItem.value.remainingHours = normalizeRemainingHours(event?.target?.value ?? '');
  }
}

function isPendingAi(item) {
  return Boolean(item?.aiGenerated === true && item?.aiAccepted !== true);
}

function acceptAiNodeDeep(node) {
  if (!node) {
    return;
  }

  node.aiAccepted = true;

  for (const story of node.stories ?? []) {
    acceptAiNodeDeep(story);
  }

  for (const task of node.tasks ?? []) {
    acceptAiNodeDeep(task);
  }
}

function normalizeGeneratedNodes(nodes = []) {
  for (const node of nodes ?? []) {
    if (node?.aiGenerated === true && node.aiAccepted == null) {
      node.aiAccepted = false;
    }

    normalizeGeneratedNodes(node?.stories);
    normalizeGeneratedNodes(node?.tasks);
  }
}

function updateAssigneeForCurrentItem(event) {
  if (!currentItem.value) {
    return;
  }

  const userId = String(event?.target?.value ?? '').trim();

  if (!userId) {
    currentItem.value.assigneeId = null;
    currentItem.value.assigneeName = '';
    return;
  }

  const user = validUsersById.value.get(userId);
  currentItem.value.assigneeId = userId;
  currentItem.value.assigneeName = user?.name ?? currentItem.value.assigneeName ?? '';
}

async function generateStories() {
  if (!props.token || !props.projectId || props.activeDetail.type !== 'epic') {
    return;
  }

  aiWorking.value = true;
  aiError.value = '';

  try {
    const result = await apiClient.generateStories(
      props.projectId,
      {
        epicId: props.activeDetail.epic.id,
        project: props.projectSnapshot ?? undefined,
      },
      props.token,
    );

    const stories = result.stories ?? [];
    if (stories.length === 0) {
      aiError.value = 'AI did not return any stories.';
      return;
    }

    normalizeGeneratedNodes(stories);

    props.activeDetail.epic.stories = [
      ...(props.activeDetail.epic.stories ?? []),
      ...stories,
    ];
  } catch (error) {
    aiError.value = error.message ?? 'Unable to generate stories.';
  } finally {
    aiWorking.value = false;
  }
}

async function generateTasks() {
  if (!props.token || !props.projectId || props.activeDetail.type !== 'story') {
    return;
  }

  aiWorking.value = true;
  aiError.value = '';

  try {
    const result = await apiClient.generateTasks(
      props.projectId,
      {
        project: props.projectSnapshot ?? undefined,
        storyId: props.activeDetail.story.id,
      },
      props.token,
    );

    const tasks = result.tasks ?? [];
    if (tasks.length === 0) {
      aiError.value = 'AI did not return any tasks.';
      return;
    }

    normalizeGeneratedNodes(tasks);

    props.activeDetail.story.tasks = [
      ...(props.activeDetail.story.tasks ?? []),
      ...tasks,
    ];
  } catch (error) {
    aiError.value = error.message ?? 'Unable to generate tasks.';
  } finally {
    aiWorking.value = false;
  }
}
</script>

<template>
  <section class="workbench-pane workbench-pane--editor">
    <div class="workbench-card workbench-card--hero">
      <div class="workbench-card__header">
        <div>
          <p class="card-eyebrow">{{ breadcrumb }}</p>
          <div style="display: flex; align-items: center; gap: 0.6rem; min-width: 0;">
            <h2 class="workbench-editor__title">{{ currentItem?.name || 'Untitled work item' }}</h2>
            <i v-if="isPendingAi(currentItem)" class="bi bi-stars" title="AI generated"></i>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <button
            v-if="activeDetail.type !== 'project'"
            class="ghost-button ghost-button--compact"
            type="button"
            :aria-expanded="historyOpen"
            title="Version history"
            @click="toggleHistory"
          >
            <i class="bi bi-clock-history" aria-hidden="true"></i>
            <span>History</span>
          </button>
          <span class="tree-badge">{{ activeDetail.type }}</span>
        </div>
      </div>
      <p class="panel-copy">{{ summaryLine }}</p>
      <!-- Only unsaved items: a template fills a new item, it does not rewrite saved work. -->
      <WorkItemTemplatePicker
        v-if="['epic', 'story', 'task'].includes(activeDetail.type) && currentItem && currentItem.version == null"
        :key="currentItem.id"
        input-id="workbench-item-template"
        :item-type="activeDetail.type"
        :model-value="currentItem.workItemTemplateId ?? ''"
        :token="token"
        @apply="(template) => applyWorkItemTemplateToNode(currentItem, template)"
      />
    </div>

    <dialog v-if="historyOpen" open class="item-history-dialog" aria-labelledby="item-history-title">
      <section class="workbench-card item-history-card" aria-live="polite">
      <div class="workbench-card__header">
        <div>
          <p class="card-eyebrow">Version history</p>
          <h3 id="item-history-title" class="workbench-card__title">Restore {{ currentItem?.name }}</h3>
        </div>
        <div class="d-flex align-items-center gap-2">
          <span class="tree-badge">v{{ currentItem?.version ?? 1 }}</span>
          <button class="ghost-button ghost-button--compact" type="button" aria-label="Close version history" @click="historyOpen = false"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
        </div>
      </div>
      <p v-if="hasUnsavedChanges" class="panel-copy">Save or revert your current draft before restoring history.</p>
      <p v-if="historyLoading" class="panel-copy">Loading history…</p>
      <p v-else-if="historyError" class="alert alert-danger" role="alert">{{ historyError }}</p>
      <p v-else-if="itemRevisions.length === 0" class="panel-copy">No granular revisions have been recorded for this item yet.</p>
      <div v-else class="d-grid gap-2">
        <article v-for="revision in itemRevisions" :key="revision.id" class="border rounded p-3">
          <div class="d-flex flex-wrap align-items-center justify-content-between gap-2">
            <div>
              <strong class="text-capitalize">{{ revision.action }}</strong>
              <span class="text-muted ms-2">v{{ revision.versionAfter }}</span>
              <div class="small text-muted">{{ formatRevisionDate(revision.createdAt) }}</div>
            </div>
            <div class="d-flex flex-wrap gap-2">
              <button v-if="revision.before" class="secondary-button secondary-button--compact" type="button" :disabled="hasUnsavedChanges || historyRestoring" @click="restoreRevision(revision, 'before')">Restore previous</button>
              <button v-if="revision.after" class="secondary-button secondary-button--compact" type="button" :disabled="hasUnsavedChanges || historyRestoring" @click="restoreRevision(revision, 'after')">Restore result</button>
            </div>
          </div>
        </article>
      </div>
      </section>
    </dialog>

    <template v-if="activeDetail.type === 'project'">
      <section class="workbench-card workbench-card--project-overview">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Project Overview</p>
            <h3 class="workbench-card__title">Current draft</h3>
          </div>
        </div>

        <div class="project-overview-grid">
          <div>
            <span class="context-metrics__label">Status</span>
            <strong>{{ currentItem.status }}</strong>
          </div>
          <div>
            <span class="context-metrics__label">Stories</span>
            <strong>{{ metrics.storyCount }}</strong>
          </div>
          <div>
            <span class="context-metrics__label">Tasks</span>
            <strong>{{ metrics.taskCount }}</strong>
          </div>
          <div>
            <span class="context-metrics__label">Complete</span>
            <strong>{{ metrics.completedPercent }}%</strong>
          </div>
        </div>

        <WorkProgressBar label="Project progress" :progress="metrics.progress" />

        <div v-if="projectBriefHasContent" class="project-brief-preview">
          <div class="workbench-card__header">
            <div>
              <p class="card-eyebrow">Project Brief</p>
              <h3 class="workbench-card__title">{{ projectBrief.name || currentItem.name }}</h3>
            </div>
          </div>
          <div class="rich-copy" v-html="projectBriefHtml"></div>
        </div>
      </section>
    </template>

    <template v-else-if="activeDetail.type === 'epic'">
      <section class="workbench-card">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Epic Details</p>
            <h3 class="workbench-card__title">Epic definition</h3>
          </div>
          <div class="action-split" role="group" aria-label="Epic commands">
            <button class="secondary-button secondary-button--compact" type="button" @click="$emit('add-story', activeDetail.epic.id)">
              <i class="bi bi-plus-square" aria-hidden="true"></i>
              <span>Add story</span>
            </button>
            <button class="secondary-button secondary-button--compact" type="button" :disabled="aiWorking" @click="generateStories">
              <i :class="aiWorking ? 'bi bi-arrow-repeat' : 'bi bi-stars'" aria-hidden="true"></i>
              <span>{{ aiWorking ? 'Working...' : 'Generate stories' }}</span>
            </button>
            <button
              v-if="isPendingAi(currentItem)"
              class="secondary-button secondary-button--compact"
              type="button"
              @click="acceptAiNodeDeep(currentItem)"
            >
              <i class="bi bi-check2-circle" aria-hidden="true"></i>
              <span>Accept epic</span>
            </button>
            <button class="ghost-button ghost-button--compact ghost-button--danger" type="button" @click="$emit('remove-item', activeDetail.selection)">
              <i class="bi bi-trash3" aria-hidden="true"></i>
              <span>Remove epic</span>
            </button>
          </div>
        </div>

        <div class="field-row">
          <div class="field-group">
            <label>Name</label>
            <input v-model="currentItem.name" />
          </div>
          <div class="field-group">
            <label>Status</label>
            <select :value="currentItem.status" @change="updateStatus">
              <option v-for="option in workStatusOptions" :key="option">{{ option }}</option>
            </select>
          </div>
        </div>

        <div class="field-group">
          <label>Description</label>
          <RichContentEditor
            v-model="currentItem.description"
            min-height="14rem"
            :project-id="projectId"
            storage-format="markdown"
            :target-id="editorTargetId"
            :target-type="editorTargetType"
            :title="currentItem.name"
            :token="token"
          />
        </div>
      </section>

      <section class="workbench-card">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Status & Assignment</p>
            <h3 class="workbench-card__title">Ownership</h3>
          </div>
        </div>

        <div class="editor-grid editor-grid--wide">
          <div class="field-group">
            <label>Assignee</label>
            <select
              v-if="validUsers.length"
              :value="currentItem.assigneeId ?? ''"
              @change="updateAssigneeForCurrentItem"
            >
              <option value="">Unassigned</option>
              <option v-for="user in validUsers" :key="user.id" :value="user.id">
                {{ user.name }}{{ user.resourceOnly ? ' (no login)' : '' }}
              </option>
            </select>
            <input v-else v-model="currentItem.assigneeName" placeholder="Unassigned" />
          </div>
          <div class="field-group">
            <label>Priority</label>
            <select v-model.number="currentItem.priority">
              <option v-for="option in priorityOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </div>
          <div class="field-group" :class="{ 'field-group--warning': estimateConflict }">
            <label>Points</label>
            <input :aria-invalid="estimateConflict" :value="currentItem.points ?? ''" min="0" step="1" type="number" @input="updatePoints" />
            <p v-if="pointsSourceHint" class="field-hint">
              {{ pointsSourceHint.text }}
              <button v-if="pointsSourceHint.canReset" class="field-hint__action" type="button" @click="useChildEstimateTotals">{{ childTotalActionLabel }}</button>
            </p>
            <p v-if="estimateConflict" class="field-hint field-hint--warning">
              {{ pointsConflictMessage }}
              <button v-if="pointsFixHours != null" class="field-hint__action" type="button" @click="fixHoursFromPoints">Fix</button>
            </p>
          </div>
        </div>
      </section>

      <section class="workbench-card">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Estimates & Dates</p>
            <h3 class="workbench-card__title">Delivery window</h3>
          </div>
        </div>

        <div class="field-row">
          <div class="field-group">
            <label>Start date</label>
            <input v-model="currentItem.targetStartDate" type="date" />
          </div>
          <div class="field-group">
            <label>End date</label>
            <input v-model="currentItem.targetEndDate" type="date" />
          </div>
          <div class="field-group" :class="{ 'field-group--warning': estimateConflict }">
            <label>Target hours</label>
            <input :aria-invalid="estimateConflict" :value="currentItem.targetHourEstimate ?? ''" min="0" step="1" type="number" @input="updateTargetHours" />
            <p v-if="hoursSourceHint" class="field-hint">
              {{ hoursSourceHint.text }}
              <button v-if="hoursSourceHint.canReset" class="field-hint__action" type="button" @click="useChildEstimateTotals">{{ childTotalActionLabel }}</button>
            </p>
            <p v-if="estimateConflict" class="field-hint field-hint--warning">
              {{ estimateConflictMessage }}
              <button class="field-hint__action" type="button" @click="fixPointsFromHours">Fix</button>
            </p>
          </div>
        </div>
      </section>
    </template>

    <template v-else-if="activeDetail.type === 'story'">
      <section class="workbench-card">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Story Details</p>
            <h3 class="workbench-card__title">User story definition</h3>
          </div>
          <div class="btn-group action-dropdown" role="group" aria-label="Story commands">
            <button
              class="secondary-button secondary-button--compact"
              type="button"
              data-bs-toggle="modal"
              data-bs-target="#storyReassignModal"
              @click="$emit('reassign-story', { epicId: activeDetail.epic.id, storyId: activeDetail.story.id })"
            >
              <i class="bi bi-arrow-left-right" aria-hidden="true"></i>
              <span>Move story</span>
            </button>
            <button
              class="secondary-button secondary-button--compact dropdown-toggle dropdown-toggle-split action-dropdown__toggle"
              type="button"
              data-bs-toggle="dropdown"
              aria-expanded="false"
              aria-label="More story actions"
            ></button>
            <ul class="dropdown-menu dropdown-menu-end action-dropdown__menu">
              <li>
                <button
                  class="dropdown-item action-dropdown__item"
                  type="button"
                  @click="$emit('split-story', { epicId: activeDetail.epic.id, storyId: activeDetail.story.id })"
                >
                  <i class="bi bi-scissors" aria-hidden="true"></i>
                  <span>Split story</span>
                </button>
              </li>
              <li v-if="isPendingAi(currentItem)">
                <button
                  class="dropdown-item action-dropdown__item"
                  type="button"
                  @click="acceptAiNodeDeep(currentItem)"
                >
                  <i class="bi bi-check2-circle" aria-hidden="true"></i>
                  <span>Accept story</span>
                </button>
              </li>
              <li v-if="isPendingAi(currentItem)">
                <hr class="dropdown-divider">
              </li>
              <li>
                <button class="dropdown-item action-dropdown__item action-dropdown__item--danger" type="button" @click="$emit('remove-item', activeDetail.selection)">
                  <i class="bi bi-trash3" aria-hidden="true"></i>
                  <span>Remove story</span>
                </button>
              </li>
            </ul>
          </div>
        </div>

        <div class="field-group">
          <label>Story name</label>
          <input v-model="currentItem.name" />
        </div>

        <div class="field-group">
          <label>Description</label>
          <RichContentEditor
            v-model="currentItem.description"
            min-height="16rem"
            :project-id="projectId"
            storage-format="markdown"
            :target-id="editorTargetId"
            :target-type="editorTargetType"
            :title="currentItem.name"
            :token="token"
          />
        </div>
      </section>

      <section class="workbench-card">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Status & Assignment</p>
            <h3 class="workbench-card__title">Workflow ownership</h3>
          </div>
        </div>

        <div class="editor-grid editor-grid--wide">
          <div class="field-group">
            <label>Status</label>
            <select :value="currentItem.status" @change="updateStatus">
              <option v-for="option in workStatusOptions" :key="option">{{ option }}</option>
            </select>
          </div>
          <div class="field-group">
            <label>Assignee</label>
            <select
              v-if="validUsers.length"
              :value="currentItem.assigneeId ?? ''"
              @change="updateAssigneeForCurrentItem"
            >
              <option value="">Unassigned</option>
              <option v-for="user in validUsers" :key="user.id" :value="user.id">
                {{ user.name }}{{ user.resourceOnly ? ' (no login)' : '' }}
              </option>
            </select>
            <input v-else v-model="currentItem.assigneeName" placeholder="Unassigned" />
          </div>
          <div class="field-group">
            <label>Priority</label>
            <select v-model.number="currentItem.priority">
              <option v-for="option in priorityOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </div>
          <div class="field-group" :class="{ 'field-group--warning': estimateConflict }">
            <label>Points</label>
            <input :aria-invalid="estimateConflict" :value="currentItem.points ?? ''" min="0" step="1" type="number" @input="updatePoints" />
            <p v-if="pointsSourceHint" class="field-hint">
              {{ pointsSourceHint.text }}
              <button v-if="pointsSourceHint.canReset" class="field-hint__action" type="button" @click="useChildEstimateTotals">{{ childTotalActionLabel }}</button>
            </p>
            <p v-if="estimateConflict" class="field-hint field-hint--warning">
              {{ pointsConflictMessage }}
              <button v-if="pointsFixHours != null" class="field-hint__action" type="button" @click="fixHoursFromPoints">Fix</button>
            </p>
          </div>
          <StoryBillingMilestoneField
            v-if="canManageBilling && currentItem.version != null"
            :key="currentItem.id"
            :project-id="projectId"
            :story-id="currentItem.id"
            :token="token"
          />
        </div>
      </section>

      <section class="workbench-card">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Estimates & Dates</p>
            <h3 class="workbench-card__title">Planning window</h3>
          </div>
        </div>

        <div class="field-row">
          <div class="field-group">
            <label>Target start</label>
            <input v-model="currentItem.targetStartDate" type="date" />
          </div>
          <div class="field-group">
            <label>Target end</label>
            <input v-model="currentItem.targetEndDate" type="date" />
          </div>
          <div class="field-group" :class="{ 'field-group--warning': estimateConflict }">
            <label>Target hours</label>
            <input :aria-invalid="estimateConflict" :value="currentItem.targetHourEstimate ?? ''" min="0" step="1" type="number" @input="updateTargetHours" />
            <p v-if="hoursSourceHint" class="field-hint">
              {{ hoursSourceHint.text }}
              <button v-if="hoursSourceHint.canReset" class="field-hint__action" type="button" @click="useChildEstimateTotals">{{ childTotalActionLabel }}</button>
            </p>
            <p v-if="estimateConflict" class="field-hint field-hint--warning">
              {{ estimateConflictMessage }}
              <button class="field-hint__action" type="button" @click="fixPointsFromHours">Fix</button>
            </p>
          </div>
          <div class="field-group">
            <label :for="percentCompleteInputId">{{ currentIsLeaf ? '% complete' : '% complete (from tasks)' }}</label>
            <input
              :id="percentCompleteInputId"
              :disabled="percentCompleteLocked"
              :placeholder="percentCompletePlaceholder"
              :value="percentCompleteValue"
              max="100"
              min="0"
              step="1"
              type="number"
              @input="updatePercentComplete"
            />
          </div>
          <div class="field-group">
            <label :for="actualHoursInputId">{{ currentIsLeaf ? 'Actual hours' : 'Actual hours (from tasks)' }}</label>
            <input
              :id="actualHoursInputId"
              :disabled="!currentIsLeaf"
              :placeholder="currentIsLeaf ? '' : 'None logged'"
              :value="actualHoursValue"
              min="0"
              step="any"
              type="number"
              @input="updateActualHours"
            />
          </div>
          <div v-if="currentIsLeaf" class="field-group">
            <label :for="remainingHoursInputId">Remaining hours</label>
            <input
              :id="remainingHoursInputId"
              :value="currentItem.remainingHours ?? ''"
              min="0"
              placeholder="Not set"
              step="any"
              type="number"
              @input="updateRemainingHours"
            />
          </div>
        </div>
      </section>

      <ProjectTaskTable
        :active-task-id="activeDetail.selection.taskId || ''"
        :story="activeDetail.story"
        :task-generation-busy="aiWorking"
        @add-task="$emit('add-task', { epicId: activeDetail.epic.id, storyId: activeDetail.story.id })"
        @generate-tasks="generateTasks"
        @remove-task="(taskId) => $emit('remove-item', { type: 'task', epicId: activeDetail.epic.id, storyId: activeDetail.story.id, taskId })"
        @select-task="(taskId) => $emit('select', { type: 'task', epicId: activeDetail.epic.id, storyId: activeDetail.story.id, taskId })"
      />
    </template>

    <template v-else-if="activeDetail.type === 'task'">
      <section class="workbench-card">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Task Details</p>
            <h3 class="workbench-card__title">Execution item</h3>
          </div>
          <div class="action-split" role="group" aria-label="Task commands">
            <button class="ghost-button ghost-button--compact" type="button" @click="$emit('select', { type: 'story', epicId: activeDetail.epic.id, storyId: activeDetail.story.id })">
              <i class="bi bi-arrow-left" aria-hidden="true"></i>
              <span>Back to story</span>
            </button>
            <button
              v-if="isPendingAi(currentItem)"
              class="secondary-button secondary-button--compact"
              type="button"
              @click="acceptAiNodeDeep(currentItem)"
            >
              <i class="bi bi-check2-circle" aria-hidden="true"></i>
              <span>Accept task</span>
            </button>
            <button class="ghost-button ghost-button--compact ghost-button--danger" type="button" @click="$emit('remove-item', activeDetail.selection)">
              <i class="bi bi-trash3" aria-hidden="true"></i>
              <span>Remove task</span>
            </button>
          </div>
        </div>

        <div class="field-group">
          <label>Name</label>
          <input v-model="currentItem.name" />
        </div>

        <div class="field-group">
          <label>Description</label>
          <RichContentEditor
            v-model="currentItem.description"
            min-height="14rem"
            :project-id="projectId"
            storage-format="markdown"
            :target-id="editorTargetId"
            :target-type="editorTargetType"
            :title="currentItem.name"
            :token="token"
          />
        </div>
      </section>

      <section class="workbench-card">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Status & Assignment</p>
            <h3 class="workbench-card__title">Execution state</h3>
          </div>
        </div>

        <div class="editor-grid editor-grid--wide">
          <div class="field-group">
            <label>Status</label>
            <select :value="currentItem.status" @change="updateStatus">
              <option v-for="option in workStatusOptions" :key="option">{{ option }}</option>
            </select>
          </div>
          <div class="field-group">
            <label>Assignee</label>
            <select
              v-if="validUsers.length"
              :value="currentItem.assigneeId ?? ''"
              @change="updateAssigneeForCurrentItem"
            >
              <option value="">Unassigned</option>
              <option v-for="user in validUsers" :key="user.id" :value="user.id">
                {{ user.name }}{{ user.resourceOnly ? ' (no login)' : '' }}
              </option>
            </select>
            <input v-else v-model="currentItem.assigneeName" placeholder="Unassigned" />
          </div>
          <div class="field-group">
            <label>Priority</label>
            <select v-model.number="currentItem.priority">
              <option v-for="option in priorityOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </div>
          <div class="field-group" :class="{ 'field-group--warning': estimateConflict }">
            <label>Points</label>
            <input :aria-invalid="estimateConflict" :value="currentItem.points ?? ''" min="0" step="1" type="number" @input="updatePoints" />
            <p v-if="pointsSourceHint" class="field-hint">
              {{ pointsSourceHint.text }}
              <button v-if="pointsSourceHint.canReset" class="field-hint__action" type="button" @click="useChildEstimateTotals">{{ childTotalActionLabel }}</button>
            </p>
            <p v-if="estimateConflict" class="field-hint field-hint--warning">
              {{ pointsConflictMessage }}
              <button v-if="pointsFixHours != null" class="field-hint__action" type="button" @click="fixHoursFromPoints">Fix</button>
            </p>
          </div>
        </div>
      </section>

      <section class="workbench-card">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Estimates & Dates</p>
            <h3 class="workbench-card__title">Timing</h3>
          </div>
        </div>

        <div class="field-row">
          <div class="field-group">
            <label>Target start</label>
            <input v-model="currentItem.targetStartDate" type="date" />
          </div>
          <div class="field-group">
            <label>Target end</label>
            <input v-model="currentItem.targetEndDate" type="date" />
          </div>
          <div class="field-group" :class="{ 'field-group--warning': estimateConflict }">
            <label>Target hours</label>
            <input :aria-invalid="estimateConflict" :value="currentItem.targetHourEstimate ?? ''" min="0" step="1" type="number" @input="updateTargetHours" />
            <p v-if="hoursSourceHint" class="field-hint">
              {{ hoursSourceHint.text }}
              <button v-if="hoursSourceHint.canReset" class="field-hint__action" type="button" @click="useChildEstimateTotals">{{ childTotalActionLabel }}</button>
            </p>
            <p v-if="estimateConflict" class="field-hint field-hint--warning">
              {{ estimateConflictMessage }}
              <button class="field-hint__action" type="button" @click="fixPointsFromHours">Fix</button>
            </p>
          </div>
          <div class="field-group">
            <label :for="percentCompleteInputId">{{ currentIsLeaf ? '% complete' : '% complete (from tasks)' }}</label>
            <input
              :id="percentCompleteInputId"
              :disabled="percentCompleteLocked"
              :placeholder="percentCompletePlaceholder"
              :value="percentCompleteValue"
              max="100"
              min="0"
              step="1"
              type="number"
              @input="updatePercentComplete"
            />
          </div>
          <div class="field-group">
            <label :for="actualHoursInputId">{{ currentIsLeaf ? 'Actual hours' : 'Actual hours (from tasks)' }}</label>
            <input
              :id="actualHoursInputId"
              :disabled="!currentIsLeaf"
              :placeholder="currentIsLeaf ? '' : 'None logged'"
              :value="actualHoursValue"
              min="0"
              step="any"
              type="number"
              @input="updateActualHours"
            />
          </div>
          <div v-if="currentIsLeaf" class="field-group">
            <label :for="remainingHoursInputId">Remaining hours</label>
            <input
              :id="remainingHoursInputId"
              :value="currentItem.remainingHours ?? ''"
              min="0"
              placeholder="Not set"
              step="any"
              type="number"
              @input="updateRemainingHours"
            />
          </div>
        </div>
      </section>
    </template>

    <WorkItemRelations
      v-if="activeDetail.type !== 'project' && editorTargetId"
      class="workbench-card"
      :item-id="editorTargetId"
      :item-name="currentItem?.name ?? ''"
      :project-id="projectId"
    />

    <ProjectFilesPanel
      v-if="activeDetail.type !== 'project' && editorTargetId"
      :project-id="projectId"
      :target-id="editorTargetId"
      :target-type="editorTargetType"
      :token="token"
    />

    <ProjectCommentsPanel
      v-if="activeDetail.type !== 'project'"
      :api-base-url="apiBaseUrl"
      :current-user-id="currentUserId"
      :current-user-role="currentUserRole"
      :project-id="projectId"
      :target-id="editorTargetId"
      :target-type="editorTargetType"
      :token="token"
    />

    <p v-if="aiError" class="rich-editor__error">{{ aiError }}</p>
  </section>
</template>

<style scoped>
.item-history-dialog {
  background: transparent;
  border: 0;
  inset: 0;
  margin: auto;
  max-height: min(80vh, 46rem);
  max-width: min(42rem, calc(100vw - 2rem));
  overflow: auto;
  padding: 0;
  position: fixed;
  width: 100%;
  z-index: 1200;
}

.item-history-dialog::backdrop {
  background: rgba(15, 23, 42, 0.55);
}

.project-brief-preview {
  border-top: 1px solid var(--border-subtle, #e5e7eb);
  margin-top: 1rem;
  padding-top: 1rem;
}
</style>
