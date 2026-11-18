import { ID, route } from './shared.js';

// Approvals, custom fields, revisions, story splits and project templates (workflow-tools.js).
// An approval decision and a custom-value delete name only their record, so the tools put the
// project in the body, and Odin refuses a record that belongs to another project.
const namesProject = (body) => typeof body.projectId === 'string';

export const routes = [
  route('POST', '^/api/workflows/approvals$', { project: 'body' }),
  route('POST', `^/api/workflows/approvals/${ID}/decision$`, { body: namesProject, project: 'body' }),
  route('PUT', '^/api/workflows/custom-values$', { project: 'body' }),
  route('DELETE', `^/api/workflows/custom-values/${ID}$`, { body: namesProject, project: 'body' }),
  // Templates belong to the whole workspace, so a grant limited to some projects cannot list them.
  route('GET', '^/api/workflows/templates$', { project: 'none' }),
  route('POST', `^/api/projects/${ID}/items/${ID}/restore$`),
  route('POST', `^/api/projects/${ID}/stories/${ID}/split$`),
];
