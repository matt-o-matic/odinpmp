// Template drafts, payloads and application helpers. Payload shapes match the typed schemas in
// backend/src/modules/workflows/workflows.schema.js; legacy rows the backend marks
// `needs_update` open with an empty draft of their kind instead of failing.
import {
  createWorkflowDraft,
  normalizeWorkflowModel,
  validateWorkflowModel,
  workflowBody,
} from './workflow-model.js';

export const TEMPLATE_KINDS = [
  { description: 'Workflow bindings, a starter outline and custom fields for new projects.', label: 'Project', value: 'project' },
  { description: 'A reusable set of states and transitions.', label: 'Workflow', value: 'workflow' },
  { description: 'Default text, estimate and fields for a new epic, story, task or ticket.', label: 'Work item', value: 'work_item' },
];
export const TICKET_CATEGORY_OPTIONS = [
  { label: 'Defect', value: 'defect' },
  { label: 'Support', value: 'support' },
  { label: 'Question', value: 'question' },
  { label: 'Change request', value: 'change_request' },
];
export const TICKET_SEVERITY_OPTIONS = ['S1', 'S2', 'S3', 'S4'];
export const PRIORITY_OPTIONS = [
  { label: 'Highest', value: 1 },
  { label: 'High', value: 2 },
  { label: 'Medium High', value: 3 },
  { label: 'Medium', value: 4 },
  { label: 'Medium Low', value: 5 },
  { label: 'Low', value: 6 },
  { label: 'Lowest', value: 7 },
];
export const OUTLINE_LIMIT = 500;

export function templateKindLabel(kind) {
  return TEMPLATE_KINDS.find((entry) => entry.value === kind)?.label ?? kind;
}

export function templateNeedsUpdate(template) {
  return template?.payloadStatus === 'needs_update';
}

/** Active templates whose payload matches the current schema, optionally for one item type. */
export function usableTemplates(templates, kind, itemType = '') {
  return (templates ?? []).filter((template) => template.kind === kind && template.status === 'active'
    && !templateNeedsUpdate(template) && (!itemType || template.payload?.itemType === itemType));
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function pointsValue(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function createOutlineNode(level) {
  const node = { description: '', name: '', points: null };
  if (level === 'epic') node.stories = [];
  if (level === 'story') node.tasks = [];
  return node;
}

function outlineFrom(payload) {
  return (payload?.outline?.epics ?? []).map((epic) => ({
    description: text(epic.description),
    name: text(epic.name),
    points: pointsValue(epic.points),
    stories: (epic.stories ?? []).map((story) => ({
      description: text(story.description),
      name: text(story.name),
      points: pointsValue(story.points),
      tasks: (story.tasks ?? []).map((task) => ({ description: text(task.description), name: text(task.name), points: pointsValue(task.points) })),
    })),
  }));
}

export function createPayloadDraft(kind, payload = null) {
  const usable = payload && typeof payload === 'object';
  if (kind === 'workflow') return usable && Array.isArray(payload.states) ? normalizeWorkflowModel(payload) : createWorkflowDraft();
  if (kind === 'project') {
    return {
      customFields: usable && Array.isArray(payload.customFields)
        ? payload.customFields.map((field) => ({ description: text(field.description), fieldType: field.fieldType ?? 'string', name: text(field.name), optionsText: (field.options ?? []).join(', '), required: field.required === true, scope: field.scope ?? 'story' }))
        : [],
      epics: usable ? outlineFrom(payload) : [],
      workflowBindings: usable && Array.isArray(payload.workflowBindings)
        ? payload.workflowBindings.map((binding) => ({ itemType: binding.itemType ?? 'story', source: binding.sourceKind && binding.sourceId ? `${binding.sourceKind}:${binding.sourceId}` : '' }))
        : [],
    };
  }
  return {
    acceptanceCriteria: usable ? text(payload.acceptanceCriteria) : '',
    category: usable ? payload.category ?? '' : '',
    customFieldDefaults: usable && Array.isArray(payload.customFieldDefaults) ? payload.customFieldDefaults.map((entry) => ({ fieldId: entry.fieldId ?? '', value: typeof entry.value === 'boolean' ? String(entry.value) : entry.value ?? '' })) : [],
    description: usable ? text(payload.description) : '',
    itemType: usable && payload.itemType ? payload.itemType : 'story',
    points: usable && pointsValue(payload.points) !== null ? String(payload.points) : '',
    priority: usable && payload.priority ? String(payload.priority) : '',
    severity: usable ? payload.severity ?? '' : '',
  };
}

function outlineCount(epics) {
  return epics.reduce((total, epic) => total + 1 + epic.stories.reduce((count, story) => count + 1 + story.tasks.length, 0), 0);
}

function customFieldValue(field, raw) {
  if (field?.fieldType === 'number') return raw === '' ? Number.NaN : Number(raw);
  if (field?.fieldType === 'boolean') return raw === true || raw === 'true';
  return typeof raw === 'string' ? raw.trim() : raw;
}

/**
 * Validates a payload draft and builds the API payload. `customFields` are the tenant's
 * custom-field definitions, used to type work-item defaults.
 */
export function buildTemplatePayload(kind, draft, { customFields = [] } = {}) {
  const errors = [];
  if (kind === 'workflow') {
    const validation = validateWorkflowModel(draft, { requireName: false });
    return { errors: validation.errors.map((entry) => entry.message), payload: workflowBody(draft), warnings: validation.warnings.map((entry) => entry.message) };
  }
  if (kind === 'project') {
    const bindings = draft.workflowBindings.map((binding) => {
      const [sourceKind, ...rest] = binding.source.split(':');
      return { itemType: binding.itemType, sourceId: rest.join(':'), sourceKind };
    });
    if (bindings.some((binding) => !binding.sourceId)) errors.push('Choose a workflow for every binding.');
    const types = bindings.map((binding) => binding.itemType);
    if (new Set(types).size !== types.length) errors.push('Bind each item type at most once.');
    const walk = (nodes, level) => nodes.forEach((node) => {
      if (!node.name.trim()) errors.push(`Every ${level} in the outline needs a name.`);
      if (node.points !== null && node.points !== '' && !(Number.isInteger(Number(node.points)) && Number(node.points) >= 0 && Number(node.points) <= 999)) errors.push(`Points for "${node.name || level}" must be a whole number from 0 to 999.`);
      if (node.stories) walk(node.stories, 'story');
      if (node.tasks) walk(node.tasks, 'task');
    });
    walk(draft.epics, 'epic');
    if (outlineCount(draft.epics) > OUTLINE_LIMIT) errors.push(`A starter outline can hold up to ${OUTLINE_LIMIT} items.`);
    const fields = draft.customFields.map((field) => ({
      description: field.description.trim(),
      fieldType: field.fieldType,
      name: field.name.trim(),
      options: field.fieldType === 'enum' ? field.optionsText.split(',').map((option) => option.trim()).filter(Boolean) : [],
      required: field.required,
      scope: field.scope,
    }));
    if (fields.some((field) => !field.name)) errors.push('Every custom field needs a name.');
    if (fields.some((field) => field.fieldType === 'enum' && !field.options.length)) errors.push('Choice fields need at least one option.');
    const fieldKeys = fields.map((field) => `${field.scope}:${field.name.toLowerCase()}`);
    if (new Set(fieldKeys).size !== fieldKeys.length) errors.push('Custom field names must be unique per item type.');
    if (!bindings.length && !draft.epics.length && !fields.length) errors.push('Add a workflow binding, a starter outline, or a custom field.');
    const node = (entry) => ({ description: entry.description.trim(), name: entry.name.trim(), points: entry.points === '' || entry.points === null ? null : Number(entry.points) });
    const payload = {
      customFields: fields,
      outline: { epics: draft.epics.map((epic) => ({ ...node(epic), stories: epic.stories.map((story) => ({ ...node(story), tasks: story.tasks.map(node) })) })) },
      workflowBindings: bindings,
    };
    return { errors: [...new Set(errors)], payload, warnings: [] };
  }

  const isTicket = draft.itemType === 'ticket';
  const points = String(draft.points ?? '').trim();
  if (points && !(/^\d+$/.test(points) && Number(points) <= 999)) errors.push('Points must be a whole number from 0 to 999.');
  const defaults = draft.customFieldDefaults.map((entry) => {
    const field = customFields.find((candidate) => candidate.id === entry.fieldId);
    if (!field) { errors.push('Choose a custom field for every default.'); return entry; }
    if (field.scope !== draft.itemType) errors.push(`${field.name} is not a ${draft.itemType} field.`);
    const value = customFieldValue(field, entry.value);
    if (field.fieldType === 'number' && !Number.isFinite(value)) errors.push(`${field.name} needs a number.`);
    if (field.fieldType === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${field.name} needs a date.`);
    if (field.fieldType === 'enum' && !field.options.includes(value)) errors.push(`Choose an option for ${field.name}.`);
    return { fieldId: field.id, value };
  });
  const ids = defaults.map((entry) => entry.fieldId);
  if (new Set(ids).size !== ids.length) errors.push('Set each custom field default once.');
  return {
    errors: [...new Set(errors)],
    payload: {
      acceptanceCriteria: draft.acceptanceCriteria.trim(),
      category: isTicket && draft.category ? draft.category : null,
      customFieldDefaults: defaults,
      description: draft.description.trim(),
      itemType: draft.itemType,
      points: points ? Number(points) : null,
      priority: draft.priority ? Number(draft.priority) : null,
      severity: isTicket && draft.severity ? draft.severity : null,
    },
    warnings: [],
  };
}

/** A definition editor model prefilled from a workflow template. */
export function definitionDraftFromWorkflowTemplate(template) {
  return normalizeWorkflowModel({ ...template.payload, description: template.payload?.description || template.description, name: template.name, status: 'active' });
}

export function composeItemDescription(description, acceptanceCriteria) {
  const body = String(description ?? '').trim();
  const criteria = String(acceptanceCriteria ?? '').trim();
  if (!criteria) return body;
  return [body, `**Acceptance criteria**\n\n${criteria}`].filter(Boolean).join('\n\n');
}

/** The item fields a work-item template fills in. */
export function workItemTemplateDefaults(template) {
  const payload = template?.payload ?? {};
  const defaults = { description: composeItemDescription(payload.description, payload.acceptanceCriteria) };
  if (Number.isInteger(payload.points)) defaults.points = payload.points;
  if (Number.isInteger(payload.priority)) defaults.priority = payload.priority;
  if (payload.itemType === 'ticket') {
    if (payload.category) defaults.category = payload.category;
    if (payload.severity) defaults.severity = payload.severity;
  }
  return defaults;
}

/**
 * Prefills an unsaved plan item in place. `workItemTemplateId` rides along to the item create
 * call so the server can record the template's custom-field defaults.
 */
export function applyWorkItemTemplateToNode(node, template) {
  if (!template) {
    delete node.workItemTemplateId;
    return node;
  }
  const defaults = workItemTemplateDefaults(template);
  node.description = defaults.description;
  if (defaults.points != null) node.points = defaults.points;
  if (defaults.priority != null) node.priority = defaults.priority;
  node.workItemTemplateId = template.id;
  return node;
}

/** A short plain-language summary of what a project template sets up. */
export function projectTemplateSummary(template) {
  const payload = template?.payload ?? {};
  const epics = payload.outline?.epics ?? [];
  const parts = [];
  if (payload.workflowBindings?.length) parts.push(`${payload.workflowBindings.length} workflow binding${payload.workflowBindings.length === 1 ? '' : 's'}`);
  if (epics.length) parts.push(`${outlineCount(outlineFrom(payload))} outline item${outlineCount(outlineFrom(payload)) === 1 ? '' : 's'}`);
  if (payload.customFields?.length) parts.push(`${payload.customFields.length} custom field${payload.customFields.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** Status choices for a project created without a template, or from one that binds no project workflow. */
export const PROJECT_STATUS_OPTIONS = Object.freeze(['Planned', 'In Progress', 'At Risk', 'Completed'].map((status) => ({ label: status, value: status })));

/** The workflow a project template binds to the project itself, or null. */
export function projectWorkflowBinding(template) {
  return template?.payload?.workflowBindings?.find((binding) => binding.itemType === 'project') ?? null;
}

/**
 * The statuses a project created from `template` may start in: the states of the workflow the
 * template binds to the project, defaulting to its initial state. Null when the template binds
 * no project workflow, so the fixed status list applies. The workflow comes from
 * `workflowTemplates` (active workflow templates) or from `loadDefinition(id)` for an existing
 * workflow definition. Throws when that workflow can't be found.
 */
export async function resolveTemplateProjectStatuses(template, { loadDefinition, workflowTemplates = [] }) {
  const binding = projectWorkflowBinding(template);
  if (!binding) return null;
  const fromTemplate = binding.sourceKind === 'workflow_template';
  const source = fromTemplate
    ? usableTemplates(workflowTemplates, 'workflow').find((candidate) => candidate.id === binding.sourceId)
    : await loadDefinition(binding.sourceId);
  const usable = fromTemplate || source?.status === 'active';
  const states = (usable ? (fromTemplate ? source?.payload?.states : source?.states) : null) ?? [];
  if (!states.length) throw new Error('The template’s project workflow is unavailable.');
  return {
    initial: (states.find((state) => state.initial) ?? states[0]).key,
    options: states.map((state) => ({ label: state.label || state.key, value: state.key })),
    workflowName: source.name,
  };
}
