<script setup>
import { computed, reactive, ref, useId, watch } from 'vue';

import { apiClient } from '../../../lib/auth/index.js';
import { fileSizeLabel } from '../../../lib/projects/project-files.js';
import { DEFAULT_SIGNING_STATEMENTS, signingErrorMessage } from '../../../lib/projects/project-signing.js';
import RequirementsDialog from '../../requirements/RequirementsDialog.vue';

// Asking stakeholders to sign: an acceptance of documents, or a sign-off
// of the project or a milestone. One form, one submit. Odin freezes the chosen file versions,
// shares them with stakeholders, and emails each signer a link.
const props = defineProps({
  // Vault files that can go in the request.
  files: { default: () => [], type: Array },
  // The file the request started from, picked by default.
  initialFileId: { default: '', type: String },
  open: { default: false, type: Boolean },
  projectId: { default: '', type: String },
  token: { default: '', type: String },
});

const emit = defineEmits(['close', 'created']);

const uid = useId();
const ids = {
  documents: `${uid}-documents`,
  kind: `${uid}-kind`,
  message: `${uid}-message`,
  search: `${uid}-search`,
  signers: `${uid}-signers`,
  statement: `${uid}-statement`,
  subject: `${uid}-subject`,
  title: `${uid}-title`,
};

const form = reactive({ fileIds: [], kind: 'acceptance', message: '', search: '', signerIds: [], statement: DEFAULT_SIGNING_STATEMENTS.acceptance, subject: 'project', title: '' });
const stakeholders = ref([]);
const milestones = ref([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
let titleTouched = false;

const signable = computed(() => props.files.filter((file) => file.targetType !== 'ticket'));
const shownFiles = computed(() => {
  const needle = form.search.trim().toLowerCase();
  return signable.value.filter((file) => !needle || form.fileIds.includes(file.id) || String(file.fileName ?? '').toLowerCase().includes(needle)).slice(0, 50);
});
const withEmail = (stakeholder) => /@/.test(String(stakeholder.email ?? ''));
const canSubmit = computed(() => form.title.trim() && form.signerIds.length && (form.kind === 'signoff' || form.fileIds.length));

function stripExtension(name) {
  return String(name ?? '').replace(/\.[A-Za-z0-9]{1,6}$/, '');
}

function suggestedTitle() {
  if (form.kind === 'acceptance') {
    const first = signable.value.find((file) => file.id === form.fileIds[0]);
    return first ? stripExtension(first.fileName) : '';
  }
  const milestone = milestones.value.find((entry) => entry.id === form.subject);
  return milestone ? `${milestone.title} sign-off` : 'Project sign-off';
}

function refreshTitle() {
  if (!titleTouched) form.title = suggestedTitle();
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [contacts, governance] = await Promise.all([
      apiClient.getProjectAssistantClarifications(props.projectId, props.token),
      apiClient.getProjectGovernance(props.projectId, props.token).catch(() => null),
    ]);
    stakeholders.value = contacts?.stakeholders ?? contacts?.stakeholderContacts ?? [];
    milestones.value = governance?.milestones ?? [];
  } catch (loadError) {
    error.value = signingErrorMessage(loadError, 'Unable to load the project\'s stakeholders.');
  } finally {
    loading.value = false;
    refreshTitle();
  }
}

function reset() {
  Object.assign(form, {
    fileIds: props.initialFileId ? [props.initialFileId] : [],
    kind: 'acceptance',
    message: '',
    search: '',
    signerIds: [],
    statement: DEFAULT_SIGNING_STATEMENTS.acceptance,
    subject: 'project',
    title: '',
  });
  titleTouched = false;
  error.value = '';
  refreshTitle();
}

watch(() => props.open, (open) => {
  if (!open) return;
  reset();
  load();
}, { immediate: true });

watch(() => form.kind, (kind, previous) => {
  // Swap the statement only when nobody has changed it.
  if (form.statement.trim() === DEFAULT_SIGNING_STATEMENTS[previous]) form.statement = DEFAULT_SIGNING_STATEMENTS[kind];
  refreshTitle();
});
watch(() => [form.subject, form.fileIds[0]], refreshTitle);

async function submit() {
  if (saving.value) return;
  if (!canSubmit.value) {
    error.value = form.kind === 'acceptance' && !form.fileIds.length
      ? 'Pick at least one document.'
      : !form.signerIds.length ? 'Pick at least one signer.' : 'Give the request a title.';
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const payload = {
      documents: form.fileIds.map((fileId) => ({ fileId })),
      kind: form.kind,
      signerStakeholderIds: form.signerIds,
      statement: form.statement.trim(),
      title: form.title.trim(),
      ...(form.message.trim() ? { message: form.message.trim() } : {}),
      ...(form.kind === 'signoff' && form.subject !== 'project' ? { subjectId: form.subject, subjectType: 'milestone' } : {}),
    };
    const result = await apiClient.createSigningRequest(props.projectId, payload, props.token);
    emit('created', result.request);
  } catch (saveError) {
    error.value = signingErrorMessage(saveError, 'Unable to send the request.');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <RequirementsDialog :busy="saving" :open="open" :title="'Request signatures'" @close="emit('close')" @submit="submit">
    <fieldset class="rq-field">
      <legend :id="ids.kind">What are you asking for?</legend>
      <div class="signing-form__choices">
        <label class="signing-form__choice">
          <input v-model="form.kind" class="form-check-input mt-0" name="signing-kind" type="radio" value="acceptance" />
          <span><strong>Acceptance</strong><span class="signing-form__hint">Stakeholders accept one or more documents.</span></span>
        </label>
        <label class="signing-form__choice">
          <input v-model="form.kind" class="form-check-input mt-0" name="signing-kind" type="radio" value="signoff" />
          <span><strong>Sign-off</strong><span class="signing-form__hint">Stakeholders sign off the project or a milestone.</span></span>
        </label>
      </div>
    </fieldset>

    <div v-if="form.kind === 'signoff'" class="rq-field">
      <label :for="ids.subject">Sign off</label>
      <select :id="ids.subject" v-model="form.subject" class="form-select">
        <option value="project">The whole project</option>
        <option v-for="milestone in milestones" :key="milestone.id" :value="milestone.id">Milestone: {{ milestone.title }}</option>
      </select>
    </div>

    <fieldset class="rq-field">
      <legend :id="ids.documents">Documents<template v-if="form.kind === 'signoff'"> (optional)</template></legend>
      <label class="visually-hidden" :for="ids.search">Find a file</label>
      <input v-if="signable.length > 6" :id="ids.search" v-model="form.search" autocomplete="off" class="form-control" placeholder="Find a file" type="search" />
      <ul v-if="shownFiles.length" class="rq-checklist signing-form__list">
        <li v-for="file in shownFiles" :key="file.id">
          <label>
            <input v-model="form.fileIds" class="form-check-input mt-0" type="checkbox" :value="file.id" />
            <span class="signing-form__name">{{ file.fileName }}</span>
            <span class="signing-form__meta">v{{ file.version ?? 1 }} · {{ fileSizeLabel(file.fileSize) }}</span>
          </label>
        </li>
      </ul>
      <p v-else class="rq-field__hint mb-0">No files{{ form.search ? ' match that search' : ' in the vault yet' }}.</p>
      <p class="rq-field__hint mb-0">Signers see the current version of each file. Later versions do not change what they sign.</p>
    </fieldset>

    <fieldset class="rq-field">
      <legend :id="ids.signers">Signers</legend>
      <p v-if="loading" class="rq-field__hint" role="status">Loading stakeholders…</p>
      <ul v-else-if="stakeholders.length" class="rq-checklist signing-form__list">
        <li v-for="stakeholder in stakeholders" :key="stakeholder.id">
          <label :class="{ 'signing-form__disabled': !withEmail(stakeholder) }">
            <input v-model="form.signerIds" class="form-check-input mt-0" type="checkbox" :disabled="!withEmail(stakeholder)" :value="stakeholder.id" />
            <span class="signing-form__name">{{ stakeholder.name || stakeholder.email }}</span>
            <span class="signing-form__meta">{{ withEmail(stakeholder) ? stakeholder.email : 'No email address' }}</span>
          </label>
        </li>
      </ul>
      <p v-else class="rq-field__hint mb-0">This project has no stakeholders yet. Add them in Project settings, Stakeholders.</p>
    </fieldset>

    <div class="rq-field">
      <label :for="ids.title">Title</label>
      <input :id="ids.title" v-model="form.title" class="form-control" maxlength="240" required @input="titleTouched = true" />
    </div>

    <div class="rq-field">
      <label :for="ids.statement">What signers agree to</label>
      <textarea :id="ids.statement" v-model="form.statement" class="form-control" maxlength="4000" rows="3"></textarea>
    </div>

    <div class="rq-field">
      <label :for="ids.message">Message to signers (optional)</label>
      <textarea :id="ids.message" v-model="form.message" class="form-control" maxlength="4000" rows="2"></textarea>
    </div>

    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="saving" @click="emit('close')">Cancel</button>
      <button class="primary-button" type="submit" :disabled="saving || loading">{{ saving ? 'Sending…' : 'Send for signature' }}</button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.signing-form__choices { display: grid; gap: 0.5rem; }
.signing-form__choice { display: flex; align-items: flex-start; gap: 0.6rem; min-height: 2.75rem; padding: 0.5rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; cursor: pointer; }
.signing-form__choice input { flex: 0 0 auto; width: 1rem; height: 1rem; min-height: 0; margin-top: 0.2rem !important; }
.signing-form__choice > span { display: grid; gap: 0.1rem; }
.signing-form__hint { color: var(--muted); font-size: 0.8rem; }
.signing-form__list { max-height: 14rem; }
.signing-form__list label { min-height: 2.75rem; }
.signing-form__list input { flex: 0 0 auto; width: 1rem; height: 1rem; min-height: 0; }
.signing-form__name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.signing-form__meta { color: var(--muted); font-size: 0.75rem; overflow-wrap: anywhere; text-align: right; }
.signing-form__disabled { color: var(--muted); }
</style>
