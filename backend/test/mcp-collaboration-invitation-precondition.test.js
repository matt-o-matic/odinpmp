import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryAssistantRepository, createMysqlAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { invitationRecipientIds } from '../src/modules/assistant/clarification-invitation-recipients.js';
import { topicPatchSchema } from '../src/modules/requirements/requirements.schema.js';

// The expected-invitation-recipients precondition on a clarification assignment save, which
// the MCP assign tool always sends. The repository checks it in the same atomic step as the
// save (synchronously in memory; on locked invitation rows in the MySQL transaction), so a
// change made after the caller's preview cannot make the save email an unconfirmed
// stakeholder. The interleaved MCP flow over HTTP is in mcp-collaboration-e2e.test.js.

const TENANT = 'tenant-1';
const PROJECT = 'project-1';
const CLARIFICATION = 'clarification-1';
const stakeholder = (actorId, role = 'collaborator') => ({ actorId, actorType: 'stakeholder', label: actorId, role });

test('the recipient rule: new assignees and never-sent, unscheduled invitations are invited; scheduled, queued, sent or failed ones are not', () => {
  const activeInvitations = [
    { mailStatus: 'sent', queuedAt: '2026-10-01T00:00:00.000Z', stakeholderId: 's-sent' },
    { mailStatus: 'pending', queuedAt: '2026-10-01T00:00:00.000Z', stakeholderId: 's-queued' },
    { mailStatus: 'pending', queuedAt: null, stakeholderId: 's-unqueued' },
    { mailStatus: 'pending', queuedAt: null, scheduledAt: '2026-10-01T00:00:00.000Z', stakeholderId: 's-scheduled' },
    { mailStatus: 'failed', queuedAt: '2026-10-01T00:00:00.000Z', stakeholderId: 's-failed' },
  ];
  assert.deepEqual(invitationRecipientIds({ activeInvitations, stakeholderIds: ['s-new', 's-sent', 's-queued', 's-unqueued', 's-scheduled', 's-failed', 's-new'] }), ['s-new', 's-unqueued']);
});

test('the native schema accepts the precondition only alongside assignments', () => {
  assert.equal(topicPatchSchema.safeParse({ assignments: [], expectedInvitationRecipients: [] }).success, true);
  assert.equal(topicPatchSchema.safeParse({ assignments: [] }).success, true, 'the UI shape is unchanged');
  for (const body of [{ expectedInvitationRecipients: [] }, { assignments: [], expectedInvitationRecipients: [], status: 'resolved' }, { assignments: [], expectedInvitationRecipients: [], prompt: 'Changed' }]) {
    assert.equal(topicPatchSchema.safeParse(body).success, false, JSON.stringify(body));
  }
});

async function inMemoryClarification() {
  const repository = createInMemoryAssistantRepository();
  for (const id of ['s-x', 's-y']) {
    await repository.createProjectStakeholder({ projectId: PROJECT, tenantId: TENANT, value: { email: `${id}@client.example`, id, name: id } });
  }
  await repository.syncProjectClarifications({ clarifications: [{ assignments: [], id: CLARIFICATION, prompt: 'Who signs off?', status: 'open' }], projectId: PROJECT, tenantId: TENANT });
  await repository.updateProjectClarification({ clarificationId: CLARIFICATION, patch: { assignments: [stakeholder('s-x', 'primary')] }, projectId: PROJECT, tenantId: TENANT });
  // As the save's mail step would: s-x has been invited.
  const [invitation] = repository.state.projectClarificationInvitations;
  await repository.markClarificationInvitationQueued({ invitationId: invitation.id, projectId: PROJECT, tenantId: TENANT });
  return repository;
}
const activeFor = (repository) => repository.state.projectClarificationInvitations
  .filter((invitation) => invitation.clarificationId === CLARIFICATION && !invitation.deactivatedAt)
  .map((invitation) => invitation.stakeholderId).sort();
const assignedTo = async (repository) => (await repository.getProjectClarification({ clarificationId: CLARIFICATION, projectId: PROJECT, tenantId: TENANT })).assignments
  .map((assignment) => `${assignment.actorId}:${assignment.role}`).sort();

test('in memory: a mismatched precondition rejects the save before anything changes; a matching one applies it', async () => {
  const repository = await inMemoryClarification();
  assert.deepEqual(activeFor(repository), ['s-x']);

  await assert.rejects(
    repository.updateProjectClarification({ clarificationId: CLARIFICATION, patch: { assignments: [stakeholder('s-x', 'primary'), stakeholder('s-y')], expectedInvitationStakeholderIds: [] }, projectId: PROJECT, tenantId: TENANT }),
    (error) => error.statusCode === 409 && error.details.code === 'invitation_recipients_changed' && error.details.recipients.join() === 's-y',
  );
  assert.deepEqual(await assignedTo(repository), ['s-x:primary'], 'assignments unchanged');
  assert.deepEqual(activeFor(repository), ['s-x'], 'no invitation created');

  // The reviewer's case: a stakeholder removed by another save is no longer invited, so restoring them needs confirmation.
  await repository.updateProjectClarification({ clarificationId: CLARIFICATION, patch: { assignments: [] }, projectId: PROJECT, tenantId: TENANT });
  await assert.rejects(
    repository.updateProjectClarification({ clarificationId: CLARIFICATION, patch: { assignments: [stakeholder('s-x')], expectedInvitationStakeholderIds: [] }, projectId: PROJECT, tenantId: TENANT }),
    (error) => error.statusCode === 409 && error.details.recipients.join() === 's-x',
  );
  assert.deepEqual(activeFor(repository), []);

  await repository.updateProjectClarification({ clarificationId: CLARIFICATION, patch: { assignments: [stakeholder('s-x', 'primary'), stakeholder('s-y')], expectedInvitationStakeholderIds: ['s-y', 's-x'] }, projectId: PROJECT, tenantId: TENANT });
  assert.deepEqual(await assignedTo(repository), ['s-x:primary', 's-y:collaborator']);
  assert.deepEqual(activeFor(repository), ['s-x', 's-y']);
});

test('the save schedules exactly the verified recipients in the same step; a refused save schedules nothing', async () => {
  const repository = await inMemoryClarification();
  const scheduled = () => repository.state.projectClarificationInvitations.filter((invitation) => !invitation.deactivatedAt && invitation.scheduledAt).map((invitation) => invitation.stakeholderId).sort();
  const save = (expected, scheduleInvitationsAt) => repository.updateProjectClarification({
    clarificationId: CLARIFICATION,
    patch: { assignments: [stakeholder('s-x', 'primary'), stakeholder('s-y')], expectedInvitationStakeholderIds: expected, scheduleInvitationsAt },
    projectId: PROJECT,
    tenantId: TENANT,
  });
  await assert.rejects(save([], new Date('2026-10-10T09:00:00.000Z')), (error) => error.statusCode === 409);
  assert.deepEqual(scheduled(), [], 'a refused save schedules nobody');
  await save(['s-y'], new Date('2026-10-10T09:01:00.000Z'));
  assert.deepEqual(scheduled(), ['s-y'], 's-x was already invited, so only s-y joins a digest');
  const sy = repository.state.projectClarificationInvitations.find((invitation) => invitation.stakeholderId === 's-y' && !invitation.deactivatedAt);
  assert.equal(sy.scheduledAt, '2026-10-10T09:01:00.000Z');
});

/** A SQL double for the MySQL repository: records statements and scripts the invitation rows. */
function sqlDouble(invitationRows) {
  const statements = [];
  const events = [];
  const connection = {
    async beginTransaction() { events.push('begin'); },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() { events.push('release'); },
    async execute(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push({ params, text });
      if (/information_schema\.(TABLES|COLUMNS)/.test(text)) return [[{ count: 1 }]];
      if (/information_schema\.KEY_COLUMN_USAGE/.test(text)) return [['tenant_id', 'project_id', 'id'].map((columnName) => ({ columnName }))];
      if (/^SELECT id FROM project_clarifications/.test(text)) return [[{ id: CLARIFICATION }]];
      if (/^SELECT .* FROM project_clarification_invitations/.test(text)) return [invitationRows];
      return [{ affectedRows: 1 }];
    },
  };
  return { connection, events, pool: { getConnection: async () => connection }, statements };
}

function mysqlRepository(double) {
  const repository = createMysqlAssistantRepository({ pool: double.pool });
  repository.getProjectClarification = async () => ({ id: CLARIFICATION });
  return repository;
}

test('MySQL: the precondition reads the invitation rows FOR UPDATE inside the save transaction and rolls back on a mismatch', async () => {
  // s-x's invitation was deactivated by another save that committed after the caller's preview.
  const double = sqlDouble([{ deactivatedAt: new Date(), id: 'inv-x', mailStatus: 'sent', queuedAt: new Date(), stakeholderId: 's-x' }]);
  await assert.rejects(
    mysqlRepository(double).updateProjectClarification({ clarificationId: CLARIFICATION, patch: { assignments: [stakeholder('s-x')], expectedInvitationStakeholderIds: [] }, projectId: PROJECT, tenantId: TENANT }),
    (error) => error.statusCode === 409 && error.details.recipients.join() === 's-x',
  );
  const invitationRead = double.statements.find((statement) => /^SELECT .* FROM project_clarification_invitations/.test(statement.text));
  assert.match(invitationRead.text, /FOR UPDATE$/);
  assert.deepEqual(invitationRead.params, [TENANT, PROJECT, CLARIFICATION]);
  assert.deepEqual(double.events, ['begin', 'rollback', 'release']);
  assert.equal(double.statements.some((statement) => /^(INSERT INTO|UPDATE) project_clarification_invitations/.test(statement.text)), false, 'no invitation written');
  assert.ok(double.statements.findIndex((statement) => statement.text === invitationRead.text) > double.statements.findIndex((statement) => /^DELETE FROM project_clarification_assignments/.test(statement.text)), 'same lock order as the native save: assignments, then invitations');
});

test('MySQL: a matching precondition commits, and a save without one keeps the native unlocked read', async () => {
  const active = [{ deactivatedAt: null, id: 'inv-x', mailStatus: 'sent', queuedAt: new Date(), stakeholderId: 's-x' }];
  const matching = sqlDouble(active);
  await mysqlRepository(matching).updateProjectClarification({ clarificationId: CLARIFICATION, patch: { assignments: [stakeholder('s-x')], expectedInvitationStakeholderIds: [] }, projectId: PROJECT, tenantId: TENANT });
  assert.deepEqual(matching.events, ['begin', 'commit', 'release']);

  const native = sqlDouble(active);
  await mysqlRepository(native).updateProjectClarification({ clarificationId: CLARIFICATION, patch: { assignments: [stakeholder('s-x')] }, projectId: PROJECT, tenantId: TENANT });
  const read = native.statements.find((statement) => /^SELECT .* FROM project_clarification_invitations/.test(statement.text));
  assert.doesNotMatch(read.text, /FOR UPDATE/);
  assert.deepEqual(native.events, ['begin', 'commit', 'release']);
});
