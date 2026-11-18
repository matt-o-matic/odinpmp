// One MCP route an area's tools call. `pattern` is matched against the request path (use ID for
// a record id). `project` says where the request names its project, so a grant limited to some
// projects can be held to them:
// - 'path': /api/projects/:id/…, /api/assistant/projects/:id/… or /api/resource-planning/projects/:id/…
// - 'query': ?projectId=
// - 'body': the JSON body's projectId
// - 'none': no project in the request (a record id alone, or the whole workspace); grants limited
//   to some projects are refused
// `body`, when given, must return true for the request body or the call is refused.

export const ID = '[A-Za-z0-9_-]+';

export function route(method, pattern, { body = null, project = 'path' } = {}) {
  if (!['path', 'query', 'body', 'none'].includes(project)) throw new TypeError(`Unknown project source ${project}.`);
  return { body, method, pattern: new RegExp(pattern), project };
}
