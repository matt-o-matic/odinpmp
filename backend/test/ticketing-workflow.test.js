import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TICKET_WORKFLOW_NAME,
  TICKET_WORKFLOW_STATES,
  TICKET_WORKFLOW_TRANSITIONS,
  buildTicketWorkflowDefinition,
  ensureTicketWorkflowBinding,
} from '../src/modules/workflows/ticket-workflow.js';
import { buildWorkflowTransitionPlan } from '../src/modules/workflows/workflows.service.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';
import { workflowDefinitionCreateSchema } from '../src/modules/workflows/workflows.schema.js';

const TENANT_ID = 'tenant-acme';
const USER = { id: 'user-grace', memberships: [{ role: 'admin', tenantId: TENANT_ID }] };

function projectWithTicket(ticket) {
  return { epics: [], id: 'project-launch', name: 'Launch', status: 'In Progress', tickets: ticket ? [ticket] : [] };
}

async function seededRepository() {
  const repository = createInMemoryWorkflowRepository();
  const result = await ensureTicketWorkflowBinding({ projectId: 'project-launch', repository, tenantId: TENANT_ID });
  return { repository, ...result };
}

async function snapshotFor(repository) {
  return repository.listSnapshot({ tenantId: TENANT_ID });
}

function planFor({ current, next, snapshot }) {
  return buildWorkflowTransitionPlan({
    currentProject: current,
    nextProject: next,
    projectRole: 'admin',
    snapshot,
    tenantId: TENANT_ID,
    user: USER,
  });
}

test('the default ticket lifecycle is a valid workflow definition', () => {
  const parsed = workflowDefinitionCreateSchema.safeParse(buildTicketWorkflowDefinition());
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test('AC3.1 creating the binding seeds the workflow and binds it to the ticket item type', async () => {
  const { binding, repository, workflow } = await seededRepository();

  assert.equal(workflow.name, TICKET_WORKFLOW_NAME);
  assert.deepEqual(workflow.itemTypes, ['ticket']);
  assert.equal(binding.itemType, 'ticket');
  assert.equal(binding.projectId, 'project-launch');

  const snapshot = await snapshotFor(repository);
  assert.equal(snapshot.workflows.length, 1);
  assert.equal(snapshot.bindings.length, 1);
});

test('AC3.1 binding a second project reuses the existing workflow definition', async () => {
  const { repository, workflow } = await seededRepository();

  const second = await ensureTicketWorkflowBinding({ projectId: 'project-support', repository, tenantId: TENANT_ID });

  assert.equal(second.workflow.id, workflow.id);
  const snapshot = await snapshotFor(repository);
  assert.equal(snapshot.workflows.length, 1);
  assert.equal(snapshot.bindings.length, 2);
});

test('AC3.4 an existing custom binding is preserved rather than overwritten', async () => {
  const repository = createInMemoryWorkflowRepository();
  const custom = await repository.createWorkflow({
    input: {
      description: 'Custom',
      itemTypes: ['ticket'],
      name: 'Custom ticket flow',
      states: [{ category: 'backlog', initial: true, key: 'new', label: 'New', requiredFields: [], slaHours: 0, terminal: false }],
      status: 'active',
      transitions: [],
    },
    tenantId: TENANT_ID,
  });
  await repository.createBinding({ input: { itemType: 'ticket', projectId: 'project-launch', workflowId: custom.id }, tenantId: TENANT_ID });

  const result = await ensureTicketWorkflowBinding({ projectId: 'project-launch', repository, tenantId: TENANT_ID });

  assert.equal(result.binding.workflowId, custom.id);
  const snapshot = await snapshotFor(repository);
  assert.equal(snapshot.bindings.filter((binding) => binding.projectId === 'project-launch').length, 1);
});

test('AC3.2 every lifecycle transition is executable with no role restriction or approval', async () => {
  const { repository } = await seededRepository();
  const snapshot = await snapshotFor(repository);

  for (const transition of TICKET_WORKFLOW_TRANSITIONS) {
    const current = projectWithTicket({ id: 'ticket-1', name: 'T', status: transition.fromState, version: 1 });
    const next = projectWithTicket({ id: 'ticket-1', name: 'T', status: transition.toState, version: 1 });

    const plan = planFor({ current, next, snapshot });
    assert.equal(plan.length, 1, `${transition.fromState} -> ${transition.toState} should plan one transition`);
    assert.equal(plan[0].transitionKey, transition.key);
    assert.equal(plan[0].approvalId ?? null, null);
  }

  assert.ok(TICKET_WORKFLOW_TRANSITIONS.every((transition) => transition.approvalRequired === false));
  assert.ok(TICKET_WORKFLOW_TRANSITIONS.every((transition) => transition.allowedRoles.length === 0));
  assert.ok(TICKET_WORKFLOW_TRANSITIONS.every((transition) => transition.requiredFields.length === 0));
});

test('AC3.3 closed to open is a recordable reopen transition', async () => {
  const { repository } = await seededRepository();
  const snapshot = await snapshotFor(repository);

  const plan = planFor({
    current: projectWithTicket({ id: 'ticket-1', name: 'T', status: 'closed', version: 1 }),
    next: projectWithTicket({ id: 'ticket-1', name: 'T', status: 'open', version: 1 }),
    snapshot,
  });

  assert.equal(plan.length, 1);
  assert.equal(plan[0].fromState, 'closed');
  assert.equal(plan[0].toState, 'open');

  const recorded = await repository.recordTransition(plan[0]);
  assert.equal(recorded.fromState, 'closed');
  assert.equal(recorded.toState, 'open');
  assert.ok(recorded.occurredAt);
});

test('a transition outside the lifecycle is still rejected', async () => {
  const { repository } = await seededRepository();
  const snapshot = await snapshotFor(repository);

  assert.throws(
    () => planFor({
      current: projectWithTicket({ id: 'ticket-1', name: 'T', status: 'new', version: 1 }),
      next: projectWithTicket({ id: 'ticket-1', name: 'T', status: 'closed', version: 1 }),
      snapshot,
    }),
    /Workflow does not allow new to transition to closed/,
  );
});

test('new tickets must start in the initial state', async () => {
  const { repository } = await seededRepository();
  const snapshot = await snapshotFor(repository);

  assert.throws(
    () => planFor({
      current: projectWithTicket(null),
      next: projectWithTicket({ id: 'ticket-1', name: 'T', status: 'in_progress', version: 1 }),
      snapshot,
    }),
    /must begin in New/,
  );
});

test('AC3.5 epic, story, and task bindings are unaffected by the ticket workflow', async () => {
  const { repository } = await seededRepository();
  const snapshot = await snapshotFor(repository);

  const current = { epics: [{ id: 'epic-1', name: 'E', status: 'Anything', stories: [] }], id: 'project-launch', name: 'Launch', status: 'In Progress', tickets: [] };
  const next = { ...current, epics: [{ id: 'epic-1', name: 'E', status: 'Something Else', stories: [] }] };

  // No epic binding exists, so no workflow gating applies to epics.
  assert.deepEqual(planFor({ current, next, snapshot }), []);
});

test('lifecycle states carry the categories the board relies on', () => {
  const byKey = new Map(TICKET_WORKFLOW_STATES.map((state) => [state.key, state]));

  assert.equal(byKey.get('new').initial, true);
  assert.equal(TICKET_WORKFLOW_STATES.filter((state) => state.initial).length, 1);
  assert.equal(byKey.get('closed').terminal, true);
  assert.equal(byKey.get('rejected').terminal, true);
  assert.equal(byKey.get('deferred').terminal, true);
  assert.equal(byKey.get('in_progress').category, 'active');
  assert.equal(byKey.get('closed').category, 'done');
  assert.equal(byKey.get('rejected').category, 'cancelled');
});
