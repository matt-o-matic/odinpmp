import assert from 'node:assert/strict';
import test from 'node:test';

import mysql from 'mysql2/promise';

import { createSharedLiveEventBus } from '../src/lib/events/shared-live-event-bus.js';
import { createMysqlSharedLiveEventRepository, ensureMysqlSharedLiveEventSchema } from '../src/lib/events/shared-live-event-repository.js';

const databaseUrl = String(process.env.ODIN_TEST_DATABASE_URL ?? '').trim();

test('MySQL shared live-event relay crosses API instances without duplicate local delivery', { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const pool = mysql.createPool(databaseUrl); await ensureMysqlSharedLiveEventSchema(pool); const repository = createMysqlSharedLiveEventRepository({ pool }); const first = createSharedLiveEventBus({ instanceId: 'mysql-first', pollIntervalMs: 60_000, repository }); const second = createSharedLiveEventBus({ instanceId: 'mysql-second', pollIntervalMs: 60_000, repository });
  try {
    await Promise.all([first.ready, second.ready]); const received = []; second.subscribe('assistant-session:1', (event) => received.push(event)); first.publish('assistant-session:1', { reason: 'turn-completed', type: 'invalidate' }); await first.flush(); const persisted = await repository.listAfter({ sequence: 0 }); assert.equal(persisted.length, 1); assert.equal(persisted[0].originId, 'mysql-first'); await second.poll(); await second.poll(); assert.equal(received.length, 1); assert.equal(received[0].reason, 'turn-completed');
    const [rows] = await pool.execute("SELECT origin_id, channel_name FROM shared_live_events WHERE origin_id = 'mysql-first'"); assert.equal(rows.length, 1); assert.equal(rows[0].channel_name, 'assistant-session:1');
  } finally { await Promise.all([first.stop(), second.stop()]); await pool.end(); }
});
