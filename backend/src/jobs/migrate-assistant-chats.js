import 'dotenv/config';

import { loadEnv } from '../config/env.js';
import { createMysqlPool } from '../lib/db/mysql.js';
import { normalizeAgentMarkdown } from '../lib/agent/agent-markdown.js';
import { createMysqlAgentChatsRepository } from '../modules/assistant/agent-chats.repository.js';

// Copies conversations from the old assistant sessions (preferences keys `as:` and the legacy
// `assistant_session:`) into assistant chats, keeping each message and the title. Their drafts
// and review proposals are not carried over; old replies get their lost line breaks back where
// the markdown shows them. The old rows are left in place. Safe to run again:
// a chat that already exists is skipped. `--dry-run` reports what it would copy.

const KEY_PATTERNS = ['as:%', 'assistant_session:%'];

export function chatFromSession(session) {
  const messages = (session.conversation ?? [])
    .filter((message) => ['user', 'assistant'].includes(message.role) && String(message.content ?? '').trim())
    .map((message) => ({
      content: message.role === 'assistant' ? normalizeAgentMarkdown(message.content) : String(message.content),
      createdAt: message.createdAt ?? session.createdAt,
      id: message.id,
      role: message.role,
    }));
  return {
    createdAt: session.createdAt,
    id: session.id,
    messages,
    projectId: session.projectId ?? null,
    run: null,
    tenantId: session.tenantId,
    title: String(session.title ?? '').trim(),
    titleSource: session.titleSource === 'user' ? 'user' : 'auto',
    updatedAt: session.updatedAt ?? session.createdAt,
    userId: session.userId,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const env = loadEnv(process.env);
  if (!env.databaseUrl) throw new Error('DATABASE_URL is required to migrate assistant chats.');
  const pool = createMysqlPool(env.databaseUrl);
  const chats = createMysqlAgentChatsRepository({ pool });
  const counts = { copied: 0, empty: 0, existing: 0, skippedDeleted: 0 };
  try {
    const [rows] = await pool.execute(`SELECT \`key\`, value FROM preferences WHERE ${KEY_PATTERNS.map(() => '`key` LIKE ?').join(' OR ')}`, KEY_PATTERNS);
    const seen = new Set();
    for (const row of rows) {
      let session;
      try { session = JSON.parse(row.value); } catch { continue; }
      if (!session?.id || !session.tenantId || !session.userId || seen.has(session.id)) continue;
      seen.add(session.id);
      if (session.deletedAt) { counts.skippedDeleted += 1; continue; }
      const chat = chatFromSession(session);
      if (!chat.messages.length) { counts.empty += 1; continue; }
      if (await chats.get({ chatId: chat.id, tenantId: chat.tenantId, userId: chat.userId })) { counts.existing += 1; continue; }
      counts.copied += 1;
      console.log(`${dryRun ? 'Would copy' : 'Copying'} "${chat.title || 'Untitled'}" (${chat.messages.length} messages) for user ${chat.userId}.`);
      if (!dryRun) await chats.save(chat);
    }
    console.log(JSON.stringify({ dryRun, ...counts }));
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('migrate-assistant-chats.js')) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
