import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createMysqlAgentExecutionRepository } from '../src/modules/assistant/agent-execution.repository.js';
import { createMysqlAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createMysqlGovernanceRepository } from '../src/modules/governance/governance.repository.js';
import { getHomeForUser } from '../src/modules/home/home.service.js';
import { createMysqlMetricsRepository } from '../src/modules/metrics/metrics.repository.js';
import { createMysqlProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createMysqlReportingRepository } from '../src/modules/reporting/reporting.repository.js';
import { createMysqlRequirementsRepository } from '../src/modules/requirements/requirements.repository.js';
import { requirementsServiceDeps } from '../src/modules/requirements/requirements.routes.js';
import { createMysqlWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';

// Counts the statements one Home load sends on the MySQL path, so a change that turns a
// per-project read into a per-item one, or puts schema checks back on the request path, fails
// here. The fake driver answers every schema probe "exists" and every other read with no rows,
// except the project list, project rows and project access, which describe PROJECT_COUNT
// projects the viewer manages.

const TENANT = 'tenant-acme';
const PROJECT_COUNT = 4;
const projectIds = Array.from({ length: PROJECT_COUNT }, (_, index) => `project-${index + 1}`);

function projectRow(id) {
  return { createdAt: new Date('2026-07-01T00:00:00Z'), description: '', endDate: '2026-12-04', id, name: id, projectRole: 'manager', rank: 1, startDate: '2026-07-01', status: 'In Progress', tenantId: TENANT, updatedAt: new Date('2026-10-01T00:00:00Z') };
}

export function createCountingPool({ onStatement = null } = {}) {
  const statements = [];
  const execute = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    statements.push(text);
    onStatement?.(text);
    if (/information_schema/i.test(text)) return [[{ count: 1, total: 1 }], []];
    if (/^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i.test(text)) return [{ affectedRows: 0, insertId: 0 }, []];
    if (/FROM projects p LEFT JOIN user_project up/.test(text) && /ORDER BY p\.`rank`/.test(text)) return [projectIds.map(projectRow), []];
    if (/^SELECT p\.id, up\.role AS projectRole FROM projects p/.test(text)) return [[{ id: params[1], projectRole: 'manager' }], []];
    if (/FROM projects p INNER JOIN project_statuses ps/.test(text) && /WHERE p\.id = \?/.test(text)) return [[projectRow(params[0])], []];
    return [[], []];
  };
  const connection = { beginTransaction: async () => {}, commit: async () => {}, execute, query: execute, release() {}, rollback: async () => {} };
  return { execute, getConnection: async () => connection, query: execute, statements };
}

export async function homeDeps(pool) {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: TENANT, name: 'Acme' }],
    users: [{ email: 'priya@acme.com', id: 'user-priya', memberships: [{ role: 'manager', tenantId: TENANT }], name: 'Priya', passwordHash: 'unused' }],
  });
  const projectRepository = createMysqlProjectsRepository({ fileStorage: { async delete() {}, async read() { return null; }, async write() {} }, pool });
  const assistantRepository = createMysqlAssistantRepository({ pool });
  const deps = {
    agentExecutionRepository: createMysqlAgentExecutionRepository({ pool }),
    assistantRepository,
    authRepository,
    governanceRepository: createMysqlGovernanceRepository({ pool }),
    homeClock: () => new Date('2026-10-12T15:00:00.000Z'),
    metricsRepository: createMysqlMetricsRepository({ pool }),
    projectRepository,
    reportingRepository: createMysqlReportingRepository({ pool }),
    workflowRepository: createMysqlWorkflowRepository({ pool }),
  };
  deps.requirements = requirementsServiceDeps({ ...deps, requirementsRepository: createMysqlRequirementsRepository({ pool }) });
  return { authRepository, deps };
}

export async function measureHomeLoad() {
  const pool = createCountingPool();
  const { authRepository, deps } = await homeDeps(pool);
  const user = await authRepository.findUserById('user-priya');
  await getHomeForUser(deps, { lens: 'team', user });
  const first = [...pool.statements];
  pool.statements.length = 0;
  await getHomeForUser(deps, { lens: 'team', user });
  return { first, second: [...pool.statements] };
}

// A warm Team load of four projects sent 694 statements before the 2026-10-12 review (429 of
// them information_schema probes, 53 DDL, a warehouse write under FOR UPDATE) and 128 after:
// about 12 per project for detail, sprints, governance and relations, 18 for the requirements
// "my items" read the projects list also makes, and 8 for the whole page.
const PER_PROJECT_LIMIT = 32;
const PER_PAGE_LIMIT = 12;

test('one Home load sends a bounded number of statements per project and no schema checks once warm', async () => {
  const { first, second } = await measureHomeLoad();
  assert.deepEqual(second.filter((sql) => /information_schema|^(CREATE|ALTER|DROP)\b/i.test(sql)), [], 'schema checks stay off the request path after the first load');
  assert.deepEqual(second.filter((sql) => /^(INSERT|UPDATE|DELETE)\b/i.test(sql)), [], 'loading Home writes nothing');
  assert.deepEqual(second.filter((sql) => /FOR UPDATE/i.test(sql)), [], 'Home reads never lock rows');
  assert.ok(second.length <= PER_PROJECT_LIMIT * PROJECT_COUNT + PER_PAGE_LIMIT, `${second.length} statements for ${PROJECT_COUNT} projects`);
  // Workflow history is read for these projects and past-SLA transitions only.
  assert.ok(second.every((sql) => !/FROM workflow_transition_history WHERE tenant_id = \? ORDER BY/.test(sql)), 'no tenant-wide history read');
  assert.ok(first.length > second.length, 'the first load warms the schema checks');
});
