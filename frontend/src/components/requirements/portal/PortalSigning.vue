<script setup>
import { computed, onBeforeUnmount, reactive, ref, useId, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import RequirementsConfirmDialog from '../RequirementsConfirmDialog.vue';
import { apiClient } from '../../../lib/auth/index.js';
import { canPreviewFile, fileSizeLabel, openFile, saveBlob } from '../../../lib/projects/project-files.js';
import {
  browserEvidence,
  signerStatus,
  signingErrorMessage,
  signingKindLabel,
  signingProgressLabel,
  signingStatus,
  signingTimeLabel,
} from '../../../lib/projects/project-signing.js';
import { usePortal } from '../../../lib/requirements/portal-context.js';
import { isLinkProblem } from '../../../lib/requirements/portal-view.js';

// One signature request in the client portal: what is being signed, who
// has signed, and, for a signer who has not acted yet, the one form that signs it. Signing needs
// a code Odin emails to the signer's address. Declining is a separate action that asks first.
const route = useRoute();
const { reportProblem, token } = usePortal();
const uid = useId();
const ids = { code: `${uid}-code`, consent: `${uid}-consent`, name: `${uid}-name`, organization: `${uid}-org`, reason: `${uid}-reason`, title: `${uid}-title` };

const data = ref(null);
const loading = ref(true);
const notFound = ref(false);
const loadError = ref('');
const busyDocument = ref(-1);
const documentError = ref('');
const codeState = reactive({ error: '', resendAt: 0, sending: false, sentTo: '' });
const form = reactive({ code: '', consent: false, error: '', fullName: '', organization: '', saving: false, title: '' });
const decline = reactive({ error: '', open: false, reason: '', saving: false });
const done = ref('');
const now = ref(Date.now());
const ticker = setInterval(() => { now.value = Date.now(); }, 5000);
onBeforeUnmount(() => clearInterval(ticker));

const requestId = computed(() => String(route.params.requestId ?? ''));
const request = computed(() => data.value?.request ?? null);
const homeLink = computed(() => ({ name: 'requirements-portal', params: { token: token.value } }));
const documentsLink = computed(() => ({ name: 'requirements-portal-documents', params: { token: token.value } }));
const canSign = computed(() => request.value?.status === 'pending' && request.value?.me?.status === 'pending');
// A code sent in the last 15 minutes may still be in the signer's inbox.
const codeLive = computed(() => Boolean(codeState.sentTo) || (request.value?.me?.codeSentAt && now.value - Date.parse(request.value.me.codeSentAt) < 15 * 60_000));
const canResend = computed(() => now.value >= codeState.resendAt);
const myStatusLine = computed(() => {
  const me = request.value?.me;
  if (!me) return '';
  if (me.status === 'signed') return 'You have signed this.';
  if (me.status === 'declined') return 'You declined this.';
  if (me.status === 'removed') return 'The team no longer needs your signature on this.';
  return '';
});

async function load({ passive = false } = {}) {
  if (!passive) loading.value = true;
  loadError.value = '';
  try {
    const result = await (passive ? apiClient.passive : apiClient).getRequirementsPortalSigning(token.value, requestId.value);
    data.value = result;
    notFound.value = false;
    if (!form.fullName) form.fullName = result?.signer?.name ?? '';
  } catch (error) {
    if (isLinkProblem(error)) reportProblem(error);
    else if (Number(error?.status) === 404) notFound.value = true;
    else loadError.value = error?.message || 'Unable to load this request.';
  } finally {
    loading.value = false;
  }
}

watch(() => [token.value, requestId.value], () => {
  data.value = null;
  done.value = '';
  load();
}, { immediate: true });

watch(() => request.value?.title, (title) => {
  if (typeof document !== 'undefined' && title) document.title = `${title} · Signature`;
}, { immediate: true });

async function sendCode() {
  if (codeState.sending) return;
  codeState.sending = true;
  codeState.error = '';
  try {
    const result = await apiClient.sendRequirementsPortalSigningCode(token.value, requestId.value);
    codeState.sentTo = result.sentTo;
    codeState.resendAt = Date.parse(result.resendAfter) || Date.now() + 60_000;
    now.value = Date.now();
  } catch (error) {
    if (isLinkProblem(error)) reportProblem(error);
    codeState.error = signingErrorMessage(error, 'Unable to send a code.');
  } finally {
    codeState.sending = false;
  }
}

async function sign() {
  if (form.saving) return;
  if (!/^\d{6}$/.test(form.code.trim())) {
    form.error = 'Enter the 6-digit code from the email.';
    return;
  }
  if (!form.fullName.trim()) {
    form.error = 'Type your full name.';
    return;
  }
  if (!form.consent) {
    form.error = 'Tick the box to agree to sign electronically.';
    return;
  }
  form.saving = true;
  form.error = '';
  try {
    data.value = await apiClient.signRequirementsPortalRequest(token.value, requestId.value, {
      browser: browserEvidence(),
      code: form.code.trim(),
      consent: true,
      fullName: form.fullName.trim(),
      organization: form.organization.trim(),
      title: form.title.trim(),
    });
    done.value = data.value?.request?.status === 'completed' ? 'Signed. Everyone has now signed, so the certificate is ready.' : 'Signed. We will email you when everyone has signed.';
  } catch (error) {
    if (isLinkProblem(error)) reportProblem(error);
    form.error = signingErrorMessage(error, 'Unable to sign.');
    if (['code_locked', 'code_expired'].includes(error?.data?.details?.code)) {
      form.code = '';
      codeState.sentTo = '';
    }
    if (error?.status === 409) await load({ passive: true });
  } finally {
    form.saving = false;
  }
}

async function confirmDecline() {
  if (decline.saving) return;
  decline.saving = true;
  decline.error = '';
  try {
    const reason = decline.reason.trim();
    data.value = await apiClient.declineRequirementsPortalRequest(token.value, requestId.value, reason ? { reason } : {});
    decline.open = false;
    done.value = 'You declined this. The team has been told.';
  } catch (error) {
    if (isLinkProblem(error)) reportProblem(error);
    decline.error = signingErrorMessage(error, 'Unable to decline.');
  } finally {
    decline.saving = false;
  }
}

async function withDocument(document, run) {
  if (busyDocument.value >= 0) return;
  busyDocument.value = document.position;
  documentError.value = '';
  try {
    await run();
  } catch (error) {
    documentError.value = error?.message || 'Unable to get the file.';
  } finally {
    busyDocument.value = -1;
  }
}

function downloadDocument(document) {
  return withDocument(document, async () => {
    const { blob } = await apiClient.getRequirementsPortalSigningDocument(token.value, requestId.value, document.position, { download: true });
    saveBlob(blob, document.fileName);
  });
}

function openDocument(document) {
  return withDocument(document, () => openFile(() => apiClient.getRequirementsPortalSigningDocument(token.value, requestId.value, document.position), document));
}

function downloadCertificate() {
  return withDocument({ position: 999 }, async () => {
    const { blob } = await apiClient.getRequirementsPortalSigningCertificate(token.value, requestId.value);
    saveBlob(blob, `${request.value?.title || 'Signature'} certificate.pdf`);
  });
}

function signerLine(signer) {
  if (signer.status === 'signed') {
    const role = [signer.title, signer.organization].filter(Boolean).join(', ');
    return `Signed${role ? ` as ${role}` : ''}, ${signingTimeLabel(signer.signedAt)}`;
  }
  if (signer.status === 'declined') return `Declined ${signingTimeLabel(signer.declinedAt)}`;
  return 'Not signed yet';
}
</script>

<template>
  <div class="rq-portal-page rq-stack ps-page">
    <nav class="rq-row rq-row--wrap ps-nav" aria-label="Portal">
      <RouterLink class="rq-portal-back" :to="homeLink"><i class="bi bi-arrow-left" aria-hidden="true"></i>All your questions and reviews</RouterLink>
      <RouterLink class="rq-portal-back" :to="documentsLink"><i class="bi bi-folder2-open" aria-hidden="true"></i>Shared documents</RouterLink>
    </nav>

    <div v-if="notFound" class="rq-empty">
      <h1 class="rq-title rq-title--md" tabindex="-1">This request isn’t available</h1>
      <p class="rq-small">It may have been removed, or it isn’t shared with you.</p>
    </div>
    <div v-else-if="loadError && !request" class="error-banner rq-row rq-row--between" role="alert">
      <span>{{ loadError }}</span>
      <button class="ghost-button ghost-button--compact" type="button" @click="load()">Try again</button>
    </div>
    <p v-else-if="loading && !request" class="rq-small rq-muted" role="status">Loading the request…</p>

    <template v-if="request">
      <header class="rq-stack rq-stack--sm">
        <p class="rq-eyebrow mb-0">{{ signingKindLabel(request.kind) }} · {{ request.subject?.name }}</p>
        <h1 class="rq-title ps-title mb-0">{{ request.title }}</h1>
        <p class="rq-small mb-0 ps-status">
          <i :class="['bi', signingStatus(request.status).icon]" aria-hidden="true"></i>
          <strong>{{ signingStatus(request.status).label }}</strong>
          <span class="rq-muted"> · {{ signingProgressLabel(request.progress) }}</span>
        </p>
        <p v-if="request.endReason" class="rq-small mb-0">Reason: {{ request.endReason }}</p>
        <p v-if="request.message" class="rq-asknote mb-0">{{ request.message }}</p>
      </header>

      <p class="rq-small mb-0" role="status">{{ done || myStatusLine }}</p>

      <section class="rq-panel rq-stack rq-stack--sm" aria-labelledby="ps-what">
        <h2 id="ps-what" class="rq-eyebrow">What you are signing</h2>
        <p class="ps-statement mb-0">{{ request.statement }}</p>
        <ul v-if="request.documents?.length" class="ps-list">
          <li v-for="document in request.documents" :key="document.position" class="ps-doc">
            <div class="ps-doc__text">
              <strong class="ps-doc__name">{{ document.fileName }}</strong>
              <span class="rq-xs rq-muted">Version {{ document.version }} · {{ fileSizeLabel(document.fileSize) }}</span>
            </div>
            <div class="ps-doc__actions">
              <button v-if="canPreviewFile(document)" class="ghost-button ps-button" type="button" :disabled="busyDocument >= 0" @click="openDocument(document)">
                <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i> Open<span class="visually-hidden"> {{ document.fileName }}</span>
              </button>
              <button class="ghost-button ps-button" type="button" :disabled="busyDocument >= 0" @click="downloadDocument(document)">
                <i class="bi bi-download" aria-hidden="true"></i> Download<span class="visually-hidden"> {{ document.fileName }}</span>
              </button>
            </div>
          </li>
        </ul>
        <p v-if="documentError" class="error-banner mb-0" role="alert">{{ documentError }}</p>
        <button v-if="request.status === 'completed'" class="ghost-button ps-button ps-certificate" type="button" :disabled="busyDocument >= 0" @click="downloadCertificate">
          <i class="bi bi-file-earmark-check" aria-hidden="true"></i> Download the completion certificate
        </button>
      </section>

      <section v-if="canSign" class="rq-panel rq-stack" aria-labelledby="ps-sign">
        <h2 id="ps-sign" class="rq-title rq-title--md mb-0">Sign</h2>
        <template v-if="!codeLive">
          <p class="rq-small mb-0">To sign, you need a code that we email to {{ data.signer?.email }}.</p>
          <p v-if="codeState.error" class="error-banner mb-0" role="alert">{{ codeState.error }}</p>
          <button class="primary-button ps-button ps-start" type="button" :disabled="codeState.sending" @click="sendCode">{{ codeState.sending ? 'Sending…' : 'Email me a code' }}</button>
        </template>
        <form v-else class="rq-stack" novalidate @submit.prevent="sign">
          <p class="rq-small mb-0">
            We sent a 6-digit code to {{ codeState.sentTo || data.signer?.email }}. It works for 15 minutes.
            <button class="ps-link" type="button" :disabled="codeState.sending || !canResend" @click="sendCode">{{ canResend ? 'Send a new code' : 'You can ask for a new code in a minute' }}</button>
          </p>
          <p v-if="codeState.error" class="error-banner mb-0" role="alert">{{ codeState.error }}</p>
          <div class="rq-field">
            <label :for="ids.code">Code</label>
            <input :id="ids.code" v-model="form.code" autocomplete="one-time-code" class="form-control ps-code" inputmode="numeric" maxlength="6" pattern="[0-9]*" />
          </div>
          <div class="ps-fields">
            <div class="rq-field">
              <label :for="ids.name">Full name</label>
              <input :id="ids.name" v-model="form.fullName" autocomplete="name" class="form-control" maxlength="255" />
            </div>
            <div class="rq-field">
              <label :for="ids.title">Title (optional)</label>
              <input :id="ids.title" v-model="form.title" autocomplete="organization-title" class="form-control" maxlength="255" />
            </div>
            <div class="rq-field">
              <label :for="ids.organization">Organization (optional)</label>
              <input :id="ids.organization" v-model="form.organization" autocomplete="organization" class="form-control" maxlength="255" />
            </div>
          </div>
          <label class="ps-consent" :for="ids.consent">
            <input :id="ids.consent" v-model="form.consent" class="form-check-input mt-0" type="checkbox" />
            <span>{{ data.consent?.text }}</span>
          </label>
          <p class="rq-xs rq-muted mb-0">{{ data.disclosure }}</p>
          <p v-if="form.error" class="error-banner mb-0" role="alert">{{ form.error }}</p>
          <div class="rq-row rq-row--wrap">
            <button class="primary-button ps-button" type="submit" :disabled="form.saving">{{ form.saving ? 'Signing…' : 'Sign' }}</button>
          </div>
        </form>
        <div class="ps-decline">
          <button class="ghost-button ps-button" type="button" :disabled="form.saving" @click="Object.assign(decline, { error: '', open: true, reason: '' })">Decline</button>
        </div>
      </section>

      <section class="rq-panel rq-stack rq-stack--sm" aria-labelledby="ps-signers">
        <h2 id="ps-signers" class="rq-eyebrow">Signers</h2>
        <ul class="ps-list">
          <li v-for="(signer, index) in request.signers" :key="index" class="rq-row rq-row--top rq-small">
            <i :class="['bi', signerStatus(signer.status).icon]" aria-hidden="true"></i>
            <div>
              <strong>{{ signer.name }}</strong><span v-if="signer.isMe" class="rq-muted"> (you)</span>
              <div class="rq-xs rq-muted">{{ signerLine(signer) }}</div>
            </div>
          </li>
        </ul>
      </section>
    </template>

    <RequirementsConfirmDialog
      :busy="decline.saving"
      confirm-label="Decline"
      :error="decline.error"
      :open="decline.open"
      :title="'Decline this request?'"
      @close="!decline.saving && (decline.open = false)"
      @confirm="confirmDecline"
    >
      <p>The request stops for everyone, and the team is told. They can send a new one.</p>
      <div class="rq-field mb-0">
        <label :for="ids.reason">Reason (optional)</label>
        <textarea :id="ids.reason" v-model="decline.reason" class="form-control" maxlength="1000" rows="3"></textarea>
      </div>
    </RequirementsConfirmDialog>
  </div>
</template>

<style scoped>
.ps-page { max-width: 760px; }
.ps-nav { gap: 0.25rem 1rem; }
.ps-title { font-size: 1.6rem; line-height: 1.2; overflow-wrap: anywhere; }
.ps-status { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; }
.ps-statement { white-space: pre-wrap; font-size: 0.95rem; }
.ps-list { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
.ps-doc { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--line); }
.ps-doc:last-child { border-bottom: 0; padding-bottom: 0; }
.ps-doc__text { display: grid; gap: 0.1rem; min-width: 0; }
.ps-doc__name { overflow-wrap: anywhere; }
.ps-doc__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.35rem; }
.ps-button { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; min-height: 2.75rem; }
.ps-start,
.ps-certificate { justify-self: start; }
.ps-code { max-width: 10rem; font-size: 1.25rem; letter-spacing: 0.3em; }
.ps-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
.ps-consent { display: flex; align-items: flex-start; gap: 0.6rem; min-height: 2.75rem; padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 0.45rem; cursor: pointer; }
.ps-consent input { flex: 0 0 auto; width: 1.15rem; height: 1.15rem; min-height: 0; margin-top: 0.15rem !important; }
.ps-link { min-height: 2.75rem; padding: 0 0.25rem; border: 0; background: transparent; color: var(--accent); font-weight: 600; text-decoration: underline; }
.ps-link:disabled { color: var(--muted); text-decoration: none; }
.ps-decline { padding-top: 0.5rem; border-top: 1px solid var(--line); }
@media (max-width: 40rem) {
  .ps-fields { grid-template-columns: minmax(0, 1fr); }
  .ps-doc { grid-template-columns: minmax(0, 1fr); }
  .ps-doc__actions { justify-content: flex-start; }
}
</style>
