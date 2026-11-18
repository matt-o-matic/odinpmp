<script setup>
// Per-project ticket view (D-020, WS9). Reuses the shared board logic so this surface and
// the tenant board group, label, and filter identically; only the project scope differs.
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import ProjectTicketIntakeLinks from './ProjectTicketIntakeLinks.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import TicketReopenBadge from './TicketReopenBadge.vue';
import WorkItemTemplatePicker from '../workflows/WorkItemTemplatePicker.vue';
import { workItemTemplateDefaults } from '../../lib/workflows/workflow-templates.js';
import {
  DEFAULT_TICKET_COLUMNS,
  TICKET_CATEGORIES,
  TICKET_SEVERITIES,
  buildTicketBoard,
  buildTicketFilterQuery,
  categoryLabel,
  createTicketFilterState,
  isAwaitingReview,
  reopenCount,
  reviewStateLabel,
  severityLabel,
  summarizeTickets,
} from '../../lib/projects/ticket-board.js';
import { ticketConfigChoices, ticketConfigName, ticketReferencePatch } from '../../lib/projects/ticket-config-options.js';
import { takeNewQuery } from '../../lib/workspace/work-menu.js';

const props = defineProps({
  projectId: { required: true, type: String },
  refreshVersion: { default: 0, type: Number },
});

const tickets = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const activeView = ref('board');
const filters = reactive(createTicketFilterState());
const emptyDraft = () => ({ category: 'defect', description: '', environmentId: '', foundInReleaseId: '', name: '', reproSteps: '', severity: 'S3' });
const draft = reactive(emptyDraft());
const draftTemplate = reactive({ id: '', priority: null });
const createDialog = ref(null);
const ticketConfig = ref({ environments: [], releases: [] });
const referenceDialog = ref(null);
const referenceTicket = ref(null);
const referenceDraft = reactive({ environmentId: '', fixedInReleaseId: '', foundInReleaseId: '' });
const referenceError = ref('');

const token = computed(() => authSession.state.token);
const columns = computed(() => buildTicketBoard(tickets.value, DEFAULT_TICKET_COLUMNS));
const summary = computed(() => summarizeTickets(tickets.value));
const environmentChoices = computed(() => ticketConfigChoices(ticketConfig.value.environments, referenceTicket.value?.environmentId));
const foundInChoices = computed(() => ticketConfigChoices(ticketConfig.value.releases, referenceTicket.value?.foundInReleaseId));
const fixedInChoices = computed(() => ticketConfigChoices(ticketConfig.value.releases, referenceTicket.value?.fixedInReleaseId));
const newEnvironmentChoices = computed(() => ticketConfigChoices(ticketConfig.value.environments));
const newReleaseChoices = computed(() => ticketConfigChoices(ticketConfig.value.releases));

// Environments and releases are tenant lists an admin manages under Ticket environments & releases.
async function loadTicketConfig() {
  try {
    const result = await apiClient.passive.getProjectTicketConfig(props.projectId, token.value);
    ticketConfig.value = { environments: result.environments ?? [], releases: result.releases ?? [] };
  } catch (_error) {
    ticketConfig.value = { environments: [], releases: [] };
  }
}

async function loadTickets({ quiet = false } = {}) {
  if (!props.projectId) return;
  loading.value = !quiet;
  errorMessage.value = '';

  try {
    // Quiet loads come from live updates, so they stay in the background.
    const client = quiet ? apiClient.passive : apiClient;
    const result = await client.listProjectTickets(props.projectId, buildTicketFilterQuery(filters), token.value);
    tickets.value = result.tickets ?? [];
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load tickets.';
  } finally {
    loading.value = false;
  }
}

function applyTicketTemplate(template) {
  draftTemplate.priority = null;
  if (!template) return;
  const { priority = null, ...defaults } = workItemTemplateDefaults(template);
  Object.assign(draft, defaults);
  draftTemplate.priority = priority;
}

async function openCreate() {
  Object.assign(draft, emptyDraft());
  Object.assign(draftTemplate, { id: '', priority: null });
  await nextTick();
  createDialog.value?.showModal();
}

async function openReferences(ticket) {
  referenceTicket.value = ticket;
  referenceError.value = '';
  Object.assign(referenceDraft, {
    environmentId: ticket.environmentId ?? '',
    fixedInReleaseId: ticket.fixedInReleaseId ?? '',
    foundInReleaseId: ticket.foundInReleaseId ?? '',
  });
  await nextTick();
  referenceDialog.value?.showModal();
}

function closeReferences() {
  referenceDialog.value?.close();
  referenceTicket.value = null;
}

async function saveReferences() {
  const ticket = referenceTicket.value;
  const patch = ticketReferencePatch(ticket, referenceDraft);
  if (!Object.keys(patch).length) {
    closeReferences();
    return;
  }
  referenceError.value = '';
  try {
    await apiClient.updateProjectItem(props.projectId, ticket.id, { expectedVersion: ticket.version, patch }, token.value);
    closeReferences();
    await loadTickets();
  } catch (error) {
    referenceError.value = error?.status === 409
      ? 'Someone else changed this ticket. Close this form and refresh to see the latest version.'
      : error.message ?? 'Unable to update the ticket.';
  }
}

async function createTicket() {
  errorMessage.value = '';

  try {
    await apiClient.createProjectItem(
      props.projectId,
      // Off-sprint by default (D-015): no sprint is set at creation.
      {
        item: { ...draft, ...(draftTemplate.priority ? { priority: draftTemplate.priority } : {}), status: 'new' },
        itemType: 'ticket',
        parentId: null,
        ...(draftTemplate.id ? { templateId: draftTemplate.id } : {}),
      },
      token.value,
    );
    createDialog.value?.close();
    await loadTickets();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to create the ticket.';
  }
}

watch(() => props.projectId, () => {
  loadTickets();
  loadTicketConfig();
});

// Live project updates: refresh in place without blanking the board.
watch(() => props.refreshVersion, () => {
  loadTickets({ quiet: true });
});

// The top bar's "New ticket…" lands here as ?new=ticket, after the Tickets page asked which
// project.
const route = useRoute();
const router = useRouter();
function openCreateFromRoute() {
  const { open, query: rest } = takeNewQuery(route.query, 'ticket');
  if (!open) return;
  openCreate();
  router.replace({ query: rest }).catch(() => null);
}
watch(() => route.query.new, openCreateFromRoute);

onMounted(() => {
  loadTickets();
  loadTicketConfig();
  openCreateFromRoute();
});
</script>

<template>
  <section class="project-tickets">
    <header class="project-tickets__header">
      <div>
        <h2>Tickets</h2>
        <p>Defects and requests for this project. Tickets stay off the sprint board unless you add them to a sprint.</p>
      </div>
      <div class="project-tickets__actions">
        <button class="btn btn-sm btn-primary" type="button" @click="openCreate">New ticket</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" @click="loadTickets()">Refresh</button>
      </div>
    </header>

    <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>

    <div class="project-tickets__metrics">
      <span>{{ summary.total }} total</span>
      <span>{{ summary.open }} open</span>
      <span>{{ summary.bySeverity.S1 }} critical</span>
      <span>{{ summary.awaitingReview }} awaiting review</span>
    </div>

    <nav class="project-tickets__tabs" aria-label="Project ticket views">
      <button :class="{ active: activeView === 'board' }" type="button" @click="activeView = 'board'">Board</button>
      <button :class="{ active: activeView === 'list' }" type="button" @click="activeView = 'list'">List</button>
      <button :class="{ active: activeView === 'intake' }" type="button" @click="activeView = 'intake'">Intake links</button>
    </nav>

    <p v-if="loading" class="empty-state" role="status">Loading tickets…</p>

    <template v-else>
      <div v-if="activeView === 'board'" class="project-tickets__board">
        <article v-for="column in columns" :key="column.key">
          <header><h3>{{ column.label }}</h3><span>{{ column.tickets.length }}</span></header>
          <ul>
            <li v-for="ticket in column.tickets" :key="ticket.id" class="project-tickets__card">
              <strong>{{ ticket.name }}</strong>
              <span class="project-tickets__meta">
                <span :class="['sev', `sev--${ticket.severity}`]">{{ ticket.severity }}</span>
                <span>{{ categoryLabel(ticket.category) }}</span>
                <span v-if="isAwaitingReview(ticket)" class="project-tickets__review">Awaiting review</span>
                <TicketReopenBadge v-if="reopenCount(ticket)" :count="reopenCount(ticket)" :last-reopened-at="ticket.lastReopenedAt" />
              </span>
            </li>
            <li v-if="column.tickets.length === 0" class="empty-state">None</li>
          </ul>
        </article>
      </div>

      <div v-if="activeView === 'list'" class="table-responsive" tabindex="0">
        <table class="table table-sm align-middle">
          <thead><tr><th>Ticket</th><th>Category</th><th>Severity</th><th>Status</th><th>Environment</th><th>Found in</th><th>Fixed in</th><th>Review</th><th>Assignee</th><th>Action</th></tr></thead>
          <tbody>
            <tr v-for="ticket in tickets" :key="ticket.id">
              <td>
                <span class="project-tickets__name">
                  {{ ticket.name }}
                  <TicketReopenBadge v-if="reopenCount(ticket)" :count="reopenCount(ticket)" :last-reopened-at="ticket.lastReopenedAt" />
                </span>
              </td>
              <td>{{ categoryLabel(ticket.category) }}</td>
              <td>{{ ticket.severity }}</td>
              <td>{{ ticket.status }}</td>
              <td>{{ ticketConfigName(ticketConfig.environments, ticket.environmentId) }}</td>
              <td>{{ ticketConfigName(ticketConfig.releases, ticket.foundInReleaseId) }}</td>
              <td>{{ ticketConfigName(ticketConfig.releases, ticket.fixedInReleaseId) }}</td>
              <td>{{ reviewStateLabel(ticket.externalReviewState) }}</td>
              <td>{{ ticket.assigneeName || 'Unassigned' }}</td>
              <td>
                <button class="project-tickets__icon-button" type="button" :aria-label="`Edit environment and releases for ${ticket.name}`" @click="openReferences(ticket)">
                  <i class="bi bi-tags" aria-hidden="true"></i>
                </button>
              </td>
            </tr>
            <tr v-if="tickets.length === 0"><td colspan="10" class="empty-state">No tickets yet.</td></tr>
          </tbody>
        </table>
      </div>

      <ProjectTicketIntakeLinks v-if="activeView === 'intake'" :project-id="projectId" :refresh-version="refreshVersion" />
    </template>

    <dialog ref="createDialog" class="project-tickets__dialog" @cancel.prevent="createDialog?.close()">
      <form method="dialog" @submit.prevent="createTicket">
        <header>
          <h3>New ticket</h3>
          <button aria-label="Close new ticket form" type="button" @click="createDialog?.close()"><i class="bi bi-x-lg"></i></button>
        </header>
        <WorkItemTemplatePicker v-model="draftTemplate.id" field-class="project-tickets__template" input-id="new-ticket-template" item-type="ticket" :token="token" @apply="applyTicketTemplate" />
        <label for="new-ticket-name">Summary<input id="new-ticket-name" v-model="draft.name" required /></label>
        <div class="project-tickets__dialog-grid">
          <label for="new-ticket-category">Category
            <select id="new-ticket-category" v-model="draft.category">
              <option v-for="value in TICKET_CATEGORIES" :key="value" :value="value">{{ categoryLabel(value) }}</option>
            </select>
          </label>
          <label for="new-ticket-severity">Severity
            <select id="new-ticket-severity" v-model="draft.severity">
              <option v-for="value in TICKET_SEVERITIES" :key="value" :value="value">{{ severityLabel(value) }}</option>
            </select>
          </label>
        </div>
        <div class="project-tickets__dialog-grid">
          <label for="new-ticket-environment">Environment
            <select id="new-ticket-environment" v-model="draft.environmentId">
              <option value="">Not set</option>
              <option v-for="choice in newEnvironmentChoices" :key="choice.id" :value="choice.id">{{ choice.label }}</option>
            </select>
          </label>
          <label for="new-ticket-found-in">Found in release
            <select id="new-ticket-found-in" v-model="draft.foundInReleaseId">
              <option value="">Not set</option>
              <option v-for="choice in newReleaseChoices" :key="choice.id" :value="choice.id">{{ choice.label }}</option>
            </select>
          </label>
        </div>
        <label for="new-ticket-description">Description<textarea id="new-ticket-description" v-model="draft.description" rows="3" maxlength="5000"></textarea></label>
        <label for="new-ticket-repro">Steps to reproduce<textarea id="new-ticket-repro" v-model="draft.reproSteps" rows="4"></textarea></label>
        <footer>
          <button class="btn btn-sm btn-outline-secondary" type="button" @click="createDialog?.close()">Cancel</button>
          <button class="btn btn-sm btn-primary" type="submit">Create</button>
        </footer>
      </form>
    </dialog>

    <dialog ref="referenceDialog" class="project-tickets__dialog" aria-labelledby="ticket-references-title" @cancel.prevent="closeReferences">
      <form v-if="referenceTicket" method="dialog" @submit.prevent="saveReferences">
        <header>
          <h3 id="ticket-references-title">Environment and releases</h3>
          <button aria-label="Close environment and releases form" type="button" @click="closeReferences"><i class="bi bi-x-lg"></i></button>
        </header>
        <p class="project-tickets__note">{{ referenceTicket.name }}</p>
        <label for="ticket-ref-environment">Environment
          <select id="ticket-ref-environment" v-model="referenceDraft.environmentId">
            <option value="">Not set</option>
            <option v-for="choice in environmentChoices" :key="choice.id" :value="choice.id">{{ choice.label }}</option>
          </select>
        </label>
        <div class="project-tickets__dialog-grid">
          <label for="ticket-ref-found-in">Found in release
            <select id="ticket-ref-found-in" v-model="referenceDraft.foundInReleaseId">
              <option value="">Not set</option>
              <option v-for="choice in foundInChoices" :key="choice.id" :value="choice.id">{{ choice.label }}</option>
            </select>
          </label>
          <label for="ticket-ref-fixed-in">Fixed in release
            <select id="ticket-ref-fixed-in" v-model="referenceDraft.fixedInReleaseId">
              <option value="">Not set</option>
              <option v-for="choice in fixedInChoices" :key="choice.id" :value="choice.id">{{ choice.label }}</option>
            </select>
          </label>
        </div>
        <p v-if="referenceError" class="alert alert-danger mb-0" role="alert">{{ referenceError }}</p>
        <footer>
          <button class="btn btn-sm btn-outline-secondary" type="button" @click="closeReferences">Cancel</button>
          <button class="btn btn-sm btn-primary" type="submit">Save</button>
        </footer>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.project-tickets{display:grid;gap:.75rem;font-size:.875rem}
.project-tickets__header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}
.project-tickets__header h2{font-size:1.125rem;margin:0}
.project-tickets__header p{color:var(--bs-secondary-color);margin:.25rem 0 0}
.project-tickets__actions{display:flex;gap:.5rem;flex-wrap:wrap}
.project-tickets__metrics{display:flex;gap:1rem;flex-wrap:wrap;color:var(--bs-secondary-color);font-size:.75rem}
.project-tickets__tabs{display:flex;gap:.25rem;border-bottom:1px solid var(--bs-border-color);overflow-x:auto}
.project-tickets__tabs button{min-height:2.75rem;padding:.5rem .75rem;border:0;border-bottom:.15rem solid transparent;background:transparent;color:var(--bs-secondary-color);font-weight:600;white-space:nowrap}
.project-tickets__tabs button.active{border-color:var(--accent);color:var(--accent)}
.project-tickets__tabs button:focus-visible,.project-tickets__dialog button:focus-visible,.project-tickets__icon-button:focus-visible{outline:.18rem solid var(--bs-primary);outline-offset:.1rem}
.project-tickets__icon-button{display:inline-grid;place-items:center;width:2.75rem;height:2.75rem;border:1px solid var(--bs-border-color);border-radius:.375rem;background:transparent;color:var(--bs-body-color)}
.project-tickets__board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(13rem,1fr);gap:.75rem;overflow-x:auto;padding-bottom:.5rem}
.project-tickets__board article{border:1px solid var(--bs-border-color);border-radius:.5rem;padding:.5rem;min-width:13rem}
.project-tickets__board header{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.5rem}
.project-tickets__board h3{font-size:.8125rem;margin:0}
.project-tickets__board header span{color:var(--bs-secondary-color);font-size:.75rem}
.project-tickets__board ul{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}
.project-tickets__card{display:grid;gap:.35rem;border:1px solid var(--bs-border-color);border-radius:.375rem;padding:.5rem}
.project-tickets__meta{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;color:var(--bs-secondary-color);font-size:.75rem}
.project-tickets__name{display:inline-flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.project-tickets__review{font-weight:600;color:var(--bs-warning-text-emphasis,#664d03)}
.sev{font-weight:700}
.sev--S1{color:var(--bs-danger)}
.sev--S2{color:var(--bs-warning-text-emphasis,#664d03)}
/* Bootstrap's primary, danger and warning text colors are tuned for white; these hold 4.5:1 in dark mode. */
html.dark .project-tickets__tabs button.active{border-color:var(--accent-bright);color:var(--accent-bright)}
html.dark .sev--S1{color:var(--danger)}
html.dark .sev--S2,html.dark .project-tickets__review{color:var(--accent-warm)}
.table th{white-space:nowrap;font-size:.75rem;color:var(--bs-secondary-color)}
.empty-state{text-align:center;color:var(--bs-secondary-color);padding:1rem}
.project-tickets__dialog{width:min(34rem,calc(100vw - 2rem));padding:0;border:1px solid var(--bs-border-color);border-radius:.75rem;background:var(--bs-body-bg);color:var(--bs-body-color)}
.project-tickets__dialog::backdrop{background:rgba(15,23,42,.55)}
.project-tickets__dialog form{display:grid;gap:.75rem;padding:1rem}
.project-tickets__dialog header,.project-tickets__dialog footer{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.project-tickets__dialog footer{justify-content:flex-end}
.project-tickets__dialog h3{font-size:1.0625rem;margin:0}
.project-tickets__dialog header button{width:2.75rem;height:2.75rem;border:0;border-radius:.375rem;background:transparent;color:var(--bs-secondary-color)}
.project-tickets__dialog label{display:grid;gap:.25rem;font-weight:600}
.project-tickets__dialog :deep(.project-tickets__template){display:grid;gap:.25rem}.project-tickets__dialog :deep(.project-tickets__template label){font-weight:600}.project-tickets__dialog :deep(.project-tickets__template select){min-height:2.75rem;border:1px solid var(--bs-border-color);border-radius:.375rem;padding:.5rem;background:var(--bs-body-bg);color:var(--bs-body-color)}
.project-tickets__dialog input,.project-tickets__dialog select,.project-tickets__dialog textarea{min-height:2.75rem;border:1px solid var(--bs-border-color);border-radius:.375rem;padding:.5rem;background:var(--bs-body-bg);color:var(--bs-body-color)}
.project-tickets__dialog-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem}
@media(max-width:48rem){
.project-tickets__header{display:grid}
.project-tickets__actions{width:100%}
.project-tickets__actions .btn{flex:1;min-height:2.75rem}
.project-tickets__board{grid-auto-flow:row;grid-auto-columns:auto}
.project-tickets__board article{min-width:0}
.project-tickets__dialog-grid{grid-template-columns:1fr}
.table-responsive{border:1px solid var(--bs-border-color);border-radius:.5rem}
}
</style>
