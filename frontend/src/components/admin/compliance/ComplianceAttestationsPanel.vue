<script setup>
import { computed, reactive, ref, watch } from 'vue';

import RequirementsDialog from '../../requirements/RequirementsDialog.vue';
import {
  ATTESTATION_STATEMENT_LIMITS,
  CONTROL_KEY_SUGGESTIONS,
  attestationPayload,
  complianceErrorMessage,
  matchesQuery,
  paginate,
  shortHash,
  validateAttestationDraft,
} from '../../../lib/admin/compliance.js';
import { apiClient, authSession } from '../../../lib/auth/index.js';

const props = defineProps({
  attestations: { required: true, type: Array },
  userLabel: { required: true, type: Function },
});
const emit = defineEmits(['changed']);

const query = ref('');
const periodEndFrom = ref('');
const sortDirection = ref('desc');
const page = ref(1);
const expandedId = ref('');

const creating = ref(false);
const busy = ref(false);
const formError = ref('');
const errors = ref({});
const draft = reactive({ controlKey: '', evidenceText: '', periodEnd: '', periodStart: '', statement: '' });

const filtered = computed(() => {
  const sign = sortDirection.value === 'asc' ? 1 : -1;
  return props.attestations
    .filter((item) => (!periodEndFrom.value || item.periodEnd >= periodEndFrom.value) && matchesQuery([item.controlKey, item.statement, ...(item.evidenceRefs ?? [])], query.value))
    .sort((left, right) => sign * (String(left.periodEnd).localeCompare(String(right.periodEnd)) || String(left.attestedAt).localeCompare(String(right.attestedAt))));
});
const pageState = computed(() => paginate(filtered.value, page.value));
watch([query, periodEndFrom, sortDirection], () => { page.value = 1; });

function toggle(item) {
  expandedId.value = expandedId.value === item.id ? '' : item.id;
}

function openCreate() {
  Object.assign(draft, { controlKey: '', evidenceText: '', periodEnd: '', periodStart: '', statement: '' });
  errors.value = {};
  formError.value = '';
  creating.value = true;
}

function closeCreate() {
  if (!busy.value) creating.value = false;
}

async function submit() {
  errors.value = validateAttestationDraft(draft);
  if (Object.keys(errors.value).length) return;
  busy.value = true;
  formError.value = '';
  try {
    await apiClient.createComplianceControlAttestation(attestationPayload(draft), authSession.state.token);
    creating.value = false;
    emit('changed', 'Control attestation recorded.');
  } catch (error) {
    formError.value = complianceErrorMessage(error, 'Unable to record the attestation.');
  } finally {
    busy.value = false;
  }
}

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : '—';
}
</script>

<template>
  <section aria-labelledby="compliance-attestations-title">
    <div class="adm-section-head">
      <h2 id="compliance-attestations-title">Control attestations</h2>
      <button class="btn btn-sm btn-primary" type="button" @click="openCreate">
        <i class="bi bi-plus-lg" aria-hidden="true"></i> New attestation
      </button>
      <p>A control owner's signed statement that a control operated for a period. Attestations are permanent once recorded.</p>
    </div>

    <div class="adm-toolbar">
      <label class="adm-grow" for="attestations-search">Search
        <input id="attestations-search" v-model="query" class="form-control" type="search" placeholder="Control, statement, or evidence" />
      </label>
      <label for="attestations-period">Period ends on or after
        <input id="attestations-period" v-model="periodEndFrom" class="form-control" type="date" />
      </label>
      <label for="attestations-sort">Sort
        <select id="attestations-sort" v-model="sortDirection" class="form-select">
          <option value="desc">Latest period first</option>
          <option value="asc">Earliest period first</option>
        </select>
      </label>
    </div>

    <div class="adm-table-wrap" role="region" aria-label="Control attestations table" tabindex="0">
      <table class="adm-table">
        <thead>
          <tr><th scope="col">Control</th><th scope="col">Period</th><th scope="col">Owner</th><th scope="col">Evidence</th><th scope="col">Content hash</th><th scope="col">Details</th></tr>
        </thead>
        <tbody>
          <template v-for="item in pageState.items" :key="item.id">
            <tr>
              <td><code class="adm-mono">{{ item.controlKey }}</code></td>
              <td>{{ item.periodStart }} to {{ item.periodEnd }}</td>
              <td>{{ userLabel(item.ownerUserId) }}<small>attested {{ date(item.attestedAt) }}</small></td>
              <td>{{ (item.evidenceRefs ?? []).length }}</td>
              <td><code class="adm-mono">{{ shortHash(item.contentHash) }}</code></td>
              <td>
                <button
                  class="btn btn-sm btn-outline-secondary adm-icon-button"
                  type="button"
                  :aria-controls="`attestation-detail-${item.id}`"
                  :aria-expanded="expandedId === item.id"
                  :aria-label="`${expandedId === item.id ? 'Hide' : 'Show'} statement and evidence for ${item.controlKey}`"
                  @click="toggle(item)"
                >
                  <i :class="['bi', expandedId === item.id ? 'bi-chevron-up' : 'bi-chevron-down']" aria-hidden="true"></i>
                </button>
              </td>
            </tr>
            <tr v-if="expandedId === item.id" :id="`attestation-detail-${item.id}`" class="adm-detail-row">
              <td colspan="6">
                <div class="adm-detail">
                  <h3>Statement</h3>
                  <p>{{ item.statement }}</p>
                  <h3>Evidence references</h3>
                  <ul><li v-for="(evidence, index) in item.evidenceRefs" :key="index" class="adm-mono">{{ evidence }}</li></ul>
                  <p class="adm-mono">SHA-256 {{ item.contentHash }}</p>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <p v-if="!pageState.items.length" class="adm-empty">{{ attestations.length ? 'No attestations match these filters.' : 'No control attestations yet.' }}</p>
    </div>
    <footer v-if="pageState.pageCount > 1" class="adm-pagination">
      <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="pageState.page <= 1" @click="page = pageState.page - 1">Previous</button>
      <span>Page {{ pageState.page }} of {{ pageState.pageCount }}</span>
      <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="pageState.page >= pageState.pageCount" @click="page = pageState.page + 1">Next</button>
    </footer>

    <RequirementsDialog class="adm-dialog" :busy="busy" :open="creating" title="New control attestation" @close="closeCreate" @submit="submit">
      <p class="alert alert-warning py-2 mb-0">
        <i class="bi bi-exclamation-triangle" aria-hidden="true"></i>
        You are attesting in your own name. Once recorded, an attestation cannot be edited or deleted.
      </p>
      <div class="rq-field">
        <label for="attestation-control">Control key</label>
        <input id="attestation-control" v-model="draft.controlKey" class="form-control" list="attestation-control-suggestions" autocomplete="off" :aria-invalid="Boolean(errors.controlKey)" :aria-describedby="errors.controlKey ? 'attestation-control-error attestation-control-hint' : 'attestation-control-hint'" />
        <datalist id="attestation-control-suggestions">
          <option v-for="key in CONTROL_KEY_SUGGESTIONS" :key="key" :value="key"></option>
        </datalist>
        <p id="attestation-control-hint" class="rq-field__hint">Lowercase, for example privacy_rights or legal_hold.</p>
        <p v-if="errors.controlKey" id="attestation-control-error" class="adm-field-error">{{ errors.controlKey }}</p>
      </div>
      <div class="adm-dialog-grid">
        <div class="rq-field">
          <label for="attestation-start">Period start</label>
          <input id="attestation-start" v-model="draft.periodStart" class="form-control" type="date" :aria-invalid="Boolean(errors.periodStart)" :aria-describedby="errors.periodStart ? 'attestation-start-error' : undefined" />
          <p v-if="errors.periodStart" id="attestation-start-error" class="adm-field-error">{{ errors.periodStart }}</p>
        </div>
        <div class="rq-field">
          <label for="attestation-end">Period end</label>
          <input id="attestation-end" v-model="draft.periodEnd" class="form-control" type="date" :aria-invalid="Boolean(errors.periodEnd)" :aria-describedby="errors.periodEnd ? 'attestation-end-error' : undefined" />
          <p v-if="errors.periodEnd" id="attestation-end-error" class="adm-field-error">{{ errors.periodEnd }}</p>
        </div>
      </div>
      <div class="rq-field">
        <label for="attestation-statement">Statement</label>
        <textarea id="attestation-statement" v-model="draft.statement" class="form-control" rows="4" :maxlength="ATTESTATION_STATEMENT_LIMITS.max" :aria-invalid="Boolean(errors.statement)" :aria-describedby="errors.statement ? 'attestation-statement-error' : undefined"></textarea>
        <p v-if="errors.statement" id="attestation-statement-error" class="adm-field-error">{{ errors.statement }}</p>
      </div>
      <div class="rq-field">
        <label for="attestation-evidence">Evidence references</label>
        <textarea id="attestation-evidence" v-model="draft.evidenceText" class="form-control" rows="3" :aria-invalid="Boolean(errors.evidenceText)" :aria-describedby="errors.evidenceText ? 'attestation-evidence-error attestation-evidence-hint' : 'attestation-evidence-hint'"></textarea>
        <p id="attestation-evidence-hint" class="rq-field__hint">One per line: export IDs, hold IDs, ticket links, or document locations.</p>
        <p v-if="errors.evidenceText" id="attestation-evidence-error" class="adm-field-error">{{ errors.evidenceText }}</p>
      </div>
      <p v-if="formError" class="error-banner mb-0" role="alert">{{ formError }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="busy" @click="closeCreate">Cancel</button>
        <button class="primary-button" type="submit" :disabled="busy">{{ busy ? 'Recording…' : 'Record attestation' }}</button>
      </template>
    </RequirementsDialog>
  </section>
</template>
