<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Sortable from 'sortablejs';

import {
  buildTreeMetrics,
  createProjectSelection,
} from '../../lib/projects/project-editor.js';
import { summarizeWorkProgress } from '../../lib/projects/work-progress.js';
import WorkProgressBar from './WorkProgressBar.vue';

const props = defineProps({
  activeSelection: {
    default: () => ({ type: 'project' }),
    type: Object,
  },
  collapsedNodes: {
    default: () => ({}),
    type: Object,
  },
  dismissible: {
    default: false,
    type: Boolean,
  },
  drawerOpen: {
    default: false,
    type: Boolean,
  },
  filterQuery: {
    default: '',
    type: String,
  },
  resourceFilters: {
    default: () => [],
    type: Array,
  },
  statusFilters: {
    default: () => [],
    type: Array,
  },
  validUsers: {
    default: () => [],
    type: Array,
  },
  project: {
    default: null,
    type: Object,
  },
});

const emit = defineEmits([
  'add-epic',
  'add-story',
  'add-task',
  'collapse-all',
  'close',
  'expand-all',
  'select',
  'toggle-collapse',
  'update:resource-filters',
  'update:filter-query',
  'update:status-filters',
]);

const outlinePaneRef = ref(null);
const outlineTreeScrollRef = ref(null);
const epicTreeRef = ref(null);
let epicSortable = null;
const storySortables = new Map();
const TOUCH_REORDER_DELAY_MS = 220;
const FILTER_COMPACT_SCROLL_TOP = 36;
const touchReorderOptions = {
  delay: TOUCH_REORDER_DELAY_MS,
  delayOnTouchOnly: true,
  fallbackTolerance: 8,
  touchStartThreshold: 6,
};
const outlineTreeScrolled = ref(false);
const filtersExpandedDuringScroll = ref(false);

const canDrag = computed(() => {
  const query = String(props.filterQuery ?? '').trim();
  const statuses = Array.isArray(props.statusFilters) ? props.statusFilters : [];
  const resources = Array.isArray(props.resourceFilters) ? props.resourceFilters : [];

  // Drag/drop on a filtered projection would produce ambiguous ordering.
  return Boolean(props.project && query.length === 0 && statuses.length === 0 && resources.length === 0);
});

function destroyDragAndDrop() {
  if (epicSortable) {
    epicSortable.destroy();
    epicSortable = null;
  }

  for (const sortable of storySortables.values()) {
    sortable.destroy();
  }
  storySortables.clear();
}

function reorderEpicsByDom() {
  if (!props.project?.epics || !epicSortable) {
    return;
  }

  const ids = epicSortable.toArray();
  if (ids.length === 0) {
    return;
  }

  const current = props.project.epics;
  const byId = new Map(current.map((epic) => [String(epic.id), epic]));
  const next = ids.map((id) => byId.get(String(id))).filter(Boolean);

  for (const epic of current) {
    if (!ids.includes(String(epic.id))) {
      next.push(epic);
    }
  }

  current.splice(0, current.length, ...next);
}

function moveStoryByEvent(event) {
  const storyId = String(event?.item?.getAttribute('data-story-id') ?? '').trim();
  const sourceEpicId = String(event?.from?.getAttribute('data-epic-id') ?? '').trim();
  const targetEpicId = String(event?.to?.getAttribute('data-epic-id') ?? '').trim();

  if (!storyId || !sourceEpicId || !targetEpicId || !props.project?.epics) {
    return;
  }

  const sourceEpic = props.project.epics.find((epic) => epic.id === sourceEpicId);
  const targetEpic = props.project.epics.find((epic) => epic.id === targetEpicId);

  if (!sourceEpic || !targetEpic) {
    return;
  }

  sourceEpic.stories = Array.isArray(sourceEpic.stories) ? sourceEpic.stories : [];
  targetEpic.stories = Array.isArray(targetEpic.stories) ? targetEpic.stories : [];

  const storyIndex = sourceEpic.stories.findIndex((story) => story.id === storyId);
  if (storyIndex < 0) {
    return;
  }

  const [story] = sourceEpic.stories.splice(storyIndex, 1);
  const insertIndex = Number.isFinite(event?.newIndex) ? event.newIndex : targetEpic.stories.length;
  const boundedIndex = Math.max(0, Math.min(insertIndex, targetEpic.stories.length));

  targetEpic.stories.splice(boundedIndex, 0, story);
}

function syncStorySortables() {
  const root = epicTreeRef.value;
  if (!root || !props.project) {
    return;
  }

  if (!canDrag.value) {
    return;
  }

  const containers = Array.from(root.querySelectorAll('[data-story-list="true"][data-epic-id]'));
  const liveKeys = new Set();

  for (const container of containers) {
    const epicId = String(container.getAttribute('data-epic-id') ?? '').trim();
    if (!epicId) continue;

    liveKeys.add(epicId);

    if (storySortables.has(epicId)) {
      continue;
    }

    const sortable = Sortable.create(container, {
      animation: 150,
      ...touchReorderOptions,
      dataIdAttr: 'data-story-id',
      draggable: 'article.outline-branch--child[data-story-id]',
      group: 'odinpmp-stories',
      handle: '.outline-row--story',
      onEnd: (event) => {
        moveStoryByEvent(event);
      },
    });

    storySortables.set(epicId, sortable);
  }

  for (const [epicId, sortable] of storySortables.entries()) {
    if (!liveKeys.has(epicId)) {
      sortable.destroy();
      storySortables.delete(epicId);
    }
  }
}

function syncEpicSortable() {
  if (!epicTreeRef.value || !props.project) {
    return;
  }

  if (!canDrag.value) {
    destroyDragAndDrop();
    return;
  }

  if (!epicSortable) {
    epicSortable = Sortable.create(epicTreeRef.value, {
      animation: 150,
      ...touchReorderOptions,
      dataIdAttr: 'data-epic-id',
      draggable: 'article.outline-branch[data-epic-id]',
      handle: '.outline-row',
      onEnd: () => {
        reorderEpicsByDom();
      },
    });
  }
}

async function syncDragAndDrop() {
  await nextTick();
  syncEpicSortable();
  syncStorySortables();
}

async function scrollActiveRowIntoView() {
  if (!props.dismissible || !props.drawerOpen) {
    return;
  }

  await nextTick();
  const activeRow = outlinePaneRef.value?.querySelector('.outline-row--active');
  activeRow?.scrollIntoView?.({
    block: 'nearest',
  });
}

onMounted(() => {
  syncDragAndDrop();
  scrollActiveRowIntoView();
});

watch(
  () => [canDrag.value, props.project?.id ?? '', Object.keys(props.collapsedNodes ?? {}).join('|')],
  () => {
    syncDragAndDrop();
  },
  { flush: 'post' },
);

watch(
  () => [props.drawerOpen, JSON.stringify(props.activeSelection ?? {})],
  () => {
    scrollActiveRowIntoView();
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  destroyDragAndDrop();
});

function matchesFilters(node, query, statusFilters, resourceFilters) {
  const normalizedQuery = String(query ?? '').trim().toLowerCase();

  const queryMatches = !normalizedQuery
    ? true
    : [
        node?.name,
        node?.description,
        node?.status,
        node?.assigneeName,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));

  if (!queryMatches) {
    return false;
  }

  const statuses = Array.isArray(statusFilters) ? statusFilters : [];
  if (statuses.length > 0 && !statuses.includes(node?.status)) {
    return false;
  }

  const resources = Array.isArray(resourceFilters) ? resourceFilters : [];
  if (resources.length > 0) {
    const assigneeId = node?.assigneeId ?? null;
    if (!assigneeId || !resources.includes(assigneeId)) {
      return false;
    }
  }

  return true;
}

function filterTreeWithFilters(project, query, statusFilters, resourceFilters) {
  if (!project) {
    return [];
  }

  return (project.epics ?? []).reduce((epics, epic) => {
    if (matchesFilters(epic, query, statusFilters, resourceFilters)) {
      epics.push(epic);
      return epics;
    }

    const stories = (epic.stories ?? []).reduce((storyMatches, story) => {
      if (matchesFilters(story, query, statusFilters, resourceFilters)) {
        storyMatches.push(story);
        return storyMatches;
      }

      const tasks = (story.tasks ?? []).filter((task) => matchesFilters(task, query, statusFilters, resourceFilters));

      if (tasks.length > 0) {
        storyMatches.push({
          ...story,
          tasks,
        });
      }

      return storyMatches;
    }, []);

    if (stories.length > 0) {
      epics.push({
        ...epic,
        stories,
      });
    }

    return epics;
  }, []);
}

const visibleEpics = computed(() => filterTreeWithFilters(
  props.project,
  props.filterQuery,
  props.statusFilters,
  props.resourceFilters,
));
const projectMetrics = computed(() => buildTreeMetrics('project', props.project));
// Keyed by id from the full project, so filtering the tree never changes an item's progress.
const progressByNodeId = computed(() => {
  const entries = new Map();
  for (const epic of props.project?.epics ?? []) {
    entries.set(epic.id, summarizeWorkProgress('epic', epic));
    for (const story of epic.stories ?? []) {
      entries.set(story.id, summarizeWorkProgress('story', story));
    }
  }
  return entries;
});
const statusFilterOptions = ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed'];
const resourceFilterOptions = computed(() => props.validUsers ?? []);
const projectSummaryChips = computed(() => [
  `${projectMetrics.value.storyCount} stories`,
  `${projectMetrics.value.taskCount} tasks`,
  `${projectMetrics.value.completedPercent}% complete`,
]);
const activeFilterCount = computed(() => {
  const queryCount = String(props.filterQuery ?? '').trim() ? 1 : 0;
  return queryCount + (props.statusFilters?.length ?? 0) + (props.resourceFilters?.length ?? 0);
});
const filtersAreCompact = computed(() => (
  !props.dismissible
  && outlineTreeScrolled.value
  && !filtersExpandedDuringScroll.value
));
const compactFilterSummary = computed(() => {
  if (activeFilterCount.value === 0) {
    return 'No active filters';
  }

  return `${activeFilterCount.value} active`;
});

function collapseKey(type, ids) {
  return [type, ...ids].join(':');
}

function isCollapsed(type, ids) {
  return Boolean(props.collapsedNodes[collapseKey(type, ids)]);
}

function isSelected(selection) {
  const left = createProjectSelection(selection);
  const right = createProjectSelection(props.activeSelection);
  return JSON.stringify(left) === JSON.stringify(right);
}

function progressFor(type, node) {
  return progressByNodeId.value.get(node?.id) ?? summarizeWorkProgress(type, node);
}

function pointsLabel(value) {
  if (value === '' || value == null) {
    return '-';
  }

  return value;
}

function hoursLabel(value) {
  if (value === '' || value == null || Number.isNaN(Number(value))) {
    return '-';
  }

  return `${Number(value)}h`;
}

// An epic's points are its stories' total unless someone set them by hand.
function epicMeta(epic) {
  return `Status: ${epic?.status ?? 'Not Started'} | Total Points: ${pointsLabel(epic?.points)}`;
}

function storyMeta(story) {
  return `Status: ${story?.status ?? 'Not Started'} | Assignee: ${story?.assigneeName || 'Unassigned'} | Points: ${pointsLabel(story?.points)} | Hours: ${hoursLabel(story?.targetHourEstimate)}`;
}

function taskMeta(task) {
  return `Status: ${task?.status ?? 'Not Started'} | Assignee: ${task?.assigneeName || 'Unassigned'} | Points: ${pointsLabel(task?.points)} | Hours: ${hoursLabel(task?.targetHourEstimate)}`;
}

function updateFilter(event) {
  emit('update:filter-query', event.target.value);
}

function selectStatusFilter(event) {
  const status = String(event.target.value ?? '').trim();

  if (status) {
    toggleStatusFilter(status);
  }

  event.target.value = '';
}

function selectResourceFilter(event) {
  const resourceId = String(event.target.value ?? '').trim();

  if (resourceId) {
    toggleResourceFilter(resourceId);
  }

  event.target.value = '';
}

function toggleStatusFilter(status) {
  const current = new Set(props.statusFilters ?? []);

  if (current.has(status)) {
    current.delete(status);
  } else {
    current.add(status);
  }

  emit('update:status-filters', Array.from(current));
}

function toggleResourceFilter(resourceId) {
  const current = new Set(props.resourceFilters ?? []);

  if (current.has(resourceId)) {
    current.delete(resourceId);
  } else {
    current.add(resourceId);
  }

  emit('update:resource-filters', Array.from(current));
}

function clearFilters() {
  emit('update:filter-query', '');
  emit('update:status-filters', []);
  emit('update:resource-filters', []);
}

function handleOutlineTreeScroll(event) {
  const scrolled = Number(event?.currentTarget?.scrollTop ?? 0) > FILTER_COMPACT_SCROLL_TOP;
  outlineTreeScrolled.value = scrolled;

  if (!scrolled) {
    filtersExpandedDuringScroll.value = false;
  }
}

function expandFiltersDuringScroll() {
  filtersExpandedDuringScroll.value = true;
}

function collapseFiltersDuringScroll() {
  filtersExpandedDuringScroll.value = false;
}
</script>

<template>
  <aside
    ref="outlinePaneRef"
    class="workbench-pane workbench-pane--outline"
    :class="{
      'workbench-pane--outline-drawer': dismissible,
      'workbench-pane--outline-drawer--open': dismissible && drawerOpen,
    }"
  >
    <div class="outline-card" :class="{ 'outline-card--drawer-shell': dismissible }">
      <div class="outline-card__header" :class="{ 'outline-card__header--drawer': dismissible }">
        <div class="outline-pane__title-block">
          <p class="card-eyebrow">{{ dismissible ? 'Project structure' : 'Project Outline' }}</p>
          <h3 class="panel-title">{{ dismissible ? 'Structure navigator' : (project?.name ?? '') }}</h3>
          <p v-if="dismissible" class="outline-pane__project-name">{{ project?.name ?? '' }}</p>
        </div>
        <button
          v-if="dismissible"
          class="outline-pane__close"
          type="button"
          aria-label="Close outline"
          @click="$emit('close')"
        >
          <i class="bi bi-x-lg" aria-hidden="true"></i>
          <span class="visually-hidden">Close</span>
        </button>
      </div>

      <div v-if="dismissible" class="outline-pane__summary">
        <span
          v-for="chip in projectSummaryChips"
          :key="chip"
          class="outline-pane__summary-chip"
        >
          {{ chip }}
        </span>
      </div>

      <div v-else class="outline-card__meta">
        <span>{{ projectMetrics.storyCount }} stories</span>
        <span>{{ projectMetrics.taskCount }} tasks</span>
        <span>{{ projectMetrics.completedPercent }}% done</span>
      </div>

      <WorkProgressBar
        v-if="!dismissible"
        label="Project progress"
        :progress="projectMetrics.progress"
      />
    </div>

    <div class="outline-card outline-card--controls" :class="{ 'outline-card--drawer-panel': dismissible }">
      <div class="outline-filter-stack" :class="{ 'outline-filter-stack--compact': filtersAreCompact }">
      <div class="outline-filter outline-filter--compact" :aria-hidden="filtersAreCompact ? 'false' : 'true'" :inert="!filtersAreCompact">
        <div class="outline-filter__compact-row">
          <button
            class="outline-filter__summary"
            type="button"
            :aria-label="`Expand filters, ${compactFilterSummary}`"
            @click="expandFiltersDuringScroll"
          >
            <span>
              <span class="outline-filter__summary-label">Filter tree</span>
              <span class="outline-filter__summary-meta">{{ compactFilterSummary }}</span>
            </span>
            <i class="bi bi-sliders" aria-hidden="true"></i>
          </button>
          <button class="primary-button secondary-button--compact outline-filter__new" type="button" @click="$emit('add-epic')">
            + New Epic
          </button>
        </div>
      </div>

      <div class="outline-filter outline-filter--full" :aria-hidden="filtersAreCompact ? 'true' : 'false'" :inert="filtersAreCompact">
        <div class="outline-filter__header">
          <label for="project-outline-filter">Filter tree</label>
          <div class="outline-filter__header-actions">
            <button
              v-if="outlineTreeScrolled && !dismissible"
              class="outline-filter__clear"
              type="button"
              @click="collapseFiltersDuringScroll"
            >
              Collapse
            </button>
            <button
              class="outline-filter__clear"
              type="button"
              :disabled="activeFilterCount === 0"
              @click="clearFilters"
            >
              Clear
            </button>
          </div>
        </div>

        <div class="outline-filter__search-row">
          <div class="outline-filter__search">
            <input
              id="project-outline-filter"
              :value="filterQuery"
              autocomplete="off"
              placeholder="Filter items..."
              @input="updateFilter"
            />
            <span v-if="activeFilterCount > 0" class="outline-filter__count">{{ activeFilterCount }}</span>
          </div>
          <button class="primary-button secondary-button--compact outline-filter__new" type="button" @click="$emit('add-epic')">
            + New Epic
          </button>
        </div>

        <div class="outline-filter__select-row">
          <select class="outline-filter__select" aria-label="Status filter" value="" @change="selectStatusFilter">
            <option value="">Status...</option>
            <option
              v-for="status in statusFilterOptions"
              :key="status"
              :disabled="statusFilters.includes(status)"
              :value="status"
            >
              {{ status }}
            </option>
          </select>

          <select class="outline-filter__select" aria-label="Resource filter" value="" @change="selectResourceFilter">
            <option value="">Resource...</option>
            <option
              v-for="user in resourceFilterOptions"
              :key="user.id"
              :disabled="resourceFilters.includes(user.id)"
              :value="user.id"
            >
              {{ user.name }}
            </option>
          </select>
        </div>

        <div v-if="statusFilters.length || resourceFilters.length" class="outline-filter__active">
          <button
            v-for="status in statusFilters"
            :key="`status-${status}`"
            class="outline-filter__tag"
            type="button"
            @click="toggleStatusFilter(status)"
          >
            {{ status }} x
          </button>
          <button
            v-for="resourceId in resourceFilters"
            :key="`resource-${resourceId}`"
            class="outline-filter__tag"
            type="button"
            @click="toggleResourceFilter(resourceId)"
          >
            {{ resourceFilterOptions.find((user) => user.id === resourceId)?.name ?? 'Resource' }} x
          </button>
        </div>
      </div>
      </div>
    </div>

    <div ref="outlineTreeScrollRef" class="outline-tree-scroll" @scroll="handleOutlineTreeScroll">
      <div class="outline-project-overview outline-row--project-sticky">
        <button
          class="outline-row outline-row--project"
          :class="{ 'outline-row--active': isSelected({ type: 'project' }) }"
          type="button"
          @click="$emit('select', { type: 'project' })"
        >
          <span class="outline-row__title">Project overview</span>
          <span class="outline-row__meta">{{ project?.status }}</span>
        </button>
        <div class="outline-project-overview__actions" aria-label="Outline display controls">
          <button
            class="outline-project-overview__action"
            type="button"
            title="Expand all"
            aria-label="Expand all"
            @click="$emit('expand-all')"
          >
            <i class="bi bi-arrows-expand" aria-hidden="true"></i>
          </button>
          <button
            class="outline-project-overview__action"
            type="button"
            title="Collapse all"
            aria-label="Collapse all"
            @click="$emit('collapse-all')"
          >
            <i class="bi bi-arrows-collapse" aria-hidden="true"></i>
          </button>
        </div>
      </div>

      <div ref="epicTreeRef" class="outline-tree">
        <article v-for="epic in visibleEpics" :key="epic.id" class="outline-branch" :data-epic-id="epic.id">
          <div class="outline-row-wrap">
            <span class="outline-drag-handle outline-drag-handle--epic" aria-hidden="true">
              <i class="bi bi-grip-vertical"></i>
            </span>
            <button
              class="outline-toggle"
              type="button"
              :aria-label="isCollapsed('epic', [epic.id]) ? 'Expand epic' : 'Collapse epic'"
              @click="$emit('toggle-collapse', { type: 'epic', ids: [epic.id] })"
            >
              {{ isCollapsed('epic', [epic.id]) ? '+' : '−' }}
            </button>
            <button
              class="outline-row"
              :class="{ 'outline-row--active': isSelected({ type: 'epic', epicId: epic.id }) }"
              type="button"
              @click="$emit('select', { type: 'epic', epicId: epic.id })"
            >
              <span class="outline-row__title">
                <span class="outline-row__title-text">{{ epic.name }}</span>
                <i v-if="epic.aiGenerated && epic.aiAccepted !== true" class="bi bi-stars outline-ai-indicator" aria-hidden="true"></i>
              </span>
              <span class="outline-row__detail">{{ epicMeta(epic) }}</span>
            </button>
            <button
              class="ghost-button ghost-button--compact"
              type="button"
              title="Add story"
              @click="$emit('add-story', epic.id)"
            >
              + Story
            </button>
          </div>

          <WorkProgressBar
            compact
            :label="`${epic.name} progress`"
            :progress="progressFor('epic', epic)"
          />

          <div v-if="!isCollapsed('epic', [epic.id])" class="outline-children" data-story-list="true" :data-epic-id="epic.id">
            <article v-for="story in epic.stories" :key="story.id" class="outline-branch outline-branch--child" :data-story-id="story.id">
              <div class="outline-row-wrap">
                <span class="outline-drag-handle outline-drag-handle--story" aria-hidden="true">
                  <i class="bi bi-grip-vertical"></i>
                </span>
                <button
                  class="outline-toggle"
                  type="button"
                  :aria-label="isCollapsed('story', [epic.id, story.id]) ? 'Expand story' : 'Collapse story'"
                  @click="$emit('toggle-collapse', { type: 'story', ids: [epic.id, story.id] })"
                >
                  {{ isCollapsed('story', [epic.id, story.id]) ? '+' : '−' }}
                </button>
                <button
                  class="outline-row outline-row--story"
                  :class="{ 'outline-row--active': isSelected({ type: 'story', epicId: epic.id, storyId: story.id }) }"
                  type="button"
                  @click="$emit('select', { type: 'story', epicId: epic.id, storyId: story.id })"
                >
                  <span class="outline-row__title">
                    <span class="outline-row__title-text">{{ story.name }}</span>
                    <i v-if="story.aiGenerated && story.aiAccepted !== true" class="bi bi-stars outline-ai-indicator" aria-hidden="true"></i>
                  </span>
                  <span class="outline-row__detail">{{ storyMeta(story) }}</span>
                </button>
                <button
                  class="ghost-button ghost-button--compact"
                  type="button"
                  title="Add task"
                  @click="$emit('add-task', { epicId: epic.id, storyId: story.id })"
                >
                  + Task
                </button>
              </div>

              <WorkProgressBar
                compact
                :label="`${story.name} progress`"
                :progress="progressFor('story', story)"
              />

              <div v-if="!isCollapsed('story', [epic.id, story.id])" class="outline-children">
                <button
                  v-for="task in story.tasks"
                  :key="task.id"
                  class="outline-row outline-row--task"
                  :class="{ 'outline-row--active': isSelected({ type: 'task', epicId: epic.id, storyId: story.id, taskId: task.id }) }"
                  type="button"
                  @click="$emit('select', { type: 'task', epicId: epic.id, storyId: story.id, taskId: task.id })"
                >
                  <span class="outline-row__title">
                    <span class="outline-row__title-text">{{ task.name }}</span>
                    <i v-if="task.aiGenerated && task.aiAccepted !== true" class="bi bi-stars outline-ai-indicator" aria-hidden="true"></i>
                  </span>
                  <span class="outline-row__detail">{{ taskMeta(task) }}</span>
                </button>
              </div>
            </article>
          </div>
        </article>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.outline-pane__title-block {
  min-width: 0;
}

.outline-pane__project-name {
  margin: 0.3rem 0 0;
  color: var(--muted);
  font-size: 0.84rem;
  font-weight: 600;
  line-height: 1.45;
}

.outline-pane__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.8rem;
}

.outline-pane__summary-chip {
  display: inline-flex;
  align-items: center;
  min-height: 1.9rem;
  padding: 0.32rem 0.62rem;
  border-radius: 999px;
  background: rgba(37, 99, 235, 0.08);
  color: #34507a;
  font-size: 0.74rem;
  font-weight: 700;
}

.outline-pane__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.2rem;
  height: 2.2rem;
  padding: 0;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.05);
  color: var(--ink);
  font-size: 0.95rem;
  font-weight: 700;
}

.outline-pane__close:hover {
  border-color: rgba(27, 74, 158, 0.2);
  background: rgba(37, 99, 235, 0.08);
  color: var(--accent-dark);
}

@media (max-width: 1280px) {
  .workbench-pane--outline-drawer {
    position: fixed;
    top: 5rem;
    left: 0;
    bottom: 0;
    z-index: 70;
    width: min(25rem, calc(100vw - 1.25rem));
    padding: 1rem 1rem 1.15rem;
    background: rgba(251, 253, 255, 0.975);
    box-shadow: 18px 0 44px rgba(15, 23, 42, 0.08);
    overflow-y: auto;
    overscroll-behavior: contain;
    pointer-events: none;
    visibility: hidden;
    opacity: 0;
    transform: translateX(-110%);
    transition: transform 180ms ease, opacity 180ms ease;
  }

  .workbench-pane--outline-drawer .outline-card {
    border: 0;
    border-radius: 0;
    padding: 0;
    background: transparent;
  }

  .outline-card--drawer-shell {
    padding-bottom: 0.95rem;
    border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  }

  .outline-card__header--drawer {
    gap: 0.9rem;
  }

  .outline-card__header--drawer .panel-title {
    white-space: normal;
  }

  .outline-card--drawer-panel {
    padding-top: 0.95rem;
  }

  .workbench-pane--outline-drawer--open {
    pointer-events: auto;
    visibility: visible;
    opacity: 1;
    transform: translateX(0);
  }
}

html.dark .workbench-pane--outline-drawer {
  background: rgba(8, 17, 29, 0.96);
}

html.dark .outline-pane__summary-chip {
  background: rgba(59, 130, 246, 0.18);
  color: #d9e7ff;
}

html.dark .outline-pane__close {
  background: rgba(15, 23, 42, 0.86);
  color: var(--ink);
}

html.dark .outline-card--drawer-shell {
  border-bottom-color: rgba(148, 163, 184, 0.16);
}
</style>
