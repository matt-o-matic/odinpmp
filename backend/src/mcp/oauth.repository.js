const copy = (value) => value == null ? null : structuredClone(value);
const valid = (record, now) => record && !record.revokedAt && Date.parse(record.expiresAt) > now;
const matches = (record, expected) => Object.entries(expected).every(([key, value]) => record[key] === value);

export function createInMemoryMcpOAuthRepository() {
  const state = { clients: new Map(), codes: new Map(), families: new Map(), tokens: new Map() };
  const insertTokens = (tokens) => { for (const token of tokens) state.tokens.set(token.tokenHash, copy(token)); };
  return {
    state,
    async createClient(client) { state.clients.set(client.clientId, copy(client)); return copy(client); },
    async getClient(clientId) { return copy(state.clients.get(clientId)); },
    async createCode(code) { state.codes.set(code.codeHash, copy(code)); },
    async getCode(codeHash) { return copy(state.codes.get(codeHash)); },
    async redeemCode({ codeHash, expected, family, tokens, now }) {
      const code = state.codes.get(codeHash);
      if (!valid(code, now) || code.consumedAt || !matches(code, expected)) return false;
      code.consumedAt = new Date(now).toISOString();
      state.families.set(family.id, copy(family)); insertTokens(tokens); return true;
    },
    async getToken(tokenHash) {
      const token = state.tokens.get(tokenHash);
      return token ? { token: copy(token), family: copy(state.families.get(token.familyId)) } : null;
    },
    async rotateRefresh({ tokenHash, clientId, resource, tokens, now }) {
      const token = state.tokens.get(tokenHash), family = state.families.get(token?.familyId);
      if (token?.kind !== 'refresh' || family?.clientId !== clientId || family.resource !== resource || !valid(family, now)) return false;
      if (token.consumedAt) { family.revokedAt = new Date(now).toISOString(); return false; }
      if (!valid(token, now)) return false;
      token.consumedAt = new Date(now).toISOString(); insertTokens(tokens); return true;
    },
    async revokeFamily({ familyId, clientId, now }) {
      const family = state.families.get(familyId);
      if (family?.clientId === clientId) family.revokedAt = new Date(now).toISOString();
    },
    async revokeApplication({ applicationId, tenantId, now }) {
      for (const code of state.codes.values()) {
        if (code.applicationId === applicationId && code.tenantId === tenantId && !code.revokedAt) code.revokedAt = new Date(now).toISOString();
      }
      for (const family of state.families.values()) {
        if (family.applicationId === applicationId && family.tenantId === tenantId && !family.revokedAt) family.revokedAt = new Date(now).toISOString();
      }
    },
  };
}

// 0086_mcp_oauth
export async function ensureMysqlMcpOAuthSchema(pool) {
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS mcp_oauth_clients (client_id VARCHAR(128) PRIMARY KEY, application_id VARCHAR(36) NOT NULL UNIQUE, payload JSON NOT NULL)',
    'CREATE TABLE IF NOT EXISTS mcp_oauth_codes (code_hash CHAR(64) PRIMARY KEY, payload JSON NOT NULL)',
    'CREATE TABLE IF NOT EXISTS mcp_oauth_families (id VARCHAR(36) PRIMARY KEY, payload JSON NOT NULL)',
    'CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (token_hash CHAR(64) PRIMARY KEY, family_id VARCHAR(36) NOT NULL, payload JSON NOT NULL, KEY idx_mcp_token_family (family_id))',
  ]) await pool.execute(sql);
}

export function createMysqlMcpOAuthRepository(pool) {
  const read = async (executor, table, column, value, lock = false) => {
    const [rows] = await executor.execute(`SELECT payload FROM ${table} WHERE ${column} = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [value]);
    const payload = rows[0]?.payload;
    return payload == null ? null : typeof payload === 'string' ? JSON.parse(payload) : payload;
  };
  const save = (executor, table, column, key, value) => executor.execute(`UPDATE ${table} SET payload = ? WHERE ${column} = ?`, [JSON.stringify(value), key]);
  const insertTokens = async (executor, tokens) => {
    for (const token of tokens) await executor.execute('INSERT INTO mcp_oauth_tokens (token_hash, family_id, payload) VALUES (?, ?, ?)', [token.tokenHash, token.familyId, JSON.stringify(token)]);
  };
  const transaction = async (handler) => {
    const connection = await pool.getConnection();
    try { await connection.beginTransaction(); const result = await handler(connection); await connection.commit(); return result; }
    catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  };
  return {
    async createClient(client) { await pool.execute('INSERT INTO mcp_oauth_clients (client_id, application_id, payload) VALUES (?, ?, ?)', [client.clientId, client.applicationId, JSON.stringify(client)]); return copy(client); },
    async getClient(clientId) { return read(pool, 'mcp_oauth_clients', 'client_id', clientId); },
    async createCode(code) { await pool.execute('INSERT INTO mcp_oauth_codes (code_hash, payload) VALUES (?, ?)', [code.codeHash, JSON.stringify(code)]); },
    async getCode(codeHash) { return read(pool, 'mcp_oauth_codes', 'code_hash', codeHash); },
    redeemCode({ codeHash, expected, family, tokens, now }) {
      return transaction(async (connection) => {
        const code = await read(connection, 'mcp_oauth_codes', 'code_hash', codeHash, true);
        if (!valid(code, now) || code.consumedAt || !matches(code, expected)) return false;
        code.consumedAt = new Date(now).toISOString();
        await save(connection, 'mcp_oauth_codes', 'code_hash', codeHash, code);
        await connection.execute('INSERT INTO mcp_oauth_families (id, payload) VALUES (?, ?)', [family.id, JSON.stringify(family)]);
        await insertTokens(connection, tokens); return true;
      });
    },
    async getToken(tokenHash) {
      const [rows] = await pool.execute('SELECT t.payload AS token_payload, f.payload AS family_payload FROM mcp_oauth_tokens t INNER JOIN mcp_oauth_families f ON f.id = t.family_id WHERE t.token_hash = ? LIMIT 1', [tokenHash]);
      if (!rows[0]) return null;
      const parse = (value) => typeof value === 'string' ? JSON.parse(value) : value;
      return { token: parse(rows[0].token_payload), family: parse(rows[0].family_payload) };
    },
    rotateRefresh({ tokenHash, clientId, resource, tokens, now }) {
      return transaction(async (connection) => {
        const initial = await read(connection, 'mcp_oauth_tokens', 'token_hash', tokenHash);
        if (!initial) return false;
        const family = await read(connection, 'mcp_oauth_families', 'id', initial.familyId, true);
        const token = await read(connection, 'mcp_oauth_tokens', 'token_hash', tokenHash, true);
        if (token?.kind !== 'refresh' || family?.clientId !== clientId || family.resource !== resource || !valid(family, now)) return false;
        if (token.consumedAt) { family.revokedAt = new Date(now).toISOString(); await save(connection, 'mcp_oauth_families', 'id', family.id, family); return false; }
        if (!valid(token, now)) return false;
        token.consumedAt = new Date(now).toISOString(); await save(connection, 'mcp_oauth_tokens', 'token_hash', tokenHash, token);
        await insertTokens(connection, tokens); return true;
      });
    },
    revokeFamily({ familyId, clientId, now }) {
      return transaction(async (connection) => {
        const family = await read(connection, 'mcp_oauth_families', 'id', familyId, true);
        if (family?.clientId === clientId) { family.revokedAt = new Date(now).toISOString(); await save(connection, 'mcp_oauth_families', 'id', familyId, family); }
      });
    },
    revokeApplication({ applicationId, tenantId, now }) {
      return transaction(async (connection) => {
        for (const table of ['mcp_oauth_codes', 'mcp_oauth_families']) await connection.execute(`UPDATE ${table} SET payload = JSON_SET(payload, '$.revokedAt', ?) WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.applicationId')) = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.tenantId')) = ? AND (JSON_EXTRACT(payload, '$.revokedAt') IS NULL OR JSON_TYPE(JSON_EXTRACT(payload, '$.revokedAt')) = 'NULL')`, [new Date(now).toISOString(), applicationId, tenantId]);
      });
    },
  };
}
