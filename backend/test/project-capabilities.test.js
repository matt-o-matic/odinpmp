import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasProjectCapability,
  PROJECT_CAPABILITIES,
  requireProjectCapability,
} from '../src/lib/auth/project-capabilities.js';

test('project capability matrix separates read, collaboration, file, edit, and administration access', () => {
  assert.equal(hasProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectRole: 'viewer' }), true);
  assert.equal(hasProjectCapability({ capability: PROJECT_CAPABILITIES.FILE_READ, projectRole: 'viewer' }), true);
  assert.equal(hasProjectCapability({ capability: PROJECT_CAPABILITIES.FILE_WRITE, projectRole: 'viewer' }), false);
  assert.equal(hasProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectRole: 'viewer' }), false);
  assert.equal(hasProjectCapability({ capability: PROJECT_CAPABILITIES.COLLABORATE, projectRole: 'user' }), true);
  assert.equal(hasProjectCapability({ capability: PROJECT_CAPABILITIES.FILE_WRITE, projectRole: 'user' }), true);
  assert.equal(hasProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectRole: 'manager' }), true);
  assert.equal(hasProjectCapability({ capability: PROJECT_CAPABILITIES.ADMIN, projectRole: 'manager' }), false);
  assert.equal(hasProjectCapability({ capability: PROJECT_CAPABILITIES.ADMIN, tenantRole: 'admin' }), true);
  assert.equal(hasProjectCapability({ capability: PROJECT_CAPABILITIES.PLAN_EDIT, projectRole: null, tenantRole: 'user', userCapabilities: [PROJECT_CAPABILITIES.PLAN_EDIT] }), true);
});

test('project authorization masks missing membership and resources with the same response', async () => {
  const repository = {
    async getProjectAccess() {
      return { exists: true, projectRole: null };
    },
  };
  const user = {
    id: 'user-1',
    memberships: [{ role: 'user', tenantId: 'tenant-1' }],
  };

  await assert.rejects(
    requireProjectCapability({
      capability: PROJECT_CAPABILITIES.READ,
      projectId: 'project-1',
      repository,
      tenantId: 'tenant-1',
      user,
    }),
    (error) => error.statusCode === 404 && error.message === 'Project not found.',
  );

  await assert.rejects(
    requireProjectCapability({
      capability: PROJECT_CAPABILITIES.READ,
      projectId: 'project-1',
      repository,
      tenantId: 'tenant-other',
      user,
    }),
    (error) => error.statusCode === 404 && error.message === 'Project not found.',
  );
});

test('project authorization allows explicit project membership', async () => {
  const access = await requireProjectCapability({
    capability: PROJECT_CAPABILITIES.PLAN_EDIT,
    projectId: 'project-1',
    repository: {
      async getProjectAccess() {
        return { exists: true, projectRole: 'editor' };
      },
    },
    tenantId: 'tenant-1',
    user: {
      id: 'user-1',
      memberships: [{ role: 'user', tenantId: 'tenant-1' }],
    },
  });

  assert.equal(access.projectRole, 'editor');
});

test('project authorization applies tenant custom-role capabilities', async () => {
  const access = await requireProjectCapability({
    capability: PROJECT_CAPABILITIES.PLAN_EDIT,
    projectId: 'project-1',
    repository: {
      async getProjectAccess() {
        return { exists: true, projectRole: null };
      },
    },
    tenantId: 'tenant-1',
    user: {
      capabilities: [PROJECT_CAPABILITIES.PLAN_EDIT],
      id: 'user-1',
      memberships: [{ role: 'user', tenantId: 'tenant-1' }],
    },
  });

  assert.equal(access.projectRole, null);
});
