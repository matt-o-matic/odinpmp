<script setup>
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { apiClient, authSession } from '../../lib/auth/index.js';
import {
  assigneeInitials,
  columnForCard,
  filterTaskCards,
  findItemVersion,
  normalizeTaskFilter,
  backlogEpicPayload,
  BACKLOG_EPIC_NAME,
  quickAddPayload,
  quickAddPlan,
  TASK_FILTERS,
  taskCardMeta,
  taskColumns,
  taskLocation,
} from '../../lib/chat/chat-tasks.js';
import { deferWhileHidden } from '../../lib/live/live-updates.js';
import { hydrateKanbanConfig } from '../../lib/projects/project-kanban-config.js';
import { buildKanbanMovePatch } from '../../lib/projects/kanban-placement.js';
import { createProjectLiveUpdates } from '../../lib/projects/project-live-updates.js';
import { PURSUIT_STATUS_OPTIONS } from '../../lib/pursuit/pursuit.js';

// A channel's Tasks tab in Odin Chat (docs/odin-chat/plan.md, Tasks): the project's work beside
// its conversation. A delivery project shows its board's stories and tasks; an engagement shows
// its pursuit tasks. People who can plan add work by name and move it between columns; others
// see it read-only. Anything more opens in Odin proper. The filter and view stay in the address.
const props = defineProps({
  // Whether Odin answers tags in this channel, so "Ask Odin" is offered.
  canAskOdin: { default: false, type: Boolean },
  kind: { default: 'delivery', type: String },
  projectId: { required: true, type: String },
});

const emit = defineEmits(['ask-odin']);

const STATUSES = ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed'];
const QUICK_PARENT_KEY = 'odin.chat.tasks.parent';

const route = useRoute();
const router = useRouter();
const uid = useId();
const token = computed(() => authSession.state.token);
const userId = computed(() => authSession.state.currentUser?.id ?? '');
const engagement = computed(() => props.kind === 'engagement');
const scope = computed(() => (engagement.value ? { scope: 'pursuit' } : {}));

const project = ref(null);
const columns = ref([]);
const cards = ref([]);
const storyId = ref('');
const canEdit = ref(false);
const loaded = ref(false);
const loadError = ref('');
const actionError = ref('');
const notice = ref('');
const busyIds = ref(new Set());
const quick = ref({ busy: false, name: '', parentId: '' });

const phone = ref(false);
let media = null;
const onMedia = () => { phone.value = Boolean(media?.matches); };

const filter = computed(() => normalizeTaskFilter(String(route.query.tasks ?? '')));
const view = computed(() => {
  const wanted = String(route.query.view ?? '');
  if (wanted === 'board' || wanted === 'list') return wanted;
  return phone.value ? 'list' : 'board';
});
const shown = computed(() => filterTaskCards(cards.value, { filter: filter.value, userId: userId.value }));
const board = computed(() => taskColumns(columns.value, shown.value));
const plan = computed(() => quickAddPlan(project.value, { kind: props.kind, storyId: storyId.value }));
const canAdd = computed(() => canEdit.value && (plan.value.parents.length > 0 || Boolean(plan.value.startsBacklog)));
const emptyLine = computed(() => {
  if (filter.value === 'mine') return 'Nothing open is assigned to you.';
  if (filter.value === 'open') return cards.value.length ? 'Everything here is done.' : 'No tasks yet.';
  return 'No tasks yet.';
});

function setQuery(patch) {
  router.replace({ query: { ...route.query, ...patch } }).catch(() => null);
}

function rememberParent(id) {
  try { globalThis.localStorage?.setItem(`${QUICK_PARENT_KEY}.${props.projectId}`, id); } catch { /* storage is a convenience */ }
}

function recalledParent() {
  try { return globalThis.localStorage?.getItem(`${QUICK_PARENT_KEY}.${props.projectId}`) ?? ''; } catch { return ''; }
}

let sequence = 0;
async function load({ quiet = false } = {}) {
  if (!props.projectId || !token.value) return;
  const current = ++sequence;
  const client = quiet ? apiClient.passive : apiClient;
  try {
    const [source, config, kanban] = await Promise.all([
      engagement.value ? client.getPursuit(props.projectId, token.value) : client.getProject(props.projectId, token.value),
      client.getProjectKanbanConfig(props.projectId, token.value, scope.value).catch(() => ({ config: {} })),
      client.getProjectKanban(props.projectId, { includeBacklog: true }, token.value, scope.value),
    ]);
    if (current !== sequence) return;
    project.value = source?.project ?? null;
    storyId.value = engagement.value ? String(source?.storyId ?? '') : '';
    canEdit.value = engagement.value ? Boolean(source?.viewer?.canEdit) : Boolean(source?.permissions?.canEditPlan);
    const statuses = engagement.value ? [...PURSUIT_STATUS_OPTIONS] : STATUSES;
    columns.value = hydrateKanbanConfig(config?.config ?? {}, statuses).columns;
    cards.value = kanban?.board?.cards ?? [];
    loadError.value = '';
    const parents = plan.value.parents;
    if (!parents.some((parent) => parent.id === quick.value.parentId)) {
      const recalled = recalledParent();
      quick.value.parentId = parents.find((parent) => parent.id === recalled)?.id ?? parents[0]?.id ?? '';
    }
  } catch (error) {
    if (current === sequence && !quiet) loadError.value = error?.message || 'Tasks could not load.';
  } finally {
    if (current === sequence) loaded.value = true;
  }
}

async function addTask() {
  const name = quick.value.name.trim();
  if (!name || quick.value.busy || !canAdd.value) return;
  quick.value.busy = true;
  actionError.value = '';
  try {
    const status = columns.value[0]?.defaultStatus ?? 'Not Started';
    // A project with no epic yet starts "Backlog" with its first story.
    const parentId = plan.value.startsBacklog
      ? (await apiClient.createProjectItem(props.projectId, backlogEpicPayload(status), token.value)).item.id
      : quick.value.parentId;
    await apiClient.createProjectItem(props.projectId, quickAddPayload({ name, parentId, plan: plan.value, project: project.value, status }), token.value);
    if (!plan.value.startsBacklog) rememberParent(quick.value.parentId);
    quick.value.name = '';
    notice.value = `Added "${name}".`;
    await load({ quiet: true });
  } catch (error) {
    actionError.value = error?.message || 'The task could not be added.';
  } finally {
    quick.value.busy = false;
  }
}

async function moveCard(card, columnKey) {
  const column = columns.value.find((entry) => entry.key === columnKey);
  if (!column || busyIds.value.has(card.id)) return;
  const patch = buildKanbanMovePatch(card, column);
  const expectedVersion = findItemVersion(project.value, card.id);
  if (expectedVersion === null) {
    actionError.value = 'That task is no longer here. The list has been refreshed.';
    void load({ quiet: true });
    return;
  }
  busyIds.value = new Set([...busyIds.value, card.id]);
  actionError.value = '';
  // Shown in its new column at once; the reload after the save settles it.
  cards.value = cards.value.map((entry) => (entry.id === card.id ? { ...entry, ...patch } : entry));
  try {
    await apiClient.updateProjectItem(props.projectId, card.id, { expectedVersion, patch }, token.value);
    notice.value = `Moved "${card.name}" to ${column.name}.`;
  } catch (error) {
    actionError.value = error?.status === 409
      ? `Someone else changed "${card.name}". The list has been refreshed; try again.`
      : error?.message || 'The task could not be moved.';
  } finally {
    const next = new Set(busyIds.value);
    next.delete(card.id);
    busyIds.value = next;
    await load({ quiet: true });
  }
}

// Someone else's change to the project's work: read the board again.
let stopLive = null;
function startLive() {
  stopLive?.();
  stopLive = null;
  if (!props.projectId || !token.value) return;
  const deferred = deferWhileHidden(() => { void load({ quiet: true }); });
  const stopUpdates = createProjectLiveUpdates({ apiClient, getToken: () => authSession.state.token, onChange: deferred.run, projectId: props.projectId });
  stopLive = () => {
    stopUpdates();
    deferred.stop();
  };
}

watch(() => [props.projectId, props.kind], () => {
  loaded.value = false;
  project.value = null;
  cards.value = [];
  void load();
  startLive();
});

onMounted(() => {
  media = globalThis.matchMedia?.('(max-width: 700px)') ?? null;
  onMedia();
  media?.addEventListener?.('change', onMedia);
  void load();
  startLive();
});

onBeforeUnmount(() => {
  media?.removeEventListener?.('change', onMedia);
  stopLive?.();
});
</script>

<template>
  <section class="chat-tasks" :aria-labelledby="`${uid}-title`">
    <h4 :id="`${uid}-title`" class="visually-hidden">Tasks</h4>
    <div class="chat-tasks__bar">
      <div class="chat-tasks__filters" role="group" aria-label="Show">
        <button
          v-for="entry in TASK_FILTERS"
          :key="entry.id"
          class="chat-tasks__chip"
          :class="{ 'chat-tasks__chip--on': filter === entry.id }"
          type="button"
          :aria-pressed="filter === entry.id ? 'true' : 'false'"
          @click="setQuery({ tasks: entry.id === 'open' ? undefined : entry.id })"
        >{{ entry.label }}</button>
      </div>
      <div class="chat-tasks__actions">
        <div class="chat-tasks__views" role="group" aria-label="Layout">
          <button class="chat-tasks__icon" :class="{ 'chat-tasks__icon--on': view === 'board' }" type="button" aria-label="Board" :aria-pressed="view === 'board' ? 'true' : 'false'" @click="setQuery({ view: 'board' })">
            <i class="bi bi-kanban" aria-hidden="true"></i>
          </button>
          <button class="chat-tasks__icon" :class="{ 'chat-tasks__icon--on': view === 'list' }" type="button" aria-label="List" :aria-pressed="view === 'list' ? 'true' : 'false'" @click="setQuery({ view: 'list' })">
            <i class="bi bi-list-ul" aria-hidden="true"></i>
          </button>
        </div>
        <button v-if="canAskOdin" class="ghost-button ghost-button--compact chat-tasks__odin" type="button" @click="emit('ask-odin')">
          <i class="bi bi-stars" aria-hidden="true"></i> Ask Odin
        </button>
        <RouterLink class="ghost-button ghost-button--compact" :to="engagement ? { name: 'engagement-detail', params: { projectId, section: 'board' } } : { name: 'project-kanban', params: { projectId } }">
          Full board <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i>
        </RouterLink>
      </div>
    </div>

    <p v-if="loadError" class="error-banner mb-0" role="alert">
      {{ loadError }}
      <button class="ghost-button ghost-button--compact ms-2" type="button" @click="load()">Try again</button>
    </p>
    <p v-if="actionError" class="error-banner mb-0" role="alert">{{ actionError }}</p>
    <p class="visually-hidden" role="status">{{ notice }}</p>

    <form v-if="canAdd" class="chat-tasks__quick" @submit.prevent="addTask">
      <label class="visually-hidden" :for="`${uid}-quick`">New {{ plan.issueType }}</label>
      <input :id="`${uid}-quick`" v-model="quick.name" class="form-control" maxlength="200" autocomplete="off" :placeholder="`Add a ${plan.issueType}, then press Enter`" :disabled="quick.busy" />
      <template v-if="!plan.pursuit && plan.parents.length > 1">
        <label class="visually-hidden" :for="`${uid}-parent`">{{ plan.issueType === 'story' ? 'Epic' : 'Story' }}</label>
        <select :id="`${uid}-parent`" v-model="quick.parentId" class="form-select chat-tasks__parent" :disabled="quick.busy">
          <option v-for="parent in plan.parents" :key="parent.id" :value="parent.id">{{ parent.label }}</option>
        </select>
      </template>
      <button class="primary-button" type="submit" :disabled="quick.busy || !quick.name.trim()">{{ quick.busy ? 'Adding…' : 'Add' }}</button>
    </form>
    <p v-if="canAdd && plan.startsBacklog" class="chat-tasks__note">The first one starts a "{{ BACKLOG_EPIC_NAME }}" epic in the project plan.</p>

    <p v-if="!loaded && !loadError" class="chat-tasks__note" role="status">Loading tasks…</p>
    <template v-else-if="loaded && !loadError">
      <p v-if="!shown.length" class="chat-tasks__note">{{ emptyLine }}</p>

      <div v-else-if="view === 'board'" class="chat-tasks__board">
        <section v-for="column in board" :key="column.key" class="chat-tasks__column" :aria-label="`${column.name}, ${column.cards.length}`">
          <h5 class="chat-tasks__column-head">{{ column.name }} <span class="chat-tasks__count">{{ column.cards.length }}</span></h5>
          <ul class="chat-tasks__cards">
            <li v-for="card in column.cards" :key="card.id" class="chat-tasks__card" :class="{ 'chat-tasks__card--busy': busyIds.has(card.id) }">
              <RouterLink class="chat-tasks__name" :to="taskLocation(projectId, card, { kind })">{{ card.name }}</RouterLink>
              <div class="chat-tasks__meta">
                <span class="chat-tasks__type">{{ taskCardMeta(card).type }}</span>
                <span v-if="taskCardMeta(card).priority" class="chat-tasks__priority" :title="taskCardMeta(card).priority.label">
                  <i class="bi bi-arrow-up" aria-hidden="true"></i><span class="visually-hidden">{{ taskCardMeta(card).priority.label }}</span>P{{ taskCardMeta(card).priority.level }}
                </span>
                <span v-if="taskCardMeta(card).due" class="chat-tasks__due" :class="{ 'chat-tasks__due--late': taskCardMeta(card).overdue }">
                  <i class="bi bi-calendar-event" aria-hidden="true"></i> {{ taskCardMeta(card).due }}<span v-if="taskCardMeta(card).overdue"> (late)</span>
                </span>
                <span v-else-if="taskCardMeta(card).sprint" class="chat-tasks__sprint">{{ taskCardMeta(card).sprint }}</span>
                <span v-if="card.assigneeName" class="chat-tasks__who" :title="card.assigneeName" :aria-label="`Assigned to ${card.assigneeName}`">{{ assigneeInitials(card.assigneeName) }}</span>
              </div>
              <label v-if="canEdit" class="visually-hidden" :for="`${uid}-move-${card.id}`">Column for {{ card.name }}</label>
              <select v-if="canEdit" :id="`${uid}-move-${card.id}`" class="form-select form-select-sm chat-tasks__move" :value="columnForCard(columns, card)?.key ?? ''" :disabled="busyIds.has(card.id)" @change="moveCard(card, $event.target.value)">
                <option v-for="option in columns" :key="option.key" :value="option.key">{{ option.name }}</option>
              </select>
            </li>
          </ul>
        </section>
      </div>

      <ul v-else class="chat-tasks__list">
        <li v-for="card in shown" :key="card.id" class="chat-tasks__row" :class="{ 'chat-tasks__card--busy': busyIds.has(card.id) }">
          <div class="chat-tasks__row-main">
            <RouterLink class="chat-tasks__name" :to="taskLocation(projectId, card, { kind })">{{ card.name }}</RouterLink>
            <div class="chat-tasks__meta">
              <span class="chat-tasks__type">{{ taskCardMeta(card).type }}</span>
              <span v-if="taskCardMeta(card).priority" class="chat-tasks__priority" :title="taskCardMeta(card).priority.label">
                <i class="bi bi-arrow-up" aria-hidden="true"></i><span class="visually-hidden">{{ taskCardMeta(card).priority.label }}</span>P{{ taskCardMeta(card).priority.level }}
              </span>
              <span v-if="taskCardMeta(card).due" class="chat-tasks__due" :class="{ 'chat-tasks__due--late': taskCardMeta(card).overdue }">
                <i class="bi bi-calendar-event" aria-hidden="true"></i> {{ taskCardMeta(card).due }}<span v-if="taskCardMeta(card).overdue"> (late)</span>
              </span>
              <span v-else-if="taskCardMeta(card).sprint" class="chat-tasks__sprint">{{ taskCardMeta(card).sprint }}</span>
              <span v-if="card.assigneeName" class="chat-tasks__who" :title="card.assigneeName" :aria-label="`Assigned to ${card.assigneeName}`">{{ assigneeInitials(card.assigneeName) }}</span>
            </div>
          </div>
          <label v-if="canEdit" class="visually-hidden" :for="`${uid}-row-${card.id}`">Column for {{ card.name }}</label>
          <select v-if="canEdit" :id="`${uid}-row-${card.id}`" class="form-select form-select-sm chat-tasks__move" :value="columnForCard(columns, card)?.key ?? ''" :disabled="busyIds.has(card.id)" @change="moveCard(card, $event.target.value)">
            <option v-for="option in columns" :key="option.key" :value="option.key">{{ option.name }}</option>
          </select>
          <span v-else class="chat-tasks__status">{{ columnForCard(columns, card)?.name ?? card.status }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.chat-tasks { display: flex; flex: 1 1 auto; flex-direction: column; gap: 0.6rem; min-width: 0; min-height: 0; padding-top: 0.6rem; }
.chat-tasks__bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; }
.chat-tasks__filters,
.chat-tasks__views,
.chat-tasks__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; }
.chat-tasks__chip { min-height: 2.75rem; padding: 0 0.85rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--ink-soft); font-weight: 600; }
.chat-tasks__chip--on { border-color: var(--accent); background: var(--accent); color: #fff; }
.chat-tasks__icon { display: inline-flex; align-items: center; justify-content: center; width: 2.75rem; height: 2.75rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface); color: var(--ink-soft); }
.chat-tasks__icon--on { border-color: var(--accent); color: var(--accent); }
.chat-tasks__actions .ghost-button { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; text-decoration: none; }
.chat-tasks__quick { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.chat-tasks__quick .form-control { flex: 1 1 14rem; min-height: 2.75rem; }
.chat-tasks__parent { flex: 0 1 14rem; min-height: 2.75rem; }
.chat-tasks__quick .primary-button { min-height: 2.75rem; }
.chat-tasks__note { margin: 0; color: var(--muted); }
.chat-tasks__board { display: grid; flex: 1 1 auto; grid-auto-columns: minmax(15rem, 1fr); grid-auto-flow: column; gap: 0.6rem; min-height: 0; overflow-x: auto; padding-bottom: 0.25rem; }
.chat-tasks__column { display: flex; flex-direction: column; min-height: 0; padding: 0.5rem; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface-soft); }
.chat-tasks__column-head { display: flex; align-items: center; justify-content: space-between; margin: 0 0 0.4rem; padding: 0 0.25rem; border: 0; color: var(--ink); font-size: 0.85rem !important; font-weight: 700; }
.chat-tasks__count { min-width: 1.5rem; padding: 0 0.4rem; border-radius: 999px; background: var(--surface); color: var(--muted); font-size: 0.75rem; text-align: center; }
.chat-tasks__cards,
.chat-tasks__list { display: grid; align-content: start; gap: 0.4rem; margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.chat-tasks__cards { flex: 1 1 auto; min-height: 0; }
.chat-tasks__list { flex: 1 1 auto; min-height: 0; }
.chat-tasks__card,
.chat-tasks__row { display: grid; gap: 0.35rem; padding: 0.55rem 0.65rem; border: 1px solid var(--line); border-radius: 0.45rem; background: var(--surface); }
.chat-tasks__row { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
.chat-tasks__card--busy { opacity: 0.6; }
.chat-tasks__name { color: var(--ink); font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }
.chat-tasks__name:hover { text-decoration: underline; }
.chat-tasks__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; color: var(--muted); font-size: 0.75rem; }
.chat-tasks__type { padding: 0 0.4rem; border: 1px solid var(--line); border-radius: 0.3rem; }
.chat-tasks__priority { color: var(--danger); font-weight: 700; }
.chat-tasks__due--late { color: var(--danger); font-weight: 600; }
.chat-tasks__who { display: inline-flex; align-items: center; justify-content: center; width: 1.6rem; height: 1.6rem; margin-left: auto; border-radius: 999px; background: var(--surface-soft); color: var(--ink); font-size: 0.7rem; font-weight: 700; }
.chat-tasks__move { min-height: 2.75rem; }
.chat-tasks__row .chat-tasks__move { width: auto; max-width: 11rem; }
.chat-tasks__status { color: var(--ink-soft); font-size: 0.8rem; white-space: nowrap; }
.chat-tasks__chip:focus-visible,
.chat-tasks__icon:focus-visible,
.chat-tasks__name:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
@media (max-width: 700px) {
  .chat-tasks__row { grid-template-columns: minmax(0, 1fr); }
  .chat-tasks__row .chat-tasks__move { max-width: none; }
}
</style>
