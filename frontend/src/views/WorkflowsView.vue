<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, toRaw, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import '../components/workflows/workflows.css';
import RequirementsConfirmDialog from '../components/requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../components/requirements/RequirementsDialog.vue';
import { apiClient, authSession } from '../lib/auth/index.js';
import { useWorkspaceLiveRefresh } from '../lib/live/live-refresh.js';
import { ITEM_TYPE_LABELS, WORKFLOW_ITEM_TYPES } from '../lib/workflows/workflow-model.js';
import { TEMPLATE_KINDS, templateKindLabel, templateNeedsUpdate } from '../lib/workflows/workflow-templates.js';

// The workflow workspace: browse definitions and templates (each opens its own screen) and
// manage the project-scoped records (bindings, approvals, baselines, custom-field values)
// through one dialog at a time.
const TABS = [
  { key: 'definitions', label: 'Definitions' },
  { key: 'templates', label: 'Templates' },
  { key: 'bindings', label: 'Bindings' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'baselines', label: 'Baselines' },
  { key: 'fields', label: 'Custom fields' },
  { key: 'history', label: 'History' },
];
const DIALOG_TITLES = { approval: 'Request approval', baseline: 'Capture baseline', binding: 'Bind workflow', decision: 'Decide approval', field: 'Custom field', value: 'Set custom-field value' };

const route = useRoute();
const router = useRouter();
const emptyWorkspace = () => ({ approvals: [], baselines: [], bindings: [], canManage: false, customFields: [], customValues: [], histories: [], projects: [], templates: [], total: 0, workflows: [] });
const workspace = ref(emptyWorkspace());
const loading = ref(true);
const errorMessage = ref('');
const activeTab = ref(TABS.some((tab) => tab.key === route.query.tab) ? route.query.tab : 'definitions');
const filters = reactive({ limit: 25, offset: 0, projectId: '', query: '', status: '' });
const templateFilters = reactive({ kind: '', query: '' });
const editor = reactive({ busy: false, error: '', kind: '', mode: 'create', open: false, recordId: '', values: {} });
const deleteTarget = reactive({ busy: false, error: '', id: '', kind: '', open: false, title: '', version: 0 });
const token = computed(() => authSession.state.token);
let searchTimer = null;

const projectMap = computed(() => new Map(workspace.value.projects.map((item) => [item.id, item])));
const workflowMap = computed(() => new Map(workspace.value.workflows.map((item) => [item.id, item])));
const fieldMap = computed(() => new Map(workspace.value.customFields.map((item) => [item.id, item])));
const pages = computed(() => Math.max(1, Math.ceil(workspace.value.total / filters.limit)));
const page = computed(() => Math.floor(filters.offset / filters.limit) + 1);
const pendingApprovals = computed(() => workspace.value.approvals.filter((item) => item.status === 'pending').length);
const overdueSlas = computed(() => {
  const latest = new Map();
  for (const history of workspace.value.histories) {
    const key = `${history.projectId}:${history.itemType}:${history.itemId}`;
    const current = latest.get(key);
    if (!current || `${history.occurredAt}:${history.id}` > `${current.occurredAt}:${current.id}`) latest.set(key, history);
  }
  return [...latest.values()].filter((item) => item.slaDueAt && Date.parse(item.slaDueAt) < Date.now()).length;
});
const visibleTemplates = computed(() => {
  const query = templateFilters.query.trim().toLowerCase();
  return workspace.value.templates
    .filter((template) => (!templateFilters.kind || template.kind === templateFilters.kind)
      && (!query || `${template.name} ${template.description}`.toLowerCase().includes(query)))
    .sort((left, right) => left.name.localeCompare(right.name));
});
const editorField = computed(() => fieldMap.value.get(editor.values.fieldId) ?? null);
const bindingWorkflows = computed(() => workspace.value.workflows.filter((item) => item.status === 'active' && item.itemTypes.includes(editor.values.itemType)));

// `quiet` reloads after someone else's change: the page stays as it is while it loads, and on
// failure. The latest load wins, so a reload never overwrites newer filters.
let loadSequence = 0;
async function loadWorkspace({ quiet = false } = {}) {
  const sequence = ++loadSequence;
  if (!quiet) {
    loading.value = true;
    errorMessage.value = '';
  }
  try {
    const result = await (quiet ? apiClient.passive : apiClient).getWorkflowWorkspace(filters, token.value);
    if (sequence === loadSequence) workspace.value = result;
  } catch (error) {
    if (!quiet && sequence === loadSequence) errorMessage.value = error.message ?? 'Unable to load the workflow workspace.';
  } finally {
    if (!quiet && sequence === loadSequence) loading.value = false;
  }
}

function selectTab(key) {
  activeTab.value = key;
  router.replace({ query: { ...route.query, tab: key } });
}

function applyFilters() {
  filters.offset = 0;
  loadWorkspace();
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilters, 300);
}

function changePage(delta) {
  filters.offset = Math.max(0, Math.min((pages.value - 1) * filters.limit, filters.offset + delta * filters.limit));
  loadWorkspace();
}

function defaultProjectId() {
  return filters.projectId || workspace.value.projects[0]?.id || '';
}

function initialValues(kind) {
  if (kind === 'binding') return { itemType: 'project', projectId: defaultProjectId(), workflowId: '' };
  if (kind === 'approval') return { expiresAt: '', fromState: '', itemId: filters.projectId || '', itemType: 'project', note: '', projectId: defaultProjectId(), toState: '', transitionKey: '' };
  if (kind === 'baseline') return { name: '', note: '', projectId: defaultProjectId() };
  if (kind === 'field') return { description: '', fieldType: 'string', name: '', optionsText: '', required: false, scope: 'story', status: 'active' };
  if (kind === 'value') return { fieldId: '', itemId: '', itemType: 'story', projectId: defaultProjectId(), valueText: '' };
  return { decisionNote: '', status: 'approved' };
}

function openEditor(kind, record = null) {
  Object.assign(editor, { busy: false, error: '', kind, mode: record && kind !== 'decision' ? 'edit' : 'create', open: true, recordId: record?.id ?? '' });
  const values = record && kind !== 'decision' ? structuredClone(toRaw(record)) : initialValues(kind);
  if (kind === 'field' && record) values.optionsText = (record.options ?? []).join(', ');
  if (kind === 'decision') values.expectedVersion = record.version;
  editor.values = values;
}

function closeEditor() {
  if (!editor.busy) editor.open = false;
}

function payload() {
  const values = { ...editor.values };
  for (const key of ['createdAt', 'updatedAt', 'tenantId', 'id', 'version', 'capturedAt', 'createdBy']) delete values[key];
  if (editor.mode === 'edit') values.expectedVersion = editor.values.version;
  if (editor.kind === 'field') {
    values.options = values.fieldType === 'enum' ? values.optionsText.split(',').map((value) => value.trim()).filter(Boolean) : [];
    delete values.optionsText;
    if (editor.mode === 'edit') { delete values.fieldType; delete values.scope; }
  }
  if (editor.kind === 'approval') values.expiresAt = values.expiresAt ? new Date(values.expiresAt).toISOString() : null;
  if (editor.kind === 'value') {
    const type = editorField.value?.fieldType;
    values.value = type === 'number' ? Number(values.valueText) : type === 'boolean' ? values.valueText === 'true' : values.valueText;
    const existing = workspace.value.customValues.find((item) => item.projectId === values.projectId && item.itemId === values.itemId && item.fieldId === values.fieldId);
    values.expectedVersion = existing?.version ?? null;
    delete values.valueText;
  }
  return values;
}

async function saveEditor() {
  if (editor.busy) return;
  editor.busy = true;
  editor.error = '';
  try {
    const values = payload();
    const id = editor.recordId;
    const edit = editor.mode === 'edit';
    if (editor.kind === 'binding') edit ? await apiClient.updateWorkflowBinding(id, values, token.value) : await apiClient.createWorkflowBinding(values, token.value);
    if (editor.kind === 'approval') await apiClient.requestWorkflowApproval(values, token.value);
    if (editor.kind === 'decision') await apiClient.decideWorkflowApproval(id, values, token.value);
    if (editor.kind === 'baseline') await apiClient.createProjectBaseline(values, token.value);
    if (editor.kind === 'field') edit ? await apiClient.updateCustomFieldDefinition(id, values, token.value) : await apiClient.createCustomFieldDefinition(values, token.value);
    if (editor.kind === 'value') await apiClient.writeCustomFieldValue(values, token.value);
    editor.busy = false;
    editor.open = false;
    await loadWorkspace();
  } catch (error) {
    editor.error = error.message ?? 'Unable to save the workflow record.';
    editor.busy = false;
  }
}

function openDelete(kind, record, title) {
  Object.assign(deleteTarget, { busy: false, error: '', id: record.id, kind, open: true, title, version: record.version });
}

async function confirmDelete() {
  deleteTarget.busy = true;
  try {
    const { id, kind, version } = deleteTarget;
    if (kind === 'workflow') await apiClient.deleteWorkflowDefinition(id, version, token.value);
    if (kind === 'binding') await apiClient.deleteWorkflowBinding(id, version, token.value);
    if (kind === 'template') await apiClient.deleteProjectTemplate(id, version, token.value);
    if (kind === 'custom field') await apiClient.deleteCustomFieldDefinition(id, version, token.value);
    if (kind === 'custom-field value') await apiClient.deleteCustomFieldValue(id, version, token.value);
    deleteTarget.open = false;
    await loadWorkspace();
  } catch (error) {
    deleteTarget.error = error.message ?? 'Unable to delete the record.';
  } finally {
    deleteTarget.busy = false;
  }
}

function dateTime(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}

function itemTypes(list) {
  return list.map((type) => ITEM_TYPE_LABELS[type] ?? type).join(', ');
}

watch(() => route.query.tab, (tab) => {
  if (TABS.some((entry) => entry.key === tab)) activeTab.value = tab;
});
onMounted(() => loadWorkspace());
// Approvals, custom fields and workflows changed elsewhere, by people, the assistant or MCP clients.
useWorkspaceLiveRefresh(['workflows'], () => {
  if (!loading.value) loadWorkspace({ quiet: true });
});
onBeforeUnmount(() => clearTimeout(searchTimer));
</script>

<template>
  <main class="wf-page workflow-page" aria-labelledby="workflows-title">
    <header class="wf-header">
      <div class="wf-header__title">
        <h1 id="workflows-title">Workflow governance</h1>
        <p class="wf-muted">Lifecycle states, approvals, SLAs, baselines, templates and custom data.</p>
      </div>
      <div class="wf-actions">
        <RouterLink v-if="workspace.canManage" class="btn btn-primary" :to="{ name: 'workflow-definition-new' }"><i class="bi bi-plus-lg" aria-hidden="true"></i> New workflow</RouterLink>
        <button class="btn btn-outline-secondary" type="button" @click="loadWorkspace()"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Refresh</button>
      </div>
    </header>
    <p v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</p>

    <section class="workflow-metrics" aria-label="Workflow summary">
      <div><span>Active workflows</span><strong>{{ workspace.workflows.filter((item) => item.status === 'active').length }}</strong></div>
      <div><span>Project bindings</span><strong>{{ workspace.bindings.length }}</strong></div>
      <div><span>Pending approvals</span><strong>{{ pendingApprovals }}</strong></div>
      <div><span>Past SLA deadlines</span><strong>{{ overdueSlas }}</strong></div>
    </section>

    <div class="workflow-filters" role="search" aria-label="Filter workflows">
      <div class="wf-field workflow-filters__search">
        <label for="wf-filter-query">Search workflows</label>
        <input id="wf-filter-query" v-model="filters.query" class="form-control" type="search" placeholder="Name or description" @input="scheduleSearch" />
      </div>
      <div class="wf-field">
        <label for="wf-filter-project">Project</label>
        <select id="wf-filter-project" v-model="filters.projectId" class="form-select" @change="applyFilters">
          <option value="">All visible projects</option>
          <option v-for="project in workspace.projects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </div>
      <div class="wf-field">
        <label for="wf-filter-status">Status</label>
        <select id="wf-filter-status" v-model="filters.status" class="form-select" @change="applyFilters">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>
    </div>

    <nav class="workflow-tabs" aria-label="Workflow workspace sections">
      <button v-for="tab in TABS" :key="tab.key" :class="{ active: activeTab === tab.key }" :aria-current="activeTab === tab.key ? 'page' : undefined" type="button" @click="selectTab(tab.key)">{{ tab.label }}</button>
    </nav>

    <p v-if="loading" class="wf-muted workflow-empty" role="status">Loading workflow workspace…</p>
    <template v-else>
      <section v-if="activeTab === 'definitions'" class="wf-stack" aria-labelledby="definitions-title">
        <div class="wf-section__head"><h2 id="definitions-title">Lifecycle definitions</h2><span class="wf-muted">{{ workspace.total }} total</span></div>
        <div class="wf-table-wrap" tabindex="0" role="region" aria-label="Lifecycle definitions table">
          <table class="wf-table">
            <thead><tr><th scope="col">Workflow</th><th scope="col">Item types</th><th scope="col">Shape</th><th scope="col">Status</th><th v-if="workspace.canManage" scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              <tr v-for="item in workspace.workflows" :key="item.id">
                <td><RouterLink :to="{ name: 'workflow-definition', params: { workflowId: item.id } }">{{ item.name }}</RouterLink><small class="d-block wf-muted">{{ item.description || 'No description' }}</small></td>
                <td>{{ itemTypes(item.itemTypes) }}</td>
                <td>{{ item.states.length }} states · {{ item.transitions.length }} transitions · v{{ item.version }}</td>
                <td><span class="wf-badge">{{ item.status === 'active' ? 'Active' : 'Inactive' }}</span></td>
                <td v-if="workspace.canManage"><button class="wf-icon-button wf-icon-button--danger" type="button" :aria-label="`Delete workflow ${item.name}`" @click="openDelete('workflow', item, item.name)"><i class="bi bi-trash3" aria-hidden="true"></i></button></td>
              </tr>
              <tr v-if="!workspace.workflows.length"><td :colspan="workspace.canManage ? 5 : 4" class="workflow-empty">No workflow definitions match the filters.</td></tr>
            </tbody>
          </table>
        </div>
        <footer class="workflow-pagination"><button class="btn btn-sm btn-outline-secondary" :disabled="page === 1" type="button" @click="changePage(-1)">Previous</button><span>Page {{ page }} of {{ pages }}</span><button class="btn btn-sm btn-outline-secondary" :disabled="page === pages" type="button" @click="changePage(1)">Next</button></footer>
      </section>

      <section v-if="activeTab === 'templates'" class="wf-stack" aria-labelledby="templates-title">
        <div class="wf-section__head">
          <h2 id="templates-title">Reusable templates</h2>
          <RouterLink v-if="workspace.canManage" class="btn btn-sm btn-outline-secondary" :to="{ name: 'workflow-template-new', query: { kind: templateFilters.kind || 'project' } }"><i class="bi bi-plus-lg" aria-hidden="true"></i> New template</RouterLink>
        </div>
        <div class="workflow-filters workflow-filters--inline">
          <div class="wf-field workflow-filters__search">
            <label for="wf-template-query">Search templates</label>
            <input id="wf-template-query" v-model="templateFilters.query" class="form-control" type="search" placeholder="Name or description" />
          </div>
          <div class="wf-field">
            <label for="wf-template-kind">Kind</label>
            <select id="wf-template-kind" v-model="templateFilters.kind" class="form-select">
              <option value="">All kinds</option>
              <option v-for="kind in TEMPLATE_KINDS" :key="kind.value" :value="kind.value">{{ kind.label }}</option>
            </select>
          </div>
        </div>
        <div class="wf-table-wrap" tabindex="0" role="region" aria-label="Templates table">
          <table class="wf-table">
            <thead><tr><th scope="col">Template</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              <tr v-for="item in visibleTemplates" :key="item.id" data-testid="template-row">
                <td><RouterLink :to="{ name: 'workflow-template', params: { templateId: item.id } }">{{ item.name }}</RouterLink><small class="d-block wf-muted">{{ item.description || 'No description' }}</small></td>
                <td>{{ templateKindLabel(item.kind) }}<span v-if="item.kind === 'work_item' && !templateNeedsUpdate(item)" class="wf-muted"> · {{ ITEM_TYPE_LABELS[item.payload?.itemType] }}</span></td>
                <td>
                  <span v-if="templateNeedsUpdate(item)" class="wf-badge wf-badge--warning"><i class="bi bi-exclamation-triangle" aria-hidden="true"></i> Needs update</span>
                  <span v-else class="wf-badge">{{ item.status === 'active' ? 'Active' : 'Inactive' }}</span>
                </td>
                <td>
                  <div class="wf-actions workflow-row-actions">
                    <RouterLink v-if="item.kind === 'workflow' && workspace.canManage && !templateNeedsUpdate(item)" class="btn btn-sm btn-outline-primary" :to="{ name: 'workflow-definition-new', query: { fromTemplate: item.id } }">Use template</RouterLink>
                    <RouterLink v-if="item.kind === 'project' && item.status === 'active' && !templateNeedsUpdate(item)" class="btn btn-sm btn-outline-primary" :to="{ name: 'projects', query: { new: 'project', template: item.id } }">Use template</RouterLink>
                    <button v-if="workspace.canManage" class="wf-icon-button wf-icon-button--danger" type="button" :aria-label="`Delete template ${item.name}`" @click="openDelete('template', item, item.name)"><i class="bi bi-trash3" aria-hidden="true"></i></button>
                  </div>
                </td>
              </tr>
              <tr v-if="!visibleTemplates.length"><td colspan="4" class="workflow-empty">No templates match.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="activeTab === 'bindings'" class="wf-stack" aria-labelledby="bindings-title">
        <div class="wf-section__head"><h2 id="bindings-title">Project bindings</h2><button class="btn btn-sm btn-outline-secondary" type="button" @click="openEditor('binding')"><i class="bi bi-link-45deg" aria-hidden="true"></i> Bind workflow</button></div>
        <div class="wf-table-wrap" tabindex="0" role="region" aria-label="Project bindings table">
          <table class="wf-table">
            <thead><tr><th scope="col">Project</th><th scope="col">Item type</th><th scope="col">Workflow</th><th scope="col">Version</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              <tr v-for="item in workspace.bindings" :key="item.id">
                <td>{{ projectMap.get(item.projectId)?.name ?? item.projectId }}</td>
                <td>{{ ITEM_TYPE_LABELS[item.itemType] ?? item.itemType }}</td>
                <td>{{ workflowMap.get(item.workflowId)?.name ?? item.workflowId }}</td>
                <td>{{ item.version }}</td>
                <td><div class="wf-row__tools"><button class="wf-icon-button" type="button" :aria-label="`Edit ${item.itemType} binding`" @click="openEditor('binding', item)"><i class="bi bi-pencil" aria-hidden="true"></i></button><button class="wf-icon-button wf-icon-button--danger" type="button" :aria-label="`Delete ${item.itemType} binding`" @click="openDelete('binding', item, `${ITEM_TYPE_LABELS[item.itemType] ?? item.itemType} binding`)"><i class="bi bi-trash3" aria-hidden="true"></i></button></div></td>
              </tr>
              <tr v-if="!workspace.bindings.length"><td colspan="5" class="workflow-empty">No project workflow bindings.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="activeTab === 'approvals'" class="wf-stack" aria-labelledby="approvals-title">
        <div class="wf-section__head"><h2 id="approvals-title">Transition approvals</h2><button class="btn btn-sm btn-outline-secondary" type="button" @click="openEditor('approval')">Request approval</button></div>
        <div class="wf-table-wrap" tabindex="0" role="region" aria-label="Transition approvals table">
          <table class="wf-table">
            <thead><tr><th scope="col">Project / item</th><th scope="col">Transition</th><th scope="col">Requester</th><th scope="col">Expires</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              <tr v-for="item in workspace.approvals" :key="item.id">
                <td>{{ projectMap.get(item.projectId)?.name ?? item.projectId }}<small class="d-block wf-muted">{{ item.itemType }} · {{ item.itemId }}</small></td>
                <td>{{ item.fromState }} → {{ item.toState }}<small class="d-block wf-muted">{{ item.transitionKey }}</small></td>
                <td>{{ item.requestedBy }}</td>
                <td>{{ dateTime(item.expiresAt) }}</td>
                <td>{{ item.status }}</td>
                <td><button v-if="item.status === 'pending'" class="btn btn-sm btn-outline-primary" type="button" @click="openEditor('decision', item)">Decide</button><span v-else>—</span></td>
              </tr>
              <tr v-if="!workspace.approvals.length"><td colspan="6" class="workflow-empty">No transition approvals.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="activeTab === 'baselines'" class="wf-stack" aria-labelledby="baselines-title">
        <div class="wf-section__head"><h2 id="baselines-title">Immutable project baselines</h2><button class="btn btn-sm btn-outline-secondary" type="button" @click="openEditor('baseline')">Capture baseline</button></div>
        <div class="wf-table-wrap" tabindex="0" role="region" aria-label="Project baselines table">
          <table class="wf-table">
            <thead><tr><th scope="col">Baseline</th><th scope="col">Project</th><th scope="col">Captured</th><th scope="col">By</th></tr></thead>
            <tbody>
              <tr v-for="item in workspace.baselines" :key="item.id"><td><span>{{ item.name }}</span><small class="d-block wf-muted">{{ item.note || 'No note' }}</small></td><td>{{ projectMap.get(item.projectId)?.name ?? item.projectId }}</td><td>{{ dateTime(item.capturedAt) }}</td><td>{{ item.createdBy }}</td></tr>
              <tr v-if="!workspace.baselines.length"><td colspan="4" class="workflow-empty">No project baselines.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="activeTab === 'fields'" class="wf-stack" aria-labelledby="fields-title">
        <div class="wf-section__head"><h2 id="fields-title">Custom fields &amp; values</h2><div class="wf-actions"><button v-if="workspace.canManage" class="btn btn-sm btn-outline-secondary" type="button" @click="openEditor('field')">Add field</button><button class="btn btn-sm btn-outline-secondary" type="button" @click="openEditor('value')">Set value</button></div></div>
        <div class="wf-table-wrap" tabindex="0" role="region" aria-label="Custom fields table">
          <table class="wf-table">
            <thead><tr><th scope="col">Name</th><th scope="col">Item type</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Status</th><th v-if="workspace.canManage" scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              <tr v-for="item in workspace.customFields" :key="item.id"><td>{{ item.name }}</td><td>{{ ITEM_TYPE_LABELS[item.scope] ?? item.scope }}</td><td>{{ item.fieldType }}</td><td>{{ item.required ? 'Yes' : 'No' }}</td><td>{{ item.status }}</td>
                <td v-if="workspace.canManage"><div class="wf-row__tools"><button class="wf-icon-button" type="button" :aria-label="`Edit custom field ${item.name}`" @click="openEditor('field', item)"><i class="bi bi-pencil" aria-hidden="true"></i></button><button class="wf-icon-button wf-icon-button--danger" type="button" :aria-label="`Delete custom field ${item.name}`" @click="openDelete('custom field', item, item.name)"><i class="bi bi-trash3" aria-hidden="true"></i></button></div></td></tr>
              <tr v-if="!workspace.customFields.length"><td :colspan="workspace.canManage ? 6 : 5" class="workflow-empty">No custom fields.</td></tr>
            </tbody>
          </table>
        </div>
        <h3>Values</h3>
        <div class="wf-table-wrap" tabindex="0" role="region" aria-label="Custom-field values table">
          <table class="wf-table">
            <thead><tr><th scope="col">Field</th><th scope="col">Item</th><th scope="col">Value</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              <tr v-for="item in workspace.customValues" :key="item.id"><td>{{ fieldMap.get(item.fieldId)?.name ?? item.fieldId }}</td><td>{{ item.itemType }} · {{ item.itemId }}</td><td>{{ item.value }}</td><td><button class="wf-icon-button wf-icon-button--danger" type="button" :aria-label="`Delete value for ${item.itemId}`" @click="openDelete('custom-field value', item, item.itemId)"><i class="bi bi-trash3" aria-hidden="true"></i></button></td></tr>
              <tr v-if="!workspace.customValues.length"><td colspan="4" class="workflow-empty">No custom-field values.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="activeTab === 'history'" class="wf-stack" aria-labelledby="history-title">
        <h2 id="history-title">Immutable transition history</h2>
        <div class="wf-table-wrap" tabindex="0" role="region" aria-label="Transition history table">
          <table class="wf-table">
            <thead><tr><th scope="col">Occurred</th><th scope="col">Project / item</th><th scope="col">Transition</th><th scope="col">Actor</th><th scope="col">SLA deadline</th><th scope="col">Automation</th></tr></thead>
            <tbody>
              <tr v-for="item in workspace.histories" :key="item.id"><td>{{ dateTime(item.occurredAt) }}</td><td>{{ projectMap.get(item.projectId)?.name ?? item.projectId }}<small class="d-block wf-muted">{{ item.itemType }} · {{ item.itemId }}</small></td><td>{{ item.fromState }} → {{ item.toState }}<small class="d-block wf-muted">{{ item.transitionKey }}</small></td><td>{{ item.userId }}</td><td>{{ dateTime(item.slaDueAt) }}</td><td><span v-if="item.slaEventEnqueuedAt">SLA escalation dispatched</span><span v-else-if="item.transitionEventEnqueuedAt">Transition event dispatched</span><span v-else>Pending event</span></td></tr>
              <tr v-if="!workspace.histories.length"><td colspan="6" class="workflow-empty">No recorded transitions.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <RequirementsDialog :busy="editor.busy" :open="editor.open" :title="editor.mode === 'edit' ? `Edit ${DIALOG_TITLES[editor.kind]?.toLowerCase() ?? 'record'}` : DIALOG_TITLES[editor.kind] ?? 'Workflow record'" @close="closeEditor" @submit="saveEditor">
      <div class="wf-stack wf-dialog-body">
        <template v-if="editor.kind === 'binding'">
          <div class="wf-field"><label for="dlg-binding-project">Project</label><select id="dlg-binding-project" v-model="editor.values.projectId" class="form-select" required><option v-for="item in workspace.projects" :key="item.id" :value="item.id">{{ item.name }}</option></select></div>
          <div class="wf-field"><label for="dlg-binding-type">Item type</label><select id="dlg-binding-type" v-model="editor.values.itemType" class="form-select" @change="editor.values.workflowId = ''"><option v-for="type in WORKFLOW_ITEM_TYPES" :key="type" :value="type">{{ ITEM_TYPE_LABELS[type] }}</option></select></div>
          <div class="wf-field"><label for="dlg-binding-workflow">Workflow</label><select id="dlg-binding-workflow" v-model="editor.values.workflowId" class="form-select" required><option value="" disabled>Choose a workflow</option><option v-for="item in bindingWorkflows" :key="item.id" :value="item.id">{{ item.name }}</option></select><span v-if="!bindingWorkflows.length" class="wf-hint">No active workflow supports {{ ITEM_TYPE_LABELS[editor.values.itemType]?.toLowerCase() }} items.</span></div>
        </template>
        <template v-if="editor.kind === 'approval'">
          <div class="wf-field"><label for="dlg-approval-project">Project</label><select id="dlg-approval-project" v-model="editor.values.projectId" class="form-select" required><option v-for="item in workspace.projects" :key="item.id" :value="item.id">{{ item.name }}</option></select></div>
          <div class="wf-grid">
            <div class="wf-field"><label for="dlg-approval-type">Item type</label><select id="dlg-approval-type" v-model="editor.values.itemType" class="form-select"><option v-for="type in WORKFLOW_ITEM_TYPES" :key="type" :value="type">{{ ITEM_TYPE_LABELS[type] }}</option></select></div>
            <div class="wf-field"><label for="dlg-approval-item">Item ID</label><input id="dlg-approval-item" v-model="editor.values.itemId" class="form-control" required /></div>
            <div class="wf-field"><label for="dlg-approval-from">From state</label><input id="dlg-approval-from" v-model="editor.values.fromState" class="form-control" required /></div>
            <div class="wf-field"><label for="dlg-approval-to">To state</label><input id="dlg-approval-to" v-model="editor.values.toState" class="form-control" required /></div>
            <div class="wf-field"><label for="dlg-approval-key">Transition key</label><input id="dlg-approval-key" v-model="editor.values.transitionKey" class="form-control" required /></div>
            <div class="wf-field"><label for="dlg-approval-expires">Expires</label><input id="dlg-approval-expires" v-model="editor.values.expiresAt" class="form-control" type="datetime-local" /></div>
          </div>
          <div class="wf-field"><label for="dlg-approval-note">Request note</label><textarea id="dlg-approval-note" v-model="editor.values.note" class="form-control" rows="2"></textarea></div>
        </template>
        <template v-if="editor.kind === 'decision'">
          <div class="wf-field"><label for="dlg-decision">Decision</label><select id="dlg-decision" v-model="editor.values.status" class="form-select"><option value="approved">Approve</option><option value="rejected">Reject</option></select></div>
          <div class="wf-field"><label for="dlg-decision-note">Decision note</label><textarea id="dlg-decision-note" v-model="editor.values.decisionNote" class="form-control" rows="2"></textarea></div>
        </template>
        <template v-if="editor.kind === 'baseline'">
          <div class="wf-field"><label for="dlg-baseline-project">Project</label><select id="dlg-baseline-project" v-model="editor.values.projectId" class="form-select" required><option v-for="item in workspace.projects" :key="item.id" :value="item.id">{{ item.name }}</option></select></div>
          <div class="wf-field"><label for="dlg-baseline-name">Baseline name</label><input id="dlg-baseline-name" v-model="editor.values.name" class="form-control" required /></div>
          <div class="wf-field"><label for="dlg-baseline-note">Note</label><textarea id="dlg-baseline-note" v-model="editor.values.note" class="form-control" rows="2"></textarea></div>
        </template>
        <template v-if="editor.kind === 'field'">
          <div class="wf-field"><label for="dlg-field-name">Field name</label><input id="dlg-field-name" v-model="editor.values.name" class="form-control" required /></div>
          <div class="wf-grid">
            <div class="wf-field"><label for="dlg-field-scope">Item type</label><select id="dlg-field-scope" v-model="editor.values.scope" class="form-select" :disabled="editor.mode === 'edit'"><option v-for="type in WORKFLOW_ITEM_TYPES" :key="type" :value="type">{{ ITEM_TYPE_LABELS[type] }}</option></select></div>
            <div class="wf-field"><label for="dlg-field-type">Field type</label><select id="dlg-field-type" v-model="editor.values.fieldType" class="form-select" :disabled="editor.mode === 'edit'"><option value="string">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / no</option><option value="enum">Choice</option></select></div>
            <div class="wf-field"><label for="dlg-field-status">Status</label><select id="dlg-field-status" v-model="editor.values.status" class="form-select"><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
          </div>
          <label class="wf-check"><input v-model="editor.values.required" type="checkbox" /> Required</label>
          <div v-if="editor.values.fieldType === 'enum'" class="wf-field"><label for="dlg-field-options">Options (comma separated)</label><input id="dlg-field-options" v-model="editor.values.optionsText" class="form-control" /></div>
          <div class="wf-field"><label for="dlg-field-description">Description</label><textarea id="dlg-field-description" v-model="editor.values.description" class="form-control" rows="2"></textarea></div>
        </template>
        <template v-if="editor.kind === 'value'">
          <div class="wf-field"><label for="dlg-value-project">Project</label><select id="dlg-value-project" v-model="editor.values.projectId" class="form-select" required><option v-for="item in workspace.projects" :key="item.id" :value="item.id">{{ item.name }}</option></select></div>
          <div class="wf-grid">
            <div class="wf-field"><label for="dlg-value-type">Item type</label><select id="dlg-value-type" v-model="editor.values.itemType" class="form-select" @change="editor.values.fieldId = ''"><option v-for="type in WORKFLOW_ITEM_TYPES" :key="type" :value="type">{{ ITEM_TYPE_LABELS[type] }}</option></select></div>
            <div class="wf-field"><label for="dlg-value-item">Item ID</label><input id="dlg-value-item" v-model="editor.values.itemId" class="form-control" required /></div>
          </div>
          <div class="wf-field"><label for="dlg-value-field">Field</label><select id="dlg-value-field" v-model="editor.values.fieldId" class="form-select" required><option value="" disabled>Choose a field</option><option v-for="item in workspace.customFields.filter((field) => field.status === 'active' && field.scope === editor.values.itemType)" :key="item.id" :value="item.id">{{ item.name }}</option></select></div>
          <div class="wf-field">
            <label for="dlg-value-value">Value</label>
            <select v-if="editorField?.fieldType === 'boolean'" id="dlg-value-value" v-model="editor.values.valueText" class="form-select"><option value="true">Yes</option><option value="false">No</option></select>
            <select v-else-if="editorField?.fieldType === 'enum'" id="dlg-value-value" v-model="editor.values.valueText" class="form-select"><option v-for="option in editorField.options" :key="option" :value="option">{{ option }}</option></select>
            <input v-else id="dlg-value-value" v-model="editor.values.valueText" class="form-control" :type="editorField?.fieldType === 'number' ? 'number' : editorField?.fieldType === 'date' ? 'date' : 'text'" required />
          </div>
        </template>
        <p v-if="editor.error" class="error-banner mb-0" role="alert">{{ editor.error }}</p>
      </div>
      <template #footer>
        <button class="btn btn-outline-secondary" type="button" :disabled="editor.busy" @click="closeEditor">Cancel</button>
        <button class="btn btn-primary" type="submit" :disabled="editor.busy">{{ editor.busy ? 'Saving…' : 'Save' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog :busy="deleteTarget.busy" confirm-label="Delete" :error="deleteTarget.error" :open="deleteTarget.open" :title="`Delete ${deleteTarget.kind}`" @close="deleteTarget.open = false" @confirm="confirmDelete">
      <p class="mb-0">Delete <strong>{{ deleteTarget.title }}</strong>? Bound or referenced records must be unlinked first.</p>
    </RequirementsConfirmDialog>
  </main>
</template>

<style scoped>
.workflow-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
.workflow-metrics div { display: grid; gap: 0.25rem; padding: 0.75rem; border: 1px solid var(--bs-border-color); border-radius: 0.5rem; }
.workflow-metrics span { font-size: 0.75rem; color: var(--bs-secondary-color); }
.workflow-metrics strong { font-size: 1.25rem; }
.workflow-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 0.5rem 0.75rem; padding: 0.75rem 0; border-block: 1px solid var(--bs-border-color); }
.workflow-filters .wf-field { min-width: 12rem; }
.workflow-filters__search { flex: 1 1 16rem; }
.workflow-filters--inline { border: 0; padding: 0; }
.workflow-tabs { display: flex; gap: 0.25rem; margin: 1rem 0; border-bottom: 1px solid var(--bs-border-color); overflow-x: auto; }
.workflow-tabs button { min-height: 2.75rem; padding: 0.5rem 0.75rem; border: 0; border-bottom: 0.15rem solid transparent; background: transparent; color: var(--bs-secondary-color); font-weight: 600; white-space: nowrap; }
.workflow-tabs button.active { border-color: var(--bs-primary); color: var(--bs-body-color); }
.workflow-empty { padding: 1.5rem; text-align: center; color: var(--bs-secondary-color); }
.workflow-pagination { display: flex; justify-content: center; align-items: center; gap: 0.75rem; }
.workflow-pagination .btn { min-height: 2.75rem; }
.workflow-row-actions { flex-wrap: nowrap; justify-content: flex-end; }
.wf-table a { font-weight: 600; }
@media (max-width: 48rem) {
  .workflow-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .workflow-filters .wf-field { min-width: 100%; }
  .wf-table th, .wf-table td { min-width: 8rem; }
}
</style>
