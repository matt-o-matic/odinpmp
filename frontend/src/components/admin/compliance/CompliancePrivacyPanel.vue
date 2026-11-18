<script setup>
import { computed, reactive, ref, watch } from 'vue';

import RequirementsDialog from '../../requirements/RequirementsDialog.vue';
import {
  ERASURE_REASON_LIMITS,
  canExecuteErasure,
  complianceErrorMessage,
  erasureResultSummary,
  matchesQuery,
  paginate,
  sortByTimestamp,
  textLengthError,
} from '../../../lib/admin/compliance.js';
import { apiClient, authSession } from '../../../lib/auth/index.js';

const CONFIRM_WORD = 'ERASE';

const props = defineProps({
  currentUserId: { required: true, type: String },
  requests: { required: true, type: Array },
  userLabel: { required: true, type: Function },
  users: { required: true, type: Array },
});
const emit = defineEmits(['changed', 'reload']);

const query = ref('');
const statusFilter = ref('pending');
const page = ref(1);

const requesting = ref(false);
const executing = ref(null);
const busy = ref(false);
const formError = ref('');
const errors = ref({});
const requestDraft = reactive({ reason: '', subjectUserId: '' });
const confirmText = ref('');

const pendingSubjects = computed(() => new Set(props.requests.filter((item) => item.status === 'pending').map((item) => item.subjectUserId)));
// Admins cannot request their own erasure, and a person with a pending request cannot get a second.
const subjectChoices = computed(() => props.users.filter((user) => user.id !== props.currentUserId && !pendingSubjects.value.has(user.id)));

const filtered = computed(() => {
  const rows = props.requests.filter((item) => (statusFilter.value === 'all' || item.status === statusFilter.value)
    && matchesQuery([props.userLabel(item.subjectUserId), item.reason], query.value));
  return sortByTimestamp(rows, 'createdAt');
});
const pageState = computed(() => paginate(filtered.value, page.value));
watch([query, statusFilter], () => { page.value = 1; });

function openRequest() {
  Object.assign(requestDraft, { reason: '', subjectUserId: '' });
  errors.value = {};
  formError.value = '';
  requesting.value = true;
}

function openExecute(item) {
  confirmText.value = '';
  errors.value = {};
  formError.value = '';
  executing.value = item;
}

function closeDialogs() {
  if (busy.value) return;
  requesting.value = false;
  executing.value = null;
}

async function createRequest() {
  errors.value = {
    reason: textLengthError(requestDraft.reason, ERASURE_REASON_LIMITS, 'The reason'),
    subjectUserId: requestDraft.subjectUserId ? '' : 'Choose the person to erase.',
  };
  if (errors.value.reason || errors.value.subjectUserId) return;
  busy.value = true;
  formError.value = '';
  try {
    await apiClient.createPrivacyErasureRequest({ reason: requestDraft.reason.trim(), subjectUserId: requestDraft.subjectUserId }, authSession.state.token);
    requesting.value = false;
    statusFilter.value = 'pending';
    emit('changed', 'Erasure request created. A different administrator must execute it.');
  } catch (error) {
    formError.value = complianceErrorMessage(error, 'Unable to create the erasure request.');
  } finally {
    busy.value = false;
  }
}

async function executeRequest() {
  if (confirmText.value.trim() !== CONFIRM_WORD) {
    errors.value = { confirm: `Type ${CONFIRM_WORD} to confirm.` };
    return;
  }
  const request = props.requests.find((item) => item.id === executing.value.id) ?? executing.value;
  busy.value = true;
  formError.value = '';
  errors.value = {};
  try {
    await apiClient.executePrivacyErasureRequest(request.id, { expectedVersion: request.version }, authSession.state.token);
    executing.value = null;
    emit('changed', 'Personal data erased. The completion record is kept for audit.');
  } catch (error) {
    formError.value = complianceErrorMessage(error, 'Unable to execute the erasure request.');
    if (error?.status === 409 && error?.data?.details?.code === 'compliance_version_conflict') emit('reload');
  } finally {
    busy.value = false;
  }
}

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : '—';
}
</script>

<template>
  <section aria-labelledby="compliance-privacy-title">
    <div class="adm-section-head">
      <h2 id="compliance-privacy-title">Privacy erasure</h2>
      <button class="btn btn-sm btn-primary" type="button" @click="openRequest">
        <i class="bi bi-plus-lg" aria-hidden="true"></i> New erasure request
      </button>
      <p>One administrator requests erasure and a different administrator executes it.</p>
    </div>

    <div class="adm-toolbar">
      <label class="adm-grow" for="privacy-search">Search
        <input id="privacy-search" v-model="query" class="form-control" type="search" placeholder="Person or reason" />
      </label>
      <label for="privacy-status">Status
        <select id="privacy-status" v-model="statusFilter" class="form-select">
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="all">All</option>
        </select>
      </label>
    </div>

    <div class="adm-table-wrap" role="region" aria-label="Privacy erasure requests table" tabindex="0">
      <table class="adm-table">
        <thead>
          <tr><th scope="col">Person</th><th scope="col">Reason</th><th scope="col">Status</th><th scope="col">Requested</th><th scope="col">Completed</th><th scope="col">Action</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in pageState.items" :key="item.id">
            <td>{{ userLabel(item.subjectUserId) }}</td>
            <td><span class="adm-clamp">{{ item.reason }}</span></td>
            <td>
              <span :class="['adm-pill', item.status === 'pending' ? 'adm-pill--warning' : 'adm-pill--active']">
                <i :class="['bi', item.status === 'pending' ? 'bi-hourglass-split' : 'bi-check2-circle']" aria-hidden="true"></i>{{ item.status === 'pending' ? 'Pending' : 'Completed' }}
              </span>
            </td>
            <td>{{ date(item.createdAt) }}<small>by {{ userLabel(item.requestedBy) }}</small></td>
            <td>
              <template v-if="item.completedAt">{{ date(item.completedAt) }}<small>by {{ userLabel(item.completedBy) }}</small><small v-if="erasureResultSummary(item.result)">{{ erasureResultSummary(item.result) }}</small></template>
              <template v-else>—</template>
            </td>
            <td>
              <button v-if="canExecuteErasure(item, currentUserId)" class="btn btn-sm btn-outline-danger" type="button" :aria-label="`Execute erasure for ${userLabel(item.subjectUserId)}`" @click="openExecute(item)">Execute</button>
              <small v-else-if="item.status === 'pending'">Waiting for another administrator</small>
              <span v-else class="visually-hidden">No action</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!pageState.items.length" class="adm-empty">{{ requests.length ? 'No erasure requests match these filters.' : 'No privacy erasure requests yet.' }}</p>
    </div>
    <footer v-if="pageState.pageCount > 1" class="adm-pagination">
      <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="pageState.page <= 1" @click="page = pageState.page - 1">Previous</button>
      <span>Page {{ pageState.page }} of {{ pageState.pageCount }}</span>
      <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="pageState.page >= pageState.pageCount" @click="page = pageState.page + 1">Next</button>
    </footer>

    <RequirementsDialog class="adm-dialog" :busy="busy" :open="requesting" title="New privacy erasure request" @close="closeDialogs" @submit="createRequest">
      <div class="rq-field">
        <label for="privacy-subject">Person</label>
        <select id="privacy-subject" v-model="requestDraft.subjectUserId" class="form-select" :aria-invalid="Boolean(errors.subjectUserId)" :aria-describedby="errors.subjectUserId ? 'privacy-subject-error privacy-subject-hint' : 'privacy-subject-hint'">
          <option value="" disabled>Choose a workspace member…</option>
          <option v-for="user in subjectChoices" :key="user.id" :value="user.id">{{ user.name }}{{ user.email ? ` (${user.email})` : '' }}</option>
        </select>
        <p id="privacy-subject-hint" class="rq-field__hint">You cannot request your own erasure, and people with a pending request are not listed.</p>
        <p v-if="errors.subjectUserId" id="privacy-subject-error" class="adm-field-error">{{ errors.subjectUserId }}</p>
      </div>
      <div class="rq-field">
        <label for="privacy-reason">Reason</label>
        <textarea id="privacy-reason" v-model="requestDraft.reason" class="form-control" rows="3" :maxlength="ERASURE_REASON_LIMITS.max" :aria-invalid="Boolean(errors.reason)" :aria-describedby="errors.reason ? 'privacy-reason-error' : undefined"></textarea>
        <p v-if="errors.reason" id="privacy-reason-error" class="adm-field-error">{{ errors.reason }}</p>
      </div>
      <p class="rq-small mb-0">Nothing is erased yet. Another administrator reviews and executes the request.</p>
      <p v-if="formError" class="error-banner mb-0" role="alert">{{ formError }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="busy" @click="closeDialogs">Cancel</button>
        <button class="primary-button" type="submit" :disabled="busy">{{ busy ? 'Creating…' : 'Create request' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsDialog class="adm-dialog" :busy="busy" :open="Boolean(executing)" title="Erase personal data" @close="closeDialogs" @submit="executeRequest">
      <template v-if="executing">
        <p class="alert alert-danger py-2 mb-0">
          <i class="bi bi-exclamation-octagon" aria-hidden="true"></i>
          <strong>This cannot be undone.</strong> Erasing <strong>{{ userLabel(executing.subjectUserId) }}</strong> will:
        </p>
        <ul class="adm-consequences">
          <li>replace their name and email with an anonymous placeholder,</li>
          <li>sign them out everywhere and remove their sign-in credentials,</li>
          <li>remove them from this workspace and its projects,</li>
          <li>delete their personal assistant memories that are not under legal hold,</li>
          <li>queue erasure in connected systems that hold their identity.</li>
        </ul>
        <p class="rq-small mb-0">Requested by {{ userLabel(executing.requestedBy) }}: “{{ executing.reason }}”</p>
        <div class="rq-field">
          <label for="privacy-confirm">Type {{ CONFIRM_WORD }} to confirm</label>
          <input id="privacy-confirm" v-model="confirmText" class="form-control" autocomplete="off" :aria-invalid="Boolean(errors.confirm)" :aria-describedby="errors.confirm ? 'privacy-confirm-error' : undefined" />
          <p v-if="errors.confirm" id="privacy-confirm-error" class="adm-field-error">{{ errors.confirm }}</p>
        </div>
      </template>
      <p v-if="formError" class="error-banner mb-0" role="alert">{{ formError }}</p>
      <template #footer>
        <button class="ghost-button" type="button" data-autofocus :disabled="busy" @click="closeDialogs">Cancel</button>
        <button class="primary-button adm-danger-button" type="submit" :disabled="busy || confirmText.trim() !== CONFIRM_WORD">{{ busy ? 'Erasing…' : 'Erase personal data' }}</button>
      </template>
    </RequirementsDialog>
  </section>
</template>
