import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository, createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemoryTenantsRepository } from '../src/modules/tenants/tenants.repository.js';

const TENANT = 'tenant-acme';
const USER = { id: 'user-grace', memberships: [{ role: 'admin', tenantId: TENANT }], name: 'Grace Hopper' };
const LISTS = {
  environments: [
    { id: 'env-staging', name: 'Staging', projectId: null, sortOrder: 0, status: 'active' },
    { id: 'env-retired', name: 'Retired', projectId: null, sortOrder: 1, status: 'inactive' },
    { id: 'env-launch-lab', name: 'Launch lab', projectId: 'project-launch', sortOrder: 2, status: 'active' },
    { id: 'env-other-lab', name: 'Other lab', projectId: 'project-other', sortOrder: 3, status: 'active' },
  ],
  releases: [{ id: 'rel-1', name: '1.0', projectId: null, sortOrder: 0, status: 'active' }],
};

// Each case runs against both repositories, which must refuse the same writes the same way.
const CASES = [
  { expected: null, item: { environmentId: 'env-staging', fixedInReleaseId: 'rel-1', foundInReleaseId: 'rel-1' }, name: 'active tenant-wide entries' },
  { expected: null, item: { environmentId: 'env-launch-lab' }, name: 'an entry scoped to this project' },
  { expected: 'Unknown environment for this tenant.', item: { environmentId: 'env-missing' }, name: 'an unknown environment' },
  { expected: 'Unknown environment for this tenant.', item: { environmentId: 'env-other-lab' }, name: "another project's environment" },
  { expected: 'The selected environment is inactive.', item: { environmentId: 'env-retired' }, name: 'an inactive environment' },
  { expected: 'Unknown found-in release for this tenant.', item: { foundInReleaseId: 'rel-missing' }, name: 'an unknown found-in release' },
  { expected: 'Unknown fixed-in release for this tenant.', item: { fixedInReleaseId: 'rel-missing' }, name: 'an unknown fixed-in release' },
];

async function createInMemory() {
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ domains: ['acme.com'], id: TENANT, name: 'Acme' }], users: [{ ...USER, authMethod: 'basic', email: 'grace@acme.com', password: 'Secret123!' }] });
  const tenantsRepository = createInMemoryTenantsRepository({ authRepository });
  for (const [kind, entries] of Object.entries(LISTS)) await tenantsRepository.saveTicketConfigList({ entries, kind, tenantId: TENANT });
  return createInMemoryProjectsRepository({
    authRepository,
    seed: { projects: [{ epics: [], id: 'project-launch', name: 'Launch', status: 'In Progress', tenantId: TENANT, updatedAt: '2026-10-01T00:00:00.000Z' }] },
    ticketConfigRepository: tenantsRepository,
  });
}

const TASK_TYPES = ['Epic', 'Story', 'Task', 'Ticket'].map((name, index) => ({ deleted: 0, id: `type-${name.toLowerCase()}`, projectId: null, sortOrder: index, taskTypeName: name, tenantId: null }));

// Answers the reads createProjectItem makes; list entries come from LISTS by table and scope.
function createFakeMysqlPool() {
  const statements = [];
  const execute = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    statements.push({ params, sql: text });
    if (/information_schema/i.test(text)) return [[{ count: 1 }]];
    if (/^SELECT id FROM projects WHERE id = \?/.test(text)) return [[{ id: params[0] }]];
    if (/FROM task_types/.test(text)) return [TASK_TYPES];
    if (/AS nextPosition/.test(text)) return [[{ nextPosition: 0 }]];
    const list = text.match(/^SELECT id, status FROM (tenant_environments|tenant_releases) WHERE id = \? AND tenant_id = \? AND \(project_id IS NULL OR project_id = \?\)/);
    if (list) {
      const [id, tenantId, projectId] = params;
      const entries = LISTS[list[1] === 'tenant_environments' ? 'environments' : 'releases'];
      return [entries.filter((entry) => entry.id === id && tenantId === TENANT && (!entry.projectId || entry.projectId === projectId)).map(({ id: entryId, status }) => ({ id: entryId, status }))];
    }
    if (/^(INSERT|UPDATE|DELETE)/i.test(text)) return [{ affectedRows: 1 }];
    return [[]];
  };
  const connection = { beginTransaction: async () => {}, commit: async () => {}, execute, query: execute, release() {}, rollback: async () => {} };
  return { execute, getConnection: async () => connection, query: execute, statements };
}

async function attemptCreate(repository, item) {
  try {
    const result = await repository.createProjectItem({ input: { item: { name: 'Checkout total is wrong', ...item }, itemType: 'ticket', parentId: null }, projectId: 'project-launch', tenantId: TENANT, user: USER });
    return { result };
  } catch (error) {
    return { error };
  }
}

for (const { expected, item, name } of CASES) {
  test(`ticket references: both repositories ${expected ? 'refuse' : 'accept'} ${name}`, async () => {
    const { error: memoryError, result: memoryResult } = await attemptCreate(await createInMemory(), item);

    const pool = createFakeMysqlPool();
    const { error: mysqlError } = await attemptCreate(createMysqlProjectsRepository({ pool }), item);
    const ticketInserts = pool.statements.filter((statement) => /^INSERT INTO tasks /.test(statement.sql));

    if (!expected) {
      assert.equal(memoryError, undefined, memoryError?.message);
      assert.equal(memoryResult.item.name, 'Checkout total is wrong');
      // The fake driver can't read the saved row back, so MySQL only proves it got to the insert.
      assert.equal(ticketInserts.length, 1, mysqlError?.message);
      return;
    }
    for (const [label, error] of [['in-memory', memoryError], ['MySQL', mysqlError]]) {
      assert.equal(error?.statusCode, 400, `${label}: ${error?.message}`);
      assert.equal(error.message, expected, label);
    }
    assert.equal(ticketInserts.length, 0, 'MySQL refuses before writing the ticket');
  });
}

// MySQL updateProjectItem passes the patch through the same check (read, not run here).
test('ticket references: an update checks only the fields it changes', async () => {
  const repository = await createInMemory();
  const created = await repository.createProjectItem({ input: { item: { environmentId: 'env-staging', name: 'Logo is misaligned' }, itemType: 'ticket', parentId: null }, projectId: 'project-launch', tenantId: TENANT, user: USER });
  const update = (patch) => repository.updateProjectItem({ input: { expectedVersion: created.item.version, patch }, itemId: created.item.id, projectId: 'project-launch', tenantId: TENANT, user: USER });
  await assert.rejects(update({ environmentId: 'env-other-lab' }), { message: 'Unknown environment for this tenant.', statusCode: 400 });
  await assert.rejects(update({ fixedInReleaseId: 'rel-missing' }), { message: 'Unknown fixed-in release for this tenant.', statusCode: 400 });
  assert.equal((await update({ severity: 'S1' })).item.environmentId, 'env-staging');
});
