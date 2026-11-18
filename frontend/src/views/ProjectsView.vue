<script setup>
import { Offcanvas } from 'bootstrap';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import RichContentEditor from '../components/rich-content/RichContentEditor.vue';
import { withWorkingMode } from '../lib/api/client.js';
import { apiClient, authSession } from '../lib/auth/index.js';
import { useWorkspaceLiveRefresh } from '../lib/live/live-refresh.js';
import { projectStore } from '../lib/projects/index.js';
import {
  PROJECT_STATUS_OPTIONS,
  projectTemplateSummary,
  resolveTemplateProjectStatuses,
  usableTemplates,
} from '../lib/workflows/workflow-templates.js';
import {
  DEFAULT_PROJECT_FILTERS,
  PROJECT_SORTS,
  PROJECT_STATUS_FILTERS,
  buildProjectRows,
  formatProjectDates,
  isArchivedProject,
  projectEndNote,
  projectFiltersFromQuery,
  projectFiltersToQuery,
  projectStatusCounts,
  projectStatusTone,
  reviewDeadline,
  summarizeAttention,
  waitingBreakdown,
  waitingCount,
} from '../lib/projects/project-register.js';
import { trackLabel } from '../lib/requirements/requirements-tracks.js';

function createProjectForm() {
  return {
    description: '',
    endDate: '',
    name: '',
    startDate: '',
    status: 'Planned',
    templateId: '',
  };
}

const router = useRouter();
const route = useRoute();
const errorMessage = ref('');
const noticeMessage = ref(projectStore.takeNotice());
const createErrorMessage = ref('');
const importErrorMessage = ref('');
const importSuccessMessage = ref('');
const importBusy = ref(false);
const importFileInput = ref(null);
const importFilename = ref('');
const importBase64 = ref('');
const importInspection = ref(null);
const pendingImportOverwriteMode = ref('');
const importUserMappings = reactive({});
const createForm = reactive(createProjectForm());
const projectTemplates = ref([]);
const workflowTemplates = ref([]);
const selectedProjectTemplate = computed(() => projectTemplates.value.find((template) => template.id === createForm.templateId) ?? null);
// Set when the chosen template binds a project workflow: the project must start in one of its states.
const templateStatuses = ref(null);
const templateStatusError = ref('');
const createStatusOptions = computed(() => templateStatuses.value?.options ?? PROJECT_STATUS_OPTIONS);
const statusHint = computed(() => templateStatusError.value
  || (templateStatuses.value ? `States of the template’s “${templateStatuses.value.workflowName}” workflow.` : ''));
const canImportProject = computed(() => authSession.state.currentUser?.role === 'admin');
const IMPORT_PROJECT_DRAWER_ID = 'importProjectDrawer';
const CREATE_PROJECT_DRAWER_ID = 'createProjectDrawer';
const drawerCleanupHandlers = [];

onMounted(async () => {
  loadSignals();
  try {
    await projectStore.loadProjects();
    projectsLoaded.value = true;
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load projects.';
  }

  registerDrawerCleanup(IMPORT_PROJECT_DRAWER_ID);
  registerDrawerCleanup(CREATE_PROJECT_DRAWER_ID);
  await loadProjectTemplates();
  await openCreateProjectDrawerFromRoute();
});

// Project templates are optional; without them the create form simply has no template choice.
// Workflow templates come along so a template's project workflow states can be offered.
async function loadProjectTemplates() {
  try {
    const result = await apiClient.listWorkflowTemplates({ status: 'active' }, authSession.state.token);
    projectTemplates.value = usableTemplates(result.templates, 'project');
    workflowTemplates.value = usableTemplates(result.templates, 'workflow');
  } catch {
    projectTemplates.value = [];
    workflowTemplates.value = [];
  }
}

let statusRequest = 0;
watch(selectedProjectTemplate, async (template) => {
  const request = ++statusRequest;
  let resolved = null;
  let error = '';
  try {
    resolved = await resolveTemplateProjectStatuses(template, {
      loadDefinition: async (workflowId) => (await apiClient.getWorkflowDefinition(workflowId, authSession.state.token)).value,
      workflowTemplates: workflowTemplates.value,
    });
  } catch {
    error = 'This template’s project workflow can’t be loaded, so the project may be refused when saved.';
  }
  if (request !== statusRequest) return;
  templateStatuses.value = resolved;
  templateStatusError.value = error;
  if (resolved) createForm.status = resolved.initial;
  else if (!PROJECT_STATUS_OPTIONS.some((option) => option.value === createForm.status)) createForm.status = 'Planned';
});

onBeforeUnmount(() => {
  for (const { drawer, handler } of drawerCleanupHandlers) {
    drawer.removeEventListener('hidden.bs.offcanvas', handler);
  }
});

const PAGE_SIZE = 50;
const projectsLoaded = ref(false);
const signalsById = ref({});
const signalsState = ref('loading');
const filters = reactive(projectFiltersFromQuery(route.query));
const visibleLimit = ref(PAGE_SIZE);

// Waiting counts and open reviews come from a second request so the list renders first.
// `quiet` reloads after someone else's change, keeping the signals shown on failure.
async function loadSignals({ quiet = false } = {}) {
  if (!quiet) signalsState.value = 'loading';
  try {
    const result = await withWorkingMode(apiClient, 'passive').getRequirementsProjectSignals(authSession.state.token);
    signalsById.value = Object.fromEntries((result.projects ?? []).map((entry) => [entry.projectId, entry]));
    signalsState.value = 'ready';
  } catch {
    if (quiet) return;
    signalsById.value = {};
    signalsState.value = 'failed';
  }
}

// Projects created, changed or deleted elsewhere, by people, the assistant or MCP clients.
useWorkspaceLiveRefresh(['projects'], () => {
  if (!projectsLoaded.value) return;
  void loadSignals({ quiet: true });
  projectStore.loadProjects({ background: true }).catch(() => {});
});

const statusCounts = computed(() => projectStatusCounts(projectStore.state.projects));
// Statuses no project has stay out of the filter, unless the link selected one.
const statusOptions = computed(() => PROJECT_STATUS_FILTERS.filter((option) => (
  option.id === 'active' || option.id === filters.status || statusCounts.value[option.id] > 0
)));
const rows = computed(() => buildProjectRows(projectStore.state.projects, signalsById.value, filters));
const shownRows = computed(() => rows.value.slice(0, visibleLimit.value).map(presentRow));
const attention = computed(() => summarizeAttention(projectStore.state.projects, signalsById.value));
const soonestReviewDeadline = computed(() => reviewDeadline(attention.value.soonestReview?.review));
const filtersActive = computed(() => (
  filters.mine || Boolean(filters.q.trim()) || filters.status !== DEFAULT_PROJECT_FILTERS.status
));

function presentRow({ project, signals }) {
  const review = signals?.review ?? null;
  const archived = isArchivedProject(project);
  return {
    archived,
    dates: formatProjectDates(project.startDate, project.endDate),
    endNote: projectEndNote(project),
    project,
    review,
    reviewDeadline: reviewDeadline(review),
    reviewMeta: review ? `Round ${review.number} · ${trackLabel(review.track)}` : '',
    reviewTarget: review ? reviewLocation(project.id, review) : null,
    signalsUnavailable: !archived && (signalsState.value === 'failed' || Boolean(signals?.unavailable)),
    status: projectStatusTone(project.status),
    waiting: waitingCount(signals),
    waitingBreakdown: waitingBreakdown(signals),
  };
}

function projectLocation(projectId) {
  return { name: 'project-detail', params: { projectId } };
}

function myItemsLocation(projectId) {
  return { name: 'project-requirements', params: { projectId } };
}

// Reviewers who still owe a review go straight into it; everyone else sees the round.
function reviewLocation(projectId, review) {
  const name = review.awaitingYou && router.hasRoute('project-requirements-round-review')
    ? 'project-requirements-round-review'
    : 'project-requirements-round';
  return { name, params: { projectId, roundId: review.id } };
}

// The waiting sort puts the largest counts first; every column sort runs one way.
function ariaSort(sort) {
  if (filters.sort !== sort) return 'none';
  return sort === 'waiting' ? 'descending' : 'ascending';
}

function clearFilters() {
  Object.assign(filters, { ...DEFAULT_PROJECT_FILTERS });
}

function showWaitingOnly() {
  Object.assign(filters, { mine: true, status: DEFAULT_PROJECT_FILTERS.status });
}

function lowerFirst(text) {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : '';
}

// Filters live in the URL so Back from a project returns to the same view. Both watchers
// stand down once the route leaves this page, or leaving would pull the user back here.
watch(
  () => ({ ...filters }),
  (next) => {
    visibleLimit.value = PAGE_SIZE;
    if (route.name !== 'projects') return;
    const query = projectFiltersToQuery(next, route.query);
    if (JSON.stringify(query) !== JSON.stringify(route.query)) router.replace({ name: 'projects', query });
  },
);

watch(
  () => route.query,
  (query) => {
    if (route.name !== 'projects') return;
    const next = projectFiltersFromQuery(query);
    if (Object.keys(next).some((key) => next[key] !== filters[key])) Object.assign(filters, next);
  },
);

const importConflictGroups = computed(() => {
  const groups = importInspection.value?.conflictGroups;
  if (Array.isArray(groups) && groups.length > 0) {
    return groups;
  }

  const grouped = new Map();
  for (const conflict of importInspection.value?.conflicts ?? []) {
    const type = String(conflict?.type ?? '').trim();
    const id = String(conflict?.id ?? '').trim();
    if (!type || !id) {
      continue;
    }

    const group = grouped.get(type) ?? {
      count: 0,
      ids: [],
      type,
    };
    group.count += 1;
    group.ids.push(id);
    grouped.set(type, group);
  }

  return [...grouped.values()].sort((left, right) => left.type.localeCompare(right.type));
});
const hasImportConflicts = computed(() => Boolean(importInspection.value?.conflicts?.length));
const supportingImportConflictTypes = new Set([
  'clarification_email_message',
  'clarification_reaction',
  'comment_vote',
  'task_log',
]);
const importPrimaryConflictLabels = computed(() => {
  return importConflictGroups.value
    .filter((group) => !supportingImportConflictTypes.has(group.type))
    .map((group) => conflictTypeLabel(group.type));
});
const importSupportingConflictLabels = computed(() => {
  return importConflictGroups.value
    .filter((group) => supportingImportConflictTypes.has(group.type))
    .map((group) => conflictTypeLabel(group.type));
});
const canOverwriteImportedProject = computed(() => {
  const projectId = importInspection.value?.project?.id ?? '';
  return (importInspection.value?.conflicts ?? []).some((conflict) => conflict.type === 'project' && conflict.id === projectId);
});

function resetCreateDraft() {
  createErrorMessage.value = '';
  Object.assign(createForm, createProjectForm());
}

function openDrawer(drawerId) {
  if (typeof document === 'undefined') {
    return;
  }

  clearStaleBootstrapOverlayScrollLock();

  const drawer = document.getElementById(drawerId);
  if (!drawer) {
    return;
  }

  Offcanvas.getOrCreateInstance(drawer).show();
}

function registerDrawerCleanup(drawerId) {
  if (typeof document === 'undefined') {
    return;
  }

  const drawer = document.getElementById(drawerId);
  if (!drawer) {
    return;
  }

  const handler = () => clearStaleBootstrapOverlayScrollLock();
  drawer.addEventListener('hidden.bs.offcanvas', handler);
  drawerCleanupHandlers.push({ drawer, handler });
}

function openImportProjectDrawer() {
  resetImportDraft();
  openDrawer(IMPORT_PROJECT_DRAWER_ID);
}

function openCreateProjectDrawer() {
  resetCreateDraft();
  openDrawer(CREATE_PROJECT_DRAWER_ID);
}

async function openCreateProjectDrawerFromRoute() {
  if (route.query.new !== 'project' || typeof document === 'undefined') {
    return;
  }

  await nextTick();
  openCreateProjectDrawer();
  if (projectTemplates.value.some((template) => template.id === route.query.template)) createForm.templateId = route.query.template;

  const query = { ...route.query };
  delete query.new;
  delete query.template;
  await router.replace({ name: 'projects', query });
}

watch(() => route.query.new, () => {
  openCreateProjectDrawerFromRoute();
});

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function resetImportDraft() {
  importErrorMessage.value = '';
  importSuccessMessage.value = '';
  importFilename.value = '';
  importBase64.value = '';
  importInspection.value = null;
  pendingImportOverwriteMode.value = '';
  Object.keys(importUserMappings).forEach((key) => delete importUserMappings[key]);
}

function conflictTypeLabel(type) {
  const labels = {
    clarification: 'Clarifications',
    clarification_assignment: 'Clarification collaborators',
    clarification_comment: 'Clarification comments',
    clarification_email_message: 'Clarification email messages',
    clarification_invitation: 'Clarification invitations',
    clarification_reaction: 'Clarification reactions',
    comment: 'Comments',
    comment_vote: 'Comment votes',
    file: 'Files',
    preference: 'Preferences',
    project: 'Projects',
    project_user: 'Project collaborators',
    sprint: 'Sprints',
    sprint_staffing: 'Sprint staffing',
    stakeholder: 'Stakeholders',
    summary: 'Summaries',
    task: 'Work items',
    task_log: 'Task logs',
  };
  return labels[type] ?? type;
}

function openImportOverwriteConfirmation(mode) {
  pendingImportOverwriteMode.value = mode;
  importErrorMessage.value = '';
  importSuccessMessage.value = '';
}

function cancelImportOverwriteConfirmation() {
  pendingImportOverwriteMode.value = '';
}

async function abortImportProject() {
  resetImportDraft();
  await closeImportProjectDrawer();
  clearStaleBootstrapOverlayScrollLock();
}

function closeImportProjectDrawer() {
  if (typeof document === 'undefined') {
    return Promise.resolve();
  }

  const drawer = document.getElementById(IMPORT_PROJECT_DRAWER_ID);
  if (!drawer || !drawer.classList.contains('show')) {
    return Promise.resolve();
  }

  const offcanvas = Offcanvas.getOrCreateInstance(drawer);
  return new Promise((resolve) => {
    let settled = false;
    let fallbackTimer = null;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      drawer.removeEventListener('hidden.bs.offcanvas', finish);
      window.clearTimeout(fallbackTimer);
      resolve();
    };

    fallbackTimer = window.setTimeout(finish, 400);
    drawer.addEventListener('hidden.bs.offcanvas', finish, { once: true });
    offcanvas.hide();
  });
}

function clearStaleBootstrapOverlayScrollLock() {
  if (typeof document === 'undefined') {
    return;
  }

  const activeOverlay = document.querySelector(
    '.modal.show, .modal.showing, .modal.hiding, .offcanvas.show, .offcanvas.showing, .offcanvas.hiding',
  );
  if (activeOverlay) {
    return;
  }

  document.querySelectorAll('.modal-backdrop, .offcanvas-backdrop').forEach((backdrop) => backdrop.remove());
  document.body.classList.remove('modal-open');
  document.body.style.removeProperty('overflow');
  document.body.style.removeProperty('padding-right');
}

function waitForOverlayCleanupFrame() {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function handleImportFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  importBusy.value = true;
  importErrorMessage.value = '';
  importSuccessMessage.value = '';

  try {
    const buffer = await file.arrayBuffer();
    importFilename.value = file.name;
    importBase64.value = arrayBufferToBase64(buffer);
    const result = await apiClient.inspectProjectImport(
      { base64OdinProject: importBase64.value },
      authSession.state.token,
    );
    importInspection.value = result;
    Object.keys(importUserMappings).forEach((key) => delete importUserMappings[key]);
    for (const sourceUser of result.sourceUsers ?? []) {
      importUserMappings[sourceUser.id] = sourceUser.suggestedTargetUserId ?? '';
    }
    importSuccessMessage.value = 'Project archive loaded.';
  } catch (error) {
    resetImportDraft();
    importErrorMessage.value = error.message ?? 'Unable to inspect the project archive.';
  } finally {
    importBusy.value = false;
    event.target.value = '';
  }
}

async function handleImportProject(overwriteMode = 'none') {
  if (!importBase64.value || importBusy.value) {
    return;
  }

  importBusy.value = true;
  importErrorMessage.value = '';
  importSuccessMessage.value = '';

  try {
    const userMappings = Object.entries(importUserMappings).map(([sourceUserId, targetUserId]) => ({
      sourceUserId,
      targetUserId: targetUserId || null,
    }));
    const result = await apiClient.importProject(
      {
        base64OdinProject: importBase64.value,
        overwriteMode,
        userMappings,
      },
      authSession.state.token,
    );
    await projectStore.loadProjects();
    await closeImportProjectDrawer();
    clearStaleBootstrapOverlayScrollLock();
    await router.push({
      name: 'project-detail',
      params: {
        projectId: result.importedProjectId,
      },
    });
    await waitForOverlayCleanupFrame();
    clearStaleBootstrapOverlayScrollLock();
  } catch (error) {
    importErrorMessage.value = error.message ?? 'Unable to import the project archive.';
  } finally {
    importBusy.value = false;
    pendingImportOverwriteMode.value = '';
  }
}

async function handleCreateProject() {
  createErrorMessage.value = '';

  try {
    const project = await projectStore.createProject({
      description: createForm.description,
      endDate: createForm.endDate || null,
      name: createForm.name,
      startDate: createForm.startDate || null,
      status: createForm.status,
      templateId: createForm.templateId || null,
    });

    await router.push({
      name: 'project-detail',
      params: {
        projectId: project.id,
      },
    });
  } catch (error) {
    createErrorMessage.value = error.message ?? 'Unable to create the project.';
  }
}

</script>

<template>
  <section class="dashboard-panel dashboard-panel--projects projects-page">
    <header class="projects-head">
      <h1 class="projects-head__title">Projects</h1>
      <div class="projects-head__actions">
        <button
          v-if="canImportProject"
          class="ghost-button"
          type="button"
          aria-controls="importProjectDrawer"
          @click="openImportProjectDrawer"
        >
          <i class="bi bi-upload" aria-hidden="true"></i> Import
        </button>
        <button
          class="primary-button"
          type="button"
          :aria-controls="CREATE_PROJECT_DRAWER_ID"
          @click="openCreateProjectDrawer"
        >
          <i class="bi bi-plus-lg" aria-hidden="true"></i> New project
        </button>
      </div>
    </header>

    <div v-if="noticeMessage" class="success-banner d-flex align-items-start justify-content-between gap-2" role="status">
      <span>{{ noticeMessage }}</span>
      <button class="btn-close flex-shrink-0" type="button" aria-label="Dismiss message" @click="noticeMessage = ''"></button>
    </div>
    <div v-if="errorMessage" class="error-banner" role="alert">{{ errorMessage }}</div>

    <p v-if="attention.projectsWithItems > 0" class="projects-attention">
      <i class="bi bi-inbox-fill" aria-hidden="true"></i>
      <span>
        <strong v-if="attention.items > 0">{{ attention.items }} {{ attention.items === 1 ? 'item' : 'items' }}</strong>
        <strong v-else>{{ attention.reviewsOwed }} {{ attention.reviewsOwed === 1 ? 'review' : 'reviews' }}</strong>
        waiting on you in {{ attention.projectsWithItems }} {{ attention.projectsWithItems === 1 ? 'project' : 'projects' }}.
        <template v-if="attention.soonestReview && soonestReviewDeadline">
          Your review of
          <RouterLink :to="reviewLocation(attention.soonestReview.project.id, attention.soonestReview.review)">{{ attention.soonestReview.project.name }}</RouterLink>
          {{ lowerFirst(soonestReviewDeadline.label) }}.
        </template>
      </span>
      <button v-if="!filters.mine" class="projects-text-button" type="button" @click="showWaitingOnly">Show only these</button>
    </p>

    <div class="projects-toolbar">
      <div class="projects-search">
        <label class="visually-hidden" for="projects-filter">Filter projects</label>
        <i class="bi bi-search" aria-hidden="true"></i>
        <input
          id="projects-filter"
          v-model="filters.q"
          class="form-control"
          autocomplete="off"
          placeholder="Filter projects"
          type="search"
        />
      </div>

      <div class="projects-status-scroll">
        <fieldset class="rq-seg projects-status">
          <legend class="visually-hidden">Status</legend>
          <label v-for="option in statusOptions" :key="option.id" class="rq-seg__option">
            <input v-model="filters.status" type="radio" name="projects-status" :value="option.id" />
            <span>{{ option.label }}<span class="projects-status__count">{{ statusCounts[option.id] }}</span></span>
          </label>
        </fieldset>
      </div>

      <div class="projects-toolbar__end">
        <label class="projects-check">
          <input v-model="filters.mine" class="form-check-input" type="checkbox" />
          Waiting on me
        </label>

        <label class="projects-sort">
          <span>Sort</span>
          <select v-model="filters.sort" class="form-select">
            <option v-for="option in PROJECT_SORTS" :key="option.id" :value="option.id">{{ option.label }}</option>
          </select>
        </label>
      </div>
    </div>

    <p v-if="signalsState === 'failed'" class="projects-note" role="status">
      <i class="bi bi-exclamation-circle" aria-hidden="true"></i>
      <span>Requirements and review status couldn't load.</span>
      <button class="projects-text-button" type="button" @click="loadSignals">Try again</button>
    </p>

    <div class="projects-table-wrap" tabindex="0" role="region" aria-label="Projects table">
      <table class="projects-table">
        <caption class="visually-hidden">Projects, {{ rows.length }} shown</caption>
        <thead>
          <tr>
            <th scope="col" class="projects-table__rank" :aria-sort="ariaSort('rank')">
              <button type="button" @click="filters.sort = 'rank'">Rank</button>
            </th>
            <th scope="col" :aria-sort="ariaSort('name')">
              <button type="button" @click="filters.sort = 'name'">Project</button>
            </th>
            <th scope="col" :aria-sort="ariaSort('status')">
              <button type="button" @click="filters.sort = 'status'">Status</button>
            </th>
            <th scope="col" :aria-sort="ariaSort('waiting')">
              <button type="button" @click="filters.sort = 'waiting'">Waiting on you</button>
            </th>
            <th scope="col" :aria-sort="ariaSort('review')">
              <button type="button" @click="filters.sort = 'review'">Open review</button>
            </th>
            <th scope="col" :aria-sort="ariaSort('end')">
              <button type="button" @click="filters.sort = 'end'">Dates</button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in shownRows" :key="row.project.id" :class="{ 'projects-row--archived': row.archived }">
            <td class="projects-table__rank" data-label="Rank">
              <span v-if="row.project.rank != null" class="projects-rank">{{ row.project.rank }}</span>
              <template v-else><span class="projects-muted" aria-hidden="true">—</span><span class="visually-hidden">Unranked</span></template>
            </td>
            <th scope="row" class="projects-table__name">
              <RouterLink :to="projectLocation(row.project.id)">{{ row.project.name }}</RouterLink>
            </th>
            <td data-label="Status">
              <span class="projects-status-chip" :class="`projects-status-chip--${row.status.tone}`">
                <i class="bi" :class="row.status.icon" aria-hidden="true"></i>{{ row.status.label }}
              </span>
            </td>
            <td data-label="Waiting on you">
              <template v-if="row.waiting > 0">
                <RouterLink class="projects-count" :to="myItemsLocation(row.project.id)">
                  {{ row.waiting }} {{ row.waiting === 1 ? 'item' : 'items' }}
                </RouterLink>
                <div class="projects-sub">{{ row.waitingBreakdown }}</div>
              </template>
              <span v-else-if="signalsState === 'loading' && !row.archived" class="projects-muted">Checking…</span>
              <span v-else-if="row.signalsUnavailable" class="projects-muted">Unavailable</span>
              <template v-else><span class="projects-muted" aria-hidden="true">—</span><span class="visually-hidden">Nothing</span></template>
            </td>
            <td data-label="Open review">
              <template v-if="row.review">
                <RouterLink class="projects-deadline" :class="`projects-deadline--${row.reviewDeadline.tone}`" :to="row.reviewTarget">
                  <i class="bi" :class="row.reviewDeadline.tone === 'overdue' ? 'bi-exclamation-circle-fill' : 'bi-clock'" aria-hidden="true"></i>
                  {{ row.reviewDeadline.label }}
                </RouterLink>
                <div class="projects-sub">
                  {{ row.reviewMeta }}<template v-if="row.reviewDeadline.dateText"> · {{ row.reviewDeadline.dateText }}</template>
                </div>
                <div v-if="row.review.awaitingYou" class="projects-sub projects-sub--strong">You haven't reviewed yet</div>
                <div v-else-if="row.review.submitted" class="projects-sub">You've reviewed</div>
                <div v-if="row.review.openCount > 1" class="projects-sub">{{ row.review.openCount - 1 }} more open</div>
              </template>
              <span v-else-if="signalsState === 'loading' && !row.archived" class="projects-muted">Checking…</span>
              <template v-else><span class="projects-muted" aria-hidden="true">—</span><span class="visually-hidden">None</span></template>
            </td>
            <td data-label="Dates">
              <span v-if="row.dates">{{ row.dates }}</span>
              <span v-else class="projects-muted">No dates</span>
              <div v-if="row.endNote" class="projects-sub" :class="`projects-sub--${row.endNote.tone}`">{{ row.endNote.text }}</div>
            </td>
          </tr>
          <tr v-if="!projectsLoaded && !errorMessage && rows.length === 0">
            <td colspan="6" class="projects-empty">Loading projects…</td>
          </tr>
          <tr v-else-if="projectsLoaded && rows.length === 0">
            <td colspan="6" class="projects-empty">
              <template v-if="projectStore.state.projects.length === 0">No projects yet.</template>
              <template v-else>
                No projects match.
                <button v-if="filtersActive" class="projects-text-button" type="button" @click="clearFilters">Clear filters</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="rows.length > shownRows.length" class="projects-more">
      <span class="projects-muted">Showing {{ shownRows.length }} of {{ rows.length }}</span>
      <button class="ghost-button ghost-button--compact" type="button" @click="visibleLimit += PAGE_SIZE">Show more</button>
    </div>

    <div
      id="importProjectDrawer"
      class="offcanvas offcanvas-end"
      tabindex="-1"
      aria-labelledby="importProjectDrawerLabel"
      style="--bs-offcanvas-width: min(640px, 100vw);"
    >
      <div class="offcanvas-header">
        <h5 id="importProjectDrawerLabel" class="offcanvas-title">
          <i class="bi bi-upload me-2"></i>Import Project
        </h5>
        <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close"></button>
      </div>

      <div class="offcanvas-body">
        <div v-if="importErrorMessage" class="alert alert-danger">{{ importErrorMessage }}</div>
        <div v-else-if="importSuccessMessage" class="alert alert-success">{{ importSuccessMessage }}</div>

        <input ref="importFileInput" accept=".odin-project,.odin,application/zip" hidden type="file" @change="handleImportFileSelected" />
        <button class="btn btn-outline-secondary w-100 mb-3" type="button" :disabled="importBusy" @click="importFileInput?.click()">
          <i class="bi bi-folder2-open me-1"></i>
          {{ importFilename || 'Choose project archive' }}
        </button>

        <template v-if="importInspection">
          <div class="mb-3">
            <p class="section-eyebrow">Archive</p>
            <h6 class="mb-1">{{ importInspection.project?.name ?? 'Project archive' }}</h6>
            <p class="muted-copy mb-0">{{ importInspection.project?.taskCount ?? 0 }} work items</p>
          </div>

          <div v-if="importInspection.importsAsCopy" class="alert alert-info" data-testid="project-import-copy-note">
            This project is in another workspace on this server, so it is imported as a separate copy.
            The other workspace's project stays as it is. Stakeholders in the copy get new portal links.
          </div>

          <div v-if="hasImportConflicts" class="alert alert-warning">
            <div class="d-flex align-items-start gap-2">
              <i class="bi bi-exclamation-triangle-fill mt-1" aria-hidden="true"></i>
              <div>
                <strong>This archive conflicts with existing records.</strong>
                <p class="mb-2">Choose how to handle the existing project data before importing.</p>
                <div class="project-import-conflict-summary">
                  <div v-if="canOverwriteImportedProject" class="project-import-conflict-summary__section">
                    <span class="project-import-conflict-summary__label">Existing project match</span>
                    <strong>{{ importInspection.project?.name ?? 'Project archive' }}</strong>
                    <p class="mb-0">
                      The archive uses the same project identity as an existing project. Overwrite Project replaces that project from scratch.
                    </p>
                  </div>
                  <div v-else class="project-import-conflict-summary__section">
                    <span class="project-import-conflict-summary__label">Record ID overlap</span>
                    <strong>{{ importInspection.project?.name ?? 'Project archive' }}</strong>
                    <p class="mb-0">
                      Some archive records already exist. Overwrite All can replace those conflicting records.
                    </p>
                  </div>
                  <div v-if="importPrimaryConflictLabels.length" class="project-import-conflict-summary__section">
                    <span class="project-import-conflict-summary__label">Project data affected</span>
                    <div class="project-import-conflict-pills">
                      <span v-for="label in importPrimaryConflictLabels" :key="label">{{ label }}</span>
                    </div>
                  </div>
                  <div v-if="importSupportingConflictLabels.length" class="project-import-conflict-summary__section">
                    <span class="project-import-conflict-summary__label">Supporting history</span>
                    <p class="mb-2">
                      Activity, reactions, and email tracking rows are tied to the project records above and will be replaced with them.
                    </p>
                    <div class="project-import-conflict-pills project-import-conflict-pills--quiet">
                      <span v-for="label in importSupportingConflictLabels" :key="label">{{ label }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="importInspection.sourceUsers?.length" class="mb-3">
            <p class="section-eyebrow">User mappings</p>
            <div v-for="sourceUser in importInspection.sourceUsers" :key="sourceUser.id" class="mb-2">
              <label class="form-label">{{ sourceUser.name }} <span class="muted-copy">{{ sourceUser.email }}</span></label>
              <select v-model="importUserMappings[sourceUser.id]" class="form-select">
                <option value="">Unmapped</option>
                <option v-for="tenantUser in importInspection.tenantUsers" :key="tenantUser.id" :value="tenantUser.id">
                  {{ tenantUser.name }} · {{ tenantUser.email }}
                </option>
              </select>
            </div>
          </div>

          <div v-if="hasImportConflicts" class="project-import-conflict-actions">
            <button class="btn btn-outline-secondary" type="button" :disabled="importBusy" @click="abortImportProject">
              Abort
            </button>
            <button
              class="btn btn-outline-danger"
              type="button"
              :disabled="importBusy || !canOverwriteImportedProject"
              @click="openImportOverwriteConfirmation('project')"
            >
              Overwrite Project
            </button>
            <button
              class="btn btn-danger"
              type="button"
              :disabled="importBusy"
              @click="openImportOverwriteConfirmation('all')"
            >
              Overwrite All
            </button>
          </div>

          <div v-if="pendingImportOverwriteMode" class="project-import-overwrite-confirmation">
            <p class="section-eyebrow text-danger">Destructive import</p>
            <h6 class="mb-2">
              {{ pendingImportOverwriteMode === 'all' ? 'Overwrite all conflicting records?' : 'Overwrite this project?' }}
            </h6>
            <p class="muted-copy">
              <template v-if="pendingImportOverwriteMode === 'all'">
                This will delete every conflicting record listed above, including records outside this project when needed.
              </template>
              <template v-else>
                This will delete the existing project and its project-owned records, then import the archive from scratch.
              </template>
            </p>
            <div class="d-flex flex-wrap gap-2 justify-content-end">
              <button class="btn btn-outline-secondary btn-sm" type="button" :disabled="importBusy" @click="cancelImportOverwriteConfirmation">
                Cancel
              </button>
              <button class="btn btn-danger btn-sm" type="button" :disabled="importBusy" @click="handleImportProject(pendingImportOverwriteMode)">
                {{ importBusy ? 'Overwriting...' : pendingImportOverwriteMode === 'all' ? 'Overwrite All' : 'Overwrite Project' }}
              </button>
            </div>
          </div>

          <button
            v-else-if="!hasImportConflicts"
            class="btn btn-primary w-100"
            type="button"
            :disabled="importBusy"
            @click="handleImportProject()"
          >
            <i class="bi bi-check-circle me-1"></i>
            {{ importBusy ? 'Importing...' : importInspection.importsAsCopy ? 'Import as Copy' : 'Import Project' }}
          </button>
        </template>
      </div>
    </div>

    <div
      :id="CREATE_PROJECT_DRAWER_ID"
      class="offcanvas offcanvas-end"
      tabindex="-1"
      aria-labelledby="createProjectDrawerLabel"
      style="--bs-offcanvas-width: min(560px, 100vw);"
    >
      <div class="offcanvas-header">
        <h5 id="createProjectDrawerLabel" class="offcanvas-title">
          <i class="bi bi-plus-circle me-2"></i>Create Project
        </h5>
        <button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="Close"></button>
      </div>

      <div class="offcanvas-body">
        <div v-if="createErrorMessage" class="alert alert-danger">{{ createErrorMessage }}</div>

        <form @submit.prevent="handleCreateProject">
          <div class="mb-3">
            <label for="project-name" class="form-label">Project Name</label>
            <input id="project-name" v-model="createForm.name" class="form-control" autocomplete="off" required />
          </div>

          <div v-if="projectTemplates.length" class="mb-3">
            <label for="project-template" class="form-label">Project Template</label>
            <select id="project-template" v-model="createForm.templateId" class="form-select" aria-describedby="project-template-hint">
              <option value="">No template</option>
              <option v-for="template in projectTemplates" :key="template.id" :value="template.id">{{ template.name }}</option>
            </select>
            <p id="project-template-hint" class="form-text mb-0">
              {{ selectedProjectTemplate ? `Sets up ${projectTemplateSummary(selectedProjectTemplate) || 'nothing yet'}.` : 'Start empty, or use a template for workflows, a starter outline and custom fields.' }}
            </p>
          </div>

          <div class="mb-3">
            <label for="project-status" class="form-label">Project Status</label>
            <select id="project-status" v-model="createForm.status" class="form-select" :aria-describedby="statusHint ? 'project-status-hint' : undefined">
              <option v-for="option in createStatusOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <p v-if="statusHint" id="project-status-hint" class="form-text mb-0">{{ statusHint }}</p>
          </div>

          <div class="row g-2">
            <div class="col-md-6 mb-3">
              <label for="project-start-date" class="form-label">Start Date</label>
              <input id="project-start-date" v-model="createForm.startDate" class="form-control" type="date" />
            </div>
            <div class="col-md-6 mb-3">
              <label for="project-end-date" class="form-label">End Date</label>
              <input id="project-end-date" v-model="createForm.endDate" class="form-control" type="date" />
            </div>
          </div>

          <div class="mb-3">
            <label id="project-description-label" class="form-label">Project Description</label>
            <RichContentEditor
              v-model="createForm.description"
              id="project-description"
              labelled-by="project-description-label"
              min-height="12rem"
              placeholder="Project description"
              storage-format="markdown"
              :token="authSession.state.token"
            />
          </div>

          <div class="d-flex justify-content-end gap-2 mt-4">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="offcanvas">
              <i class="bi bi-x-circle me-1"></i> Cancel
            </button>
            <button type="submit" class="btn btn-primary" :disabled="projectStore.state.saving">
              <i class="bi bi-check-circle me-1"></i> {{ projectStore.state.saving ? 'Saving...' : 'Save Project' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<style scoped>
.projects-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.75rem;
  padding: 1rem 1.25rem 1.25rem;
  color: var(--ink);
}

html.dark .projects-page {
  --muted: #93a6bf;
}

.projects-page :focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: 2px;
}

.projects-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
}

.projects-head__title {
  margin: 0;
  padding: 0;
  border: 0;
  font-family: var(--font-display);
  font-size: 1.375rem;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.projects-head__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.projects-attention,
.projects-note {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 0.25rem 0.5rem;
  align-items: baseline;
  margin: 0;
  padding: 0.6rem 0.85rem;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
  border-radius: 0.5rem;
  background: var(--rq-selected);
  font-size: 0.93rem;
}

.projects-attention > i {
  color: var(--rq-link);
}

.projects-attention a {
  color: var(--rq-link);
  font-weight: 700;
}

.projects-note {
  border-color: var(--line);
  background: var(--surface-soft);
  color: var(--ink-soft);
}

.projects-text-button {
  min-height: 2rem;
  padding: 0 0.25rem;
  border: 0;
  background: transparent;
  color: var(--rq-link);
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.projects-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  align-items: center;
}

.projects-search {
  position: relative;
  flex: 1 1 14rem;
  max-width: 24rem;
}

.projects-search > i {
  position: absolute;
  top: 50%;
  left: 0.7rem;
  color: var(--muted);
  transform: translateY(-50%);
  pointer-events: none;
}

.projects-search .form-control {
  min-height: 2.5rem;
  padding-left: 2.1rem;
  font-size: 0.93rem;
}

/* Scrolls sideways when the statuses outgrow the row instead of widening the page. */
.projects-status-scroll {
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
}

.projects-status {
  margin: 0;
  padding: 0;
}

.projects-status .rq-seg__option span {
  min-height: 2.5rem;
}

.projects-status__count {
  margin-left: 0.4rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  opacity: 0.8;
}

.projects-check {
  display: inline-flex;
  gap: 0.45rem;
  align-items: center;
  min-height: 2.5rem;
  font-size: 0.93rem;
  font-weight: 600;
  cursor: pointer;
}

.projects-check .form-check-input {
  width: 1.15rem;
  height: 1.15rem;
  margin: 0;
}

.projects-toolbar__end {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  align-items: center;
  margin-left: auto;
}

.projects-sort {
  display: inline-flex;
  gap: 0.45rem;
  align-items: center;
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--muted);
}

.projects-sort .form-select {
  width: auto;
  min-height: 2.5rem;
  color: var(--ink);
  font-size: 0.93rem;
}

.projects-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--surface);
}

.projects-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  color: var(--ink);
}

.projects-table thead th {
  padding: 0 0.35rem;
  border-bottom: 1px solid var(--line);
  background: var(--surface-soft);
  text-align: left;
  white-space: nowrap;
}

.projects-table thead button {
  display: inline-flex;
  gap: 0.2rem;
  align-items: center;
  min-height: 2.5rem;
  padding: 0 0.4rem;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.projects-table thead button:hover,
.projects-table thead th:not([aria-sort='none']) button {
  color: var(--rq-link);
}

.projects-table thead th:not([aria-sort='none']) button::after {
  content: '\f124';
  font-family: bootstrap-icons;
  font-size: 1rem;
  letter-spacing: 0;
}

.projects-table tbody td,
.projects-table tbody th {
  padding: 0.7rem 0.75rem;
  border-bottom: 1px solid var(--line);
  font-size: 0.93rem;
  font-weight: 400;
  text-align: left;
  vertical-align: top;
}

.projects-table tbody tr:last-child > * {
  border-bottom: 0;
}

.projects-table tbody tr:hover > * {
  background: var(--rq-selected);
}

.projects-table__rank {
  width: 4.5rem;
}

.projects-rank {
  display: inline-grid;
  place-items: center;
  min-width: 1.75rem;
  height: 1.75rem;
  padding: 0 0.35rem;
  border-radius: 0.35rem;
  background: var(--surface-tint);
  color: var(--ink-soft);
  font-family: var(--font-mono);
  font-size: 0.82rem;
  font-weight: 700;
}

.projects-table__name {
  min-width: 14rem;
}

.projects-table__name a {
  color: var(--ink);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.3;
  text-decoration: none;
}

.projects-table__name a:hover {
  color: var(--rq-link);
  text-decoration: underline;
}

.projects-row--archived .projects-table__name a {
  color: var(--muted);
}

.projects-status-chip {
  display: inline-flex;
  gap: 0.35rem;
  align-items: center;
  padding: 0.15rem 0.6rem;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 700;
  white-space: nowrap;
}

.projects-status-chip--planned { border-color: var(--line-strong); background: var(--surface-soft); color: var(--ink-soft); }
.projects-status-chip--active { background: var(--rq-exp-bg); color: var(--rq-exp); }
.projects-status-chip--risk { background: var(--rq-outstanding-bg); color: var(--rq-outstanding); }
.projects-status-chip--review { background: var(--rq-under-bg); color: var(--rq-under); }
.projects-status-chip--done { background: var(--rq-aligned-bg); color: var(--rq-aligned); }
.projects-status-chip--archived { border: 1px dashed var(--line-strong); background: transparent; color: var(--muted); }

html.dark .projects-status-chip--active { color: #8db8ff; }

.projects-count {
  display: inline-flex;
  align-items: center;
  padding: 0.1rem 0.6rem;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 0.86rem;
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
}

html.dark .projects-count {
  background: var(--accent-dark);
}

.projects-count:hover {
  background: var(--accent-dark);
  color: #fff;
  text-decoration: underline;
}

.projects-deadline {
  display: inline-flex;
  gap: 0.35rem;
  align-items: center;
  color: var(--ink);
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
}

.projects-deadline:hover {
  text-decoration: underline;
}

.projects-deadline--overdue { color: var(--rq-outstanding); }
.projects-deadline--soon { color: var(--rq-divergent); }
.projects-deadline--none { color: var(--ink-soft); font-weight: 600; }

.projects-sub {
  margin-top: 0.15rem;
  color: var(--muted);
  font-size: 0.82rem;
  line-height: 1.3;
}

.projects-sub--strong { color: var(--ink-soft); font-weight: 700; }
.projects-sub--overdue { color: var(--rq-outstanding); font-weight: 600; }
.projects-sub--soon { color: var(--rq-divergent); font-weight: 600; }

.projects-muted {
  color: var(--muted);
}

.projects-empty {
  padding: 1.5rem 0.75rem !important;
  color: var(--muted);
  text-align: center !important;
}

.projects-more {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: center;
}

@media (pointer: coarse) {
  .projects-text-button,
  .projects-table thead button,
  .projects-check,
  .projects-search .form-control,
  .projects-sort .form-select,
  .projects-status .rq-seg__option span {
    min-height: 3.15rem;
  }
}

/* Narrow screens: each project becomes a card, labels come from data-label, and the
   sort control in the toolbar replaces the column headers. Media queries measure rem at
   the browser's 16px, not the app's 14px root. */
@media (max-width: 52rem) {
  .projects-page {
    padding: 0.75rem;
  }

  .projects-toolbar__end {
    margin-left: 0;
  }

  .projects-attention,
  .projects-note {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .projects-attention > button,
  .projects-note > button {
    grid-column: 2;
    justify-self: start;
  }

  .projects-search,
  .projects-status-scroll {
    flex-basis: 100%;
    max-width: none;
  }

  .projects-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .projects-table,
  .projects-table tbody {
    display: block;
  }

  .projects-table tbody tr {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.6rem 0.75rem;
    padding: 0.85rem;
    border-bottom: 1px solid var(--line);
  }

  .projects-table tbody tr:last-child {
    border-bottom: 0;
  }

  .projects-table tbody tr > * {
    padding: 0;
    border: 0;
  }

  .projects-table tbody tr:hover > * {
    background: transparent;
  }

  .projects-table tbody td[data-label]::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 0.15rem;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .projects-table__name {
    grid-column: 1 / -1;
    order: -1;
    min-width: 0;
  }

  .projects-table tbody .projects-table__rank {
    display: none;
  }

  .projects-table tbody .projects-empty {
    grid-column: 1 / -1;
    padding: 1rem 0 !important;
  }
}

@media (max-width: 22rem) {
  .projects-table tbody tr {
    grid-template-columns: minmax(0, 1fr);
  }
}

.project-import-conflict-summary {
  display: grid;
  gap: 0.85rem;
}

.project-import-conflict-summary__section {
  display: grid;
  gap: 0.35rem;
}

.project-import-conflict-summary__label {
  color: #6c5d22;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.project-import-conflict-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.project-import-conflict-pills span {
  padding: 0.25rem 0.5rem;
  border: 1px solid rgba(111, 66, 193, 0.18);
  border-radius: 0.35rem;
  background: rgba(255, 255, 255, 0.55);
  color: #3f344d;
  font-size: 0.78rem;
  font-weight: 650;
}

.project-import-conflict-pills--quiet span {
  border-color: rgba(108, 117, 125, 0.18);
  color: #5b6470;
}

.project-import-conflict-actions,
.project-import-overwrite-confirmation {
  display: grid;
  gap: 0.75rem;
  margin-top: 1rem;
}

.project-import-conflict-actions {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.project-import-overwrite-confirmation {
  padding: 1rem;
  border: 1px solid rgba(220, 53, 69, 0.24);
  border-radius: 0.75rem;
  background: rgba(220, 53, 69, 0.06);
}

@media (max-width: 640px) {
  .project-import-conflict-actions {
    grid-template-columns: 1fr;
  }
}
</style>
