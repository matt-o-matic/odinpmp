// Polls on posts (polls.js, 0108_polls). Spread into the projects repositories, as the channel
// and Odin reply methods are.

const iso = (value) => (value ? new Date(value).toISOString() : null);
const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

function pollFromRow(row) {
  return {
    closedAt: iso(row.closed_at),
    closedBy: row.closed_by ?? null,
    closesAt: iso(row.closes_at),
    createdAt: iso(row.created_at),
    kind: row.kind,
    options: json(row.options_json) ?? [],
    postId: row.post_id,
    question: row.question,
    settings: json(row.settings_json) ?? {},
    tenantId: row.tenant_id,
  };
}

function voteFromRow(row) {
  return {
    answer: json(row.answer_json),
    postId: row.post_id,
    updatedAt: iso(row.updated_at),
    voterId: row.voter_id,
    voterName: row.voter_name ?? '',
    voterType: row.voter_type,
  };
}

export function createInMemoryPollMethods({ state }) {
  state.polls ??= [];
  state.pollVotes ??= [];
  const clone = (value) => structuredClone(value);

  return {
    async createPoll({ poll }) {
      const stored = { closedAt: null, closedBy: null, createdAt: new Date().toISOString(), ...clone(poll) };
      state.polls = state.polls.filter((entry) => entry.postId !== poll.postId);
      state.polls.push(stored);
      return clone(stored);
    },
    async listPolls({ postIds = [], tenantId }) {
      const ids = new Set(postIds);
      return state.polls.filter((entry) => entry.tenantId === tenantId && ids.has(entry.postId)).map(clone);
    },
    async listPollVotes({ postIds = [], tenantId }) {
      const ids = new Set(postIds);
      return state.pollVotes.filter((entry) => entry.tenantId === tenantId && ids.has(entry.postId)).map(clone);
    },
    // One vote per person: a second vote replaces the first.
    async setPollVote({ answer, postId, tenantId, voterId, voterName = '', voterType }) {
      const now = new Date().toISOString();
      const existing = state.pollVotes.find((entry) => entry.postId === postId && entry.voterType === voterType && entry.voterId === voterId);
      if (existing) Object.assign(existing, { answer: clone(answer), updatedAt: now, voterName });
      else state.pollVotes.push({ answer: clone(answer), createdAt: now, postId, tenantId, updatedAt: now, voterId, voterName, voterType });
      return true;
    },
    async closePoll({ closedBy, postId, tenantId }) {
      const poll = state.polls.find((entry) => entry.postId === postId && entry.tenantId === tenantId);
      if (!poll) return null;
      if (!poll.closedAt) Object.assign(poll, { closedAt: new Date().toISOString(), closedBy });
      return clone(poll);
    },
  };
}

export function createMysqlPollMethods({ pool }) {
  return {
    async createPoll({ poll }) {
      await pool.execute(
        `INSERT INTO post_polls (post_id, tenant_id, kind, question, options_json, settings_json, closes_at, closed_at, closed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NOW(3))`,
        [poll.postId, poll.tenantId, poll.kind, poll.question, JSON.stringify(poll.options), JSON.stringify(poll.settings), poll.closesAt ? new Date(poll.closesAt) : null],
      );
      const [rows] = await pool.execute('SELECT * FROM post_polls WHERE post_id = ? AND tenant_id = ?', [poll.postId, poll.tenantId]);
      return rows[0] ? pollFromRow(rows[0]) : null;
    },
    async listPolls({ postIds = [], tenantId }) {
      if (!postIds.length) return [];
      const [rows] = await pool.query('SELECT * FROM post_polls WHERE tenant_id = ? AND post_id IN (?)', [tenantId, postIds]);
      return rows.map(pollFromRow);
    },
    async listPollVotes({ postIds = [], tenantId }) {
      if (!postIds.length) return [];
      const [rows] = await pool.query('SELECT * FROM post_poll_votes WHERE tenant_id = ? AND post_id IN (?) ORDER BY created_at, voter_id', [tenantId, postIds]);
      return rows.map(voteFromRow);
    },
    async setPollVote({ answer, postId, tenantId, voterId, voterName = '', voterType }) {
      await pool.execute(
        `INSERT INTO post_poll_votes (post_id, tenant_id, voter_type, voter_id, voter_name, answer_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE answer_json = VALUES(answer_json), voter_name = VALUES(voter_name), updated_at = NOW(3)`,
        [postId, tenantId, voterType, voterId, voterName || null, JSON.stringify(answer)],
      );
      return true;
    },
    async closePoll({ closedBy, postId, tenantId }) {
      await pool.execute('UPDATE post_polls SET closed_at = NOW(3), closed_by = ? WHERE post_id = ? AND tenant_id = ? AND closed_at IS NULL', [closedBy, postId, tenantId]);
      const [rows] = await pool.execute('SELECT * FROM post_polls WHERE post_id = ? AND tenant_id = ?', [postId, tenantId]);
      return rows[0] ? pollFromRow(rows[0]) : null;
    },
  };
}
