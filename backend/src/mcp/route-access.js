import { HttpError } from '../lib/errors/http-error.js';
import { parseMentionTokens } from '../modules/requirements/mentions/mention-tokens.js';
import { AREA_ROUTES } from './access/index.js';

const TOPIC_TEXT_FIELDS = ['prompt', 'rationale', 'settles', 'suggestedOwnerRole'];
const MCP_DECISION_OUTCOMES = ['agreed', 'decided', 'deferred'];

function mcpRequestBodyAllowed(method, path, body) {
  const fields = Object.keys(body);
  const only = (allowed) => fields.length > 0 && fields.every((field) => allowed.includes(field));
  if (method === 'PATCH' && /\/topics\/[^/]+$/.test(path)) {
    if ('assignments' in body || 'expectedInvitationRecipients' in body) {
      return Array.isArray(body.assignments) && Array.isArray(body.expectedInvitationRecipients) && only(['assignments', 'expectedInvitationRecipients']);
    }
    if ('status' in body) return only(['status']) && ['dismissed', 'open'].includes(body.status);
    return only(TOPIC_TEXT_FIELDS);
  }
  if (method === 'POST' && /\/tracks\/[^/]+\/topics$/.test(path)) {
    return body.assignments === undefined || (Array.isArray(body.assignments) && body.assignments.length === 0);
  }
  if (method === 'POST' && /\/topics\/[^/]+\/comments$/.test(path)) {
    return typeof body.body === 'string' && parseMentionTokens(body.body).every((token) => token.kind === 'user');
  }
  if (method === 'POST' && /\/requirements\/decisions$/.test(path)) return MCP_DECISION_OUTCOMES.includes(body.outcome);
  if (method === 'POST' && /\/requirements\/rounds$/.test(path)) return body.closePrevious === undefined;
  if (method === 'POST' && /\/requirements\/links$/.test(path)) return body.send === true;
  return true;
}

// MCP credentials are accepted only on the REST operations used by the tool catalog.
export function requireMcpRouteAccess(request, grant) {
  const url = new URL(request.originalUrl, 'http://odin.internal');
  const path = url.pathname;
  const method = request.method;
  const resource = '[A-Za-z0-9_-]+';
  const track = '(?:experience|architecture)';
  const requirements = `^/api/projects/${resource}/requirements`;
  // Fixed routes beside /api/projects/:id: the ticket review queue holds unreviewed ticket content.
  const project = '(?!(?:deleted|import|ticket-review-queue|tickets)$)[A-Za-z0-9_-]+';
  const routes = [
    ['GET', '^/api/projects$'], ['POST', '^/api/projects$'],
    ['GET', `^/api/projects/${project}$`], ['PUT', `^/api/projects/${project}$`],
    ['PATCH', `^/api/projects/${resource}/assistant-brief$`],
    ['POST', `^/api/projects/${resource}/items$`],
    ...['PATCH', 'DELETE'].map(verb => [verb, `^/api/projects/${resource}/items/${resource}$`]),
    ...['GET', 'POST'].map(verb => [verb, `^/api/projects/${resource}/items/${resource}/relations$`]),
    ['DELETE', `^/api/projects/${resource}/relations/${resource}$`],
    ['GET', `^/api/projects/${resource}/kanban$`],
    ...['GET', 'PUT'].map(verb => [verb, `^/api/projects/${resource}/kanban/config$`]),
    ['POST', `^/api/projects/${resource}/kanban/reorder$`],
    ...['GET', 'POST'].map(verb => [verb, `^/api/projects/${resource}/sprints$`]),
    ['PUT', `^/api/projects/${resource}/sprints/${resource}$`],
    ['POST', `^/api/projects/${resource}/sprints/${resource}/(?:activate|complete)$`],
    ...['GET', 'POST'].map(verb => [verb, `^/api/projects/${resource}/comments$`]),
    ...['PUT', 'DELETE'].map(verb => [verb, `^/api/projects/${resource}/comments/${resource}$`]),
    ['GET', '^/api/workflows$'],
    // Requirements: reads for the context and feedback tools, plus upload URLs for
    // package drafts. Closing rounds, preferences, plans, proposed work, reviews and decision
    // edits stay outside every MCP grant.
    ['GET', `${requirements}$`],
    ['GET', `${requirements}/tracks/${track}/(?:topics|decisions)$`],
    // Topic administration and topic decisions (requirements-topic-tools.js). Odin checks
    // member access and decision rights on each route as it does for people.
    ['POST', `${requirements}/tracks/${track}/topics$`],
    ['DELETE', `${requirements}/topics/${resource}$`],
    ['POST', `${requirements}/topics/${resource}/(?:move|comments)$`],
    ['GET', `${requirements}/topics/${resource}/summary/history$`],
    ['POST', `${requirements}/decisions$`],
    // Publishing a draft as a round and changing an open round's reviewers
    // (requirements-round-tools.js). Closing a round stays in Odin.
    ['POST', `${requirements}/rounds$`],
    ...['GET', 'PATCH'].map(verb => [verb, `${requirements}/rounds/${resource}$`]),
    ['GET', `${requirements}/rounds$`],
    ['GET', `${requirements}/rounds/${resource}/(?:results|feedback)$`],
    ['GET', `${requirements}/packages$`],
    ['POST', `${requirements}/packages/upload-urls$`],
    ['GET', `${requirements}/packages/uploads/${resource}$`],
    ['GET', `${requirements}/plans$`],
    // One topic's read and its save: assignments, a dismiss or reopen, or text (checked below).
    ...['GET', 'PATCH'].map(verb => [verb, `${requirements}/topics/${resource}$`]),
    // Stakeholder contacts and invitations.
    ['GET', `^/api/assistant/projects/${resource}/clarifications$`],
    ['POST', `^/api/assistant/projects/${resource}/stakeholder-contacts$`],
    ['PATCH', `^/api/assistant/projects/${resource}/stakeholder-contacts/${resource}$`],
    ...['GET', 'POST'].map(verb => [verb, `${requirements}/links$`]),
    ['POST', `${requirements}/links/${resource}/(?:revoke|extend)$`],
    // Project membership.
    ['GET', `^/api/projects/${resource}/valid-users$`],
    ['PUT', `^/api/projects/${resource}/permissions$`],
  ];
  // Routes added by area (access/), each saying where the request names its project. The list
  // above wins where both match, so its body checks always apply.
  const listed = routes.some(([verb, pattern]) => verb === method && new RegExp(pattern).test(path));
  const area = listed ? null : AREA_ROUTES.find((entry) => entry.method === method && entry.pattern.test(path));
  if (!listed && !area) {
    throw new HttpError(403, 'This operation is outside the MCP grant.');
  }
  // No grant may email a stakeholder nobody confirmed or obtain a link without its email:
  // - a topic save carries exactly one of: assignments with the expected invitation
  //   recipients, which Odin enforces as it saves; a dismiss or reopen; or text fields;
  // - a new topic carries no assignments, and a topic comment tags no stakeholder (tagging
  //   one who cannot see the topic invites them);
  // - a decision is recorded with a real outcome, never marked superseded directly;
  // - a round is published without closing the open one (closing records a round decision);
  // - a link is created only when Odin emails it.
  const body = request.body && typeof request.body === 'object' ? request.body : {};
  if (area ? area.body && !area.body(body, path) : !mcpRequestBodyAllowed(method, path, body)) {
    throw new HttpError(403, 'This operation is outside the MCP grant.');
  }
  if (!grant.scopes.includes('projects.read') || (method !== 'GET' && !grant.scopes.includes('projects.write'))) {
    throw new HttpError(403, 'The MCP grant lacks the required scope.');
  }
  if (area) {
    if (!grant.projectIds.length) return;
    // A grant limited to some projects reaches an area route only when the request names one of them.
    const named = {
      body: () => (typeof body.projectId === 'string' ? body.projectId : null),
      none: () => null,
      path: () => path.match(/^\/api\/(?:assistant\/|resource-planning\/)?projects\/([^/]+)/)?.[1] ?? null,
      query: () => url.searchParams.get('projectId'),
    }[area.project]();
    if (!named || !grant.projectIds.includes(named)) throw new HttpError(404, 'Project not found.');
    return;
  }
  const projectId = path.match(/^\/api\/(?:assistant\/)?projects\/([^/]+)/)?.[1] ?? url.searchParams.get('projectId');
  if (path === '/api/workflows' && !projectId) throw new HttpError(403, 'MCP workflow reads require a project.');
  if (grant.projectIds.length && ((projectId && !grant.projectIds.includes(projectId)) || (path === '/api/projects' && method === 'POST'))) {
    throw new HttpError(404, 'Project not found.');
  }
}
