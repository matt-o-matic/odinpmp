<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, onBeforeRouteLeave, onBeforeRouteUpdate, useRoute } from 'vue-router';

import RequirementsConfirmDialog from '../components/requirements/RequirementsConfirmDialog.vue';
import '../components/admin/admin-screens.css';
import {
  TICKET_CONFIG_KINDS,
  TICKET_CONFIG_NAME_MAX,
  addTicketConfigDraftRow,
  buildTicketConfigPayload,
  createTicketConfigDraft,
  filterTicketConfigEntries,
  moveTicketConfigDraftRow,
  removeNewTicketConfigDraftRow,
  setTicketConfigDraftStatus,
  sortTicketConfigEntries,
  ticketConfigDraftChanged,
  validateTicketConfigDraft,
} from '../lib/admin/ticket-config-draft.js';
import { apiClient, authSession } from '../lib/auth/index.js';

const route = useRoute();
const token = computed(() => authSession.state.token);
const kind = computed(() => (TICKET_CONFIG_KINDS.some((item) => item.key === route.params.kind) ? route.params.kind : 'environments'));
const kindMeta = computed(() => TICKET_CONFIG_KINDS.find((item) => item.key === kind.value));

const entries = ref([]);
const revision = ref('');
const projects = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const notice = ref('');
const conflict = ref(false);

const query = ref('');
const scopeFilter = ref('all');
const statusFilter = ref('active');

const editing = ref(false);
const saving = ref(false);
const rows = ref([]);
const rowErrors = ref({});
const discardOpen = ref(false);
let pendingLeave = null;

const projectNames = computed(() => new Map(projects.value.map((project) => [project.id, project.name])));
const visibleEntries = computed(() => filterTicketConfigEntries(entries.value, { query: query.value, scope: scopeFilter.value, status: statusFilter.value }));
// Positions follow the saved order across the whole list, so filtered rows keep their real place.
const positionById = computed(() => new Map(sortTicketConfigEntries(entries.value).map((entry, index) => [entry.id, index + 1])));
const counts = computed(() => ({
  active: entries.value.filter((entry) => entry.status !== 'inactive').length,
  inactive: entries.value.filter((entry) => entry.status === 'inactive').length,
}));
const dirty = computed(() => editing.value && ticketConfigDraftChanged(rows.value, entries.value));
// Entries scoped to a project the admin cannot list still need a readable option.
const projectChoices = computed(() => {
  const known = [...projects.value];
  for (const entry of entries.value) {
    if (entry.projectId && !projectNames.value.has(entry.projectId)) known.push({ id: entry.projectId, name: `Unlisted project (${entry.projectId.slice(0, 8)})` });
  }
  return known;
});

function scopeLabel(projectId) {
  if (!projectId) return 'All projects';
  return projectNames.value.get(projectId) ?? `Unlisted project (${String(projectId).slice(0, 8)})`;
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [result, projectList] = await Promise.all([
      apiClient.listTicketConfig(kind.value, token.value),
      apiClient.getProjects(token.value).catch(() => ({ projects: [] })),
    ]);
    entries.value = result.entries ?? [];
    revision.value = result.revision ?? '';
    projects.value = [...(projectList?.projects ?? [])].sort((left, right) => String(left.name).localeCompare(String(right.name)));
  } catch (error) {
    errorMessage.value = error.message ?? `Unable to load ${kindMeta.value.label.toLowerCase()}.`;
  } finally {
    loading.value = false;
  }
}

function startEditing() {
  rows.value = createTicketConfigDraft(entries.value);
  rowErrors.value = {};
  notice.value = '';
  conflict.value = false;
  editing.value = true;
}

function stopEditing() {
  editing.value = false;
  rows.value = [];
  rowErrors.value = {};
}

function requestCancel() {
  if (dirty.value) {
    pendingLeave = null;
    discardOpen.value = true;
    return;
  }
  stopEditing();
}

function confirmDiscard() {
  discardOpen.value = false;
  stopEditing();
  const next = pendingLeave;
  pendingLeave = null;
  next?.(true);
}

function addRow() {
  rows.value = addTicketConfigDraftRow(rows.value);
}

function moveRow(row, delta) {
  rows.value = moveTicketConfigDraftRow(rows.value, row.key, delta);
}

function setStatus(row, status) {
  rows.value = setTicketConfigDraftStatus(rows.value, row.key, status);
}

function removeRow(row) {
  rows.value = removeNewTicketConfigDraftRow(rows.value, row.key);
}

async function save() {
  rowErrors.value = validateTicketConfigDraft(rows.value);
  if (Object.keys(rowErrors.value).length) {
    errorMessage.value = 'Fix the highlighted entries before saving.';
    return;
  }
  saving.value = true;
  errorMessage.value = '';
  try {
    await apiClient.saveTicketConfig(kind.value, buildTicketConfigPayload(rows.value, revision.value), token.value);
    stopEditing();
    await load();
    notice.value = `${kindMeta.value.label} saved.`;
  } catch (error) {
    if (error?.status === 409) {
      conflict.value = true;
      errorMessage.value = 'Another administrator saved this list after you started editing. Reload to see their changes, then make your edits again.';
    } else {
      errorMessage.value = error.message ?? `Unable to save ${kindMeta.value.label.toLowerCase()}.`;
    }
  } finally {
    saving.value = false;
  }
}

async function reloadAfterConflict() {
  stopEditing();
  conflict.value = false;
  await load();
}

watch(kind, () => {
  stopEditing();
  notice.value = '';
  query.value = '';
  scopeFilter.value = 'all';
  statusFilter.value = 'active';
  load();
});

// Leaving the screen or switching list while edits are unsaved asks first.
function confirmNavigation() {
  if (!dirty.value) return true;
  return new Promise((resolve) => {
    pendingLeave = resolve;
    discardOpen.value = true;
  });
}

function closeDiscard() {
  discardOpen.value = false;
  const next = pendingLeave;
  pendingLeave = null;
  next?.(false);
}

onBeforeRouteLeave(confirmNavigation);
onBeforeRouteUpdate(confirmNavigation);

onMounted(load);
</script>

<template>
  <div class="adm-page ticket-config-page">
    <header class="adm-header">
      <div>
        <h1>Ticket environments &amp; releases</h1>
        <p>The lists tickets pick from for where a problem was found and which release found or fixed it.</p>
      </div>
      <div class="adm-header-actions">
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="loading || editing" @click="load">
          <i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Refresh
        </button>
      </div>
    </header>

    <nav class="adm-tabs" aria-label="Ticket lists">
      <RouterLink
        v-for="item in TICKET_CONFIG_KINDS"
        :key="item.key"
        :aria-current="kind === item.key ? 'page' : undefined"
        :class="{ active: kind === item.key }"
        :to="{ name: 'ticket-config-admin', params: { kind: item.key === 'environments' ? undefined : item.key } }"
      >
        {{ item.label }}
      </RouterLink>
    </nav>

    <div v-if="errorMessage" class="alert alert-danger d-flex flex-wrap align-items-center justify-content-between gap-2" role="alert">
      <span>{{ errorMessage }}</span>
      <button v-if="conflict" class="btn btn-sm btn-outline-danger" type="button" @click="reloadAfterConflict">Reload list</button>
    </div>
    <p v-if="notice" class="alert alert-success py-2" role="status">{{ notice }}</p>
    <p v-if="loading" class="adm-empty" role="status">Loading {{ kindMeta.label.toLowerCase() }}…</p>

    <section v-else-if="!editing" :aria-labelledby="`ticket-config-${kind}-title`">
      <div class="adm-section-head">
        <h2 :id="`ticket-config-${kind}-title`">{{ kindMeta.label }}</h2>
        <button class="btn btn-sm btn-outline-primary" type="button" @click="startEditing">
          <i class="bi bi-pencil" aria-hidden="true"></i> Edit list
        </button>
        <p>{{ counts.active }} active, {{ counts.inactive }} inactive. Inactive entries stay on tickets that already use them but cannot be picked for new changes.</p>
      </div>

      <div class="adm-toolbar">
        <label class="adm-grow" for="ticket-config-search">Search
          <input id="ticket-config-search" v-model="query" class="form-control" type="search" :placeholder="`Find a ${kindMeta.singular}`" />
        </label>
        <label for="ticket-config-scope">Scope
          <select id="ticket-config-scope" v-model="scopeFilter" class="form-select">
            <option value="all">All scopes</option>
            <option value="tenant">All projects (tenant-wide)</option>
            <option v-for="project in projectChoices" :key="project.id" :value="project.id">{{ project.name }} only</option>
          </select>
        </label>
        <label for="ticket-config-status">Status
          <select id="ticket-config-status" v-model="statusFilter" class="form-select">
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>

      <div class="adm-table-wrap" role="region" :aria-label="`${kindMeta.label} table`" tabindex="0">
        <table class="adm-table">
          <thead><tr><th scope="col">Order</th><th scope="col">Name</th><th scope="col">Available in</th><th scope="col">Status</th></tr></thead>
          <tbody>
            <tr v-for="entry in visibleEntries" :key="entry.id">
              <td>{{ positionById.get(entry.id) }}</td>
              <td>{{ entry.name }}</td>
              <td>{{ scopeLabel(entry.projectId) }}</td>
              <td>
                <span :class="['adm-pill', entry.status === 'inactive' ? 'adm-pill--muted' : 'adm-pill--active']">
                  <i :class="['bi', entry.status === 'inactive' ? 'bi-archive' : 'bi-check2-circle']" aria-hidden="true"></i>{{ entry.status === 'inactive' ? 'Inactive' : 'Active' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!visibleEntries.length" class="adm-empty">{{ entries.length ? `No ${kindMeta.label.toLowerCase()} match these filters.` : `No ${kindMeta.label.toLowerCase()} yet. Choose Edit list to add one.` }}</p>
      </div>
    </section>

    <form v-else class="ticket-config-editor" :aria-labelledby="`ticket-config-${kind}-edit-title`" novalidate @submit.prevent="save">
      <div class="adm-section-head">
        <h2 :id="`ticket-config-${kind}-edit-title`">Editing {{ kindMeta.label.toLowerCase() }}</h2>
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="addRow">
          <i class="bi bi-plus-lg" aria-hidden="true"></i> Add {{ kindMeta.singular }}
        </button>
        <p>Order sets how pickers list entries. Deactivating keeps an entry on existing tickets; there is no delete. Saving replaces the whole list.</p>
      </div>

      <ol class="ticket-config-rows">
        <li v-for="(row, index) in rows" :key="row.key" :class="['ticket-config-row', { 'ticket-config-row--inactive': row.status === 'inactive' }]">
          <div class="ticket-config-row__order">
            <span class="ticket-config-row__position" aria-hidden="true">{{ index + 1 }}</span>
            <button class="btn btn-sm btn-outline-secondary adm-icon-button" type="button" :disabled="index === 0" :aria-label="`Move ${row.name || 'new entry'} up`" @click="moveRow(row, -1)"><i class="bi bi-arrow-up" aria-hidden="true"></i></button>
            <button class="btn btn-sm btn-outline-secondary adm-icon-button" type="button" :disabled="index === rows.length - 1" :aria-label="`Move ${row.name || 'new entry'} down`" @click="moveRow(row, 1)"><i class="bi bi-arrow-down" aria-hidden="true"></i></button>
          </div>
          <div class="ticket-config-row__field">
            <label :for="`ticket-config-name-${row.key}`">Name</label>
            <input
              :id="`ticket-config-name-${row.key}`"
              v-model="row.name"
              class="form-control"
              :maxlength="TICKET_CONFIG_NAME_MAX"
              :aria-invalid="Boolean(rowErrors[row.key])"
              :aria-describedby="rowErrors[row.key] ? `ticket-config-error-${row.key}` : undefined"
            />
            <p v-if="rowErrors[row.key]" :id="`ticket-config-error-${row.key}`" class="adm-field-error">{{ rowErrors[row.key] }}</p>
            <p v-else-if="!row.isNew && row.name.trim() !== row.originalName" class="ticket-config-row__note">Renamed from {{ row.originalName }}</p>
          </div>
          <div class="ticket-config-row__field">
            <label :for="`ticket-config-scope-${row.key}`">Available in</label>
            <select :id="`ticket-config-scope-${row.key}`" v-model="row.projectId" class="form-select">
              <option value="">All projects</option>
              <option v-for="project in projectChoices" :key="project.id" :value="project.id">{{ project.name }}</option>
            </select>
          </div>
          <div class="ticket-config-row__actions">
            <span :class="['adm-pill', row.status === 'inactive' ? 'adm-pill--muted' : 'adm-pill--active']">
              <i :class="['bi', row.status === 'inactive' ? 'bi-archive' : 'bi-check2-circle']" aria-hidden="true"></i>{{ row.status === 'inactive' ? 'Inactive' : 'Active' }}
            </span>
            <button v-if="row.isNew" class="btn btn-sm btn-outline-secondary" type="button" :aria-label="`Remove unsaved ${row.name || 'entry'}`" @click="removeRow(row)">Remove</button>
            <button v-else-if="row.status === 'inactive'" class="btn btn-sm btn-outline-secondary" type="button" :aria-label="`Reactivate ${row.name}`" @click="setStatus(row, 'active')">Reactivate</button>
            <button v-else class="btn btn-sm btn-outline-secondary" type="button" :aria-label="`Deactivate ${row.name}`" @click="setStatus(row, 'inactive')">Deactivate</button>
          </div>
        </li>
      </ol>
      <p v-if="!rows.length" class="adm-empty">The list is empty. Add an entry or cancel.</p>
      <p v-if="rowErrors.list" class="adm-field-error">{{ rowErrors.list }}</p>

      <footer class="ticket-config-editor__footer">
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="saving" @click="requestCancel">Cancel</button>
        <button class="btn btn-sm btn-primary" type="submit" :disabled="saving || conflict || !dirty">{{ saving ? 'Saving…' : `Save ${kindMeta.label.toLowerCase()}` }}</button>
      </footer>
    </form>

    <RequirementsConfirmDialog
      class="adm-dialog"
      :open="discardOpen"
      confirm-label="Discard changes"
      title="Discard unsaved changes?"
      @close="closeDiscard"
      @confirm="confirmDiscard"
    >
      <p class="mb-0">Your edits to {{ kindMeta.label.toLowerCase() }} have not been saved.</p>
    </RequirementsConfirmDialog>
  </div>
</template>

<style scoped>
.ticket-config-rows { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
.ticket-config-row { display: grid; grid-template-columns: auto minmax(12rem, 1.4fr) minmax(10rem, 1fr) auto; gap: 0.75rem; align-items: start; padding: 0.75rem; border: 1px solid var(--bs-border-color); border-radius: 0.5rem; }
.ticket-config-row--inactive { border-style: dashed; }
.ticket-config-row__order { display: flex; align-items: center; gap: 0.25rem; padding-top: 1.25rem; }
.ticket-config-row__position { min-width: 1.5rem; color: var(--bs-secondary-color); font-weight: 600; text-align: right; }
.ticket-config-row__field { display: grid; gap: 0.25rem; }
.ticket-config-row__field label { font-size: 0.75rem; font-weight: 600; }
.ticket-config-row__note { margin: 0; color: var(--bs-secondary-color); font-size: 0.75rem; }
.ticket-config-row__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding-top: 1.25rem; }
.ticket-config-editor__footer { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.75rem; padding: 0.75rem 0; border-top: 1px solid var(--bs-border-color); background: var(--bs-body-bg); }

@media (max-width: 48rem) {
  .ticket-config-row { grid-template-columns: 1fr; }
  .ticket-config-row__order,
  .ticket-config-row__actions { padding-top: 0; }
}
</style>
