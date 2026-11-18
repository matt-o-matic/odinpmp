import { ID, route } from './shared.js';

// Sharing files with stakeholders and signature requests (signing-tools.js). Signing itself
// happens only in the client portal, never through a credential.

const only = (body, fields) => Object.keys(body).every((field) => fields.includes(field));
const REQUEST_FIELDS = ['documents', 'kind', 'message', 'signerStakeholderIds', 'statement', 'subjectId', 'subjectType', 'title'];

export const routes = [
  route('PATCH', `^/api/projects/${ID}/files/${ID}/audience$`, {
    body: (body) => only(body, ['audience']) && ['internal', 'external'].includes(body.audience),
  }),
  route('GET', `^/api/projects/${ID}/signing-requests$`),
  route('GET', `^/api/projects/${ID}/signing-requests/${ID}$`),
  route('POST', `^/api/projects/${ID}/signing-requests$`, { body: (body) => only(body, REQUEST_FIELDS) }),
  route('POST', `^/api/projects/${ID}/signing-requests/${ID}/cancel$`, { body: (body) => only(body, ['reason']) }),
  route('POST', `^/api/projects/${ID}/signing-requests/${ID}/signers/${ID}/remove$`, { body: (body) => only(body, ['reason']) }),
  route('POST', `^/api/projects/${ID}/signing-requests/${ID}/remind$`, { body: (body) => only(body, ['signerId']) }),
];
