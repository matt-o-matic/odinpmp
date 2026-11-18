<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import PortalHeader from '../components/requirements/portal/PortalHeader.vue';
import { apiClient } from '../lib/auth/index.js';
import {
  DEFAULT_ATTACHMENT_LIMITS,
  attachmentLimitsText,
  filterReporterTickets,
  formatFileSize,
  isClosedTicketStatus,
  readFileAsBase64,
  submissionFieldErrors,
  validateAttachments,
} from '../lib/projects/ticket-intake.js';
import { TICKET_CATEGORIES, TICKET_SEVERITIES, categoryLabel, severityLabel } from '../lib/projects/ticket-board.js';
import { formatAgo } from '../lib/requirements/requirements-time.js';

// The reporter's page at /report/:token (D-011, D-021). The intake token is the only
// credential; the page files tickets against the token's project and lists the tickets
// filed through this link. The app's header and navigation are hidden (route meta `portal`).
const PAGE_SIZE = 10;
const route = useRoute();

const intake = ref(null);
const status = ref('loading');
const draft = reactive(emptyDraft());
const files = ref([]);
const fieldErrors = ref({});
const formError = ref('');
const sending = ref(false);
const submitted = ref(null);
const listFilter = ref('all');
const listLimit = ref(PAGE_SIZE);
const highlighted = ref('');
const successPanel = ref(null);
const unavailableHeading = ref(null);

const token = computed(() => String(route.params.token ?? ''));
const limits = computed(() => intake.value?.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS);
const eyebrow = computed(() => (intake.value?.projectName ? `${intake.value.projectName} · issue reporting` : 'Issue reporting'));
const tickets = computed(() => intake.value?.tickets ?? []);
const listed = computed(() => filterReporterTickets(tickets.value, { filter: listFilter.value, limit: listLimit.value }));

function emptyDraft() {
  return {
    actualResult: '',
    buildVersion: '',
    category: 'defect',
    description: '',
    environmentId: '',
    expectedResult: '',
    foundInReleaseId: '',
    name: '',
    reproSteps: '',
    severity: 'S3',
  };
}

let sequence = 0;
async function load({ quiet = false } = {}) {
  const current = ++sequence;
  if (!token.value) return;
  if (!quiet) status.value = 'loading';
  try {
    const client = quiet ? apiClient.passive : apiClient;
    const result = await client.getTicketIntake(token.value);
    if (current !== sequence) return;
    intake.value = result.intake;
    status.value = 'ready';
    if (!quiet) revealLinkedTicket();
  } catch (error) {
    if (current !== sequence) return;
    if (quiet && Number(error?.status) !== 404) return;
    status.value = Number(error?.status) === 404 ? 'unavailable' : 'failed';
    await nextTick();
    unavailableHeading.value?.focus();
  }
}

// Links in the acknowledgement and status emails end in #ticket-<reference>.
async function revealLinkedTicket() {
  const reference = String(route.hash ?? '').replace(/^#ticket-/, '');
  if (!reference || reference === route.hash) return;
  const index = tickets.value.findIndex((ticket) => ticket.reference === reference);
  if (index === -1) return;
  listFilter.value = 'all';
  listLimit.value = Math.max(PAGE_SIZE, index + 1);
  highlighted.value = reference;
  await nextTick();
  document.getElementById(`ticket-${reference}`)?.scrollIntoView?.({ block: 'center' });
}

watch(token, () => {
  intake.value = null;
  load();
}, { immediate: true });

function chooseFiles(event) {
  const chosen = Array.from(event.target.files ?? []);
  files.value = [...files.value, ...chosen];
  event.target.value = '';
  const problems = validateAttachments(files.value, limits.value);
  fieldErrors.value = { ...fieldErrors.value, attachments: problems.join(' ') };
  if (!problems.length) delete fieldErrors.value.attachments;
}

function removeFile(index) {
  files.value = files.value.filter((_file, position) => position !== index);
  const problems = validateAttachments(files.value, limits.value);
  fieldErrors.value = { ...fieldErrors.value, attachments: problems.join(' ') };
  if (!problems.length) delete fieldErrors.value.attachments;
}

const FIELD_IDS = { attachments: 'report-attachments', name: 'report-summary' };

async function focusFirstError() {
  await nextTick();
  const first = Object.keys(fieldErrors.value).find((key) => FIELD_IDS[key]);
  if (first) document.getElementById(FIELD_IDS[first])?.focus();
}

function validate() {
  const errors = {};
  if (!draft.name.trim()) errors.name = 'Enter a short summary of the issue.';
  const problems = validateAttachments(files.value, limits.value);
  if (problems.length) errors.attachments = problems.join(' ');
  fieldErrors.value = errors;
  return Object.keys(errors).length === 0;
}

async function submit() {
  if (sending.value) return;
  formError.value = '';
  if (!validate()) {
    formError.value = 'Check the highlighted fields.';
    await focusFirstError();
    return;
  }
  sending.value = true;
  try {
    const attachments = [];
    for (const file of files.value) {
      attachments.push({ contentBase64: await readFileAsBase64(file), contentType: file.type, fileName: file.name });
    }
    const result = await apiClient.submitTicketIntake(token.value, {
      ...draft,
      attachments,
      environmentId: draft.environmentId || null,
      foundInReleaseId: draft.foundInReleaseId || null,
      name: draft.name.trim(),
    });
    submitted.value = result.ticket;
    Object.assign(draft, emptyDraft());
    files.value = [];
    fieldErrors.value = {};
    await load({ quiet: true });
    await nextTick();
    successPanel.value?.focus();
  } catch (error) {
    const code = Number(error?.status);
    if (code === 404) {
      status.value = 'unavailable';
    } else if (code === 400 && error?.data?.details) {
      fieldErrors.value = submissionFieldErrors(error);
      formError.value = 'Check the highlighted fields.';
      await focusFirstError();
    } else if (code === 429) {
      formError.value = 'Too many reports from this link for now. Try again in an hour.';
    } else if (code === 400 || code === 413) {
      formError.value = error.message;
    } else {
      formError.value = 'Your report didn’t send. Check your connection and try again.';
    }
  } finally {
    sending.value = false;
  }
}

async function reportAnother() {
  submitted.value = null;
  await nextTick();
  document.getElementById(FIELD_IDS.name)?.focus();
}

function describedBy(field, hintId = '') {
  return [hintId, fieldErrors.value[field] ? `${FIELD_IDS[field] ?? field}-error` : ''].filter(Boolean).join(' ') || undefined;
}
</script>

<template>
  <div class="rq-workspace rq-portal ticket-report">
    <PortalHeader :eyebrow="eyebrow" :show-link="false" title="Report an issue" />

    <div class="rq-review-page ticket-report__page">
      <p v-if="status === 'loading'" class="rq-review-card rq-small rq-muted mb-0" role="status">Loading…</p>

      <section v-else-if="status !== 'ready'" class="rq-review-card rq-stack" aria-labelledby="ticket-report-problem" data-testid="ticket-report-unavailable">
        <h1 id="ticket-report-problem" ref="unavailableHeading" class="rq-title rq-title--lg" tabindex="-1">
          {{ status === 'unavailable' ? 'This link isn’t available' : 'The page didn’t load' }}
        </h1>
        <template v-if="status === 'unavailable'">
          <p class="mb-0">The link may have expired or been turned off, or it may have been copied incompletely.</p>
          <p class="mb-0">Contact the team that sent it to you and ask for a new link.</p>
        </template>
        <template v-else>
          <p class="mb-0">Something went wrong while loading this page.</p>
          <div><button class="primary-button" type="button" @click="load()">Try again</button></div>
        </template>
      </section>

      <template v-else>
        <section class="rq-review-card rq-stack" aria-labelledby="ticket-report-heading">
          <div>
            <h1 id="ticket-report-heading" class="rq-title rq-title--lg">Report an issue to {{ intake.projectName || 'the team' }}</h1>
            <p class="rq-small rq-muted mb-0">
              <template v-if="intake.reporterName">Hello {{ intake.reporterName }}. </template>
              Your report goes straight to the project team. We email you a confirmation and again whenever its status changes.
            </p>
          </div>

          <div v-if="submitted" ref="successPanel" class="success-banner ticket-report__success" role="status" tabindex="-1" data-testid="ticket-report-success">
            <p class="mb-1"><strong>Thanks, we received your report.</strong></p>
            <p class="mb-2">“{{ submitted.name }}” is reference <strong>{{ submitted.reference }}</strong>, status {{ submitted.statusLabel }}. A confirmation is on its way to your email.</p>
            <button class="ghost-button ghost-button--compact" type="button" @click="reportAnother">Report another issue</button>
          </div>

          <form v-else class="rq-stack" novalidate aria-labelledby="ticket-report-heading" @submit.prevent="submit">
            <p v-if="formError" class="error-banner mb-0" role="alert">{{ formError }}</p>

            <div class="rq-field">
              <label for="report-summary">Summary <span class="rq-muted">(required)</span></label>
              <input
                id="report-summary"
                v-model="draft.name"
                class="form-control"
                maxlength="200"
                autocomplete="off"
                :aria-invalid="fieldErrors.name ? 'true' : 'false'"
                :aria-describedby="describedBy('name', 'report-summary-hint')"
              />
              <p id="report-summary-hint" class="rq-field__hint">One line, for example “Checkout button does nothing on the payment page”.</p>
              <p v-if="fieldErrors.name" id="report-summary-error" class="ticket-report__error">{{ fieldErrors.name }}</p>
            </div>

            <div class="ticket-report__grid">
              <div class="rq-field">
                <label for="report-category">Type</label>
                <select id="report-category" v-model="draft.category" class="form-select">
                  <option v-for="value in TICKET_CATEGORIES" :key="value" :value="value">{{ categoryLabel(value) }}</option>
                </select>
              </div>
              <div class="rq-field">
                <label for="report-severity">Severity</label>
                <select id="report-severity" v-model="draft.severity" class="form-select">
                  <option v-for="value in TICKET_SEVERITIES" :key="value" :value="value">{{ severityLabel(value) }}</option>
                </select>
              </div>
            </div>

            <div class="rq-field">
              <label for="report-description">What happened?</label>
              <textarea id="report-description" v-model="draft.description" class="form-control" maxlength="8000" rows="4"></textarea>
            </div>

            <div class="rq-field">
              <label for="report-repro">Steps to reproduce</label>
              <textarea id="report-repro" v-model="draft.reproSteps" class="form-control" maxlength="8000" rows="4" aria-describedby="report-repro-hint"></textarea>
              <p id="report-repro-hint" class="rq-field__hint">Number each step so the team can follow along.</p>
            </div>

            <details class="ticket-report__more">
              <summary>More detail (optional)</summary>
              <div class="rq-stack ticket-report__more-body">
                <div class="ticket-report__grid">
                  <div class="rq-field">
                    <label for="report-expected">What did you expect?</label>
                    <textarea id="report-expected" v-model="draft.expectedResult" class="form-control" maxlength="8000" rows="3"></textarea>
                  </div>
                  <div class="rq-field">
                    <label for="report-actual">What happened instead?</label>
                    <textarea id="report-actual" v-model="draft.actualResult" class="form-control" maxlength="8000" rows="3"></textarea>
                  </div>
                </div>
                <div class="ticket-report__grid">
                  <div v-if="intake.environments.length" class="rq-field">
                    <label for="report-environment">Environment</label>
                    <select id="report-environment" v-model="draft.environmentId" class="form-select">
                      <option value="">Not sure</option>
                      <option v-for="entry in intake.environments" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
                    </select>
                  </div>
                  <div v-if="intake.releases.length" class="rq-field">
                    <label for="report-release">Found in release</label>
                    <select id="report-release" v-model="draft.foundInReleaseId" class="form-select">
                      <option value="">Not sure</option>
                      <option v-for="entry in intake.releases" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
                    </select>
                  </div>
                  <div class="rq-field">
                    <label for="report-build">Build or version</label>
                    <input id="report-build" v-model="draft.buildVersion" class="form-control" maxlength="120" autocomplete="off" />
                  </div>
                </div>
              </div>
            </details>

            <div class="rq-field">
              <label for="report-attachments">Attachments</label>
              <input
                id="report-attachments"
                class="form-control"
                type="file"
                multiple
                :accept="limits.allowedTypes.join(',')"
                :aria-invalid="fieldErrors.attachments ? 'true' : 'false'"
                :aria-describedby="describedBy('attachments', 'report-attachments-hint')"
                @change="chooseFiles"
              />
              <p id="report-attachments-hint" class="rq-field__hint">{{ attachmentLimitsText(limits) }}</p>
              <p v-if="fieldErrors.attachments" id="report-attachments-error" class="ticket-report__error">{{ fieldErrors.attachments }}</p>
              <ul v-if="files.length" class="ticket-report__files" aria-label="Chosen files">
                <li v-for="(file, index) in files" :key="`${file.name}-${index}`">
                  <i class="bi bi-paperclip" aria-hidden="true"></i>
                  <span class="ticket-report__file-name">{{ file.name }}</span>
                  <span class="rq-xs rq-muted">{{ formatFileSize(file.size) }}</span>
                  <button class="ghost-button ghost-button--icon" type="button" :aria-label="`Remove ${file.name}`" @click="removeFile(index)">
                    <i class="bi bi-x-lg" aria-hidden="true"></i>
                  </button>
                </li>
              </ul>
            </div>

            <div>
              <button class="primary-button" type="submit" :disabled="sending">{{ sending ? 'Sending…' : 'Send report' }}</button>
            </div>
          </form>
        </section>

        <section class="rq-review-card rq-stack" aria-labelledby="ticket-report-list-heading" data-testid="ticket-report-list">
          <div class="rq-row rq-row--between rq-row--wrap">
            <h2 id="ticket-report-list-heading" class="rq-title rq-title--md">Your reports</h2>
            <div v-if="tickets.length" class="ticket-report__filter">
              <label for="report-list-filter" class="rq-xs rq-muted">Show</label>
              <select id="report-list-filter" v-model="listFilter" class="form-select form-select-sm" @change="listLimit = PAGE_SIZE">
                <option value="all">All</option>
                <option value="open">Open</option>
                <option value="closed">Finished</option>
              </select>
            </div>
          </div>
          <p v-if="!tickets.length" class="rq-small rq-muted mb-0">Reports you send from this page appear here with their status.</p>
          <p v-else-if="!listed.total" class="rq-small rq-muted mb-0">No reports match this filter.</p>
          <ul v-else class="ticket-report__list">
            <li
              v-for="ticket in listed.visible"
              :id="`ticket-${ticket.reference}`"
              :key="ticket.id"
              class="ticket-report__item"
              :class="{ 'ticket-report__item--linked': highlighted === ticket.reference }"
            >
              <div class="ticket-report__item-main">
                <strong class="ticket-report__item-name">{{ ticket.name }}</strong>
                <span class="rq-xs rq-muted">Ref {{ ticket.reference }} · {{ categoryLabel(ticket.category) }} · {{ severityLabel(ticket.severity) }}<template v-if="ticket.updatedAt"> · updated {{ formatAgo(ticket.updatedAt) }}</template></span>
              </div>
              <span class="rq-chip" :class="isClosedTicketStatus(ticket.status) ? 'rq-chip--ok' : 'rq-chip--neutral'">{{ ticket.statusLabel }}</span>
            </li>
          </ul>
          <div v-if="listed.total > listed.visible.length">
            <button class="ghost-button ghost-button--compact" type="button" @click="listLimit += PAGE_SIZE">
              Show more ({{ listed.total - listed.visible.length }} more)
            </button>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ticket-report__page { display: grid; gap: 1rem; align-content: start; }
.ticket-report__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.75rem; }
.ticket-report .form-control,
.ticket-report .form-select { min-height: 2.75rem; }
.ticket-report .form-select-sm { min-height: 2.75rem; width: auto; }
.ticket-report__error { margin: 0; color: var(--rq-outstanding); font-size: 0.8125rem; font-weight: 600; }
.ticket-report__success:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 60%, transparent); outline-offset: 2px; }
.ticket-report__more { border: 1px solid var(--line); border-radius: 0.5rem; padding: 0 0.75rem; }
.ticket-report__more summary { display: flex; align-items: center; min-height: 2.75rem; font-weight: 700; font-size: 0.875rem; cursor: pointer; }
.ticket-report__more-body { padding-bottom: 0.75rem; }
.ticket-report__files { display: grid; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
.ticket-report__files li { display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; }
.ticket-report__file-name { min-width: 0; overflow-wrap: anywhere; }
.ticket-report__files .ghost-button--icon { width: 2.75rem; height: 2.75rem; margin-left: auto; flex: none; }
.ticket-report__filter { display: flex; align-items: center; gap: 0.5rem; }
.ticket-report__list { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
.ticket-report__item { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; padding: 0.65rem 0.75rem; border: 1px solid var(--line); border-radius: 0.5rem; }
.ticket-report__item--linked { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent); }
.ticket-report__item-main { display: grid; gap: 0.15rem; min-width: 0; }
.ticket-report__item-name { font-size: 0.875rem; overflow-wrap: anywhere; }
@media (max-width: 36rem) {
  .ticket-report__item { flex-direction: column; }
}
</style>
