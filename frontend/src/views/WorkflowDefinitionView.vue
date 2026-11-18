<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import '../components/workflows/workflows.css';
import WorkflowModelEditor from '../components/workflows/WorkflowModelEditor.vue';
import WorkflowStatePreview from '../components/workflows/WorkflowStatePreview.vue';
import { apiClient, authSession } from '../lib/auth/index.js';
import {
  ITEM_TYPE_LABELS,
  createWorkflowDraft,
  definitionPayload,
  normalizeWorkflowModel,
  validateWorkflowModel,
} from '../lib/workflows/workflow-model.js';
import { definitionDraftFromWorkflowTemplate, templateNeedsUpdate } from '../lib/workflows/workflow-templates.js';

// One workflow definition: read-only by default, with an explicit Edit that switches the
// screen to the structured editor. `/workflows/definitions/new` opens straight into the
// editor, optionally prefilled from a workflow template (`?fromTemplate=<id>`).
const route = useRoute();
const router = useRouter();
const token = computed(() => authSession.state.token);
const isNew = computed(() => route.name === 'workflow-definition-new');

const loading = ref(true);
const saving = ref(false);
const errorMessage = ref('');
const noticeMessage = ref('');
const canManage = ref(false);
const record = ref(null);
const model = ref(createWorkflowDraft());
const editing = ref(false);
const submitted = ref(false);
const sourceTemplate = ref(null);
const otherNames = ref([]);

const validation = computed(() => {
  const result = validateWorkflowModel(model.value);
  const name = model.value.name.trim().toLowerCase();
  if (name && otherNames.value.includes(name)) result.errors.unshift({ message: `A workflow named "${model.value.name.trim()}" already exists.`, target: 'name' });
  return { ...result, ok: result.errors.length === 0 };
});
const nameErrors = computed(() => validation.value.errors.filter((entry) => entry.target === 'name'));
const viewModel = computed(() => normalizeWorkflowModel(record.value ?? {}));
const title = computed(() => {
  if (isNew.value) return 'New workflow';
  return record.value?.name ?? 'Workflow';
});

async function loadNames(excludeId = '') {
  try {
    const workspace = await apiClient.getWorkflowWorkspace({ limit: 200 }, token.value);
    canManage.value = workspace.canManage;
    otherNames.value = workspace.workflows.filter((workflow) => workflow.id !== excludeId).map((workflow) => workflow.name.toLowerCase());
  } catch {
    otherNames.value = [];
  }
}

async function load() {
  loading.value = true;
  errorMessage.value = '';
  noticeMessage.value = route.query.notice === 'created' ? 'Workflow created.' : '';
  editing.value = false;
  submitted.value = false;
  sourceTemplate.value = null;
  try {
    if (isNew.value) {
      record.value = null;
      model.value = createWorkflowDraft();
      await loadNames();
      const templateId = String(route.query.fromTemplate ?? '');
      if (templateId) {
        const { templates } = await apiClient.listWorkflowTemplates({ kind: 'workflow' }, token.value);
        const template = templates.find((entry) => entry.id === templateId);
        if (!template) errorMessage.value = 'That workflow template no longer exists. Starting from a blank workflow.';
        else if (templateNeedsUpdate(template)) errorMessage.value = `"${template.name}" needs an update before it can be used. Starting from a blank workflow.`;
        else { sourceTemplate.value = template; model.value = definitionDraftFromWorkflowTemplate(template); }
      }
      editing.value = canManage.value;
    } else {
      const result = await apiClient.getWorkflowDefinition(route.params.workflowId, token.value);
      record.value = result.value;
      canManage.value = result.canManage;
    }
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load the workflow.';
  } finally {
    loading.value = false;
  }
}

async function startEdit() {
  model.value = normalizeWorkflowModel(record.value);
  submitted.value = false;
  noticeMessage.value = '';
  await loadNames(record.value.id);
  editing.value = true;
}

function cancelEdit() {
  if (isNew.value) { router.push({ name: 'workflows' }); return; }
  editing.value = false;
  errorMessage.value = '';
}

async function save() {
  submitted.value = true;
  if (!validation.value.ok || saving.value) return;
  saving.value = true;
  errorMessage.value = '';
  try {
    const payload = definitionPayload(model.value);
    if (isNew.value) {
      const result = await apiClient.createWorkflowDefinition(payload, token.value);
      await router.replace({ name: 'workflow-definition', params: { workflowId: result.value.id }, query: { notice: 'created' } });
    } else {
      const result = await apiClient.updateWorkflowDefinition(record.value.id, { ...payload, expectedVersion: record.value.version }, token.value);
      record.value = result.value;
      editing.value = false;
      noticeMessage.value = 'Workflow saved.';
    }
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to save the workflow.';
  } finally {
    saving.value = false;
  }
}

watch(() => route.fullPath, async () => {
  if (['workflow-definition', 'workflow-definition-new'].includes(route.name)) await load();
});

onMounted(load);
</script>

<template>
  <main class="wf-page" aria-labelledby="wf-definition-title">
    <header class="wf-header">
      <div class="wf-header__title">
        <RouterLink class="wf-back" :to="{ name: 'workflows' }"><i class="bi bi-arrow-left" aria-hidden="true"></i> Workflows</RouterLink>
        <h1 id="wf-definition-title">{{ editing && !isNew ? `Edit ${record?.name ?? 'workflow'}` : title }}</h1>
        <p v-if="sourceTemplate && isNew" class="wf-muted">Prefilled from the "{{ sourceTemplate.name }}" template. Review it, then save to create the workflow.</p>
      </div>
      <div v-if="!editing && record && canManage" class="wf-actions">
        <button class="btn btn-primary" type="button" @click="startEdit"><i class="bi bi-pencil" aria-hidden="true"></i> Edit workflow</button>
      </div>
    </header>

    <p v-if="noticeMessage" class="alert alert-success" role="status">{{ noticeMessage }}</p>
    <p v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</p>
    <p v-if="loading" class="wf-muted" role="status">Loading workflow…</p>

    <template v-else-if="editing">
      <form class="wf-stack" novalidate aria-label="Workflow definition" @submit.prevent="save">
        <section class="wf-section" aria-labelledby="wf-details-title">
          <h2 id="wf-details-title">Details</h2>
          <div class="wf-grid">
            <div class="wf-field">
              <label for="wf-name">Workflow name</label>
              <input id="wf-name" v-model="model.name" class="form-control" maxlength="240" required :aria-invalid="submitted && nameErrors.length > 0" />
              <p v-for="entry in submitted || model.name ? nameErrors : []" :key="entry.message" class="wf-error"><i class="bi bi-exclamation-circle" aria-hidden="true"></i> {{ entry.message }}</p>
            </div>
            <div class="wf-field">
              <label for="wf-status">Status</label>
              <select id="wf-status" v-model="model.status" class="form-select">
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          <div class="wf-field">
            <label for="wf-description">Description</label>
            <textarea id="wf-description" v-model="model.description" class="form-control" rows="2" maxlength="4000"></textarea>
          </div>
        </section>
        <WorkflowModelEditor :model="model" :validation="validation" />
        <p v-if="submitted && !validation.ok" class="wf-error" role="alert">Fix the problems listed above before saving.</p>
        <footer class="wf-footer">
          <button class="btn btn-outline-secondary" type="button" :disabled="saving" @click="cancelEdit">Cancel</button>
          <button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? 'Saving…' : isNew ? 'Create workflow' : 'Save workflow' }}</button>
        </footer>
      </form>
    </template>

    <template v-else-if="record">
      <div class="wf-stack">
        <section class="wf-section" aria-labelledby="wf-summary-title">
          <h2 id="wf-summary-title">Summary</h2>
          <dl class="wf-dl">
            <dt>Status</dt>
            <dd><span class="wf-badge"><i :class="record.status === 'active' ? 'bi bi-check-circle' : 'bi bi-pause-circle'" aria-hidden="true"></i> {{ record.status === 'active' ? 'Active' : 'Inactive' }}</span></dd>
            <dt>Item types</dt>
            <dd>{{ record.itemTypes.map((type) => ITEM_TYPE_LABELS[type] ?? type).join(', ') }}</dd>
            <dt>Description</dt>
            <dd>{{ record.description || 'No description' }}</dd>
            <dt>Version</dt>
            <dd>v{{ record.version }}</dd>
          </dl>
        </section>
        <WorkflowStatePreview :model="viewModel" />
      </div>
    </template>

    <p v-else-if="isNew && !canManage && !errorMessage" class="wf-muted">Only workspace admins and managers can create workflows.</p>
  </main>
</template>
