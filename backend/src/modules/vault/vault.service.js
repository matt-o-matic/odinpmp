import { PROJECT_CAPABILITIES, getTenantMembership, hasProjectCapability, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { assertFileScanClean } from '../../lib/files/file-scan-status.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { isTicketVisibleToAssistant } from '../assistant/assistant-ticket-visibility.js';
import { assertEditingConfirmed, resolveUploadFolder, withFolderPaths } from '../channels/channel-library.js';
import { assertRecordsNotHeld } from '../compliance/legal-hold.js';
import { assertFilesNotUnderSignature } from '../signing/signing-guards.js';
import { DOCUMENT_TEXT_LIMITS, extractDocumentText } from './vault-text.js';

// Files read back as text: plain text, markdown, CSV, JSON, YAML, XML, HTML and logs as they are,
// and Word documents (.docx), Excel workbooks (.xlsx), PowerPoint decks (.pptx) and PDFs through
// text extraction (vault-text.js). Images and other binary files are not.
const TEXT_TYPES = /^(?:text\/|application\/(?:json|ld\+json|xml|x-yaml|yaml|csv|x-ndjson|markdown|x-markdown|sql)(?:;|$))/i;
const TEXT_EXTENSIONS = /\.(?:txt|text|md|markdown|csv|tsv|json|xml|ya?ml|log|html?|sql|ics|vtt|srt)$/i;
const DOCX_TYPE = /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document(?:;|$)/i;
const XLSX_TYPE = /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet(?:;|$)/i;
const PPTX_TYPE = /^application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation(?:;|$)/i;
const DOCUMENT_EXTENSIONS = { docx: /\.docx$/i, pdf: /\.pdf$/i, pptx: /\.pptx$/i, xlsx: /\.xlsx$/i };
export const FILE_TEXT_MAX_BYTES = 5 * 1024 * 1024;
// The most a tool gets in a reply, base64-encoded: what it can send back in an upload.
export const MAX_INLINE_DOWNLOAD_BYTES = 700 * 1024;

const sameFileName = (left, right) => String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();

function getPrimaryTenantId(user) {
  return user.memberships?.[0]?.tenantId ?? null;
}

export function assertTenantId(user) {
  const tenantId = getPrimaryTenantId(user);

  if (!tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  return tenantId;
}

export async function requireFileCapability(user, projectId, repository, capability) {
  const tenantId = assertTenantId(user);
  await requireProjectCapability({ capability, projectId, repository, tenantId, user });
  return tenantId;
}

function normalizeRepositoryError(error) {
  if (error?.message === 'Forbidden') {
    throw new HttpError(403, 'Forbidden');
  }

  if (error?.message === 'Invalid file target.') {
    throw new HttpError(400, error.message);
  }

  if (error?.message === 'File failed virus scan.') {
    throw new HttpError(400, error.message);
  }

  throw error;
}

function logVaultRepositoryFailure({ error, operation, projectId = null, user, extra = {} }) {
  logBackendError({
    context: buildOperationLogContext(operation, {
      projectId,
      tenantId: getPrimaryTenantId(user),
      userId: user?.id ?? null,
      ...extra,
    }),
    error,
    level: 'warn',
    message: 'Vault repository operation failed.',
  });
}

// What agents (agentView) get of a project's files: none attached to a ticket from outside the
// team that nobody has validated (D-027), since intake names such files after the ticket and
// their contents are the reporter's. Nor any on a ticket since deleted, as nothing then shows it
// was validated. Checked against the project as it is now.
async function ticketsVisibleToAgents(repository, { projectId, tenantId }) {
  const project = await repository.getProjectDetail({ projectId, tenantId });
  return new Set((project?.tickets ?? []).filter(isTicketVisibleToAssistant).map((ticket) => ticket.id));
}

async function filesVisibleToAgents(files, repository, { projectId, tenantId }) {
  if (!files.some((file) => file.targetType === 'ticket' || file.links?.some((link) => link.targetType === 'ticket'))) return files;
  const visible = await ticketsVisibleToAgents(repository, { projectId, tenantId });
  return files
    .filter((file) => file.targetType !== 'ticket' || visible.has(file.targetId))
    .map((file) => (file.links ? { ...file, links: file.links.filter((link) => link.targetType !== 'ticket' || visible.has(link.targetId)) } : file));
}

// The file as agents may see it, without links to tickets hidden from them, or 404. Every file an
// agent gets back goes through here: links name the items they lead to.
export async function requireFileVisibleToAgents(file, repository, { projectId, tenantId }) {
  const [visible] = await filesVisibleToAgents([file], repository, { projectId, tenantId });
  if (!visible) throw new HttpError(404, 'File not found.');
  return visible;
}

// A file of this project, whatever it is attached to, or 404.
export async function requireProjectFile(repository, { fileId, projectId, tenantId }) {
  const file = await repository.getFileRecord({ fileId, tenantId });
  if (!file?.projectId || file.projectId !== projectId) throw new HttpError(404, 'File not found.');
  return file;
}

// Changing a file's contents needs the rights to change files, and no legal hold on it.
async function requireWritableProjectFile(user, { agentView, complianceRepository, fileId, projectId, repository }) {
  const tenantId = await requireFileCapability(user, projectId, repository, PROJECT_CAPABILITIES.FILE_WRITE);
  const file = await requireProjectFile(repository, { fileId, projectId, tenantId });
  if (agentView) await requireFileVisibleToAgents(file, repository, { projectId, tenantId });
  await assertRecordsNotHeld({
    repository: complianceRepository,
    resources: [
      { resourceId: projectId, resourceType: 'project' },
      { resourceId: fileId, resourceType: 'file' },
    ],
    tenantId,
  });
  // What a change returns goes back as this caller may see it.
  const reply = async (result) => (agentView ? { ...result, file: await requireFileVisibleToAgents(result.file, repository, { projectId, tenantId }) } : result);
  return { file, reply, tenantId };
}

export async function listFilesForUser(user, projectId, input, repository, { agentView = false } = {}) {
  const tenantId = await requireFileCapability(user, projectId, repository, PROJECT_CAPABILITIES.FILE_READ);
  // What the screen should offer, not a decision: a viewer reading a list is not a refused write.
  const access = await repository.getProjectAccess({ projectId, tenantId, userId: user.id });
  // A lost engagement is read-only (engagement-guard.js refuses its writes).
  const kind = repository.getProjectKind ? await repository.getProjectKind({ projectId }) : null;
  // An archived channel's library is read-only too (channel-events.js refuses its writes).
  const archivedChannel = input.targetType === 'channel' && Boolean((await repository.getChannel?.({ channelId: input.targetId, projectId, tenantId }))?.archivedAt);
  const canWrite = !archivedChannel && !(kind?.kind === 'engagement' && kind.engagementStatus === 'lost') && hasProjectCapability({
    capability: PROJECT_CAPABILITIES.FILE_WRITE,
    projectRole: access?.projectRole,
    tenantRole: getTenantMembership(user, tenantId)?.role,
    userCapabilities: user.capabilities,
  });
  if (agentView && input.targetType === 'ticket' && !(await ticketsVisibleToAgents(repository, { projectId, tenantId })).has(input.targetId)) {
    return { canWrite, files: [], ok: true };
  }
  // Files in a channel library show the folder they are in.
  const files = await withFolderPaths(repository, await repository.listFiles({
    ...input,
    includeLinked: true,
    projectId,
    tenantId,
    user,
  }), { projectId, tenantId });
  return {
    canWrite,
    files: agentView ? await filesVisibleToAgents(files, repository, { projectId, tenantId }) : files,
    ok: true,
  };
}

export async function uploadFileForUser(user, projectId, input, repository, complianceRepository = null, { agentView = false } = {}) {
  const tenantId = await requireFileCapability(user, projectId, repository, PROJECT_CAPABILITIES.FILE_WRITE);
  // In a channel library a file can go into a folder; names are taken within it.
  const folderId = await resolveUploadFolder(repository, { ...input, projectId, tenantId });
  input = { ...input, folderId };
  // A file saved under a name already on the target replaces that file's contents, so a held
  // file or project keeps its copy.
  if (complianceRepository) {
    const existing = (await repository.listFiles({ ...input, projectId, tenantId, user }))
      .find((file) => file.targetType === input.targetType && file.targetId === input.targetId && (file.folderId ?? null) === folderId && sameFileName(file.fileName, input.fileName));
    if (existing) {
      await assertRecordsNotHeld({
        repository: complianceRepository,
        resources: [
          { resourceId: projectId, resourceType: 'project' },
          { resourceId: existing.id, resourceType: 'file' },
        ],
        tenantId,
      });
    }
  }
  try {
    const file = await repository.saveFile({
      ...input,
      projectId,
      tenantId,
      user,
    });
    return {
      file: agentView ? await requireFileVisibleToAgents(file, repository, { projectId, tenantId }) : file,
      ok: true,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    logVaultRepositoryFailure({
      error,
      extra: {
        fileName: input.fileName,
        targetId: input.targetId ?? null,
        targetType: input.targetType ?? null,
      },
      operation: 'vault.upload',
      projectId,
      user,
    });
    normalizeRepositoryError(error);
  }
}

export async function deleteFileForUser(user, fileId, repository, complianceRepository = null, { agentView = false, projectId = null, signingRepository = null } = {}) {
  const tenantId = assertTenantId(user);
  // The record alone: a file being scanned, or a large one, can be deleted without reading it.
  const record = await repository.getFileRecord({ fileId, tenantId });

  if (!record?.projectId || (projectId && record.projectId !== projectId)) {
    throw new HttpError(404, 'File not found.');
  }

  await requireFileCapability(user, record.projectId, repository, PROJECT_CAPABILITIES.FILE_WRITE);
  if (agentView) await requireFileVisibleToAgents(record, repository, { projectId: record.projectId, tenantId });
  await assertRecordsNotHeld({
    repository: complianceRepository,
    resources: [
      { resourceId: record.projectId, resourceType: 'project' },
      { resourceId: fileId, resourceType: 'file' },
    ],
    tenantId,
  });
  // A file someone signed, or is asked to sign, stays (docs/document-signing, E-04).
  await assertFilesNotUnderSignature(signingRepository, { fileIds: [fileId], tenantId });
  const deleted = await repository.deleteFile({
    fileId,
    tenantId,
    user,
  });

  if (!deleted) {
    throw new HttpError(404, 'File not found.');
  }

  return {
    deletedFileId: fileId,
    ok: true,
  };
}

/**
 * Shares a file with the project's stakeholders (external) or keeps it to the team (internal).
 * Files on tickets stay internal, and a file in a signature request stays external (E-04).
 */
export async function setFileAudienceForUser(user, projectId, fileId, { audience }, repository, { agentView = false, signingRepository = null } = {}) {
  const tenantId = await requireFileCapability(user, projectId, repository, PROJECT_CAPABILITIES.FILE_WRITE);
  const file = await requireProjectFile(repository, { fileId, projectId, tenantId });
  if (agentView) await requireFileVisibleToAgents(file, repository, { projectId, tenantId });
  if (audience === 'external' && file.targetType === 'ticket') {
    throw new HttpError(400, 'Files on tickets cannot be shared with stakeholders.', { details: { code: 'ticket_file' } });
  }
  if (audience === 'internal') await assertFilesNotUnderSignature(signingRepository, { fileIds: [fileId], tenantId });
  const result = await repository.setFileAudience({ audience, fileId, projectId, tenantId, user });
  if (!result) throw new HttpError(404, 'File not found.');
  return {
    changed: result.changed,
    file: agentView ? await requireFileVisibleToAgents(result.file, repository, { projectId, tenantId }) : result.file,
    ok: true,
  };
}

export async function uploadFileVersionForUser(user, projectId, fileId, input, repository, complianceRepository = null, { agentView = false } = {}) {
  const { file, reply, tenantId } = await requireWritableProjectFile(user, { agentView, complianceRepository, fileId, projectId, repository });
  assertEditingConfirmed(file, user, input.confirmEditing === true);
  try {
    const { confirmEditing: _confirmEditing, ...version } = input;
    const result = await repository.saveFileVersion({ ...version, fileId, projectId, tenantId, user });
    if (!result) throw new HttpError(404, 'File not found.');
    return { ...await reply(result), ok: true };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    logVaultRepositoryFailure({ error, extra: { fileId, fileName: input.fileName ?? file.fileName }, operation: 'vault.version', projectId, user });
    normalizeRepositoryError(error);
  }
}

export async function restoreFileVersionForUser(user, projectId, fileId, version, { expectedVersion }, repository, complianceRepository = null, { agentView = false } = {}) {
  const { reply, tenantId } = await requireWritableProjectFile(user, { agentView, complianceRepository, fileId, projectId, repository });
  const result = await repository.restoreFileVersion({ expectedVersion, fileId, projectId, tenantId, user, version });
  if (!result) throw new HttpError(404, 'File version not found.');
  return { ...await reply(result), ok: true };
}

export async function listFileVersionsForUser(user, projectId, fileId, repository, { agentView = false } = {}) {
  const tenantId = await requireFileCapability(user, projectId, repository, PROJECT_CAPABILITIES.FILE_READ);
  const stored = await requireProjectFile(repository, { fileId, projectId, tenantId });
  const file = agentView ? await requireFileVisibleToAgents(stored, repository, { projectId, tenantId }) : stored;
  const versions = await repository.listFileVersions({ fileId, tenantId });
  if (!versions) throw new HttpError(404, 'File not found.');
  return { file, ok: true, versions };
}

export async function linkFileForUser(user, projectId, fileId, input, repository, { agentView = false } = {}) {
  const tenantId = await requireFileCapability(user, projectId, repository, PROJECT_CAPABILITIES.FILE_WRITE);
  const file = await requireProjectFile(repository, { fileId, projectId, tenantId });
  if (agentView) {
    await requireFileVisibleToAgents(file, repository, { projectId, tenantId });
    if (input.targetType === 'ticket' && !(await ticketsVisibleToAgents(repository, { projectId, tenantId })).has(input.targetId)) {
      throw new HttpError(400, 'Invalid file target.');
    }
  }
  try {
    const result = await repository.linkFile({ ...input, fileId, projectId, tenantId, user });
    if (!result) throw new HttpError(404, 'File not found.');
    return agentView
      ? { ...result, file: await requireFileVisibleToAgents(result.file, repository, { projectId, tenantId }), ok: true }
      : { ...result, ok: true };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    normalizeRepositoryError(error);
  }
}

export async function unlinkFileForUser(user, projectId, fileId, linkId, repository, { agentView = false } = {}) {
  const tenantId = await requireFileCapability(user, projectId, repository, PROJECT_CAPABILITIES.FILE_WRITE);
  const file = await requireProjectFile(repository, { fileId, projectId, tenantId });
  if (agentView) {
    const visible = await requireFileVisibleToAgents(file, repository, { projectId, tenantId });
    if (!visible.links?.some((link) => link.id === linkId)) throw new HttpError(404, 'Link not found.');
  }
  const result = await repository.unlinkFile({ fileId, linkId, projectId, tenantId, user });
  if (!result) throw new HttpError(404, 'Link not found.');
  return agentView
    ? { ...result, file: await requireFileVisibleToAgents(result.file, repository, { projectId, tenantId }), ok: true }
    : { ...result, ok: true };
}

// The contents of a file as tools get them, with the link to it in Odin. Over the inline limit, or
// without inline, only the link comes back.
export async function downloadFileForUser(user, projectId, fileId, { inline, version }, repository, { agentView = false, frontendAppUrl = '' } = {}) {
  const tenantId = await requireFileCapability(user, projectId, repository, PROJECT_CAPABILITIES.FILE_READ);
  // The bytes are read only when they go back in the reply, so a large file is never loaded.
  const described = await repository.describeFileVersion({ fileId, tenantId, version: version ?? null });
  if (!described?.file?.projectId || described.file.projectId !== projectId) throw new HttpError(404, 'File not found.');
  assertFileScanClean(described.scanStatus);
  const file = agentView ? await requireFileVisibleToAgents(described.file, repository, { projectId, tenantId }) : described.file;
  const within = described.fileSize <= MAX_INLINE_DOWNLOAD_BYTES;
  const asset = inline === '1' && within ? await repository.getFileAsset({ fileId, tenantId, user, version: version ?? null }) : null;
  const url = new URL(`${String(frontendAppUrl).replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}`);
  url.searchParams.set('projectSettings', 'files');
  url.searchParams.set('file', fileId);
  return {
    file,
    ok: true,
    url: url.toString(),
    ...(asset ? { contentBase64: Buffer.from(asset.bytes).toString('base64') } : {}),
    ...(inline === '1' && !within ? { tooLargeToInline: true } : {}),
  };
}

// A file's contents for the content route, as a stream once the caller may read them. Repositories
// without streams hand back the bytes.
export async function getFileContentForUser(user, fileId, repository, { version = null } = {}) {
  const tenantId = assertTenantId(user);
  const record = await repository.getFileRecord({ fileId, tenantId });
  if (!record?.projectId) {
    throw new HttpError(404, 'File not found.');
  }
  await requireFileCapability(user, record.projectId, repository, PROJECT_CAPABILITIES.FILE_READ);

  if (typeof repository.openFileContent === 'function') {
    const opened = await repository.openFileContent({ fileId, tenantId, version });
    if (!opened) throw new HttpError(404, 'File not found.');
    return opened;
  }
  const asset = await repository.getFileAsset({ fileId, tenantId, user, version });
  if (!asset?.file?.projectId) throw new HttpError(404, 'File not found.');
  return asset;
}

// Types a browser shows without running anything from them. Anything else is sent as a download,
// so HTML, SVG and the like never open on Odin's own origin.
const SAFE_INLINE_TYPES = /^(?:image\/(?:png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain|text\/csv|text\/markdown)(?:;|$)/i;

/** How to send a file: attachment when asked, or whenever its type is not safe to show inline. */
export function fileContentDisposition(fileName, { download = false, contentType = '' } = {}) {
  const name = String(fileName ?? 'file').replace(/[\r\n]/g, ' ');
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${download || !SAFE_INLINE_TYPES.test(contentType) ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Whether a file is text Odin can hand back as text, by its type or, failing that, its name. */
export function isTextFile(file) {
  return TEXT_TYPES.test(String(file?.contentType ?? '')) || TEXT_EXTENSIONS.test(String(file?.fileName ?? ''));
}

/**
 * 'pdf', 'docx', 'xlsx' or 'pptx' for a document whose text Odin extracts, by its type or,
 * failing that, its name.
 */
export function documentKind(file) {
  const type = String(file?.contentType ?? '');
  if (/^application\/pdf(?:;|$)/i.test(type)) return 'pdf';
  if (DOCX_TYPE.test(type)) return 'docx';
  if (XLSX_TYPE.test(type)) return 'xlsx';
  if (PPTX_TYPE.test(type)) return 'pptx';
  if (TEXT_TYPES.test(type)) return null;
  const name = String(file?.fileName ?? '');
  return Object.entries(DOCUMENT_EXTENSIONS).find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

/** Whether readFileTextForUser can read a file's text. */
export const isReadableFile = (file) => Boolean(documentKind(file)) || isTextFile(file);

/**
 * A file's whole text, as readFileTextForUser reads it. Binary files (415), text files over
 * FILE_TEXT_MAX_BYTES and documents over DOCUMENT_TEXT_LIMITS.bytes (413) are refused rather than
 * returned garbled or in part; so (422) are documents whose text cannot be extracted.
 */
export async function readableFileText(file, contents) {
  const bytes = Buffer.from(contents ?? []);
  const kind = documentKind(file);
  // A NUL byte early on means binary, whatever the file claims to be.
  if (!kind && (!isTextFile(file) || bytes.subarray(0, 8192).includes(0))) {
    throw new HttpError(415, 'This file is not text, so it cannot be read as text.', { details: { code: 'not_text' } });
  }
  if (bytes.length > (kind ? DOCUMENT_TEXT_LIMITS.bytes : FILE_TEXT_MAX_BYTES)) {
    throw new HttpError(413, 'This file is too large to read as text.', { details: { code: 'text_too_large' } });
  }
  return kind
    ? extractDocumentText(kind, bytes)
    : new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** A window of a file's text, for tools that read files as text (readableFileText). */
export async function readFileTextForUser(user, projectId, fileId, { maxChars, offset, version = null }, repository, { agentView = false } = {}) {
  const tenantId = assertTenantId(user);
  const described = await repository.describeFileVersion?.({ fileId, tenantId, version }) ?? null;
  // Too large to read as text, said before the bytes are loaded (readableFileText says it after).
  if (described?.file?.projectId === projectId && described.fileSize > Math.max(FILE_TEXT_MAX_BYTES, DOCUMENT_TEXT_LIMITS.bytes)) {
    await requireFileCapability(user, projectId, repository, PROJECT_CAPABILITIES.FILE_READ);
    throw new HttpError(413, 'This file is too large to read as text.', { details: { code: 'text_too_large' } });
  }
  const asset = await repository.getFileAsset({ fileId, tenantId, user, version });

  if (!asset?.file?.projectId || asset.file.projectId !== projectId) {
    throw new HttpError(404, 'File not found.');
  }

  await requireFileCapability(user, projectId, repository, PROJECT_CAPABILITIES.FILE_READ);
  const file = agentView ? await requireFileVisibleToAgents(asset.file, repository, { projectId, tenantId }) : asset.file;
  return { file, ok: true, text: fileTextWindow(await readableFileText(asset.file, asset.bytes), { maxChars, offset }) };
}

/** Up to maxChars of a file's text from offset, and where the next read starts. */
export function fileTextWindow(content, { maxChars, offset }) {
  const start = Math.min(offset, content.length);
  let end = Math.min(start + maxChars, content.length);
  // Never end on half a surrogate pair.
  if (end < content.length && end > start && /[\uD800-\uDBFF]/.test(content[end - 1])) end -= 1;
  return { content: content.slice(start, end), end, nextOffset: end < content.length ? end : null, offset: start, totalChars: content.length };
}
