import { ID, route } from './shared.js';

// Agents keeping a project in step with the world outside Odin (change-tools.js): what changed
// since a cursor, details for chosen items, and a batch of checked changes. Odin checks project
// read on the reads, and its usual item and comment rules on each change.
export const routes = [
  route('GET', `^/api/projects/${ID}/changes$`),
  route('GET', `^/api/projects/${ID}/item-details$`),
  route('POST', `^/api/projects/${ID}/item-changes$`),
];
