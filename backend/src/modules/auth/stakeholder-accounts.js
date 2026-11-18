// Users and stakeholders are separate actors in Odin: a stakeholder is never made from a user.
// A collaborator who reports through Bug Reporter owns their attachments through an account that
// shares their stakeholder email. An account with no tenant membership whose email belongs to a
// project stakeholder exists only to own such files, so it cannot sign in. It becomes an ordinary
// account when an invitation or identity provisioning makes it a member.

/** True when the email belongs to a stakeholder of any project. */
export async function isStakeholderEmail(executor, email) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!address) return false;
  try {
    const [rows] = await executor.execute('SELECT 1 FROM project_stakeholders WHERE email = ? LIMIT 1', [address]);
    return rows.length > 0;
  } catch (error) {
    // Databases that never stored a stakeholder have no such table, and so no such accounts.
    if (error?.code === 'ER_NO_SUCH_TABLE') return false;
    throw error;
  }
}

/** True for a no-login stakeholder account that nobody has claimed: no membership and no password. */
export async function isUnclaimedStakeholderAccount(executor, { email, userId }) {
  const [rows] = await executor.execute(
    'SELECT u.password, (SELECT COUNT(*) FROM user_tenant ut WHERE ut.user_id = u.id) AS memberships FROM users u WHERE u.id = ? LIMIT 1',
    [userId],
  );
  if (!rows[0] || rows[0].password != null || Number(rows[0].memberships) !== 0) return false;
  return isStakeholderEmail(executor, email);
}
