<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import '../components/workflows/workflows.css';
import ProjectTemplateEditor from '../components/workflows/ProjectTemplateEditor.vue';
import TemplatePayloadSummary from '../components/workflows/TemplatePayloadSummary.vue';
import WorkflowModelEditor from '../components/workflows/WorkflowModelEditor.vue';
import WorkItemTemplateEditor from '../components/workflows/WorkItemTemplateEditor.vue';
import { apiClient, authSession } from '../lib/auth/index.js';
import { ITEM_TYPE_LABELS, validateWorkflowModel } from '../lib/workflows/workflow-model.js';
import {
  TEMPLATE_KINDS,
  buildTemplatePayload,
  createPayloadDraft,
  templateKindLabel,
  templateNeedsUpdate,
  usableTemplates,
} from '../lib/workflows/workflow-templates.js';

// One template: read-only by default with an explicit Edit. Each kind has its own structured
// payload editor; templates saved in the old free-form format open with an empty draft and
// a notice listing what no longer matches.
const route = useRoute();
const router = useRouter();
const token = computed(() => authSession.state.token);
const isNew = computed(() => route.name === 'workflow-template-new');

const loading = ref(true);
const saving = ref(false);
const errorMessage = ref('');
const noticeMessage = ref('');
const canManage = ref(false);
const record = ref(null);
const templates = ref([]);
const workflows = ref([]);
const customFields = ref([]);
const editing = ref(false);
const submitted = ref(false);
const form = ref({ description: '', kind: 'project', name: '', status: 'active' });
const draft = ref(createPayloadDraft('project'));

const workflowTemplates = computed(() => usableTemplates(templates.value, 'workflow'));
const workflowValidation = computed(() => (form.value.kind === 'workflow'
  ? validateWorkflowModel(draft.value, { requireName: false })
  : { errors: [], ok: true, warnings: [] }));
const built = computed(() => buildTemplatePayload(form.value.kind, draft.value, { customFields: customFields.value }));
const formErrors = computed(() => {
  const errors = [];
  if (!form.value.name.trim()) errors.push('Enter a template name.');
  return [...errors, ...built.value.errors];
});
const legacyIssues = computed(() => (templateNeedsUpdate(record.value) ? record.value.payloadIssues ?? [] : []));

async function load() {
  loading.value = true;
  errorMessage.value = '';
  noticeMessage.value = route.query.notice === 'created' ? 'Template created.' : '';
  editing.value = false;
  submitted.value = false;
  try {
    const [workspace, list] = await Promise.all([
      apiClient.getWorkflowWorkspace({ limit: 200 }, token.value),
      apiClient.listWorkflowTemplates({}, token.value),
    ]);
    canManage.value = workspace.canManage;
    workflows.value = workspace.workflows;
    customFields.value = workspace.customFields;
    templates.value = list.templates;
    if (isNew.value) {
      record.value = null;
      const kind = TEMPLATE_KINDS.some((entry) => entry.value === route.query.kind) ? route.query.kind : 'project';
      form.value = { description: '', kind, name: '', status: 'active' };
      draft.value = createPayloadDraft(kind);
      editing.value = canManage.value;
    } else {
      record.value = templates.value.find((template) => template.id === route.params.templateId) ?? null;
      if (!record.value) errorMessage.value = 'Template not found.';
    }
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load the template.';
  } finally {
    loading.value = false;
  }
}

function startEdit() {
  const current = record.value;
  form.value = { description: current.description ?? '', kind: current.kind, name: current.name, status: current.status };
  draft.value = createPayloadDraft(current.kind, templateNeedsUpdate(current) ? null : current.payload);
  submitted.value = false;
  noticeMessage.value = '';
  editing.value = true;
}

function changeKind(kind) {
  form.value.kind = kind;
  draft.value = createPayloadDraft(kind);
}

function cancelEdit() {
  if (isNew.value) { router.push({ name: 'workflows', query: { tab: 'templates' } }); return; }
  editing.value = false;
  errorMessage.value = '';
}

async function save() {
  submitted.value = true;
  if (formErrors.value.length || saving.value) return;
  saving.value = true;
  errorMessage.value = '';
  const body = { description: form.value.description.trim(), name: form.value.name.trim(), payload: built.value.payload, status: form.value.status };
  try {
    if (isNew.value) {
      const result = await apiClient.createProjectTemplate({ ...body, kind: form.value.kind }, token.value);
      await router.replace({ name: 'workflow-template', params: { templateId: result.value.id }, query: { notice: 'created' } });
    } else {
      const result = await apiClient.updateProjectTemplate(record.value.id, { ...body, expectedVersion: record.value.version }, token.value);
      record.value = result.value;
      templates.value = templates.value.map((template) => (template.id === result.value.id ? result.value : template));
      editing.value = false;
      noticeMessage.value = 'Template saved.';
    }
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to save the template.';
  } finally {
    saving.value = false;
  }
}

watch(() => route.fullPath, async () => {
  if (['workflow-template', 'workflow-template-new'].includes(route.name)) await load();
});

onMounted(load);
</script>

<template>
  <main class="wf-page" aria-labelledby="wf-template-title">
    <header class="wf-header">
      <div class="wf-header__title">
        <RouterLink class="wf-back" :to="{ name: 'workflows', query: { tab: 'templates' } }"><i class="bi bi-arrow-left" aria-hidden="true"></i> Templates</RouterLink>
        <h1 id="wf-template-title">{{ isNew ? `New ${templateKindLabel(form.kind).toLowerCase()} template` : editing ? `Edit ${record?.name ?? 'template'}` : record?.name ?? 'Template' }}</h1>
        <p v-if="record && !editing" class="wf-muted">{{ templateKindLabel(record.kind) }} template · {{ record.status === 'active' ? 'Active' : 'Inactive' }} · v{{ record.version }}</p>
      </div>
      <div v-if="record && !editing" class="wf-actions">
        <RouterLink v-if="record.kind === 'workflow' && !legacyIssues.length && canManage" class="btn btn-outline-primary" :to="{ name: 'workflow-definition-new', query: { fromTemplate: record.id } }"><i class="bi bi-diagram-3" aria-hidden="true"></i> Create workflow from template</RouterLink>
        <RouterLink v-if="record.kind === 'project' && !legacyIssues.length && record.status === 'active'" class="btn btn-outline-primary" :to="{ name: 'projects', query: { new: 'project', template: record.id } }"><i class="bi bi-folder-plus" aria-hidden="true"></i> Create project from template</RouterLink>
        <button v-if="canManage" class="btn btn-primary" type="button" @click="startEdit"><i class="bi bi-pencil" aria-hidden="true"></i> Edit template</button>
      </div>
    </header>

    <p v-if="noticeMessage" class="alert alert-success" role="status">{{ noticeMessage }}</p>
    <p v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</p>
    <div v-if="legacyIssues.length" class="alert alert-warning" role="status" data-testid="template-legacy-notice">
      <strong><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> This template needs an update.</strong>
      It was saved in an older format and can't be used until it's edited and saved again{{ editing ? '. The editor below starts empty' : '' }}.
      <ul class="mb-0 mt-1">
        <li v-for="issue in legacyIssues" :key="issue">{{ issue }}</li>
      </ul>
    </div>
    <p v-if="loading" class="wf-muted" role="status">Loading template…</p>

    <form v-else-if="editing" class="wf-stack" novalidate aria-label="Template" @submit.prevent="save">
      <section class="wf-section" aria-labelledby="tpl-details-title">
        <h2 id="tpl-details-title">Details</h2>
        <div class="wf-grid">
          <div class="wf-field">
            <label for="tpl-name">Template name</label>
            <input id="tpl-name" v-model="form.name" class="form-control" maxlength="240" required />
          </div>
          <div class="wf-field">
            <label for="tpl-kind">Template kind</label>
            <select id="tpl-kind" class="form-select" :value="form.kind" :disabled="!isNew" aria-describedby="tpl-kind-hint" @change="changeKind($event.target.value)">
              <option v-for="kind in TEMPLATE_KINDS" :key="kind.value" :value="kind.value">{{ kind.label }}</option>
            </select>
            <span id="tpl-kind-hint" class="wf-hint">{{ TEMPLATE_KINDS.find((kind) => kind.value === form.kind)?.description }}</span>
          </div>
          <div class="wf-field">
            <label for="tpl-status">Status</label>
            <select id="tpl-status" v-model="form.status" class="form-select">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
        <div class="wf-field">
          <label for="tpl-description">Description</label>
          <textarea id="tpl-description" v-model="form.description" class="form-control" rows="2" maxlength="4000"></textarea>
        </div>
      </section>

      <WorkflowModelEditor v-if="form.kind === 'workflow'" :model="draft" :validation="workflowValidation" />
      <ProjectTemplateEditor v-else-if="form.kind === 'project'" :draft="draft" :workflow-templates="workflowTemplates" :workflows="workflows" />
      <WorkItemTemplateEditor v-else :custom-fields="customFields" :draft="draft" />

      <ul v-if="submitted && formErrors.length" class="wf-messages wf-messages--errors" role="alert" aria-label="Problems to fix before saving">
        <li v-for="message in formErrors" :key="message"><i class="bi bi-x-circle" aria-hidden="true"></i> {{ message }}</li>
      </ul>
      <footer class="wf-footer">
        <button class="btn btn-outline-secondary" type="button" :disabled="saving" @click="cancelEdit">Cancel</button>
        <button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? 'Saving…' : isNew ? 'Create template' : 'Save template' }}</button>
      </footer>
    </form>

    <div v-else-if="record" class="wf-stack">
      <p v-if="record.description">{{ record.description }}</p>
      <p v-if="record.kind === 'work_item' && !legacyIssues.length" class="wf-muted">
        Offered when someone creates a {{ (ITEM_TYPE_LABELS[record.payload?.itemType] ?? 'work item').toLowerCase() }} in the plan, on the board or in tickets.
      </p>
      <TemplatePayloadSummary v-if="!legacyIssues.length" :custom-fields="customFields" :template="record" :templates="templates" :workflows="workflows" />
    </div>

    <p v-else-if="isNew && !canManage && !errorMessage" class="wf-muted">Only workspace admins and managers can create templates.</p>
  </main>
</template>
