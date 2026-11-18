import { randomUUID } from 'node:crypto';

// The one way an existing account joins a workspace, shared by accepted invitations and
// approved join requests. An existing membership is left as it is. Returns whether one was added.

export function addWorkspaceMembershipMemory(user, { role, tenantId }) {
  if (user.memberships.some((membership) => membership.tenantId === tenantId)) return false;
  user.memberships.push({ role, tenantId });
  return true;
}

/** Runs inside the caller's transaction; the row lock keeps simultaneous joins to one membership. */
export async function addWorkspaceMembershipMysql(connection, { role, tenantId, userId }) {
  const [memberships] = await connection.execute('SELECT id FROM user_tenant WHERE user_id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE', [userId, tenantId]);
  if (memberships.length) return false;
  await connection.execute('INSERT INTO user_tenant (id, user_id, tenant_id, role) VALUES (?, ?, ?, ?)', [randomUUID(), userId, tenantId, role]);
  return true;
}
