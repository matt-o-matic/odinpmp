<script setup>
import { computed, reactive, ref, watch } from 'vue';

import RequirementsDialog from '../../requirements/RequirementsDialog.vue';
import {
  complianceErrorMessage,
  exportRangeLabel,
  isoDate,
  paginate,
  regionLabel,
  shortHash,
  sortByTimestamp,
  validateDateRange,
} from '../../../lib/admin/compliance.js';
import { apiClient, authSession } from '../../../lib/auth/index.js';

const props = defineProps({
  exports: { required: true, type: Array },
  policy: { default: null, type: Object },
  userLabel: { required: true, type: Function },
});
const emit = defineEmits(['changed']);

const createdFrom = ref('');
const sortDirection = ref('desc');
const page = ref(1);
const panelError = ref('');
const downloadingId = ref('');

const creating = ref(false);
const busy = ref(false);
const formError = ref('');
const draft = reactive({ endDate: '', startDate: '' });
const errors = ref({});

const filtered = computed(() => {
  const minimum = createdFrom.value;
  const rows = props.exports.filter((item) => !minimum || isoDate(item.createdAt) >= minimum);
  return sortByTimestamp(rows, 'createdAt', sortDirection.value);
});
const pageState = computed(() => paginate(filtered.value, page.value));
watch([createdFrom, sortDirection], () => { page.value = 1; });

function openCreate() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  Object.assign(draft, { endDate: today, startDate: monthAgo });
  errors.value = {};
  formError.value = '';
  creating.value = true;
}

function closeCreate() {
  if (!busy.value) creating.value = false;
}

async function createExport() {
  const range = validateDateRange(draft.startDate, draft.endDate);
  errors.value = { endDate: range.end, startDate: range.start };
  if (range.end || range.start) return;
  busy.value = true;
  formError.value = '';
  try {
    const result = await apiClient.createComplianceAuditExport({ endDate: draft.endDate, startDate: draft.startDate }, authSession.state.token);
    creating.value = false;
    emit('changed', `Audit export created with ${result?.manifest?.recordCount ?? 0} events.`);
  } catch (error) {
    formError.value = complianceErrorMessage(error, 'Unable to create the audit export.');
  } finally {
    busy.value = false;
  }
}

async function download(item) {
  panelError.value = '';
  downloadingId.value = item.id;
  try {
    const { blob } = await apiClient.downloadComplianceAuditExport(item.id, authSession.state.token);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `audit-evidence-${item.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    panelError.value = complianceErrorMessage(error, 'Unable to download the audit export.');
  } finally {
    downloadingId.value = '';
  }
}

function dateTime(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}
</script>

<template>
  <section aria-labelledby="compliance-exports-title">
    <div class="adm-section-head">
      <h2 id="compliance-exports-title">Audit exports</h2>
      <button class="btn btn-sm btn-primary" type="button" @click="openCreate">
        <i class="bi bi-plus-lg" aria-hidden="true"></i> New export
      </button>
      <p>Each export is a hash-chained, read-only copy of the audit log for a date range, linked to the export before it.</p>
    </div>

    <div v-if="panelError" class="alert alert-danger" role="alert">{{ panelError }}</div>

    <div class="adm-toolbar">
      <label for="export-created-from">Created on or after
        <input id="export-created-from" v-model="createdFrom" class="form-control" type="date" />
      </label>
      <label for="export-sort">Sort
        <select id="export-sort" v-model="sortDirection" class="form-select">
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
      </label>
    </div>

    <div class="adm-table-wrap" role="region" aria-label="Audit exports table" tabindex="0">
      <table class="adm-table">
        <thead>
          <tr><th scope="col">Created</th><th scope="col">Date range (UTC)</th><th scope="col">Events</th><th scope="col">Root hash</th><th scope="col">Region</th><th scope="col">Locked until</th><th scope="col">Action</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in pageState.items" :key="item.id">
            <td>{{ dateTime(item.createdAt) }}<small>by {{ userLabel(item.createdBy) }}</small></td>
            <td>{{ exportRangeLabel(item) }}</td>
            <td>{{ Number(item.recordCount ?? 0).toLocaleString() }}</td>
            <td><code class="adm-mono">{{ shortHash(item.rootHash) }}</code></td>
            <td>{{ regionLabel(item.dataRegion) }}</td>
            <td>{{ isoDate(item.retentionUntil) || '—' }}</td>
            <td>
              <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="downloadingId === item.id" :aria-label="`Download export created ${dateTime(item.createdAt)}`" @click="download(item)">
                <i class="bi bi-download" aria-hidden="true"></i> {{ downloadingId === item.id ? 'Downloading…' : 'Download' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!pageState.items.length" class="adm-empty">{{ exports.length ? 'No exports match these filters.' : 'No audit exports yet.' }}</p>
    </div>
    <footer v-if="pageState.pageCount > 1" class="adm-pagination">
      <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="pageState.page <= 1" @click="page = pageState.page - 1">Previous</button>
      <span>Page {{ pageState.page }} of {{ pageState.pageCount }}</span>
      <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="pageState.page >= pageState.pageCount" @click="page = pageState.page + 1">Next</button>
    </footer>

    <RequirementsDialog class="adm-dialog" :busy="busy" :open="creating" title="New audit export" @close="closeCreate" @submit="createExport">
      <p class="rq-small mb-0">
        Covers every audit event from the start of the first day to the end of the last day, in UTC, up to 100,000 events.
        The file is stored read-only<template v-if="policy"> for {{ policy.wormRetentionDays }} days</template> and cannot be changed or deleted.
      </p>
      <div class="adm-dialog-grid">
        <div class="rq-field">
          <label for="export-start">First day</label>
          <input id="export-start" v-model="draft.startDate" class="form-control" type="date" required :aria-invalid="Boolean(errors.startDate)" :aria-describedby="errors.startDate ? 'export-start-error' : undefined" />
          <p v-if="errors.startDate" id="export-start-error" class="adm-field-error">{{ errors.startDate }}</p>
        </div>
        <div class="rq-field">
          <label for="export-end">Last day</label>
          <input id="export-end" v-model="draft.endDate" class="form-control" type="date" required :aria-invalid="Boolean(errors.endDate)" :aria-describedby="errors.endDate ? 'export-end-error' : undefined" />
          <p v-if="errors.endDate" id="export-end-error" class="adm-field-error">{{ errors.endDate }}</p>
        </div>
      </div>
      <p v-if="formError" class="error-banner mb-0" role="alert">{{ formError }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="busy" @click="closeCreate">Cancel</button>
        <button class="primary-button" type="submit" :disabled="busy">{{ busy ? 'Creating…' : 'Create export' }}</button>
      </template>
    </RequirementsDialog>
  </section>
</template>
