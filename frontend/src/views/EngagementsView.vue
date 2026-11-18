<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import RequirementsDialog from '../components/requirements/RequirementsDialog.vue';
import { apiClient, authSession } from '../lib/auth/index.js';
import { isWorkspaceAdmin } from '../lib/auth/access.js';
import {
  ENGAGEMENT_STATUS_FILTERS,
  engagementErrorMessage,
  engagementStatusCounts,
  engagementStatusIcon,
  engagementStatusLabel,
  filterEngagements,
  formatLastActivity,
  normalizeEngagementStatusFilter,
} from '../lib/engagements/engagements.js';
import { useWorkspaceLiveRefresh } from '../lib/live/live-refresh.js';
import { unreadLabel } from '../lib/channels/channels.js';
import { workspaceModules } from '../lib/workspace/index.js';
import { takeNewQuery } from '../lib/workspace/work-menu.js';

// The Engagements page: the sales engagements the person can see, filtered by status (kept in
// the address), and "New engagement".
const route = useRoute();
const router = useRouter();

const engagements = ref([]);
const loaded = ref(false);
const loadError = ref('');
const moduleOff = ref(false);
const status = computed(() => normalizeEngagementStatusFilter(route.query.status));
const query = ref(String(route.query.q ?? ''));
const counts = computed(() => engagementStatusCounts(engagements.value));
const rows = computed(() => filterEngagements(engagements.value, { query: query.value, status: status.value }));
const canSwitchModules = computed(() => isWorkspaceAdmin(authSession.state.currentUser));

const creating = reactive({ busy: false, customer: '', error: '', name: '', open: false });

function setStatus(value) {
  router.replace({ query: { ...route.query, status: value === 'open' ? undefined : value } });
}

watch(query, (value) => {
  router.replace({ query: { ...route.query, q: value.trim() ? value : undefined } });
});

function engagementLocation(engagement) {
  // A won engagement is a delivery project now.
  return engagement.kind === 'delivery'
    ? { name: 'project-detail', params: { projectId: engagement.id } }
    : { name: 'engagement-detail', params: { projectId: engagement.id } };
}

// New posts anywhere change the unread counts.
useWorkspaceLiveRefresh(['projects'], () => { if (loaded.value && !moduleOff.value) void load(); });

async function load() {
  loadError.value = '';
  try {
    const result = await apiClient.listEngagements(authSession.state.token);
    engagements.value = Array.isArray(result?.engagements) ? result.engagements : [];
    moduleOff.value = false;
  } catch (error) {
    if (error?.data?.details?.code === 'module_disabled') {
      moduleOff.value = true;
      workspaceModules.apply([]);
    } else {
      loadError.value = engagementErrorMessage(error, 'Engagements could not load.');
    }
  } finally {
    loaded.value = true;
  }
}

function openCreate() {
  Object.assign(creating, { busy: false, customer: '', error: '', name: '', open: true });
}

async function submitCreate() {
  if (creating.busy) return;
  const name = creating.name.trim();
  const customer = creating.customer.trim();
  if (!name || !customer) {
    creating.error = !name ? 'Enter a name for the engagement.' : 'Enter the customer.';
    return;
  }
  creating.busy = true;
  creating.error = '';
  try {
    const result = await apiClient.createEngagement({ customer, name }, authSession.state.token);
    creating.open = false;
    // A new engagement opens on its General channel.
    await router.push({ name: 'engagement-detail', params: { projectId: result.project.id, section: 'channels' }, query: { channel: 'general' } });
  } catch (error) {
    creating.error = engagementErrorMessage(error, 'The engagement could not be created.');
  } finally {
    creating.busy = false;
  }
}

// The top bar's "New engagement…" lands here as ?new=engagement.
function openCreateFromRoute() {
  const { open, query: rest } = takeNewQuery(route.query, 'engagement');
  if (!open) return;
  openCreate();
  router.replace({ query: rest }).catch(() => null);
}
watch(() => route.query.new, openCreateFromRoute);

onMounted(() => {
  openCreateFromRoute();
  return load();
});
</script>

<template>
  <section class="dashboard-panel engagements-page">
    <header class="engagements-head">
      <h1 class="engagements-head__title">Engagements</h1>
      <button v-if="!moduleOff" class="primary-button" type="button" @click="openCreate">
        <i class="bi bi-plus-lg" aria-hidden="true"></i> New engagement
      </button>
    </header>

    <div v-if="moduleOff" class="engagements-notice" role="status">
      <i class="bi bi-info-circle" aria-hidden="true"></i>
      <span>
        The Consulting module is switched off for this workspace.
        <RouterLink v-if="canSwitchModules" :to="{ name: 'admin', query: { section: 'modules' } }">Switch it on in Tenant Admin</RouterLink>
      </span>
    </div>
    <div v-else-if="loadError" class="error-banner" role="alert">
      {{ loadError }}
      <button class="ghost-button ghost-button--compact ms-2" type="button" @click="load">Try again</button>
    </div>

    <template v-if="!moduleOff">
      <div class="engagements-toolbar">
        <div class="engagements-search">
          <label class="visually-hidden" for="engagements-filter">Filter engagements</label>
          <i class="bi bi-search" aria-hidden="true"></i>
          <input id="engagements-filter" v-model="query" class="form-control" autocomplete="off" placeholder="Filter by name, customer or owner" type="search" />
        </div>
        <fieldset class="rq-seg engagements-status">
          <legend class="visually-hidden">Status</legend>
          <label v-for="option in ENGAGEMENT_STATUS_FILTERS" :key="option.id" class="rq-seg__option">
            <input type="radio" name="engagements-status" :value="option.id" :checked="status === option.id" @change="setStatus(option.id)" />
            <span>{{ option.label }}<span class="engagements-status__count">{{ counts[option.id] }}</span></span>
          </label>
        </fieldset>
      </div>

      <div class="table-responsive engagements-table-wrap">
        <table class="table table-sm table-hover align-middle engagements-table">
          <caption class="visually-hidden">Engagements, {{ rows.length }} shown</caption>
          <thead>
            <tr>
              <th scope="col">Engagement</th>
              <th scope="col">Customer</th>
              <th scope="col">Owner</th>
              <th scope="col">Status</th>
              <th scope="col">Last activity</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="engagement in rows" :key="engagement.id">
              <th scope="row">
                <RouterLink :to="engagementLocation(engagement)">{{ engagement.name }}</RouterLink>
                <span v-if="engagement.unreadCount > 0" class="engagements-unread">{{ unreadLabel(engagement.unreadCount) }} unread</span>
              </th>
              <td>{{ engagement.customer }}</td>
              <td>{{ engagement.ownerName || '—' }}</td>
              <td>
                <span class="engagements-status-chip" :class="`engagements-status-chip--${engagement.status}`">
                  <i class="bi" :class="engagementStatusIcon(engagement.status)" aria-hidden="true"></i>{{ engagementStatusLabel(engagement.status) }}
                </span>
              </td>
              <td>{{ formatLastActivity(engagement.lastActivityAt) }}</td>
            </tr>
            <tr v-if="!loaded">
              <td colspan="5" class="engagements-empty">Loading engagements…</td>
            </tr>
            <tr v-else-if="!rows.length && !loadError">
              <td colspan="5" class="engagements-empty">
                <template v-if="!engagements.length">No engagements yet.</template>
                <template v-else-if="query.trim()">No engagements match.</template>
                <template v-else>No {{ engagementStatusLabel(status).toLowerCase() }} engagements.</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <RequirementsDialog :busy="creating.busy" :open="creating.open" title="New engagement" @close="creating.open = false" @submit="submitCreate">
      <div class="rq-field">
        <label for="engagement-name">Name</label>
        <input id="engagement-name" v-model="creating.name" class="form-control" maxlength="160" autocomplete="off" required />
      </div>
      <div class="rq-field">
        <label for="engagement-customer">Customer</label>
        <input id="engagement-customer" v-model="creating.customer" class="form-control" maxlength="255" autocomplete="off" required />
      </div>
      <p v-if="creating.error" class="error-banner mb-0" role="alert">{{ creating.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="creating.busy" @click="creating.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="creating.busy">{{ creating.busy ? 'Creating…' : 'Create engagement' }}</button>
      </template>
    </RequirementsDialog>
  </section>
</template>

<style scoped>
.engagements-page {
  display: grid;
  gap: 0.75rem;
  font-size: 0.875rem;
}

.engagements-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.engagements-head__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  line-height: 1.2;
}

.engagements-notice {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
  background: var(--bs-tertiary-bg);
}

.engagements-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

.engagements-search {
  position: relative;
  flex: 1 1 16rem;
  max-width: 28rem;
}

.engagements-search i {
  position: absolute;
  top: 50%;
  left: 0.75rem;
  transform: translateY(-50%);
  color: var(--bs-secondary-color);
}

.engagements-search input {
  min-height: 2.75rem;
  padding-left: 2.25rem;
}

.engagements-status__count {
  margin-left: 0.35rem;
  color: var(--bs-secondary-color);
  font-variant-numeric: tabular-nums;
}

.engagements-table {
  margin: 0;
}

.engagements-table th[scope='row'] a {
  font-weight: 600;
}

.engagements-unread {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
}

html.dark .engagements-unread {
  color: #0b1220;
}

.engagements-status-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.engagements-status-chip--won {
  font-weight: 600;
}

.engagements-status-chip--lost {
  color: var(--bs-secondary-color);
}

.engagements-empty {
  padding: 1rem;
  color: var(--bs-secondary-color);
  text-align: center;
}
</style>
