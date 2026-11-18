<script setup>
import { computed, reactive, ref, watch } from 'vue';

import RequirementsDialog from '../../requirements/RequirementsDialog.vue';
import {
  DATA_REGIONS,
  POLICY_LIMITS,
  complianceErrorMessage,
  policyDraftFrom,
  policyPayload,
  regionLabel,
  validatePolicyDraft,
} from '../../../lib/admin/compliance.js';
import { apiClient, authSession } from '../../../lib/auth/index.js';

const props = defineProps({
  policy: { required: true, type: Object },
  userLabel: { required: true, type: Function },
});
const emit = defineEmits(['changed', 'reload']);

const editing = ref(false);
const busy = ref(false);
const formError = ref('');
const awaitingReload = ref(false);
const draft = reactive(policyDraftFrom());
const errors = ref({});

const neverSaved = computed(() => Number(props.policy?.version ?? 0) === 0);

function openEditor() {
  Object.assign(draft, policyDraftFrom(props.policy));
  errors.value = {};
  formError.value = '';
  editing.value = true;
}

function closeEditor() {
  if (busy.value) return;
  editing.value = false;
}

async function save() {
  errors.value = validatePolicyDraft(draft);
  if (Object.keys(errors.value).length) return;
  busy.value = true;
  formError.value = '';
  try {
    await apiClient.updateCompliancePolicy(policyPayload(draft, props.policy.version), authSession.state.token);
    editing.value = false;
    emit('changed', 'Compliance policy saved.');
  } catch (error) {
    formError.value = complianceErrorMessage(error, 'Unable to save the compliance policy.');
    if (error?.status === 409) {
      awaitingReload.value = true;
      emit('reload');
    }
  } finally {
    busy.value = false;
  }
}

// After a version conflict the parent reloads; show the other admin's values before a retry.
watch(() => props.policy?.version, () => {
  if (!awaitingReload.value || !editing.value) return;
  awaitingReload.value = false;
  Object.assign(draft, policyDraftFrom(props.policy));
});

function dateTime(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}
</script>

<template>
  <section aria-labelledby="compliance-policy-title">
    <div class="adm-section-head">
      <h2 id="compliance-policy-title">Policy</h2>
      <button class="btn btn-sm btn-outline-primary" type="button" @click="openEditor">
        <i class="bi bi-pencil" aria-hidden="true"></i> Edit policy
      </button>
    </div>

    <div v-if="policy.legalHold" class="alert alert-warning d-flex gap-2 align-items-start" role="status">
      <i class="bi bi-shield-lock-fill" aria-hidden="true"></i>
      <span><strong>Tenant-wide legal hold is on.</strong> Destructive changes and privacy erasure are blocked across this workspace until it is turned off.</span>
    </div>
    <p v-if="neverSaved" class="alert alert-info py-2">These are the default values. Nothing has been saved for this workspace yet.</p>

    <dl class="adm-dl">
      <div><dt>Data region</dt><dd>{{ regionLabel(policy.dataRegion) }}</dd></div>
      <div><dt>Audit log retention</dt><dd>{{ policy.auditRetentionDays }} days</dd></div>
      <div><dt>Export retention lock (WORM)</dt><dd>{{ policy.wormRetentionDays }} days</dd></div>
      <div><dt>Privacy deletion window</dt><dd>{{ policy.privacyDeletionDays }} days</dd></div>
      <div>
        <dt>Tenant-wide legal hold</dt>
        <dd>
          <span :class="['adm-pill', policy.legalHold ? 'adm-pill--warning' : 'adm-pill--muted']">
            <i :class="['bi', policy.legalHold ? 'bi-lock-fill' : 'bi-unlock']" aria-hidden="true"></i>{{ policy.legalHold ? 'On' : 'Off' }}
          </span>
        </dd>
      </div>
      <div><dt>Last changed</dt><dd>{{ dateTime(policy.updatedAt) }}<template v-if="policy.updatedBy"> by {{ userLabel(policy.updatedBy) }}</template></dd></div>
    </dl>

    <RequirementsDialog class="adm-dialog" :busy="busy" :open="editing" title="Edit compliance policy" @close="closeEditor" @submit="save">
      <div class="rq-field">
        <label for="policy-region">Data region</label>
        <select id="policy-region" v-model="draft.dataRegion" class="form-select" aria-describedby="policy-region-hint">
          <option v-for="region in DATA_REGIONS" :key="region.value" :value="region.value">{{ region.label }}</option>
        </select>
        <p id="policy-region-hint" class="rq-field__hint">Recorded on every audit export and checked against the export storage region. It does not move existing data.</p>
      </div>
      <div class="adm-dialog-grid">
        <div class="rq-field">
          <label for="policy-audit-retention">Audit log retention (days)</label>
          <input id="policy-audit-retention" v-model.number="draft.auditRetentionDays" class="form-control" type="number" :min="POLICY_LIMITS.auditRetentionDays.min" :max="POLICY_LIMITS.auditRetentionDays.max" :aria-invalid="Boolean(errors.auditRetentionDays)" :aria-describedby="errors.auditRetentionDays ? 'policy-audit-retention-error' : undefined" />
          <p v-if="errors.auditRetentionDays" id="policy-audit-retention-error" class="adm-field-error">{{ errors.auditRetentionDays }}</p>
        </div>
        <div class="rq-field">
          <label for="policy-worm-retention">Export retention lock (days)</label>
          <input id="policy-worm-retention" v-model.number="draft.wormRetentionDays" class="form-control" type="number" :min="POLICY_LIMITS.wormRetentionDays.min" :max="POLICY_LIMITS.wormRetentionDays.max" :aria-invalid="Boolean(errors.wormRetentionDays)" :aria-describedby="errors.wormRetentionDays ? 'policy-worm-retention-error' : undefined" />
          <p v-if="errors.wormRetentionDays" id="policy-worm-retention-error" class="adm-field-error">{{ errors.wormRetentionDays }}</p>
        </div>
        <div class="rq-field">
          <label for="policy-privacy-days">Privacy deletion window (days)</label>
          <input id="policy-privacy-days" v-model.number="draft.privacyDeletionDays" class="form-control" type="number" :min="POLICY_LIMITS.privacyDeletionDays.min" :max="POLICY_LIMITS.privacyDeletionDays.max" :aria-invalid="Boolean(errors.privacyDeletionDays)" :aria-describedby="errors.privacyDeletionDays ? 'policy-privacy-days-error' : undefined" />
          <p v-if="errors.privacyDeletionDays" id="policy-privacy-days-error" class="adm-field-error">{{ errors.privacyDeletionDays }}</p>
        </div>
      </div>
      <label class="adm-check" for="policy-legal-hold">
        <input id="policy-legal-hold" v-model="draft.legalHold" type="checkbox" aria-describedby="policy-legal-hold-hint" />
        <span>Tenant-wide legal hold</span>
      </label>
      <p id="policy-legal-hold-hint" class="rq-field__hint">While on, deleting projects, files, reports, and financial entries, and executing privacy erasure, are refused for the whole workspace.</p>
      <p v-if="formError" class="error-banner mb-0" role="alert">{{ formError }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="busy" @click="closeEditor">Cancel</button>
        <button class="primary-button" type="submit" :disabled="busy">{{ busy ? 'Saving…' : 'Save policy' }}</button>
      </template>
    </RequirementsDialog>
  </section>
</template>
