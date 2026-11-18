import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../../lib/errors/http-error.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const lifetime = 30 * 86400000;
const grantType = 'bug_reporter_session';
const prefix = 'odin_reporting_session_';

export function registerReportingSessions({ router, oauth, wrap, assigned, authRepository, platformRepository }) {
  async function client(req) {
    if (typeof req.body?.client_id !== 'string' || typeof req.body?.client_secret !== 'string') throw new HttpError(401, 'Confidential client authentication is required.');
    const value = await platformRepository.authenticateOAuthClient({ clientId: req.body.client_id, clientSecretHash: hash(req.body.client_secret) });
    if (!value || !value.scopes.includes('projects.read')) throw new HttpError(401, 'Confidential client authentication failed.');
    return value;
  }
  async function currentUser(application, userId) {
    const user = await authRepository.findUserById(userId);
    if (!user || !user.memberships?.some(m => m.tenantId === application.tenantId)) throw new HttpError(401, 'The reporting identity is no longer available.');
    for (const projectId of application.projectIds) if (await assigned(user, projectId, application.tenantId)) return user;
    throw new HttpError(403, 'The user is no longer assigned to a reporting project.');
  }
  async function grant(req) {
    const application = await client(req), raw = req.body?.refresh_token;
    if (typeof raw !== 'string' || !raw.startsWith(prefix) || raw.length > 200) throw new HttpError(401, 'Invalid reporting session.');
    const value = await platformRepository.authenticateOAuthAccessToken({ tokenHash: hash(raw) });
    if (!value || value.application.id !== application.id || value.token.tenantId !== application.tenantId || value.token.grantType !== grantType || !value.token.userId) throw new HttpError(401, 'The reporting session has expired or been revoked.');
    return { application, token: value.token };
  }
  router.post('/session', oauth, wrap(async (req, res) => {
    const application = await client(req), { token, application: delegatedApplication } = req.oauthAuth;
    if (application.id !== delegatedApplication.id || token.grantType !== 'authorization_code' || !token.userId) throw new HttpError(403, 'A fresh delegated sign-in is required.');
    await currentUser(application, token.userId);
    const raw = prefix + randomBytes(48).toString('base64url'), expiresAt = new Date(Date.now() + lifetime).toISOString();
    await platformRepository.createOAuthAccessToken({ applicationId: application.id, expiresAt, grantType, scopes: ['projects.read'], tenantId: application.tenantId, tokenHash: hash(raw), userId: token.userId });
    res.json({ refresh_token: raw, expires_at: expiresAt });
  }));
  router.post('/session/refresh', wrap(async (req, res) => {
    const { application, token } = await grant(req);
    await currentUser(application, token.userId);
    if (req.body.activity !== undefined && typeof req.body.activity !== 'boolean') throw new HttpError(400, 'Activity must be a boolean.');
    const expiresAt = req.body.activity === true ? new Date(Date.now() + lifetime).toISOString() : null;
    const updated = await platformRepository.updateReportingSession({ applicationId: application.id, tenantId: application.tenantId, tokenId: token.id, expiresAt });
    if (!updated) throw new HttpError(401, 'The reporting session has expired or been revoked.');
    const access = 'odin_oauth_' + randomBytes(48).toString('base64url');
    await platformRepository.createOAuthAccessToken({ applicationId: application.id, expiresAt: new Date(Date.now() + 3600000).toISOString(), grantType: 'bug_reporter_access', scopes: ['projects.read'], tenantId: application.tenantId, tokenHash: hash(access), userId: token.userId });
    res.json({ access_token: access, expires_in: 3600, token_type: 'Bearer', session_expires_at: expiresAt ?? token.expiresAt });
  }));
  router.post('/session/revoke', wrap(async (req, res) => {
    const { application, token } = await grant(req);
    await platformRepository.updateReportingSession({ applicationId: application.id, tenantId: application.tenantId, tokenId: token.id, revoke: true });
    res.json({ ok: true });
  }));
}
