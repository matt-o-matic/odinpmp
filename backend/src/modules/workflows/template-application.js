// Applies stored templates: project templates seed workflows, custom fields and an outline
// when a project is created; work-item templates add custom-field defaults to a new item.
// Workflow templates are applied by the client, which prefills the definition editor.
import { z } from 'zod';

import { HttpError } from '../../lib/errors/http-error.js';
import { projectTreeSchema } from '../projects/projects.schema.js';
import {
  describeTemplatePayload,
  parseTemplatePayload,
  TEMPLATE_PAYLOAD_SCHEMAS,
} from './workflows.schema.js';
import {
  assertCustomFieldValue,
  buildWorkflowTransitionPlan,
  requireWorkflowManager,
  tenantIdFor,
} from './workflows.service.js';

const KIND_LABELS = { project: 'Project', work_item: 'Work-item', workflow: 'Workflow' };
const DEFAULT_ITEM_STATUS = 'Not Started';
const PREVIEW_PROJECT_ID = 'template-preview';

export function annotateTemplate(template) {
  return template && { ...template, ...describeTemplatePayload(template) };
}

function parsePayloadOrThrow(kind, payload) {
  return z.unknown().transform((value, context) => parseTemplatePayload(kind, value, context)).parse(payload);
}

export async function listTemplatesForUser({ input, repository, user }) {
  const tenantId = tenantIdFor(user);
  const { templates } = await repository.listSnapshot({ tenantId });
  return {
    templates: templates
      .filter((template) => (!input.kind || template.kind === input.kind) && (!input.status || template.status === input.status))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(annotateTemplate),
  };
}

export async function createTemplateForUser({ input, repository, user }) {
  const tenantId = tenantIdFor(user); requireWorkflowManager(user, tenantId);
  return { ok: true, value: annotateTemplate(await repository.createTemplate({ input, tenantId })) };
}

export async function updateTemplateForUser({ input, repository, templateId, user }) {
  const tenantId = tenantIdFor(user); requireWorkflowManager(user, tenantId);
  const current = (await repository.listSnapshot({ tenantId })).templates.find((record) => record.id === templateId);
  if (!current) throw new HttpError(404, 'Workflow record not found.');
  const kind = input.kind ?? current.kind;
  const next = { ...input };
  // A legacy payload may stay while only the name or status changes, but never under a new kind.
  if (input.payload !== undefined || kind !== current.kind) next.payload = parsePayloadOrThrow(kind, input.payload ?? current.payload);
  const value = await repository.updateTemplate({ input: next, templateId, tenantId });
  if (!value) throw new HttpError(404, 'Workflow record not found.');
  return { ok: true, value: annotateTemplate(value) };
}

function usableTemplate(snapshot, templateId, kind) {
  const template = snapshot.templates.find((record) => record.id === templateId && record.kind === kind);
  if (!template || template.status !== 'active') {
    throw new HttpError(404, `${KIND_LABELS[kind]} template not found.`, { details: { code: 'template_not_found', templateId } });
  }
  const parsed = TEMPLATE_PAYLOAD_SCHEMAS[kind].safeParse(template.payload);
  if (!parsed.success) {
    throw new HttpError(409, `The "${template.name}" template needs an update before it can be used.`, {
      details: { code: 'template_needs_update', issues: describeTemplatePayload(template).payloadIssues, templateId },
    });
  }
  return { payload: parsed.data, template };
}

export function workflowDefinitionFromTemplate(template, payload) {
  return {
    description: payload.description || template.description || '',
    itemTypes: [...payload.itemTypes],
    name: template.name,
    states: structuredClone(payload.states),
    status: 'active',
    transitions: structuredClone(payload.transitions),
  };
}

// MySQL JSON columns reorder object keys, so compare definitions by canonical form.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function sameWorkflowModel(left, right) {
  const shape = (workflow) => JSON.stringify(canonical({ itemTypes: workflow.itemTypes, states: workflow.states, transitions: workflow.transitions }));
  return shape(left) === shape(right);
}

function uniqueWorkflowName(name, projectName, takenNames) {
  const candidates = [name, `${name} (${projectName})`];
  for (let index = 2; candidates.length < 50; index += 1) candidates.push(`${name} (${projectName} ${index})`);
  const chosen = candidates.map((candidate) => candidate.slice(0, 240)).find((candidate) => !takenNames.has(candidate.toLowerCase()));
  if (!chosen) throw new HttpError(409, `Rename existing "${name}" workflows before using this template again.`);
  takenNames.add(chosen.toLowerCase());
  return chosen;
}

function templateConflict(message, code, details = {}) {
  return new HttpError(409, message, { details: { code, ...details } });
}

function resolveTemplateBindings({ payload, projectName, snapshot }) {
  const takenNames = new Set(snapshot.workflows.map((workflow) => workflow.name.toLowerCase()));
  const fromTemplate = new Map();
  const newDefinitions = [];
  const bindings = [];
  for (const binding of payload.workflowBindings) {
    let workflow;
    if (binding.sourceKind === 'workflow_definition') {
      workflow = snapshot.workflows.find((record) => record.id === binding.sourceId && record.status === 'active');
      if (!workflow) throw templateConflict(`The template's ${binding.itemType} workflow is missing or inactive.`, 'template_workflow_unavailable', { itemType: binding.itemType });
    } else if (fromTemplate.has(binding.sourceId)) {
      workflow = fromTemplate.get(binding.sourceId);
    } else {
      let source;
      try {
        source = usableTemplate(snapshot, binding.sourceId, 'workflow');
      } catch (error) {
        throw templateConflict(`The template's ${binding.itemType} workflow template is unavailable: ${error.message}`, 'template_workflow_unavailable', { itemType: binding.itemType });
      }
      const draft = workflowDefinitionFromTemplate(source.template, source.payload);
      // Reuse the definition an earlier project created from the same template.
      workflow = snapshot.workflows.find((record) => record.status === 'active'
        && record.name.toLowerCase() === draft.name.toLowerCase() && sameWorkflowModel(record, draft));
      if (!workflow) {
        workflow = { ...draft, id: `planned-workflow-${newDefinitions.length + 1}`, name: uniqueWorkflowName(draft.name, projectName, takenNames) };
        newDefinitions.push(workflow);
      }
      fromTemplate.set(binding.sourceId, workflow);
    }
    if (!workflow.itemTypes.includes(binding.itemType)) {
      throw templateConflict(`The "${workflow.name}" workflow does not support ${binding.itemType} items.`, 'template_workflow_item_type', { itemType: binding.itemType });
    }
    bindings.push({ itemType: binding.itemType, workflow });
  }
  return { bindings, newDefinitions };
}

function resolveTemplateCustomFields({ payload, snapshot }) {
  const newFields = [];
  for (const field of payload.customFields) {
    const existing = snapshot.customFields.find((record) => record.scope === field.scope && record.name.toLowerCase() === field.name.toLowerCase());
    if (!existing) { newFields.push({ ...field, status: 'active' }); continue; }
    if (existing.fieldType !== field.fieldType) {
      throw templateConflict(`A ${field.scope} custom field named "${existing.name}" already exists with a different type.`, 'template_custom_field_conflict', { field: field.name, scope: field.scope });
    }
  }
  return newFields;
}

function buildOutline(outline, bindings) {
  const statusFor = (itemType) => bindings.find((binding) => binding.itemType === itemType)?.workflow.states.find((state) => state.initial)?.key ?? DEFAULT_ITEM_STATUS;
  const node = (entry, itemType) => ({ description: entry.description, name: entry.name, points: entry.points, status: statusFor(itemType) });
  return outline.epics.map((epic) => ({
    ...node(epic, 'epic'),
    stories: epic.stories.map((story) => ({ ...node(story, 'story'), tasks: story.tasks.map((task) => node(task, 'task')) })),
  }));
}

/**
 * Resolves and checks everything a project template will create before the project exists,
 * so most template problems are reported without writing anything.
 */
export async function planProjectTemplate({ projectInput, templateId, tenantId, user, workflowRepository }) {
  if (!workflowRepository) throw new HttpError(409, 'Project templates are unavailable.');
  const snapshot = await workflowRepository.listSnapshot({ tenantId });
  const { payload, template } = usableTemplate(snapshot, templateId, 'project');
  const { bindings, newDefinitions } = resolveTemplateBindings({ payload, projectName: projectInput.name, snapshot });
  const newFields = resolveTemplateCustomFields({ payload, snapshot });

  const projectWorkflow = bindings.find((binding) => binding.itemType === 'project')?.workflow;
  if (projectWorkflow && !projectWorkflow.states.some((state) => state.key === projectInput.status)) {
    throw templateConflict(
      `Choose a project status from the "${projectWorkflow.name}" workflow: ${projectWorkflow.states.map((state) => state.key).join(', ')}.`,
      'template_project_status_mismatch',
      { states: projectWorkflow.states.map((state) => state.key) },
    );
  }

  const epics = buildOutline(payload.outline, bindings);
  const plannedWorkflows = new Map(snapshot.workflows.map((workflow) => [workflow.id, workflow]));
  for (const binding of bindings) plannedWorkflows.set(binding.workflow.id, binding.workflow);
  const previewSnapshot = {
    approvals: [],
    bindings: bindings.map((binding) => ({ itemType: binding.itemType, projectId: PREVIEW_PROJECT_ID, workflowId: binding.workflow.id })),
    customFields: [...snapshot.customFields, ...newFields.map((field, index) => ({ ...field, id: `planned-field-${index + 1}` }))],
    customValues: [],
    workflows: [...plannedWorkflows.values()],
  };
  const previewProject = { id: PREVIEW_PROJECT_ID, status: projectInput.status, tickets: [] };
  try {
    buildWorkflowTransitionPlan({
      currentProject: { ...previewProject, epics: [] },
      nextProject: { ...previewProject, epics },
      projectRole: 'admin',
      snapshot: previewSnapshot,
      tenantId,
      user,
    });
  } catch (error) {
    if (error?.details?.code !== 'workflow_required_fields_missing') throw error;
    throw templateConflict(
      `The template outline is missing fields its workflows require at the starting state: ${error.details.fields.join(', ')}.`,
      'template_outline_required_fields',
      { fields: error.details.fields },
    );
  }
  return { bindings, epics, newDefinitions, newFields, template };
}

// Removes the workflows, bindings and custom fields a template created, newest first, and then
// either the project (a project created for the template) or the outline the template seeded
// (an existing project, such as a converted engagement). Returns how many steps failed.
async function rollbackProjectTemplate({ created, discardProject, previousEpics, project, projectRepository, tenantId, user, workflowRepository }) {
  const steps = [
    ...[...created.bindings].reverse().map((record) => () => workflowRepository.deleteBinding({ bindingId: record.id, expectedVersion: record.version, tenantId })),
    ...[...created.fields].reverse().map((record) => () => workflowRepository.deleteCustomField({ expectedVersion: record.version, fieldId: record.id, tenantId })),
    ...[...created.workflows].reverse().map((record) => () => workflowRepository.deleteWorkflow({ expectedVersion: record.version, tenantId, workflowId: record.id })),
  ];
  if (discardProject) {
    steps.push(() => projectRepository.discardCreatedProject({ projectId: project.id, tenantId }));
  } else if (created.seeded) {
    steps.push(async () => {
      const tree = projectTreeSchema.parse({ epics: previousEpics, expectedUpdatedAt: created.seeded.updatedAt });
      if (!await projectRepository.replaceProjectTree({ input: tree, projectId: project.id, tenantId, user })) throw new HttpError(404, 'Project not found.');
    });
  }
  let failed = 0;
  for (const step of steps) {
    try { await step(); } catch { failed += 1; }
  }
  return failed;
}

function incompleteRollback(error, failedSteps, projectId) {
  return new HttpError(500, 'The project template could not be applied, and some of its records could not be removed.', {
    details: { cause: error?.message ?? null, code: 'template_rollback_incomplete', failedSteps, projectId },
  });
}

// Creates the planned workflows, bindings and custom fields, then seeds the outline after any
// epics the project already has. `created` records each step as it lands, for the rollback.
async function runProjectTemplate({ created, plan, previousEpics, project, projectRepository, tenantId, user, workflowRepository }) {
  const workflowIds = new Map();
  for (const { id: plannedId, ...input } of plan.newDefinitions) {
    const record = await workflowRepository.createWorkflow({ input, tenantId });
    created.workflows.push(record);
    workflowIds.set(plannedId, record.id);
  }
  for (const binding of plan.bindings) {
    const workflowId = workflowIds.get(binding.workflow.id) ?? binding.workflow.id;
    created.bindings.push(await workflowRepository.createBinding({ input: { itemType: binding.itemType, projectId: project.id, workflowId }, tenantId }));
  }
  for (const field of plan.newFields) created.fields.push(await workflowRepository.createCustomField({ input: field, tenantId }));
  if (!plan.epics.length) return project;
  const tree = projectTreeSchema.parse({ epics: [...previousEpics, ...plan.epics], expectedUpdatedAt: project.updatedAt });
  const seeded = await projectRepository.replaceProjectTree({ input: tree, projectId: project.id, tenantId, user });
  if (!seeded) throw new HttpError(404, 'Project not found.');
  created.seeded = seeded;
  return { ...seeded, role: project.role ?? seeded.role };
}

/**
 * Creates the planned workflows, bindings and custom fields, then seeds the outline. On any
 * failure everything created here and the new project are removed again.
 */
export async function applyProjectTemplate({ plan, project, projectRepository, tenantId, user, workflowRepository }) {
  const created = { bindings: [], fields: [], seeded: null, workflows: [] };
  try {
    return await runProjectTemplate({ created, plan, previousEpics: [], project, projectRepository, tenantId, user, workflowRepository });
  } catch (error) {
    const failedSteps = await rollbackProjectTemplate({ created, discardProject: true, project, projectRepository, tenantId, workflowRepository });
    if (failedSteps) throw incompleteRollback(error, failedSteps, project.id);
    throw error;
  }
}

// The epics a project already has, as projectTreeSchema input, so seeding a template's outline
// keeps them.
function existingEpicsForTree(project) {
  return projectTreeSchema.parse({ epics: project.epics ?? [], expectedUpdatedAt: project.updatedAt ?? new Date().toISOString() }).epics;
}

/**
 * Applies a template to a project that already exists, such as an engagement being converted.
 * The project is never removed: on failure, only what the template added is undone and the
 * error is rethrown. On success it returns the project and `undo`, which removes what the
 * template added again, for a caller whose next step fails.
 */
export async function applyProjectTemplateToExistingProject({ plan, project, projectRepository, tenantId, user, workflowRepository }) {
  const created = { bindings: [], fields: [], seeded: null, workflows: [] };
  const previousEpics = existingEpicsForTree(project);
  const rollback = () => rollbackProjectTemplate({ created, discardProject: false, previousEpics, project, projectRepository, tenantId, user, workflowRepository });
  let applied;
  try {
    applied = await runProjectTemplate({ created, plan, previousEpics, project, projectRepository, tenantId, user, workflowRepository });
  } catch (error) {
    const failedSteps = await rollback();
    if (failedSteps) throw incompleteRollback(error, failedSteps, project.id);
    throw error;
  }
  return {
    project: applied,
    async undo(error) {
      const failedSteps = await rollback();
      if (failedSteps) throw incompleteRollback(error, failedSteps, project.id);
    },
  };
}

/** Checks a work-item template and its custom-field defaults before the item is created. */
export async function planWorkItemTemplate({ itemType, templateId, tenantId, workflowRepository }) {
  if (!workflowRepository) throw new HttpError(409, 'Work-item templates are unavailable.');
  const snapshot = await workflowRepository.listSnapshot({ tenantId });
  const { payload, template } = usableTemplate(snapshot, templateId, 'work_item');
  if (payload.itemType !== itemType) {
    throw templateConflict(`The "${template.name}" template is for ${payload.itemType} items.`, 'template_item_type_mismatch', { itemType: payload.itemType });
  }
  const values = payload.customFieldDefaults.map((entry) => {
    const field = snapshot.customFields.find((record) => record.id === entry.fieldId && record.status === 'active' && record.scope === itemType);
    if (!field) throw templateConflict(`The "${template.name}" template sets a custom field that is no longer available.`, 'template_custom_field_unavailable', { fieldId: entry.fieldId });
    assertCustomFieldValue(field, entry.value);
    return { fieldId: field.id, value: entry.value };
  });
  return { itemType, template, values };
}

/**
 * Records the template's custom-field defaults on the created item. The item already exists,
 * so a failure here is reported as a warning rather than failing the create.
 */
export async function applyWorkItemTemplateDefaults({ plan, projectId, result, tenantId, workflowRepository }) {
  const itemId = result?.item?.id;
  const customValues = [];
  const templateWarnings = [];
  for (const entry of plan.values) {
    try {
      customValues.push(await workflowRepository.upsertCustomValue({
        input: { expectedVersion: null, fieldId: entry.fieldId, itemId, itemType: plan.itemType, projectId, value: entry.value },
        tenantId,
      }));
    } catch {
      templateWarnings.push(`The default for custom field ${entry.fieldId} could not be saved.`);
    }
  }
  return { ...result, templateApplied: { customValues, templateId: plan.template.id, templateWarnings } };
}
