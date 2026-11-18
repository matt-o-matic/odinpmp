<script setup>
import { computed, onMounted, ref, watch } from 'vue';

import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { projectStore } from '../../lib/projects/index.js';
import {
  DELETED_PROJECT_SORTS,
  filterDeletedProjects,
  formatDeletedAt,
  paginate,
} from '../../lib/projects/project-deletion.js';

// Tenant admin list of soft-deleted projects, with a confirmed Restore for each.
const PAGE_SIZE = 10;

const projects = ref([]);
const loading = ref(false);
const loadError = ref('');
const notice = ref('');
const query = ref('');
const sort = ref('deletedAt');
const page = ref(1);
const restoreTarget = ref(null);
const restoreBusy = ref(false);
const restoreError = ref('');

const filtered = computed(() => filterDeletedProjects(projects.value, { query: query.value, sort: sort.value }));
const pageView = computed(() => paginate(filtered.value, page.value, PAGE_SIZE));

watch([query, sort], () => {
  page.value = 1;
});

async function loadDeletedProjects() {
  if (!authSession.state.token) return;
  loading.value = true;
  loadError.value = '';
  try {
    const result = await apiClient.listDeletedProjects(authSession.state.token);
    projects.value = Array.isArray(result.projects) ? result.projects : [];
  } catch (error) {
    loadError.value = error.message ?? 'Unable to load deleted projects.';
  } finally {
    loading.value = false;
  }
}

function openRestore(project) {
  restoreError.value = '';
  notice.value = '';
  restoreTarget.value = project;
}

function closeRestore() {
  if (restoreBusy.value) return;
  restoreTarget.value = null;
}

async function confirmRestore() {
  const target = restoreTarget.value;
  if (!target || restoreBusy.value) return;
  restoreBusy.value = true;
  restoreError.value = '';
  try {
    await apiClient.restoreDeletedProject(target.id, authSession.state.token);
    projects.value = projects.value.filter((project) => project.id !== target.id);
    restoreTarget.value = null;
    notice.value = `Restored ${target.name}. It is back in the project list for its members.`;
    projectStore.loadProjects({ background: true }).catch(() => null);
  } catch (error) {
    restoreError.value = error?.status === 404
      ? 'This project is no longer in the deleted list. Refresh to see the current list.'
      : error.message ?? 'Unable to restore the project.';
  } finally {
    restoreBusy.value = false;
  }
}

onMounted(loadDeletedProjects);
</script>

<template>
  <section class="card mb-3 deleted-projects" aria-labelledby="deleted-projects-heading">
    <div class="card-header">
      <h4 id="deleted-projects-heading" class="deleted-projects__title">Restore deleted projects</h4>
    </div>
    <div class="card-body">
      <p class="deleted-projects__intro">
        Deleted projects are hidden from every list, search, report and the AI Workspace. Nothing in them was erased;
        restoring a project brings it back with its work items, tickets, comments and files.
      </p>

      <div v-if="notice" class="success-banner d-flex align-items-start justify-content-between gap-2 mb-3" role="status">
        <span>{{ notice }}</span>
        <button class="btn-close flex-shrink-0" type="button" aria-label="Dismiss message" @click="notice = ''"></button>
      </div>
      <div v-if="loadError" class="error-banner mb-3" role="alert">{{ loadError }}</div>

      <div class="deleted-projects__filters">
        <label class="deleted-projects__field deleted-projects__field--grow">
          <span>Search deleted projects</span>
          <input v-model="query" class="form-control" type="search" placeholder="Project name or who deleted it" />
        </label>
        <label class="deleted-projects__field">
          <span>Sort by</span>
          <select v-model="sort" class="form-select">
            <option v-for="(label, key) in DELETED_PROJECT_SORTS" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>
        <button class="btn btn-outline-secondary deleted-projects__refresh" type="button" :disabled="loading" @click="loadDeletedProjects">
          <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
          {{ loading ? 'Loading…' : 'Refresh' }}
        </button>
      </div>

      <p v-if="!loading && !loadError && projects.length === 0" class="deleted-projects__empty">No deleted projects.</p>
      <p v-else-if="!loading && filtered.length === 0 && projects.length > 0" class="deleted-projects__empty">No deleted projects match your search.</p>

      <ul v-if="pageView.items.length" class="deleted-projects__list" aria-label="Deleted projects">
        <li v-for="project in pageView.items" :key="project.id" class="deleted-projects__row">
          <div class="deleted-projects__info">
            <strong class="deleted-projects__name">{{ project.name }}</strong>
            <span class="deleted-projects__meta">
              Deleted {{ formatDeletedAt(project.deletedAt) }}<template v-if="project.deletedByName"> by {{ project.deletedByName }}</template>
              <template v-if="project.status"> · Status when deleted: {{ project.status }}</template>
            </span>
          </div>
          <button
            class="btn btn-outline-primary deleted-projects__restore"
            type="button"
            :aria-label="`Restore ${project.name}`"
            @click="openRestore(project)"
          >
            <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>
            Restore
          </button>
        </li>
      </ul>

      <nav v-if="pageView.pageCount > 1" class="deleted-projects__pager" aria-label="Deleted projects pages">
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="pageView.page <= 1" @click="page = pageView.page - 1">Previous</button>
        <span>Page {{ pageView.page }} of {{ pageView.pageCount }}</span>
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="pageView.page >= pageView.pageCount" @click="page = pageView.page + 1">Next</button>
      </nav>
    </div>

    <RequirementsConfirmDialog
      :busy="restoreBusy"
      confirm-label="Restore project"
      :error="restoreError"
      :open="Boolean(restoreTarget)"
      title="Restore this project?"
      @close="closeRestore"
      @confirm="confirmRestore"
    >
      <p class="mb-0">
        <strong>{{ restoreTarget?.name }}</strong> will reappear for its members with everything it had when it was deleted.
      </p>
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.deleted-projects {
  font-size: 0.875rem;
}

.deleted-projects__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.deleted-projects__refresh,
.deleted-projects__restore,
.deleted-projects__pager .btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 2.75rem;
}

.deleted-projects__intro {
  margin-bottom: 1rem;
  color: var(--bs-secondary-color);
}

.deleted-projects__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.deleted-projects__field {
  display: grid;
  gap: 0.25rem;
  min-width: 11rem;
  font-size: 0.75rem;
  font-weight: 600;
}

.deleted-projects__field--grow {
  flex: 1 1 16rem;
}

.deleted-projects__field .form-control,
.deleted-projects__field .form-select {
  min-height: 2.75rem;
  font-size: 0.875rem;
}

.deleted-projects__empty {
  margin: 0;
  color: var(--bs-secondary-color);
}

.deleted-projects__list {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--bs-border-color);
}

.deleted-projects__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--bs-border-color);
}

.deleted-projects__info {
  display: grid;
  gap: 0.2rem;
  min-width: 0;
  flex: 1 1 16rem;
}

.deleted-projects__name {
  overflow-wrap: anywhere;
}

.deleted-projects__meta {
  color: var(--bs-secondary-color);
  font-size: 0.75rem;
}

.deleted-projects__pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

@media (max-width: 575.98px) {
  .deleted-projects__restore {
    width: 100%;
    justify-content: center;
  }
}
</style>
