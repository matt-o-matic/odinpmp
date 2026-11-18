// Editing model for workflow definitions and workflow templates. Validation mirrors the
// backend rules in backend/src/modules/workflows/workflows.schema.js so problems show while
// editing instead of after a failed save.

export const WORKFLOW_ITEM_TYPES = ['project', 'epic', 'story', 'task', 'ticket'];
export const WORK_ITEM_TYPES = ['epic', 'story', 'task', 'ticket'];
export const WORKFLOW_ROLES = ['admin', 'manager', 'contributor', 'editor', 'member', 'user', 'viewer'];
export const STATE_CATEGORIES = [
  { label: 'Backlog', value: 'backlog' },
  { label: 'Active', value: 'active' },
  { label: 'Done', value: 'done' },
  { label: 'Cancelled', value: 'cancelled' },
];
export const ITEM_TYPE_LABELS = { epic: 'Epic', project: 'Project', story: 'Story', task: 'Task', ticket: 'Ticket' };

const LIMITS = { keyMax: 80, labelMax: 120, nameMax: 240, slaMax: 87600, statesMax: 64, transitionKeyMax: 120, transitionsMax: 256 };

let sequence = 0;
function localId(prefix) {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

export function keyFromLabel(label) {
  return String(label ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, LIMITS.keyMax);
}

function uniqueKey(base, taken) {
  const root = base || 'state';
  let candidate = root;
  for (let index = 2; taken.has(candidate); index += 1) candidate = `${root}_${index}`;
  return candidate;
}

function list(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean) : [];
}

/** Editor rows carry a local `uid` so reordering and key edits keep Vue keys stable. */
export function normalizeState(state = {}) {
  return {
    category: STATE_CATEGORIES.some((category) => category.value === state.category) ? state.category : 'backlog',
    initial: state.initial === true,
    key: String(state.key ?? ''),
    label: String(state.label ?? ''),
    requiredFields: list(state.requiredFields),
    slaHours: Number.isFinite(Number(state.slaHours)) ? Number(state.slaHours) : 0,
    terminal: state.terminal === true,
    uid: state.uid ?? localId('state'),
  };
}

export function normalizeTransition(transition = {}) {
  return {
    allowedRoles: list(transition.allowedRoles),
    approvalRequired: transition.approvalRequired === true,
    approverRoles: list(transition.approverRoles),
    fromState: String(transition.fromState ?? ''),
    key: String(transition.key ?? ''),
    requiredFields: list(transition.requiredFields),
    toState: String(transition.toState ?? ''),
    uid: transition.uid ?? localId('transition'),
  };
}

export function normalizeWorkflowModel(record = {}) {
  return {
    description: String(record.description ?? ''),
    itemTypes: list(record.itemTypes).filter((type) => WORKFLOW_ITEM_TYPES.includes(type)),
    name: String(record.name ?? ''),
    states: (record.states ?? []).map(normalizeState),
    status: record.status === 'inactive' ? 'inactive' : 'active',
    transitions: (record.transitions ?? []).map(normalizeTransition),
  };
}

export function createWorkflowDraft() {
  return normalizeWorkflowModel({
    itemTypes: ['story'],
    states: [
      { category: 'backlog', initial: true, key: 'ready', label: 'Ready' },
      { category: 'active', key: 'in_progress', label: 'In progress' },
      { category: 'done', key: 'done', label: 'Done', terminal: true },
    ],
    transitions: [
      { fromState: 'ready', key: 'start', toState: 'in_progress' },
      { fromState: 'in_progress', key: 'finish', toState: 'done' },
    ],
  });
}

export function createState(model) {
  const taken = new Set(model.states.map((state) => state.key));
  const key = uniqueKey('new_state', taken);
  return normalizeState({ category: 'active', initial: model.states.length === 0, key, label: 'New state' });
}

export function createTransition(model) {
  const [from, to] = [model.states[0]?.key ?? '', model.states[1]?.key ?? model.states[0]?.key ?? ''];
  const taken = new Set(model.transitions.map((transition) => transition.key));
  return normalizeTransition({ fromState: from, key: uniqueKey(keyFromLabel(`${from} to ${to}`) || 'transition', taken), toState: to });
}

export function moveEntry(entries, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= entries.length) return entries;
  const next = [...entries];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Changing a state key keeps transitions pointing at the same state. */
export function renameStateKey(model, previousKey, nextKey) {
  if (!previousKey || previousKey === nextKey) return model.transitions;
  return model.transitions.map((transition) => ({
    ...transition,
    fromState: transition.fromState === previousKey ? nextKey : transition.fromState,
    toState: transition.toState === previousKey ? nextKey : transition.toState,
  }));
}

export function removeState(model, uid) {
  const state = model.states.find((entry) => entry.uid === uid);
  return {
    states: model.states.filter((entry) => entry.uid !== uid),
    transitions: model.transitions.filter((transition) => transition.fromState !== state?.key && transition.toState !== state?.key),
  };
}

export function parseFieldList(text) {
  return [...new Set(String(text ?? '').split(',').map((entry) => entry.trim()).filter(Boolean))].slice(0, 32);
}

/**
 * Errors block saving (the backend would reject them); warnings point at likely mistakes.
 * Each message carries a `target` so the editor can show it next to the field.
 */
export function validateWorkflowModel(model, { requireName = true } = {}) {
  const errors = [];
  const warnings = [];
  const error = (target, message) => errors.push({ message, target });
  if (requireName && !model.name.trim()) error('name', 'Enter a workflow name.');
  if (model.name.length > LIMITS.nameMax) error('name', `Workflow names can be up to ${LIMITS.nameMax} characters.`);
  if (!model.itemTypes.length) error('itemTypes', 'Choose at least one item type.');
  if (!model.states.length) error('states', 'Add at least one state.');
  if (model.states.length > LIMITS.statesMax) error('states', `A workflow can have up to ${LIMITS.statesMax} states.`);
  if (model.transitions.length > LIMITS.transitionsMax) error('transitions', `A workflow can have up to ${LIMITS.transitionsMax} transitions.`);

  const keys = model.states.map((state) => state.key.trim());
  model.states.forEach((state, index) => {
    const row = `state:${state.uid}`;
    const label = state.label.trim() || `State ${index + 1}`;
    if (!state.label.trim()) error(row, `State ${index + 1} needs a label.`);
    if (!state.key.trim()) error(row, `${label} needs a key.`);
    else if (keys.indexOf(state.key.trim()) !== index) error(row, `State key "${state.key.trim()}" is used more than once.`);
    if (state.key.trim().length > LIMITS.keyMax) error(row, `${label}: keys can be up to ${LIMITS.keyMax} characters.`);
    if (!Number.isInteger(state.slaHours) || state.slaHours < 0 || state.slaHours > LIMITS.slaMax) error(row, `${label}: SLA hours must be a whole number from 0 to ${LIMITS.slaMax}.`);
  });
  const initialCount = model.states.filter((state) => state.initial).length;
  if (model.states.length && initialCount !== 1) error('states', initialCount ? 'Mark only one state as initial.' : 'Mark one state as initial.');

  const transitionKeys = model.transitions.map((transition) => transition.key.trim());
  const pairs = new Set();
  model.transitions.forEach((transition, index) => {
    const row = `transition:${transition.uid}`;
    const label = transition.key.trim() || `Transition ${index + 1}`;
    if (!transition.key.trim()) error(row, `Transition ${index + 1} needs a key.`);
    else if (transitionKeys.indexOf(transition.key.trim()) !== index) error(row, `Transition key "${transition.key.trim()}" is used more than once.`);
    if (!keys.includes(transition.fromState)) error(row, `${label}: choose a defined "from" state.`);
    if (!keys.includes(transition.toState)) error(row, `${label}: choose a defined "to" state.`);
    const pair = `${transition.fromState}->${transition.toState}`;
    if (pairs.has(pair)) warnings.push({ message: `${label}: another transition already moves ${transition.fromState} to ${transition.toState}; only the first one is used.`, target: row });
    pairs.add(pair);
    if (transition.approvalRequired && !transition.approverRoles.length) {
      warnings.push({ message: `${label}: no approver roles are set, so anyone who can edit the plan (except the requester) can approve.`, target: row });
    }
  });

  const initial = model.states.find((state) => state.initial);
  if (initial && !errors.length) {
    const reachable = new Set([initial.key]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const transition of model.transitions) {
        if (reachable.has(transition.fromState) && !reachable.has(transition.toState)) { reachable.add(transition.toState); grew = true; }
      }
    }
    const unreachable = model.states.filter((state) => !reachable.has(state.key)).map((state) => state.label || state.key);
    if (unreachable.length) warnings.push({ message: `Unreachable from the initial state: ${unreachable.join(', ')}.`, target: 'transitions' });
  }
  return { errors, ok: errors.length === 0, warnings };
}

/** The workflow body sent to the API, without editor-only fields. */
export function workflowBody(model) {
  return {
    description: model.description.trim(),
    itemTypes: [...model.itemTypes],
    states: model.states.map(({ uid: _uid, ...state }) => ({ ...state, key: state.key.trim(), label: state.label.trim() })),
    transitions: model.transitions.map(({ uid: _uid, ...transition }) => ({ ...transition, key: transition.key.trim() })),
  };
}

export function definitionPayload(model) {
  return { ...workflowBody(model), name: model.name.trim(), status: model.status };
}

/** States grouped by category for the read-only state machine preview. */
export function previewColumns(model) {
  return STATE_CATEGORIES.map((category) => ({
    ...category,
    states: model.states.filter((state) => state.category === category.value).map((state) => ({
      ...state,
      outgoing: model.transitions.filter((transition) => transition.fromState === state.key).map((transition) => ({
        ...transition,
        toLabel: model.states.find((candidate) => candidate.key === transition.toState)?.label || transition.toState,
      })),
    })),
  })).filter((column) => column.states.length > 0);
}
