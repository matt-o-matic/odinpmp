<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Sortable from 'sortablejs';

import { isWorkingCancellation } from '../../lib/api/activity-tracker.js';
import { createSerialQueue } from '../../lib/async/serial-queue.js';
import { apiClient } from '../../lib/auth/index.js';
import { useOverlayScrollLock } from '../../lib/ui/overlay-scroll-lock.js';
import { cloneProject, resolveProjectSelection } from '../../lib/projects/project-editor.js';
import { kanbanCardStatusOptions } from '../../lib/projects/kanban-card-create.js';
import { pursuitCardDue } from '../../lib/pursuit/pursuit.js';
import {
  applyKanbanPreset,
  createKanbanColumnDraft,
  createKanbanConfigPayload,
  createKanbanPreset,
  hydrateKanbanConfig,
  kanbanStatusOwners,
  renameKanbanColumn,
  reorderKanbanColumns,
  setKanbanColumnKey,
} from '../../lib/projects/project-kanban-config.js';
import { buildKanbanMovePatch, moveKanbanCard, resolveKanbanDropAnchors } from '../../lib/projects/kanban-placement.js';
import { createKanbanDrawerState, toggleKanbanDrawer } from '../../lib/projects/project-kanban-shell.js';
import {
  buildKanbanLanes,
  buildPlanningSelection,
  createDefaultKanbanConfig,
} from '../../lib/projects/project-planning.js';
import ProjectKanbanCardCreateModal from './ProjectKanbanCardCreateModal.vue';

const props = defineProps({
  // False hides New card for people who can't add work; the server refuses it anyway.
  canEdit: {
    default: true,
    type: Boolean,
  },
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
  // 'pursuit' shows the pursuit board: the engagement's tasks as a flat list, with no sprints
  // or stories (docs/engagements/plan.md). Empty is the project's own board.
  scope: {
    default: '',
    type: String,
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
    default: () => [],
    type: Array,
  },
});

const emit = defineEmits(['edit-item', 'error', 'message', 'project-updated']);

const pursuitBoard = computed(() => props.scope === 'pursuit');
const scopeOption = computed(() => (props.scope ? { scope: props.scope } : {}));

const loading = ref(false);
// Board writes run one at a time through this queue. Each drop updates the board right
// away and queues its save, so the user can keep moving cards while earlier saves finish.
const pendingOperations = ref(0);
const saving = computed(() => pendingOperations.value > 0);
const operationQueue = createSerialQueue({
  onChange: ({ busy, size }) => {
    pendingOperations.value = size;
    if (!busy) {
      flushDeferredRefresh();
    }
  },
});
const presetName = ref('');
const drawerState = ref(createKanbanDrawerState());
const configState = ref(hydrateKanbanConfig(createDefaultKanbanConfig(props.workStatusOptions), props.workStatusOptions));
const boardState = ref({
  cards: [],
  columns: [],
  members: [],
  sprints: [],
  swimlane: 'none',
});
const expandedColumnIds = ref(new Set());
const layoutListRef = ref(null);
// Without a hold delay, Sortable starts a drag on the slight finger movement of a tap,
// which swallows the click that opens a card on touch screens.
const TOUCH_REORDER_DELAY_MS = 220;
const touchReorderOptions = {
  delay: TOUCH_REORDER_DELAY_MS,
  delayOnTouchOnly: true,
  fallbackTolerance: 8,
  touchStartThreshold: 6,
};
let sortables = [];
let sortableContainers = [];
let layoutSortable = null;
// A live refresh mid-drag would re-render the columns out from under the cursor.
let dragging = false;
// Server reads that land while local changes are unsaved would undo them on screen, so
// refreshes wait until no drag or queued save is in progress.
let refreshPending = false;
// Bumped by every local change; a board read started before a change is out of date.
let localRevision = 0;
// Versions returned by queued item saves, so the next save of the same card does not send
// the version it had before the previous save.
const savedItemVersions = new Map();

const cardsWithSprintNames = computed(() => {
  const sprintById = new Map((boardState.value.sprints ?? []).map((sprint) => [sprint.id, sprint]));
  return (boardState.value.cards ?? []).map((card) => ({
    ...card,
    sprintName: sprintById.get(card.sprintId)?.name ?? '',
  }));
});

const boardLanes = computed(() => buildKanbanLanes(cardsWithSprintNames.value, configState.value.columns, configState.value.swimlane));

const boardSummary = computed(() => {
  const count = cardsWithSprintNames.value.length;
  if (pursuitBoard.value) {
    return `${count} ${count === 1 ? 'task' : 'tasks'}${configState.value.swimlane === 'assignee' ? ' | by assignee' : ''}`;
  }
  const parts = [`${count} cards`];

  if (configState.value.selectedSprintIds.length > 0) {
    parts.push(`${configState.value.selectedSprintIds.length} sprint${configState.value.selectedSprintIds.length === 1 ? '' : 's'}`);
  }

  parts.push(configState.value.includeBacklog ? 'backlog included' : 'backlog hidden');
  parts.push(`swimlane: ${configState.value.swimlane}`);

  if (configState.value.issueTypes.length > 0) {
    parts.push(configState.value.issueTypes.join(' + '));
  }

  return parts.join(' | ');
});
const statusOwners = computed(() => kanbanStatusOwners(configState.value.columns));
const cardStatusOptions = computed(() => kanbanCardStatusOptions(props.workStatusOptions, configState.value.columns));
const createCardState = ref({ errorMessage: '', open: false, saving: false });
const overlayScrollLocked = computed(() => drawerState.value.filtersOpen || drawerState.value.layoutOpen);

useOverlayScrollLock(overlayScrollLocked);

function destroySortables() {
  for (const sortable of sortables) {
    sortable.destroy();
  }

  sortables = [];
  sortableContainers = [];
}

// Sortable moves DOM nodes that Vue owns. Put the node back and let Vue re-render from
// state, so the virtual DOM never disagrees with the page.
function restoreSortableItem({ from, item, oldIndex }) {
  const siblings = [...from.children].filter((child) => child !== item);
  const reference = siblings[oldIndex];

  if (reference) {
    from.insertBefore(item, reference);
  } else if (siblings.length > 0) {
    siblings[siblings.length - 1].after(item);
  } else {
    from.appendChild(item);
  }
}

async function syncSortables() {
  await nextTick();

  const cardContainers = Array.from(document.querySelectorAll('.kanban-column__cards[data-column-key]'));
  const columnContainers = Array.from(document.querySelectorAll('.kanban-lane__columns'));
  const containers = [...cardContainers, ...columnContainers];
  // Rebuilding the drag handlers while a card moves would drop the next drag, so keep them
  // whenever the lanes and columns on screen are the same elements as before.
  if (dragging || (containers.length === sortableContainers.length && containers.every((element, index) => element === sortableContainers[index]))) {
    return;
  }

  destroySortables();
  sortableContainers = containers;

  for (const container of cardContainers) {
    sortables.push(Sortable.create(container, {
      animation: 150,
      dataIdAttr: 'data-card-id',
      draggable: '.kanban-card',
      group: 'odinpmp-kanban-board',
      ...touchReorderOptions,
      handle: '.kanban-card__title',
      onEnd: (event) => {
        try {
          handleBoardMove(event);
        } finally {
          finishDrag();
        }
      },
      onStart: beginDrag,
    }));
  }

  for (const container of columnContainers) {
    sortables.push(Sortable.create(container, {
      animation: 150,
      draggable: '.kanban-column',
      ...touchReorderOptions,
      handle: '.kanban-column__header',
      onEnd: (event) => {
        handleBoardColumnMove(event).finally(finishDrag);
      },
      onStart: beginDrag,
    }));
  }
}

function destroyLayoutSortable() {
  layoutSortable?.destroy();
  layoutSortable = null;
}

async function syncLayoutSortable() {
  await nextTick();
  destroyLayoutSortable();

  if (!drawerState.value.layoutOpen || !layoutListRef.value) {
    return;
  }

  layoutSortable = Sortable.create(layoutListRef.value, {
    animation: 150,
    draggable: '.planning-layout-card',
    handle: '.planning-layout-card__handle',
    onEnd: (event) => {
      restoreSortableItem(event);
      configState.value.columns = reorderKanbanColumns(configState.value.columns, event.oldIndex, event.newIndex);
    },
  });
}

function closeDrawers() {
  drawerState.value = createKanbanDrawerState();
}

function handleToggleDrawer(drawer) {
  drawerState.value = toggleKanbanDrawer(drawerState.value, drawer);
}

async function loadConfig() {
  if (!props.projectId || !props.token) {
    return;
  }

  const result = await apiClient.getProjectKanbanConfig(props.projectId, props.token, scopeOption.value);
  configState.value = hydrateKanbanConfig(result.config ?? {}, props.workStatusOptions);
}

function beginDrag() {
  dragging = true;
}

function finishDrag() {
  dragging = false;
  syncSortables();
  flushDeferredRefresh();
}

function boardIsSettling() {
  return dragging || operationQueue.busy;
}

function requestBackgroundRefresh() {
  if (boardIsSettling()) {
    refreshPending = true;
    return;
  }
  loadBoard({ background: true });
}

function flushDeferredRefresh() {
  if (refreshPending && !boardIsSettling()) {
    refreshPending = false;
    loadBoard({ background: true });
  }
}

async function loadBoard({ background = false } = {}) {
  if (!props.projectId || !props.token) {
    return;
  }

  loading.value = !background;
  const startedAtRevision = localRevision;
  const client = background ? apiClient.passive : apiClient;

  try {
    const result = await client.getProjectKanban(
      props.projectId,
      {
        assigneeIds: configState.value.assigneeIds,
        hideDone: configState.value.hideDone,
        includeBacklog: configState.value.includeBacklog,
        issueTypes: configState.value.issueTypes,
        search: configState.value.search,
        selectedSprintIds: configState.value.selectedSprintIds,
        statusValues: configState.value.statusValues,
      },
      props.token,
      scopeOption.value,
    );

    if (startedAtRevision !== localRevision || boardIsSettling()) {
      // Local changes happened while this read was in flight; read again once they settle.
      refreshPending = true;
      flushDeferredRefresh();
      return;
    }

    boardState.value = result.board;

    if ((configState.value.columns ?? []).length === 0) {
      configState.value = hydrateKanbanConfig({
        ...configState.value,
        columns: result.board.columns ?? createDefaultKanbanConfig(props.workStatusOptions).columns,
      }, props.workStatusOptions);
    }
    if (!configState.value.swimlane) {
      configState.value.swimlane = result.board.swimlane ?? 'none';
    }
  } catch (error) {
    emit('error', error.message ?? 'Unable to load the Kanban board.');
  } finally {
    loading.value = false;
    syncSortables();
  }
}

const DROPPED_BY_CANCEL = Symbol('dropped-by-cancel');

/**
 * Queues a board write. Card moves report progress through the board's saving line rather
 * than a page message, which would push the board down under the user's next drag.
 * Failures are reported but do not stop later writes, and the board
 * reloads from the server once the queue is empty. Cancelling from the working dialog
 * drops the writes that have not started.
 */
function queueBoardOperation(run, { failureMessage, successMessage } = {}) {
  localRevision += 1;
  // The queue reloads the board from the server once it is empty.
  refreshPending = true;

  return operationQueue.enqueue(async () => {
    try {
      return await run();
    } catch (error) {
      // Drop the rest before the queue moves on to the next write.
      if (isWorkingCancellation(error)) {
        operationQueue.clear(DROPPED_BY_CANCEL);
      }
      throw error;
    }
  })
    .then((result) => {
      if (successMessage) {
        emit('message', successMessage);
      }
      return result;
    })
    .catch((error) => {
      if (error === DROPPED_BY_CANCEL) {
        return null;
      }
      if (isWorkingCancellation(error)) {
        emit('error', 'Board changes cancelled. Reloading the board.');
      } else {
        emit('error', error.message ?? failureMessage ?? 'Unable to update the board.');
      }
      return null;
    });
}

watch(
  () => [props.projectId, props.token],
  async () => {
    await loadConfig();
    await loadBoard();
  },
  { immediate: true },
);

watch(
  () => props.refreshVersion,
  () => {
    requestBackgroundRefresh();
  },
);

watch(
  () => [configState.value.columns, configState.value.swimlane, boardState.value.cards],
  () => {
    syncSortables();
  },
  { deep: true },
);

watch(
  () => drawerState.value.layoutOpen,
  () => {
    syncLayoutSortable();
  },
);

onBeforeUnmount(() => {
  destroySortables();
  destroyLayoutSortable();
});

function toggleFilter(listKey, value) {
  const current = new Set(configState.value[listKey] ?? []);
  if (current.has(value)) {
    current.delete(value);
  } else {
    current.add(value);
  }

  configState.value[listKey] = [...current];
}

function toggleColumnStatus(column, status) {
  const current = new Set(column.statuses ?? []);
  if (current.has(status)) {
    current.delete(status);
  } else {
    current.add(status);
  }

  column.statuses = [...current];
  if (!column.statuses.includes(column.defaultStatus)) {
    column.defaultStatus = column.statuses[0] ?? props.workStatusOptions[0] ?? 'Not Started';
  }
}

function addColumn() {
  const column = createKanbanColumnDraft(props.workStatusOptions, configState.value.columns);
  configState.value.columns = [...configState.value.columns, column];
  expandedColumnIds.value = new Set([...expandedColumnIds.value, column.clientId]);
}

function duplicateColumn(index) {
  const source = configState.value.columns[index];
  if (!source) {
    return;
  }

  const draft = createKanbanColumnDraft(props.workStatusOptions, configState.value.columns);
  const columns = [...configState.value.columns];
  columns.splice(index + 1, 0, {
    ...draft,
    defaultStatus: source.defaultStatus,
    statuses: [...source.statuses],
  });
  configState.value.columns = renameKanbanColumn(columns, index + 1, `${source.name} (copy)`);
  expandedColumnIds.value = new Set([...expandedColumnIds.value, draft.clientId]);
}

function removeColumn(index) {
  if (configState.value.columns.length <= 1) {
    return;
  }

  configState.value.columns = configState.value.columns.filter((_, columnIndex) => columnIndex !== index);
}

function toggleColumnExpanded(column) {
  const next = new Set(expandedColumnIds.value);
  if (next.has(column.clientId)) {
    next.delete(column.clientId);
  } else {
    next.add(column.clientId);
  }
  expandedColumnIds.value = next;
}

function updateColumnName(index, name) {
  configState.value.columns = renameKanbanColumn(configState.value.columns, index, name);
}

function updateColumnKey(index, value) {
  configState.value.columns = setKanbanColumnKey(configState.value.columns, index, value);
}

function sharedStatusNote(column, status) {
  const others = (statusOwners.value.get(status) ?? []).filter((name) => name !== column.name);
  return others.length > 0 ? `also in ${others.join(', ')}` : '';
}

async function handleBoardColumnMove(event) {
  restoreSortableItem(event);

  if (event.oldIndex === event.newIndex) {
    return;
  }

  configState.value.columns = reorderKanbanColumns(configState.value.columns, event.oldIndex, event.newIndex);
  await saveBoardConfig('Column order saved.');
}

function saveBoardConfig(message = 'Board view saved.') {
  if (!props.projectId || !props.token) {
    return Promise.resolve(false);
  }

  return queueBoardOperation(async () => {
    // Build the payload when the save runs, so it includes every change queued before it.
    const revision = localRevision;
    const payload = createKanbanConfigPayload(configState.value, props.workStatusOptions);
    const result = await apiClient.saveProjectKanbanConfig(props.projectId, payload, props.token, scopeOption.value);
    if (revision === localRevision) {
      configState.value = hydrateKanbanConfig(result.config ?? payload, props.workStatusOptions);
    }
    return true;
  }, { failureMessage: 'Unable to save the board view.', successMessage: message }).then(Boolean);
}

function saveLayout() {
  // The layout already shows on the board; the save runs in the queue behind it.
  closeDrawers();
  saveBoardConfig('Board layout saved.');
}

async function applyFilters() {
  await loadBoard();
  closeDrawers();
}

async function savePreset() {
  const name = String(presetName.value ?? '').trim();
  if (!name) {
    emit('error', 'Enter a preset name first.');
    return;
  }

  const preset = createKanbanPreset(name, configState.value);
  if (!preset) {
    emit('error', 'Enter a preset name first.');
    return;
  }

  const presets = (configState.value.presets ?? []).filter((preset) => preset.name !== name);
  presets.push(preset);

  configState.value.presets = presets;
  await saveBoardConfig(`Preset "${name}" saved.`);
  presetName.value = '';
}

async function applyPreset(preset) {
  configState.value = applyKanbanPreset(configState.value, preset, props.workStatusOptions);
  await loadBoard();
  closeDrawers();
}

async function deletePreset(name) {
  configState.value.presets = (configState.value.presets ?? []).filter((preset) => preset.name !== name);
  await saveBoardConfig(`Preset "${name}" removed.`);
}

function handleBoardMove(event) {
  restoreSortableItem(event);

  if (!props.project || !props.projectId || !props.token) {
    return;
  }

  if (event.from === event.to && event.oldIndex === event.newIndex) {
    return;
  }

  const cardId = String(event?.item?.getAttribute('data-card-id') ?? '').trim();
  const columnKey = String(event?.to?.getAttribute('data-column-key') ?? '').trim();
  const laneKey = String(event?.to?.getAttribute('data-lane-key') ?? '').trim();
  const column = configState.value.columns.find((entry) => entry.key === columnKey);
  if (!cardId || !column) {
    return;
  }

  const card = cardsWithSprintNames.value.find((entry) => entry.id === cardId);
  if (!card) {
    return;
  }

  const cell = boardLanes.value
    .find((lane) => lane.key === laneKey)
    ?.columns.find((entry) => entry.key === columnKey);
  const anchors = resolveKanbanDropAnchors((cell?.cards ?? []).map((entry) => entry.id), cardId, event.newIndex);
  const columnChanged = String(event?.from?.getAttribute('data-column-key') ?? '').trim() !== columnKey;
  const movePatch = columnChanged ? buildKanbanMovePatch(card, column) : {};

  // Show the card in its new spot right away; the queue saves it in order.
  boardState.value = {
    ...boardState.value,
    cards: moveKanbanCard(boardState.value.cards ?? [], cardId, anchors, movePatch),
  };

  queueBoardOperation(async () => {
    if (columnChanged) {
      // Resolve the item when the save runs, so it sees results of earlier queued saves.
      const projectClone = cloneProject(props.project);
      const item = resolveProjectSelection(projectClone, buildPlanningSelection(projectClone, card)).item;
      // An unresolved card falls back to the project itself, which must never be patched here.
      if (!item || item.id !== card.id) {
        throw new Error('That card is no longer on this project.');
      }

      const expectedVersion = Math.max(Number(item.version ?? 1), savedItemVersions.get(item.id) ?? 0);
      const result = await apiClient.updateProjectItem(props.projectId, item.id, {
        expectedVersion,
        patch: movePatch,
      }, props.token);
      if (result.item?.version != null) {
        savedItemVersions.set(item.id, Number(result.item.version));
      }
      emit('project-updated', result.project);
    }

    await apiClient.reorderProjectKanbanItem(props.projectId, { itemId: cardId, ...anchors }, props.token, scopeOption.value);
  });
}

function changeCardSprint(card, sprintId) {
  if (!props.projectId || !props.token) {
    return;
  }

  boardState.value = {
    ...boardState.value,
    cards: (boardState.value.cards ?? []).map((entry) => (entry.id === card.id ? { ...entry, sprintId: sprintId || null } : entry)),
  };

  queueBoardOperation(async () => {
    const result = await apiClient.assignSprintItems(
      props.projectId,
      {
        assignments: [
          {
            itemId: card.id,
            itemType: card.issueType,
            sprintId: sprintId || null,
          },
        ],
      },
      props.token,
    );
    emit('project-updated', result.project);
  }, { failureMessage: 'Unable to change the sprint assignment.' });
}

// The card itself rides along for screens that open a card without the plan editor.
function openCard(card) {
  emit('edit-item', buildPlanningSelection(props.project, card), card);
}

function openCreateCard() {
  createCardState.value = { errorMessage: '', open: true, saving: false };
}

function closeCreateCard() {
  if (createCardState.value.saving) {
    return;
  }
  createCardState.value = { errorMessage: '', open: false, saving: false };
}

/**
 * Creates a card through the board's write queue, so it lands after any moves still saving.
 * Errors stay in the dialog, where the user can fix the form and try again.
 */
async function createCard(payload) {
  if (createCardState.value.saving || !props.projectId || !props.token) {
    return;
  }

  createCardState.value = { ...createCardState.value, errorMessage: '', saving: true };
  localRevision += 1;

  try {
    const result = await operationQueue.enqueue(() => apiClient.createProjectItem(props.projectId, payload, props.token));
    emit('project-updated', result.project);
    createCardState.value = { errorMessage: '', open: false, saving: false };

    const cardId = result.item?.id ?? payload.item.id;
    const name = payload.item.name;
    if (boardIsSettling()) {
      // Earlier saves are still running; the board reloads once they finish.
      refreshPending = true;
      emit('message', `"${name}" created in ${payload.item.status}.`);
      return;
    }

    await loadBoard({ background: true });
    const shown = (boardState.value.cards ?? []).some((card) => card.id === cardId);
    emit('message', shown
      ? `"${name}" created in ${payload.item.status}.`
      : `"${name}" created in ${payload.item.status}. The current board scope hides it.`);
  } catch (error) {
    createCardState.value = {
      ...createCardState.value,
      // A cancel elsewhere on the board also drops this create if it had not started yet.
      errorMessage: isWorkingCancellation(error) || error === DROPPED_BY_CANCEL
        ? 'Card creation cancelled.'
        : error.message ?? 'Unable to create the card.',
      saving: false,
    };
    requestBackgroundRefresh();
  }
}

</script>

<template>
  <div class="kanban-shell">
    <section class="workbench-card kanban-shell__board">
      <div class="workbench-card__header">
        <div>
          <p v-if="!pursuitBoard" class="card-eyebrow">Kanban</p>
          <h3 class="workbench-card__title">{{ pursuitBoard ? 'Tasks' : 'Execution board' }}</h3>
          <p class="panel-copy">{{ boardSummary }}</p>
        </div>
        <div class="actions-row kanban-shell__actions">
          <span v-if="saving" class="kanban-shell__saving" role="status">
            <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
            <span>Saving {{ pendingOperations }} {{ pendingOperations === 1 ? 'change' : 'changes' }}...</span>
          </span>
          <div class="btn-group action-dropdown" role="group" aria-label="Board view actions">
            <button class="secondary-button secondary-button--compact" type="button" @click="handleToggleDrawer('filters')">
              <i class="bi bi-funnel" aria-hidden="true"></i>
              <span>{{ drawerState.filtersOpen ? 'Close scope' : 'Board scope' }}</span>
            </button>
            <button
              class="secondary-button secondary-button--compact dropdown-toggle dropdown-toggle-split action-dropdown__toggle"
              type="button"
              data-bs-toggle="dropdown"
              aria-expanded="false"
              aria-label="More board view actions"
            ></button>
            <ul class="dropdown-menu dropdown-menu-end action-dropdown__menu">
              <li>
                <button class="dropdown-item action-dropdown__item" type="button" @click="handleToggleDrawer('layout')">
                  <i class="bi bi-columns-gap" aria-hidden="true"></i>
                  <span>{{ drawerState.layoutOpen ? 'Close layout' : 'Layout builder' }}</span>
                </button>
              </li>
              <li>
                <button class="dropdown-item action-dropdown__item" type="button" @click="saveBoardConfig()">
                  <i class="bi bi-save" aria-hidden="true"></i>
                  <span>Save board view</span>
                </button>
              </li>
            </ul>
          </div>
          <button v-if="canEdit" class="primary-button primary-button--compact" type="button" :disabled="loading" @click="openCreateCard">
            <i class="bi bi-plus-lg" aria-hidden="true"></i>
            <span>{{ pursuitBoard ? 'New task' : 'New card' }}</span>
          </button>
          <button class="ghost-button ghost-button--compact ghost-button--icon kanban-shell__refresh" type="button" aria-label="Refresh board" :disabled="loading" @click="loadBoard()">
            <i :class="loading ? 'bi bi-arrow-repeat' : 'bi bi-arrow-clockwise'" aria-hidden="true"></i>
          </button>
        </div>
      </div>

      <div v-if="loading" class="muted-copy">Loading board...</div>
      <div v-else class="kanban-board">
        <section v-for="lane in boardLanes" :key="lane.key" class="kanban-lane">
          <header class="kanban-lane__header">
            <h4>{{ lane.label }}</h4>
          </header>
          <div class="kanban-lane__columns" :style="{ gridTemplateColumns: `repeat(${Math.max(lane.columns.length, 1)}, minmax(18rem, 1fr))` }">
            <article v-for="column in lane.columns" :key="`${lane.key}-${column.key}`" class="kanban-column">
              <header class="kanban-column__header" title="Drag to reorder columns">
                <span class="kanban-column__title">
                  <i class="bi bi-grip-vertical kanban-column__grip" aria-hidden="true"></i>
                  <strong>{{ column.name }}</strong>
                </span>
                <small>{{ column.cards.length }} cards</small>
              </header>
              <div class="kanban-column__cards" :data-column-key="column.key" :data-lane-key="lane.key">
                <article v-for="card in column.cards" :key="card.id" class="kanban-card" :data-card-id="card.id">
                  <button class="kanban-card__title" type="button" @click="openCard(card)">
                    {{ card.name }}
                  </button>
                  <template v-if="pursuitBoard">
                    <p class="kanban-card__meta">
                      {{ card.assigneeName || 'Unassigned' }}<template v-if="pursuitCardDue(card)"> | Due {{ pursuitCardDue(card).label }}<strong v-if="pursuitCardDue(card).overdue" class="kanban-card__overdue"> · Overdue</strong></template>
                    </p>
                  </template>
                  <template v-else>
                    <p class="kanban-card__meta">{{ card.issueType }} | {{ card.parentName || card.epicName || 'Project' }}</p>
                    <p class="kanban-card__meta">{{ card.assigneeName || 'Unassigned' }} | {{ card.points ?? 'no' }} pts | {{ card.targetHourEstimate ?? 'no' }}h</p>
                  </template>
                  <div v-if="!pursuitBoard" class="kanban-card__controls">
                    <select :value="card.sprintId ?? ''" @change="changeCardSprint(card, $event.target.value)">
                      <option value="">Backlog</option>
                      <option v-for="sprint in boardState.sprints" :key="sprint.id" :value="sprint.id">{{ sprint.name }}</option>
                    </select>
                  </div>
                </article>
              </div>
            </article>
          </div>
        </section>
      </div>
    </section>

    <div
      v-if="drawerState.filtersOpen || drawerState.layoutOpen"
      class="kanban-drawer-backdrop"
      @click="closeDrawers"
    ></div>

    <aside v-if="drawerState.filtersOpen" class="kanban-drawer kanban-drawer--left" aria-label="Board scope drawer">
      <header class="kanban-drawer__header">
        <div>
          <p class="card-eyebrow">Kanban Filters</p>
          <h3 class="workbench-card__title">Board scope</h3>
        </div>
        <button class="kanban-drawer__close" type="button" aria-label="Close board scope" @click="closeDrawers">x</button>
      </header>

      <div class="kanban-drawer__body">
        <div class="field-group">
          <label>Search</label>
          <input v-model="configState.search" placeholder="Search board" />
        </div>

        <div class="field-group">
          <label>Swimlane</label>
          <select v-model="configState.swimlane">
            <option value="none">None</option>
            <option value="assignee">Assignee</option>
            <template v-if="!pursuitBoard">
              <option value="epic">Epic</option>
              <option value="sprint">Sprint</option>
              <option value="issueType">Issue type</option>
            </template>
          </select>
        </div>

        <div class="planning-toggle-list">
          <label v-if="!pursuitBoard" class="planning-check-row">
            <input v-model="configState.includeBacklog" type="checkbox" />
            <span><strong>Include backlog</strong></span>
          </label>
          <label class="planning-check-row">
            <input v-model="configState.hideDone" type="checkbox" />
            <span><strong>Hide completed</strong></span>
          </label>
        </div>

        <div v-if="!pursuitBoard" class="field-group">
          <label>Sprints</label>
          <div class="planning-toggle-list">
            <label v-for="sprint in boardState.sprints" :key="sprint.id" class="planning-check-row">
              <input
                :checked="configState.selectedSprintIds.includes(sprint.id)"
                type="checkbox"
                @change="toggleFilter('selectedSprintIds', sprint.id)"
              />
              <span>{{ sprint.name }}</span>
            </label>
          </div>
        </div>

        <div v-if="!pursuitBoard" class="field-group">
          <label>Issue types</label>
          <div class="planning-toggle-list">
            <label class="planning-check-row">
              <input :checked="configState.issueTypes.includes('story')" type="checkbox" @change="toggleFilter('issueTypes', 'story')" />
              <span>Stories</span>
            </label>
            <label class="planning-check-row">
              <input :checked="configState.issueTypes.includes('task')" type="checkbox" @change="toggleFilter('issueTypes', 'task')" />
              <span>Tasks</span>
            </label>
          </div>
        </div>

        <div class="field-group">
          <label>Assignees</label>
          <div class="planning-toggle-list">
            <label v-for="user in validUsers" :key="user.id" class="planning-check-row">
              <input :checked="configState.assigneeIds.includes(user.id)" type="checkbox" @change="toggleFilter('assigneeIds', user.id)" />
              <span>{{ user.name }}</span>
            </label>
          </div>
        </div>

        <div class="field-group">
          <label>Status</label>
          <div class="planning-toggle-list">
            <label v-for="status in workStatusOptions" :key="status" class="planning-check-row">
              <input :checked="configState.statusValues.includes(status)" type="checkbox" @change="toggleFilter('statusValues', status)" />
              <span>{{ status }}</span>
            </label>
          </div>
        </div>
      </div>

      <footer class="kanban-drawer__footer">
        <button class="secondary-button" type="button" @click="closeDrawers">Close</button>
        <button class="primary-button" type="button" :disabled="loading" @click="applyFilters">Apply scope</button>
      </footer>
    </aside>

    <aside v-if="drawerState.layoutOpen" class="kanban-drawer kanban-drawer--right" aria-label="Layout builder drawer">
      <header class="kanban-drawer__header">
        <div>
          <p class="card-eyebrow">Kanban Layout</p>
          <h3 class="workbench-card__title">Layout builder</h3>
        </div>
        <button class="kanban-drawer__close" type="button" aria-label="Close layout builder" @click="closeDrawers">x</button>
      </header>

      <div class="kanban-drawer__body">
        <section class="workbench-card">
          <div class="workbench-card__header">
            <div>
              <p class="card-eyebrow">Presets</p>
              <h4 class="workbench-card__title">Saved views</h4>
            </div>
          </div>

          <div class="field-group">
            <label>Preset name</label>
            <input v-model="presetName" placeholder="Sprint review board" />
          </div>
          <button class="btn btn-primary w-100 mb-3" type="button" @click="savePreset">
            Save preset
          </button>
          <div class="planning-preset-list">
            <div v-for="preset in configState.presets" :key="preset.name" class="planning-preset-item">
              <strong>{{ preset.name }}</strong>
              <div class="actions-row">
                <button class="secondary-button secondary-button--compact" type="button" @click="applyPreset(preset)">Load</button>
                <button class="ghost-button ghost-button--compact" type="button" @click="deletePreset(preset.name)">Delete</button>
              </div>
            </div>
          </div>
        </section>

        <section class="workbench-card">
          <div class="workbench-card__header">
            <div>
              <p class="card-eyebrow">Columns</p>
              <h4 class="workbench-card__title">Board columns</h4>
              <p class="panel-copy">Drag to reorder. Columns can share statuses; a card stays in the column you drop it in.</p>
            </div>
            <button class="secondary-button secondary-button--compact" type="button" @click="addColumn">Add column</button>
          </div>

          <div ref="layoutListRef" class="planning-layout-list">
            <div
              v-for="(column, index) in configState.columns"
              :key="column.clientId"
              class="planning-layout-card"
              :class="{ 'planning-layout-card--expanded': expandedColumnIds.has(column.clientId) }"
            >
              <div class="planning-layout-card__summary">
                <span class="planning-layout-card__handle" title="Drag to reorder" aria-label="Drag to reorder">
                  <i class="bi bi-grip-vertical" aria-hidden="true"></i>
                </span>
                <button class="planning-layout-card__toggle" type="button" :aria-expanded="expandedColumnIds.has(column.clientId)" @click="toggleColumnExpanded(column)">
                  <strong>{{ column.name }}</strong>
                  <small>{{ column.statuses.join(', ') }}</small>
                </button>
                <div class="actions-row">
                  <button class="ghost-button ghost-button--compact ghost-button--icon" type="button" title="Duplicate column" aria-label="Duplicate column" @click="duplicateColumn(index)">
                    <i class="bi bi-copy" aria-hidden="true"></i>
                  </button>
                  <button
                    class="ghost-button ghost-button--compact ghost-button--icon"
                    type="button"
                    title="Remove column"
                    aria-label="Remove column"
                    :disabled="configState.columns.length <= 1"
                    @click="removeColumn(index)"
                  >
                    <i class="bi bi-trash" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
              <div v-if="expandedColumnIds.has(column.clientId)" class="planning-layout-card__details">
                <div class="field-group">
                  <label>Name</label>
                  <input :value="column.name" @input="updateColumnName(index, $event.target.value)" />
                </div>
                <div class="field-group">
                  <label>Column key</label>
                  <input :value="column.key" @change="updateColumnKey(index, $event.target.value)" />
                  <small class="muted-copy">Set an item's <code>boardColumn</code> to this key to place it here. Changing it moves placed cards back to their status column.</small>
                </div>
                <div class="field-group">
                  <label>Accepted statuses</label>
                  <div class="planning-toggle-list">
                    <label v-for="status in workStatusOptions" :key="status" class="planning-check-row">
                      <input :checked="column.statuses.includes(status)" type="checkbox" @change="toggleColumnStatus(column, status)" />
                      <span>{{ status }}</span>
                      <small v-if="column.statuses.includes(status) && sharedStatusNote(column, status)">{{ sharedStatusNote(column, status) }}</small>
                    </label>
                  </div>
                </div>
                <div class="field-group">
                  <label>Status on drop</label>
                  <select v-model="column.defaultStatus">
                    <option v-for="status in column.statuses" :key="status" :value="status">{{ status }}</option>
                  </select>
                  <small class="muted-copy">Applied when a dropped card's status isn't one this column accepts.</small>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <footer class="kanban-drawer__footer">
        <button class="secondary-button" type="button" @click="closeDrawers">Close</button>
        <button class="primary-button" type="button" @click="saveLayout">Save layout</button>
      </footer>
    </aside>

    <ProjectKanbanCardCreateModal
      :error-message="createCardState.errorMessage"
      :open="createCardState.open"
      :project="project"
      :saving="createCardState.saving"
      :sprints="boardState.sprints"
      :status-options="cardStatusOptions"
      :task-only="pursuitBoard"
      :token="token"
      :valid-users="validUsers"
      @close="closeCreateCard"
      @submit="createCard"
    />
  </div>
</template>
