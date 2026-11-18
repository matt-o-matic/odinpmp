<script setup>
import { computed, reactive, ref, watch } from 'vue';

import RequirementsDialog from '../../requirements/RequirementsDialog.vue';
import {
  HOLD_REASON_LIMITS,
  LEGAL_HOLD_RESOURCE_TYPES,
  complianceErrorMessage,
  exportRangeLabel,
  matchesQuery,
  paginate,
  resourceTypeLabel,
  sortByTimestamp,
  textLengthError,
} from '../../../lib/admin/compliance.js';
import { apiClient, authSession } from '../../../lib/auth/index.js';

const props = defineProps({
  exports: { required: true, type: Array },
  holds: { required: true, type: Array },
  projectLabel: { required: true, type: Function },
  projects: { required: true, type: Array },
  userLabel: { required: true, type: Function },
  users: { required: true, type: Array },
});
const emit = defineEmits(['changed', 'reload']);

const query = ref('');
const statusFilter = ref('active');
const typeFilter = ref('');
const page = ref(1);

const placing = ref(false);
const releasing = ref(null);
const busy = ref(false);
const formError = ref('');
const errors = ref({});
const placeDraft = reactive({ reason: '', resourceId: '', resourceType: 'project' });
const releaseDraft = reactive({ reason: '' });

const exportChoices = computed(() => sortByTimestamp(props.exports, 'createdAt').map((item) => ({ id: item.id, label: `${exportRangeLabel(item)} (created ${String(item.createdAt).slice(0, 10)})` })));
const selectedType = computed(() => LEGAL_HOLD_RESOURCE_TYPES.find((type) => type.value === placeDraft.resourceType) ?? LEGAL_HOLD_RESOURCE_TYPES[0]);
const pickerChoices = computed(() => {
  if (selectedType.value.picker === 'project') return props.projects.map((project) => ({ id: project.id, label: project.name }));
  if (selectedType.value.picker === 'user') return props.users.map((user) => ({ id: user.id, label: user.email ? `${user.name} (${user.email})` : user.name }));
  if (selectedType.value.picker === 'export') return exportChoices.value;
  return [];
});
// Fall back to a typed ID when the list behind a picker could not be loaded or is empty.
const usesPicker = computed(() => Boolean(selectedType.value.picker) && pickerChoices.value.length > 0);

function resourceLabel(hold) {
  if (hold.resourceType === 'project') return props.projectLabel(hold.resourceId);
  if (hold.resourceType === 'privacy_subject') return props.userLabel(hold.resourceId);
  if (hold.resourceType === 'audit_export') {
    const match = props.exports.find((item) => item.id === hold.resourceId);
    return match ? `Export ${exportRangeLabel(match)}` : hold.resourceId;
  }
  return hold.resourceId;
}

const filtered = computed(() => {
  const rows = props.holds.filter((hold) => {
    if (statusFilter.value !== 'all' && hold.status !== statusFilter.value) return false;
    if (typeFilter.value && hold.resourceType !== typeFilter.value) return false;
    return matchesQuery([resourceLabel(hold), hold.resourceId, hold.reason, hold.releaseReason], query.value);
  });
  return sortByTimestamp(rows, 'createdAt');
});
const pageState = computed(() => paginate(filtered.value, page.value));
watch([query, statusFilter, typeFilter], () => { page.value = 1; });
watch(() => placeDraft.resourceType, () => { placeDraft.resourceId = ''; });

function openPlace() {
  Object.assign(placeDraft, { reason: '', resourceId: '', resourceType: 'project' });
  errors.value = {};
  formError.value = '';
  placing.value = true;
}

function openRelease(hold) {
  releaseDraft.reason = '';
  errors.value = {};
  formError.value = '';
  releasing.value = hold;
}

function closeDialogs() {
  if (busy.value) return;
  placing.value = false;
  releasing.value = null;
}

async function placeHold() {
  errors.value = {
    reason: textLengthError(placeDraft.reason, HOLD_REASON_LIMITS, 'The reason'),
    resourceId: String(placeDraft.resourceId).trim() ? '' : usesPicker.value ? 'Choose the record to hold.' : 'Enter the record ID.',
  };
  if (errors.value.reason || errors.value.resourceId) return;
  busy.value = true;
  formError.value = '';
  try {
    await apiClient.createComplianceLegalHold({ reason: placeDraft.reason.trim(), resourceId: String(placeDraft.resourceId).trim(), resourceType: placeDraft.resourceType }, authSession.state.token);
    placing.value = false;
    statusFilter.value = 'active';
    emit('changed', 'Legal hold placed.');
  } catch (error) {
    formError.value = complianceErrorMessage(error, 'Unable to place the legal hold.');
  } finally {
    busy.value = false;
  }
}

async function releaseHold() {
  errors.value = { reason: textLengthError(releaseDraft.reason, HOLD_REASON_LIMITS, 'The release reason') };
  if (errors.value.reason) return;
  // A conflict reloads the list, so use the newest copy of the hold for the version check.
  const hold = props.holds.find((item) => item.id === releasing.value.id) ?? releasing.value;
  if (hold.status !== 'active') {
    formError.value = 'This hold has already been released.';
    return;
  }
  busy.value = true;
  formError.value = '';
  try {
    await apiClient.releaseComplianceLegalHold(hold.id, { expectedVersion: hold.version, reason: releaseDraft.reason.trim() }, authSession.state.token);
    releasing.value = null;
    emit('changed', 'Legal hold released.');
  } catch (error) {
    formError.value = complianceErrorMessage(error, 'Unable to release the legal hold.');
    if (error?.status === 409) emit('reload');
  } finally {
    busy.value = false;
  }
}

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : '—';
}
</script>

<template>
  <section aria-labelledby="compliance-holds-title">
    <div class="adm-section-head">
      <h2 id="compliance-holds-title">Legal holds</h2>
      <button class="btn btn-sm btn-primary" type="button" @click="openPlace">
        <i class="bi bi-plus-lg" aria-hidden="true"></i> Place hold
      </button>
      <p>A held record cannot be deleted or erased until the hold is released.</p>
    </div>

    <div class="adm-toolbar">
      <label class="adm-grow" for="holds-search">Search
        <input id="holds-search" v-model="query" class="form-control" type="search" placeholder="Record or reason" />
      </label>
      <label for="holds-status">Status
        <select id="holds-status" v-model="statusFilter" class="form-select">
          <option value="active">Active</option>
          <option value="released">Released</option>
          <option value="all">All</option>
        </select>
      </label>
      <label for="holds-type">Record type
        <select id="holds-type" v-model="typeFilter" class="form-select">
          <option value="">All types</option>
          <option v-for="type in LEGAL_HOLD_RESOURCE_TYPES" :key="type.value" :value="type.value">{{ type.label }}</option>
        </select>
      </label>
    </div>

    <div class="adm-table-wrap" role="region" aria-label="Legal holds table" tabindex="0">
      <table class="adm-table">
        <thead>
          <tr><th scope="col">Record</th><th scope="col">Reason</th><th scope="col">Status</th><th scope="col">Placed</th><th scope="col">Released</th><th scope="col">Action</th></tr>
        </thead>
        <tbody>
          <tr v-for="hold in pageState.items" :key="hold.id">
            <td>{{ resourceLabel(hold) }}<small>{{ resourceTypeLabel(hold.resourceType) }}</small></td>
            <td><span class="adm-clamp">{{ hold.reason }}</span></td>
            <td>
              <span :class="['adm-pill', hold.status === 'active' ? 'adm-pill--warning' : 'adm-pill--muted']">
                <i :class="['bi', hold.status === 'active' ? 'bi-lock-fill' : 'bi-unlock']" aria-hidden="true"></i>{{ hold.status === 'active' ? 'Active' : 'Released' }}
              </span>
            </td>
            <td>{{ date(hold.createdAt) }}<small>by {{ userLabel(hold.createdBy) }}</small></td>
            <td>
              <template v-if="hold.releasedAt">{{ date(hold.releasedAt) }}<small>by {{ userLabel(hold.releasedBy) }}</small></template>
              <template v-else>—</template>
            </td>
            <td>
              <button v-if="hold.status === 'active'" class="btn btn-sm btn-outline-secondary" type="button" :aria-label="`Release hold on ${resourceLabel(hold)}`" @click="openRelease(hold)">Release</button>
              <span v-else class="visually-hidden">No action</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!pageState.items.length" class="adm-empty">{{ holds.length ? 'No legal holds match these filters.' : 'No legal holds have been placed.' }}</p>
    </div>
    <footer v-if="pageState.pageCount > 1" class="adm-pagination">
      <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="pageState.page <= 1" @click="page = pageState.page - 1">Previous</button>
      <span>Page {{ pageState.page }} of {{ pageState.pageCount }}</span>
      <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="pageState.page >= pageState.pageCount" @click="page = pageState.page + 1">Next</button>
    </footer>

    <RequirementsDialog class="adm-dialog" :busy="busy" :open="placing" title="Place legal hold" @close="closeDialogs" @submit="placeHold">
      <div class="rq-field">
        <label for="hold-type">Record type</label>
        <select id="hold-type" v-model="placeDraft.resourceType" class="form-select">
          <option v-for="type in LEGAL_HOLD_RESOURCE_TYPES" :key="type.value" :value="type.value">{{ type.label }}</option>
        </select>
      </div>
      <div class="rq-field">
        <template v-if="usesPicker">
          <label for="hold-resource">{{ selectedType.label }}</label>
          <select id="hold-resource" v-model="placeDraft.resourceId" class="form-select" :aria-invalid="Boolean(errors.resourceId)" :aria-describedby="errors.resourceId ? 'hold-resource-error' : undefined">
            <option value="" disabled>Choose…</option>
            <option v-for="choice in pickerChoices" :key="choice.id" :value="choice.id">{{ choice.label }}</option>
          </select>
        </template>
        <template v-else>
          <label for="hold-resource">Record ID</label>
          <input id="hold-resource" v-model="placeDraft.resourceId" class="form-control" autocomplete="off" :aria-invalid="Boolean(errors.resourceId)" :aria-describedby="errors.resourceId ? 'hold-resource-error hold-resource-hint' : 'hold-resource-hint'" />
          <p id="hold-resource-hint" class="rq-field__hint">Copy the ID of the {{ selectedType.label.toLowerCase() }} from the screen that manages it.</p>
        </template>
        <p v-if="errors.resourceId" id="hold-resource-error" class="adm-field-error">{{ errors.resourceId }}</p>
      </div>
      <div class="rq-field">
        <label for="hold-reason">Reason</label>
        <textarea id="hold-reason" v-model="placeDraft.reason" class="form-control" rows="3" :maxlength="HOLD_REASON_LIMITS.max" :aria-invalid="Boolean(errors.reason)" :aria-describedby="errors.reason ? 'hold-reason-error' : undefined"></textarea>
        <p v-if="errors.reason" id="hold-reason-error" class="adm-field-error">{{ errors.reason }}</p>
      </div>
      <p v-if="formError" class="error-banner mb-0" role="alert">{{ formError }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="busy" @click="closeDialogs">Cancel</button>
        <button class="primary-button" type="submit" :disabled="busy">{{ busy ? 'Placing…' : 'Place hold' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsDialog class="adm-dialog" :busy="busy" :open="Boolean(releasing)" title="Release legal hold" @close="closeDialogs" @submit="releaseHold">
      <p v-if="releasing" class="rq-small mb-0">
        Releasing the hold on <strong>{{ resourceLabel(releasing) }}</strong> ({{ resourceTypeLabel(releasing.resourceType) }}) allows it to be deleted or erased again. The release and its reason are kept on record.
      </p>
      <div class="rq-field">
        <label for="hold-release-reason">Release reason</label>
        <textarea id="hold-release-reason" v-model="releaseDraft.reason" class="form-control" rows="3" :maxlength="HOLD_REASON_LIMITS.max" :aria-invalid="Boolean(errors.reason)" :aria-describedby="errors.reason ? 'hold-release-reason-error' : undefined"></textarea>
        <p v-if="errors.reason" id="hold-release-reason-error" class="adm-field-error">{{ errors.reason }}</p>
      </div>
      <p v-if="formError" class="error-banner mb-0" role="alert">{{ formError }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="busy" @click="closeDialogs">Cancel</button>
        <button class="primary-button adm-danger-button" type="submit" :disabled="busy">{{ busy ? 'Releasing…' : 'Release hold' }}</button>
      </template>
    </RequirementsDialog>
  </section>
</template>
