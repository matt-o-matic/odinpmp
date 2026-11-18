import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryDomainEventOutboxRepository } from '../src/lib/events/domain-event-outbox.js';
import { applyRecoveryActions } from '../src/modules/assistant/assistant-recovery-actions.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryGovernanceRepository } from '../src/modules/governance/governance.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';

const TENANT = 'tenant-acme';
const PROJECT = 'project-portal';
const user = { id: 'user-sam', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Sam Ortiz' };

async function setup() {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: TENANT, name: 'Acme' }],
    users: [
      { email: 'sam@acme.com', id: 'user-sam', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Sam Ortiz', passwordHash: 'unused' },
      { email: 'dana@acme.com', id: 'user-dana', memberships: [{ role: 'user', tenantId: TENANT }], name: 'Dana Reyes', passwordHash: 'unused' },
    ],
  });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projects: [{
        epics: [{
          id: 'epic-1',
          name: 'Portal',
          stories: [
            { assigneeId: 'user-sam', id: 'story-netsuite', name: 'Map NetSuite cost centers', points: 8, sprintId: 'sprint-14', status: 'Not Started' },
            { assigneeId: 'user-sam', id: 'story-export', name: 'CSV export', points: 5, sprintId: 'sprint-14', status: 'Not Started' },
            {
              assigneeId: 'user-sam', id: 'story-kanban', name: 'Saved kanban views', sprintId: 'sprint-14', status: 'In Progress',
              tasks: [
                { id: 'task-kv1', name: 'Per-user storage', points: 7, sprintId: 'sprint-14', status: 'Completed' },
                { id: 'task-kv2', name: 'Share views', points: 2, sprintId: 'sprint-14', status: 'Not Started' },
              ],
            },
          ],
        }],
        id: PROJECT,
        name: 'Customer Portal Rebuild',
        status: 'In Progress',
        tenantId: TENANT,
      }],
      sprints: [
        { endDate: '2026-10-16', id: 'sprint-14', name: 'Sprint 14', projectId: PROJECT, sortOrder: 1, startDate: '2026-10-05', status: 'active' },
        { endDate: '2026-10-30', id: 'sprint-15', name: 'Sprint 15', projectId: PROJECT, sortOrder: 2, startDate: '2026-10-19', status: 'planned' },
      ],
    },
  });
  const governanceRepository = createInMemoryGovernanceRepository();
  const milestone = await governanceRepository.createMilestone({ input: { status: 'planned', targetDate: '2026-10-28', title: 'Pilot ready', workItemId: null }, projectId: PROJECT, tenantId: TENANT });
  return { domainEventOutboxRepository: createInMemoryDomainEventOutboxRepository(), governanceRepository, milestone, projectRepository };
}

async function nodesNow(projectRepository) {
  const project = await projectRepository.getProjectDetail({ projectId: PROJECT, tenantId: TENANT });
  const nodes = new Map();
  for (const story of project.epics[0].stories) {
    nodes.set(story.id, story);
    for (const task of story.tasks ?? []) nodes.set(task.id, task);
  }
  return { nodes, project };
}

// What home-recovery.js stores with a move or split when it is staged.
async function expectedNow(projectRepository, itemIds, openSprintIds = ['sprint-15']) {
  const { nodes } = await nodesNow(projectRepository);
  return {
    items: itemIds.map((id) => ({ id, name: nodes.get(id).name, sprintId: nodes.get(id).sprintId ?? null, status: nodes.get(id).status, version: nodes.get(id).version })),
    openSprintIds,
  };
}

function move(itemId, expected) {
  return { createPayload: { expected, input: { assignments: [{ itemId, itemType: 'story', sprintId: 'sprint-15' }] } }, id: `action-move-${itemId}`, targetId: 'sprint-14', type: 'sprint_items_move' };
}

function splitKanban(expected) {
  return { createPayload: { expected, input: { name: 'Saved kanban views (follow-up)', sprintId: 'sprint-15', status: 'Not Started', taskIds: ['task-kv2'] } }, id: 'action-split', targetId: 'story-kanban', type: 'story_split' };
}

const RISK_TITLE = 'Sprint 14 may not finish about 8 points';

// What home-recovery.js stages for Raise a risk.
function raiseRisk() {
  return {
    createPayload: { input: { description: '3 of 15 points closed.', dueDate: '2026-10-16', impact: 'high', kind: 'risk', ownerId: 'user-sam', probability: 'high', status: 'open', title: RISK_TITLE } },
    id: 'action-risk',
    targetId: 'sprint-14',
    type: 'governance_item_create',
  };
}

async function complete(projectRepository, itemId) {
  const { nodes } = await nodesNow(projectRepository);
  await projectRepository.updateProjectItem({ input: { expectedVersion: nodes.get(itemId).version, patch: { status: 'Completed' } }, itemId, projectId: PROJECT, tenantId: TENANT, user });
}

test('each recovery action applies through the repository call behind its route', async () => {
  const { domainEventOutboxRepository, governanceRepository, milestone, projectRepository } = await setup();
  const { nodes } = await nodesNow(projectRepository);
  const actions = [
    move('story-export', await expectedNow(projectRepository, ['story-export'])),
    { createPayload: { input: { assigneeId: 'user-dana', expectedVersion: nodes.get('story-netsuite').version } }, id: 'action-reassign', targetId: 'story-netsuite', type: 'assignee_change' },
    { createPayload: { input: { expectedVersion: milestone.version, targetDate: '2026-11-02' } }, id: 'action-milestone', targetId: milestone.id, type: 'milestone_shift' },
    splitKanban(await expectedNow(projectRepository, ['story-kanban', 'task-kv2'])),
    raiseRisk(),
  ];
  await applyRecoveryActions({ actions, domainEventOutboxRepository, governanceRepository, projectId: PROJECT, projectRepository, tenantId: TENANT, user });

  const { nodes: after, project } = await nodesNow(projectRepository);
  assert.equal(after.get('story-export').sprintId, 'sprint-15');
  assert.equal(after.get('story-netsuite').assigneeId, 'user-dana');
  const followUp = project.epics[0].stories.find((entry) => entry.name === 'Saved kanban views (follow-up)');
  assert.deepEqual(followUp.tasks.map((task) => [task.id, task.sprintId]), [['task-kv2', 'sprint-15']]);
  assert.deepEqual(after.get('story-kanban').tasks.map((task) => task.id), ['task-kv1']);
  const snapshot = await governanceRepository.listSnapshot({ projectId: PROJECT, tenantId: TENANT });
  assert.equal(snapshot.milestones[0].targetDate, '2026-11-02');
  const [risk] = snapshot.items;
  assert.deepEqual(
    [risk.kind, risk.title, risk.status, risk.impact, risk.probability, risk.ownerId, risk.dueDate],
    ['risk', RISK_TITLE, 'open', 'high', 'high', 'user-sam', '2026-10-16'],
  );
  assert.ok(actions.every((action) => action.appliedRecord), 'each applied action records what it changed');
  // The milestone shift and the risk queue the events the governance routes queue.
  const events = await domainEventOutboxRepository.list();
  assert.deepEqual(events.map((event) => [event.eventType, event.payload.action, event.payload.entityType, event.payload.entityId, event.projectId]), [
    ['governance.changed', 'updated', 'milestone', milestone.id, PROJECT],
    ['governance.changed', 'created', 'governance_item', risk.id, PROJECT],
  ]);
});

test('a staged risk is refused when an open risk with its title was raised since', async () => {
  const { governanceRepository, projectRepository } = await setup();
  const apply = (action) => applyRecoveryActions({ actions: [action], governanceRepository, projectId: PROJECT, projectRepository, tenantId: TENANT, user });
  await apply(raiseRisk());
  await assert.rejects(apply(raiseRisk()), (error) => error.statusCode === 409 && error.details?.code === 'recovery_stale');
  const { items } = await governanceRepository.listSnapshot({ projectId: PROJECT, tenantId: TENANT });
  assert.equal(items.length, 1, 'no second risk');

  // Once the first is closed, the same risk can be raised again.
  await governanceRepository.updateItem({ input: { expectedVersion: items[0].version, status: 'closed' }, itemId: items[0].id, projectId: PROJECT, tenantId: TENANT });
  await apply(raiseRisk());
  assert.equal((await governanceRepository.listSnapshot({ projectId: PROJECT, tenantId: TENANT })).items.length, 2);
});

test('a change type the apply step does not know is refused, not skipped', async () => {
  const { governanceRepository, projectRepository } = await setup();
  const action = { createPayload: { input: {} }, id: 'action-other', targetId: 'x', type: 'brief_patch' };
  await assert.rejects(
    applyRecoveryActions({ actions: [action], governanceRepository, projectId: PROJECT, projectRepository, tenantId: TENANT, user }),
    (error) => error.statusCode === 400 && error.details?.code === 'recovery_unsupported',
  );
  assert.equal(action.appliedRecord, undefined);
});

test('a staged move or split refuses with 409 when its items or target sprint changed since staging', async () => {
  const { governanceRepository, projectRepository } = await setup();
  const apply = (action) => applyRecoveryActions({ actions: [action], governanceRepository, projectId: PROJECT, projectRepository, tenantId: TENANT, user });
  const stale = (error) => error.statusCode === 409 && error.details?.code === 'recovery_stale';

  // Staged while CSV export and Share views were unstarted; both were finished since.
  const staleMove = move('story-export', await expectedNow(projectRepository, ['story-export']));
  const staleSplit = splitKanban(await expectedNow(projectRepository, ['story-kanban', 'task-kv2']));
  await complete(projectRepository, 'story-export');
  await complete(projectRepository, 'task-kv2');
  await assert.rejects(apply(staleMove), stale);
  await assert.rejects(apply(staleSplit), stale);
  const { nodes } = await nodesNow(projectRepository);
  assert.equal(nodes.get('story-export').sprintId, 'sprint-14', 'nothing moved');
  assert.deepEqual(nodes.get('story-kanban').tasks.map((task) => task.id), ['task-kv1', 'task-kv2'], 'nothing split');

  // The target sprint closed after staging.
  const toClosed = move('story-netsuite', await expectedNow(projectRepository, ['story-netsuite']));
  await projectRepository.updateProjectSprintStatus({ projectId: PROJECT, sprintId: 'sprint-15', status: 'completed', tenantId: TENANT });
  await assert.rejects(apply(toClosed), (error) => stale(error) && error.details.sprintId === 'sprint-15');

  // A move staged without its expectations is refused rather than applied blind.
  await assert.rejects(apply({ ...toClosed, createPayload: { input: toClosed.createPayload.input } }), stale);
});

test('reassignments and milestone shifts refuse stale versions, and a missing store is a 503', async () => {
  const { governanceRepository, milestone, projectRepository } = await setup();
  await assert.rejects(
    applyRecoveryActions({ actions: [{ createPayload: { input: { assigneeId: 'user-dana', expectedVersion: 99 } }, targetId: 'story-netsuite', type: 'assignee_change' }], governanceRepository, projectId: PROJECT, projectRepository, tenantId: TENANT, user }),
    (error) => error.statusCode === 409,
  );
  await assert.rejects(
    applyRecoveryActions({ actions: [{ createPayload: { input: { expectedVersion: milestone.version + 1, targetDate: '2026-11-02' } }, targetId: milestone.id, type: 'milestone_shift' }], governanceRepository, projectId: PROJECT, projectRepository, tenantId: TENANT, user }),
    (error) => error.statusCode === 409,
  );
  await assert.rejects(
    applyRecoveryActions({ actions: [{ createPayload: { input: { expectedVersion: 1, targetDate: '2026-11-02' } }, targetId: milestone.id, type: 'milestone_shift' }], governanceRepository: null, projectId: PROJECT, projectRepository, tenantId: TENANT, user }),
    (error) => error.statusCode === 503,
  );
});
