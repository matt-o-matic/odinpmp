import { ID, route } from './shared.js';

// Tickets, ticket comments and links, and comment mentions (ticket-tools.js, catalog.js).
// Creating, deleting, commenting on and linking tickets use the items, comments and relations
// routes in route-access.js.
export const routes = [
  // A ticket's choices: the workspace's environments and releases for this project.
  route('GET', `^/api/projects/${ID}/ticket-config$`),
  // People a comment can @mention.
  route('GET', `^/api/projects/${ID}/mentionables$`),
  // Tickets from outside the team awaiting triage: metadata and an automated check, no content.
  route('GET', `^/api/projects/${ID}/tickets/awaiting-review$`),
  // Triage: a decision on a ticket submitted from outside the team, and nothing else. The route
  // runs every MCP validation through the automated check; a body may confirm that, never waive it.
  route('POST', `^/api/projects/${ID}/items/${ID}/review$`, {
    body: (body) => Object.keys(body).every((field) => ['agentCheck', 'expectedVersion', 'state'].includes(field)) && ['validated', 'rejected'].includes(body.state) && [undefined, true].includes(body.agentCheck),
  }),
];
