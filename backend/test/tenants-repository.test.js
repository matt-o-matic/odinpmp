import assert from 'node:assert/strict';
import test from 'node:test';

import { createMysqlTenantsRepository } from '../src/modules/tenants/tenants.repository.js';

function createPreferencePool({ selectValueRows = [] } = {}) {
  const calls = [];

  function buildExecutor() {
    return {
      async execute(sql, params = []) {
        calls.push({ params, sql });

        if (sql.includes('SELECT id') && sql.includes('FROM preferences')) {
          return [[]];
        }

        if (sql.includes('SELECT value') && sql.includes('FROM preferences')) {
          return [selectValueRows];
        }

        if (sql.includes('INSERT INTO preferences')) {
          return [{ affectedRows: 1 }];
        }

        if (sql.includes('DELETE FROM preferences')) {
          return [{ affectedRows: 1 }];
        }

        if (sql.startsWith('UPDATE preferences SET value = ?')) {
          return [{ affectedRows: 1 }];
        }

        throw new Error(`Unexpected SQL in test double: ${sql}`);
      },
    };
  }

  return {
    calls,
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

test('mysql tenants repository escapes the preferences key column for OpenAI config queries', async () => {
  const pool = createPreferencePool();
  const repository = createMysqlTenantsRepository({ pool });

  await repository.getOpenAiConfig({
    defaults: { enabled: false },
    tenantId: 'tenant-123',
  });
  await repository.saveOpenAiConfig({
    tenantId: 'tenant-123',
    config: { enabled: true, openai_key: 'sk-test' },
  });
  await repository.deleteOpenAiConfig({
    tenantId: 'tenant-123',
  });

  const sqlText = pool.calls.map((entry) => entry.sql.replace(/\s+/g, ' ').trim());

  assert.ok(sqlText.some((sql) => sql.includes("AND `key` = 'openai_config'")));
  assert.ok(sqlText.some((sql) => sql.includes('WHERE `key` = ?')));
  assert.ok(sqlText.some((sql) => sql.includes('INSERT INTO preferences (id, tenant_id, user_id, project_id, `key`, `value`, updated_at)')));
  assert.ok(sqlText.some((sql) => sql.includes("DELETE FROM preferences WHERE tenant_id = ? AND user_id IS NULL AND project_id IS NULL AND `key` = 'openai_config'")));
});

test('mysql tenants repository loads saved capability settings from openai_config preferences', async () => {
  const pool = createPreferencePool({
    selectValueRows: [{
      value: JSON.stringify({
        available_models: ['gpt-5.6-luna', 'gpt-5.5'],
        capabilities: {
          clarificationDiscussion: {
            enabledTools: ['project_context', 'web_search'],
            model: 'gpt-5.5',
            reasoningEffort: 'low',
          },
          intakeDialogue: {
            enabledTools: ['project_context', 'attachments'],
            model: 'gpt-5.6-luna',
            reasoningEffort: 'high',
          },
        },
        model_to_function: {
          aiAnalyze: 'gpt-5.5',
          aiEnhance: 'gpt-5.6-luna',
        },
        openai_key: 'sk-test',
      }),
    }],
  });
  const repository = createMysqlTenantsRepository({ pool });

  const config = await repository.getOpenAiConfig({
    defaults: { available_models: [], capabilities: {}, model_to_function: {}, openai_key: '' },
    tenantId: 'tenant-123',
  });

  assert.deepEqual(config.capabilities, {
    clarificationDiscussion: {
      enabledTools: ['project_context', 'web_search'],
      model: 'gpt-5.5',
      reasoningEffort: 'low',
    },
    intakeDialogue: {
      enabledTools: ['project_context', 'attachments'],
      model: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    },
  });
});
