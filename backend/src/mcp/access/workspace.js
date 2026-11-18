import { ID, route } from './shared.js';

// The workspace tools MCP clients share with the assistant, and governance (workspace-tools.js).
// The project, sprint, item, valid-users and team routes those tools also call are listed in
// route-access.js and resources.js. Odin checks project read on every read here and plan-edit on
// every write; change-scope.js keeps sprint moves, milestones, dependencies, the working calendar
// and baselines to the project's admins and managers.
const PROJECT = `^/api/projects/${ID}`;
const GOVERNANCE = `${PROJECT}/governance`;

export const routes = [
  route('GET', `${PROJECT}/items/${ID}/revisions$`),
  route('GET', `${PROJECT}/tickets$`),
  // Every project's tickets at once. route-access.js's own project pattern also matches this path
  // and takes "tickets" for a project id, which refuses grants limited to some projects the same way.
  route('GET', '^/api/projects/tickets$', { project: 'none' }),
  route('GET', `${PROJECT}/insights$`),
  route('POST', `${PROJECT}/sprints/assign-items$`),
  route('GET', `${GOVERNANCE}$`),
  route('GET', `${GOVERNANCE}/schedule-analysis$`),
  route('POST', `${GOVERNANCE}/(?:items|milestones|dependencies)$`),
  ...['PATCH', 'DELETE'].map((verb) => route(verb, `${GOVERNANCE}/(?:items|milestones|dependencies)/${ID}$`)),
  route('PUT', `${GOVERNANCE}/working-calendar$`),
  route('POST', `${GOVERNANCE}/schedule-baselines$`),
  // Across projects. Home names no project, so grants limited to some projects are refused it.
  // Search must name one of such a grant's projects, and then leaves out workspace-wide records.
  route('GET', '^/api/home$', { project: 'none' }),
  route('GET', '^/api/reporting/search$', { project: 'query' }),
];
