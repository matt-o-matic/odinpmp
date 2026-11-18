<script setup>
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { apiClient } from '../../../lib/auth/index.js';
import { canPreviewFile, fileDateLabel, fileSizeLabel, openFile, saveBlob } from '../../../lib/projects/project-files.js';
import { signingKindLabel, signingProgressLabel, signingStatus, signingTimeLabel } from '../../../lib/projects/project-signing.js';
import { usePortal } from '../../../lib/requirements/portal-context.js';
import { isLinkProblem } from '../../../lib/requirements/portal-view.js';

// What the team shared with this stakeholder (docs/document-signing): each external file with its
// signature history, and sign-offs that have no documents. Requests waiting for this stakeholder
// come first.
const { portal, reportProblem, token } = usePortal();

const data = ref(null);
const loading = ref(true);
const error = ref('');
const busyId = ref('');

const homeLink = computed(() => ({ name: 'requirements-portal', params: { token: token.value } }));
const requestsById = computed(() => new Map((data.value?.requests ?? []).map((request) => [request.id, request])));
const awaiting = computed(() => (data.value?.awaitingMe ?? []).map((id) => requestsById.value.get(id)).filter(Boolean));
const documents = computed(() => data.value?.documents ?? []);
const signoffs = computed(() => (data.value?.requests ?? []).filter((request) => !request.documents?.length));

const signingLink = (request) => ({ name: 'requirements-portal-signing', params: { requestId: request.id, token: token.value } });
const documentRequests = (document) => (document.requestIds ?? []).map((id) => requestsById.value.get(id)).filter(Boolean);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await apiClient.getRequirementsPortalDocuments(token.value);
  } catch (loadError) {
    if (isLinkProblem(loadError)) reportProblem(loadError);
    else error.value = loadError?.message || 'Unable to load the documents.';
  } finally {
    loading.value = false;
  }
}

async function download(document) {
  if (busyId.value) return;
  busyId.value = document.id;
  error.value = '';
  try {
    const { blob } = await apiClient.getRequirementsPortalDocumentContent(token.value, document.id, { download: true });
    saveBlob(blob, document.fileName);
  } catch (downloadError) {
    error.value = downloadError?.message || 'Unable to download the file.';
  } finally {
    busyId.value = '';
  }
}

async function open(document) {
  if (busyId.value) return;
  busyId.value = document.id;
  error.value = '';
  try {
    await openFile(() => apiClient.getRequirementsPortalDocumentContent(token.value, document.id), document);
  } catch (openError) {
    error.value = openError?.message || 'Unable to open the file.';
  } finally {
    busyId.value = '';
  }
}

function signerLine(signer) {
  if (signer.status === 'signed') return `${signer.name} signed ${signingTimeLabel(signer.signedAt)}`;
  if (signer.status === 'declined') return `${signer.name} declined`;
  return `${signer.name}: not signed yet`;
}

watch(token, load, { immediate: true });
watch(() => portal.value?.project?.name, (name) => {
  if (typeof document !== 'undefined' && name) document.title = `${name} · Documents`;
}, { immediate: true });
</script>

<template>
  <div class="rq-portal-page rq-stack">
    <RouterLink class="rq-portal-back" :to="homeLink"><i class="bi bi-arrow-left" aria-hidden="true"></i>All your questions and reviews</RouterLink>
    <h1 class="rq-title rq-title--md mb-0">Shared documents</h1>

    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <p v-if="loading && !data" class="rq-small rq-muted mb-0" role="status">Loading documents…</p>

    <section v-if="awaiting.length" class="rq-panel rq-stack rq-stack--sm" aria-labelledby="pd-awaiting">
      <h2 id="pd-awaiting" class="rq-eyebrow">Waiting for your signature · {{ awaiting.length }}</h2>
      <ul class="rq-portal-cards">
        <li v-for="request in awaiting" :key="request.id" class="rq-row rq-row--between rq-row--wrap">
          <span><strong>{{ request.title }}</strong><span class="rq-xs rq-muted"> · {{ signingKindLabel(request.kind) }}</span></span>
          <RouterLink class="primary-button" :to="signingLink(request)">Review and sign<span class="visually-hidden">: {{ request.title }}</span></RouterLink>
        </li>
      </ul>
    </section>

    <section v-if="data" class="rq-panel rq-stack" aria-labelledby="pd-files">
      <h2 id="pd-files" class="rq-eyebrow">Files · {{ documents.length }}</h2>
      <p v-if="!documents.length" class="rq-small rq-muted mb-0">The team has not shared any files with you yet.</p>
      <ul v-else class="pd-list">
        <li v-for="document in documents" :key="document.id" class="pd-item">
          <div class="pd-item__main">
            <strong class="pd-item__name">{{ document.fileName }}</strong>
            <span class="rq-xs rq-muted">Version {{ document.version }} · {{ fileSizeLabel(document.fileSize) }} · {{ fileDateLabel(document.updatedAt) }}</span>
            <span v-if="document.description && document.description !== document.fileName" class="rq-small">{{ document.description }}</span>
            <ul v-if="documentRequests(document).length" class="pd-history" aria-label="Signature history">
              <li v-for="request in documentRequests(document)" :key="request.id" class="rq-xs">
                <i :class="['bi', signingStatus(request.status).icon]" aria-hidden="true"></i>
                <RouterLink :to="signingLink(request)">{{ request.title }}</RouterLink>:
                {{ signingStatus(request.status).label }} · {{ signingProgressLabel(request.progress) }}
                <span class="rq-muted"> · {{ request.signers.map(signerLine).join(' · ') }}</span>
              </li>
            </ul>
          </div>
          <div class="pd-item__actions">
            <button class="ghost-button pd-button" type="button" :disabled="busyId === document.id" @click="download(document)">
              <i class="bi bi-download" aria-hidden="true"></i> Download<span class="visually-hidden"> {{ document.fileName }}</span>
            </button>
            <button v-if="canPreviewFile(document)" class="ghost-button pd-button" type="button" :disabled="busyId === document.id" @click="open(document)">
              <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i> Open<span class="visually-hidden"> {{ document.fileName }}</span>
            </button>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="signoffs.length" class="rq-panel rq-stack rq-stack--sm" aria-labelledby="pd-signoffs">
      <h2 id="pd-signoffs" class="rq-eyebrow">Sign-offs</h2>
      <ul class="pd-list">
        <li v-for="request in signoffs" :key="request.id" class="rq-row rq-row--between rq-row--wrap rq-small">
          <span>
            <i :class="['bi', signingStatus(request.status).icon]" aria-hidden="true"></i>
            <RouterLink :to="signingLink(request)">{{ request.title }}</RouterLink>
            <span class="rq-muted"> · {{ signingStatus(request.status).label }} · {{ signingProgressLabel(request.progress) }}</span>
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.pd-list { display: grid; gap: 0.6rem; margin: 0; padding: 0; list-style: none; }
.pd-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem 0.75rem; align-items: start; padding-bottom: 0.6rem; border-bottom: 1px solid var(--line); }
.pd-item:last-child { padding-bottom: 0; border-bottom: 0; }
.pd-item__main { display: grid; gap: 0.2rem; min-width: 0; }
.pd-item__name { overflow-wrap: anywhere; }
.pd-item__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.35rem; }
.pd-button { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; }
.pd-history { display: grid; gap: 0.2rem; margin: 0.2rem 0 0; padding: 0; list-style: none; }
@media (max-width: 40rem) {
  .pd-item { grid-template-columns: minmax(0, 1fr); }
  .pd-item__actions { justify-content: flex-start; }
}
</style>
