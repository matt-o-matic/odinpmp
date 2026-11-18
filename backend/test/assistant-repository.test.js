import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInMemoryAssistantRepository,
  createMysqlAssistantRepository,
  ensureMysqlClarificationSchema,
} from '../src/modules/assistant/assistant.repository.js';

function createPreferencePool({ maxKeyLength = 50 } = {}) {
  const inserts = [];
  const rowsByLookup = new Map();
  let updateCounter = 0;

  function lookupKey(tenantId, userId, projectId, key) {
    return JSON.stringify([tenantId, userId, projectId, key]);
  }

  function nextUpdatedAt() {
    updateCounter += 1;
    return `2026-05-14T00:00:${String(updateCounter).padStart(2, '0')}.000Z`;
  }

  function matchesLike(value, pattern) {
    if (!pattern.includes('%')) {
      return value === pattern;
    }

    const prefix = pattern.slice(0, pattern.indexOf('%'));
    return String(value).startsWith(prefix);
  }

  function listRows() {
    return [...rowsByLookup.values()];
  }

  function buildExecutor() {
    return {
      async execute(sql, params) {
        if (sql.includes('SELECT id, value') && sql.includes('FROM preferences')) {
          const [tenantId, userId, likeCurrent, likeLegacy] = params;
          const rows = listRows()
            .filter((row) => row.tenantId === tenantId
              && row.userId === userId
              && (matchesLike(row.key, likeCurrent) || matchesLike(row.key, likeLegacy)))
            .map((row) => ({ id: row.id, value: row.value }));
          return [rows];
        }

        if (sql.includes('SELECT id') && sql.includes('FROM preferences')) {
          const [tenantId, userId, projectId, key] = params;
          const row = rowsByLookup.get(lookupKey(tenantId, userId, projectId, key));
          return [row ? [{ id: row.id }] : []];
        }

        if (sql.includes('SELECT `key`, value, updated_at') && sql.includes('FROM preferences')) {
          const [tenantId, userId, likeCurrent, likeLegacy, ...rest] = params;
          const currentKey = rest[0] ?? null;
          const legacyKey = rest[1] ?? null;
          const rows = listRows()
            .filter((row) => row.tenantId === tenantId
              && row.userId === userId
              && (matchesLike(row.key, likeCurrent) || matchesLike(row.key, likeLegacy))
              && (!currentKey || row.key === currentKey || row.key === legacyKey))
            .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
            .map((row) => ({
              key: row.key,
              updated_at: row.updatedAt,
              value: row.value,
            }));
          return [rows];
        }

        if (sql.includes('INSERT INTO preferences')) {
          const [id, tenantId, userId, projectId, key, value] = params;
          if (String(key).length > maxKeyLength) {
            throw new Error(`Data too long for column 'key' (${String(key).length} > ${maxKeyLength})`);
          }
          const row = {
            id,
            key,
            projectId,
            tenantId,
            updatedAt: nextUpdatedAt(),
            userId,
            value,
          };
          rowsByLookup.set(lookupKey(tenantId, userId, projectId, key), row);
          inserts.push(row);
          return [{ affectedRows: 1 }];
        }

        if (sql.startsWith('UPDATE preferences SET value = ?')) {
          const [value, id] = params;
          const row = listRows().find((item) => item.id === id);
          if (row) {
            row.value = value;
            row.updatedAt = nextUpdatedAt();
          }
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('DELETE FROM preferences') && sql.includes('`key` IN')) {
          const [tenantId, userId, ...keys] = params;
          for (const row of listRows()) {
            if (row.tenantId === tenantId && row.userId === userId && keys.includes(row.key)) {
              rowsByLookup.delete(lookupKey(row.tenantId, row.userId, row.projectId, row.key));
            }
          }
          return [{ affectedRows: 1 }];
        }

        if (sql.startsWith('DELETE FROM preferences WHERE id = ?')) {
          const [id] = params;
          const row = listRows().find((item) => item.id === id);
          if (row) {
            rowsByLookup.delete(lookupKey(row.tenantId, row.userId, row.projectId, row.key));
          }
          return [{ affectedRows: 1 }];
        }

        throw new Error(`Unexpected SQL in test double: ${sql}`);
      },
    };
  }

  return {
    inserts,
    rowsByLookup,
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
    async execute(sql, params) {
      return buildExecutor().execute(sql, params);
    },
  };
}

function createClarificationPool({
  existingClarification = null,
  primaryKeyColumns = ['tenant_id', 'project_id', 'id'],
} = {}) {
  const clarificationInserts = [];
  const clarificationUpdates = [];
  const schemaStatements = [];

  function buildExecutor() {
    return {
      async execute(sql, params = []) {
        if (sql.includes('FROM information_schema.TABLES')) {
          return [[{ count: 1 }]];
        }

        if (sql.includes('FROM information_schema.COLUMNS')) {
          return [[{ count: 1 }]];
        }

        if (sql.includes('FROM information_schema.KEY_COLUMN_USAGE')) {
          return [primaryKeyColumns.map((columnName) => ({ columnName }))];
        }

        if (sql.includes('ALTER TABLE project_clarifications') && sql.includes('DROP PRIMARY KEY')) {
          schemaStatements.push(sql);
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('FROM project_clarifications') && sql.includes('LIMIT 1')) {
          return [existingClarification ? [existingClarification] : []];
        }

        if (sql.includes('UPDATE project_clarifications')) {
          clarificationUpdates.push({ params, sql });
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('INSERT INTO project_clarifications')) {
          clarificationInserts.push({ params, sql });
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('DELETE FROM project_clarification_assignments')) {
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('FROM project_clarifications')) {
          return [[]];
        }

        if (sql.includes('FROM project_clarification_assignments')) {
          return [[]];
        }

        if (sql.includes('FROM project_clarification_comments')) {
          return [[]];
        }

        if (sql.includes('FROM project_clarification_comment_reactions')) {
          return [[]];
        }

        if (sql.includes('FROM project_clarification_invitations')) {
          return [[]];
        }

        if (sql.includes('INSERT INTO project_clarification_invitations')) {
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('FROM project_stakeholders')) {
          return [[]];
        }

        throw new Error(`Unexpected SQL in clarification test double: ${sql}`);
      },
    };
  }

  return {
    clarificationInserts,
    clarificationUpdates,
    schemaStatements,
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
    async execute(sql, params) {
      return buildExecutor().execute(sql, params);
    },
  };
}

function createClarificationDiscussionReviewPool() {
  let getConnectionCalls = 0;
  let commentCounter = 0;
  const comments = [];
  const clarification = {
    blockingArea: 'compliance',
    createdAt: '2026-05-18T12:00:00.000Z',
    currentAnswer: '',
    currentAnswerUpdatedAt: null,
    id: 'clar-1',
    lastActivityAt: '2026-05-18T12:00:00.000Z',
    lastAutoCommentActivityAt: null,
    lastHumanActivityAt: '2026-05-18T12:00:00.000Z',
    lastReviewedActivityAt: null,
    latestInboundSuggestedAnswer: '',
    latestInboundSummary: '',
    latestInboundSummaryCommentId: null,
    latestInboundSummaryUpdatedAt: null,
    lifecycleState: 'committed',
    linkedSection: 'brief',
    prompt: 'What approvals are required before launch?',
    proposedDraftImpact: 'Adds release-gate requirements to the plan.',
    rationale: 'The approval path is not yet documented.',
    status: 'open',
    updatedAt: '2026-05-18T12:00:00.000Z',
  };

  async function execute(sql, params = []) {
    if (sql.includes('FROM information_schema.TABLES')) {
      return [[{ count: 1 }]];
    }

    if (sql.includes('FROM information_schema.COLUMNS')) {
      return [[{ count: 1 }]];
    }

    if (sql.includes('FROM information_schema.KEY_COLUMN_USAGE')) {
      return [[
        { columnName: 'tenant_id' },
        { columnName: 'project_id' },
        { columnName: 'id' },
      ]];
    }

    if (sql.includes('FROM project_clarifications') && sql.includes('LIMIT 1')) {
      return [[{
        id: clarification.id,
        lastActivityAt: clarification.lastActivityAt,
        lastAutoCommentActivityAt: clarification.lastAutoCommentActivityAt,
        lastHumanActivityAt: clarification.lastHumanActivityAt,
        status: clarification.status,
      }]];
    }

    if (sql.includes('UPDATE project_clarifications') && sql.includes('SET current_answer = ?')) {
      clarification.currentAnswer = params[0];
      clarification.currentAnswerUpdatedAt = '2026-05-18T12:05:00.000Z';
      clarification.lastReviewedActivityAt = params[1];
      clarification.status = clarification.status === 'open' ? 'answered' : clarification.status;
      clarification.updatedAt = '2026-05-18T12:05:00.000Z';
      return [{ affectedRows: 1 }];
    }

    if (sql.includes('INSERT INTO project_clarification_comments')) {
      commentCounter += 1;
      comments.push({
        actorId: params[6],
        actorType: params[5],
        authorName: params[7],
        body: params[8],
        clarificationId: params[3],
        createdAt: '2026-05-18T12:06:00.000Z',
        deletedAt: null,
        editedAt: null,
        id: params[0],
        parentCommentId: params[4],
        source: params[9],
        updatedAt: '2026-05-18T12:06:00.000Z',
      });
      return [{ affectedRows: 1 }];
    }

    if (sql.includes('UPDATE project_clarifications') && sql.includes('SET last_activity_at = NOW()')) {
      clarification.lastActivityAt = '2026-05-18T12:06:00.000Z';
      clarification.updatedAt = '2026-05-18T12:06:00.000Z';
      return [{ affectedRows: 1 }];
    }

    if (sql.includes('FROM project_clarification_comments') && sql.includes('parent_comment_id = ?')) {
      return [[]];
    }

    if (sql.includes('FROM project_clarification_comments')) {
      return [comments.map((comment) => ({
        actorId: comment.actorId,
        actorType: comment.actorType,
        authorName: comment.authorName,
        body: comment.body,
        clarificationId: comment.clarificationId,
        createdAt: comment.createdAt,
        deletedAt: comment.deletedAt,
        editedAt: comment.editedAt,
        id: comment.id,
        parentCommentId: comment.parentCommentId,
        source: comment.source,
        updatedAt: comment.updatedAt,
      }))];
    }

    if (sql.includes('FROM project_clarification_assignments')) {
      return [[]];
    }

    if (sql.includes('FROM project_clarification_comment_reactions')) {
      return [[]];
    }

    if (sql.includes('FROM project_clarification_invitations')) {
      return [[]];
    }

    if (sql.includes('FROM project_stakeholders')) {
      return [[]];
    }

    if (sql.includes('FROM project_clarifications')) {
      return [[{
        blockingArea: clarification.blockingArea,
        createdAt: clarification.createdAt,
        currentAnswer: clarification.currentAnswer,
        currentAnswerUpdatedAt: clarification.currentAnswerUpdatedAt,
        id: clarification.id,
        lastActivityAt: clarification.lastActivityAt,
        lastAutoCommentActivityAt: clarification.lastAutoCommentActivityAt,
        lastHumanActivityAt: clarification.lastHumanActivityAt,
        lastReviewedActivityAt: clarification.lastReviewedActivityAt,
        latestInboundSuggestedAnswer: clarification.latestInboundSuggestedAnswer,
        latestInboundSummary: clarification.latestInboundSummary,
        latestInboundSummaryCommentId: clarification.latestInboundSummaryCommentId,
        latestInboundSummaryUpdatedAt: clarification.latestInboundSummaryUpdatedAt,
        lifecycleState: clarification.lifecycleState,
        linkedSection: clarification.linkedSection,
        prompt: clarification.prompt,
        proposedDraftImpact: clarification.proposedDraftImpact,
        rationale: clarification.rationale,
        status: clarification.status,
        updatedAt: clarification.updatedAt,
      }]];
    }

    throw new Error(`Unexpected SQL in clarification discussion review test double: ${sql}`);
  }

  return {
    getConnectionCalls() {
      return getConnectionCalls;
    },
    async getConnection() {
      getConnectionCalls += 1;
      if (getConnectionCalls > 1) {
        throw new Error('Nested clarification review transaction requested.');
      }
      return {
        execute,
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
    async execute(sql, params) {
      return execute(sql, params);
    },
  };
}

test('mysql assistant repository stores session preferences under DB-safe keys', async () => {
  const pool = createPreferencePool({ maxKeyLength: 50 });
  const repository = createMysqlAssistantRepository({ pool });

  await repository.createSession({
    approvals: {},
    artifacts: [],
    conversation: [],
    draft: { brief: {}, clarifications: [], structure: { epics: [] } },
    id: '12345678-1234-1234-1234-123456789abc',
    mode: 'project-context',
    projectId: 'project-123',
    tenantId: 'tenant-123',
    toolEvents: [],
    userId: 'user-123',
  });

  assert.equal(pool.inserts.length, 2);
  assert.ok(pool.inserts.every((entry) => entry.key.length <= 50));
});

test('mysql assistant repository stores create-project sessions with null project scope', async () => {
  const pool = createPreferencePool({ maxKeyLength: 50 });
  const repository = createMysqlAssistantRepository({ pool });

  await repository.createSession({
    approvals: {},
    artifacts: [],
    conversation: [],
    draft: { brief: {}, clarifications: [], structure: { epics: [] } },
    id: '87654321-1234-1234-1234-123456789abc',
    mode: 'create-project',
    projectId: null,
    tenantId: 'tenant-123',
    toolEvents: [],
    userId: 'user-123',
  });

  assert.equal(pool.inserts.length, 2);
  assert.ok(pool.inserts.every((entry) => entry.projectId === null));
});

test('mysql assistant repository keeps a single canonical row per session id across context changes', async () => {
  const pool = createPreferencePool({ maxKeyLength: 50 });
  const repository = createMysqlAssistantRepository({ pool });

  await repository.createSession({
    approvals: {},
    artifacts: [],
    conversation: [],
    draft: { brief: {}, clarifications: [], structure: { epics: [] } },
    id: 'session-123',
    mode: 'create-project',
    projectId: null,
    tenantId: 'tenant-123',
    toolEvents: [],
    updatedAt: '2026-05-14T00:00:01.000Z',
    userId: 'user-123',
  });

  await repository.saveSession({
    approvals: { brief: true, clarifications: true, structure: true },
    artifacts: [],
    conversation: [],
    draft: { brief: { name: 'Promoted Project' }, clarifications: [], structure: { epics: [] } },
    id: 'session-123',
    mode: 'project-context',
    projectId: 'project-123',
    status: 'committed',
    tenantId: 'tenant-123',
    toolEvents: [],
    updatedAt: '2026-05-14T00:00:05.000Z',
    userId: 'user-123',
  });

  const storedSessions = [...pool.rowsByLookup.values()].filter((row) => row.key === 'as:session-123');
  assert.equal(storedSessions.length, 1);
  assert.equal(storedSessions[0].projectId, null);

  const latestPointers = [...pool.rowsByLookup.values()].filter((row) => row.key.startsWith('asl:'));
  assert.equal(latestPointers.some((row) => row.key === 'asl:create-project'), false);
  assert.equal(latestPointers.some((row) => row.key === 'asl:project-context' && row.projectId === 'project-123'), true);
});

test('mysql assistant repository prefers promoted project-context snapshots over stale create-project duplicates', async () => {
  const pool = createPreferencePool({ maxKeyLength: 50 });
  const repository = createMysqlAssistantRepository({ pool });

  const staleLookup = JSON.stringify(['tenant-123', 'user-123', null, 'as:session-456']);
  const currentLookup = JSON.stringify(['tenant-123', 'user-123', 'project-456', 'as:session-456']);
  pool.rowsByLookup.set(staleLookup, {
    id: 'pref-stale',
    key: 'as:session-456',
    projectId: null,
    tenantId: 'tenant-123',
    updatedAt: '2026-05-14T00:00:05.000Z',
    userId: 'user-123',
    value: JSON.stringify({
      id: 'session-456',
      mode: 'create-project',
      projectId: null,
      status: 'draft',
      tenantId: 'tenant-123',
      updatedAt: '2026-05-14T00:00:05.000Z',
      userId: 'user-123',
    }),
  });
  pool.rowsByLookup.set(currentLookup, {
    id: 'pref-current',
    key: 'as:session-456',
    projectId: 'project-456',
    tenantId: 'tenant-123',
    updatedAt: '2026-05-14T00:00:03.000Z',
    userId: 'user-123',
    value: JSON.stringify({
      id: 'session-456',
      mode: 'project-context',
      projectId: 'project-456',
      status: 'committed',
      tenantId: 'tenant-123',
      updatedAt: '2026-05-14T00:00:03.000Z',
      userId: 'user-123',
    }),
  });

  const session = await repository.getSession({
    sessionId: 'session-456',
    tenantId: 'tenant-123',
    userId: 'user-123',
  });

  assert.equal(session.mode, 'project-context');
  assert.equal(session.projectId, 'project-456');

  const sessions = await repository.listSessions({
    tenantId: 'tenant-123',
    userId: 'user-123',
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, 'committed');
});

test('mysql assistant repository syncProjectClarifications inserts clarification rows with matching value counts', async () => {
  const pool = createClarificationPool();
  const repository = createMysqlAssistantRepository({ pool });

  await repository.syncProjectClarifications({
    clarifications: [{
      blockingArea: 'stakeholders',
      currentAnswer: 'Grace Hopper signs off on launch.',
      currentAnswerUpdatedAt: '2026-05-15T10:00:00.000Z',
      id: 'clar-1',
      lastActivityAt: '2026-05-15T10:00:00.000Z',
      lastAutoCommentActivityAt: '2026-05-15T10:05:00.000Z',
      lastHumanActivityAt: '2026-05-15T10:00:00.000Z',
      lastReviewedActivityAt: '2026-05-15T10:02:00.000Z',
      lifecycleState: 'draft',
      linkedSection: 'brief',
      prompt: 'Who owns final approval for the rollout?',
      proposedDraftImpact: 'Assign explicit stakeholder ownership in the brief and rollout plan.',
      rationale: 'The approval owner is still unclear.',
      status: 'answered',
    }],
    projectId: 'project-1',
    stakeholderContacts: [],
    tenantId: 'tenant-1',
  });

  assert.equal(pool.clarificationInserts.length, 1);
  assert.equal((pool.clarificationInserts[0].sql.match(/\?/g) ?? []).length, pool.clarificationInserts[0].params.length);
  assert.equal(pool.clarificationInserts[0].params[8], 'draft');
  assert.equal(pool.clarificationInserts[0].params[10], 'Grace Hopper signs off on launch.');
  assert.equal(pool.clarificationInserts[0].params[11], '2026-05-15 10:00:00');
  assert.equal(pool.clarificationInserts[0].params[12], '');
  assert.equal(pool.clarificationInserts[0].params[13], '');
  assert.equal(pool.clarificationInserts[0].params[14], null);
  assert.equal(pool.clarificationInserts[0].params[15], null);
  assert.equal(pool.clarificationInserts[0].params[16], '2026-05-15 10:00:00');
  assert.equal(pool.clarificationInserts[0].params[17], '2026-05-15 10:00:00');
  assert.equal(pool.clarificationInserts[0].params[18], '2026-05-15 10:02:00');
  assert.equal(pool.clarificationInserts[0].params[19], '2026-05-15 10:05:00');
});

test('mysql assistant repository coerces model-sized clarification ids before insert', async () => {
  const pool = createClarificationPool();
  const repository = createMysqlAssistantRepository({ pool });
  const unsafeModelId = 'clarification-final-launch-readiness-go-live-approval-owner-before-the-customer-facing-beta-can-ship';

  await repository.syncProjectClarifications({
    clarifications: [{
      blockingArea: 'stakeholders',
      id: unsafeModelId,
      lifecycleState: 'draft',
      linkedSection: 'brief',
      prompt: 'Who owns final approval for the rollout?',
      proposedDraftImpact: 'Assign explicit stakeholder ownership in the brief and rollout plan.',
      rationale: 'The approval owner is still unclear.',
      status: 'open',
    }],
    projectId: 'project-1',
    stakeholderContacts: [],
    tenantId: 'tenant-1',
  });

  assert.equal(pool.clarificationInserts.length, 1);
  assert.equal(pool.clarificationInserts[0].params[0].length, 36);
  assert.notEqual(pool.clarificationInserts[0].params[0], unsafeModelId);
});

test('migration 0003 upgrades clarification primary keys to project scope; saving clarifications changes no schema', async () => {
  const pool = createClarificationPool({
    primaryKeyColumns: ['id'],
  });
  const repository = createMysqlAssistantRepository({ pool });

  await repository.syncProjectClarifications({
    clarifications: [{
      blockingArea: 'compliance',
      id: 'CLAR-001',
      lifecycleState: 'draft',
      linkedSection: 'brief',
      prompt: 'What reporting deadlines matter for this project?',
      proposedDraftImpact: 'Adds compliance timing requirements to the brief.',
      rationale: 'Current filing deadlines are part of the planning scope.',
      status: 'open',
    }],
    projectId: 'project-1',
    stakeholderContacts: [],
    tenantId: 'tenant-1',
  });
  assert.deepEqual(pool.schemaStatements, []);

  await ensureMysqlClarificationSchema(pool);
  assert.equal(
    pool.schemaStatements.some((sql) => /DROP PRIMARY KEY/i.test(sql) && /ADD PRIMARY KEY \(tenant_id, project_id, id\)/i.test(sql)),
    true,
  );
});

test('mysql assistant repository scopes clarification updates by tenant and project', async () => {
  const pool = createClarificationPool({
    existingClarification: {
      createdAt: '2026-05-19T12:00:00.000Z',
      currentAnswer: '',
      currentAnswerUpdatedAt: null,
      id: 'CLAR-001',
      lastActivityAt: '2026-05-19T12:00:00.000Z',
      lastAutoCommentActivityAt: null,
      lastHumanActivityAt: null,
      lastReviewedActivityAt: null,
      latestInboundSuggestedAnswer: '',
      latestInboundSummary: '',
      latestInboundSummaryCommentId: null,
      latestInboundSummaryUpdatedAt: null,
      status: 'open',
    },
  });
  const repository = createMysqlAssistantRepository({ pool });

  await repository.syncProjectClarifications({
    clarifications: [{
      blockingArea: 'compliance',
      id: 'CLAR-001',
      lifecycleState: 'draft',
      linkedSection: 'brief',
      prompt: 'What reporting deadlines matter for this project?',
      proposedDraftImpact: 'Adds compliance timing requirements to the brief.',
      rationale: 'Current filing deadlines are part of the planning scope.',
      status: 'open',
    }],
    projectId: 'project-1',
    stakeholderContacts: [],
    tenantId: 'tenant-1',
  });

  assert.equal(pool.clarificationInserts.length, 0);
  assert.equal(pool.clarificationUpdates.length, 1);
  assert.match(pool.clarificationUpdates[0].sql, /WHERE tenant_id = \?/i);
  assert.match(pool.clarificationUpdates[0].sql, /AND project_id = \?/i);
  assert.deepEqual(pool.clarificationUpdates[0].params.slice(-3), ['tenant-1', 'project-1', 'CLAR-001']);
});

test('mysql assistant repository applies clarification discussion reviews without opening a nested transaction', async () => {
  const pool = createClarificationDiscussionReviewPool();
  const repository = createMysqlAssistantRepository({ pool });

  const clarification = await repository.applyClarificationDiscussionReview({
    clarificationId: 'clar-1',
    comment: 'This answer is ready to use in the project settings view.',
    currentAnswer: 'Legal, privacy, and security approvals are required before launch.',
    explicit: true,
    projectId: 'project-1',
    tenantId: 'tenant-1',
  });

  assert.equal(pool.getConnectionCalls(), 1);
  assert.equal(
    clarification.currentAnswer,
    'Legal, privacy, and security approvals are required before launch.',
  );
  assert.equal(clarification.status, 'answered');
  assert.equal(clarification.comments.length, 1);
  assert.equal(clarification.comments[0].source, 'ask-odin');
});

test('assistant repository keeps clarification order stable when activity changes', async () => {
  const repository = createInMemoryAssistantRepository();

  await repository.syncProjectClarifications({
    clarifications: [
      {
        createdAt: '2026-05-15T10:00:00.000Z',
        id: 'clar-older',
        lastActivityAt: '2026-05-15T10:00:00.000Z',
        linkedSection: 'brief',
        prompt: 'What approval path is required?',
        rationale: 'Approval still needs to be defined.',
        status: 'open',
      },
      {
        createdAt: '2026-05-15T10:05:00.000Z',
        id: 'clar-newer',
        lastActivityAt: '2026-05-15T10:05:00.000Z',
        linkedSection: 'brief',
        prompt: 'Which systems are in scope?',
        rationale: 'System scope affects rollout planning.',
        status: 'open',
      },
    ],
    projectId: 'project-1',
    stakeholderContacts: [],
    tenantId: 'tenant-1',
  });

  await repository.addProjectClarificationComment({
    clarificationId: 'clar-older',
    comment: {
      actorId: 'user-1',
      actorType: 'user',
      authorName: 'Grace Hopper',
      body: 'Older clarification now has recent activity.',
      source: 'comment',
    },
    projectId: 'project-1',
    tenantId: 'tenant-1',
  });

  await repository.updateProjectClarification({
    clarificationId: 'clar-older',
    patch: {
      status: 'resolved',
    },
    projectId: 'project-1',
    tenantId: 'tenant-1',
  });

  const clarifications = await repository.listProjectClarifications({
    projectId: 'project-1',
    tenantId: 'tenant-1',
  });

  assert.deepEqual(
    clarifications.map((clarification) => clarification.id),
    ['clar-older', 'clar-newer'],
  );
});

test('assistant repository resolves active invitation links when imported stakeholder rows are missing', async () => {
  const repository = createInMemoryAssistantRepository();

  await repository.syncProjectClarifications({
    clarifications: [{
      assignments: [{
        actorId: 'stakeholder-imported',
        actorType: 'stakeholder',
        label: 'Imported Sponsor',
        role: 'primary',
      }],
      blockingArea: 'stakeholders',
      id: 'clar-imported',
      linkedSection: 'brief',
      prompt: 'Who signs off on the imported plan?',
      status: 'open',
    }],
    projectId: 'project-imported',
    stakeholderContacts: [],
    tenantId: 'tenant-1',
  });

  const [clarification] = await repository.listProjectClarifications({
    projectId: 'project-imported',
    tenantId: 'tenant-1',
  });
  const invitationToken = clarification.assignments[0]?.invitationToken;
  const accessContext = await repository.getProjectClarificationAccessContext({
    accessToken: invitationToken,
  });

  assert.equal(accessContext?.stakeholder.id, 'stakeholder-imported');
  assert.equal(accessContext?.stakeholder.name, 'Imported Sponsor');
  assert.equal(accessContext?.focusClarificationId, 'clar-imported');
  assert.equal(accessContext?.clarifications.length, 1);
});
