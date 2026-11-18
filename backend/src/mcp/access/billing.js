import { ID, route } from './shared.js';

// A project's billing and its story-to-milestone mapping (billing-tools.js). Odin allows only
// finance-visible people on each route (billing.service.js); claims stay with invoice-gen.
const PROJECT = `^/api/projects/${ID}/billing`;

export const routes = [
  route('GET', `${PROJECT}$`),
  route('GET', `${PROJECT}/milestones$`),
  route('PUT', `${PROJECT}/milestones$`),
];
