<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import PortalHeader from '../../components/requirements/portal/PortalHeader.vue';
import AccessAddTaskDialog from '../../components/task-access/AccessAddTaskDialog.vue';
import AccessLinkProblem from '../../components/task-access/AccessLinkProblem.vue';
import AccessTaskBoard from '../../components/task-access/AccessTaskBoard.vue';
import AccessTaskDialog from '../../components/task-access/AccessTaskDialog.vue';
import AccessTaskList from '../../components/task-access/AccessTaskList.vue';
import '../../components/task-access/task-access.css';
import { createSerialQueue } from '../../lib/async/serial-queue.js';
import { apiClient } from '../../lib/auth/index.js';
import {
  ALL_SPRINTS,
  accessLinkText,
  applyTaskChange,
  boardColumns,
  boardDropPatch,
  classifyAccessError,
  describeAccessWriteError,
  directTasksProjectId,
  emptyTasksText,
  filterTasks,
  groupTasksByStory,
  showsEveryoneFilter,
  sprintOptions,
  storiesForNewTask,
} from '../../lib/task-access/access-view.js';
import { createVisibleRefresh } from '../../lib/task-access/visible-refresh.js';

// One project's work from the access link (/access/:token/projects/:projectId): epics, stories
// and tasks as a board or a list. The person moves and edits only what is assigned to them;
// everything else is read-only. The page refreshes every 30 seconds while it is visible and
// after each write.
const REFRESH_MS = 30_000;
const route = useRoute();
const router = useRouter();
const uid = useId();

const hub = shallowRef(null);
const data = shallowRef(null);
const problem = ref(null);
const notice = ref(null);
const view = ref(route.query.view === 'list' ? 'list' : 'board');
const sprintId = ref(ALL_SPRINTS);
const show = ref('mine');
const openTaskId = ref('');
const adding = ref({ open: false, storyId: '' });
const pendingMoves = ref(0);
// Bumped on each timed refresh so an open item also reloads its comments and time.
const tick = ref(0);

let sequence = 0;
// A refresh while a card is dragged, or while moves are saving, would undo them on screen,
// so it waits until they settle.
let dragging = false;
let refreshDeferred = false;
const moveQueue = createSerialQueue({
  onChange: ({ busy, size }) => {
    pendingMoves.value = size;
    if (!busy) flushDeferredRefresh();
  },
});

const token = computed(() => String(route.params.token ?? ''));
const projectId = computed(() => String(route.params.projectId ?? ''));
const scope = computed(() => data.value?.scope ?? 'own');
const mineOnly = computed(() => showsEveryoneFilter(scope.value) && show.value === 'mine');
const items = computed(() => data.value?.items ?? []);
const visibleItems = computed(() => filterTasks(items.value, { mineOnly: mineOnly.value, sprintId: sprintId.value }));
const board = computed(() => boardColumns(data.value?.columns, visibleItems.value));
const groups = computed(() => groupTasksByStory(data.value?.stories, visibleItems.value));
const sprintNames = computed(() => new Map((data.value?.sprints ?? []).map((sprint) => [sprint.id, sprint.name])));
const sprintChoices = computed(() => sprintOptions(data.value?.sprints, items.value));
const addableStories = computed(() => storiesForNewTask(data.value?.stories));
const openTask = computed(() => items.value.find((item) => item.id === openTaskId.value) ?? null);
const hubLink = computed(() => ({ name: 'task-access-hub', params: { token: token.value } }));
// The hub opens a lone tasks project directly, so a way back only helps when it lists more.
const showHubLink = computed(() => Boolean(hub.value) && !directTasksProjectId(hub.value));
const projectName = computed(() => data.value?.project?.name
  ?? (hub.value?.projects ?? []).find((project) => project.id === projectId.value)?.name
  ?? '');
const personName = computed(() => hub.value?.person?.name || data.value?.me?.name || '');
const emptyText = computed(() => emptyTasksText({ mineOnly: mineOnly.value, sprintId: sprintId.value, total: items.value.length }));

function boardIsSettling() {
  return dragging || moveQueue.busy;
}

async function load({ passive = false } = {}) {
  const current = ++sequence;
  if (!token.value || !projectId.value) return;
  const client = passive ? apiClient.passive : apiClient;
  try {
    const [hubData, taskData] = await Promise.all([
      passive && hub.value ? hub.value : client.getAccessHub(token.value),
      client.getAccessTasks(token.value, projectId.value),
    ]);
    if (current !== sequence) return;
    if (passive && boardIsSettling()) {
      refreshDeferred = true;
      return;
    }
    hub.value = hubData;
    data.value = taskData;
    problem.value = null;
  } catch (error) {
    if (current !== sequence) return;
    const classified = classifyAccessError(error);
    // A missed background refresh isn't worth replacing the page; the next one may work.
    if (passive && (classified.kind === 'failed' || classified.kind === 'rate-limited')) return;
    problem.value = classified;
  }
}

function requestRefresh() {
  if (boardIsSettling()) {
    refreshDeferred = true;
    return;
  }
  load({ passive: true });
}

function flushDeferredRefresh() {
  if (refreshDeferred && !boardIsSettling()) {
    refreshDeferred = false;
    load({ passive: true });
  }
}

const poller = createVisibleRefresh({
  intervalMs: REFRESH_MS,
  refresh: () => {
    if (problem.value || !data.value) return;
    tick.value += 1;
    requestRefresh();
  },
});

function mergeTask(item) {
  if (!item?.id || !data.value) return;
  data.value = { ...data.value, items: applyTaskChange(data.value.items, item.id, item) };
}

function setDragging(value) {
  dragging = value;
  if (!value) flushDeferredRefresh();
}

// Shows the move at once, then saves it in order behind any earlier moves.
function moveTask({ columnKey, fromColumnKey, taskId }) {
  const task = items.value.find((entry) => entry.id === taskId);
  const column = (data.value?.columns ?? []).find((entry) => entry.key === columnKey);
  const patch = boardDropPatch(task, column, fromColumnKey);
  if (!patch) return;
  const { expectedVersion: _version, ...change } = patch;
  const before = { boardColumn: task.boardColumn ?? null, status: task.status };
  const moved = { ...before, ...change };
  data.value = { ...data.value, items: applyTaskChange(data.value.items, taskId, change) };
  notice.value = null;
  // The board reloads from the server once the queue is empty.
  refreshDeferred = true;
  moveQueue.enqueue(async () => {
    // Read the version when the save runs, so a second move sends the first one's result.
    const latest = data.value?.items.find((entry) => entry.id === taskId);
    const result = await apiClient.updateAccessTask(token.value, projectId.value, taskId, { ...patch, expectedVersion: latest?.version ?? patch.expectedVersion });
    mergeTask(result?.task);
  }).catch((error) => {
    const described = describeAccessWriteError(error, { itemType: task.itemType });
    if (described.problem) {
      problem.value = described.problem;
      return;
    }
    // A refused drop (a workflow rule, a conflict, a closed column, a story with someone else's
    // open tasks) puts the card back where it was at once, unless a later move has taken it
    // elsewhere, then reads the board again.
    const current = data.value?.items.find((entry) => entry.id === taskId);
    if (current && current.status === moved.status && (current.boardColumn ?? null) === moved.boardColumn) {
      data.value = { ...data.value, items: applyTaskChange(data.value.items, taskId, before) };
    }
    requestRefresh();
    notice.value = described.conflict
      ? { text: `Someone else changed “${task.name}” while you were moving it. The board now shows their changes.`, tone: 'info' }
      : { text: `“${task.name}” didn’t move. ${described.message}`, tone: 'error' };
  });
}

function openTaskDetail(taskId) {
  openTaskId.value = taskId;
}

function closeTaskDetail() {
  openTaskId.value = '';
}

function taskSaved(task) {
  mergeTask(task);
  requestRefresh();
}

function openAdd(storyId = '') {
  adding.value = { open: true, storyId };
}

function taskCreated(task) {
  adding.value = { open: false, storyId: '' };
  const hidden = task && !filterTasks([task], { sprintId: sprintId.value }).length;
  notice.value = {
    text: `${task?.name ? `“${task.name}” added.` : 'Task added.'}${hidden ? ' It’s in another sprint, so this sprint filter hides it.' : ''}`,
    tone: 'ok',
  };
  requestRefresh();
}

function showProblem(value) {
  openTaskId.value = '';
  adding.value = { open: false, storyId: '' };
  problem.value = value;
}

function retry() {
  problem.value = null;
  load();
}

watch([token, projectId], () => {
  hub.value = null;
  data.value = null;
  problem.value = null;
  notice.value = null;
  openTaskId.value = '';
  sprintId.value = ALL_SPRINTS;
  show.value = 'mine';
  load();
}, { immediate: true });

// A sprint that disappears on refresh drops the filter back to every sprint.
watch(sprintChoices, (choices) => {
  if (!choices.some((choice) => choice.value === sprintId.value)) sprintId.value = ALL_SPRINTS;
});

watch(view, (value) => {
  const { view: _view, ...query } = route.query;
  router.replace({ query: value === 'list' ? { ...query, view: 'list' } : query });
});

watch(projectName, (name) => {
  if (typeof document !== 'undefined' && name) document.title = `${name} · Tasks`;
}, { immediate: true });

onMounted(() => poller.start());
onBeforeUnmount(() => poller.stop());
</script>

<template>
  <div class="rq-workspace rq-portal access-portal">
    <PortalHeader
      :eyebrow="projectName"
      title="Tasks"
      :link="hub?.link ?? null"
      :show-link="Boolean(hub) && !problem"
      :stakeholder="!problem && personName ? { name: personName } : null"
      :validity="accessLinkText(hub?.link)"
    >
      <template #status>
        <RouterLink v-if="showHubLink && !problem" class="rq-portal-head__home" :to="hubLink">
          <i class="bi bi-arrow-left" aria-hidden="true"></i>Your projects
        </RouterLink>
      </template>
    </PortalHeader>

    <AccessLinkProblem v-if="problem" :hub-link="problem.kind === 'no-project' ? hubLink : null" :problem="problem" @retry="retry" />
    <div v-else-if="!data" class="rq-review-page">
      <p class="rq-review-card rq-small rq-muted mb-0" role="status">Loading your work…</p>
    </div>
    <div v-else class="access-page">
      <h1 class="visually-hidden">Tasks on {{ projectName || 'this project' }}</h1>

      <div class="access-toolbar">
        <fieldset class="rq-seg">
          <legend class="visually-hidden">View</legend>
          <label class="rq-seg__option">
            <input v-model="view" type="radio" :name="`access-view-${uid}`" value="board" />
            <span><i class="bi bi-kanban" aria-hidden="true"></i>Board</span>
          </label>
          <label class="rq-seg__option">
            <input v-model="view" type="radio" :name="`access-view-${uid}`" value="list" />
            <span><i class="bi bi-list-ul" aria-hidden="true"></i>List</span>
          </label>
        </fieldset>
        <fieldset v-if="showsEveryoneFilter(scope)" class="rq-seg">
          <legend class="visually-hidden">Whose work</legend>
          <label class="rq-seg__option">
            <input v-model="show" type="radio" :name="`access-show-${uid}`" value="mine" />
            <span>Mine</span>
          </label>
          <label class="rq-seg__option">
            <input v-model="show" type="radio" :name="`access-show-${uid}`" value="everyone" />
            <span>Everyone</span>
          </label>
        </fieldset>
        <div class="access-toolbar__sprint">
          <label :for="`access-sprint-${uid}`">Sprint</label>
          <select :id="`access-sprint-${uid}`" v-model="sprintId" class="form-select">
            <option v-for="choice in sprintChoices" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
          </select>
        </div>
        <span v-if="pendingMoves" class="access-toolbar__saving" role="status">
          <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>Saving…
        </span>
        <button v-if="addableStories.length" class="primary-button access-toolbar__add" type="button" @click="openAdd()">
          <i class="bi bi-plus-lg" aria-hidden="true"></i>Add task
        </button>
      </div>

      <div v-if="notice" class="access-notice" :class="notice.tone === 'error' ? 'error-banner' : notice.tone === 'info' ? 'info-banner' : 'success-banner'" :role="notice.tone === 'error' ? 'alert' : 'status'">
        <span>{{ notice.text }}</span>
        <button class="access-notice__close" type="button" aria-label="Dismiss message" @click="notice = null">
          <i class="bi bi-x-lg" aria-hidden="true"></i>
        </button>
      </div>

      <p v-if="!visibleItems.length" class="rq-small rq-muted mb-0">{{ emptyText }}</p>

      <template v-if="view === 'board'">
        <AccessTaskBoard
          :columns="board.columns"
          @dragging="setDragging"
          @move="moveTask"
          @open="openTaskDetail"
        />
        <p v-if="board.unplaced.length" class="rq-xs rq-muted mb-0">
          {{ board.unplaced.length === 1 ? '1 item has a status' : `${board.unplaced.length} items have a status` }} with no column on this board. List shows every item.
        </p>
      </template>
      <AccessTaskList v-else-if="visibleItems.length" :groups="groups" :sprint-names="sprintNames" @add="openAdd" @open="openTaskDetail" />
    </div>

    <AccessTaskDialog
      v-if="data"
      :columns="data.columns ?? []"
      :open="Boolean(openTaskId)"
      :project-id="projectId"
      :refresh-key="tick"
      :sprint-name="sprintNames.get(openTask?.sprintId) ?? ''"
      :task="openTask"
      :token="token"
      @close="closeTaskDetail"
      @problem="showProblem"
      @saved="taskSaved"
    />
    <AccessAddTaskDialog
      v-if="data"
      :open="adding.open"
      :project-id="projectId"
      :stories="addableStories"
      :story-id="adding.storyId"
      :token="token"
      @close="adding = { open: false, storyId: '' }"
      @created="taskCreated"
      @problem="showProblem"
      @refresh="requestRefresh"
    />
  </div>
</template>
