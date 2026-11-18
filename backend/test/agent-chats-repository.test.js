import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryAgentChatsRepository, createMysqlAgentChatsRepository } from '../src/modules/assistant/agent-chats.repository.js';

// A generated chat title is set on its own, and only over the title cut from the first message.

const owner = { tenantId: 'tenant-1', userId: 'user-1' };

test('in memory, a generated title replaces only the automatic one', async () => {
  const repository = createInMemoryAgentChatsRepository();
  await repository.save({ ...owner, id: 'chat-auto', title: 'Summarize the project', titleSource: 'auto' });
  await repository.save({ ...owner, id: 'chat-user', title: 'My notes', titleSource: 'user' });
  const named = await repository.setGeneratedTitle({ ...owner, chatId: 'chat-auto', title: ' Project summary ' });
  assert.deepEqual([named.title, named.titleSource], ['Project summary', 'generated']);
  assert.equal(await repository.setGeneratedTitle({ ...owner, chatId: 'chat-auto', title: 'Again' }), null, 'named once');
  assert.equal(await repository.setGeneratedTitle({ ...owner, chatId: 'chat-user', title: 'Generated' }), null);
  assert.equal((await repository.get({ ...owner, chatId: 'chat-user' })).title, 'My notes');
  assert.equal(await repository.setGeneratedTitle({ ...owner, chatId: 'chat-auto', tenantId: 'tenant-2', title: 'Other tenant' }), null);
});

test('on MySQL one conditional statement sets the title, and a renamed chat is left alone', async () => {
  const statements = [];
  const stored = { createdAt: '2026-10-28T10:00:00.000Z', id: 'chat-1', messages: [], tenantId: 'tenant-1', title: 'Project summary', titleSource: 'generated', updatedAt: '2026-10-28T10:01:00.000Z', userId: 'user-1' };
  let affectedRows = 1;
  const pool = {
    async execute(sql, params) {
      statements.push({ params, sql: sql.replace(/\s+/g, ' ').trim() });
      return sql.startsWith('SELECT') ? [[{ value: JSON.stringify(stored) }]] : [{ affectedRows }];
    },
  };
  const repository = createMysqlAgentChatsRepository({ pool });
  const named = await repository.setGeneratedTitle({ ...owner, chatId: 'chat-1', title: ' Project summary ' });
  assert.equal(named.title, 'Project summary');
  const [update] = statements;
  assert.match(update.sql, /^UPDATE preferences SET value = JSON_SET\(value, '\$\.title', \?, '\$\.titleSource', 'generated'\)/);
  assert.match(update.sql, /COALESCE\(JSON_UNQUOTE\(JSON_EXTRACT\(value, '\$\.titleSource'\)\), 'auto'\) = 'auto'$/);
  assert.doesNotMatch(update.sql, /updated_at/, 'naming is not activity');
  assert.deepEqual(update.params, ['Project summary', 'tenant-1', 'user-1', 'ac:chat-1']);

  affectedRows = 0;
  statements.length = 0;
  assert.equal(await repository.setGeneratedTitle({ ...owner, chatId: 'chat-1', title: 'Late' }), null);
  assert.equal(statements.length, 1, 'nothing read back when nothing changed');
});
