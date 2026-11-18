<script setup>
import { computed, onMounted, ref } from 'vue';

import RequirementsConfirmDialog from '../components/requirements/RequirementsConfirmDialog.vue';
import { apiClient, authSession } from '../lib/auth/index.js';
import { formatRequestDate, requesterStatus } from '../lib/workspace-access/join-requests.js';

import '../components/admin/admin-screens.css';

// A signed-in person asks to join another workspace by its exact name. Nothing is granted
// here: the workspace's admins see the request once the email is confirmed, and decide.
const workspaceName = ref('');
const requests = ref([]);
const maxPending = ref(3);
const loading = ref(false);
const submitting = ref(false);
const formError = ref('');
const formNotice = ref('');
const listError = ref('');
const rowNotice = ref('');
const resendingId = ref('');
const switchingId = ref('');
const cancelTarget = ref(null);
const cancelBusy = ref(false);
const cancelError = ref('');

const activeTenantId = computed(() => authSession.state.currentUser?.tenantId ?? null);
const pendingCount = computed(() => requests.value.filter((request) => request.status === 'pending').length);

async function loadRequests() {
  loading.value = true;
  listError.value = '';
  try {
    const result = await apiClient.listWorkspaceAccessRequests(authSession.state.token);
    requests.value = Array.isArray(result.requests) ? result.requests : [];
    maxPending.value = result.limits?.maxPending ?? maxPending.value;
  } catch (error) {
    listError.value = error.message ?? 'Unable to load your requests.';
  } finally {
    loading.value = false;
  }
}

async function submitRequest() {
  const name = workspaceName.value.trim();
  if (submitting.value) return;
  formError.value = '';
  formNotice.value = '';
  if (!name) {
    formError.value = 'Enter the workspace’s name.';
    return;
  }
  submitting.value = true;
  try {
    const result = await apiClient.requestWorkspaceAccess({ workspaceName: name }, authSession.state.token);
    formNotice.value = result.message ?? 'Request received.';
    workspaceName.value = '';
    await loadRequests();
  } catch (error) {
    formError.value = error.message ?? 'Unable to send the request.';
  } finally {
    submitting.value = false;
  }
}

async function resend(request) {
  if (resendingId.value) return;
  resendingId.value = request.id;
  rowNotice.value = '';
  listError.value = '';
  try {
    const result = await apiClient.resendWorkspaceAccessConfirmation(request.id, authSession.state.token);
    rowNotice.value = result.message ?? 'We sent a new confirmation link.';
    await loadRequests();
  } catch (error) {
    listError.value = error.message ?? 'Unable to send another confirmation email.';
  } finally {
    resendingId.value = '';
  }
}

function openCancel(request) {
  cancelError.value = '';
  rowNotice.value = '';
  cancelTarget.value = request;
}

function closeCancel() {
  if (!cancelBusy.value) cancelTarget.value = null;
}

async function confirmCancel() {
  const target = cancelTarget.value;
  if (!target || cancelBusy.value) return;
  cancelBusy.value = true;
  cancelError.value = '';
  try {
    await apiClient.cancelWorkspaceAccessRequest(target.id, authSession.state.token);
    cancelTarget.value = null;
    rowNotice.value = `Your request to join ${target.workspaceName} is cancelled.`;
    await loadRequests();
  } catch (error) {
    cancelError.value = error?.status === 404
      ? 'This request was already decided or cancelled. Close this and refresh the list.'
      : error.message ?? 'Unable to cancel the request.';
  } finally {
    cancelBusy.value = false;
  }
}

async function switchTo(request) {
  if (switchingId.value) return;
  switchingId.value = request.id;
  listError.value = '';
  try {
    await authSession.switchTenant(request.tenantId);
    // Reload tenant-scoped stores in the new workspace, as accepting an invitation does.
    window.location.assign(import.meta.env.BASE_URL);
  } catch (error) {
    listError.value = error.message ?? 'Unable to switch workspace.';
    switchingId.value = '';
  }
}

onMounted(loadRequests);
</script>

<template>
  <div class="adm-page workspace-access">
    <header class="adm-header">
      <div>
        <h1>Request workspace access</h1>
        <p>Ask to join a colleague’s OdinPMP workspace. One of its admins decides, and you get no access until they approve.</p>
      </div>
    </header>

    <form class="workspace-access__form" novalidate aria-labelledby="workspace-access-form-title" @submit.prevent="submitRequest">
      <h2 id="workspace-access-form-title" class="workspace-access__subtitle">Ask to join</h2>
      <label class="workspace-access__field" for="workspace-access-name">
        <span>Workspace name</span>
        <input
          id="workspace-access-name"
          v-model="workspaceName"
          class="form-control"
          autocomplete="off"
          maxlength="120"
          :aria-invalid="Boolean(formError)"
          aria-describedby="workspace-access-name-help"
          :disabled="submitting"
        />
      </label>
      <p id="workspace-access-name-help" class="workspace-access__help">
        Type its exact name; ask someone in the workspace if you aren’t sure. We email {{ authSession.state.currentUser?.email }}
        a link to confirm it’s you before its admins see the request.
      </p>
      <p v-if="formError" class="error-banner mb-0" role="alert">{{ formError }}</p>
      <p v-if="formNotice" class="success-banner mb-0" role="status">{{ formNotice }}</p>
      <div>
        <button class="btn btn-primary" type="submit" :disabled="submitting">
          <i class="bi bi-send" aria-hidden="true"></i>
          {{ submitting ? 'Sending…' : 'Request access' }}
        </button>
      </div>
    </form>

    <section class="workspace-access__requests" aria-labelledby="workspace-access-list-title">
      <div class="adm-section-head">
        <h2 id="workspace-access-list-title">Your requests</h2>
        <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="loading" @click="loadRequests">
          <i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Refresh
        </button>
        <p>Waiting requests, and decisions from the last 30 days. You can have {{ maxPending }} requests waiting at once ({{ pendingCount }} now).</p>
      </div>

      <p v-if="rowNotice" class="success-banner" role="status">{{ rowNotice }}</p>
      <p v-if="listError" class="error-banner" role="alert">{{ listError }}</p>
      <p v-if="loading && !requests.length" class="adm-empty" role="status">Loading your requests…</p>
      <p v-else-if="!requests.length" class="adm-empty">You haven’t asked to join a workspace.</p>

      <ul v-if="requests.length" class="workspace-access__list" aria-label="Your requests to join workspaces">
        <li v-for="request in requests" :key="request.id" class="workspace-access__row">
          <div class="workspace-access__info">
            <strong class="workspace-access__name">{{ request.workspaceName }}</strong>
            <span :class="['adm-pill', `workspace-access__status--${requesterStatus(request).tone}`]">{{ requesterStatus(request).label }}</span>
            <span class="workspace-access__meta">
              Requested {{ formatRequestDate(request.requestedAt) }}<template v-if="request.decidedAt && request.status !== 'pending'"> · {{ requesterStatus(request).label }} {{ formatRequestDate(request.decidedAt) }}</template>
            </span>
            <span v-if="request.status === 'pending' && !request.emailConfirmed" class="workspace-access__meta">
              Open the link we sent to {{ request.email }} within 24 hours. Its admins can’t see the request until you do.
            </span>
            <span v-else-if="request.status === 'pending'" class="workspace-access__meta">Your email is confirmed. An admin of {{ request.workspaceName }} will decide.</span>
            <span v-else-if="request.status === 'approved' && request.grantedRole" class="workspace-access__meta">You joined as {{ request.grantedRole }}.</span>
          </div>
          <div class="workspace-access__actions">
            <button
              v-if="request.status === 'pending' && !request.emailConfirmed"
              class="btn btn-outline-primary"
              type="button"
              :disabled="Boolean(resendingId)"
              :aria-label="`Send another confirmation email for ${request.workspaceName}`"
              @click="resend(request)"
            >
              <i class="bi bi-envelope" aria-hidden="true"></i>
              {{ resendingId === request.id ? 'Sending…' : 'Resend email' }}
            </button>
            <button
              v-if="request.status === 'pending'"
              class="btn btn-outline-danger workspace-access__cancel"
              type="button"
              :aria-label="`Cancel your request to join ${request.workspaceName}`"
              @click="openCancel(request)"
            >
              Cancel request
            </button>
            <span v-if="request.status === 'approved' && request.tenantId === activeTenantId" class="workspace-access__meta">Current workspace</span>
            <button
              v-else-if="request.status === 'approved' && request.tenantId"
              class="btn btn-primary"
              type="button"
              :disabled="Boolean(switchingId)"
              @click="switchTo(request)"
            >
              {{ switchingId === request.id ? 'Switching…' : `Switch to ${request.workspaceName}` }}
            </button>
          </div>
        </li>
      </ul>
    </section>

    <RequirementsConfirmDialog
      :busy="cancelBusy"
      confirm-label="Cancel request"
      :error="cancelError"
      :open="Boolean(cancelTarget)"
      title="Cancel this request?"
      @close="closeCancel"
      @confirm="confirmCancel"
    >
      <p class="mb-0">Your request to join <strong>{{ cancelTarget?.workspaceName }}</strong> is withdrawn and its admins no longer see it.</p>
    </RequirementsConfirmDialog>
  </div>
</template>

<style scoped>
.workspace-access {
  max-width: 52rem;
  margin: 1.5rem auto;
}

.workspace-access__form {
  display: grid;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
  padding: 1rem;
  border: 1px solid var(--bs-border-color);
  border-radius: 0.5rem;
}

.workspace-access__subtitle {
  margin: 0;
  font-size: 1.125rem;
}

.workspace-access__field {
  display: grid;
  gap: 0.25rem;
  font-weight: 600;
}

.workspace-access__help {
  margin: 0;
  color: var(--bs-secondary-color);
  overflow-wrap: anywhere;
}

.workspace-access__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--bs-border-color);
}

.workspace-access__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--bs-border-color);
}

.workspace-access__info {
  display: flex;
  flex: 1 1 18rem;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.5rem;
  min-width: 0;
}

.workspace-access__name {
  overflow-wrap: anywhere;
}

.workspace-access__meta {
  flex-basis: 100%;
  color: var(--bs-secondary-color);
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.workspace-access__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.workspace-access__actions .workspace-access__meta {
  flex-basis: auto;
}

.workspace-access__status--warning {
  border-color: var(--bs-warning-border-subtle);
  background: var(--bs-warning-bg-subtle);
  color: var(--bs-warning-text-emphasis);
}

.workspace-access__status--info {
  border-color: var(--bs-info-border-subtle);
  background: var(--bs-info-bg-subtle);
  color: var(--bs-info-text-emphasis);
}

.workspace-access__status--success {
  border-color: var(--bs-success-border-subtle);
  background: var(--bs-success-bg-subtle);
  color: var(--bs-success-text-emphasis);
}

.workspace-access__status--secondary {
  color: var(--bs-secondary-color);
}

/* Bootstrap's danger colour is for light backgrounds. */
:global(html.dark .workspace-access__cancel) {
  border-color: #f26b63;
  color: #f9a5a0;
}

@media (max-width: 42rem) {
  .workspace-access {
    margin: 0;
  }

  .workspace-access__actions,
  .workspace-access__actions .btn {
    width: 100%;
  }
}
</style>
