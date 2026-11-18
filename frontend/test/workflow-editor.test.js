import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { applyKanbanCardTemplate, buildKanbanCardCreatePayload, changeKanbanCardType, createKanbanCardForm } from '../src/lib/projects/kanban-card-create.js';
import {
  WORKFLOW_ITEM_TYPES,
  createState,
  createWorkflowDraft,
  definitionPayload,
  moveEntry,
  normalizeWorkflowModel,
  parseFieldList,
  previewColumns,
  removeState,
  renameStateKey,
  validateWorkflowModel,
} from '../src/lib/workflows/workflow-model.js';
import {
  applyWorkItemTemplateToNode,
  buildTemplatePayload,
  composeItemDescription,
  createPayloadDraft,
  definitionDraftFromWorkflowTemplate,
  PROJECT_STATUS_OPTIONS,
  projectTemplateSummary,
  resolveTemplateProjectStatuses,
  usableTemplates,
  workItemTemplateDefaults,
} from '../src/lib/workflows/workflow-templates.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function messages(result) {
  return result.errors.map((entry) => entry.message);
}

test('workflow item types include tickets everywhere the workspace offers a picker', () => {
  assert.deepEqual(WORKFLOW_ITEM_TYPES, ['project', 'epic', 'story', 'task', 'ticket']);
  const view = read('../src/views/WorkflowsView.vue');
  assert.doesNotMatch(view, /\['project','epic','story','task'\]/);
  assert.equal((view.match(/v-for="type in WORKFLOW_ITEM_TYPES"/g) ?? []).length, 4, 'binding, approval, field and value pickers');
  assert.match(read('../src/components/workflows/WorkflowModelEditor.vue'), /v-for="type in WORKFLOW_ITEM_TYPES"/);
});

test('the definition editor is structured, not raw JSON', () => {
  const sources = ['../src/views/WorkflowsView.vue', '../src/views/WorkflowDefinitionView.vue', '../src/views/WorkflowTemplateView.vue', '../src/components/workflows/WorkflowStatesEditor.vue', '../src/components/workflows/WorkflowTransitionsEditor.vue'].map(read).join('\n');
  assert.doesNotMatch(sources, /JSON\.parse|statesText|transitionsText|payloadText/);
  assert.doesNotMatch(sources, /window\.(alert|confirm)|\balert\(|\bconfirm\(/);
  assert.doesNotMatch(sources, /\stitle="/);
  const router = read('../src/router/index.js');
  for (const name of ['workflow-definition-new', 'workflow-definition', 'workflow-template-new', 'workflow-template']) assert.match(router, new RegExp(`name: '${name}'`));
});

test('validation mirrors the backend rules and flags likely mistakes', () => {
  const draft = createWorkflowDraft();
  draft.name = 'Delivery';
  assert.deepEqual(messages(validateWorkflowModel(draft)), []);

  const broken = normalizeWorkflowModel({
    itemTypes: [],
    name: '',
    states: [
      { initial: true, key: 'open', label: 'Open' },
      { initial: true, key: 'open', label: 'Duplicate' },
      { key: '', label: '', slaHours: -1 },
    ],
    transitions: [{ fromState: 'open', key: 'go', toState: 'missing' }, { fromState: 'open', key: 'go', toState: 'open' }],
  });
  const result = validateWorkflowModel(broken);
  const text = messages(result).join('\n');
  assert.equal(result.ok, false);
  assert.match(text, /Enter a workflow name/);
  assert.match(text, /Choose at least one item type/);
  assert.match(text, /"open" is used more than once/);
  assert.match(text, /State 3 needs a label/);
  assert.match(text, /SLA hours must be a whole number/);
  assert.match(text, /Mark only one state as initial/);
  assert.match(text, /choose a defined "to" state/);
  assert.match(text, /Transition key "go" is used more than once/);
  assert.ok(result.errors.some((entry) => entry.target.startsWith('state:')), 'errors point at their row');

  const unreachable = normalizeWorkflowModel({ itemTypes: ['ticket'], name: 'Tickets', states: [{ initial: true, key: 'a', label: 'A' }, { key: 'b', label: 'B' }], transitions: [{ approvalRequired: true, fromState: 'b', key: 'back', toState: 'a' }] });
  const warnings = validateWorkflowModel(unreachable).warnings.map((entry) => entry.message).join('\n');
  assert.match(warnings, /Unreachable from the initial state: B/);
  assert.match(warnings, /no approver roles/);
});

test('state edits keep transitions consistent', () => {
  const model = createWorkflowDraft();
  model.transitions = renameStateKey(model, 'in_progress', 'doing');
  assert.deepEqual(model.transitions.map((entry) => `${entry.fromState}->${entry.toState}`), ['ready->doing', 'doing->done']);
  const doing = model.states.find((state) => state.key === 'in_progress');
  doing.key = 'doing';
  const removed = removeState(model, doing.uid);
  assert.deepEqual(removed.states.map((state) => state.key), ['ready', 'done']);
  assert.deepEqual(removed.transitions, []);
  assert.deepEqual(moveEntry(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moveEntry(['a', 'b'], 0, -1), ['a', 'b']);
  assert.equal(createState(model).key, 'new_state');
  assert.deepEqual(parseFieldList(' description, points ,description,'), ['description', 'points']);
});

test('definition payloads drop editor-only fields and the preview groups by category', () => {
  const model = createWorkflowDraft();
  model.name = '  Delivery  ';
  const payload = definitionPayload(model);
  assert.equal(payload.name, 'Delivery');
  assert.equal('uid' in payload.states[0], false);
  assert.equal('uid' in payload.transitions[0], false);
  const columns = previewColumns(model);
  assert.deepEqual(columns.map((column) => column.value), ['backlog', 'active', 'done']);
  assert.equal(columns[0].states[0].outgoing[0].toLabel, 'In progress');
});

test('template drafts build typed payloads and tolerate legacy rows', () => {
  assert.equal(createPayloadDraft('project', { status: 'In Progress' }).epics.length, 0);
  const project = createPayloadDraft('project');
  assert.deepEqual(buildTemplatePayload('project', project).errors, ['Add a workflow binding, a starter outline, or a custom field.']);
  project.workflowBindings.push({ itemType: 'story', source: 'workflow_template:tpl-1' }, { itemType: 'story', source: '' });
  project.epics.push({ description: '', name: 'Discovery', points: '5', stories: [{ description: '', name: '', points: null, tasks: [] }] });
  project.customFields.push({ description: '', fieldType: 'enum', name: 'Risk', optionsText: '', required: false, scope: 'story' });
  const invalid = buildTemplatePayload('project', project).errors.join('\n');
  assert.match(invalid, /Choose a workflow for every binding/);
  assert.match(invalid, /Bind each item type at most once/);
  assert.match(invalid, /Every story in the outline needs a name/);
  assert.match(invalid, /Choice fields need at least one option/);
  project.workflowBindings.pop();
  project.epics[0].stories[0].name = 'Interview users';
  project.customFields[0].optionsText = 'Low, High';
  const built = buildTemplatePayload('project', project);
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.payload.workflowBindings, [{ itemType: 'story', sourceId: 'tpl-1', sourceKind: 'workflow_template' }]);
  assert.equal(built.payload.outline.epics[0].points, 5);
  assert.deepEqual(built.payload.customFields[0].options, ['Low', 'High']);
  assert.equal(projectTemplateSummary({ payload: built.payload }), '1 workflow binding · 2 outline items · 1 custom field');

  const fields = [{ fieldType: 'number', id: 'f-1', name: 'Budget', options: [], scope: 'ticket', status: 'active' }];
  const item = createPayloadDraft('work_item');
  item.itemType = 'ticket';
  Object.assign(item, { category: 'defect', points: '2', priority: '1', severity: 'S1' });
  item.customFieldDefaults.push({ fieldId: 'f-1', value: 'abc' });
  assert.match(buildTemplatePayload('work_item', item, { customFields: fields }).errors.join(), /Budget needs a number/);
  item.customFieldDefaults[0].value = '40';
  const ticket = buildTemplatePayload('work_item', item, { customFields: fields });
  assert.deepEqual(ticket.errors, []);
  assert.deepEqual(ticket.payload, { acceptanceCriteria: '', category: 'defect', customFieldDefaults: [{ fieldId: 'f-1', value: 40 }], description: '', itemType: 'ticket', points: 2, priority: 1, severity: 'S1' });
});

test('workflow templates prefill the definition editor and work-item templates prefill items', () => {
  const template = { description: 'Fallback', id: 'tpl-1', kind: 'workflow', name: 'Story flow', payload: { description: '', itemTypes: ['story'], states: [{ initial: true, key: 'ready', label: 'Ready' }], transitions: [] }, payloadStatus: 'valid', status: 'active' };
  const draft = definitionDraftFromWorkflowTemplate(template);
  assert.equal(draft.name, 'Story flow');
  assert.equal(draft.description, 'Fallback');
  assert.equal(draft.states[0].key, 'ready');

  const templates = [
    template,
    { id: 'wi-1', kind: 'work_item', name: 'Spike', payload: { acceptanceCriteria: 'Write it up.', description: 'Research.', itemType: 'story', points: 3, priority: 2 }, payloadStatus: 'valid', status: 'active' },
    { id: 'wi-2', kind: 'work_item', name: 'Old', payload: {}, payloadStatus: 'needs_update', status: 'active' },
    { id: 'wi-3', kind: 'work_item', name: 'Off', payload: { itemType: 'story' }, payloadStatus: 'valid', status: 'inactive' },
  ];
  assert.deepEqual(usableTemplates(templates, 'work_item', 'story').map((entry) => entry.id), ['wi-1']);
  assert.equal(composeItemDescription('Research.', 'Write it up.'), 'Research.\n\n**Acceptance criteria**\n\nWrite it up.');
  assert.deepEqual(workItemTemplateDefaults(templates[1]), { description: 'Research.\n\n**Acceptance criteria**\n\nWrite it up.', points: 3, priority: 2 });

  const node = { description: '', id: 'story-draft', points: null, priority: 4 };
  applyWorkItemTemplateToNode(node, templates[1]);
  assert.deepEqual(node, { description: workItemTemplateDefaults(templates[1]).description, id: 'story-draft', points: 3, priority: 2, workItemTemplateId: 'wi-1' });
  applyWorkItemTemplateToNode(node, null);
  assert.equal('workItemTemplateId' in node, false);

  const project = { epics: [{ id: 'epic-1', name: 'Delivery', stories: [] }] };
  let form = createKanbanCardForm(project, ['Not Started']);
  form = applyKanbanCardTemplate({ ...form, name: 'Caching spike' }, templates[1]);
  const payload = buildKanbanCardCreatePayload(form);
  assert.equal(payload.templateId, 'wi-1');
  assert.equal(payload.item.points, 3);
  assert.equal(payload.item.priority, 2);
  assert.match(payload.item.description, /Acceptance criteria/);
  assert.equal(changeKanbanCardType(form, project, 'task').templateId, '');
  assert.equal('templateId' in buildKanbanCardCreatePayload(createKanbanCardForm(project, ['Not Started'])), false);
});

test('work-item template pickers are offered where items are created', () => {
  assert.match(read('../src/components/projects/ProjectKanbanCardCreateModal.vue'), /<WorkItemTemplatePicker[\s\S]*:item-type="form.issueType"/);
  assert.match(read('../src/components/projects/ProjectTicketsPanel.vue'), /<WorkItemTemplatePicker[^>]*item-type="ticket"/);
  assert.match(read('../src/components/projects/ProjectWorkbenchEditor.vue'), /<WorkItemTemplatePicker[\s\S]*currentItem.version == null/);
  assert.match(read('../src/views/ProjectsView.vue'), /templateId: createForm.templateId \|\| null/);
});

test('a template that binds a project workflow limits the new project to that workflow states', async () => {
  const state = (key, label, initial = false) => ({ initial, key, label });
  const flow = { id: 'flow-1', kind: 'workflow', name: 'Gate flow', payload: { states: [state('proposed', 'Proposed'), state('approved', 'Approved', true)] }, status: 'active' };
  const projectTemplate = (binding) => ({ kind: 'project', payload: { workflowBindings: [{ itemType: 'story', sourceId: 'flow-1', sourceKind: 'workflow_template' }, ...(binding ? [{ itemType: 'project', ...binding }] : [])] } });
  const definitions = { 'workflow-1': { name: 'Delivery', states: [state('In Progress', 'In progress', true), state('Completed', 'Completed')], status: 'active' }, 'workflow-off': { name: 'Old', states: [state('x', 'X', true)], status: 'inactive' } };
  const loadDefinition = async (id) => definitions[id] ?? null;

  assert.equal(await resolveTemplateProjectStatuses(null, { loadDefinition }), null);
  assert.equal(await resolveTemplateProjectStatuses(projectTemplate(null), { loadDefinition, workflowTemplates: [flow] }), null, 'only a project binding counts');
  assert.deepEqual(await resolveTemplateProjectStatuses(projectTemplate({ sourceId: 'flow-1', sourceKind: 'workflow_template' }), { loadDefinition, workflowTemplates: [flow] }), {
    initial: 'approved', options: [{ label: 'Proposed', value: 'proposed' }, { label: 'Approved', value: 'approved' }], workflowName: 'Gate flow',
  });
  const fromDefinition = await resolveTemplateProjectStatuses(projectTemplate({ sourceId: 'workflow-1', sourceKind: 'workflow_definition' }), { loadDefinition });
  assert.equal(fromDefinition.initial, 'In Progress');
  assert.deepEqual(fromDefinition.options.map((option) => option.value), ['In Progress', 'Completed']);
  await assert.rejects(resolveTemplateProjectStatuses(projectTemplate({ sourceId: 'flow-1', sourceKind: 'workflow_template' }), { loadDefinition, workflowTemplates: [] }));
  await assert.rejects(resolveTemplateProjectStatuses(projectTemplate({ sourceId: 'workflow-off', sourceKind: 'workflow_definition' }), { loadDefinition }));
  assert.deepEqual(PROJECT_STATUS_OPTIONS.map((option) => option.value), ['Planned', 'In Progress', 'At Risk', 'Completed']);

  const view = read('../src/views/ProjectsView.vue');
  assert.match(view, /<option v-for="option in createStatusOptions" :key="option.value" :value="option.value">/);
  assert.match(view, /<label id="project-description-label" class="form-label">Project Description<\/label>/);
  assert.match(view, /labelled-by="project-description-label"/);
  assert.match(read('../src/components/rich-content/RichContentEditor.vue'), /\{ attributes: \{ 'aria-labelledby': props\.labelledBy, 'aria-multiline': 'true', role: 'textbox' \} \}/);
});
