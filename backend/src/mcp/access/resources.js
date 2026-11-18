import { ID, route } from './shared.js';

// People, resources, allocations, time and time off (resource-tools.js).
const project = `^/api/resource-planning/projects/${ID}`;
export const routes = [
  // For a grant limited to some projects, the team's directory and logins hold only the people on
  // those projects, and allocations and moved hours reach only them (resource-finance.service.js).
  route('GET', `${project}/team$`),
  // Adding someone without a login as a resource on the project, and changing their profile.
  route('POST', `${project}/resources$`),
  route('PATCH', `${project}/resources/${ID}$`),
  // Their task access, and their access link, which goes only by email: a link to copy would hand
  // the tool a working credential.
  route('GET', `${project}/task-access$`),
  route('PUT', `${project}/task-access/${ID}$`),
  route('POST', `${project}/task-access/${ID}/link$`, { body: (body) => body.delivery === 'email' }),
  // Allocations on the project: add someone already in Odin, change or end one, remove one, move hours.
  route('POST', `${project}/allocations$`),
  ...['PATCH', 'DELETE'].map((method) => route(method, `${project}/allocations/${ID}$`)),
  route('POST', `${project}/allocations/${ID}/level$`),
  // Time, logged, changed and deleted on the project. The list spans the user's projects, so a
  // grant limited to some projects must name one.
  route('GET', '^/api/resource-planning/time-entries$', { project: 'query' }),
  route('POST', `${project}/time-entries$`),
  ...['PATCH', 'DELETE'].map((method) => route(method, `${project}/time-entries/${ID}$`)),
  // Time off belongs to a person, not a project, so grants limited to some projects can't reach it.
  ...[['GET', '$'], ['POST', '$'], ['DELETE', `/${ID}$`]].map(([method, rest]) => route(method, `^/api/resource-planning/calendar-entries${rest}`, { project: 'none' })),
  // Sprint capacity: each member's hours in one sprint, saved as the sprint's whole list.
  route('PUT', `^/api/projects/${ID}/sprints/${ID}/staffing$`),
];
