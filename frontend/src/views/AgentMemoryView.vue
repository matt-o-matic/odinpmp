<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import AgentMemoryEditorDialog from '../components/memory/AgentMemoryEditorDialog.vue';
import AgentMemoryGovernanceDialog from '../components/memory/AgentMemoryGovernanceDialog.vue';
import RequirementsConfirmDialog from '../components/requirements/RequirementsConfirmDialog.vue';
import { buildAssistantRouteQuery } from '../lib/assistant/assistant-routing.js';
import { apiClient, authSession } from '../lib/auth/index.js';
import {
  MEMORY_PAGE_SIZE,
  MEMORY_SENSITIVITIES,
  MEMORY_SORTS,
  MEMORY_TYPES,
  PERSONAL_SCOPE,
  buildMemoryBrowseQuery,
  confidenceLabel,
  createMemoryFilterState,
  dateLabel,
  memoryChangeBlockedReason,
  memoryErrorMessage,
  memoryFiltersToRouteQuery,
  memorySourceLabel,
  memoryTypeLabel,
  pageSummary,
  safeSourceUrl,
  sensitivityLabel,
} from '../lib/memory/agent-memory.js';

const route = useRoute();
const router = useRouter();

const filters = reactive(createMemoryFilterState(route.query));
const memories = ref([]);
const total = ref(0);
const offset = ref(0);
const permissions = ref({ canGovern: false, editableProjectIds: [] });
const projects = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const statusMessage = ref('');
const expandedId = ref('');

const editor = reactive({ busy: false, error: '', memory: null, mode: 'add', open: false });
const governance = reactive({ busy: false, error: '', memory: null, open: false });
const forget = reactive({ busy: false, error: '', memory: null, open: false });
const purge = reactive({ busy: false, error: '', open: false });

const token = computed(() => authSession.state.token);
const currentUserId = computed(() => authSession.state.currentUser?.id ?? '');
const editableProjects = computed(() => projects.value.filter((project) => permissions.value.editableProjectIds.includes(project.id)));
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / MEMORY_PAGE_SIZE)));
const hasFilters = computed(() => Boolean(filters.project || filters.query.trim() || filters.type || filters.sensitivity));
const summary = computed(() => pageSummary({ count: memories.value.length, offset: offset.value, total: total.value }));
const defaultProjectForNew = computed(() => (filters.project && filters.project !== PERSONAL_SCOPE ? filters.project : ''));

let syncedPath = route.fullPath;

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const result = await apiClient.browseAgentMemory(buildMemoryBrowseQuery(filters), token.value);
    memories.value = result.memories ?? [];
    total.value = result.total ?? 0;
    offset.value = result.offset ?? 0;
    permissions.value = result.permissions ?? { canGovern: false, editableProjectIds: [] };
    if (memories.value.length === 0 && total.value > 0 && filters.page > pageCount.value) {
      filters.page = pageCount.value;
      await syncAndLoad();
    }
  } catch (error) {
    memories.value = [];
    total.value = 0;
    errorMessage.value = memoryErrorMessage(error, 'Unable to load what the AI remembers.');
  } finally {
    loading.value = false;
  }
}

async function loadProjects() {
  try {
    projects.value = (await apiClient.getProjects(token.value)).projects ?? [];
  } catch (_error) {
    projects.value = [];
  }
}

async function syncAndLoad() {
  const target = router.resolve({ name: 'agent-memory', query: memoryFiltersToRouteQuery(filters) });
  syncedPath = target.fullPath;
  if (route.fullPath !== target.fullPath) await router.replace(target);
  await load();
}

function applyFilters() {
  filters.page = 1;
  statusMessage.value = '';
  syncAndLoad();
}

function clearFilters() {
  Object.assign(filters, createMemoryFilterState({}));
  statusMessage.value = '';
  syncAndLoad();
}

function goToPage(page) {
  filters.page = Math.min(Math.max(1, page), pageCount.value);
  syncAndLoad();
}

function toggle(memory) {
  expandedId.value = expandedId.value === memory.id ? '' : memory.id;
}

function projectLabel(memory) {
  if (!memory.projectId) return 'Personal';
  return memory.projectName || 'Project';
}

function conversationLink(memory) {
  const sessionId = memory.provenance?.sourceId;
  if (memory.provenance?.sourceType !== 'approved_assistant_run' || !memory.projectId || !sessionId || memory.createdBy !== currentUserId.value) return null;
  return { name: 'project-detail', params: { projectId: memory.projectId }, query: buildAssistantRouteQuery({}, { open: true, sessionId }) };
}

function correctionSummary(memory) {
  const corrections = Array.isArray(memory.provenance?.corrections) ? memory.provenance.corrections : [];
  if (!corrections.length) return '';
  const last = corrections[corrections.length - 1];
  const who = last.by === currentUserId.value ? 'you' : 'a teammate';
  return `Corrected ${corrections.length === 1 ? 'once' : `${corrections.length} times`}, last by ${who} on ${dateLabel(last.at)}`;
}

function finish(message) {
  statusMessage.value = message;
  return load();
}

function openAdd() {
  Object.assign(editor, { busy: false, error: '', memory: null, mode: 'add', open: true });
}

function openCorrect(memory) {
  Object.assign(editor, { busy: false, error: '', memory, mode: 'correct', open: true });
}

async function submitEditor(payload) {
  editor.busy = true;
  editor.error = '';
  try {
    if (editor.mode === 'correct') {
      await apiClient.correctAgentMemory(editor.memory.id, payload, token.value);
      editor.open = false;
      await finish(`Corrected “${payload.title ?? editor.memory.title}”.`);
    } else {
      const result = await apiClient.createAgentMemory(payload, token.value);
      editor.open = false;
      expandedId.value = result.memory?.id ?? '';
      await finish(result.warning ? `Memory added. ${result.warning}` : 'Memory added. The AI can use it from now on.');
    }
  } catch (error) {
    editor.error = memoryErrorMessage(error, 'Unable to save the memory.');
    if (error?.status === 409) load();
  } finally {
    editor.busy = false;
  }
}

function openGovernance(memory) {
  Object.assign(governance, { busy: false, error: '', memory, open: true });
}

async function submitGovernance(payload) {
  governance.busy = true;
  governance.error = '';
  try {
    await apiClient.updateAgentMemoryGovernance(governance.memory.id, payload, token.value);
    governance.open = false;
    await finish(`Retention updated for “${governance.memory.title}”.`);
  } catch (error) {
    governance.error = memoryErrorMessage(error, 'Unable to update retention.');
    if (error?.status === 409) load();
  } finally {
    governance.busy = false;
  }
}

function openForget(memory) {
  Object.assign(forget, { busy: false, error: '', memory, open: true });
}

async function confirmForget() {
  forget.busy = true;
  try {
    await apiClient.forgetAgentMemory(forget.memory.id, forget.memory.version, token.value);
    forget.open = false;
    expandedId.value = '';
    await finish(`Forgot “${forget.memory.title}”. The AI won’t use it again.`);
  } catch (error) {
    forget.error = memoryErrorMessage(error, 'Unable to forget the memory.');
    if (error?.status === 409) load();
  } finally {
    forget.busy = false;
  }
}

function openPurge() {
  Object.assign(purge, { busy: false, error: '', open: true });
}

async function confirmPurge() {
  purge.busy = true;
  try {
    const result = await apiClient.purgeExpiredAgentMemory({}, token.value);
    purge.open = false;
    const count = Number(result.purgedCount ?? 0);
    await finish(count ? `Purged ${count} expired ${count === 1 ? 'memory' : 'memories'}.` : 'No memories had expired.');
  } catch (error) {
    purge.error = memoryErrorMessage(error, 'Unable to purge expired memories.');
  } finally {
    purge.busy = false;
  }
}

watch(
  () => route.fullPath,
  (path) => {
    if (route.name !== 'agent-memory' || path === syncedPath) return;
    syncedPath = path;
    Object.assign(filters, createMemoryFilterState(route.query));
    load();
  },
);

onMounted(() => {
  loadProjects();
  load();
});
</script>

<template>
  <div class="memory-page">
    <header class="memory-header">
      <div>
        <h1>What the AI remembers</h1>
        <p>Decisions, preferences, facts, and outcomes the AI Workspace recalls when it works on your projects. Correct or forget anything that is wrong or out of date.</p>
      </div>
      <div class="memory-header__actions">
        <button class="btn btn-primary" type="button" @click="openAdd"><i class="bi bi-plus-lg me-1" aria-hidden="true"></i>Add memory</button>
        <button v-if="permissions.canGovern" class="btn btn-outline-danger" type="button" @click="openPurge">Purge expired</button>
      </div>
    </header>

    <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>
    <div class="memory-status" role="status" aria-live="polite">
      <p v-if="statusMessage" class="alert alert-success mb-0">{{ statusMessage }}</p>
    </div>

    <form class="memory-filters" role="search" aria-label="Filter memories" @submit.prevent="applyFilters">
      <label class="memory-filters__search" for="memory-search">Search
        <input id="memory-search" v-model="filters.query" class="form-control" type="search" maxlength="200" placeholder="Words in the title or content" />
      </label>
      <label for="memory-project">Project
        <select id="memory-project" v-model="filters.project" class="form-select">
          <option value="">All projects and personal</option>
          <option :value="PERSONAL_SCOPE">Personal only</option>
          <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </label>
      <label for="memory-type">Type
        <select id="memory-type" v-model="filters.type" class="form-select">
          <option value="">All types</option>
          <option v-for="option in MEMORY_TYPES" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <label for="memory-sensitivity">Sensitivity
        <select id="memory-sensitivity" v-model="filters.sensitivity" class="form-select">
          <option value="">Any</option>
          <option v-for="option in MEMORY_SENSITIVITIES" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <label for="memory-sort">Sort
        <select id="memory-sort" v-model="filters.sort" class="form-select">
          <option v-for="option in MEMORY_SORTS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>
      <div class="memory-filters__buttons">
        <button class="btn btn-outline-secondary" type="submit">Apply</button>
        <button class="btn btn-outline-secondary" type="button" @click="clearFilters">Clear</button>
      </div>
    </form>

    <p v-if="loading" class="memory-empty" role="status">Loading memories…</p>

    <section v-else aria-labelledby="memory-list-heading">
      <div class="memory-list-head">
        <h2 id="memory-list-heading">Memories</h2>
        <span class="memory-muted">{{ summary }}</span>
      </div>

      <p v-if="memories.length === 0 && hasFilters" class="memory-empty">No memories match these filters.</p>
      <p v-else-if="memories.length === 0" class="memory-empty">
        Nothing yet. The AI saves a note each time changes are applied in the AI Workspace, and you can add your own.
      </p>

      <ul v-else class="memory-list">
        <li v-for="memory in memories" :key="memory.id" class="memory-row" :class="{ 'memory-row--open': expandedId === memory.id }">
          <h3 class="memory-row__heading">
            <button
              class="memory-row__toggle"
              type="button"
              :aria-expanded="expandedId === memory.id ? 'true' : 'false'"
              :aria-controls="`memory-detail-${memory.id}`"
              @click="toggle(memory)"
            >
              <i class="bi bi-chevron-right memory-row__chevron" aria-hidden="true"></i>
              <span>{{ memory.title }}</span>
            </button>
          </h3>
          <p class="memory-row__meta">
            <span class="memory-badge">{{ memoryTypeLabel(memory.memoryType) }}</span>
            <span>{{ projectLabel(memory) }}</span>
            <span>{{ memorySourceLabel(memory) }}</span>
            <span>Added {{ dateLabel(memory.createdAt) }}</span>
            <span v-if="memory.freshnessAt">Fresh until {{ dateLabel(memory.freshnessAt) }}</span>
            <span>Confidence {{ confidenceLabel(memory.confidence) }}</span>
            <span v-if="memory.sensitivity !== 'internal'" class="memory-badge memory-badge--outline">{{ sensitivityLabel(memory.sensitivity) }}</span>
            <span v-if="memory.legalHold" class="memory-badge memory-badge--hold"><i class="bi bi-lock-fill me-1" aria-hidden="true"></i>Legal hold</span>
          </p>

          <div v-if="expandedId === memory.id" :id="`memory-detail-${memory.id}`" class="memory-row__detail">
            <p class="memory-row__content">{{ memory.content }}</p>
            <dl class="memory-facts">
              <div>
                <dt>Source</dt>
                <dd>
                  {{ memorySourceLabel(memory) }}
                  <template v-if="safeSourceUrl(memory)">
                    · <a :href="safeSourceUrl(memory)" target="_blank" rel="noopener noreferrer">Open source<span class="visually-hidden"> (opens in a new tab)</span></a>
                  </template>
                  <template v-else-if="conversationLink(memory)">
                    · <RouterLink :to="conversationLink(memory)">Open the AI Workspace conversation</RouterLink>
                  </template>
                </dd>
              </div>
              <div v-if="memory.provenance?.sourceId && !conversationLink(memory)"><dt>Source reference</dt><dd class="memory-mono">{{ memory.provenance.sourceId }}</dd></div>
              <div><dt>Source date</dt><dd>{{ dateLabel(memory.sourceAt) }}</dd></div>
              <div><dt>Who can see it</dt><dd>{{ sensitivityLabel(memory.sensitivity) }}</dd></div>
              <div v-if="memory.expiresAt"><dt>Expires</dt><dd>{{ dateLabel(memory.expiresAt) }}</dd></div>
              <div v-if="memory.retentionPolicyId"><dt>Retention policy</dt><dd>{{ memory.retentionPolicyId }}</dd></div>
              <div v-if="correctionSummary(memory)"><dt>History</dt><dd>{{ correctionSummary(memory) }}</dd></div>
            </dl>
            <div class="memory-row__actions">
              <button class="btn btn-outline-primary" type="button" :disabled="!memory.canCorrect" :aria-describedby="memory.canCorrect ? undefined : `memory-blocked-${memory.id}`" @click="openCorrect(memory)">
                <i class="bi bi-pencil me-1" aria-hidden="true"></i>Correct
              </button>
              <button v-if="permissions.canGovern" class="btn btn-outline-secondary" type="button" @click="openGovernance(memory)">
                <i class="bi bi-shield-lock me-1" aria-hidden="true"></i>Retention
              </button>
              <button class="btn btn-outline-danger memory-row__forget" type="button" :disabled="!memory.canForget" :aria-describedby="memory.canForget ? undefined : `memory-blocked-${memory.id}`" @click="openForget(memory)">
                <i class="bi bi-trash3 me-1" aria-hidden="true"></i>Forget
              </button>
              <p v-if="!memory.canForget" :id="`memory-blocked-${memory.id}`" class="memory-row__blocked">{{ memoryChangeBlockedReason(memory) }}</p>
            </div>
          </div>
        </li>
      </ul>

      <nav v-if="pageCount > 1" class="memory-pages" aria-label="Memory pages">
        <button class="btn btn-outline-secondary" type="button" :disabled="filters.page <= 1" @click="goToPage(filters.page - 1)">Previous</button>
        <span>Page {{ filters.page }} of {{ pageCount }}</span>
        <button class="btn btn-outline-secondary" type="button" :disabled="filters.page >= pageCount" @click="goToPage(filters.page + 1)">Next</button>
      </nav>
    </section>

    <AgentMemoryEditorDialog
      :busy="editor.busy"
      :default-project="defaultProjectForNew"
      :error="editor.error"
      :memory="editor.memory"
      :mode="editor.mode"
      :open="editor.open"
      :projects="editableProjects"
      @close="editor.open = false"
      @submit="submitEditor"
    />
    <AgentMemoryGovernanceDialog
      :busy="governance.busy"
      :error="governance.error"
      :memory="governance.memory"
      :open="governance.open"
      @close="governance.open = false"
      @submit="submitGovernance"
    />
    <RequirementsConfirmDialog
      :busy="forget.busy"
      confirm-label="Forget"
      :error="forget.error"
      :open="forget.open"
      title="Forget this memory?"
      @close="forget.open = false"
      @confirm="confirmForget"
    >
      <p class="mb-0">The AI will stop using “{{ forget.memory?.title }}”. It can’t be brought back from this screen.</p>
    </RequirementsConfirmDialog>
    <RequirementsConfirmDialog
      :busy="purge.busy"
      confirm-label="Purge expired"
      :error="purge.error"
      :open="purge.open"
      title="Purge expired memories?"
      @close="purge.open = false"
      @confirm="confirmPurge"
    >
      <p class="mb-0">Every memory in this workspace whose expiry date has passed will be forgotten. Memories on legal hold are kept.</p>
    </RequirementsConfirmDialog>
  </div>
</template>

<style scoped>
.memory-page { padding: 1rem 1.5rem 2rem; font-size: 0.875rem; }
.memory-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.memory-header h1 { margin: 0; padding: 0; border-bottom: 0; font-size: 1.375rem !important; }
.memory-header p { max-width: 48rem; margin: 0.25rem 0 0; color: var(--bs-secondary-color); }
.memory-header__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.memory-header__actions .btn,
.memory-filters .btn,
.memory-row__actions .btn,
.memory-pages .btn { min-height: 2.75rem; font-size: 0.875rem; }
/* Bootstrap's secondary grey is under 4.5:1 on the light page background. */
.memory-page .btn-outline-secondary { --bs-btn-color: #495057; --bs-btn-border-color: #6c757d; }
.memory-status:empty { display: none; }
.memory-status { margin-bottom: 1rem; }
.memory-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 0.5rem; padding: 0.75rem 0; border-block: 1px solid var(--bs-border-color); }
.memory-filters label { display: grid; gap: 0.25rem; min-width: 10rem; font-size: 0.75rem; font-weight: 600; }
.memory-filters__search { flex: 1 1 14rem; }
.memory-filters .form-control,
.memory-filters .form-select { min-height: 2.75rem; font-size: 0.875rem; }
.memory-filters__buttons { display: flex; gap: 0.5rem; }
.memory-list-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.5rem; margin: 1rem 0 0.5rem; }
.memory-list-head h2 { margin: 0; font-size: 1rem; }
.memory-muted { color: var(--bs-secondary-color); }
.memory-empty { padding: 1.5rem 1rem; color: var(--bs-secondary-color); text-align: center; }
.memory-list { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
.memory-row { border: 1px solid var(--bs-border-color); border-radius: 0.5rem; background: var(--bs-body-bg); }
.memory-row--open { border-color: var(--bs-primary-border-subtle, var(--bs-border-color)); }
/* assets/legacy/header.css sizes h3 with !important and rules it off with a border. */
.memory-row__heading { margin: 0; padding: 0; border-bottom: 0; font-size: 0.9375rem !important; }
.memory-row__toggle { display: flex; align-items: center; gap: 0.5rem; width: 100%; min-height: 2.75rem; padding: 0.5rem 0.75rem 0.25rem; border: 0; background: transparent; color: var(--bs-body-color); font-weight: 600; text-align: left; overflow-wrap: anywhere; }
.memory-row__toggle:focus-visible,
.memory-row a:focus-visible { outline: 0.18rem solid var(--bs-primary); outline-offset: 0.1rem; }
.memory-row__chevron { flex: none; transition: transform 0.15s ease; }
.memory-row--open .memory-row__chevron { transform: rotate(90deg); }
.memory-row__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; margin: 0; padding: 0 0.75rem 0.6rem 2.25rem; color: var(--bs-secondary-color); font-size: 0.75rem; }
.memory-badge { display: inline-flex; align-items: center; padding: 0.1rem 0.45rem; border-radius: 999px; background: var(--bs-secondary-bg); color: var(--bs-body-color); font-weight: 600; }
.memory-badge--outline { border: 1px solid var(--bs-border-color); background: transparent; }
.memory-badge--hold { background: var(--bs-warning-bg-subtle, #fff3cd); color: var(--bs-warning-text-emphasis, #664d03); }
.memory-row__detail { display: grid; gap: 0.75rem; padding: 0.75rem 0.75rem 0.75rem 2.25rem; border-top: 1px solid var(--bs-border-color); }
.memory-row__content { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.memory-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: 0.5rem 1rem; margin: 0; }
.memory-facts dt { color: var(--bs-secondary-color); font-size: 0.75rem; font-weight: 600; }
.memory-facts dd { margin: 0; overflow-wrap: anywhere; }
.memory-mono { font-family: var(--font-mono, monospace); font-size: 0.75rem; }
.memory-row a { color: var(--accent, var(--bs-link-color)); }
.memory-row__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.memory-row__forget { margin-inline-start: auto; }
.memory-row__blocked { flex-basis: 100%; margin: 0; color: var(--bs-secondary-color); font-size: 0.75rem; }
.memory-pages { display: flex; align-items: center; justify-content: center; gap: 0.75rem; margin-top: 1rem; }

html.dark .memory-badge--hold { background: rgba(201, 171, 104, 0.18); color: #e2c27a; }

@media (max-width: 48rem) {
  .memory-page { padding: 0.75rem; }
  .memory-header { display: grid; }
  .memory-header__actions .btn { flex: 1; }
  .memory-filters label { min-width: 100%; }
  .memory-filters__buttons { width: 100%; }
  .memory-filters__buttons .btn { flex: 1; }
  .memory-row__meta,
  .memory-row__detail { padding-left: 0.75rem; }
  .memory-row__forget { margin-inline-start: 0; }
}
</style>
