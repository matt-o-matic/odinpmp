import { parseMentionTokens } from '../../modules/requirements/mentions/mention-tokens.js';
import { FILE_LINK_TARGETS, FILE_TARGETS, UPLOAD_CONTENT_TYPES } from '../file-tools.js';
import { ID, route } from './shared.js';

// Project files, requirements extras, memory and monitors (file-tools.js, memory-tools.js).
// Memory and monitors are the in-app assistant's alone: their routes refuse MCP credentials.

const UPLOAD_FIELDS = ['createOnly', 'expectedSignature', 'fileContentsBase64', 'fileDescription', 'fileName', 'fileType', 'folderId', 'targetId', 'targetType'];
const VERSION_FIELDS = ['expectedVersion', 'fileContentsBase64', 'fileName', 'fileType', 'note'];
const only = (body, fields) => Object.keys(body).length > 0 && Object.keys(body).every((field) => fields.includes(field));

export const routes = [
  // Listing files, reading a text file, and deleting one, each named by its project.
  route('GET', `^/api/projects/${ID}/files$`),
  route('GET', `^/api/projects/${ID}/files/${ID}/text$`),
  route('DELETE', `^/api/projects/${ID}/files/${ID}$`),
  // A file itself, its versions, and its links to work items.
  route('GET', `^/api/projects/${ID}/files/${ID}/download$`),
  route('GET', `^/api/projects/${ID}/files/${ID}/view$`),
  route('GET', `^/api/projects/${ID}/files/${ID}/versions$`),
  route('POST', `^/api/projects/${ID}/files/${ID}/versions$`, {
    body: (body) => only(body, VERSION_FIELDS) && typeof body.fileContentsBase64 === 'string' && Number.isInteger(body.expectedVersion) && UPLOAD_CONTENT_TYPES.includes(body.fileType),
  }),
  route('POST', `^/api/projects/${ID}/files/${ID}/versions/[0-9]+/restore$`, {
    body: (body) => only(body, ['expectedVersion']) && Number.isInteger(body.expectedVersion),
  }),
  route('POST', `^/api/projects/${ID}/files/${ID}/links$`, {
    body: (body) => only(body, ['targetId', 'targetType']) && typeof body.targetId === 'string' && FILE_LINK_TARGETS.includes(body.targetType),
  }),
  route('DELETE', `^/api/projects/${ID}/files/${ID}/links/${ID}$`),
  // An upload carries no inline image flag, goes to the project or one of its items or topics
  // (not a ticket), and has a type a browser will not run as a page. It may ask Odin not to save
  // over a file it did not expect.
  route('POST', `^/api/projects/${ID}/files$`, {
    body: (body) => only(body, UPLOAD_FIELDS) && typeof body.fileContentsBase64 === 'string'
      && [undefined, true, false].includes(body.createOnly) && (body.expectedSignature == null || typeof body.expectedSignature === 'string')
      && (Object.values(FILE_TARGETS).includes(body.targetType) || body.targetType === 'channel') && UPLOAD_CONTENT_TYPES.includes(body.fileType)
      && (body.folderId == null || (body.targetType === 'channel' && typeof body.folderId === 'string')),
  }),
  // The file tree (the project, its channels and their folders), folders in a channel's library,
  // and renaming or moving a file in the tree (folder-tools.js).
  route('GET', `^/api/projects/${ID}/file-tree$`),
  route('POST', `^/api/projects/${ID}/channels/${ID}/folders$`, {
    body: (body) => only(body, ['name', 'parentId']) && typeof body.name === 'string' && (body.parentId == null || typeof body.parentId === 'string'),
  }),
  route('PATCH', `^/api/projects/${ID}/folders/${ID}$`, {
    body: (body) => only(body, ['name', 'parentId']) && (body.name === undefined || typeof body.name === 'string') && (body.parentId == null || typeof body.parentId === 'string'),
  }),
  route('DELETE', `^/api/projects/${ID}/folders/${ID}$`),
  route('PATCH', `^/api/projects/${ID}/files/${ID}$`, {
    body: (body) => only(body, ['confirmGuests', 'destination', 'fileName'])
      && (body.fileName === undefined || typeof body.fileName === 'string')
      && [undefined, true, false].includes(body.confirmGuests)
      && (body.destination === undefined || ['project', 'channel'].includes(body.destination?.kind)),
  }),
  // What the signed-in user owes on a project's requirements: topics to decide or answer, rounds
  // to review and draft packages.
  route('GET', `^/api/projects/${ID}/requirements/my-items$`),
  // Editing or deleting the user's own topic comment (Odin refuses anyone else's). An edit, like
  // a new comment, tags no stakeholder: tagging one who cannot see the topic invites them.
  route('PATCH', `^/api/projects/${ID}/requirements/topics/${ID}/comments/${ID}$`, {
    body: (body) => only(body, ['body']) && typeof body.body === 'string' && parseMentionTokens(body.body).every((token) => token.kind === 'user'),
  }),
  route('DELETE', `^/api/projects/${ID}/requirements/topics/${ID}/comments/${ID}$`),
];
