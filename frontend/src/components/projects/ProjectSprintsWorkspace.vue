<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Sortable from 'sortablejs';

import { apiClient } from '../../lib/auth/index.js';
import { cloneProject, resolveProjectSelection, serializeProjectTree } from '../../lib/projects/project-editor.js';
import {
  buildPlanningSelection,
  mergeSprintStaffingMembers,
  summarizeSprintHealth,
} from '../../lib/projects/project-planning.js';
import { mergeRecord, recordsDiffer } from '../../lib/projects/project-merge.js';
import ProjectLiveUpdateNotice from './ProjectLiveUpdateNotice.vue';
import ProjectSplitStoryModal from './ProjectSplitStoryModal.vue';

const props = defineProps({
  project: {
    default: null,
    type: Object,
  },
  projectId: {
    required: true,
    type: String,
  },
  refreshVersion: {
    default: 0,
    type: Number,
  },
  token: {
    default: '',
    type: String,
  },
});

const emit = defineEmits(['edit-item', 'error', 'message', 'project-updated', 'select-item']);

const loading = ref(false);
const saving = ref(false);
const sprintQuery = ref('');
const planning = ref({
  backlog: { items: [], summary: {} },
  members: [],
  sprints: [],
});
const selectedSprintId = ref('');
const sprintDraft = ref({
  endDate: null,
  goal: '',
  name: '',
  startDate: null,
  status: 'planned',
});
const staffingDraft = ref([]);
const selectedBacklogIds = ref([]);
const selectedSprintItemIds = ref([]);
const splitStoryOpen = ref(false);
const splitStoryTarget = ref(null);
let planningSortables = [];

const sprintStatusOptions = ['planned', 'active', 'completed', 'archived'];

const filteredSprints = computed(() => {
  const query = String(sprintQuery.value ?? '').trim().toLowerCase();
  if (!query) {
    return planning.value.sprints ?? [];
  }

  return (planning.value.sprints ?? []).filter((sprint) => {
    return [sprint.name, sprint.goal, sprint.status]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
});

const selectedSprint = computed(() => {
  return (planning.value.sprints ?? []).find((sprint) => sprint.id === selectedSprintId.value) ?? null;
});

const sprintHealth = computed(() => summarizeSprintHealth(selectedSprint.value));

const availableBacklogItems = computed(() => planning.value.backlog?.items ?? []);
const committedItems = computed(() => selectedSprint.value?.items ?? []);
const committedGroups = computed(() => buildPlanningGroups(committedItems.value));
const backlogGroups = computed(() => buildPlanningGroups(availableBacklogItems.value));
const expandedPlanningGroupKeys = ref([]);

const SPRINT_FIELDS = ['name', 'goal', 'startDate', 'endDate', 'status'];
const STAFFING_FIELDS = ['capacityHours', 'allocationPctOverride', 'notes'];
const SPRINT_FIELD_LABELS = { endDate: 'End date', startDate: 'Start date' };
const STAFFING_FIELD_LABELS = { allocationPctOverride: 'Allocation override', capacityHours: 'Capacity hours' };

// The sprint form values as last loaded, so live updates can tell local edits from theirs.
const draftBase = ref(null);
const liveConflict = ref(null);
// A live refresh mid-drag would re-render the planning lanes under the cursor.
let planningDragging = false;
let refreshAfterDrag = false;

function draftsForSprint(sprint) {
  if (!sprint) {
    return {
      sprint: {
        endDate: props.project?.endDate ?? null,
        goal: '',
        name: '',
        startDate: props.project?.startDate ?? null,
        status: 'planned',
      },
      staffing: [],
    };
  }

  return {
    sprint: {
      endDate: sprint.endDate ?? null,
      goal: sprint.goal ?? '',
      name: sprint.name ?? '',
      startDate: sprint.startDate ?? null,
      status: sprint.status ?? 'planned',
    },
    staffing: mergeSprintStaffingMembers(sprint, planning.value.members),
  };
}

function initializeDrafts() {
  const drafts = draftsForSprint(selectedSprint.value);
  sprintDraft.value = drafts.sprint;
  staffingDraft.value = drafts.staffing;
  draftBase.value = JSON.parse(JSON.stringify(drafts));
  liveConflict.value = null;
}

function staffingDiffers(left = [], right = []) {
  const rightByUser = new Map(right.map((entry) => [entry.userId, entry]));
  return left.length !== right.length
    || left.some((entry) => !rightByUser.has(entry.userId) || recordsDiffer(entry, rightByUser.get(entry.userId), STAFFING_FIELDS));
}

function draftsDiffer(left, right) {
  return recordsDiffer(left?.sprint, right?.sprint, SPRINT_FIELDS) || staffingDiffers(left?.staffing, right?.staffing);
}

const sprintFormDirty = computed(() => (
  Boolean(selectedSprint.value && draftBase.value)
  && draftsDiffer({ sprint: sprintDraft.value, staffing: staffingDraft.value }, draftBase.value)
));

function mergeSprintDrafts(theirs, resolutions = {}) {
  const label = `Sprint "${theirs.sprint.name || sprintDraft.value.name || 'Sprint'}"`;
  const sprint = mergeRecord({
    base: draftBase.value.sprint,
    fieldLabels: SPRINT_FIELD_LABELS,
    fields: SPRINT_FIELDS,
    keyPrefix: 'sprint',
    label,
    mine: sprintDraft.value,
    resolutions,
    theirs: theirs.sprint,
  });
  const conflicts = [...sprint.conflicts];
  const baseByUser = new Map((draftBase.value.staffing ?? []).map((entry) => [entry.userId, entry]));
  const mineByUser = new Map(staffingDraft.value.map((entry) => [entry.userId, entry]));
  const staffing = theirs.staffing.map((theirRow) => {
    const mineRow = mineByUser.get(theirRow.userId);
    if (!mineRow) return theirRow;
    const row = mergeRecord({
      base: baseByUser.get(theirRow.userId) ?? theirRow,
      fieldLabels: STAFFING_FIELD_LABELS,
      fields: STAFFING_FIELDS,
      keyPrefix: `staffing:${theirRow.userId}`,
      label: `Capacity for ${theirRow.name || 'team member'}`,
      mine: mineRow,
      resolutions,
      theirs: theirRow,
    });
    conflicts.push(...row.conflicts);
    return { ...theirRow, ...Object.fromEntries(STAFFING_FIELDS.map((field) => [field, row.merged[field]])) };
  });

  return { conflicts, sprint: { ...sprintDraft.value, ...sprint.merged }, staffing };
}

const liveConflicts = computed(() => (liveConflict.value ? mergeSprintDrafts(liveConflict.value.theirs).conflicts : []));

function applyLiveMerge(resolutions) {
  if (!liveConflict.value) return;
  const { theirs } = liveConflict.value;
  const merged = mergeSprintDrafts(theirs, resolutions);
  sprintDraft.value = merged.sprint;
  staffingDraft.value = merged.staffing;
  draftBase.value = JSON.parse(JSON.stringify(theirs));
  liveConflict.value = null;
  emit('message', 'Merged the latest sprint changes into your edits. Save when ready.');
}

function discardLiveEdits() {
  initializeDrafts();
  emit('message', 'Discarded your sprint edits and loaded the latest version.');
}

function beginPlanningDrag() {
  planningDragging = true;
}

function finishPlanningDrag() {
  planningDragging = false;
  if (refreshAfterDrag) {
    refreshAfterDrag = false;
    loadPlanning({ live: true });
  }
}

async function loadPlanning({ live = false } = {}) {
  if (!props.projectId || !props.token) {
    return;
  }

  loading.value = !live;
  const keepLocalEdits = live && sprintFormDirty.value;

  try {
    // Live refreshes follow someone else's change, so they stay in the background.
    const client = live ? apiClient.passive : apiClient;
    const result = await client.getProjectSprints(props.projectId, props.token);
    planning.value = {
      backlog: result.backlog ?? { items: [], summary: {} },
      members: result.members ?? [],
      sprints: result.sprints ?? [],
    };

    if ((planning.value.sprints ?? []).some((sprint) => sprint.id === selectedSprintId.value)) {
      if (!keepLocalEdits) {
        initializeDrafts();
        return;
      }

      const theirs = draftsForSprint(selectedSprint.value);
      if (draftsDiffer(theirs, draftBase.value)) {
        liveConflict.value = { theirs };
      }
      return;
    }

    selectedSprintId.value = planning.value.sprints[0]?.id ?? '';
    initializeDrafts();
  } catch (error) {
    emit('error', error.message ?? 'Unable to load sprint planning.');
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.projectId, props.token],
  () => {
    selectedBacklogIds.value = [];
    selectedSprintItemIds.value = [];
    loadPlanning();
  },
  { immediate: true },
);

watch(
  () => props.refreshVersion,
  () => {
    if (planningDragging) {
      refreshAfterDrag = true;
      return;
    }
    loadPlanning({ live: true });
  },
);

watch(selectedSprintId, () => {
  selectedSprintItemIds.value = [];
  initializeDrafts();
  syncPlanningSortables();
});

watch(sprintFormDirty, (dirty) => {
  // Undoing every local edit leaves nothing to merge; take the latest values.
  if (!dirty && liveConflict.value) initializeDrafts();
});

watch(
  () => [availableBacklogItems.value, committedItems.value],
  () => {
    syncPlanningSortables();
  },
  { deep: true },
);

onBeforeUnmount(() => {
  destroyPlanningSortables();
});

function formatSummaryLabel(item) {
  const parts = [
    item.status ?? 'Not Started',
    item.assigneeName || 'Unassigned',
    item.points != null ? `${item.points} pts` : 'No points',
    item.targetHourEstimate != null ? `${item.targetHourEstimate}h` : 'No hours',
  ];

  return parts.join(' | ');
}

function buildPlanningGroups(items) {
  const groups = [];
  const groupByKey = new Map();

  for (const item of items ?? []) {
    const key = `story:${item.storyId || item.parentId || item.id}`;
    let group = groupByKey.get(key);

    if (!group) {
      group = {
        key,
        story: null,
        storyName: item.storyName || item.parentName || item.name,
        tasks: [],
      };
      groupByKey.set(key, group);
      groups.push(group);
    }

    if (item.issueType === 'story') {
      group.story = item;
      group.storyName = item.name;
    } else {
      group.tasks.push(item);
    }
  }

  return groups;
}

function isPlanningGroupExpanded(key) {
  return expandedPlanningGroupKeys.value.includes(key);
}

function togglePlanningGroup(key) {
  if (isPlanningGroupExpanded(key)) {
    expandedPlanningGroupKeys.value = expandedPlanningGroupKeys.value.filter((entry) => entry !== key);
    syncPlanningSortables();
    return;
  }

  expandedPlanningGroupKeys.value = [...expandedPlanningGroupKeys.value, key];
  syncPlanningSortables();
}

function getStoryTasks(item) {
  const storyId = item?.storyId || item?.id;

  for (const epic of props.project?.epics ?? []) {
    const story = (epic.stories ?? []).find((entry) => entry.id === storyId);
    if (story) {
      return story.tasks ?? [];
    }
  }

  return [];
}

function getPlanningItemCascadeIds(item) {
  if (item?.issueType !== 'story') {
    return [item.id];
  }

  return [item.id, ...getStoryTasks(item).map((task) => task.id)];
}

function isPlanningItemSelected(selectedIds, item) {
  return getPlanningItemCascadeIds(item).every((itemId) => selectedIds.includes(itemId));
}

function planningItemById(itemId) {
  const planningItem = [
    ...(planning.value.backlog?.items ?? []),
    ...(selectedSprint.value?.items ?? []),
  ].find((item) => item.id === itemId);

  if (planningItem) {
    return planningItem;
  }

  for (const epic of props.project?.epics ?? []) {
    for (const story of epic.stories ?? []) {
      if (story.id === itemId) {
        return { id: story.id, issueType: 'story' };
      }

      for (const task of story.tasks ?? []) {
        if (task.id === itemId) {
          return { id: task.id, issueType: 'task' };
        }
      }
    }
  }

  return null;
}

function visiblePlanningItemIds(container) {
  return Array.from(container.querySelectorAll(':scope > .planning-check-row'))
    .filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map((row) => row.getAttribute('data-planning-item-id'))
    .filter(Boolean);
}

function storyTaskIdsInLane(story, targetSprintId) {
  return getStoryTasks(story)
    .filter((task) => (task.sprintId ?? null) === targetSprintId)
    .map((task) => task.id);
}

function normalizePlanningOrder(itemIds, targetSprintId, movedCascadeIds = []) {
  const movedCascadeSet = new Set(movedCascadeIds);
  const normalizedIds = [];
  const includedIds = new Set();

  for (const itemId of itemIds) {
    if (includedIds.has(itemId) || (movedCascadeSet.size > 0 && movedCascadeSet.has(itemId) && itemId !== movedCascadeIds[0])) {
      continue;
    }

    const item = planningItemById(itemId);
    normalizedIds.push(itemId);
    includedIds.add(itemId);

    if (item?.issueType === 'story') {
      const taskIds = movedCascadeIds[0] === itemId
        ? movedCascadeIds.slice(1)
        : storyTaskIdsInLane(item, targetSprintId);

      for (const taskId of taskIds) {
        if (!includedIds.has(taskId)) {
          normalizedIds.push(taskId);
          includedIds.add(taskId);
        }
      }
    }
  }

  return normalizedIds;
}

function applyPlanningOrder(projectDraft, itemIds, targetSprintId, movedCascadeIds = []) {
  let sortOrder = 0;

  for (const itemId of normalizePlanningOrder(itemIds, targetSprintId, movedCascadeIds)) {
    const sourceItem = planningItemById(itemId);
    if (!sourceItem) {
      continue;
    }

    const selection = buildPlanningSelection(projectDraft, sourceItem);
    const detail = resolveProjectSelection(projectDraft, selection);

    if (!detail.item) {
      continue;
    }

    detail.item.sprintId = targetSprintId;
    detail.item.sprintSortOrder = sortOrder++;
  }
}

function destroyPlanningSortables() {
  for (const sortable of planningSortables) {
    sortable.destroy();
  }

  planningSortables = [];
}

async function syncPlanningSortables() {
  await nextTick();
  destroyPlanningSortables();

  for (const container of document.querySelectorAll('.planning-list-card__items[data-planning-lane]')) {
    planningSortables.push(Sortable.create(container, {
      animation: 150,
      dataIdAttr: 'data-planning-item-id',
      draggable: '.planning-check-row:not(.planning-check-row--hidden)',
      group: 'odinpmp-sprint-builder',
      handle: '.planning-drag-handle',
      onEnd: (event) => {
        Promise.resolve(handlePlanningSortEnd(event)).finally(finishPlanningDrag);
      },
      onStart: beginPlanningDrag,
    }));
  }
}

async function handlePlanningSortEnd(event) {
  if (!props.project || !selectedSprint.value || !props.token) {
    return;
  }

  const targetLane = event.to?.getAttribute('data-planning-lane') ?? '';
  const sourceLane = event.from?.getAttribute('data-planning-lane') ?? '';
  const movedItemId = event.item?.getAttribute('data-planning-item-id') ?? '';
  const movedItem = planningItemById(movedItemId);
  const movedCascadeIds = movedItem ? getPlanningItemCascadeIds(movedItem) : [];

  const projectDraft = cloneProject(props.project);
  const targetSprintId = targetLane === 'sprint' ? selectedSprint.value.id : null;
  const sourceSprintId = sourceLane === 'sprint' ? selectedSprint.value.id : null;

  applyPlanningOrder(projectDraft, visiblePlanningItemIds(event.to), targetSprintId, movedCascadeIds);

  if (event.from && event.from !== event.to) {
    const movedCascadeSet = new Set(movedCascadeIds);
    const sourceIds = visiblePlanningItemIds(event.from).filter((itemId) => !movedCascadeSet.has(itemId));
    applyPlanningOrder(projectDraft, sourceIds, sourceSprintId);
  }

  saving.value = true;

  try {
    const result = await apiClient.updateProjectTree(
      props.projectId,
      serializeProjectTree(projectDraft),
      props.token,
    );

    emit('project-updated', result.project);
    selectedBacklogIds.value = [];
    selectedSprintItemIds.value = [];
    await loadPlanning();
    emit('message', 'Sprint order updated.');
  } catch (error) {
    emit('error', error.message ?? 'Unable to reorder sprint work.');
    await loadPlanning();
  } finally {
    saving.value = false;
  }
}

function togglePlanningSelection(selectionRef, item) {
  const itemIds = getPlanningItemCascadeIds(item);
  const selectedIds = new Set(selectionRef.value);

  if (itemIds.every((itemId) => selectedIds.has(itemId))) {
    for (const itemId of itemIds) {
      selectedIds.delete(itemId);
    }
  } else {
    for (const itemId of itemIds) {
      selectedIds.add(itemId);
    }
  }

  selectionRef.value = [...selectedIds];
}

function openItem(item) {
  emit('edit-item', buildPlanningSelection(props.project, item));
}

function toggleBacklogSelection(item) {
  togglePlanningSelection(selectedBacklogIds, item);
}

function toggleCommittedSelection(item) {
  togglePlanningSelection(selectedSprintItemIds, item);
}

async function createSprint() {
  if (!props.projectId || !props.token) {
    return;
  }

  saving.value = true;

  try {
    const sprintNumber = (planning.value.sprints?.length ?? 0) + 1;
    const result = await apiClient.createProjectSprint(
      props.projectId,
      {
        endDate: props.project?.endDate ?? null,
        goal: '',
        name: `Sprint ${sprintNumber}`,
        startDate: props.project?.startDate ?? null,
        status: 'planned',
      },
      props.token,
    );

    selectedSprintId.value = result.sprint.id;
    await loadPlanning();
    emit('message', 'Sprint created.');
  } catch (error) {
    emit('error', error.message ?? 'Unable to create the sprint.');
  } finally {
    saving.value = false;
  }
}

function blockSaveForLiveConflict() {
  if (!liveConflict.value) return false;
  emit('error', 'This sprint changed while you were editing. Merge or discard the incoming changes before saving.');
  return true;
}

async function saveSprintDetails() {
  if (!selectedSprint.value || !props.token || blockSaveForLiveConflict()) {
    return;
  }

  saving.value = true;

  try {
    await apiClient.updateProjectSprint(props.projectId, selectedSprint.value.id, sprintDraft.value, props.token);
    await loadPlanning();
    emit('message', 'Sprint details saved.');
  } catch (error) {
    emit('error', error.message ?? 'Unable to save sprint details.');
  } finally {
    saving.value = false;
  }
}

async function updateSprintStatus(action) {
  if (!selectedSprint.value || !props.token) {
    return;
  }

  saving.value = true;

  try {
    if (action === 'activate') {
      await apiClient.activateProjectSprint(props.projectId, selectedSprint.value.id, props.token);
    } else {
      await apiClient.completeProjectSprint(props.projectId, selectedSprint.value.id, props.token);
    }
    await loadPlanning();
    emit('message', action === 'activate' ? 'Sprint activated.' : 'Sprint completed.');
  } catch (error) {
    emit('error', error.message ?? 'Unable to update sprint status.');
  } finally {
    saving.value = false;
  }
}

async function saveStaffing() {
  if (!selectedSprint.value || !props.token || blockSaveForLiveConflict()) {
    return;
  }

  saving.value = true;

  try {
    await apiClient.saveSprintStaffing(
      props.projectId,
      selectedSprint.value.id,
      {
        staffing: staffingDraft.value.map((entry) => ({
          allocationPctOverride: entry.allocationPctOverride === '' ? null : entry.allocationPctOverride,
          capacityHours: entry.capacityHours === '' ? null : entry.capacityHours,
          notes: entry.notes ?? '',
          userId: entry.userId,
        })),
      },
      props.token,
    );
    await loadPlanning();
    emit('message', 'Sprint staffing saved.');
  } catch (error) {
    emit('error', error.message ?? 'Unable to save sprint staffing.');
  } finally {
    saving.value = false;
  }
}

async function assignItems(itemIds, targetSprintId) {
  if (!props.token || itemIds.length === 0) {
    return;
  }

  const sourceItems = [
    ...(planning.value.backlog?.items ?? []),
    ...((selectedSprint.value?.items ?? [])),
  ];
  const itemMap = new Map(sourceItems.map((item) => [item.id, item]));

  saving.value = true;

  try {
    const result = await apiClient.assignSprintItems(
      props.projectId,
      {
        assignments: itemIds.map((itemId) => {
          const item = itemMap.get(itemId);
          return {
            itemId,
            itemType: item?.issueType ?? 'task',
            sprintId: targetSprintId ?? null,
          };
        }),
      },
      props.token,
    );

    emit('project-updated', result.project);
    selectedBacklogIds.value = [];
    selectedSprintItemIds.value = [];
    await loadPlanning();
    emit('message', targetSprintId ? 'Items assigned to sprint.' : 'Items moved back to backlog.');
  } catch (error) {
    emit('error', error.message ?? 'Unable to update sprint assignments.');
  } finally {
    saving.value = false;
  }
}

function beginSplitStory(item) {
  const selection = buildPlanningSelection(props.project, item);
  if (selection.type !== 'story') {
    return;
  }

  const epic = (props.project?.epics ?? []).find((entry) => entry.id === selection.epicId);
  splitStoryTarget.value = (epic?.stories ?? []).find((story) => story.id === selection.storyId) ?? null;
  splitStoryOpen.value = Boolean(splitStoryTarget.value);
}

async function handleSplitResult(result) {
  if (result?.project) {
    emit('project-updated', result.project);
  }

  await loadPlanning();

  if (result?.story) {
    emit('select-item', buildPlanningSelection(result.project, {
      id: result.story.id,
      issueType: 'story',
    }));
  }

  emit('message', 'Story split into a new follow-on item.');
}
</script>

<template>
  <div class="project-workbench">
    <aside class="workbench-pane workbench-pane--outline">
      <section class="workbench-card">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Sprint Workspace</p>
            <h3 class="workbench-card__title">Sprints</h3>
          </div>
          <button class="secondary-button secondary-button--compact" type="button" :disabled="saving" @click="createSprint">
            New Sprint
          </button>
        </div>

        <div class="field-group">
          <label>Filter sprints</label>
          <input v-model="sprintQuery" placeholder="Search sprints" />
        </div>

        <div class="planning-sprint-list" v-if="filteredSprints.length">
          <button
            v-for="sprint in filteredSprints"
            :key="sprint.id"
            class="planning-sprint-list__item"
            :class="{ 'planning-sprint-list__item--active': selectedSprintId === sprint.id }"
            type="button"
            @click="selectedSprintId = sprint.id"
          >
            <strong>{{ sprint.name }}</strong>
            <small>{{ sprint.status }} | {{ sprint.summary.totalItems }} items | {{ sprint.summary.totalHours }}h</small>
          </button>
        </div>
        <p v-else class="muted-copy">No sprints yet.</p>
      </section>
    </aside>

    <section class="workbench-pane workbench-pane--editor">
      <section v-if="selectedSprint" class="workbench-card planning-dual-grid planning-assignment-board">
        <div
          class="planning-list-card"
        >
          <div class="planning-list-card__header">
            <div>
              <p class="card-eyebrow">Committed</p>
              <h3 class="workbench-card__title">Sprint work</h3>
            </div>
            <button
              class="secondary-button secondary-button--compact"
              type="button"
              :disabled="saving || selectedSprintItemIds.length === 0"
              @click="assignItems(selectedSprintItemIds, null)"
            >
              Move to backlog
            </button>
          </div>

          <div class="planning-list-card__items" data-planning-lane="sprint">
          <template v-for="group in committedGroups" :key="group.key">
            <label
              v-if="group.story"
              class="planning-check-row planning-check-row--story"
              :data-planning-item-id="group.story.id"
            >
              <span class="planning-drag-handle" aria-hidden="true">
                <i class="bi bi-grip-vertical"></i>
              </span>
              <input
                :checked="isPlanningItemSelected(selectedSprintItemIds, group.story)"
                type="checkbox"
                @change="toggleCommittedSelection(group.story)"
              />
              <button
                v-if="group.tasks.length > 0"
                class="planning-collapse-button"
                type="button"
                :aria-expanded="isPlanningGroupExpanded(group.key)"
                @click="togglePlanningGroup(group.key)"
              >
                <i
                  class="bi"
                  :class="isPlanningGroupExpanded(group.key) ? 'bi-chevron-down' : 'bi-chevron-right'"
                  aria-hidden="true"
                ></i>
              </button>
              <span v-else class="planning-collapse-spacer" aria-hidden="true"></span>
              <button class="planning-check-row__copy" type="button" @click="openItem(group.story)">
                <strong>{{ group.story.name }}</strong>
                <small>{{ group.story.issueType }} | {{ formatSummaryLabel(group.story) }}<span v-if="group.tasks.length"> | {{ group.tasks.length }} tasks</span></small>
              </button>
              <button
                class="ghost-button ghost-button--compact ghost-button--icon"
                type="button"
                aria-label="Split story"
                title="Split story"
                @click="beginSplitStory(group.story)"
              >
                <i class="bi bi-scissors" aria-hidden="true"></i>
              </button>
            </label>
            <div v-else class="planning-story-context">
              <button
                class="planning-collapse-button"
                type="button"
                :aria-expanded="isPlanningGroupExpanded(group.key)"
                @click="togglePlanningGroup(group.key)"
              >
                <i
                  class="bi"
                  :class="isPlanningGroupExpanded(group.key) ? 'bi-chevron-down' : 'bi-chevron-right'"
                  aria-hidden="true"
                ></i>
              </button>
              <span>{{ group.storyName }}</span>
              <small>{{ group.tasks.length }} tasks</small>
            </div>

            <label
              v-for="task in group.tasks"
              v-show="isPlanningGroupExpanded(group.key)"
              :key="task.id"
              class="planning-check-row planning-check-row--task"
              :class="{ 'planning-check-row--hidden': !isPlanningGroupExpanded(group.key) }"
              :data-planning-item-id="task.id"
            >
              <span class="planning-drag-handle" aria-hidden="true">
                <i class="bi bi-grip-vertical"></i>
              </span>
              <input
                :checked="isPlanningItemSelected(selectedSprintItemIds, task)"
                type="checkbox"
                @change="toggleCommittedSelection(task)"
              />
              <span class="planning-task-connector" aria-hidden="true"></span>
              <button class="planning-check-row__copy" type="button" @click="openItem(task)">
                <strong>{{ task.name }}</strong>
                <small>{{ task.issueType }} | {{ formatSummaryLabel(task) }}</small>
              </button>
            </label>
          </template>
          <p v-if="committedItems.length === 0" class="muted-copy">No work committed yet.</p>
          </div>
        </div>

        <div
          class="planning-list-card"
        >
          <div class="planning-list-card__header">
            <div>
              <p class="card-eyebrow">Backlog</p>
              <h3 class="workbench-card__title">Candidate work</h3>
            </div>
            <button
              class="secondary-button secondary-button--compact"
              type="button"
              :disabled="saving || selectedBacklogIds.length === 0"
              @click="assignItems(selectedBacklogIds, selectedSprint.id)"
            >
              Commit to sprint
            </button>
          </div>

          <div class="planning-list-card__items" data-planning-lane="backlog">
          <template v-for="group in backlogGroups" :key="group.key">
            <label
              v-if="group.story"
              class="planning-check-row planning-check-row--story"
              :data-planning-item-id="group.story.id"
            >
              <span class="planning-drag-handle" aria-hidden="true">
                <i class="bi bi-grip-vertical"></i>
              </span>
              <input
                :checked="isPlanningItemSelected(selectedBacklogIds, group.story)"
                type="checkbox"
                @change="toggleBacklogSelection(group.story)"
              />
              <button
                v-if="group.tasks.length > 0"
                class="planning-collapse-button"
                type="button"
                :aria-expanded="isPlanningGroupExpanded(group.key)"
                @click="togglePlanningGroup(group.key)"
              >
                <i
                  class="bi"
                  :class="isPlanningGroupExpanded(group.key) ? 'bi-chevron-down' : 'bi-chevron-right'"
                  aria-hidden="true"
                ></i>
              </button>
              <span v-else class="planning-collapse-spacer" aria-hidden="true"></span>
              <button class="planning-check-row__copy" type="button" @click="openItem(group.story)">
                <strong>{{ group.story.name }}</strong>
                <small>{{ group.story.issueType }} | {{ formatSummaryLabel(group.story) }}<span v-if="group.tasks.length"> | {{ group.tasks.length }} tasks</span></small>
              </button>
              <button
                class="ghost-button ghost-button--compact ghost-button--icon"
                type="button"
                aria-label="Split story"
                title="Split story"
                @click="beginSplitStory(group.story)"
              >
                <i class="bi bi-scissors" aria-hidden="true"></i>
              </button>
            </label>
            <div v-else class="planning-story-context">
              <button
                class="planning-collapse-button"
                type="button"
                :aria-expanded="isPlanningGroupExpanded(group.key)"
                @click="togglePlanningGroup(group.key)"
              >
                <i
                  class="bi"
                  :class="isPlanningGroupExpanded(group.key) ? 'bi-chevron-down' : 'bi-chevron-right'"
                  aria-hidden="true"
                ></i>
              </button>
              <span>{{ group.storyName }}</span>
              <small>{{ group.tasks.length }} tasks</small>
            </div>

            <label
              v-for="task in group.tasks"
              v-show="isPlanningGroupExpanded(group.key)"
              :key="task.id"
              class="planning-check-row planning-check-row--task"
              :class="{ 'planning-check-row--hidden': !isPlanningGroupExpanded(group.key) }"
              :data-planning-item-id="task.id"
            >
              <span class="planning-drag-handle" aria-hidden="true">
                <i class="bi bi-grip-vertical"></i>
              </span>
              <input
                :checked="isPlanningItemSelected(selectedBacklogIds, task)"
                type="checkbox"
                @change="toggleBacklogSelection(task)"
              />
              <span class="planning-task-connector" aria-hidden="true"></span>
              <button class="planning-check-row__copy" type="button" @click="openItem(task)">
                <strong>{{ task.name }}</strong>
                <small>{{ task.issueType }} | {{ formatSummaryLabel(task) }}</small>
              </button>
            </label>
          </template>
          <p v-if="availableBacklogItems.length === 0" class="muted-copy">Backlog is clear.</p>
          </div>
        </div>
      </section>

      <section v-if="selectedSprint" class="workbench-card planning-sprint-details">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Sprint Details</p>
            <h3 class="workbench-card__title">{{ selectedSprint.name }}</h3>
          </div>
          <div class="actions-row">
            <button class="secondary-button secondary-button--compact" type="button" :disabled="saving" @click="saveSprintDetails">
              Save sprint
            </button>
            <button
              v-if="selectedSprint.status === 'planned'"
              class="secondary-button secondary-button--compact"
              type="button"
              :disabled="saving"
              @click="updateSprintStatus('activate')"
            >
              Activate
            </button>
            <button
              v-if="selectedSprint.status !== 'completed'"
              class="ghost-button ghost-button--compact"
              type="button"
              :disabled="saving"
              @click="updateSprintStatus('complete')"
            >
              Complete
            </button>
          </div>
        </div>

        <div class="field-group">
          <label>Name</label>
          <input v-model="sprintDraft.name" />
        </div>
        <div class="field-group">
          <label>Goal</label>
          <textarea v-model="sprintDraft.goal" rows="4"></textarea>
        </div>
        <div class="editor-grid editor-grid--wide">
          <div class="field-group">
            <label>Status</label>
            <select v-model="sprintDraft.status">
              <option v-for="option in sprintStatusOptions" :key="option" :value="option">{{ option }}</option>
            </select>
          </div>
          <div class="field-group">
            <label>Start date</label>
            <input v-model="sprintDraft.startDate" type="date" />
          </div>
          <div class="field-group">
            <label>End date</label>
            <input v-model="sprintDraft.endDate" type="date" />
          </div>
        </div>
      </section>

      <section v-if="selectedSprint" class="workbench-card planning-sprint-staffing">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Staffing</p>
            <h3 class="workbench-card__title">Capacity plan</h3>
          </div>
          <button class="secondary-button secondary-button--compact" type="button" :disabled="saving" @click="saveStaffing">
            Save staffing
          </button>
        </div>

        <table class="planning-table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Project allocation</th>
              <th>Sprint hours</th>
              <th>Allocation override</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in staffingDraft" :key="row.userId">
              <td>{{ row.name }}</td>
              <td>{{ row.defaultAllocation ?? 'n/a' }}</td>
              <td><input v-model.number="row.capacityHours" min="0" step="1" type="number" /></td>
              <td><input v-model.number="row.allocationPctOverride" max="100" min="0" step="1" type="number" /></td>
              <td><input v-model="row.notes" /></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-else class="workbench-card">
        <div class="empty-state">
          <p class="card-eyebrow">Sprint Workspace</p>
          <h3>Create the first sprint</h3>
          <p class="muted-copy">Start by creating a sprint, then staff it and pull work from the backlog.</p>
          <button class="primary-button" type="button" :disabled="saving" @click="createSprint">Create sprint</button>
        </div>
      </section>
    </section>

    <aside class="workbench-pane workbench-pane--context">
      <div class="card mb-3">
        <div class="card-body pb-2">
          <h5 class="mb-0">Sprint Snapshot</h5>
        </div>
        <ul class="list-group list-group-flush">
          <li class="list-group-item d-flex justify-content-between">
            Status
            <strong>{{ selectedSprint?.status ?? 'none' }}</strong>
          </li>
          <li class="list-group-item d-flex justify-content-between">
            Items
            <strong>{{ sprintHealth.totalItems }}</strong>
          </li>
          <li class="list-group-item d-flex justify-content-between">
            Points
            <strong>{{ sprintHealth.totalPoints }}</strong>
          </li>
          <li class="list-group-item d-flex justify-content-between">
            Planned hours
            <strong>{{ sprintHealth.totalHours }}</strong>
          </li>
          <li class="list-group-item d-flex justify-content-between">
            Capacity hours
            <strong>{{ sprintHealth.capacityHours }}</strong>
          </li>
          <li class="list-group-item d-flex justify-content-between">
            Remaining
            <strong :class="{ 'text-danger': sprintHealth.isOverCapacity, 'text-warning': sprintHealth.isUnderstaffed }">
              {{ sprintHealth.remainingHours }}
            </strong>
          </li>
        </ul>
      </div>

      <div class="card mb-3">
        <div class="card-body">
          <h5 class="mb-3">Signals</h5>
          <p class="planning-signal" :class="{ 'planning-signal--warning': sprintHealth.isOverCapacity }">
            {{ sprintHealth.isOverCapacity ? 'Sprint is over capacity.' : 'Capacity is within plan.' }}
          </p>
          <p class="planning-signal" :class="{ 'planning-signal--warning': sprintHealth.isUnderstaffed }">
            {{ sprintHealth.isUnderstaffed ? 'Sprint has work but no staffing capacity.' : 'Staffing is defined.' }}
          </p>
          <p class="muted-copy">Backlog: {{ planning.backlog?.summary?.totalItems ?? 0 }} items, {{ planning.backlog?.summary?.totalHours ?? 0 }}h</p>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <h5 class="mb-3">Actions</h5>
          <button class="btn btn-outline-primary w-100 mb-2" type="button" :disabled="loading" @click="loadPlanning()">
            Refresh planner
          </button>
          <button class="btn btn-primary w-100" type="button" :disabled="saving" @click="createSprint">
            New Sprint
          </button>
        </div>
      </div>
    </aside>

    <ProjectSplitStoryModal
      :open="splitStoryOpen"
      :project-id="projectId"
      :sprints="planning.sprints"
      :story="splitStoryTarget"
      :token="token"
      @close="splitStoryOpen = false"
      @split="handleSplitResult"
    />
    <ProjectLiveUpdateNotice
      :busy="saving"
      :conflicts="liveConflicts"
      message="This sprint was updated while you were editing it."
      :visible="Boolean(liveConflict)"
      @discard="discardLiveEdits"
      @merge="applyLiveMerge"
    />
  </div>
</template>
