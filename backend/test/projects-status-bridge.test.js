import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMysqlProjectsRepository,
  ensureMysqlProjectPlanningSchema,
} from '../src/modules/projects/projects.repository.js';

function createMysqlProjectStatusPool(initialProjectStatuses = null) {
  const projectStatuses = initialProjectStatuses ?? [
    { id: 'status-abandoned', projectStatusName: 'Abandoned' },
    { id: 'status-candidate', projectStatusName: 'Candidate' },
    { id: 'status-delayed', projectStatusName: 'Delayed' },
    { id: 'status-done', projectStatusName: 'Done' },
    { id: 'status-planning', projectStatusName: 'Planning' },
    { id: 'status-rejected', projectStatusName: 'Rejected' },
    { id: 'status-started', projectStatusName: 'Started' },
    { id: 'status-review', projectStatusName: 'Under Review' },
  ];
  const projects = [];
  const memberships = [];
  const taskTypes = [];
  const executed = [];

  function statusById(statusId) {
    return projectStatuses.find((item) => item.id === statusId) ?? null;
  }

  function buildProjectRow(project) {
    const status = statusById(project.projectStatusId);
    return {
      createdAt: project.createdAt,
      description: project.description,
      endDate: project.endDate,
      id: project.id,
      name: project.name,
      projectRole: memberships.find((item) => item.projectId === project.id)?.role ?? null,
      rank: project.rank ?? null,
      startDate: project.startDate,
      status: status?.projectStatusName ?? '',
      tenantId: project.tenantId,
      updatedAt: project.updatedAt,
    };
  }

  function buildExecutor() {
    return {
      async execute(sql, params = []) {
        executed.push({ sql, params });
        if (sql.includes('FROM projects WHERE id = ? AND tenant_id = ?')) {
          const found = projects.find((project) => project.id === params[0] && project.tenantId === params[1]);
          return [found ? [{ id: found.id, ...(sql.includes('updated_at AS updatedAt') ? { updatedAt: found.updatedAt } : {}) }] : []];
        }
        if (sql.includes('UPDATE projects') && sql.includes('SET name = ?')) {
          const [name, description, projectStatusId, startDate, endDate, projectId, tenantId] = params;
          const found = projects.find((project) => project.id === projectId && project.tenantId === tenantId);
          if (found) Object.assign(found, { name, description, projectStatusId, startDate, endDate, updatedAt: new Date(Date.parse(found.updatedAt) + 1000).toISOString() });
          return [{ affectedRows: found ? 1 : 0 }];
        }
        if (sql.includes('FROM information_schema.TABLES')) {
          const [tableName] = params;
          if (tableName === 'project_sprints' || tableName === 'project_sprint_staffing') {
            return [[{ count: 1 }]];
          }
          return [[{ count: 0 }]];
        }

        if (sql.includes('FROM information_schema.COLUMNS')) {
          const [tableName, columnName] = params;
          if (tableName === 'projects' && columnName === 'rank') {
            return [[{ count: 1 }]];
          }
          if (tableName === 'tasks' && ['target_hour_estimate', 'sprint_id', 'sprint_sort_order', 'board_sort_order', 'source_clarification_ids', 'percent_complete', 'actual_hours', 'estimate_override', 'remaining_hours'].includes(columnName)) {
            return [[{ count: 1 }]];
          }
          return [[{ count: 0 }]];
        }

        if (sql.includes('FROM project_statuses') && sql.includes('WHERE id = ?')) {
          const [statusValue] = params;
          const matched = projectStatuses.filter((item) => item.id === statusValue || item.projectStatusName === statusValue);
          return [matched.map((item) => ({ id: item.id }))];
        }

        if (sql.includes('FROM project_statuses') && sql.includes('project_status_name AS projectStatusName')) {
          return [projectStatuses.map((item) => ({ ...item }))];
        }

        if (sql.includes('INSERT INTO project_statuses')) {
          const [projectStatusName, projectStatusDescription] = params;
          projectStatuses.push({
            id: `status-${projectStatuses.length + 1}`,
            projectStatusDescription,
            projectStatusName,
          });
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('INSERT INTO projects')) {
          const [id, tenantId, name, description, projectStatusId, startDate, endDate] = params;
          projects.push({
            createdAt: '2026-05-17T00:00:00.000Z',
            description,
            endDate,
            id,
            name,
            projectStatusId,
            rank: null,
            startDate,
            tenantId,
            updatedAt: '2026-05-17T00:00:00.000Z',
          });
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('INSERT INTO user_project')) {
          const [, userId, projectId, role] = params;
          memberships.push({
            projectId,
            role,
            userId,
          });
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('FROM projects p') && sql.includes('WHERE p.id = ?')) {
          const [projectId, tenantId] = params;
          const project = projects.find((item) => item.id === projectId && item.tenantId === tenantId);
          return [project ? [buildProjectRow(project)] : []];
        }

        if (sql.includes('FROM projects p') && sql.includes('LEFT JOIN user_project up')) {
          const [userId, tenantId] = params;
          const rows = projects
            .filter((item) => item.tenantId === tenantId)
            .map((project) => ({
              ...buildProjectRow(project),
              projectRole: memberships.find((item) => item.projectId === project.id && item.userId === userId)?.role ?? null,
            }));
          return [rows];
        }

        if (sql.includes('FROM task_types')) {
          return [taskTypes.map((row) => ({ ...row }))];
        }

        if (sql.includes('INSERT INTO task_types')) {
          const [tenantId, projectId, taskTypeName, sortOrder] = params;
          taskTypes.push({
            deleted: 0,
            id: `type-${String(taskTypeName ?? '').toLowerCase()}`,
            projectId,
            sortOrder,
            taskTypeName,
            tenantId,
          });
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('FROM tasks') && sql.includes('DISTINCT task_type AS taskTypeId')) {
          return [[]];
        }

        if (sql.includes('FROM tasks') && sql.includes('parent_task_id IS NULL')) {
          return [[]];
        }

        // Flat ticket collection query (no parent predicate).
        if (sql.includes('FROM tasks') && sql.includes('ORDER BY sort_order, id')) {
          return [[]];
        }

        if (sql.includes('FROM task_log') && sql.includes('ROW_NUMBER()')) {
          return [[]];
        }

        // Project details changes join the project change log.
        if (sql.includes('INSERT INTO project_change_log')) {
          return [{ affectedRows: 1 }];
        }

        throw new Error(`Unexpected SQL in MySQL project status bridge test double: ${sql}`);
      },
    };
  }

  return {
    executed,
    projects,
    projectStatuses,
    async execute(sql, params) {
      return buildExecutor().execute(sql, params);
    },
    async getConnection() {
      const executor = buildExecutor();
      return {
        ...executor,
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  };
}

function createMysqlEmptyProjectStatusPool() {
  return createMysqlProjectStatusPool([]);
}

test('mysql project metadata selects and locks its timestamp before accepting the expected version', async () => {
  const pool = createMysqlProjectStatusPool();
  const repository = createMysqlProjectsRepository({ pool });
  const user = { id: 'fixture-admin' };
  const project = await repository.createProject({ input: { name: 'Disposable fixture', status: 'Planned', description: '', startDate: null, endDate: null }, tenantId: 'tenant-local', user });
  const input = { name: 'Maintained fixture', status: 'In Progress', description: '', startDate: null, endDate: null, expectedUpdatedAt: project.updatedAt };
  const updated = await repository.updateProject({ input, projectId: project.id, tenantId: 'tenant-local', user });
  assert.equal(updated.name, 'Maintained fixture');
  assert.ok(Date.parse(updated.updatedAt) > Date.parse(project.updatedAt));
  const lock = pool.executed.find(({ sql }) => sql.includes('FROM projects WHERE id = ? AND tenant_id = ?'));
  assert.match(lock.sql, /updated_at AS updatedAt.*FOR UPDATE/);
  const write = pool.executed.find(({ sql }) => sql.includes('UPDATE projects') && sql.includes('SET name = ?'));
  assert.match(write.sql, /GREATEST\(NOW\(3\), COALESCE\(DATE_ADD\(updated_at, INTERVAL 1 SECOND\), NOW\(3\)\)\)/);
  const writesBefore = pool.executed.filter(({ sql }) => sql.includes('UPDATE projects')).length;
  await assert.rejects(repository.updateProject({ input, projectId: project.id, tenantId: 'tenant-local', user }), (error) => error.statusCode === 409 && error.details.code === 'project_version_conflict');
  assert.equal(pool.executed.filter(({ sql }) => sql.includes('UPDATE projects')).length, writesBefore);
});

function createMysqlProjectDetailPool() {
  const project = {
    createdAt: '2026-05-17T00:00:00.000Z',
    description: 'Rebuild the Ledger reporting tool inside Northwind.',
    endDate: null,
    id: 'project-ledger',
    name: 'Ledger Reporter Rebuild',
    rank: 1,
    startDate: '2026-05-17',
    status: 'Started',
    tenantId: 'tenant-acme',
    updatedAt: '2026-05-17T00:00:00.000Z',
  };
  const taskTypes = [
    { deleted: 0, id: 'type-epic', projectId: null, taskTypeName: 'Epic', tenantId: null },
    { deleted: 0, id: 'type-story', projectId: null, taskTypeName: 'Story', tenantId: null },
  ];
  const tasks = [
    {
      deleted: 0,
      description: 'Coordinate launch work.',
      id: 'epic-1',
      name: 'Launch readiness',
      parent_task_id: null,
      points: null,
      priority: 1,
      project_id: project.id,
      sort_order: 0,
      source_clarification_ids: '["clar-1"]',
      sprint_id: null,
      sprint_sort_order: null,
      target_end_date: null,
      target_hour_estimate: null,
      target_start_date: null,
      task_type: 'type-epic',
    },
    {
      deleted: 0,
      description: 'Capture approval workflow.',
      id: 'story-1',
      name: 'Approval workflow',
      parent_task_id: 'epic-1',
      points: null,
      priority: 1,
      project_id: project.id,
      sort_order: 0,
      source_clarification_ids: '["clar-1","clar-2"]',
      sprint_id: null,
      sprint_sort_order: null,
      target_end_date: null,
      target_hour_estimate: null,
      target_start_date: null,
      task_type: 'type-story',
    },
  ];

  function buildExecutor() {
    return {
      async execute(sql, params = []) {
        if (sql.includes('FROM information_schema.TABLES')) {
          const [tableName] = params;
          if (tableName === 'project_sprints' || tableName === 'project_sprint_staffing') {
            return [[{ count: 1 }]];
          }
          return [[{ count: 0 }]];
        }

        if (sql.includes('FROM information_schema.COLUMNS')) {
          const [tableName, columnName] = params;
          if (tableName === 'projects' && columnName === 'rank') {
            return [[{ count: 1 }]];
          }
          if (tableName === 'tasks' && ['target_hour_estimate', 'sprint_id', 'sprint_sort_order', 'board_sort_order', 'source_clarification_ids', 'percent_complete', 'actual_hours', 'estimate_override', 'remaining_hours'].includes(columnName)) {
            return [[{ count: 1 }]];
          }
          return [[{ count: 0 }]];
        }

        if (sql.includes('FROM projects p') && sql.includes('INNER JOIN project_statuses ps')) {
          const [projectId, tenantId] = params;
          if (projectId === project.id && tenantId === project.tenantId) {
            return [[{ ...project }]];
          }
          return [[]];
        }

        if (sql.includes('FROM task_types')) {
          return [taskTypes.map((row) => ({ ...row }))];
        }

        if (sql.includes('INSERT INTO task_types')) {
          const [tenantId, projectId, taskTypeName, sortOrder] = params;
          taskTypes.push({
            deleted: 0,
            id: `type-${String(taskTypeName ?? '').toLowerCase()}`,
            projectId,
            sortOrder,
            taskTypeName,
            tenantId,
          });
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('SELECT DISTINCT task_type AS taskTypeId FROM tasks WHERE project_id = ?')) {
          return [[
            { taskTypeId: 'type-epic' },
            { taskTypeId: 'type-story' },
          ]];
        }

        if (sql.includes('FROM tasks') && sql.includes('parent_task_id IS NULL')) {
          const [projectId, taskTypeId] = params;
          return [[
            ...tasks.filter((task) => task.project_id === projectId && task.task_type === taskTypeId && task.parent_task_id === null),
          ]];
        }

        if (sql.includes('FROM tasks') && sql.includes('parent_task_id = ?')) {
          const [projectId, taskTypeId, parentId] = params;
          return [[
            ...tasks.filter((task) => task.project_id === projectId && task.task_type === taskTypeId && task.parent_task_id === parentId),
          ]];
        }

        // Flat ticket collection query, or every item of the project when no type is given.
        if (sql.includes('FROM tasks') && sql.includes('ORDER BY sort_order, id')) {
          const [projectId, taskTypeId] = params;
          return [[
            ...tasks.filter((task) => task.project_id === projectId && (taskTypeId === undefined || task.task_type === taskTypeId)),
          ]];
        }

        // Latest status or assignee per item for the whole project.
        if (sql.includes('FROM task_log') && sql.includes('ROW_NUMBER()')) {
          return [[]];
        }

        if (sql.includes('FROM task_log') && sql.includes("log_action = 'status_change'")) {
          return [[]];
        }

        if (sql.includes('FROM task_log') && sql.includes("log_action = 'assign'")) {
          return [[]];
        }

        throw new Error(`Unexpected SQL in MySQL project detail test double: ${sql}`);
      },
    };
  }

  return {
    async execute(sql, params) {
      return buildExecutor().execute(sql, params);
    },
    async getConnection() {
      const executor = buildExecutor();
      return {
        ...executor,
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  };
}

function createMysqlLegacyProjectSchemaPool() {
  let projectRankExists = false;
  const executed = [];

  return {
    executed,
    async execute(sql, params = []) {
      executed.push({ params, sql });

      if (sql.includes('FROM information_schema.TABLES')) {
        const [tableName] = params;
        if (tableName === 'project_sprints' || tableName === 'project_sprint_staffing') {
          return [[{ count: 1 }]];
        }
        return [[{ count: 0 }]];
      }

      if (sql.includes('FROM information_schema.COLUMNS')) {
        const [tableName, columnName] = params;
        if (tableName === 'projects' && columnName === 'rank') {
          return [[{ count: projectRankExists ? 1 : 0 }]];
        }
        if (tableName === 'tasks' && ['target_hour_estimate', 'sprint_id', 'sprint_sort_order', 'board_sort_order', 'source_clarification_ids', 'percent_complete', 'actual_hours', 'estimate_override', 'remaining_hours'].includes(columnName)) {
          return [[{ count: 1 }]];
        }
        return [[{ count: 0 }]];
      }

      if (sql.startsWith('ALTER TABLE projects ADD COLUMN `rank`')) {
        projectRankExists = true;
        return [{ affectedRows: 1 }];
      }

      if (sql.includes('FROM projects p') && sql.includes('LEFT JOIN user_project up')) {
        assert.equal(projectRankExists, true);
        return [[]];
      }

      throw new Error(`Unexpected SQL in legacy project schema bridge test double: ${sql}`);
    },
    async getConnection() {
      return {
        beginTransaction() {},
        commit() {},
        execute: this.execute.bind(this),
        release() {},
        rollback() {},
      };
    },
  };
}

function createMysqlProjectTreeInsertPool(initialTaskTypes = [
  { deleted: 0, id: 'type-epic', projectId: null, taskTypeName: 'Epic', tenantId: null },
  { deleted: 0, id: 'type-story', projectId: null, taskTypeName: 'Story', tenantId: null },
  { deleted: 0, id: 'type-task', projectId: null, taskTypeName: 'Task', tenantId: null },
]) {
  const executed = [];
  const taskTypes = initialTaskTypes.map((row) => ({ ...row }));

  function countPlaceholders(sql) {
    return (sql.match(/\?/g) ?? []).length;
  }

  return {
    executed,
    taskTypes,
    async execute(sql, params = []) {
      executed.push({ params, sql });

      if (sql.includes('FROM information_schema.TABLES')) {
        const [tableName] = params;
        if (tableName === 'project_sprints' || tableName === 'project_sprint_staffing') {
          return [[{ count: 1 }]];
        }
        return [[{ count: 0 }]];
      }

      if (sql.includes('FROM information_schema.COLUMNS')) {
        const [tableName, columnName] = params;
        if (tableName === 'projects' && columnName === 'rank') {
          return [[{ count: 1 }]];
        }
        if (tableName === 'tasks' && ['target_hour_estimate', 'sprint_id', 'sprint_sort_order', 'board_sort_order', 'source_clarification_ids', 'percent_complete', 'actual_hours', 'estimate_override', 'remaining_hours'].includes(columnName)) {
          return [[{ count: 1 }]];
        }
        return [[{ count: 0 }]];
      }

      if (sql.startsWith('SELECT id') && sql.includes('FROM projects WHERE id = ?')) {
        return [[{ id: 'project-1', updatedAt: '2026-05-17T00:00:00.000Z' }]];
      }

      if (sql.startsWith('UPDATE projects SET updated_at = GREATEST(')) {
        return [{ affectedRows: 1 }];
      }

      if (sql.startsWith('SELECT t.id FROM tasks t WHERE t.project_id = ? AND t.deleted = 0')) {
        // The sweep of items a tree save left out never takes tickets.
        assert.match(sql, /task_type_name = 'Ticket'/);
        return [[]];
      }

      if (sql.includes('FROM task_types')) {
        return [taskTypes.map((row) => ({ ...row }))];
      }

      if (sql.includes('INSERT INTO task_types')) {
        const [tenantId, projectId, taskTypeName, sortOrder] = params;
        taskTypes.push({
          deleted: 0,
          id: `type-${String(taskTypeName ?? '').toLowerCase()}`,
          projectId,
          sortOrder,
          taskTypeName,
          tenantId,
        });
        return [{ affectedRows: 1 }];
      }

      if (sql.startsWith('SELECT DISTINCT task_type AS taskTypeId FROM tasks WHERE project_id = ?')) {
        return [[]];
      }

      if (sql.startsWith('SELECT id FROM tasks WHERE id = ? AND project_id = ? LIMIT 1')) {
        return [[]];
      }

      if (sql.includes('INSERT INTO tasks (')) {
        assert.equal(countPlaceholders(sql), params.length);
        return [{ affectedRows: 1 }];
      }

      if (sql.includes('INSERT INTO task_log')) {
        return [{ affectedRows: 1 }];
      }

      if (sql.includes('FROM projects p') && sql.includes('INNER JOIN project_statuses ps')) {
        return [[{
          createdAt: '2026-05-17T00:00:00.000Z',
          description: 'Desc',
          endDate: null,
          id: 'project-1',
          name: 'Project',
          rank: null,
          startDate: null,
          status: 'Planning',
          tenantId: 'tenant-acme',
          updatedAt: '2026-05-17T00:00:00.000Z',
        }]];
      }

      if (sql.includes('FROM tasks') && sql.includes('parent_task_id IS NULL')) {
        return [[]];
      }

      // Flat ticket collection query (no parent predicate).
      if (sql.includes('FROM tasks') && sql.includes('ORDER BY sort_order, id')) {
        return [[]];
      }

      if (sql.includes('FROM task_log') && sql.includes('ROW_NUMBER()')) {
        return [[]];
      }

      throw new Error(`Unexpected SQL in MySQL project tree insert test double: ${sql}`);
    },
    async getConnection() {
      return {
        beginTransaction() {},
        commit() {},
        execute: this.execute.bind(this),
        release() {},
        rollback() {},
      };
    },
  };
}

test('mysql projects repository maps canonical project statuses onto legacy planning rows', async () => {
  const pool = createMysqlProjectStatusPool();
  const repository = createMysqlProjectsRepository({ pool });

  const project = await repository.createProject({
    input: {
      description: 'Rebuild the Ledger reporting tool inside Northwind.',
      endDate: null,
      name: 'Ledger Reporter Rebuild',
      startDate: null,
      status: 'Planned',
    },
    tenantId: 'tenant-acme',
    user: { id: 'user-grace' },
  });

  assert.equal(project.status, 'Planned');
  assert.equal(pool.projects[0].projectStatusId, 'status-planning');
});

test('mysql projects repository seeds canonical statuses when project_statuses is empty', async () => {
  const pool = createMysqlEmptyProjectStatusPool();
  const repository = createMysqlProjectsRepository({ pool });

  const project = await repository.createProject({
    input: {
      description: 'Build a Ledger reporting replacement.',
      endDate: null,
      name: 'Ledger Replacement',
      startDate: null,
      status: 'Planned',
    },
    tenantId: 'tenant-acme',
    user: { id: 'user-grace' },
  });

  assert.equal(project.status, 'Planned');
  assert.deepEqual(
    pool.projectStatuses.map((status) => status.projectStatusName),
    ['Planned', 'In Progress', 'At Risk', 'Review', 'Completed', 'Archived'],
  );
  assert.equal(pool.projects[0].projectStatusId, 'status-1');
});

test('mysql projects repository no longer guesses unknown project statuses', async () => {
  const pool = createMysqlProjectStatusPool();
  const repository = createMysqlProjectsRepository({ pool });

  await assert.rejects(
    () => repository.createProject({
      input: {
        description: 'Rebuild the Ledger reporting tool inside Northwind.',
        endDate: null,
        name: 'Ledger Reporter Rebuild',
        startDate: null,
        status: 'Planned / Discovery Required',
      },
      tenantId: 'tenant-acme',
      user: { id: 'user-grace' },
    }),
    /Unknown project status: Planned \/ Discovery Required/,
  );
});

test('mysql projects repository translates legacy stored project statuses back to canonical app statuses', async () => {
  const pool = createMysqlProjectStatusPool();
  pool.projects.push({
    createdAt: '2026-05-17T00:00:00.000Z',
    description: 'Rebuild the Ledger reporting tool inside Northwind.',
    endDate: null,
    id: 'project-ledger',
    name: 'Ledger Reporter Rebuild',
    projectStatusId: 'status-started',
    rank: 1,
    startDate: '2026-05-17',
    tenantId: 'tenant-acme',
    updatedAt: '2026-05-17T00:00:00.000Z',
  });

  const repository = createMysqlProjectsRepository({ pool });
  const projects = await repository.listProjectsForTenant({
    tenantId: 'tenant-acme',
    user: {
      id: 'user-grace',
      memberships: [{ role: 'admin', tenantId: 'tenant-acme' }],
    },
  });

  assert.equal(projects.length, 1);
  assert.equal(projects[0].status, 'In Progress');
});

test('mysql projects repository parses source clarification ids when building nested project detail', async () => {
  const pool = createMysqlProjectDetailPool();
  const repository = createMysqlProjectsRepository({ pool });

  const project = await repository.getProjectDetail({
    projectId: 'project-ledger',
    tenantId: 'tenant-acme',
  });

  assert.ok(project);
  assert.deepEqual(project.epics[0].sourceClarificationIds, ['clar-1']);
  assert.deepEqual(project.epics[0].stories[0].sourceClarificationIds, ['clar-1', 'clar-2']);
});

test('migration 0004 adds projects.rank to legacy schemas; listing projects changes no schema', async () => {
  const pool = createMysqlLegacyProjectSchemaPool();
  const repository = createMysqlProjectsRepository({ pool });

  await ensureMysqlProjectPlanningSchema(pool);
  assert.equal(
    pool.executed.some((entry) => entry.sql.startsWith('ALTER TABLE projects ADD COLUMN `rank` INT NULL AFTER end_date')),
    true,
  );

  pool.executed.length = 0;
  const projects = await repository.listProjectsForTenant({
    tenantId: 'tenant-acme',
    user: {
      id: 'user-grace',
      memberships: [{ role: 'admin', tenantId: 'tenant-acme' }],
    },
  });

  assert.deepEqual(projects, []);
  assert.deepEqual(pool.executed.filter((entry) => /ALTER TABLE|information_schema/i.test(entry.sql)), []);
});

test('mysql projects repository inserts generated task trees with the full task column set', async () => {
  const pool = createMysqlProjectTreeInsertPool();
  const repository = createMysqlProjectsRepository({ pool });

  const project = await repository.replaceProjectTree({
    input: {
      epics: [{
        description: 'Epic description',
        name: 'Epic 1',
        priority: 1,
        stories: [{
          description: 'Story description',
          name: 'Story 1',
          priority: 1,
          status: 'Not Started',
          tasks: [{
            description: 'Task description',
            name: 'Task 1',
            priority: 1,
            status: 'Not Started',
          }],
        }],
        status: 'Not Started',
      }],
    },
    projectId: 'project-1',
    tenantId: 'tenant-acme',
    user: { id: 'user-grace' },
  });

  assert.ok(project);
  assert.equal(
    pool.executed.filter((entry) => entry.sql.includes('INSERT INTO tasks (')).length,
    3,
  );
});

test('mysql projects repository does not trust incoming task ids for new tree inserts', async () => {
  const pool = createMysqlProjectTreeInsertPool();
  const repository = createMysqlProjectsRepository({ pool });

  const project = await repository.replaceProjectTree({
    input: {
      epics: [{
        description: 'Epic description',
        id: 'EPIC-001',
        name: 'Epic 1',
        priority: 1,
        stories: [{
          description: 'Story description',
          id: 'STORY-001',
          name: 'Story 1',
          priority: 1,
          status: 'Not Started',
          tasks: [{
            description: 'Task description',
            id: 'TASK-001',
            name: 'Task 1',
            priority: 1,
            status: 'Not Started',
          }],
        }],
        status: 'Not Started',
      }],
    },
    projectId: 'project-1',
    tenantId: 'tenant-acme',
    user: { id: 'user-grace' },
  });

  assert.ok(project);

  const insertedTaskIds = pool.executed
    .filter((entry) => entry.sql.includes('INSERT INTO tasks ('))
    .map((entry) => entry.params[0]);

  assert.equal(insertedTaskIds.includes('EPIC-001'), false);
  assert.equal(insertedTaskIds.includes('STORY-001'), false);
  assert.equal(insertedTaskIds.includes('TASK-001'), false);
});

test('mysql projects repository seeds canonical task types when task_types is empty before replacing the project tree', async () => {
  const pool = createMysqlProjectTreeInsertPool([]);
  const repository = createMysqlProjectsRepository({ pool });

  const project = await repository.replaceProjectTree({
    input: {
      epics: [{
        description: 'Epic description',
        name: 'Epic 1',
        priority: 1,
        stories: [{
          description: 'Story description',
          name: 'Story 1',
          priority: 1,
          status: 'Not Started',
          tasks: [{
            description: 'Task description',
            name: 'Task 1',
            priority: 1,
            status: 'Not Started',
          }],
        }],
        status: 'Not Started',
      }],
    },
    projectId: 'project-1',
    tenantId: 'tenant-acme',
    user: { id: 'user-grace' },
  });

  assert.ok(project);
  assert.deepEqual(
    pool.taskTypes.map((entry) => entry.taskTypeName),
    ['Epic', 'Story', 'Task', 'Ticket'],
  );
  assert.equal(
    pool.executed.filter((entry) => entry.sql.includes('INSERT INTO task_types')).length,
    4,
  );
});
