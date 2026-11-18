import { PROJECT_CAPABILITIES, getTenantMembership, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { describeTemplatePayload, workflowDefinitionCreateSchema } from './workflows.schema.js';

export function tenantIdFor(user) {
  const tenantId = user?.memberships?.[0]?.tenantId;
  if (!tenantId) throw new HttpError(403, 'This account is not assigned to a tenant.');
  return tenantId;
}

function tenantRoleFor(user, tenantId) {
  return String(getTenantMembership(user, tenantId)?.role ?? '').trim().toLowerCase();
}

export function requireWorkflowManager(user, tenantId) {
  if (!['admin', 'manager'].includes(tenantRoleFor(user, tenantId))) {
    throw new HttpError(404, 'Workflow record not found.');
  }
}

async function projectRoleFor({ projectId, projectRepository, tenantId, user }) {
  const access = await requireProjectCapability({
    capability: PROJECT_CAPABILITIES.PLAN_EDIT,
    projectId,
    repository: projectRepository,
    tenantId,
    user,
  });
  return String(access?.projectRole ?? tenantRoleFor(user, tenantId)).trim().toLowerCase();
}

function workflowForBinding(snapshot, projectId, itemType) {
  const binding = snapshot.bindings.find((candidate) => candidate.projectId === projectId && candidate.itemType === itemType);
  if (!binding) return { binding: null, workflow: null };
  const workflow = snapshot.workflows.find((candidate) => candidate.id === binding.workflowId && candidate.status === 'active');
  if (!workflow) throw new HttpError(409, `The ${itemType} workflow binding references an inactive or missing workflow.`);
  if (!workflow.itemTypes.includes(itemType)) throw new HttpError(409, `The bound workflow does not support ${itemType} items.`);
  return { binding, workflow };
}

function flattenProject(project) {
  const records = [{ item: project, itemId: project.id, itemType: 'project' }];
  for (const epic of project.epics ?? []) {
    records.push({ item: epic, itemId: epic.id, itemType: 'epic' });
    for (const story of epic.stories ?? []) {
      records.push({ item: story, itemId: story.id, itemType: 'story' });
      for (const task of story.tasks ?? []) records.push({ item: task, itemId: task.id, itemType: 'task' });
    }
  }
  // Tickets are a flat project-level collection rather than tree nodes.
  for (const ticket of project.tickets ?? []) records.push({ item: ticket, itemId: ticket.id, itemType: 'ticket' });
  return records;
}

function nativeFieldValue(item, field) {
  if (Object.hasOwn(item, field)) return item[field];
  const aliases = { assignee: 'assigneeId', description: 'description', endDate: 'targetEndDate', name: 'name', points: 'points', startDate: 'targetStartDate' };
  return aliases[field] ? item[aliases[field]] : undefined;
}

function isPresent(value) {
  return value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
}

function customFieldValue(snapshot, { field, itemId, itemType, projectId }) {
  const definition = snapshot.customFields.find((candidate) => candidate.status === 'active'
    && candidate.scope === itemType && (candidate.id === field || candidate.name === field));
  if (!definition) return undefined;
  return snapshot.customValues.find((candidate) => candidate.projectId === projectId
    && candidate.itemId === itemId && candidate.fieldId === definition.id)?.value;
}

function requireFields(snapshot, fields, context) {
  const missing = [...new Set(fields)].filter((field) => !isPresent(nativeFieldValue(context.item, field))
    && !isPresent(customFieldValue(snapshot, { ...context, field })));
  if (missing.length) {
    throw new HttpError(409, `Complete required fields before this transition: ${missing.join(', ')}.`, {
      details: { code: 'workflow_required_fields_missing', fields: missing },
    });
  }
}

function findApproval(snapshot, context, transition) {
  const now = Date.now();
  return snapshot.approvals.find((approval) => approval.projectId === context.projectId
    && approval.itemType === context.itemType && approval.itemId === context.itemId
    && approval.transitionKey === transition.key && approval.fromState === context.fromState
    && approval.toState === context.toState && approval.status === 'approved'
    && (!approval.expiresAt || Date.parse(approval.expiresAt) > now)) ?? null;
}

export function buildWorkflowTransitionPlan({ currentProject, nextProject, snapshot, tenantId, user, projectRole }) {
  const currentRecords = flattenProject(currentProject);
  const currentByKey = new Map(currentRecords.map((record) => [`${record.itemType}:${record.itemId}`, record]));
  const nextKeys = new Set(flattenProject(nextProject).map((record) => `${record.itemType}:${record.itemId}`));
  for (const current of currentRecords) {
    if (nextKeys.has(`${current.itemType}:${current.itemId}`)) continue;
    const { workflow } = workflowForBinding(snapshot, currentProject.id, current.itemType);
    if (!workflow) continue;
    const state = workflow.states.find((candidate) => candidate.key === current.item.status);
    if (!state?.terminal) {
      throw new HttpError(409, `Move ${current.itemType} ${current.itemId} to a terminal workflow state before deleting it.`, {
        details: { code: 'workflow_item_delete_not_terminal', itemId: current.itemId, itemType: current.itemType },
      });
    }
  }
  const planned = [];
  for (const next of flattenProject(nextProject)) {
    const { workflow } = workflowForBinding(snapshot, nextProject.id, next.itemType);
    if (!workflow) continue;
    const current = currentByKey.get(`${next.itemType}:${next.itemId}`);
    const fromState = current?.item?.status ?? null;
    const toState = next.item?.status;
    if (!current) {
      const initial = workflow.states.find((state) => state.initial);
      if (toState !== initial?.key) {
        throw new HttpError(409, `New ${next.itemType} items must begin in ${initial?.label ?? initial?.key}.`, {
          details: { code: 'workflow_initial_state_required', expectedState: initial?.key },
        });
      }
      requireFields(snapshot, initial.requiredFields, { item: next.item, itemId: next.itemId, itemType: next.itemType, projectId: nextProject.id });
      continue;
    }
    if (fromState === toState) continue;
    const transition = workflow.transitions.find((candidate) => candidate.fromState === fromState && candidate.toState === toState);
    if (!transition) {
      throw new HttpError(409, `Workflow does not allow ${fromState} to transition to ${toState}.`, {
        details: { code: 'workflow_transition_not_allowed', fromState, itemId: next.itemId, itemType: next.itemType, toState },
      });
    }
    const allowedRoles = new Set(transition.allowedRoles);
    const tenantRole = tenantRoleFor(user, tenantId);
    if (allowedRoles.size && !allowedRoles.has(projectRole) && !allowedRoles.has(tenantRole)) {
      throw new HttpError(403, 'Your role cannot perform this workflow transition.', {
        details: { code: 'workflow_transition_role_denied' },
      });
    }
    const target = workflow.states.find((state) => state.key === toState);
    requireFields(snapshot, [...transition.requiredFields, ...(target?.requiredFields ?? [])], {
      item: next.item, itemId: next.itemId, itemType: next.itemType, projectId: nextProject.id,
    });
    const approval = transition.approvalRequired ? findApproval(snapshot, {
      fromState, itemId: next.itemId, itemType: next.itemType, projectId: nextProject.id, toState,
    }, transition) : null;
    if (transition.approvalRequired && !approval) {
      throw new HttpError(409, 'This workflow transition requires a current approval.', {
        details: { code: 'workflow_approval_required', transitionKey: transition.key },
      });
    }
    planned.push({
      approvalId: approval?.id ?? null,
      fromState,
      itemId: next.itemId,
      itemType: next.itemType,
      projectId: nextProject.id,
      slaDueAt: target?.slaHours ? new Date(Date.now() + target.slaHours * 3_600_000).toISOString() : null,
      tenantId,
      toState,
      transitionKey: transition.key,
      userId: user.id,
    });
  }
  return planned;
}

export async function prepareWorkflowProjectMutation({ input, mode, projectId, projectRepository, user, workflowRepository }) {
  if (!workflowRepository) return { transitions: [] };
  const tenantId = tenantIdFor(user);
  const projectRole = await projectRoleFor({ projectId, projectRepository, tenantId, user });
  const [currentProject, snapshot] = await Promise.all([
    projectRepository.getProjectDetail({ projectId, tenantId }),
    workflowRepository.listSnapshot({ tenantId }),
  ]);
  if (!currentProject) throw new HttpError(404, 'Project not found.');
  const nextProject = mode === 'project'
    ? { ...currentProject, ...input, id: projectId }
    : { ...currentProject, epics: input.epics ?? [], tickets: input.tickets ?? currentProject.tickets ?? [] };
  return {
    tenantId,
    transitions: buildWorkflowTransitionPlan({ currentProject, nextProject, projectRole, snapshot, tenantId, user }),
  };
}

/**
 * The workflow transitions a change from `currentProject` to `nextProject` makes, checked for an
 * actor whose project role the caller has already worked out. Someone with no role on the
 * project (a person with a task access link) passes only transitions that name no roles.
 */
export async function planWorkflowTransitions({ currentProject, nextProject, projectRole = '', tenantId, user, workflowRepository }) {
  if (!workflowRepository) return [];
  const snapshot = await workflowRepository.listSnapshot({ tenantId });
  return buildWorkflowTransitionPlan({ currentProject, nextProject, projectRole: String(projectRole ?? '').trim().toLowerCase(), snapshot, tenantId, user });
}

export async function recordWorkflowTransitions(workflowRepository, transitions) {
  if (!workflowRepository) return [];
  const recorded = [];
  for (const transition of transitions) recorded.push(await workflowRepository.recordTransition(transition));
  return recorded;
}

function visibleProjectIds(projects) { return new Set(projects.map((project) => project.id)); }

export async function getWorkflowWorkspaceForUser({ input, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  if (input.projectId) await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId: input.projectId, repository: projectRepository, tenantId, user });
  const [snapshot, projects] = await Promise.all([
    repository.listSnapshot({ tenantId }),
    projectRepository.listProjectsForTenant({ tenantId, user }),
  ]);
  const visible = visibleProjectIds(projects);
  const projectScoped = (record) => !record.projectId || (visible.has(record.projectId) && (!input.projectId || record.projectId === input.projectId));
  const query = input.query.toLowerCase();
  let workflows = snapshot.workflows.filter((workflow) => (!input.status || workflow.status === input.status)
    && (!query || `${workflow.name} ${workflow.description}`.toLowerCase().includes(query)));
  const total = workflows.length;
  workflows = workflows.sort((left, right) => left.name.localeCompare(right.name)).slice(input.offset, input.offset + input.limit);
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  return {
    approvals: snapshot.approvals.filter(projectScoped),
    baselines: snapshot.baselines.filter(projectScoped),
    bindings: snapshot.bindings.filter((binding) => projectScoped(binding) && workflowIds.has(binding.workflowId)),
    canManage: ['admin', 'manager'].includes(tenantRoleFor(user, tenantId)),
    customFields: snapshot.customFields,
    customValues: snapshot.customValues.filter(projectScoped),
    histories: snapshot.histories.filter(projectScoped),
    limit: input.limit,
    offset: input.offset,
    projects,
    templates: snapshot.templates.map((template) => ({ ...template, ...describeTemplatePayload(template) })),
    total,
    workflows,
  };
}

export async function createWorkflowForUser({ input, repository, user }) {
  const tenantId = tenantIdFor(user); requireWorkflowManager(user, tenantId);
  return { ok: true, value: await repository.createWorkflow({ input, tenantId }) };
}

export async function updateWorkflowForUser({ input, projectRepository, repository, user, workflowId }) {
  const tenantId = tenantIdFor(user); requireWorkflowManager(user, tenantId);
  const snapshot = await repository.listSnapshot({ tenantId });
  const current = snapshot.workflows.find((record) => record.id === workflowId);
  if (!current) throw new HttpError(404, 'Workflow record not found.');
  const validated = workflowDefinitionCreateSchema.parse({ ...current, ...input });
  const bindings = snapshot.bindings.filter((record) => record.workflowId === workflowId);
  if (bindings.length && validated.status !== 'active') throw new HttpError(409, 'Remove project bindings before deactivating this workflow.');
  const stateKeys = new Set(validated.states.map((state) => state.key));
  for (const binding of bindings) {
    const project = await projectRepository.getProjectDetail({ projectId: binding.projectId, tenantId });
    const incompatible = flattenProject(project ?? {}).filter((record) => record.itemType === binding.itemType && !stateKeys.has(record.item.status));
    if (incompatible.length) throw new HttpError(409, 'This update would remove workflow states used by bound project items.', { details: { code: 'workflow_state_in_use', itemIds: incompatible.map((record) => record.itemId) } });
  }
  const value = await repository.updateWorkflow({ input: { ...validated, expectedVersion: input.expectedVersion }, tenantId, workflowId });
  if (!value) throw new HttpError(404, 'Workflow record not found.');
  return { ok: true, value };
}

export async function deleteWorkflowRecordForUser({ expectedVersion, id, method, repository, user }) {
  const tenantId = tenantIdFor(user); requireWorkflowManager(user, tenantId);
  const deleted = await repository[method]({ expectedVersion, tenantId, ...id });
  if (!deleted) throw new HttpError(404, 'Workflow record not found.');
  return { ok: true };
}

export async function mutateManagedWorkflowRecordForUser({ input, method, recordId = {}, repository, user }) {
  const tenantId = tenantIdFor(user); requireWorkflowManager(user, tenantId);
  const value = await repository[method]({ input, tenantId, ...recordId });
  if (!value) throw new HttpError(404, 'Workflow record not found.');
  return { ok: true, value };
}

export async function mutateProjectWorkflowRecordForUser({ capability = PROJECT_CAPABILITIES.PLAN_EDIT, input, method, projectRepository, recordId = {}, repository, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability, projectId: input.projectId, repository: projectRepository, tenantId, user });
  const value = await repository[method]({ input, tenantId, ...recordId, requestedBy: user.id, createdBy: user.id });
  if (!value) throw new HttpError(404, 'Workflow record not found.');
  return { ok: true, value };
}

export async function createBindingForUser({ input, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: input.projectId, repository: projectRepository, tenantId, user });
  const [snapshot, project] = await Promise.all([
    repository.listSnapshot({ tenantId }),
    projectRepository.getProjectDetail({ projectId: input.projectId, tenantId }),
  ]);
  const workflow = snapshot.workflows.find((record) => record.id === input.workflowId && record.status === 'active');
  if (!workflow || !workflow.itemTypes.includes(input.itemType)) throw new HttpError(404, 'Compatible active workflow not found.');
  const states = new Set(workflow.states.map((state) => state.key));
  const invalid = flattenProject(project ?? {}).filter((record) => record.itemType === input.itemType && !states.has(record.item.status));
  if (invalid.length) {
    throw new HttpError(409, 'Existing project items use statuses that are not defined by this workflow.', {
      details: { code: 'workflow_binding_status_mismatch', itemIds: invalid.map((record) => record.itemId) },
    });
  }
  return { ok: true, value: await repository.createBinding({ input, tenantId }) };
}

export async function updateBindingForUser({ bindingId, input, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  const snapshot = await repository.listSnapshot({ tenantId });
  const current = snapshot.bindings.find((record) => record.id === bindingId);
  if (!current) throw new HttpError(404, 'Workflow binding not found.');
  return createOrUpdateBinding({ bindingId, current, input, projectRepository, repository, tenantId, user });
}

async function createOrUpdateBinding({ bindingId, current, input, projectRepository, repository, tenantId, user }) {
  const effective = { ...current, ...input };
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: effective.projectId, repository: projectRepository, tenantId, user });
  const [snapshot, project] = await Promise.all([
    repository.listSnapshot({ tenantId }), projectRepository.getProjectDetail({ projectId: effective.projectId, tenantId }),
  ]);
  const workflow = snapshot.workflows.find((record) => record.id === effective.workflowId && record.status === 'active');
  if (!workflow || !workflow.itemTypes.includes(effective.itemType)) throw new HttpError(404, 'Compatible active workflow not found.');
  const states = new Set(workflow.states.map((state) => state.key));
  if (flattenProject(project ?? {}).some((record) => record.itemType === effective.itemType && !states.has(record.item.status))) {
    throw new HttpError(409, 'Existing project items use statuses that are not defined by this workflow.');
  }
  const value = await repository.updateBinding({ bindingId, input, tenantId });
  if (!value) throw new HttpError(404, 'Workflow binding not found.');
  return { ok: true, value };
}

export async function deleteProjectWorkflowRecordForUser({ expectedVersion, id, method, projectId = null, projectRepository, repository, snapshotCollection, user }) {
  const tenantId = tenantIdFor(user);
  const snapshot = await repository.listSnapshot({ tenantId });
  const idValue = Object.values(id)[0];
  const record = snapshot[snapshotCollection].find((candidate) => candidate.id === idValue);
  if (!record || (projectId && record.projectId !== projectId)) throw new HttpError(404, 'Workflow record not found.');
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: record.projectId, repository: projectRepository, tenantId, user });
  const deleted = await repository[method]({ expectedVersion, tenantId, ...id });
  if (!deleted) throw new HttpError(404, 'Workflow record not found.');
  return { ok: true };
}

export async function requestApprovalForUser({ input, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  const projectRole = await projectRoleFor({ projectId: input.projectId, projectRepository, tenantId, user });
  const [snapshot, project] = await Promise.all([
    repository.listSnapshot({ tenantId }), projectRepository.getProjectDetail({ projectId: input.projectId, tenantId }),
  ]);
  const item = flattenProject(project ?? {}).find((record) => record.itemType === input.itemType && record.itemId === input.itemId)?.item;
  if (!item) throw new HttpError(404, 'Project item not found.');
  if (item.status !== input.fromState) throw new HttpError(409, 'The project item is no longer in the requested source state.');
  const { workflow } = workflowForBinding(snapshot, input.projectId, input.itemType);
  const transition = workflow?.transitions.find((candidate) => candidate.key === input.transitionKey
    && candidate.fromState === input.fromState && candidate.toState === input.toState);
  if (!transition?.approvalRequired) throw new HttpError(409, 'This transition does not require approval.');
  const roles = new Set([projectRole, tenantRoleFor(user, tenantId)]);
  if (transition.allowedRoles.length && !transition.allowedRoles.some((role) => roles.has(role))) throw new HttpError(403, 'Your role cannot request this transition.');
  const duplicate = snapshot.approvals.find((approval) => approval.projectId === input.projectId && approval.itemId === input.itemId
    && approval.transitionKey === input.transitionKey && ['pending', 'approved'].includes(approval.status)
    && (!approval.expiresAt || Date.parse(approval.expiresAt) > Date.now()));
  if (duplicate) throw new HttpError(409, 'A current approval already exists for this transition.');
  return { ok: true, value: await repository.requestApproval({ input, requestedBy: user.id, tenantId }) };
}

export async function createBaselineForUser({ input, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: input.projectId, repository: projectRepository, tenantId, user });
  const snapshot = await projectRepository.getProjectDetail({ projectId: input.projectId, tenantId });
  if (!snapshot) throw new HttpError(404, 'Project not found.');
  return { ok: true, value: await repository.createBaseline({ createdBy: user.id, input, snapshot, tenantId }) };
}

export async function decideApprovalForUser({ approvalId, input: { projectId = null, ...input }, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  const snapshot = await repository.listSnapshot({ tenantId });
  const approval = snapshot.approvals.find((record) => record.id === approvalId);
  if (!approval || approval.status !== 'pending' || (projectId && approval.projectId !== projectId)) throw new HttpError(404, 'Workflow approval not found.');
  const access = await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: approval.projectId, repository: projectRepository, tenantId, user });
  if (approval.requestedBy === user.id) throw new HttpError(403, 'Approval requesters cannot approve their own transition.');
  const { workflow } = workflowForBinding(snapshot, approval.projectId, approval.itemType);
  const transition = workflow?.transitions.find((candidate) => candidate.key === approval.transitionKey
    && candidate.fromState === approval.fromState && candidate.toState === approval.toState);
  if (!transition?.approvalRequired) throw new HttpError(409, 'This approval no longer matches an active workflow transition.');
  const roles = new Set([tenantRoleFor(user, tenantId), String(access?.projectRole ?? '').toLowerCase()]);
  if (transition.approverRoles.length && !transition.approverRoles.some((role) => roles.has(role))) {
    throw new HttpError(403, 'Your role cannot decide this workflow approval.');
  }
  const value = await repository.decideApproval({ approvalId, decidedBy: user.id, input, tenantId });
  return { ok: true, value };
}

export async function writeCustomFieldValueForUser({ input, projectRepository, repository, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectId: input.projectId, repository: projectRepository, tenantId, user });
  const snapshot = await repository.listSnapshot({ tenantId });
  const field = snapshot.customFields.find((record) => record.id === input.fieldId && record.status === 'active' && record.scope === input.itemType);
  if (!field) throw new HttpError(404, 'Custom-field definition not found.');
  const project = await projectRepository.getProjectDetail({ projectId: input.projectId, tenantId });
  const itemExists = flattenProject(project ?? {}).some((record) => record.itemType === input.itemType && record.itemId === input.itemId);
  if (!itemExists) throw new HttpError(404, 'Project item not found.');
  assertCustomFieldValue(field, input.value);
  return { ok: true, value: await repository.upsertCustomValue({ input, tenantId }) };
}

export function assertCustomFieldValue(field, value) {
  if (field.fieldType === 'number' && typeof value !== 'number') throw new HttpError(400, 'Custom-field value must be a number.');
  if (field.fieldType === 'boolean' && typeof value !== 'boolean') throw new HttpError(400, 'Custom-field value must be a boolean.');
  if (field.fieldType === 'string' && typeof value !== 'string') throw new HttpError(400, 'Custom-field value must be text.');
  if (field.fieldType === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) throw new HttpError(400, 'Custom-field value must use YYYY-MM-DD.');
  if (field.fieldType === 'enum' && !field.options.includes(value)) throw new HttpError(400, 'Custom-field value is not an allowed option.');
}

export async function getWorkflowDefinitionForUser({ repository, user, workflowId }) {
  const tenantId = tenantIdFor(user);
  const workflow = (await repository.listSnapshot({ tenantId })).workflows.find((record) => record.id === workflowId);
  if (!workflow) throw new HttpError(404, 'Workflow record not found.');
  return { canManage: ['admin', 'manager'].includes(tenantRoleFor(user, tenantId)), value: workflow };
}
