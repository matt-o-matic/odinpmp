<script setup>
import { computed, reactive, ref, watch } from 'vue';

import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { copyText } from '../../lib/clipboard.js';
import { INTAKE_LINK_STATE_LABELS, filterIntakeLinks, intakeLinkState } from '../../lib/projects/ticket-intake.js';
import { endOfLocalDayIso, formatShortDate, toDateInputValue } from '../../lib/requirements/requirements-time.js';

// The project's ticket intake links (D-028). Each link lets one external reporter file
// tickets against this project at /report/:token; creating one emails it to the reporter.
const props = defineProps({
  projectId: { required: true, type: String },
  refreshVersion: { default: 0, type: Number },
});

const invitations = ref([]);
const loaded = ref(false);
const loadError = ref('');
const filters = reactive({ query: '', state: 'active' });
const copyStatus = reactive({ id: '', text: '' });
const create = reactive({ copyStatus: '', email: '', error: '', expiresOn: '', name: '', open: false, result: null, saving: false });
const revoke = reactive({ error: '', invitation: null, saving: false });

const token = computed(() => authSession.state.token);
const rows = computed(() => filterIntakeLinks(invitations.value, filters).map((invitation) => ({
  invitation,
  label: invitation.reporterName || invitation.reporterEmail,
  state: intakeLinkState(invitation),
})));
const minExpiry = computed(() => toDateInputValue(new Date(Date.now() + 24 * 60 * 60 * 1000)));
const sendFailure = computed(() => ({
  'mail-not-configured': 'Email isn’t set up on this server, so nothing was sent.',
  'queue-failed': 'The email couldn’t be queued.',
})[create.result?.email?.reason] ?? '');

let sequence = 0;
async function load({ quiet = false } = {}) {
  if (!props.projectId) return;
  const current = ++sequence;
  try {
    const client = quiet ? apiClient.passive : apiClient;
    const result = await client.listTicketIntakeInvitations(props.projectId, token.value);
    if (current !== sequence) return;
    invitations.value = result.invitations ?? [];
    loadError.value = '';
  } catch (error) {
    if (current !== sequence || quiet) return;
    loadError.value = error.message ?? 'Unable to load intake links.';
  } finally {
    if (current === sequence) loaded.value = true;
  }
}

watch(() => props.projectId, () => load(), { immediate: true });
watch(() => props.refreshVersion, () => load({ quiet: true }));

async function copyLink(invitation) {
  const copied = await copyText(invitation.url);
  Object.assign(copyStatus, { id: invitation.id, text: copied ? 'Link copied.' : 'Copying failed. Select the link and copy it.' });
}

function openCreate() {
  Object.assign(create, { copyStatus: '', email: '', error: '', expiresOn: '', name: '', open: true, result: null, saving: false });
}

function closeCreate() {
  create.open = false;
  create.result = null;
}

async function submitCreate() {
  if (create.result) {
    closeCreate();
    return;
  }
  if (create.saving) return;
  const email = create.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    create.error = 'Enter the reporter’s email address.';
    return;
  }
  const expiresAt = create.expiresOn ? endOfLocalDayIso(create.expiresOn) : null;
  if (create.expiresOn && !expiresAt) {
    create.error = 'Choose a valid expiry date, or leave it empty.';
    return;
  }
  create.saving = true;
  create.error = '';
  try {
    create.result = await apiClient.createTicketIntakeInvitation(props.projectId, {
      expiresAt,
      reporterEmail: email,
      reporterName: create.name.trim(),
    }, token.value);
    await load({ quiet: true });
  } catch (error) {
    create.error = error.message ?? 'Unable to create the intake link.';
  } finally {
    create.saving = false;
  }
}

async function copyNewLink() {
  create.copyStatus = (await copyText(create.result?.url)) ? 'Link copied.' : 'Copying failed. Select the link and copy it.';
}

function openRevoke(invitation) {
  Object.assign(revoke, { error: '', invitation, saving: false });
}

async function submitRevoke() {
  if (revoke.saving || !revoke.invitation) return;
  revoke.saving = true;
  revoke.error = '';
  try {
    await apiClient.revokeTicketIntakeInvitation(props.projectId, revoke.invitation.id, token.value);
    revoke.invitation = null;
    await load({ quiet: true });
  } catch (error) {
    revoke.error = error.message ?? 'Unable to revoke the intake link.';
  } finally {
    revoke.saving = false;
  }
}
</script>

<template>
  <div class="intake-links">
    <div class="intake-links__intro">
      <p class="intake-links__note">
        An intake link lets one outside reporter file tickets against this project only. Their tickets wait for review
        before the assistant can see them, and they are emailed when a ticket’s status changes.
      </p>
      <button class="btn btn-sm btn-primary" type="button" @click="openCreate">
        <i class="bi bi-link-45deg" aria-hidden="true"></i> New intake link
      </button>
    </div>

    <div class="intake-links__filters">
      <label for="intake-links-state">Show
        <select id="intake-links-state" v-model="filters.state" class="form-select form-select-sm">
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="revoked">Revoked</option>
          <option value="all">All</option>
        </select>
      </label>
      <label for="intake-links-search">Reporter
        <input id="intake-links-search" v-model="filters.query" class="form-control form-control-sm" type="search" autocomplete="off" />
      </label>
    </div>

    <div v-if="loadError" class="alert alert-danger d-flex align-items-center justify-content-between gap-2" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-sm btn-outline-danger" type="button" @click="load()">Try again</button>
    </div>
    <p v-else-if="!loaded" class="empty-state" role="status">Loading intake links…</p>
    <div v-else class="table-responsive" tabindex="0">
      <table class="table table-sm align-middle intake-links__table">
        <caption class="visually-hidden">Intake links</caption>
        <thead>
          <tr><th scope="col">Reporter</th><th scope="col">Link</th><th scope="col">Submissions</th><th scope="col">State</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.invitation.id">
            <td data-label="Reporter">
              <strong>{{ row.label }}</strong>
              <span v-if="row.invitation.reporterName" class="intake-links__meta">{{ row.invitation.reporterEmail }}</span>
            </td>
            <td data-label="Link" class="intake-links__link-cell">
              <template v-if="row.invitation.url">
                <code class="intake-links__url" data-testid="intake-link-url">{{ row.invitation.url }}</code>
                <span class="intake-links__copy">
                  <button class="btn btn-sm btn-outline-secondary" type="button" :aria-label="`Copy the link for ${row.label}`" @click="copyLink(row.invitation)">
                    <i class="bi bi-clipboard" aria-hidden="true"></i> Copy
                  </button>
                  <span class="intake-links__meta" role="status">{{ copyStatus.id === row.invitation.id ? copyStatus.text : '' }}</span>
                </span>
              </template>
              <span v-else class="intake-links__meta">No longer works</span>
            </td>
            <td data-label="Submissions">{{ row.invitation.submissionCount }}</td>
            <td data-label="State">
              {{ INTAKE_LINK_STATE_LABELS[row.state] }}
              <span v-if="row.state === 'active' && row.invitation.expiresAt" class="intake-links__meta">until {{ formatShortDate(row.invitation.expiresAt) }}</span>
            </td>
            <td class="text-end intake-links__actions">
              <button
                v-if="!row.invitation.revokedAt"
                class="btn btn-sm btn-outline-danger"
                type="button"
                :aria-label="`Revoke the link for ${row.label}`"
                @click="openRevoke(row.invitation)"
              >Revoke</button>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="5" class="empty-state">{{ invitations.length ? 'No intake links match.' : 'No intake links yet.' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <RequirementsDialog
      :busy="create.saving"
      :open="create.open"
      :title="create.result ? (create.result.email?.sent ? 'Link sent' : 'Link created') : 'New intake link'"
      @close="closeCreate"
      @submit="submitCreate"
    >
      <template v-if="!create.result">
        <div class="rq-field">
          <label for="intake-link-email">Reporter email</label>
          <input id="intake-link-email" v-model="create.email" class="form-control" type="email" autocomplete="off" required />
          <p class="rq-field__hint">We email the link here. Replies and status updates go to this address too.</p>
        </div>
        <div class="rq-field">
          <label for="intake-link-name">Reporter name <span class="rq-field__hint d-inline">(optional)</span></label>
          <input id="intake-link-name" v-model="create.name" class="form-control" maxlength="160" autocomplete="off" />
        </div>
        <div class="rq-field">
          <label for="intake-link-expiry">Works until <span class="rq-field__hint d-inline">(optional)</span></label>
          <input id="intake-link-expiry" v-model="create.expiresOn" class="form-control" type="date" :min="minExpiry" aria-describedby="intake-link-expiry-hint" />
          <p id="intake-link-expiry-hint" class="rq-field__hint">Leave empty to keep the link working until you revoke it.</p>
        </div>
        <p v-if="create.error" class="error-banner mb-0" role="alert">{{ create.error }}</p>
      </template>
      <template v-else>
        <p v-if="create.result.email?.sent" class="success-banner mb-0" role="status">Sent to {{ create.result.email.recipient }}.</p>
        <p v-else-if="sendFailure" class="error-banner mb-0" role="alert">{{ sendFailure }} Copy the link and send it yourself.</p>
        <p class="rq-small mb-0">You can copy the link from the Intake links list at any time.</p>
        <code class="rq-secret" data-testid="intake-new-link-url">{{ create.result.url }}</code>
        <div class="d-flex align-items-center gap-2">
          <button class="ghost-button ghost-button--compact" type="button" data-autofocus @click="copyNewLink">
            <i class="bi bi-clipboard" aria-hidden="true"></i>Copy link
          </button>
          <span class="rq-xs rq-muted" role="status">{{ create.copyStatus }}</span>
        </div>
      </template>
      <template #footer>
        <template v-if="!create.result">
          <button class="ghost-button" type="button" :disabled="create.saving" @click="closeCreate">Cancel</button>
          <button class="primary-button" type="submit" :disabled="create.saving">{{ create.saving ? 'Sending…' : 'Create and send link' }}</button>
        </template>
        <button v-else class="primary-button" type="submit">Done</button>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog
      :busy="revoke.saving"
      confirm-label="Revoke link"
      :error="revoke.error"
      :open="Boolean(revoke.invitation)"
      title="Revoke this intake link?"
      @close="revoke.invitation = null"
      @confirm="submitRevoke"
    >
      <p class="mb-0">{{ revoke.invitation?.reporterName || revoke.invitation?.reporterEmail }} can no longer file tickets or see their reports. Tickets they already filed stay in the project.</p>
    </RequirementsConfirmDialog>
  </div>
</template>

<style scoped>
.intake-links{display:grid;gap:.75rem}
.intake-links__intro{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}
.intake-links__intro .btn{min-height:2.75rem;white-space:nowrap}
.intake-links__note{color:var(--bs-secondary-color);margin:0;max-width:48rem}
.intake-links__filters{display:flex;flex-wrap:wrap;gap:.75rem;align-items:end}
.intake-links__filters label{display:grid;gap:.25rem;font-size:.75rem;font-weight:600}
.intake-links__filters .form-select,.intake-links__filters .form-control{min-height:2.75rem;min-width:12rem}
.intake-links__meta{display:block;color:var(--bs-secondary-color);font-size:.75rem}
.intake-links__link-cell{min-width:16rem}
.intake-links__url{display:block;font-size:.75rem;overflow-wrap:anywhere;color:var(--bs-body-color)}
.intake-links__copy{display:flex;align-items:center;gap:.5rem;margin-top:.25rem}
.intake-links .table .btn{min-height:2.75rem}
.table th{white-space:nowrap;font-size:.75rem;color:var(--bs-secondary-color)}
.empty-state{text-align:center;color:var(--bs-secondary-color);padding:1rem}
@media(max-width:48rem){
.intake-links__intro{display:grid}
.intake-links__intro .btn{width:100%}
.intake-links__filters label{flex:1 1 100%}
.intake-links__filters .form-select,.intake-links__filters .form-control{min-width:0;width:100%}
/* Narrow screens: each link is a stacked card, labelled field by field. */
.intake-links__table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.intake-links__table,.intake-links__table tbody,.intake-links__table tr,.intake-links__table td{display:block;width:100%}
.intake-links__table tr{padding:.5rem .75rem;border-bottom:1px solid var(--bs-border-color)}
.intake-links__table tr:last-child{border-bottom:0}
.intake-links__table td{padding:.25rem 0;border:0;text-align:left}
.intake-links__table td[data-label]::before{content:attr(data-label);display:block;color:var(--bs-secondary-color);font-size:.75rem;font-weight:600}
.intake-links__link-cell{min-width:0}
.intake-links__actions .btn{width:100%}
.table-responsive{border:1px solid var(--bs-border-color);border-radius:.5rem}
}
</style>
