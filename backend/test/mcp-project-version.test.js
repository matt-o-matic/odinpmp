import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';

test('project metadata versions advance when the clock has not advanced', async (t) => {
  const fixed = new Date('2026-10-01T12:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: fixed });
  const repository = createInMemoryProjectsRepository({ authRepository: { state: { tenants: [{ id: 'tenant-local' }], users: [{ id: 'fixture' }] } }, seed: { projects: [{ id: 'project-local', tenantId: 'tenant-local', name: 'Disposable fixture', status: 'Planned', updatedAt: fixed.toISOString(), epics: [] }] } });
  const input = { name: 'Updated fixture', status: 'In Progress', description: '', startDate: null, endDate: null, expectedUpdatedAt: fixed.toISOString() };
  const updated = await repository.updateProject({ input, projectId: 'project-local', tenantId: 'tenant-local', user: { id: 'fixture' } });
  assert.ok(Date.parse(updated.updatedAt) > fixed.getTime());
  await assert.rejects(repository.updateProject({ input, projectId: 'project-local', tenantId: 'tenant-local', user: { id: 'fixture' } }), (error) => error.statusCode === 409 && error.details.code === 'project_version_conflict');
});
