<script setup>
import { computed, onMounted, ref, watch } from 'vue';

import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import {
  JOIN_REQUEST_ROLES,
  formatRequestDate,
  pageOfRequests,
  verificationLabel,
} from '../../lib/workspace-access/join-requests.js';

// Requests to join the active workspace. Only requests whose email the requester confirmed
// reach this list; approving adds them as the chosen role, declining tells them by email.
const emit = defineEmits(['count']);

const requests = ref([]);
const loading = ref(false);
const loadError = ref('');
const notice = ref('');
const query = ref('');
const sort = ref('newest');
const page = ref(1);
const approveTarget = ref(null);
const approveRole = ref('user');
const declineTarget = ref(null);
const decisionBusy = ref(false);
const decisionError = ref('');

const pageView = computed(() => pageOfRequests(requests.value, { page: page.value, query: query.value, sort: sort.value }));

watch([query, sort], () => {
  page.value = 1;
});
watch(requests, (value) => emit('count', value.length), { immediate: true });

async function loadRequests() {
  if (!authSession.state.token) return;
  loading.value = true;
  loadError.value = '';
  try {
    const result = await apiClient.getTenantUserRequests(authSession.state.token);
    requests.value = Array.isArray(result.requests) ? result.requests : [];
  } catch (error) {
    loadError.value = error.message ?? 'Unable to load requests to join.';
  } finally {
    loading.value = false;
  }
}

function displayName(request) {
  return request?.name || request?.email || 'this person';
}

function openApprove(request) {
  notice.value = '';
  decisionError.value = '';
  approveRole.value = 'user';
  approveTarget.value = request;
}

function openDecline(request) {
  notice.value = '';
  decisionError.value = '';
  declineTarget.value = request;
}

function closeDialogs() {
  if (decisionBusy.value) return;
  approveTarget.value = null;
  declineTarget.value = null;
}

async function decide(target, run) {
  if (!target || decisionBusy.value) return;
  decisionBusy.value = true;
  decisionError.value = '';
  try {
    const result = await run();
    requests.value = requests.value.filter((request) => request.id !== target.id);
    approveTarget.value = null;
    declineTarget.value = null;
    notice.value = result?.message ?? 'Done.';
  } catch (error) {
    decisionError.value = error?.status === 404
      ? 'This request was already decided or withdrawn. Refresh to see the current list.'
      : error.message ?? 'Unable to record the decision.';
  } finally {
    decisionBusy.value = false;
  }
}

function confirmApprove() {
  const target = approveTarget.value;
  return decide(target, () => apiClient.approveTenantUserRequest(target.id, { role: approveRole.value }, authSession.state.token));
}

function confirmDecline() {
  const target = declineTarget.value;
  return decide(target, () => apiClient.declineTenantUserRequest(target.id, authSession.state.token));
}

onMounted(loadRequests);
</script>

<template>
  <section class="join-requests" aria-labelledby="join-requests-heading">
    <div class="join-requests__head">
      <h4 id="join-requests-heading" class="join-requests__title">Requests to join</h4>
      <button class="btn btn-outline-secondary join-requests__button" type="button" :disabled="loading" @click="loadRequests">
        <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
    </div>
    <p class="join-requests__intro">
      People who asked to join this workspace and confirmed their email address. They have no access until you approve,
      and you choose their role when you do.
    </p>

    <div v-if="notice" class="success-banner d-flex align-items-start justify-content-between gap-2 mb-3" role="status">
      <span>{{ notice }}</span>
      <button class="btn-close flex-shrink-0" type="button" aria-label="Dismiss message" @click="notice = ''"></button>
    </div>
    <div v-if="loadError" class="error-banner mb-3" role="alert">{{ loadError }}</div>

    <div v-if="requests.length > 1" class="join-requests__filters">
      <label class="join-requests__field join-requests__field--grow">
        <span>Search requests</span>
        <input v-model="query" class="form-control" type="search" placeholder="Name or email" />
      </label>
      <label class="join-requests__field">
        <span>Sort by</span>
        <select v-model="sort" class="form-select">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </label>
    </div>

    <p v-if="!loading && !loadError && requests.length === 0" class="join-requests__empty">No one is waiting to join.</p>
    <p v-else-if="!loading && pageView.total === 0 && requests.length > 0" class="join-requests__empty">No requests match your search.</p>

    <ul v-if="pageView.items.length" class="join-requests__list" aria-label="Requests to join">
      <li v-for="request in pageView.items" :key="request.id" class="join-requests__row">
        <div class="join-requests__info">
          <strong class="join-requests__name">{{ displayName(request) }}</strong>
          <span class="join-requests__email">{{ request.email }}</span>
          <span class="join-requests__meta">
            <span class="join-requests__verified">
              <i class="bi bi-patch-check" aria-hidden="true"></i>
              {{ verificationLabel(request) }}<template v-if="request.emailVerifiedAt"> {{ formatRequestDate(request.emailVerifiedAt) }}</template>
            </span>
            <span>Requested {{ formatRequestDate(request.requestedAt) }}</span>
          </span>
        </div>
        <div class="join-requests__actions">
          <button class="btn btn-outline-primary join-requests__button" type="button" :aria-label="`Approve ${displayName(request)}`" @click="openApprove(request)">
            <i class="bi bi-person-check" aria-hidden="true"></i>
            Approve
          </button>
          <button class="btn btn-outline-danger join-requests__button join-requests__decline" type="button" :aria-label="`Decline ${displayName(request)}`" @click="openDecline(request)">
            <i class="bi bi-x-circle" aria-hidden="true"></i>
            Decline
          </button>
        </div>
      </li>
    </ul>

    <nav v-if="pageView.pageCount > 1" class="join-requests__pager" aria-label="Requests to join pages">
      <button class="btn btn-sm btn-outline-secondary join-requests__button" type="button" :disabled="pageView.page <= 1" @click="page = pageView.page - 1">Previous</button>
      <span>Page {{ pageView.page }} of {{ pageView.pageCount }}</span>
      <button class="btn btn-sm btn-outline-secondary join-requests__button" type="button" :disabled="pageView.page >= pageView.pageCount" @click="page = pageView.page + 1">Next</button>
    </nav>

    <RequirementsDialog
      :busy="decisionBusy"
      :open="Boolean(approveTarget)"
      :title="`Approve ${displayName(approveTarget)}?`"
      @close="closeDialogs"
      @submit="confirmApprove"
    >
      <p class="rq-small mb-0">
        <strong>{{ displayName(approveTarget) }}</strong> ({{ approveTarget?.email }}) joins this workspace and can sign in to it right away.
        We’ll email them that you approved.
      </p>
      <label class="join-requests__field" for="join-request-role">
        <span>Role in this workspace</span>
        <select id="join-request-role" v-model="approveRole" class="form-select">
          <option v-for="role in JOIN_REQUEST_ROLES" :key="role.value" :value="role.value">{{ role.label }}</option>
        </select>
      </label>
      <p v-if="approveRole === 'admin'" class="rq-small mb-0">Admins manage users, integrations and every project in the workspace.</p>
      <p v-if="decisionError" class="error-banner mb-0" role="alert">{{ decisionError }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="decisionBusy" @click="closeDialogs">Cancel</button>
        <button class="primary-button" type="submit" :disabled="decisionBusy">{{ decisionBusy ? 'Working…' : 'Approve and add' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog
      :busy="decisionBusy"
      confirm-label="Decline request"
      :error="decisionError"
      :open="Boolean(declineTarget)"
      :title="`Decline ${displayName(declineTarget)}?`"
      @close="closeDialogs"
      @confirm="confirmDecline"
    >
      <p class="mb-0">
        <strong>{{ displayName(declineTarget) }}</strong> ({{ declineTarget?.email }}) won’t join this workspace. We’ll email them that
        the request was declined, and they can’t ask again for 7 days.
      </p>
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.join-requests {
  font-size: 0.875rem;
}

.join-requests__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.join-requests__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.join-requests__intro {
  margin-bottom: 1rem;
  color: var(--bs-secondary-color);
}

.join-requests__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  min-height: 2.75rem;
}

.join-requests__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.join-requests__field {
  display: grid;
  flex: 1 1 11rem;
  gap: 0.25rem;
  min-width: 0;
  font-size: 0.75rem;
  font-weight: 600;
}

.join-requests__field--grow {
  flex: 2 1 16rem;
}

.join-requests__field .form-control,
.join-requests__field .form-select {
  min-height: 2.75rem;
  font-size: 0.875rem;
}

.join-requests__empty {
  margin: 0;
  color: var(--bs-secondary-color);
}

.join-requests__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--bs-border-color);
}

.join-requests__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--bs-border-color);
}

.join-requests__info {
  display: grid;
  flex: 1 1 16rem;
  gap: 0.2rem;
  min-width: 0;
}

.join-requests__name,
.join-requests__email {
  overflow-wrap: anywhere;
}

.join-requests__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  color: var(--bs-secondary-color);
  font-size: 0.75rem;
}

.join-requests__verified {
  color: var(--bs-success-text-emphasis);
}

.join-requests__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.join-requests__pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

/* Bootstrap's danger and success text colours are for light backgrounds. */
:global(html.dark .join-requests__verified) {
  color: #80d4ae;
}

:global(html.dark .join-requests__decline) {
  border-color: #f26b63;
  color: #f9a5a0;
}

@media (max-width: 575.98px) {
  .join-requests__actions {
    width: 100%;
  }

  .join-requests__actions .join-requests__button {
    flex: 1 1 0;
  }
}
</style>
