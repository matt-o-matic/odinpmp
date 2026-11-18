import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRequireDecisionRights,
  hasDecisionRights,
  requireDecisionRights,
  resolveDecisionRights,
} from '../src/lib/auth/decision-rights.js';

const TENANT = 'tenant-1';
const PROJECT = 'project-1';

function repositoryFor(projectRole, { exists = true } = {}) {
  return {
    async getProjectAccess({ projectId, tenantId }) {
      if (projectId !== PROJECT || tenantId !== TENANT) return { exists: false, projectRole: null };
      return { exists, projectRole };
    },
  };
}

function userWith(tenantRole) {
  return { id: 'user-1', memberships: [{ role: tenantRole, tenantId: TENANT }] };
}

// Project admin or manager, or tenant admin or manager.
const ROLE_CASES = [
  { allowed: false, label: 'viewer', projectRole: 'viewer', tenantRole: 'user' },
  { allowed: false, label: 'member', projectRole: 'member', tenantRole: 'user' },
  { allowed: false, label: 'user', projectRole: 'user', tenantRole: 'user' },
  { allowed: false, label: 'contributor', projectRole: 'contributor', tenantRole: 'user' },
  { allowed: false, label: 'editor', projectRole: 'editor', tenantRole: 'user' },
  { allowed: true, label: 'project manager', projectRole: 'manager', tenantRole: 'user' },
  { allowed: true, label: 'project admin', projectRole: 'admin', tenantRole: 'user' },
  { allowed: true, label: 'tenant manager without project role', projectRole: null, tenantRole: 'manager' },
  { allowed: true, label: 'tenant admin without project role', projectRole: null, tenantRole: 'admin' },
  { allowed: false, label: 'tenant user without project role', projectRole: null, tenantRole: 'user' },
];

for (const roleCase of ROLE_CASES) {
  test(`decision rights: ${roleCase.label} ${roleCase.allowed ? 'can' : 'cannot'} decide`, async () => {
    assert.equal(hasDecisionRights({ projectRole: roleCase.projectRole, tenantRole: roleCase.tenantRole }), roleCase.allowed);

    const user = userWith(roleCase.tenantRole);
    const repository = repositoryFor(roleCase.projectRole);
    const resolved = await resolveDecisionRights({ projectId: PROJECT, repository, tenantId: TENANT, user });
    assert.equal(resolved.allowed, roleCase.allowed);

    if (roleCase.allowed) {
      await requireDecisionRights({ projectId: PROJECT, repository, tenantId: TENANT, user });
    } else {
      await assert.rejects(
        requireDecisionRights({ projectId: PROJECT, repository, tenantId: TENANT, user }),
        (error) => error.statusCode === 404 && error.message === 'Project not found.',
      );
    }
  });
}

test('decision rights are case-insensitive and ignore unrelated capabilities', () => {
  assert.equal(hasDecisionRights({ projectRole: 'Manager' }), true);
  assert.equal(hasDecisionRights({ tenantRole: ' ADMIN ' }), true);
  assert.equal(hasDecisionRights({ projectRole: 'owner', tenantRole: 'user' }), false);
  assert.equal(hasDecisionRights({}), false);
});

test('decision rights deny a missing project, a foreign tenant, and a user without membership', async () => {
  const admin = userWith('admin');
  await assert.rejects(
    requireDecisionRights({ projectId: PROJECT, repository: repositoryFor('admin', { exists: false }), tenantId: TENANT, user: admin }),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    requireDecisionRights({ projectId: PROJECT, repository: repositoryFor('admin'), tenantId: 'tenant-other', user: admin }),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    requireDecisionRights({ projectId: PROJECT, repository: repositoryFor('admin'), tenantId: TENANT, user: { id: 'user-2', memberships: [] } }),
    (error) => error.statusCode === 404,
  );
});

test('decision rights middleware passes managers and returns 404 to members', async () => {
  const middleware = createRequireDecisionRights({ projectRepository: repositoryFor('member') });
  const errors = [];
  await middleware({ auth: { user: userWith('user') }, params: { projectId: PROJECT } }, {}, (error) => errors.push(error ?? null));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.statusCode, 404);

  const managerMiddleware = createRequireDecisionRights({ projectRepository: repositoryFor('manager') });
  const passes = [];
  await managerMiddleware({ auth: { user: userWith('user') }, params: { projectId: PROJECT } }, {}, (error) => passes.push(error ?? null));
  assert.deepEqual(passes, [null]);
});
