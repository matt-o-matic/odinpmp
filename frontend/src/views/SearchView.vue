<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { apiClient, authSession } from '../lib/auth/index.js';
import { projectStore } from '../lib/projects/index.js';
import {
  SEARCH_CATEGORIES,
  buildSearchRequest,
  buildSearchRouteQuery,
  groupSearchResults,
  parseSearchRouteQuery,
  searchPageCount,
  searchResultLink,
  searchSnippet,
  searchTypeLabel,
} from '../lib/search/enterprise-search.js';

const route = useRoute();
const router = useRouter();

const criteria = computed(() => parseSearchRouteQuery(route.query));
const draft = ref(criteria.value.q);
const result = ref({ records: [], total: 0 });
const loading = ref(false);
const errorMessage = ref('');
let controller = null;

const projects = computed(() => [...(projectStore.state.projects ?? [])].sort((left, right) => String(left.name).localeCompare(String(right.name))));
const projectNames = computed(() => new Map(projects.value.map((project) => [project.id, project.name])));
const groups = computed(() => groupSearchResults(result.value.records));
const pageCount = computed(() => searchPageCount(result.value.total));
const summary = computed(() => {
  const total = Number(result.value.total ?? 0);
  return `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'} for “${criteria.value.q}”`;
});

function navigate(changes) {
  const next = { ...criteria.value, page: 1, ...changes };
  return router.push({ name: 'search', query: buildSearchRouteQuery(next) });
}

function submitSearch() {
  navigate({ q: draft.value });
}

function changePage(delta) {
  const page = Math.min(pageCount.value, Math.max(1, criteria.value.page + delta));
  if (page !== criteria.value.page) navigate({ page });
}

async function runSearch() {
  controller?.abort();
  const { q } = criteria.value;
  if (!q) {
    result.value = { records: [], total: 0 };
    errorMessage.value = '';
    loading.value = false;
    return;
  }
  const current = new AbortController();
  controller = current;
  loading.value = true;
  errorMessage.value = '';
  try {
    const value = await apiClient.withSignal(current.signal).searchEnterprise(buildSearchRequest(criteria.value), authSession.state.token);
    if (controller === current) result.value = value;
  } catch (error) {
    if (controller !== current || error?.name === 'AbortError') return;
    result.value = { records: [], total: 0 };
    errorMessage.value = error?.message ?? 'Search is unavailable right now.';
  } finally {
    if (controller === current) loading.value = false;
  }
}

// Keyed on the parsed criteria so unrelated query changes (the AI Workspace flag) don't re-run it.
watch(() => JSON.stringify(criteria.value), () => {
  if (route.name !== 'search') return;
  draft.value = criteria.value.q;
  runSearch();
});

onMounted(() => {
  runSearch();
  if (!projectStore.state.projects.length && authSession.state.token) projectStore.loadProjects({ background: true }).catch(() => null);
});

onBeforeUnmount(() => {
  controller?.abort();
});
</script>

<template>
  <div class="search-page">
    <header class="search-header">
      <h1>Search</h1>
      <p v-if="criteria.q && !loading && !errorMessage" role="status">{{ summary }}</p>
    </header>

    <form class="search-filters" role="search" aria-label="Search results" @submit.prevent="submitSearch">
      <div class="search-filters__field search-filters__query">
        <label for="search-page-query">Search</label>
        <span class="search-filters__input">
          <input id="search-page-query" v-model="draft" type="search" maxlength="500" autocomplete="off" placeholder="Projects, work items, posts…" />
          <button class="btn btn-primary" type="submit" aria-label="Run search"><i class="bi bi-search" aria-hidden="true"></i></button>
        </span>
      </div>
      <div class="search-filters__field">
        <label for="search-page-type">Type</label>
        <select id="search-page-type" :value="criteria.category" @change="navigate({ category: $event.target.value })">
          <option value="">All types</option>
          <option v-for="category in SEARCH_CATEGORIES" :key="category.key" :value="category.key">{{ category.label }}</option>
        </select>
      </div>
      <div class="search-filters__field">
        <label for="search-page-project">Project</label>
        <select id="search-page-project" :value="criteria.projectId" @change="navigate({ projectId: $event.target.value })">
          <option value="">All projects</option>
          <option v-if="criteria.projectId && !projectNames.has(criteria.projectId)" :value="criteria.projectId">{{ criteria.projectId }}</option>
          <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </div>
    </form>

    <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>

    <section v-if="!criteria.q" class="search-empty" aria-labelledby="search-prompt-title">
      <i class="bi bi-search" aria-hidden="true"></i>
      <h2 id="search-prompt-title">Search your workspace</h2>
      <p>Find projects, epics, stories, tasks, risks, milestones, portfolio records, agent goals, channels, posts and channel files you have access to.</p>
    </section>

    <p v-else-if="loading" class="search-empty" role="status">Searching…</p>

    <section v-else-if="!errorMessage && !result.records.length" class="search-empty" aria-labelledby="search-none-title">
      <i class="bi bi-inbox" aria-hidden="true"></i>
      <h2 id="search-none-title">No matches</h2>
      <p>Try different words{{ criteria.category || criteria.projectId ? ', or clear the type and project filters' : '' }}.</p>
    </section>

    <template v-else-if="!errorMessage">
      <section v-for="group in groups" :key="group.key" class="search-group" :aria-labelledby="`search-group-${group.key}`">
        <h2 :id="`search-group-${group.key}`"><i class="bi" :class="group.icon" aria-hidden="true"></i> {{ group.label }} <span class="search-group__count">{{ group.records.length }}</span></h2>
        <ul class="search-results">
          <li v-for="record in group.records" :key="`${record.documentType}:${record.sourceId ?? record.id}`">
            <div class="search-result__head">
              <RouterLink class="search-result__title" :to="searchResultLink(record)">{{ record.title }}</RouterLink>
              <span class="search-result__type">{{ searchTypeLabel(record.documentType) }}</span>
            </div>
            <p class="search-result__meta">
              <!-- Engagements are not in the project list, so channel rows carry their project's name. -->
              <span v-if="record.projectId"><i class="bi bi-folder2" aria-hidden="true"></i> {{ projectNames.get(record.projectId) ?? record.facets?.project ?? 'Project' }}</span>
              <span v-if="record.documentType === 'file' && record.facets?.channel"><i class="bi bi-hash" aria-hidden="true"></i> {{ record.facets.channel.replace(/^#/, '') }}</span>
              <span v-if="record.facets?.status">Status: {{ record.facets.status }}</span>
              <span v-if="record.facets?.impact">Impact: {{ record.facets.impact }}</span>
            </p>
            <p v-if="searchSnippet(record.content)" class="search-result__snippet">{{ searchSnippet(record.content) }}</p>
          </li>
        </ul>
      </section>

      <nav v-if="pageCount > 1" class="search-pagination" aria-label="Search result pages">
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="criteria.page <= 1" @click="changePage(-1)">Previous</button>
        <span>Page {{ criteria.page }} of {{ pageCount }}</span>
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="criteria.page >= pageCount" @click="changePage(1)">Next</button>
      </nav>
    </template>
  </div>
</template>

<style scoped>
.search-page { padding: 1rem 1.5rem 2rem; font-size: 0.875rem; line-height: 1.25; }
.search-header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem; }
.search-header h1 { font-size: 1.375rem; line-height: 1.2; margin: 0; }
.search-header p { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
.search-filters { display: flex; align-items: end; flex-wrap: wrap; gap: 0.5rem; padding: 0.75rem 0; border-block: 1px solid var(--bs-border-color); margin-bottom: 1rem; }
.search-filters__field { display: grid; gap: 0.25rem; min-width: 12rem; }
.search-filters label { font-size: 0.75rem; font-weight: 600; }
.search-filters__query { flex: 1; }
.search-filters__input { display: flex; gap: 0.25rem; }
.search-filters input, .search-filters select { min-height: 2.75rem; width: 100%; padding: 0.5rem; border: 1px solid var(--bs-border-color); border-radius: 0.375rem; background: var(--bs-body-bg); color: var(--bs-body-color); font-size: 0.875rem; font-weight: 400; }
.search-filters__input .btn { min-width: 2.75rem; min-height: 2.75rem; }
.search-empty { display: grid; justify-items: center; gap: 0.5rem; padding: 2rem 1rem; text-align: center; color: var(--muted); }
.search-empty i { font-size: 1.5rem; }
.search-empty h2 { font-size: 1.125rem; margin: 0; color: var(--bs-body-color); }
.search-empty p { margin: 0; max-width: 60ch; }
.search-group + .search-group { margin-top: 1rem; }
.search-group h2 { display: flex; align-items: center; gap: 0.5rem; font-size: 1rem; line-height: 1.2; margin: 0 0 0.5rem; }
.search-group__count { padding: 0 0.5rem; border: 1px solid var(--bs-border-color); border-radius: 999px; font-size: 0.75rem; font-weight: 600; color: var(--muted); }
.search-results { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
.search-results li { padding: 0.75rem; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface); }
.search-result__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.search-result__title { color: var(--accent); display: inline-flex; align-items: center; min-height: 2.75rem; font-weight: 600; overflow-wrap: anywhere; }
.search-result__type { flex-shrink: 0; padding: 0.125rem 0.5rem; border-radius: 999px; background: var(--surface-tint); color: var(--ink); font-size: 0.75rem; }
.search-result__meta { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; margin: 0; color: var(--muted); font-size: 0.75rem; }
.search-result__snippet { margin: 0.25rem 0 0; max-width: 120ch; overflow-wrap: anywhere; }
.search-pagination { display: flex; align-items: center; justify-content: center; gap: 0.75rem; margin-top: 1rem; }
.search-pagination .btn { min-height: 2.75rem; color: var(--ink-soft); border-color: var(--line-strong); }
.search-pagination .btn:hover:not(:disabled) { background: var(--surface-soft); }
.search-filters input:focus-visible, .search-filters select:focus-visible, .search-result__title:focus-visible { outline: 0.18rem solid var(--bs-primary); outline-offset: 0.1rem; }
@media (max-width: 48rem) {
  .search-page { padding: 0.75rem; }
  .search-filters { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: stretch; }
  .search-filters__field { min-width: 0; }
  .search-filters__query { grid-column: 1 / -1; }
  .search-result__head { align-items: flex-start; }
}
</style>
