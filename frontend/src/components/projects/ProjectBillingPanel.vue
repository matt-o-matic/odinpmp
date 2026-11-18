<script setup>
import { computed, reactive, ref, watch } from 'vue';

import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import {
  billingErrorMessage, filterStories, formatBillingDate, formatHours, formatMoney, invoiceStatusIcon, invoiceStatusLabel, remainingHours,
} from '../../lib/projects/project-billing.js';

// The project's billing from invoice-gen: the linked client and SOW, each milestone's hours,
// and the invoices. Read-only, except the story assignment, which opens as its own dialog.
// Shown to project and workspace admins and managers.

const props = defineProps({
  projectId: { required: true, type: String },
  refreshVersion: { default: 0, type: Number },
});

const billing = ref(null);
const loading = ref(true);
const errorMessage = ref('');
const notice = ref('');

async function load({ quiet = false } = {}) {
  if (!quiet) loading.value = true;
  try {
    billing.value = await (quiet ? apiClient.passive : apiClient).getProjectBilling(props.projectId, authSession.state.token);
    errorMessage.value = '';
  } catch (error) {
    if (!quiet) errorMessage.value = billingErrorMessage(error, 'Billing could not be loaded.');
  } finally {
    loading.value = false;
  }
}
watch(() => props.projectId, () => load(), { immediate: true });
watch(() => props.refreshVersion, () => load({ quiet: true }));

const link = computed(() => billing.value?.link ?? null);
const agreement = computed(() => link.value?.agreement ?? null);
const milestones = computed(() => billing.value?.milestones ?? []);
const invoices = computed(() => billing.value?.invoices ?? []);

// ---- Assign stories (one dialog, one submit) ----
const assigning = reactive({ busy: false, epicId: '', error: '', milestoneId: '', open: false, query: '', selected: [], stories: [], loaded: false });
const epics = computed(() => [...new Map(assigning.stories.map((story) => [story.epicId, story.epicTitle])).entries()].map(([id, title]) => ({ id, title })));
const shownStories = computed(() => filterStories(assigning.stories, { epicId: assigning.epicId, query: assigning.query }));
const milestoneName = (id) => milestones.value.find((milestone) => milestone.id === id)?.name ?? '';
const allShownSelected = computed(() => shownStories.value.length > 0 && shownStories.value.every((story) => assigning.selected.includes(story.id)));

async function openAssign(milestoneId = '') {
  Object.assign(assigning, { busy: false, epicId: '', error: '', milestoneId: milestoneId === '' ? '' : String(milestoneId), open: true, query: '', selected: [] });
  try {
    const result = await apiClient.getStoryMilestones(props.projectId, authSession.state.token);
    assigning.stories = result?.stories ?? [];
    assigning.loaded = true;
  } catch (error) {
    assigning.error = billingErrorMessage(error, 'The stories could not be loaded.');
  }
}

function toggleShown(event) {
  const ids = shownStories.value.map((story) => story.id);
  assigning.selected = event.target.checked
    ? [...new Set([...assigning.selected, ...ids])]
    : assigning.selected.filter((id) => !ids.includes(id));
}

async function submitAssign() {
  if (assigning.busy) return;
  if (!assigning.selected.length) { assigning.error = 'Choose at least one story.'; return; }
  if (assigning.milestoneId === '') { assigning.error = 'Choose a milestone.'; return; }
  assigning.busy = true;
  assigning.error = '';
  const milestoneId = assigning.milestoneId === 'none' ? null : Number(assigning.milestoneId);
  try {
    const result = await apiClient.updateStoryMilestones(props.projectId, assigning.selected.map((storyId) => ({ milestoneId, storyId })), authSession.state.token);
    const count = result?.changed?.length ?? 0;
    notice.value = milestoneId == null
      ? `${count} ${count === 1 ? 'story' : 'stories'} taken off their milestone.`
      : `${count} ${count === 1 ? 'story' : 'stories'} now bill to ${milestoneName(milestoneId)}.`;
    assigning.open = false;
    await load({ quiet: true });
  } catch (error) {
    assigning.error = billingErrorMessage(error, 'The stories could not be assigned. Nothing was changed.');
  } finally {
    assigning.busy = false;
  }
}
</script>

<template>
  <section class="billing-panel" aria-labelledby="billing-heading">
    <h2 id="billing-heading" class="visually-hidden">Billing</h2>
    <p v-if="loading" class="billing-panel__status" role="status">Loading billing…</p>
    <p v-else-if="errorMessage" class="error-banner" role="alert">{{ errorMessage }}</p>

    <template v-else-if="billing">
      <div v-if="notice" class="success-banner d-flex align-items-start justify-content-between gap-2" role="status">
        <span>{{ notice }}</span>
        <button class="btn-close flex-shrink-0" type="button" aria-label="Dismiss message" @click="notice = ''"></button>
      </div>

      <div v-if="!link" class="billing-panel__empty" data-testid="billing-unlinked">
        <i class="bi bi-link-45deg" aria-hidden="true"></i>
        <div>
          <p class="mb-1"><strong>Not linked to invoice-gen.</strong></p>
          <p class="mb-0">
            Link this project from its SOW in invoice-gen, or ask an agent to run <code>link_odin_project</code>.
            <a v-if="billing.invoiceGenUrl" :href="billing.invoiceGenUrl" target="_blank" rel="noopener noreferrer">Open invoice-gen <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></a>
          </p>
        </div>
      </div>

      <template v-else>
        <dl class="billing-facts">
          <div>
            <dt>Client</dt>
            <dd>{{ link.customer?.name || '—' }}<template v-if="link.lineOfBusiness?.name"> · {{ link.lineOfBusiness.name }}</template></dd>
          </div>
          <div>
            <dt>SOW</dt>
            <dd v-if="agreement">
              <a v-if="agreement.url" :href="agreement.url" target="_blank" rel="noopener noreferrer" data-testid="billing-sow-link">{{ agreement.title || 'SOW' }} <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i><span class="visually-hidden"> (opens invoice-gen)</span></a>
              <template v-else>{{ agreement.title || 'SOW' }}</template>
              <span class="billing-badge" :class="{ 'billing-badge--good': agreement.status === 'executed' }">
                <i class="bi" :class="agreement.status === 'executed' ? 'bi-check-circle-fill' : 'bi-circle'" aria-hidden="true"></i>
                {{ agreement.status === 'executed' ? 'Signed' : agreement.status }}
              </span>
            </dd>
            <dd v-else>No SOW. All time bills to the No SOW line.</dd>
          </div>
          <div>
            <dt>Last update from invoice-gen</dt>
            <dd>{{ billing.heardAt ? formatBillingDate(billing.heardAt, { time: true }) : 'Never' }}</dd>
          </div>
        </dl>

        <section class="billing-section" aria-labelledby="billing-milestones-heading">
          <div class="billing-section__header">
            <h3 id="billing-milestones-heading">Milestones</h3>
            <button v-if="agreement && milestones.length" class="secondary-button secondary-button--compact" type="button" data-testid="billing-assign" @click="openAssign()">
              <i class="bi bi-diagram-3" aria-hidden="true"></i> Assign stories
            </button>
          </div>
          <div class="table-responsive">
            <table class="table table-sm billing-table" data-testid="billing-milestones">
              <thead>
                <tr>
                  <th scope="col">Milestone</th>
                  <th scope="col" class="num">Budget</th>
                  <th scope="col" class="num">Billed</th>
                  <th scope="col" class="num">On drafts</th>
                  <th scope="col" class="num">Ready to bill</th>
                  <th scope="col" class="num">Left</th>
                  <th scope="col" class="num">Stories</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="milestone in milestones" :key="milestone.id">
                  <th scope="row">{{ milestone.name }}</th>
                  <td class="num">{{ formatHours(milestone.budgetHours) }}</td>
                  <td class="num">{{ formatHours(milestone.billedHours) }}</td>
                  <td class="num">{{ formatHours(milestone.claimedUnbilledHours) }}</td>
                  <td class="num">{{ formatHours(milestone.approvedUnclaimedHours) }}</td>
                  <td class="num" :class="{ 'billing-over': remainingHours(milestone) < 0 }">
                    <i v-if="remainingHours(milestone) < 0" class="bi bi-exclamation-triangle-fill" aria-hidden="true"></i>
                    {{ formatHours(remainingHours(milestone)) }}<span v-if="remainingHours(milestone) < 0" class="visually-hidden"> over budget</span>
                  </td>
                  <td class="num">
                    <button class="link-button" type="button" :aria-label="`Assign stories to ${milestone.name}`" @click="openAssign(milestone.id)">{{ milestone.storyCount }}</button>
                  </td>
                </tr>
                <tr class="billing-table__nosow">
                  <th scope="row">No SOW</th>
                  <td class="num">—</td>
                  <td class="num">{{ formatHours(billing.noSow.billedHours) }}</td>
                  <td class="num">{{ formatHours(billing.noSow.claimedUnbilledHours) }}</td>
                  <td class="num">{{ formatHours(billing.noSow.approvedUnclaimedHours) }}</td>
                  <td class="num">—</td>
                  <td class="num">—</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="billing-hint">Time on a story, or on a task under it, bills to the story's milestone. Ready to bill is approved, billable time no invoice holds yet.</p>
        </section>
      </template>

      <section v-if="link || invoices.length" class="billing-section" aria-labelledby="billing-invoices-heading">
        <h3 id="billing-invoices-heading">Invoices</h3>
        <p v-if="!invoices.length" class="billing-hint">No invoices yet.</p>
        <div v-else class="table-responsive">
          <table class="table table-sm billing-table" data-testid="billing-invoices">
            <thead>
              <tr>
                <th scope="col">Invoice</th>
                <th scope="col">Status</th>
                <th scope="col">Issued</th>
                <th scope="col">Due</th>
                <th scope="col" class="num">Hours</th>
                <th scope="col" class="num">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="invoice in invoices" :key="invoice.externalInvoiceId">
                <th scope="row">
                  <a v-if="invoice.url" :href="invoice.url" target="_blank" rel="noopener noreferrer">{{ invoice.number || 'Draft invoice' }}<span class="visually-hidden"> (opens invoice-gen)</span></a>
                  <template v-else>{{ invoice.number || 'Draft invoice' }}</template>
                </th>
                <td>
                  <span class="billing-badge" :class="`billing-badge--${invoice.status}`"><i class="bi" :class="invoiceStatusIcon(invoice.status)" aria-hidden="true"></i> {{ invoiceStatusLabel(invoice.status) }}</span>
                  <span v-if="invoice.overdue" class="billing-badge billing-badge--overdue"><i class="bi bi-exclamation-circle-fill" aria-hidden="true"></i> Overdue</span>
                </td>
                <td>{{ formatBillingDate(invoice.issueDate) }}</td>
                <td>{{ formatBillingDate(invoice.dueDate) }}</td>
                <td class="num">{{ formatHours(invoice.hours) }}</td>
                <td class="num">{{ formatMoney(invoice.totalCents, invoice.currency) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <RequirementsDialog :busy="assigning.busy" :open="assigning.open" title="Assign stories to a milestone" @close="assigning.open = false" @submit="submitAssign">
      <div class="rq-field">
        <label for="billing-assign-milestone">Milestone</label>
        <select id="billing-assign-milestone" v-model="assigning.milestoneId" class="form-select" required>
          <option value="" disabled>Choose a milestone</option>
          <option v-for="milestone in milestones" :key="milestone.id" :value="String(milestone.id)">{{ milestone.name }}</option>
          <option value="none">No milestone (No SOW)</option>
        </select>
      </div>
      <div class="billing-picker__filters">
        <div class="rq-field">
          <label for="billing-assign-search">Find stories</label>
          <input id="billing-assign-search" v-model="assigning.query" class="form-control" type="search" autocomplete="off" placeholder="Story or epic name" />
        </div>
        <div class="rq-field">
          <label for="billing-assign-epic">Epic</label>
          <select id="billing-assign-epic" v-model="assigning.epicId" class="form-select">
            <option value="">All epics</option>
            <option v-for="epic in epics" :key="epic.id" :value="epic.id">{{ epic.title }}</option>
          </select>
        </div>
      </div>
      <fieldset class="billing-picker" :disabled="!assigning.loaded">
        <legend class="visually-hidden">Stories</legend>
        <label v-if="shownStories.length" class="billing-picker__row billing-picker__row--all">
          <input type="checkbox" :checked="allShownSelected" @change="toggleShown" />
          <span>Select all shown ({{ shownStories.length }})</span>
        </label>
        <label v-for="story in shownStories" :key="story.id" class="billing-picker__row">
          <input v-model="assigning.selected" type="checkbox" :value="story.id" />
          <span class="billing-picker__story">
            {{ story.title }}
            <small>{{ story.epicTitle }}<template v-if="story.milestoneId != null"> · now {{ milestoneName(story.milestoneId) }}</template></small>
          </span>
        </label>
        <p v-if="assigning.loaded && !shownStories.length" class="billing-hint mb-0">No stories match.</p>
      </fieldset>
      <p v-if="assigning.error" class="error-banner mb-0" role="alert">{{ assigning.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="assigning.busy" @click="assigning.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="assigning.busy" data-testid="billing-assign-submit">
          {{ assigning.busy ? 'Saving…' : `Assign ${assigning.selected.length || ''} ${assigning.selected.length === 1 ? 'story' : 'stories'}`.replace('  ', ' ') }}
        </button>
      </template>
    </RequirementsDialog>
  </section>
</template>

<style scoped>
.billing-panel {
  display: grid;
  gap: 1rem;
  font-size: 0.875rem;
  line-height: 1.25;
}

.billing-panel__status,
.billing-hint {
  color: var(--text-muted, #5f6b7a);
  font-size: 0.8125rem;
  margin: 0;
}

.billing-panel__empty {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.75rem 1rem;
  border: 1px dashed var(--border-color, #c9d1db);
  border-radius: 0.5rem;
}

.billing-panel__empty .bi {
  font-size: 1.25rem;
}

.billing-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: 0.75rem 1.5rem;
  margin: 0;
}

.billing-facts dt {
  color: var(--text-muted, #5f6b7a);
  font-size: 0.75rem;
  font-weight: 600;
}

.billing-facts dd {
  margin: 0.25rem 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.billing-section {
  display: grid;
  gap: 0.5rem;
}

.billing-section h3 {
  font-size: 1rem;
  line-height: 1.2;
  margin: 0;
}

.billing-section__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.billing-table {
  margin: 0;
}

.billing-table .num {
  text-align: right;
  white-space: nowrap;
}

.billing-table th[scope='row'] {
  font-weight: 600;
}

.billing-table__nosow th,
.billing-table__nosow td {
  color: var(--text-muted, #5f6b7a);
}

.billing-over {
  color: var(--danger-color, #b42318);
  font-weight: 600;
}

.billing-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--border-color, #c9d1db);
  font-size: 0.75rem;
  white-space: nowrap;
}

.billing-badge--good,
.billing-badge--paid {
  border-color: #2e7d32;
  color: #1b5e20;
}

.billing-badge--overdue {
  border-color: #b42318;
  color: #b42318;
  margin-left: 0.25rem;
}

.link-button {
  min-width: 2.75rem;
  min-height: 2.75rem;
  padding: 0 0.5rem;
  border: 0;
  background: none;
  color: var(--link-color, #0b5cad);
  text-decoration: underline;
}

.link-button:focus-visible {
  outline: 2px solid var(--focus-color, #0b5cad);
  outline-offset: 2px;
}

.billing-picker__filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 0.5rem;
}

.billing-picker {
  display: grid;
  gap: 0.25rem;
  max-height: 18rem;
  overflow-y: auto;
  margin: 0;
  padding: 0.25rem 0;
  border: 0;
  border-top: 1px solid var(--border-color, #c9d1db);
}

.billing-picker__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  padding: 0 0.25rem;
}

.billing-picker__row input {
  width: 1.125rem;
  height: 1.125rem;
  flex-shrink: 0;
}

.billing-picker__row--all {
  font-weight: 600;
}

.billing-picker__story {
  display: grid;
}

.billing-picker__story small {
  color: var(--text-muted, #5f6b7a);
  font-size: 0.75rem;
}

</style>
