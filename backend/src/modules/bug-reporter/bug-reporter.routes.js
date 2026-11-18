import { Router } from 'express';
import { createOAuthApplicationMiddleware } from '../../lib/auth/oauth-application-middleware.js';
import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { registerReportingSessions } from './bug-reporter.sessions.js';
import { registerReportingUpdates } from './bug-reporter.updates.js';
import { registerReportingMail } from './bug-reporter.mail.js';
import { registerReportingTickets } from './bug-reporter.tickets.js';
import { registerReportingReplies } from './bug-reporter.replies.js';

// This bridge returns reporting identity only; clarification bearer links never leave Odin.
export function createBugReporterRouter({ authRepository, assistantRepository, platformRepository, projectRepository, tokenService, mailRepository, metricsRepository, workflowRepository, liveEventBus, mailReplyDomain = '', bugReporterEmailReplies = false }) {
  const router = Router();
  const oauth = createOAuthApplicationMiddleware({ authRepository, platformRepository, requiredScopes: ['projects.read'] });
  const wrap = fn => async (req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); await fn(req, res); } catch (error) { next(error); } };
  const missing = () => new HttpError(404, 'Project or collaborator not found.');
  async function assigned(user, projectId, tenantId) {
    if (!user?.memberships?.some(m => m.tenantId === tenantId)) return false;
    const access = await projectRepository.getProjectAccess({ projectId, tenantId, userId: user.id });
    return Boolean(access?.exists && access.projectRole);
  }
  async function internal(req) {
    const { application, token } = req.oauthAuth;
    if (!token.userId || !req.auth.user || req.auth.user.id !== token.userId) throw new HttpError(403, 'A delegated project member is required.');
    const id = req.params.projectId;
    if (id && (!application.projectIds.includes(id) || !await assigned(req.auth.user, id, application.tenantId))) throw missing();
    return application;
  }
  function safeStakeholder(value, application, projectId) {
    return { id: value.id, name: value.name, email: value.email, tenantId: application.tenantId, projectId };
  }
  router.get('/consent-info', createAuthMiddleware({ authRepository, tokenService }), wrap(async (req, res) => {
    const clientId = String(req.query.client_id ?? '');
    const redirectUri = String(req.query.redirect_uri ?? '');
    const application = await platformRepository.getOAuthApplicationByClientId({ clientId });
    if (!application?.enabled || !application.redirectUris.includes(redirectUri) || !application.scopes.includes('projects.read')) throw new HttpError(400, 'Invalid authorization request.');
    const projects = await projectRepository.listProjectsForTenant({ tenantId: application.tenantId, user: req.auth.user });
    const permitted = [];
    for (const project of projects) if (application.projectIds.includes(project.id) && await assigned(req.auth.user, project.id, application.tenantId)) permitted.push({ id: project.id, name: project.name });
    if (!permitted.length) throw new HttpError(403, 'You are not assigned to a project for this application.');
    res.json({ name: application.name, redirectOrigin: new URL(redirectUri).origin, projects: permitted });
  }));
  registerReportingSessions({ router, oauth, wrap, assigned, authRepository, platformRepository });
  registerReportingMail({ router, oauth, wrap, internal, assistantRepository, projectRepository, mailRepository });
  registerReportingUpdates({ router, oauth, wrap, internal, assigned, authRepository, assistantRepository, projectRepository, mailRepository, mailReplyDomain, emailReplies: bugReporterEmailReplies });
  registerReportingReplies({ router, oauth, wrap, mailRepository, projectRepository });
  const writeOauth = createOAuthApplicationMiddleware({ authRepository, platformRepository, requiredScopes: ['projects.write'] });
  registerReportingTickets({ router, oauth: writeOauth, wrap, assigned, authRepository, assistantRepository, metricsRepository, projectRepository, workflowRepository, liveEventBus });
  router.use(oauth);
  router.get('/access', wrap(async (req, res) => {
    const application = await internal(req);
    const projects = await projectRepository.listProjectsForTenant({ tenantId: application.tenantId, user: req.auth.user });
    const permitted = [];
    for (const project of projects) if (application.projectIds.includes(project.id) && await assigned(req.auth.user, project.id, application.tenantId)) permitted.push({ id: project.id, tenantId: application.tenantId, name: project.name, role: 'internal' });
    res.json({ identity: { id: req.auth.user.id, kind: 'internal', name: req.auth.user.name, tenantId: application.tenantId }, projects: permitted });
  }));
  router.get('/projects/:projectId/members', wrap(async (req, res) => {
    const application = await internal(req);
    const rows = await projectRepository.getValidUsers({ projectId: req.params.projectId, tenantId: application.tenantId });
    const members = [];
    for (const row of rows?.project_users ?? []) {
      const user = await authRepository.findUserById(row.id);
      if (await assigned(user, req.params.projectId, application.tenantId)) members.push({ id: row.id, name: row.name });
    }
    res.json({ members });
  }));
  router.get('/projects/:projectId/collaborators', wrap(async (req, res) => {
    const application = await internal(req);
    const values = await assistantRepository.listProjectStakeholders({ projectId: req.params.projectId, tenantId: application.tenantId });
    res.json({ collaborators: values.map(v => safeStakeholder(v, application, req.params.projectId)) });
  }));
  router.get('/projects/:projectId/collaborators/:stakeholderId', wrap(async (req, res) => {
    const application = req.oauthAuth.application;
    if (!application.projectIds.includes(req.params.projectId)) throw missing();
    if (req.oauthAuth.token.userId) await internal(req);
    const access = await projectRepository.getProjectAccess({ projectId: req.params.projectId, tenantId: application.tenantId, userId: req.oauthAuth.token.userId ?? '' });
    if (!access?.exists) throw missing();
    const values = await assistantRepository.listProjectStakeholders({ projectId: req.params.projectId, tenantId: application.tenantId });
    const stakeholder = values.find(v => v.id === req.params.stakeholderId);
    if (!stakeholder) throw missing();
    res.json({ collaborator: safeStakeholder(stakeholder, application, req.params.projectId) });
  }));
  return router;
}
