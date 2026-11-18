function parseJson(value) { if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return {}; } }

export async function ensureMysqlSharedLiveEventSchema(executor) {
  await executor.execute(`CREATE TABLE IF NOT EXISTS shared_live_events (
    sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    event_id VARCHAR(36) NOT NULL,
    origin_id VARCHAR(64) NOT NULL,
    channel_name VARCHAR(500) NOT NULL,
    payload_json JSON NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY uq_shared_live_event_id (event_id),
    KEY idx_shared_live_events_expiry (expires_at),
    KEY idx_shared_live_events_channel (channel_name, sequence_id)
  )`);
}

export function createMysqlSharedLiveEventRepository({ pool }) {
  return {
    async append({ channel, eventId, expiresAt, originId, payload }) { await pool.execute('INSERT INTO shared_live_events (event_id, origin_id, channel_name, payload_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, NOW(3))', [eventId, originId, channel, JSON.stringify(payload), new Date(expiresAt)]); },
    async latestSequence() { const [rows] = await pool.execute('SELECT COALESCE(MAX(sequence_id), 0) AS sequence_id FROM shared_live_events'); return Number(rows[0]?.sequence_id ?? 0); },
    async listAfter({ limit = 200, sequence = 0 }) { const bounded = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 200)); const [rows] = await pool.execute(`SELECT * FROM shared_live_events WHERE sequence_id > ? ORDER BY sequence_id LIMIT ${bounded}`, [sequence]); return rows.map((row) => ({ channel: row.channel_name, createdAt: new Date(row.created_at).toISOString(), eventId: row.event_id, expiresAt: new Date(row.expires_at).toISOString(), originId: row.origin_id, payload: parseJson(row.payload_json), sequence: Number(row.sequence_id) })); },
    async purgeExpired() { const [result] = await pool.execute('DELETE FROM shared_live_events WHERE expires_at <= NOW(3)'); return Number(result.affectedRows); },
  };
}
