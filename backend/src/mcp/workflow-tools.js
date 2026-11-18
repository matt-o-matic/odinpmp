import { z } from 'zod';
import { OdinApiError } from './api-client.js';
import { textMentionsSomeone } from '../lib/mentions/mention-markup.js';
import { storySplitSchema } from '../modules/projects/projects.schema.js';
import { assertCustomFieldValue } from '../modules/workflows/workflows.service.js';

// Approvals, custom fields, item revisions, story splits and project templates, through Odin's
// workflow and project routes as the signed-in user. Odin checks every write: plan-edit access,
// the roles a transition names, and that nobody approves their own request. Tickets have their
// own tools (and their reporters are emailed on status changes), so these cover the project,
// epics, stories and tasks.

const projectPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}`;
const pick = (record, fields) => Object.fromEntries(fields.filter((key) => key in (record ?? {})).map((key) => [key, record[key]]));
const sameText = (left, right) => String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
const list = (value) => (Array.isArray(value) ? value : []);
const truncate = (value, max) => { const text = String(value ?? ''); return text.length <= max ? text : `${text.slice(0, max - 1)}…`; };
const preview = (method, path, body) => ({ ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method, path, body } });

const ITEM_TYPES = ['project', 'epic', 'story', 'task'];
const ITEM_FIELDS = ['id', 'name', 'status', 'priority', 'points', 'targetHourEstimate', 'assigneeId', 'assigneeName', 'sprintId', 'targetStartDate', 'targetEndDate', 'version'];
const FIELD_FIELDS = ['id', 'name', 'description', 'fieldType', 'options', 'required'];
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'consumed'];
const WORKFLOW_PAGE = 200;
const WORKFLOW_PAGES = 10;

// Odin's REST errors reach tools without their messages, so each tool says what a status means
// for it. Refusals raised before Odin is called (change scope, the tools' own checks) pass through.
async function call(api, errors, method, path, options) {
  try {
    return await api.request(method, path, options);
  } catch (error) {
    const known = error instanceof OdinApiError && error.code === `http_${error.status}` && errors[error.status];
    if (!known) throw error;
    throw new OdinApiError(error.status, known[0], known[1], { outcomeUnknown: error.outcomeUnknown });
  }
}

// GET /api/workflows pages through workflow definitions and returns a project's bindings only for
// the definitions on that page, so finding a project's workflows reads every page.
async function readWorkflowState(api, projectId, { workflows = false } = {}) {
  const limit = workflows ? WORKFLOW_PAGE : 1;
  const state = { bindings: [], workflows: [] };
  for (let page = 0; page < WORKFLOW_PAGES; page += 1) {
    const result = await api.request('GET', '/api/workflows', { query: { limit, offset: page * limit, projectId } });
    if (!page) Object.assign(state, { approvals: list(result.approvals), customFields: list(result.customFields), customValues: list(result.customValues) });
    state.workflows.push(...list(result.workflows));
    state.bindings.push(...list(result.bindings).filter((binding) => binding.projectId === projectId));
    if (!workflows || (page + 1) * limit >= Number(result.total ?? 0)) break;
  }
  return state;
}

function boundWorkflow(state, itemType) {
  const binding = state.bindings.find((entry) => entry.itemType === itemType);
  return binding ? state.workflows.find((workflow) => workflow.id === binding.workflowId) ?? null : null;
}

export function registerWorkflowTools({ api, dryRun, flattenItems, id, page, pageShape, tool }) {
  const readProject = (projectId) => api.request('GET', projectPath(projectId));
  const itemsOf = (project) => new Map([
    [project.id, { id: project.id, itemType: 'project', name: project.name, status: project.status }],
    ...flattenItems(project).map((item) => [item.id, item]),
  ]);
  const requireItem = (items, itemId) => {
    const item = items.get(itemId);
    if (!item) throw new OdinApiError(404, 'item_not_found', 'No epic, story or task with this id on the project. Pass the project id itself for the project.');
    return item;
  };
  async function peopleNames(projectId) {
    const users = await api.request('GET', `${projectPath(projectId)}/valid-users`).catch(() => ({}));
    return new Map([...list(users.tenant_users), ...list(users.project_users)].filter((user) => user.name).map((user) => [user.id, user.name]));
  }

  function presentApproval(approval, { items, names = new Map(), permissions = null, workflow = null } = {}) {
    const transition = workflow?.transitions?.find((entry) => entry.key === approval.transitionKey && entry.fromState === approval.fromState && entry.toState === approval.toState);
    const label = (key) => workflow?.states?.find((state) => state.key === key)?.label ?? key;
    const approverRoles = transition?.approverRoles ?? [];
    const roles = [permissions?.projectRole, permissions?.workspaceRole].filter(Boolean);
    const pending = approval.status === 'pending';
    return {
      id: approval.id, version: approval.version, status: approval.status,
      itemId: approval.itemId, itemType: approval.itemType, itemName: items?.get(approval.itemId)?.name ?? null,
      fromState: approval.fromState, toState: approval.toState, fromLabel: label(approval.fromState), toLabel: label(approval.toState), transitionKey: approval.transitionKey,
      note: truncate(approval.note, 500), requestedBy: names.get(approval.requestedBy) ?? approval.requestedBy, requestedAt: approval.createdAt ?? null, expiresAt: approval.expiresAt ?? null,
      ...(pending ? {} : { decidedBy: names.get(approval.decidedBy) ?? approval.decidedBy ?? null, decidedAt: approval.decidedAt ?? null, decisionNote: truncate(approval.decisionNote, 500) }),
      ...(workflow ? { approverRoles } : {}),
      ...(pending && permissions && workflow ? { yourRoleMayDecide: Boolean(transition?.approvalRequired) && permissions.canEditPlan === true && (!approverRoles.length || approverRoles.some((role) => roles.includes(role))) } : {}),
    };
  }

  tool('odin_list_approvals', [
    'List workflow approvals on a project: sign-offs a workflow requires before an item may move to a status.',
    'status defaults to pending; itemId narrows to one item (the project id for the project itself).',
    'Each names the item, the move (fromState to toState), who asked and why, approverRoles (empty: anyone who can edit the plan)',
    'and yourRoleMayDecide. Nobody may decide their own request. Decide with odin_decide_approval; ask with odin_request_approval.',
  ].join(' '), z.object({ projectId: id, status: z.enum([...APPROVAL_STATUSES, 'all']).default('pending'), itemId: id.optional(), ...pageShape }).strict(), async (args) => {
    const [{ permissions = null, project }, state, names] = await Promise.all([readProject(args.projectId), readWorkflowState(api, args.projectId, { workflows: true }), peopleNames(args.projectId)]);
    const items = itemsOf(project);
    const approvals = state.approvals
      .filter((approval) => approval.projectId === args.projectId && ITEM_TYPES.includes(approval.itemType)
        && (args.status === 'all' || approval.status === args.status) && (!args.itemId || approval.itemId === args.itemId))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map((approval) => presentApproval(approval, { items, names, permissions, workflow: boundWorkflow(state, approval.itemType) }));
    const paged = page(approvals, args, { projectId: args.projectId, status: args.status, itemId: args.itemId, tool: 'approvals' });
    return { ok: true, approvals: paged.items, total: paged.total, nextCursor: paged.nextCursor };
  }, { purpose: 'See approvals (sign-offs on status changes) waiting for a decision, and who may give them.' });

  const REQUEST_ERRORS = {
    403: ['role_denied', 'Your role may not make this status change, so you may not ask for it. The transition\'s allowedRoles in odin_get_workflows say who may.'],
    404: ['http_404', 'Project or item not found, or you cannot edit this project\'s plan.'],
    409: ['http_409', 'The item moved, the move is already requested or approved, or the workflow changed. Check odin_list_approvals and the item\'s status.'],
  };
  tool('odin_request_approval', [
    'Ask for the sign-off a workflow requires before an item may move to a status. Give the item (an epic, story or task, or the project id for the project)',
    'and the status it should move to, by key or label; the tool reads its current status, its workflow and the transition.',
    'Odin records a pending approval that approvers see on their Home and in odin_list_approvals; no email is sent.',
    'You cannot approve your own request. Once someone approves it, make the move with odin_update_item (odin_update_project for the project); the move uses the approval up.',
    'expiresAt (ISO date-time) makes an unused approval lapse. Needs plan-edit access, and one of the transition\'s allowedRoles when it names any.',
  ].join(' '), z.object({
    projectId: id, itemId: id, toState: z.string().trim().min(1).max(120), note: z.string().trim().max(2000).default(''),
    expiresAt: z.string().datetime({ offset: true }).optional(), dryRun,
  }).strict(), async (args) => {
    const path = '/api/workflows/approvals';
    if (args.dryRun) return preview('POST', path, { expiresAt: args.expiresAt ?? null, itemId: args.itemId, note: args.note, projectId: args.projectId, toState: args.toState });
    const [{ project }, state] = await Promise.all([readProject(args.projectId), readWorkflowState(api, args.projectId, { workflows: true })]);
    const items = itemsOf(project);
    const item = requireItem(items, args.itemId);
    const workflow = boundWorkflow(state, item.itemType);
    if (!workflow) throw new OdinApiError(409, 'no_workflow', `No workflow governs ${item.itemType} statuses on this project, so no approval is needed. Change the status directly.`);
    const target = workflow.states.find((entry) => sameText(entry.key, args.toState) || sameText(entry.label, args.toState));
    const transition = target && workflow.transitions.find((entry) => entry.fromState === item.status && entry.toState === target.key);
    if (!transition) {
      const allowed = workflow.transitions.filter((entry) => entry.fromState === item.status).map((entry) => entry.toState);
      throw new OdinApiError(409, 'transition_not_allowed', `The "${workflow.name}" workflow does not move this ${item.itemType} from ${item.status} to ${args.toState}. From ${item.status} it allows: ${allowed.join(', ') || 'nothing'}.`, { details: { allowed, fromState: item.status } });
    }
    if (!transition.approvalRequired) throw new OdinApiError(409, 'approval_not_required', `Moving from ${item.status} to ${target.key} needs no approval. Change the status directly.`);
    const current = state.approvals.find((approval) => approval.projectId === args.projectId && approval.itemId === item.id && approval.transitionKey === transition.key
      && ['pending', 'approved'].includes(approval.status) && (!approval.expiresAt || Date.parse(approval.expiresAt) > Date.now()));
    if (current) {
      throw new OdinApiError(409, 'already_requested', current.status === 'approved' ? 'This move is already approved: make it now.' : 'An approval for this move is already waiting. See it with odin_list_approvals.', { details: { approvalId: current.id, status: current.status } });
    }
    const body = { expiresAt: args.expiresAt ?? null, fromState: item.status, itemId: item.id, itemType: item.itemType, note: args.note, projectId: args.projectId, toState: target.key, transitionKey: transition.key };
    const { value } = await call(api, REQUEST_ERRORS, 'POST', path, { body });
    return { ok: true, approval: presentApproval(value, { items, workflow }) };
  }, { write: true, purpose: 'Ask for approval (a sign-off) to move a work item or the project to a status its workflow gates.' });

  const DECIDE_ERRORS = {
    403: ['not_an_approver', 'You cannot decide this approval: you asked for it, or your role is not one of the transition\'s approverRoles. Someone else must decide it.'],
    404: ['approval_not_found', 'No pending approval with this id on this project, or you cannot edit its plan. It may be decided already; check odin_list_approvals.'],
    409: ['http_409', 'The approval changed since it was read, or the workflow no longer asks for it. Read it again with odin_list_approvals.'],
  };
  tool('odin_decide_approval', [
    'Approve or reject a pending workflow approval (odin_list_approvals lists them). Approving lets the requested status change through once,',
    'made by anyone allowed to make it with odin_update_item; rejecting closes the request, and anyone may ask again. Neither changes the item, and no email is sent.',
    'A decision cannot be undone. Odin allows it only for someone who can edit the plan, did not ask for it, and holds one of the transition\'s approverRoles when it names any.',
    'expectedVersion is the approval\'s version and is read for you when omitted.',
  ].join(' '), z.object({
    projectId: id, approvalId: id, decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(2000).default(''),
    expectedVersion: z.number().int().positive().optional(), dryRun,
  }).strict(), async (args) => {
    const path = `/api/workflows/approvals/${encodeURIComponent(args.approvalId)}/decision`;
    // The project in the body lets Odin hold a grant limited to some projects to their approvals.
    const body = { decisionNote: args.note, expectedVersion: args.expectedVersion, projectId: args.projectId, status: args.decision };
    if (args.dryRun) return preview('POST', path, body);
    // Approvals on tickets stay out of reach, as in odin_list_approvals: an external ticket may await review (D-027).
    const approval = (await readWorkflowState(api, args.projectId)).approvals.find((entry) => entry.id === args.approvalId && entry.projectId === args.projectId);
    if (!approval || !ITEM_TYPES.includes(approval.itemType)) throw new OdinApiError(404, 'approval_not_found', 'No approval with this id on this project. Find it with odin_list_approvals.');
    if (approval.status !== 'pending') throw new OdinApiError(409, 'already_decided', `This approval is already ${approval.status}.`, { details: { status: approval.status } });
    body.expectedVersion ??= approval.version;
    const { value } = await call(api, DECIDE_ERRORS, 'POST', path, { body });
    return {
      ok: true,
      approval: presentApproval(value),
      next: value.status === 'approved' ? `The item may now move from ${value.fromState} to ${value.toState}, once.` : 'The request is closed; anyone may ask again.',
    };
  }, { write: true, destructive: true, confirm: true, purpose: 'Approve or reject a sign-off someone asked for on a status change.' });

  tool('odin_get_custom_fields', [
    'Read the custom fields a project\'s items can carry and the values set on them.',
    'Fields are defined for the whole workspace per item type (appliesTo: project, epic, story or task); values belong to one item.',
    'itemId narrows to one item (the project id for the project itself), itemType to one type. Values are paginated.',
    'Workflow states and transitions can require a field before a status change (requiredFields in odin_get_workflows). Set one with odin_set_custom_field.',
  ].join(' '), z.object({ projectId: id, itemId: id.optional(), itemType: z.enum(ITEM_TYPES).optional(), ...pageShape }).strict(), async (args) => {
    const [{ project }, state] = await Promise.all([readProject(args.projectId), readWorkflowState(api, args.projectId)]);
    const items = itemsOf(project);
    const itemType = args.itemId ? requireItem(items, args.itemId).itemType : args.itemType;
    const fieldsById = new Map(state.customFields.map((field) => [field.id, field]));
    const fields = state.customFields.filter((field) => field.status === 'active' && ITEM_TYPES.includes(field.scope) && (!itemType || field.scope === itemType))
      .map((field) => ({ ...pick(field, FIELD_FIELDS), description: truncate(field.description, 300), appliesTo: field.scope }));
    const values = state.customValues
      .filter((value) => value.projectId === args.projectId && ITEM_TYPES.includes(value.itemType) && (!itemType || value.itemType === itemType) && (!args.itemId || value.itemId === args.itemId))
      .map((value) => {
        const field = fieldsById.get(value.fieldId);
        return {
          itemId: value.itemId, itemType: value.itemType, itemName: items.get(value.itemId)?.name ?? null, fieldId: value.fieldId, field: field?.name ?? null,
          value: typeof value.value === 'string' ? truncate(value.value, 1000) : value.value, version: value.version, ...(field?.status === 'active' ? {} : { fieldInactive: true }),
        };
      });
    const paged = page(values, args, { projectId: args.projectId, itemId: args.itemId, itemType, tool: 'custom-values' });
    return { ok: true, fields, values: paged.items, total: paged.total, nextCursor: paged.nextCursor };
  }, { purpose: 'Read the custom fields on work items (extra fields such as a cost center or acceptance evidence) and their values.' });

  const VALUE_ERRORS = {
    400: ['invalid_value', 'Odin rejected the value for this field\'s type. odin_get_custom_fields lists each field\'s type and options.'],
    403: ['http_403', 'You cannot edit this project\'s plan.'],
    404: ['http_404', 'Item or field not found, or you cannot edit this project\'s plan.'],
    409: ['version_conflict', 'The value changed since it was read. Read it again with odin_get_custom_fields before retrying.'],
  };
  tool('odin_set_custom_field', [
    'Set or clear one custom field on an epic, story or task, or the project itself (pass the project id as itemId).',
    'field is the field\'s id or name (odin_get_custom_fields lists them). value must suit its type: text, a number, true or false,',
    'a YYYY-MM-DD date, or one of an option field\'s options; null clears it. The current value\'s version is read for you unless you pass expectedVersion.',
    'Needs plan-edit access.',
  ].join(' '), z.object({
    projectId: id, itemId: id, field: z.string().trim().min(1).max(160),
    value: z.union([z.string().trim().max(2000), z.number().finite(), z.boolean(), z.null()]),
    expectedVersion: z.number().int().positive().optional(), dryRun,
  }).strict(), async (args) => {
    if (args.dryRun) return preview(args.value === null ? 'DELETE' : 'PUT', '/api/workflows/custom-values', { field: args.field, itemId: args.itemId, projectId: args.projectId, value: args.value });
    const [{ permissions = {}, project }, state] = await Promise.all([readProject(args.projectId), readWorkflowState(api, args.projectId)]);
    const item = requireItem(itemsOf(project), args.itemId);
    // A field on the project itself is a project setting, which change-scope.js leaves to admins and managers.
    if (item.itemType === 'project' && permissions.canEditPlan === true && permissions.canManage === false) {
      throw new OdinApiError(403, 'needs_project_manager', `Only a project admin or manager can change the project's own fields. Your role on this project is ${permissions.projectRole ?? `workspace ${permissions.workspaceRole}`}.`);
    }
    const available = state.customFields.filter((field) => field.status === 'active' && field.scope === item.itemType);
    const field = available.find((entry) => entry.id === args.field) ?? available.find((entry) => sameText(entry.name, args.field));
    if (!field) {
      throw new OdinApiError(404, 'field_not_found', available.length
        ? `No active ${item.itemType} custom field called ${args.field}. ${item.itemType} fields: ${available.map((entry) => entry.name).join(', ')}.`
        : `No custom fields apply to ${item.itemType} items. A workspace admin or manager defines them in Odin.`);
    }
    const current = state.customValues.find((value) => value.projectId === args.projectId && value.itemId === item.id && value.fieldId === field.id);
    const result = { ok: true, itemId: item.id, itemType: item.itemType, field: field.name, fieldId: field.id };
    if (args.value === null) {
      if (!current) return { ...result, changed: false, value: null };
      await call(api, VALUE_ERRORS, 'DELETE', `/api/workflows/custom-values/${encodeURIComponent(current.id)}`, { body: { expectedVersion: args.expectedVersion ?? current.version, projectId: args.projectId } });
      return { ...result, changed: true, value: null };
    }
    try {
      assertCustomFieldValue(field, args.value);
    } catch (error) {
      throw new OdinApiError(400, 'invalid_value', `${field.name}: ${error.message}${field.fieldType === 'enum' ? ` Options: ${field.options.join(', ')}.` : ''}`);
    }
    if (current && current.value === args.value && args.expectedVersion === undefined) return { ...result, changed: false, value: current.value, version: current.version };
    const { value } = await call(api, VALUE_ERRORS, 'PUT', '/api/workflows/custom-values', {
      body: { expectedVersion: args.expectedVersion ?? current?.version ?? null, fieldId: field.id, itemId: item.id, itemType: item.itemType, projectId: args.projectId, value: args.value },
    });
    return { ...result, changed: true, value: value.value, version: value.version };
  }, { write: true, destructive: true, confirm: (args) => args?.value === null, purpose: 'Fill in, change or clear a custom field on a work item or the project.' });

  const RESTORE_ERRORS = {
    404: ['http_404', 'Item or revision not found, or you cannot edit this project\'s plan. Restore a deleted parent before its children.'],
    409: ['http_409', 'Odin refused the restore: the item changed since its version was read, the revision holds no item state, or the project\'s workflow does not allow the status it would bring back (a deleted item returns in its workflow\'s starting status only). Read the item and its revisions again.'],
  };
  tool('odin_restore_item_revision', [
    'Put an epic, story or task back the way it was at one of its revisions (odin_list_item_revisions lists them, newest first, with their ids).',
    'state "after" (default) restores the item as that change left it, "before" as it was just before; restoring a delete revision brings a deleted item back',
    '(restore a parent before its children). The item\'s current version is read for you unless you pass expectedVersion; for a deleted item it is the delete revision\'s versionAfter.',
    'Workflow rules apply to the status it brings back. The restore is recorded as a new revision, so it can itself be restored over.',
  ].join(' '), z.object({ projectId: id, itemId: id, revisionId: id, state: z.enum(['after', 'before']).default('after'), expectedVersion: z.number().int().positive().optional(), dryRun }).strict(), async (args) => {
    const path = `${projectPath(args.projectId)}/items/${encodeURIComponent(args.itemId)}/restore`;
    const body = { expectedVersion: args.expectedVersion, revisionId: args.revisionId, state: args.state };
    if (args.dryRun) return preview('POST', path, body);
    const [{ project }, { revisions = [] }] = await Promise.all([
      readProject(args.projectId),
      call(api, RESTORE_ERRORS, 'GET', `${projectPath(args.projectId)}/items/${encodeURIComponent(args.itemId)}/revisions`, { query: { limit: 100 } }),
    ]);
    const revision = revisions.find((entry) => entry.id === args.revisionId);
    if (!revision) throw new OdinApiError(404, 'revision_not_found', 'This item has no revision with this id among its latest 100. List them with odin_list_item_revisions.');
    if (!['epic', 'story', 'task'].includes(revision.itemType)) throw new OdinApiError(400, 'unsupported_item', 'Only epics, stories and tasks can be restored with this tool.');
    const item = flattenItems(project).find((entry) => entry.id === args.itemId);
    if (body.expectedVersion === undefined) {
      body.expectedVersion = item?.version ?? (revisions[0]?.action === 'delete' ? revisions[0].versionAfter : undefined);
      if (body.expectedVersion === undefined) throw new OdinApiError(404, 'item_not_found', 'The item is not on the project and its latest revision is not a delete. Pass expectedVersion if you know it.');
    }
    const result = await call(api, RESTORE_ERRORS, 'POST', path, { body });
    return {
      ok: true,
      undeleted: !item,
      item: { ...pick(result.item, ITEM_FIELDS), itemType: revision.itemType },
      revision: pick(result.revision, ['id', 'action', 'versionBefore', 'versionAfter', 'createdAt']),
    };
  }, { write: true, destructive: true, purpose: 'Restore (revert or undelete) an epic, story or task to an earlier version from its history.' });

  const splitInput = storySplitSchema.extend({ status: z.string().trim().min(1).max(80).optional() }).strict();
  const SPLIT_ERRORS = {
    400: ['http_400', 'Odin rejected the new story. Check its name, dates, estimates, assignee and sprint.'],
    404: ['http_404', 'Story not found, none of the tasks are on it, or you cannot edit this project\'s plan.'],
  };
  tool('odin_split_story', [
    'Split a story by moving some of its tasks (taskIds) into a new story placed right after it in the same epic.',
    'The new story\'s points and hour estimate default to the moved tasks\' totals, and the original\'s drop by the same amounts.',
    'It keeps the original\'s assignee and dates unless you set them; otherwise priority is 4, description empty and sprint none,',
    'and moved tasks keep their sprints unless you set sprintId. Its status is the story workflow\'s starting status (Not Started without one).',
    'No version precondition. Needs plan-edit access.',
  ].join(' '), z.object({ projectId: id, storyId: id, input: splitInput, dryRun }).strict(), async (args) => {
    const path = `${projectPath(args.projectId)}/stories/${encodeURIComponent(args.storyId)}/split`;
    if (args.dryRun) return preview('POST', path, args.input);
    const [{ project }, state] = await Promise.all([readProject(args.projectId), readWorkflowState(api, args.projectId, { workflows: true })]);
    const items = flattenItems(project);
    if (!items.some((entry) => entry.id === args.storyId && entry.itemType === 'story')) throw new OdinApiError(404, 'story_not_found', 'No story with this id on the project.');
    const tasks = new Set(items.filter((entry) => entry.parentId === args.storyId).map((entry) => entry.id));
    const stray = args.input.taskIds.filter((taskId) => !tasks.has(taskId));
    if (stray.length) throw new OdinApiError(400, 'tasks_not_in_story', `These are not tasks of the story: ${stray.join(', ')}.`, { details: { taskIds: stray } });
    // Odin's split route skips workflow checks, so hold the new story to the rule for new items.
    const initial = boundWorkflow(state, 'story')?.states?.find((entry) => entry.initial)?.key;
    if (initial && args.input.status !== undefined && args.input.status !== initial) {
      throw new OdinApiError(409, 'workflow_initial_state_required', `New stories on this project start in ${initial}. Leave status out, then move the story on with odin_update_item.`);
    }
    // The split moves every task it names, so count them against the change-scope item limit.
    await api.checkItemLimit?.(args.projectId, new Set(args.input.taskIds).size + 1);
    const body = { ...args.input, status: args.input.status ?? initial ?? 'Not Started' };
    const result = await call(api, SPLIT_ERRORS, 'POST', path, { body });
    const after = flattenItems(result.project ?? { epics: [] });
    const original = after.find((entry) => entry.id === args.storyId);
    return {
      ok: true,
      story: { ...pick(result.story, ITEM_FIELDS), taskIds: list(result.story?.tasks).map((task) => task.id) },
      original: original ? { ...pick(original, ITEM_FIELDS), taskIds: after.filter((entry) => entry.parentId === original.id).map((entry) => entry.id) } : null,
    };
  }, { write: true, destructive: true, confirm: (args) => textMentionsSomeone(args?.input?.description), purpose: 'Split a story in two by moving some of its tasks into a new story.' });

  function templateContents(template) {
    const payload = template.payload && typeof template.payload === 'object' ? template.payload : {};
    if (template.kind === 'work_item') return { ...pick(payload, ['itemType', 'priority', 'points']), customFieldDefaults: list(payload.customFieldDefaults).length };
    const epics = list(payload.outline?.epics);
    const stories = epics.flatMap((epic) => list(epic.stories));
    return {
      workflowsFor: list(payload.workflowBindings).map((binding) => binding.itemType),
      customFields: list(payload.customFields).map((field) => `${field.name} (${field.scope})`),
      outline: { epics: epics.length, stories: stories.length, tasks: stories.reduce((total, story) => total + list(story.tasks).length, 0), epicNames: epics.slice(0, 20).map((epic) => epic.name) },
    };
  }
  tool('odin_list_project_templates', [
    'List the workspace\'s templates. Project templates (the default kind) set up a new project\'s workflows, custom fields and starter outline:',
    'pass one\'s id as templateId to odin_create_project. Work-item templates set custom-field defaults on a new item: pass one\'s id as templateId in odin_create_item\'s input.',
    'usable is false when a template needs an update in Odin first. Templates are created and edited in Odin.',
  ].join(' '), z.object({ kind: z.enum(['project', 'work_item']).default('project'), includeInactive: z.boolean().default(false) }).strict(), async (args) => {
    const { templates } = await api.request('GET', '/api/workflows/templates', { query: { kind: args.kind, status: args.includeInactive ? undefined : 'active' } });
    return {
      ok: true,
      kind: args.kind,
      templates: list(templates).map((template) => ({
        id: template.id, name: template.name, description: truncate(template.description, 300),
        ...(args.includeInactive ? { status: template.status } : {}),
        usable: template.status === 'active' && template.payloadStatus === 'valid',
        ...(list(template.payloadIssues).length ? { issues: template.payloadIssues } : {}),
        contents: templateContents(template),
      })),
    };
  }, { purpose: 'Find a template to start a new project (or work item) from.' });
}
