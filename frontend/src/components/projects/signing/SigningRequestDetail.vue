<script setup>
import { computed, reactive, ref, useId, watch } from 'vue';

import { apiClient } from '../../../lib/auth/index.js';
import { fileSizeLabel, saveBlob } from '../../../lib/projects/project-files.js';
import {
  signerMailProblem,
  signerStatus,
  signingErrorMessage,
  signingEventLine,
  signingKindLabel,
  signingProgressLabel,
  signingStatus,
  signingTimeLabel,
} from '../../../lib/projects/project-signing.js';
import RequirementsConfirmDialog from '../../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../../requirements/RequirementsDialog.vue';

// One signature request as the team sees it: its documents, signers and history, with the
// actions open while it waits (remind, remove a signer, withdraw) and the certificate once
// everyone has signed. The API refuses those actions to anyone without decision rights.
const props = defineProps({
  open: { default: false, type: Boolean },
  projectId: { default: '', type: String },
  requestId: { default: '', type: String },
  token: { default: '', type: String },
});

const emit = defineEmits(['changed', 'close']);

const uid = useId();
const reasonId = `${uid}-reason`;
const request = ref(null);
const loading = ref(false);
const error = ref('');
const status = ref('');
const busy = ref('');
const confirm = reactive({ error: '', kind: '', reason: '', saving: false, signer: null });

const title = computed(() => request.value?.title ?? 'Signature request');
// Only people with decision rights can remind, remove or withdraw (the API says which).
const canManage = ref(false);
const pending = computed(() => request.value?.status === 'pending');
const pendingSigners = computed(() => (request.value?.signers ?? []).filter((signer) => signer.status === 'pending'));
const shownSigners = computed(() => (request.value?.signers ?? []));

async function load() {
  if (!props.requestId) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await apiClient.getSigningRequest(props.projectId, props.requestId, props.token);
    request.value = result.request;
    canManage.value = result.canManage === true;
  } catch (loadError) {
    error.value = signingErrorMessage(loadError, 'Unable to load this request.');
  } finally {
    loading.value = false;
  }
}

watch(() => [props.open, props.requestId], ([open]) => {
  status.value = '';
  if (open) {
    request.value = null;
    load();
  }
}, { immediate: true });

async function act(key, run, done) {
  if (busy.value) return;
  busy.value = key;
  error.value = '';
  status.value = '';
  try {
    const result = await run();
    if (result?.request) request.value = result.request;
    status.value = done(result);
    emit('changed');
  } catch (actionError) {
    error.value = signingErrorMessage(actionError, 'That did not work. Try again.');
  } finally {
    busy.value = '';
  }
}

function remind(signer = null) {
  act(`remind-${signer?.id ?? 'all'}`, () => apiClient.remindSigningSigners(props.projectId, props.requestId, signer ? { signerId: signer.id } : {}, props.token),
    (result) => (result.reminded ? `Reminder sent to ${result.reminded === 1 ? (signer?.name ?? '1 signer') : `${result.reminded} signers`}.` : 'No reminder could be sent. Check the signers below.'));
}

async function download(document) {
  await act(`doc-${document.position}`, async () => {
    const { blob } = await apiClient.getSigningDocument(props.projectId, props.requestId, document.position, props.token, { download: true });
    saveBlob(blob, document.fileName);
    return null;
  }, () => '');
}

async function certificate() {
  await act('certificate', async () => {
    const { blob } = await apiClient.getSigningCertificate(props.projectId, props.requestId, props.token);
    saveBlob(blob, `${request.value?.title || 'Signature'} certificate.pdf`);
    return null;
  }, () => '');
}

function askCancel() {
  Object.assign(confirm, { error: '', kind: 'cancel', reason: '', saving: false, signer: null });
}

function askRemove(signer) {
  Object.assign(confirm, { error: '', kind: 'remove', reason: '', saving: false, signer });
}

function closeConfirm() {
  if (!confirm.saving) confirm.kind = '';
}

async function confirmAction() {
  if (confirm.saving) return;
  confirm.saving = true;
  confirm.error = '';
  const reason = confirm.reason.trim();
  try {
    const result = confirm.kind === 'cancel'
      ? await apiClient.cancelSigningRequest(props.projectId, props.requestId, reason ? { reason } : {}, props.token)
      : await apiClient.removeSigningSigner(props.projectId, props.requestId, confirm.signer.id, reason ? { reason } : {}, props.token);
    request.value = result.request;
    status.value = confirm.kind === 'cancel' ? 'Request withdrawn. Signers who had not signed were told.' : `${confirm.signer.name} removed.${result.request.status === 'completed' ? ' Everyone left has signed, so the request is complete.' : ''}`;
    confirm.kind = '';
    emit('changed');
  } catch (actionError) {
    confirm.error = signingErrorMessage(actionError, 'That did not work. Try again.');
  } finally {
    confirm.saving = false;
  }
}

function signerLine(signer) {
  if (signer.status === 'signed') {
    const role = [signer.signedTitle, signer.signedOrganization].filter(Boolean).join(', ');
    return `Signed as ${signer.signedName ?? signer.name}${role ? ` (${role})` : ''}, ${signingTimeLabel(signer.signedAt)}`;
  }
  if (signer.status === 'declined') return `Declined ${signingTimeLabel(signer.declinedAt)}${signer.declineReason ? `: ${signer.declineReason}` : ''}`;
  if (signer.status === 'removed') return `Removed ${signingTimeLabel(signer.removedAt)}${signer.removalReason ? `: ${signer.removalReason}` : ''}`;
  return signer.remindedAt ? `Reminded ${signingTimeLabel(signer.remindedAt)}` : 'Not signed yet';
}
</script>

<template>
  <RequirementsDialog :busy="Boolean(busy)" :open="open" :title="title" @close="emit('close')" @submit="emit('close')">
    <p v-if="loading && !request" class="rq-small rq-muted mb-0" role="status">Loading the request…</p>
    <template v-if="request">
      <div class="signing-detail__summary">
        <span class="signing-status" :class="`signing-status--${signingStatus(request.status).tone}`">
          <i :class="['bi', signingStatus(request.status).icon]" aria-hidden="true"></i>{{ signingStatus(request.status).label }}
        </span>
        <span class="rq-small rq-muted">{{ signingKindLabel(request.kind) }} · {{ request.subject?.name }} · {{ signingProgressLabel(request.progress) }}</span>
        <span class="rq-xs rq-muted">Asked by {{ request.createdBy?.name || 'a team member' }}, {{ signingTimeLabel(request.createdAt) }}</span>
        <span v-if="request.endReason" class="rq-xs">Reason: {{ request.endReason }}</span>
      </div>

      <p class="signing-detail__status" role="status">{{ status }}</p>
      <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>

      <section class="signing-detail__section" aria-label="Signers">
        <h3 class="signing-detail__label">Signers</h3>
        <ul class="signing-detail__list">
          <li v-for="signer in shownSigners" :key="signer.id" class="signing-detail__row">
            <div class="signing-detail__text">
              <span class="signing-detail__line">
                <i :class="['bi', signerStatus(signer.status).icon]" aria-hidden="true"></i>
                <strong>{{ signer.name }}</strong>
                <span class="rq-xs rq-muted">{{ signer.email }}</span>
              </span>
              <span class="rq-xs">{{ signerLine(signer) }}</span>
              <span v-if="signerMailProblem(signer)" class="rq-xs signing-detail__problem"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> {{ signerMailProblem(signer) }}</span>
              <details v-if="signer.evidence" class="signing-detail__evidence rq-xs">
                <summary><i class="bi bi-chevron-down signing-detail__chevron" aria-hidden="true"></i>Evidence</summary>
                <ul>
                  <li><i :class="['bi', signer.sealValid ? 'bi-shield-check' : 'bi-shield-exclamation']" aria-hidden="true"></i> {{ signer.sealValid ? 'Seal checks out' : 'Seal does not match' }}</li>
                  <li>Verified by a code sent to {{ signer.evidence.verification?.sentTo }}</li>
                  <li>IP address {{ signer.evidence.clientIp || 'unknown' }} · {{ signer.evidence.browser?.timeZone }} · {{ signer.evidence.browser?.language }}</li>
                  <li class="signing-detail__hash">Evidence SHA-256 {{ signer.evidenceHash }}</li>
                </ul>
              </details>
            </div>
            <div v-if="canManage && pending && signer.status === 'pending'" class="signing-detail__actions">
              <button class="ghost-button signing-detail__button" type="button" :disabled="Boolean(busy)" @click="remind(signer)">Remind<span class="visually-hidden"> {{ signer.name }}</span></button>
              <button class="ghost-button signing-detail__button" type="button" :disabled="Boolean(busy)" @click="askRemove(signer)">Remove<span class="visually-hidden"> {{ signer.name }}</span></button>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="request.documents?.length" class="signing-detail__section" aria-label="Documents">
        <h3 class="signing-detail__label">Documents</h3>
        <ul class="signing-detail__list">
          <li v-for="document in request.documents" :key="document.position" class="signing-detail__row">
            <div class="signing-detail__text">
              <strong class="signing-detail__name">{{ document.fileName }}</strong>
              <span class="rq-xs rq-muted">Version {{ document.version }} · {{ fileSizeLabel(document.fileSize) }}</span>
            </div>
            <button class="signing-detail__icon" type="button" :aria-label="`Download ${document.fileName}, version ${document.version}`" :disabled="Boolean(busy)" @click="download(document)">
              <i class="bi bi-download" aria-hidden="true"></i>
            </button>
          </li>
        </ul>
      </section>

      <details class="signing-detail__section">
        <summary class="signing-detail__label signing-detail__summary-toggle"><i class="bi bi-chevron-down signing-detail__chevron" aria-hidden="true"></i>Statement and history</summary>
        <p class="rq-small signing-detail__statement">{{ request.statement }}</p>
        <p v-if="request.message" class="rq-small rq-muted">Message: {{ request.message }}</p>
        <ol class="signing-detail__events rq-xs">
          <li v-for="(event, index) in request.events ?? []" :key="index">{{ signingTimeLabel(event.at) }} · {{ signingEventLine(event) }}</li>
        </ol>
        <p class="rq-xs rq-muted signing-detail__hash">Package SHA-256 {{ request.packageHash }}</p>
      </details>
    </template>
    <p v-else-if="error && !loading" class="error-banner mb-0" role="alert">{{ error }}</p>

    <template #footer>
      <button v-if="canManage && pending" class="ghost-button ghost-button--danger" type="button" :disabled="Boolean(busy)" @click="askCancel">Withdraw request</button>
      <button v-if="canManage && pending && pendingSigners.length" class="ghost-button" type="button" :disabled="Boolean(busy)" @click="remind()">Remind everyone</button>
      <button v-if="request?.status === 'completed'" class="ghost-button" type="button" :disabled="Boolean(busy)" @click="certificate">
        <i class="bi bi-file-earmark-check" aria-hidden="true"></i> Certificate
      </button>
      <button class="primary-button" type="button" :disabled="Boolean(busy)" @click="emit('close')">Close</button>
    </template>
  </RequirementsDialog>

  <RequirementsConfirmDialog
    :busy="confirm.saving"
    :confirm-label="confirm.kind === 'cancel' ? 'Withdraw request' : 'Remove signer'"
    :error="confirm.error"
    :open="Boolean(confirm.kind)"
    :title="confirm.kind === 'cancel' ? 'Withdraw this request?' : `Remove ${confirm.signer?.name ?? 'this signer'}?`"
    @close="closeConfirm"
    @confirm="confirmAction"
  >
    <p v-if="confirm.kind === 'cancel'">Nobody can sign it after this. Signers who have not signed get an email. Signatures already given stay in the history.</p>
    <p v-else>They will no longer be asked to sign. If everyone else has signed, the request completes.</p>
    <div class="rq-field mb-0">
      <label :for="reasonId">Reason (optional)</label>
      <input :id="reasonId" v-model="confirm.reason" class="form-control" maxlength="1000" />
    </div>
  </RequirementsConfirmDialog>
</template>

<style scoped>
.signing-detail__summary { display: grid; gap: 0.2rem; }
/* The legacy stylesheet sizes and underlines every h3 with !important. */
.signing-detail__label { margin: 0; padding: 0; border-bottom: 0; color: var(--muted); font-size: 0.75rem !important; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.signing-detail__status { margin: 0; color: var(--ink-soft); }
.signing-detail__status:empty { display: none; }
.signing-detail__button { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; min-height: 2.75rem; }
.signing-detail__icon { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border: 0; border-radius: 0.375rem; background: transparent; color: var(--muted); }
.signing-detail__icon:hover { background: var(--surface-soft); color: var(--ink); }
.signing-detail__icon:focus-visible,
.signing-detail__button:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }
.signing-detail__section { display: grid; gap: 0.35rem; }
.signing-detail__list,
.signing-detail__events { display: grid; gap: 0.35rem; margin: 0; padding: 0; list-style: none; }
.signing-detail__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; min-height: 2.75rem; padding-block: 0.25rem; border-bottom: 1px solid var(--line); }
.signing-detail__row:last-child { border-bottom: 0; }
.signing-detail__text { display: grid; gap: 0.1rem; min-width: 0; }
.signing-detail__line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.5rem; }
.signing-detail__name { overflow-wrap: anywhere; }
.signing-detail__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.25rem; }
.signing-detail__problem { color: var(--danger, #b42318); }
.signing-detail__evidence summary,
.signing-detail__summary-toggle { display: flex; align-items: center; min-height: 2.75rem; cursor: pointer; }
.signing-detail__evidence summary,
.signing-detail__summary-toggle { gap: 0.35rem; list-style: none; }
.signing-detail__evidence summary::-webkit-details-marker,
.signing-detail__summary-toggle::-webkit-details-marker { display: none; }
.signing-detail__chevron { transition: transform 0.15s; }
details[open] > summary .signing-detail__chevron { transform: rotate(180deg); }
.signing-detail__evidence ul { margin: 0.25rem 0 0; padding-left: 1rem; }
.signing-detail__statement { white-space: pre-wrap; }
.signing-detail__hash { overflow-wrap: anywhere; font-family: var(--font-mono, monospace); }
.signing-status { display: inline-flex; align-items: center; gap: 0.35rem; font-weight: 700; }
.signing-status--ok { color: var(--success, #1a7f37); }
.signing-status--bad { color: var(--danger, #b42318); }
.signing-status--wait { color: var(--ink); }
.signing-status--muted { color: var(--muted); }
@media (max-width: 30rem) {
  .signing-detail__row { grid-template-columns: minmax(0, 1fr); }
  .signing-detail__actions { justify-content: flex-start; }
}
</style>
