<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import TicketReopenBadge from '../components/projects/TicketReopenBadge.vue';
import ProjectFilesPanel from '../components/projects/ProjectFilesPanel.vue';
import RequirementsDialog from '../components/requirements/RequirementsDialog.vue';
import WorkItemRelations from '../components/projects/WorkItemRelations.vue';
import { apiClient, authSession } from '../lib/auth/index.js';
import { provideProjectRefresh, useWorkspaceLiveRefresh } from '../lib/live/live-refresh.js';
import {
  DEFAULT_TICKET_COLUMNS,
  TICKET_CATEGORIES,
  TICKET_REVIEW_STATES,
  TICKET_SEVERITIES,
  buildTicketBoard,
  buildTicketFilterQuery,
  categoryLabel,
  createTicketFilterState,
  isAwaitingReview,
  reopenCount,
  reopenLabel,
  reviewCheckLabel,
  reviewStateLabel,
  severityLabel,
  summarizeTickets,
} from '../lib/projects/ticket-board.js';
import { ticketConfigName } from '../lib/projects/ticket-config-options.js';
import { takeNewQuery } from '../lib/workspace/work-menu.js';

const tickets = ref([]);
const projects = ref([]);
const reviewQueue = ref([]);
const reviewChecks = ref(new Map());
const nextCursor = ref(null);
const total = ref(0);
const loading = ref(true);
const errorMessage = ref('');
const activeView = ref('board');
const filters = reactive(createTicketFilterState());
const detail = ref(null);
const detailDialog = ref(null);
const route = useRoute();
const router = useRouter();
const detailConfig = ref({ environments: [], releases: [] });
const ticketConfigByProject = new Map();
let reviewChecksRequested = false;

const token = computed(() => authSession.state.token);
const columns = computed(() => buildTicketBoard(tickets.value, DEFAULT_TICKET_COLUMNS));
const summary = computed(() => summarizeTickets(tickets.value));

// `quiet` reloads after someone else's change: in the background, keeping as many rows as are
// showing (up to the API's 200), the open ticket, and the page as it is on failure. The latest
// load wins, so a reload never overwrites newer filters.
let loadSequence = 0;
async function loadTickets({ quiet = false } = {}) {
  const sequence = ++loadSequence;
  if (!quiet) {
    loading.value = true;
    errorMessage.value = '';
  }
  const client = quiet ? apiClient.passive : apiClient;
  const query = quiet ? { ...filters, cursor: '', limit: Math.min(200, Math.max(50, tickets.value.length)) } : filters;

  try {
    const [ticketPage, projectList, queue] = await Promise.all([
      client.listTickets(buildTicketFilterQuery(query), token.value),
      client.getProjects(token.value).catch(() => ({ projects: [] })),
      client.listTicketReviewQueue({ limit: 100 }, token.value).catch(() => ({ tickets: [] })),
    ]);
    if (sequence !== loadSequence) return;

    tickets.value = ticketPage.tickets ?? [];
    nextCursor.value = ticketPage.nextCursor ?? null;
    total.value = ticketPage.total ?? 0;
    projects.value = projectList.projects ?? [];
    reviewQueue.value = queue.tickets ?? [];
    if (!reviewChecksRequested) loadReviewChecks(reviewQueue.value);
    if (quiet && detail.value) {
      detail.value = [...tickets.value, ...reviewQueue.value].find((entry) => entry.id === detail.value.id) ?? detail.value;
    }
  } catch (error) {
    if (!quiet && sequence === loadSequence) errorMessage.value = error.message ?? 'Unable to load tickets.';
  } finally {
    if (!quiet && sequence === loadSequence) loading.value = false;
  }
}

// Tickets changed elsewhere, by people, the assistant or MCP clients. The open ticket's files and
// related work reload with them.
const ticketsRefreshVersion = ref(0);
provideProjectRefresh(ticketsRefreshVersion);
useWorkspaceLiveRefresh(['projects'], async () => {
  if (loading.value) return;
  await loadTickets({ quiet: true });
  ticketsRefreshVersion.value += 1;
});

// The automated check of each ticket awaiting review, loaded after the queue so it never holds
// the page up. Each check may cost an OpenAI call, so it loads once per visit, not on every
// filter change, and quietly: projects the user cannot triage, or a failed check, show no hint.
async function loadReviewChecks(queue) {
  const projectIds = [...new Set(queue.map((ticket) => ticket.projectId))];
  if (!projectIds.length) return;
  reviewChecksRequested = true;
  const pages = await Promise.all(projectIds.map((projectId) => apiClient.passive.listTicketsAwaitingReview(projectId, { limit: 25 }, token.value).catch(() => ({ tickets: [] }))));
  reviewChecks.value = new Map(pages.flatMap((page) => (page.tickets ?? []).map((ticket) => [ticket.id, ticket.classification])));
}

function applyFilters() {
  filters.cursor = '';
  loadTickets();
}

function clearFilters() {
  Object.assign(filters, createTicketFilterState());
  loadTickets();
}

async function loadMore() {
  if (!nextCursor.value) return;
  errorMessage.value = '';
  try {
    const page = await apiClient.listTickets(buildTicketFilterQuery({ ...filters, cursor: nextCursor.value }), token.value);
    tickets.value = [...tickets.value, ...(page.tickets ?? [])];
    nextCursor.value = page.nextCursor ?? null;
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load more tickets.';
  }
}

async function openDetail(ticket) {
  detail.value = ticket;
  detailConfig.value = ticketConfigByProject.get(ticket.projectId) ?? { environments: [], releases: [] };
  await nextTick();
  if (!detailDialog.value?.open) detailDialog.value?.showModal();
  if (!ticketConfigByProject.has(ticket.projectId) && (ticket.environmentId || ticket.foundInReleaseId || ticket.fixedInReleaseId)) {
    try {
      const config = await apiClient.passive.getProjectTicketConfig(ticket.projectId, token.value);
      ticketConfigByProject.set(ticket.projectId, { environments: config.environments ?? [], releases: config.releases ?? [] });
      if (detail.value?.id === ticket.id) detailConfig.value = ticketConfigByProject.get(ticket.projectId);
    } catch (_error) {
      // Names stay as "Unavailable entry" when the lists cannot be read.
    }
  }
}

// A related-ticket link lands here as ?project=&ticket=. The ticket may be outside the
// loaded page, so fall back to the project's own ticket list.
async function openLinkedTicket() {
  const ticketId = String(route.query.ticket ?? '');
  const projectId = String(route.query.project ?? '');
  if (!ticketId || detail.value?.id === ticketId) return;
  const loaded = [...tickets.value, ...reviewQueue.value].find((entry) => entry.id === ticketId);
  if (loaded) {
    await openDetail(loaded);
    return;
  }
  if (!projectId) return;
  try {
    const { project } = await apiClient.getProject(projectId, token.value);
    const ticket = (project?.tickets ?? []).find((entry) => entry.id === ticketId);
    if (ticket) await openDetail({ ...ticket, projectId, projectName: project.name });
    else errorMessage.value = 'That ticket is no longer available.';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to open the linked ticket.';
  }
}

function closeDetail() {
  detailDialog.value?.close();
  detail.value = null;
  if (route.query.ticket) router.replace({ query: {} });
}

async function decideReview(ticket, state) {
  errorMessage.value = '';

  try {
    await apiClient.decideTicketReview(ticket.projectId, ticket.id, { expectedVersion: ticket.version, state }, token.value);
    closeDetail();
    await loadTickets();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to record the review decision.';
  }
}

function dateTime(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}

// New ticket: a ticket belongs to a project, so this asks which one and opens that project's
// new-ticket form. The top bar's "New ticket…" lands here as ?new=ticket.
const newTicket = reactive({ error: '', open: false, projectId: '' });
const ticketProjects = computed(() => projects.value.filter((project) => !project.archivedAt && project.status !== 'archived'));

function openNewTicket() {
  Object.assign(newTicket, { error: '', open: true, projectId: ticketProjects.value.length === 1 ? ticketProjects.value[0].id : '' });
}

function submitNewTicket() {
  if (!newTicket.projectId) {
    newTicket.error = 'Choose a project.';
    return;
  }
  newTicket.open = false;
  router.push({ name: 'project-tickets', params: { projectId: newTicket.projectId }, query: { new: 'ticket' } }).catch(() => null);
}

function openNewTicketFromRoute() {
  const { open, query: rest } = takeNewQuery(route.query, 'ticket');
  if (!open) return;
  openNewTicket();
  router.replace({ query: rest }).catch(() => null);
}
watch(() => route.query.new, () => { if (!loading.value) openNewTicketFromRoute(); });

onMounted(async () => {
  await loadTickets();
  openNewTicketFromRoute();
  await openLinkedTicket();
});
watch(() => route.query.ticket, () => {
  if (!loading.value) openLinkedTicket();
});
</script>

<template>
  <main class="ticket-page">
    <header class="ticket-header">
      <div>
        <h1>Tickets</h1>
        <p>Defects, support requests, questions, and change requests across every project you can read.</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-sm btn-primary" type="button" @click="openNewTicket">New ticket</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="loadTickets()">Refresh</button>
      </div>
    </header>

    <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>

    <section class="ticket-metrics" aria-label="Ticket summary">
      <article><span>Total</span><strong>{{ total }}</strong></article>
      <article><span>Open</span><strong>{{ summary.open }}</strong></article>
      <article><span>Critical (S1)</span><strong>{{ summary.bySeverity.S1 }}</strong></article>
      <article><span>Awaiting review</span><strong>{{ summary.awaitingReview }}</strong></article>
    </section>

    <form class="ticket-filters" @submit.prevent="applyFilters">
      <label for="ticket-search">Search
        <input id="ticket-search" v-model="filters.search" placeholder="Title, description, or steps" />
      </label>
      <label for="ticket-project">Project
        <select id="ticket-project" v-model="filters.projectIds" multiple size="1">
          <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </label>
      <label for="ticket-category">Category
        <select id="ticket-category" v-model="filters.categories" multiple size="1">
          <option v-for="value in TICKET_CATEGORIES" :key="value" :value="value">{{ categoryLabel(value) }}</option>
        </select>
      </label>
      <label for="ticket-severity">Severity
        <select id="ticket-severity" v-model="filters.severities" multiple size="1">
          <option v-for="value in TICKET_SEVERITIES" :key="value" :value="value">{{ severityLabel(value) }}</option>
        </select>
      </label>
      <label for="ticket-review">Review state
        <select id="ticket-review" v-model="filters.externalReviewStates" multiple size="1">
          <option v-for="value in TICKET_REVIEW_STATES" :key="value" :value="value">{{ reviewStateLabel(value) }}</option>
        </select>
      </label>
      <label for="ticket-reopened">Reopened
        <select id="ticket-reopened" v-model="filters.reopened">
          <option :value="false">All tickets</option>
          <option :value="true">Reopened by reporter</option>
        </select>
      </label>
      <button class="btn btn-sm btn-outline-secondary" type="submit">Apply</button>
      <button class="btn btn-sm btn-outline-secondary" type="button" @click="clearFilters">Clear</button>
    </form>

    <nav class="ticket-tabs" aria-label="Ticket views">
      <button :class="{ active: activeView === 'board' }" type="button" @click="activeView = 'board'">Board</button>
      <button :class="{ active: activeView === 'list' }" type="button" @click="activeView = 'list'">List</button>
      <button :class="{ active: activeView === 'review' }" type="button" @click="activeView = 'review'">
        Review queue<span v-if="reviewQueue.length" class="badge text-bg-warning">{{ reviewQueue.length }}</span>
      </button>
    </nav>

    <p v-if="loading" class="empty-state" role="status">Loading tickets…</p>

    <template v-else>
      <section v-if="activeView === 'board'" class="ticket-board" aria-label="Ticket board">
        <article v-for="column in columns" :key="column.key" class="ticket-column">
          <header><h2>{{ column.label }}</h2><span>{{ column.tickets.length }}</span></header>
          <ul>
            <li v-for="ticket in column.tickets" :key="ticket.id" class="ticket-card-item">
              <button class="ticket-card" type="button" @click="openDetail(ticket)">
                <span class="ticket-card__title">{{ ticket.name }}</span>
                <span class="ticket-card__meta">
                  <span :class="['sev', `sev--${ticket.severity}`]">{{ ticket.severity }}</span>
                  <span>{{ categoryLabel(ticket.category) }}</span>
                  <span class="ticket-card__project">{{ ticket.projectName }}</span>
                </span>
                <span v-if="isAwaitingReview(ticket)" class="ticket-card__review">Awaiting review</span>
              </button>
              <!-- A sibling of the card button, since a button cannot hold another control. -->
              <span v-if="reopenCount(ticket)" class="ticket-card__reopen">
                <TicketReopenBadge :count="reopenCount(ticket)" :last-reopened-at="ticket.lastReopenedAt" />
              </span>
            </li>
            <li v-if="column.tickets.length === 0" class="empty-state">None</li>
          </ul>
        </article>
      </section>

      <section v-if="activeView === 'list'" aria-label="Ticket list">
        <div class="table-responsive" tabindex="0">
          <table class="table table-sm align-middle">
            <thead>
              <tr><th>Ticket</th><th>Project</th><th>Category</th><th>Severity</th><th>Status</th><th>Review</th><th>Updated</th></tr>
            </thead>
            <tbody>
              <tr v-for="ticket in tickets" :key="ticket.id">
                <td>
                  <span class="ticket-name">
                    <button class="link-button" type="button" @click="openDetail(ticket)">{{ ticket.name }}</button>
                    <TicketReopenBadge v-if="reopenCount(ticket)" :count="reopenCount(ticket)" :last-reopened-at="ticket.lastReopenedAt" />
                  </span>
                </td>
                <td>{{ ticket.projectName }}</td>
                <td>{{ categoryLabel(ticket.category) }}</td>
                <td>{{ ticket.severity }}</td>
                <td>{{ ticket.status }}</td>
                <td>{{ reviewStateLabel(ticket.externalReviewState) }}</td>
                <td>{{ dateTime(ticket.updatedAt) }}</td>
              </tr>
              <tr v-if="tickets.length === 0"><td colspan="7" class="empty-state">No tickets match the filters.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="activeView === 'review'" aria-label="External review queue">
        <p class="review-note">
          Externally submitted tickets stay invisible to the assistant until someone marks them valid.
          They remain assignable and schedulable in the meantime.
        </p>
        <div class="table-responsive" tabindex="0">
          <table class="table table-sm align-middle">
            <thead><tr><th>Ticket</th><th>Project</th><th>Severity</th><th>Automated check</th><th>Decision</th></tr></thead>
            <tbody>
              <tr v-for="ticket in reviewQueue" :key="ticket.id">
                <td><button class="link-button" type="button" @click="openDetail(ticket)">{{ ticket.name }}</button></td>
                <td>{{ ticket.projectName }}</td>
                <td>{{ ticket.severity }}</td>
                <td>{{ reviewCheckLabel(reviewChecks.get(ticket.id)) }}</td>
                <td>
                  <div class="row-actions">
                    <button class="btn btn-sm btn-outline-primary" type="button" @click="decideReview(ticket, 'validated')">Validate</button>
                    <button class="btn btn-sm btn-outline-danger" type="button" @click="decideReview(ticket, 'rejected')">Reject</button>
                  </div>
                </td>
              </tr>
              <tr v-if="reviewQueue.length === 0"><td colspan="5" class="empty-state">Nothing awaiting review.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <footer v-if="nextCursor" class="ticket-more">
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="loadMore">Load more</button>
      </footer>
    </template>

    <dialog ref="detailDialog" class="ticket-dialog" @cancel.prevent="closeDetail">
      <div v-if="detail" class="ticket-dialog__body">
        <header>
          <h2>{{ detail.name }}</h2>
          <button aria-label="Close ticket detail" type="button" @click="closeDetail"><i class="bi bi-x-lg"></i></button>
        </header>
        <dl class="ticket-dialog__grid">
          <div><dt>Project</dt><dd>{{ detail.projectName }}</dd></div>
          <div><dt>Category</dt><dd>{{ categoryLabel(detail.category) }}</dd></div>
          <div><dt>Severity</dt><dd>{{ severityLabel(detail.severity) }}</dd></div>
          <div><dt>Status</dt><dd>{{ detail.status }}</dd></div>
          <div><dt>Priority</dt><dd>{{ detail.priority }}</dd></div>
          <div><dt>Review</dt><dd>{{ reviewStateLabel(detail.externalReviewState) }}</dd></div>
          <div><dt>Build</dt><dd>{{ detail.buildVersion || '—' }}</dd></div>
          <div><dt>Environment</dt><dd>{{ ticketConfigName(detailConfig.environments, detail.environmentId) }}</dd></div>
          <div><dt>Found in</dt><dd>{{ ticketConfigName(detailConfig.releases, detail.foundInReleaseId) }}</dd></div>
          <div><dt>Fixed in</dt><dd>{{ ticketConfigName(detailConfig.releases, detail.fixedInReleaseId) }}</dd></div>
          <div><dt>Assignee</dt><dd>{{ detail.assigneeName || 'Unassigned' }}</dd></div>
          <div v-if="reopenCount(detail)">
            <dt>Reopened by reporter</dt>
            <dd>
              <i class="bi bi-arrow-counterclockwise ticket-dialog__reopen-icon" aria-hidden="true"></i>
              {{ reopenLabel(reopenCount(detail)) }}<template v-if="detail.lastReopenedAt">, last {{ dateTime(detail.lastReopenedAt) }}</template>
            </dd>
          </div>
        </dl>
        <section v-if="detail.reproSteps || detail.expectedResult || detail.actualResult">
          <h3>Reproduction</h3>
          <p v-if="detail.reproSteps"><strong>Steps</strong><br />{{ detail.reproSteps }}</p>
          <p v-if="detail.expectedResult"><strong>Expected</strong><br />{{ detail.expectedResult }}</p>
          <p v-if="detail.actualResult"><strong>Actual</strong><br />{{ detail.actualResult }}</p>
        </section>
        <section v-if="detail.description"><h3>Description</h3><p>{{ detail.description }}</p></section>
        <WorkItemRelations :item-id="detail.id" :item-name="detail.name" :project-id="detail.projectId" />
        <ProjectFilesPanel :project-id="detail.projectId" :target-id="detail.id" target-type="ticket" :token="token" />
        <footer>
          <template v-if="isAwaitingReview(detail)">
            <button class="btn btn-sm btn-outline-danger" type="button" @click="decideReview(detail, 'rejected')">Reject</button>
            <button class="btn btn-sm btn-primary" type="button" @click="decideReview(detail, 'validated')">Validate</button>
          </template>
          <button class="btn btn-sm btn-outline-secondary" type="button" @click="closeDetail">Close</button>
        </footer>
      </div>
    </dialog>
    <RequirementsDialog :open="newTicket.open" title="New ticket" @close="newTicket.open = false" @submit="submitNewTicket">
      <div class="rq-field">
        <label for="new-ticket-project">Project</label>
        <select id="new-ticket-project" v-model="newTicket.projectId" class="form-select" required>
          <option value="" disabled>Choose a project</option>
          <option v-for="project in ticketProjects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
        <p class="rq-field__hint mb-0">The ticket form opens in that project.</p>
      </div>
      <p v-if="newTicket.error" class="error-banner mb-0" role="alert">{{ newTicket.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" @click="newTicket.open = false">Cancel</button>
        <button class="primary-button" type="submit">Continue</button>
      </template>
    </RequirementsDialog>
  </main>
</template>

<style scoped>
.ticket-page{padding:1rem 1.5rem 2rem;font-size:.875rem}
.ticket-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1rem}
.ticket-header h1{font-size:1.375rem;margin:0}
.ticket-header p{color:var(--bs-secondary-color);margin:.25rem 0 0}
.header-actions{display:flex;flex-wrap:wrap;gap:.5rem}
.ticket-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem;margin-bottom:1rem}
.ticket-metrics article{border:1px solid var(--bs-border-color);border-radius:.5rem;padding:.75rem}
.ticket-metrics span{display:block;color:var(--bs-secondary-color);font-size:.75rem}
.ticket-metrics strong{font-size:1.25rem}
.ticket-filters{display:flex;align-items:end;gap:.5rem;flex-wrap:wrap;border-block:1px solid var(--bs-border-color);padding:.75rem 0}
.ticket-filters label{display:grid;gap:.25rem;min-width:11rem;font-size:.75rem;font-weight:600}
.ticket-filters label:first-child{flex:1}
.ticket-filters input,.ticket-filters select{min-height:2.75rem}
.ticket-tabs{display:flex;gap:.25rem;margin:1rem 0;border-bottom:1px solid var(--bs-border-color);overflow-x:auto}
.ticket-tabs button{min-height:2.75rem;padding:.5rem .75rem;border:0;border-bottom:.15rem solid transparent;background:transparent;color:var(--bs-secondary-color);font-weight:600;white-space:nowrap;display:flex;align-items:center;gap:.4rem}
.ticket-tabs button.active{border-color:var(--accent);color:var(--accent)}
.ticket-tabs button:focus-visible,.ticket-card:focus-visible,.link-button:focus-visible,.ticket-dialog button:focus-visible{outline:.18rem solid var(--bs-primary);outline-offset:.1rem}
.ticket-board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(15rem,1fr);gap:.75rem;overflow-x:auto;padding-bottom:.5rem}
.ticket-column{border:1px solid var(--bs-border-color);border-radius:.5rem;padding:.5rem;min-width:15rem}
.ticket-column header{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.5rem}
.ticket-column h2{font-size:.875rem;margin:0}
.ticket-column header span{color:var(--bs-secondary-color);font-size:.75rem}
.ticket-column ul{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}
/* The list item carries the card frame, so the reopen badge and its note sit inside it below the card button. */
.ticket-card-item{display:grid;border:1px solid var(--bs-border-color);border-radius:.375rem;background:var(--bs-body-bg)}
.ticket-card{display:grid;gap:.35rem;width:100%;text-align:left;border:0;border-radius:.375rem;background:transparent;color:var(--bs-body-color);padding:.5rem;min-height:2.75rem}
.ticket-card__title{font-weight:600}
.ticket-card__meta{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;color:var(--bs-secondary-color);font-size:.75rem}
.ticket-card__project{margin-inline-start:auto}
.ticket-card__review{font-size:.7rem;font-weight:600;color:var(--bs-warning-text-emphasis,#664d03)}
.ticket-card__reopen{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem;padding:0 .5rem .5rem}
.ticket-name{display:inline-flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.ticket-dialog__reopen-icon{color:var(--accent)}
.sev{font-weight:700}
.sev--S1{color:var(--bs-danger)}
.sev--S2{color:var(--bs-warning-text-emphasis,#664d03)}
.link-button{border:0;background:transparent;padding:0;color:var(--accent);text-align:left;text-decoration:underline}
/* Bootstrap's primary, danger and warning text colors are tuned for white; these hold 4.5:1 on the tinted page and in dark mode. */
html.dark .link-button,html.dark .ticket-tabs button.active{border-color:var(--accent-bright);color:var(--accent-bright)}
html.dark .sev--S1{color:var(--danger)}
html.dark .sev--S2,html.dark .ticket-card__review{color:var(--accent-warm)}
.row-actions{display:flex;gap:.35rem;flex-wrap:wrap}
.review-note{color:var(--bs-secondary-color);margin:0 0 .75rem}
.table th{position:sticky;top:0;background:var(--bs-body-bg);white-space:nowrap;font-size:.75rem;color:var(--bs-secondary-color)}
.empty-state{text-align:center;color:var(--bs-secondary-color);padding:1rem}
.ticket-more{display:flex;justify-content:center;margin-top:1rem}
.ticket-dialog{width:min(44rem,calc(100vw - 2rem));max-height:calc(100vh - 2rem);padding:0;border:1px solid var(--bs-border-color);border-radius:.75rem;background:var(--bs-body-bg);color:var(--bs-body-color);box-shadow:0 1rem 3rem rgba(0,0,0,.25)}
.ticket-dialog::backdrop{background:rgba(15,23,42,.55)}
.ticket-dialog__body{display:grid;gap:.75rem;padding:1rem;overflow:auto;max-height:calc(100vh - 2rem)}
.ticket-dialog header,.ticket-dialog footer{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.ticket-dialog footer{justify-content:flex-end;flex-wrap:wrap}
.ticket-dialog h2{font-size:1.125rem;margin:0}
.ticket-dialog h3{font-size:1rem;margin:0 0 .35rem}
.ticket-dialog header button{width:2.75rem;height:2.75rem;border:0;border-radius:.375rem;background:transparent;color:var(--bs-secondary-color)}
.ticket-dialog__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem;margin:0}
.ticket-dialog__grid dt{color:var(--bs-secondary-color);font-size:.75rem}
.ticket-dialog__grid dd{margin:0}
.ticket-dialog p{white-space:pre-wrap;margin:0 0 .5rem}
@media(max-width:48rem){
.ticket-page{padding:.75rem}
.ticket-header{display:grid}
.header-actions{width:100%}
.header-actions .btn{flex:1;min-height:2.75rem}
.ticket-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
.ticket-filters{align-items:stretch}
.ticket-filters label{min-width:100%}
.ticket-filters .btn{min-height:2.75rem}
.ticket-board{grid-auto-flow:row;grid-auto-columns:auto}
.ticket-column{min-width:0}
.ticket-dialog__grid{grid-template-columns:1fr}
.table-responsive{border:1px solid var(--bs-border-color);border-radius:.5rem}
}
</style>
