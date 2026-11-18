// Default ticket lifecycle (D-022).
//
// No transition carries approvalRequired, requiredFields, or allowedRoles: triage is an
// ordinary status rather than a gate (D-013) and there is no verification state (D-009).
// The `closed -> open` transition is the reopen path, and it is recorded in transition
// history so reopen rate stays derivable even though no metrics ship in v1 (D-016).
//
// These labels are client-facing: D-021 makes status changes visible to external reporters.

export const TICKET_WORKFLOW_NAME = 'Ticket lifecycle';

export const TICKET_WORKFLOW_STATES = [
  { category: 'backlog', initial: true, key: 'new', label: 'New', requiredFields: [], slaHours: 0, terminal: false },
  { category: 'backlog', initial: false, key: 'triage', label: 'Triage', requiredFields: [], slaHours: 0, terminal: false },
  { category: 'backlog', initial: false, key: 'open', label: 'Open', requiredFields: [], slaHours: 0, terminal: false },
  { category: 'active', initial: false, key: 'in_progress', label: 'In Progress', requiredFields: [], slaHours: 0, terminal: false },
  { category: 'active', initial: false, key: 'resolved', label: 'Resolved', requiredFields: [], slaHours: 0, terminal: false },
  { category: 'done', initial: false, key: 'closed', label: 'Closed', requiredFields: [], slaHours: 0, terminal: true },
  { category: 'cancelled', initial: false, key: 'rejected', label: 'Rejected', requiredFields: [], slaHours: 0, terminal: true },
  { category: 'cancelled', initial: false, key: 'deferred', label: 'Deferred', requiredFields: [], slaHours: 0, terminal: true },
];

function transition(fromState, toState) {
  return {
    allowedRoles: [],
    approvalRequired: false,
    approverRoles: [],
    fromState,
    key: `${fromState}__${toState}`,
    requiredFields: [],
    toState,
  };
}

export const TICKET_WORKFLOW_TRANSITIONS = [
  transition('new', 'triage'),
  transition('triage', 'open'),
  transition('open', 'in_progress'),
  transition('in_progress', 'resolved'),
  transition('resolved', 'closed'),
  transition('triage', 'rejected'),
  transition('triage', 'deferred'),
  transition('open', 'rejected'),
  transition('open', 'deferred'),
  transition('deferred', 'open'),
  // Reopen path (D-009): there is no verification gate, so a closed ticket returns to open.
  transition('closed', 'open'),
];

export function buildTicketWorkflowDefinition() {
  return {
    description: 'Default ticket lifecycle for defects, support requests, questions, and change requests.',
    itemTypes: ['ticket'],
    name: TICKET_WORKFLOW_NAME,
    states: TICKET_WORKFLOW_STATES.map((state) => ({ ...state })),
    status: 'active',
    transitions: TICKET_WORKFLOW_TRANSITIONS.map((entry) => ({ ...entry })),
  };
}

/**
 * Creates the default ticket workflow for a tenant if it is absent, and binds it to the
 * project's `ticket` item type when no binding exists yet (AC3.1).
 *
 * A project that has already rebound `ticket` to a custom workflow is left alone (AC3.4).
 */
export async function ensureTicketWorkflowBinding({ projectId, repository, tenantId }) {
  if (!repository || !tenantId || !projectId) {
    return null;
  }

  const snapshot = await repository.listSnapshot({ tenantId });
  let workflow = snapshot.workflows.find((candidate) => candidate.name === TICKET_WORKFLOW_NAME);

  if (!workflow) {
    workflow = await repository.createWorkflow({ input: buildTicketWorkflowDefinition(), tenantId });
  }

  const existingBinding = snapshot.bindings.find(
    (binding) => binding.projectId === projectId && binding.itemType === 'ticket',
  );

  if (existingBinding) {
    return { binding: existingBinding, workflow };
  }

  const binding = await repository.createBinding({
    input: { itemType: 'ticket', projectId, workflowId: workflow.id },
    tenantId,
  });

  return { binding, workflow };
}
