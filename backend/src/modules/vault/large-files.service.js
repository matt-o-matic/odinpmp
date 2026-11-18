import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { requireDecisionRights } from '../../lib/auth/decision-rights.js';
import { PROJECT_CAPABILITIES } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { assertFileScanClean } from '../../lib/files/file-scan-status.js';
import { supportsLargeFiles } from '../../lib/files/file-storage.js';
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { assertEditingConfirmed, resolveUploadFolder } from '../channels/channel-library.js';
import { assertRecordsNotHeld } from '../compliance/legal-hold.js';
import {
  assertTenantId,
  requireFileCapability,
  requireFileVisibleToAgents,
  requireProjectFile,
} from './vault.service.js';

// Large files (docs/engagements/plan.md, Files): uploads in parts straight to storage, downloads
// by short-lived signed URL, deleting old versions, and the storage a project's files use.
//
// With S3 the browser sends each part to S3 and fetches files from it, and no bytes pass through
// Odin. With local storage (development) the same API hands out signed backend URLs, and the
// routes in large-files.routes.js stream each part to disk and each download from it.

/** The largest file anyone can upload (Q-05), unless FILE_UPLOAD_MAX_BYTES says otherwise. */
export const DEFAULT_FILE_UPLOAD_MAX_BYTES = 1_073_741_824;
const MIN_PART_BYTES = 8 * 1024 * 1024;
const MAX_PARTS = 10_000;
export const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const PART_URL_SECONDS = 60 * 60;
export const DOWNLOAD_URL_SECONDS = 5 * 60;
export const MAX_PARTS_PER_REQUEST = 100;

// What a browser shows inline: the types the content route shows (vault.service.js), plus MP4 and
// WebM video. HTML and SVG never are.
const INLINE_TYPES = /^(?:image\/(?:png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain|text\/csv|text\/markdown|video\/mp4|video\/webm)(?:;|$)/i;

/** The part size for a file: 8 MiB, doubled until the file fits in 10,000 parts. */
export function partSizeFor(size) {
  let partSize = MIN_PART_BYTES;
  while (Math.ceil(size / partSize) > MAX_PARTS) partSize *= 2;
  return partSize;
}

const partCountOf = (upload) => Math.max(1, Math.ceil(upload.size / upload.partSize));
const expectedPartSize = (upload, partNumber) => (partNumber < partCountOf(upload) ? upload.partSize : upload.size - upload.partSize * (partCountOf(upload) - 1));

/** The Content-Disposition for a signed download: inline only when asked and the type is safe. */
export function downloadDisposition(fileName, { contentType = '', inline = false } = {}) {
  const name = String(fileName ?? 'file').replace(/[\r\n]/g, ' ');
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline && INLINE_TYPES.test(contentType) ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Signs and checks the short-lived backend URLs that move bytes with local storage. A token
 * names one object and what may be done with it, and when it stops working.
 */
export function createTransferSigner(secret) {
  const key = String(secret ?? '');
  if (key.length < 16) throw new TypeError('A file transfer secret of at least 16 characters is required.');
  const mac = (body) => createHmac('sha256', key).update(body).digest('base64url');
  return {
    sign(payload) {
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${body}.${mac(body)}`;
    },
    verify(token, { now = new Date() } = {}) {
      const [body, signature, extra] = String(token ?? '').split('.');
      if (!body || !signature || extra !== undefined) return null;
      const expected = Buffer.from(mac(body));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      let payload;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      return Number(payload?.exp) > now.getTime() ? payload : null;
    },
  };
}

const nowOf = (deps) => (deps.clock ? deps.clock() : new Date());
const maxBytesOf = (deps) => Number(deps.fileUploadMaxBytes ?? DEFAULT_FILE_UPLOAD_MAX_BYTES);

function requireLargeFileStorage(deps) {
  if (!supportsLargeFiles(deps.fileStorage)) {
    throw new HttpError(503, 'Large uploads are not available on this server.', { details: { code: 'large_uploads_unavailable' } });
  }
  return deps.fileStorage;
}

function tooLarge(deps, size) {
  const maxBytes = maxBytesOf(deps);
  return new HttpError(413, `Files can be up to ${maxBytes} bytes. This one is ${size} bytes.`, { details: { code: 'file_too_large', maxBytes, size } });
}

// Where transfer URLs point: the backend's public origin, or the path alone for the client to
// resolve against the API it already talks to.
const transferUrl = (deps, path) => `${String(deps.backendPublicUrl ?? '').replace(/\/$/, '')}${path}`;

function transferSigner(deps) {
  if (!deps.transferSigner) throw new HttpError(503, 'Large uploads are not available on this server.', { details: { code: 'large_uploads_unavailable' } });
  return deps.transferSigner;
}

function presentUpload(deps, upload, extra = {}) {
  return {
    baseVersion: upload.baseVersion ?? null,
    contentType: upload.contentType,
    expiresAt: upload.expiresAt,
    fileId: upload.fileId ?? null,
    fileName: upload.fileName,
    id: upload.id,
    maxBytes: maxBytesOf(deps),
    partCount: partCountOf(upload),
    partSize: upload.partSize,
    size: upload.size,
    status: upload.status,
    targetId: upload.targetId,
    targetType: upload.targetType,
    ...extra,
  };
}

function logLargeFileFailure({ error, operation, projectId, user, extra = {} }) {
  logBackendError({
    context: buildOperationLogContext(operation, { projectId, tenantId: user?.memberships?.[0]?.tenantId ?? null, userId: user?.id ?? null, ...extra }),
    error,
    level: 'warn',
    message: 'Large file operation failed.',
  });
}

// The legal holds a write to this file, or to the file already under its name, must respect.
async function assertWritable(deps, { fileId, projectId, tenantId }) {
  await assertRecordsNotHeld({
    repository: deps.complianceRepository,
    resources: [
      { resourceId: projectId, resourceType: 'project' },
      ...(fileId ? [{ resourceId: fileId, resourceType: 'file' }] : []),
    ],
    tenantId,
  });
}

async function sameNamedFileId(deps, { fileName, folderId = null, projectId, targetId, targetType, tenantId, user }) {
  const files = await deps.projectRepository.listFiles({ projectId, targetId, targetType, tenantId, user });
  const name = String(fileName).trim().toLowerCase();
  return files.find((file) => file.targetId === targetId && file.targetType === targetType && (file.folderId ?? null) === (folderId ?? null) && String(file.fileName ?? '').trim().toLowerCase() === name)?.id ?? null;
}

/**
 * Starts an upload: checks rights and the size limit, starts a multipart upload in storage, and
 * records it. A new version names its file and the version it was made from (expectedVersion).
 */
export async function startUploadForUser(deps, user, projectId, input) {
  const tenantId = await requireFileCapability(user, projectId, deps.projectRepository, PROJECT_CAPABILITIES.FILE_WRITE);
  return startUpload(deps, { projectId, tenantId, user }, input);
}

/**
 * Starts an upload for someone whose right to change the target is already checked: a member by
 * startUploadForUser, a guest by the guests module (their channel, or a file in it). `user` is the
 * account the upload and the file record name.
 */
export async function startUpload(deps, { projectId, tenantId, user }, input) {
  const storage = requireLargeFileStorage(deps);
  if (input.fileSize > maxBytesOf(deps)) throw tooLarge(deps, input.fileSize);
  let target = { targetId: input.targetId, targetType: input.targetType };
  let baseVersion = null;
  let folderId = null;
  if (input.fileId) {
    const file = await requireProjectFile(deps.projectRepository, { fileId: input.fileId, projectId, tenantId });
    await assertWritable(deps, { fileId: file.id, projectId, tenantId });
    if ((file.version ?? 1) !== input.expectedVersion) {
      throw new HttpError(409, 'This file changed since you opened it.', { details: { code: 'file_changed', currentVersion: file.version ?? 1 } });
    }
    assertEditingConfirmed(file, user, input.confirmEditing === true);
    target = { targetId: file.targetId, targetType: file.targetType };
    baseVersion = input.expectedVersion;
    // A new version stays in its file's folder; kept beside it, a copy goes there too.
    folderId = file.folderId ?? null;
  } else {
    if (!target.targetId || !target.targetType) throw new HttpError(400, 'Choose where the file goes.', { details: { code: 'target_required' } });
    if (!await deps.projectRepository.isFileTarget({ projectId, tenantId, ...target })) throw new HttpError(400, 'Invalid file target.');
    folderId = await resolveUploadFolder(deps.projectRepository, { ...target, folderId: input.folderId ?? null, projectId, tenantId });
    const sameNamed = await sameNamedFileId(deps, { ...target, fileName: input.fileName, folderId, projectId, tenantId, user });
    await assertWritable(deps, { fileId: sameNamed, projectId, tenantId });
    // Same name in the same place: a new version of that file, so its marker counts too.
    if (sameNamed) assertEditingConfirmed(await deps.projectRepository.getFileRecord({ fileId: sameNamed, tenantId }), user, input.confirmEditing === true);
  }
  const storageKey = randomUUID();
  const contentType = input.contentType || 'application/octet-stream';
  const { uploadId: storageUploadId } = await storage.createMultipartUpload(storageKey, { contentType });
  const now = nowOf(deps);
  const upload = await deps.projectRepository.createFileUpload({
    baseVersion,
    contentType,
    createdAt: now.toISOString(),
    createdBy: user.id,
    expiresAt: new Date(now.getTime() + UPLOAD_LIFETIME_MS).toISOString(),
    fileId: input.fileId ?? null,
    fileName: input.fileName,
    folderId,
    id: randomUUID(),
    partSize: partSizeFor(input.fileSize),
    projectId,
    size: input.fileSize,
    status: 'uploading',
    storageKey,
    storageUploadId,
    targetId: target.targetId,
    targetType: target.targetType,
    tenantId,
  });
  return { ok: true, upload: presentUpload(deps, upload, { parts: [], receivedBytes: 0 }) };
}

// The caller's own upload in this project, or 404: an upload is its uploader's alone.
async function requireOwnUpload(deps, user, projectId, uploadId) {
  const tenantId = await requireFileCapability(user, projectId, deps.projectRepository, PROJECT_CAPABILITIES.FILE_WRITE);
  return { tenantId, upload: await findOwnUpload(deps, { tenantId, uploadId, userId: user.id, projectId }) };
}

/** The upload `userId` started, or 404. `projectId` null accepts any project in the workspace. */
export async function findOwnUpload(deps, { projectId = null, tenantId, uploadId, userId }) {
  const upload = await deps.projectRepository.getFileUpload({ tenantId, uploadId });
  if (!upload || (projectId && upload.projectId !== projectId) || upload.createdBy !== userId) throw new HttpError(404, 'Upload not found.');
  return upload;
}

function requireOpenUpload(deps, upload) {
  if (upload.status !== 'uploading') {
    throw new HttpError(409, upload.status === 'expired' ? 'This upload expired. Start it again.' : 'This upload is no longer taking parts.', { details: { code: 'upload_closed', status: upload.status } });
  }
  if (new Date(upload.expiresAt) <= nowOf(deps)) throw new HttpError(409, 'This upload expired. Start it again.', { details: { code: 'upload_closed', status: 'expired' } });
}

/** Signed URLs for a batch of parts, each good for an hour. */
export async function signUploadPartsForUser(deps, user, projectId, uploadId, input) {
  return signUploadParts(deps, await requireOwnUpload(deps, user, projectId, uploadId), input);
}

/** Part URLs for an upload already found as the caller's own (findOwnUpload). */
export async function signUploadParts(deps, { tenantId, upload }, { partNumbers }) {
  const storage = requireLargeFileStorage(deps);
  requireOpenUpload(deps, upload);
  const count = partCountOf(upload);
  const wanted = [...new Set(partNumbers)].sort((left, right) => left - right);
  const outside = wanted.filter((partNumber) => partNumber > count);
  if (outside.length) throw new HttpError(400, `This upload has ${count} parts.`, { details: { code: 'invalid_part', partNumbers: outside } });
  const expiresAt = new Date(Math.min(nowOf(deps).getTime() + PART_URL_SECONDS * 1000, new Date(upload.expiresAt).getTime()));
  const parts = [];
  for (const partNumber of wanted) {
    const url = typeof storage.presignUploadPart === 'function'
      ? await storage.presignUploadPart(upload.storageKey, upload.storageUploadId, partNumber, { expiresIn: PART_URL_SECONDS })
      : transferUrl(deps, `/api/file-transfers/parts/${transferSigner(deps).sign({ exp: expiresAt.getTime(), kind: 'part', partNumber, tenantId, uploadId: upload.id })}`);
    parts.push({ method: 'PUT', partNumber, size: expectedPartSize(upload, partNumber), url });
  }
  return { expiresAt: expiresAt.toISOString(), ok: true, parts };
}

/** The upload and the parts storage already has, so a browser can resume after a reload. */
export async function getUploadForUser(deps, user, projectId, uploadId) {
  return describeUpload(deps, await requireOwnUpload(deps, user, projectId, uploadId));
}

export async function describeUpload(deps, { upload }) {
  const storage = requireLargeFileStorage(deps);
  let parts = [];
  if (upload.status === 'uploading') {
    try {
      parts = (await storage.listParts(upload.storageKey, upload.storageUploadId)).map(({ partNumber, size }) => ({ partNumber, size }));
    } catch (error) {
      if (error?.code !== 'upload_not_found') throw error;
    }
  }
  return { ok: true, upload: presentUpload(deps, upload, { parts, receivedBytes: parts.reduce((sum, part) => sum + part.size, 0) }) };
}

// Joins the parts in storage after checking every part is there at its size, and that the whole
// is within the limit. A file over the limit is aborted, whatever the browser said at the start.
async function assembleUpload(deps, { tenantId, upload }) {
  const storage = deps.fileStorage;
  const parts = await storage.listParts(upload.storageKey, upload.storageUploadId);
  const total = parts.reduce((sum, part) => sum + part.size, 0);
  const reject = async (error, { assembled = false } = {}) => {
    if (await deps.projectRepository.setFileUploadStatus({ from: ['uploading', 'assembling'], status: 'rejected', tenantId, uploadId: upload.id })) {
      await (assembled ? storage.delete(upload.storageKey) : storage.abortMultipartUpload(upload.storageKey, upload.storageUploadId)).catch(() => {});
    }
    throw error;
  };
  if (total > maxBytesOf(deps)) await reject(tooLarge(deps, total));
  const count = partCountOf(upload);
  const byNumber = new Map(parts.map((part) => [part.partNumber, part]));
  const missing = [];
  const wrongSize = [];
  for (let partNumber = 1; partNumber <= count; partNumber += 1) {
    const part = byNumber.get(partNumber);
    if (!part) missing.push(partNumber);
    else if (part.size !== expectedPartSize(upload, partNumber)) wrongSize.push(partNumber);
  }
  if (missing.length || wrongSize.length || parts.length !== count) {
    throw new HttpError(409, missing.length ? 'Some parts have not arrived yet.' : 'Some parts are not the size this upload expects. Send them again.', {
      details: { code: 'upload_incomplete', missingParts: missing.slice(0, 100), wrongSizeParts: wrongSize.slice(0, 100) },
    });
  }
  if (!await deps.projectRepository.setFileUploadStatus({ from: ['uploading'], status: 'assembling', tenantId, uploadId: upload.id })) {
    throw new HttpError(409, 'This upload is already being completed.', { details: { code: 'upload_closed' } });
  }
  let size;
  try {
    ({ size } = await storage.completeMultipartUpload(upload.storageKey, upload.storageUploadId, parts));
  } catch (error) {
    await deps.projectRepository.setFileUploadStatus({ from: ['assembling'], status: 'uploading', tenantId, uploadId: upload.id });
    throw error;
  }
  // What storage now holds is what counts.
  if (size > maxBytesOf(deps)) await reject(tooLarge(deps, size), { assembled: true });
  if (size !== upload.size) await reject(new HttpError(400, 'The uploaded file is not the size it was said to be.', { details: { code: 'upload_size_mismatch', size } }), { assembled: true });
  await deps.projectRepository.setFileUploadStatus({ from: ['assembling'], status: 'assembled', tenantId, uploadId: upload.id });
  return size;
}

/**
 * Completes an upload: joins its parts, then saves it as a file or a new version with scan status
 * pending. A new version made from a version that is no longer current is refused (409
 * file_changed) and the joined file is kept: completing again with keepBoth saves it as a new
 * file beside the other, and with expectedVersion set to the newer version saves it on top.
 */
export async function completeUploadForUser(deps, user, projectId, uploadId, input = {}) {
  return completeUpload(deps, { ...await requireOwnUpload(deps, user, projectId, uploadId), user }, input);
}

/** Completes an upload already found as the caller's own; `user` is the account the file names. */
export async function completeUpload(deps, { tenantId, upload, user }, input = {}) {
  const { projectId } = upload;
  const uploadId = upload.id;
  requireLargeFileStorage(deps);
  let size;
  if (upload.status === 'uploading') {
    requireOpenUpload(deps, upload);
    size = await assembleUpload(deps, { tenantId, upload });
  } else if (upload.status === 'assembled') {
    size = (await deps.fileStorage.stat(upload.storageKey))?.size ?? null;
    if (size == null) throw new HttpError(409, 'This upload is no longer in storage. Start it again.', { details: { code: 'upload_closed', status: upload.status } });
  } else {
    throw new HttpError(409, upload.status === 'completed' ? 'This upload is already saved.' : 'This upload is no longer open.', { details: { code: 'upload_closed', fileId: upload.fileId ?? null, status: upload.status } });
  }
  await assertWritable(deps, { fileId: upload.fileId ?? await sameNamedFileId(deps, { fileName: upload.fileName, folderId: upload.folderId ?? null, projectId, targetId: upload.targetId, targetType: upload.targetType, tenantId, user }), projectId, tenantId });
  try {
    const { file } = await deps.projectRepository.saveUploadedFile({
      expectedVersion: input.expectedVersion ?? null,
      fileDescription: input.fileDescription,
      keepBoth: input.keepBoth === true,
      note: input.note ?? '',
      size,
      upload: { ...upload, status: 'assembled' },
      user,
    });
    return { file, ok: true };
  } catch (error) {
    if (error instanceof HttpError && error.details?.code === 'file_changed') {
      throw new HttpError(409, 'Someone uploaded a newer version while this one was uploading. Keep both, or save this on top of theirs.', {
        details: { ...error.details, canKeepBoth: true, uploadId: upload.id },
      });
    }
    if (error?.message === 'Invalid file target.') throw new HttpError(400, error.message);
    if (!(error instanceof HttpError)) logLargeFileFailure({ error, extra: { uploadId }, operation: 'vault.upload.complete', projectId, user });
    throw error;
  }
}

/** Cancels an upload, and drops what storage has of it. */
export async function cancelUploadForUser(deps, user, projectId, uploadId) {
  return cancelUpload(deps, await requireOwnUpload(deps, user, projectId, uploadId));
}

export async function cancelUpload(deps, { tenantId, upload }) {
  const storage = requireLargeFileStorage(deps);
  if (!await deps.projectRepository.setFileUploadStatus({ from: ['uploading', 'assembled'], status: 'aborted', tenantId, uploadId: upload.id })) {
    return { cancelled: false, ok: true, status: upload.status };
  }
  await dropUploadObject(storage, upload);
  return { cancelled: true, ok: true, status: 'aborted' };
}

async function dropUploadObject(storage, upload) {
  if (upload.status === 'assembled') await storage.delete(upload.storageKey);
  else await storage.abortMultipartUpload(upload.storageKey, upload.storageUploadId);
}

/** Aborts uploads still open 24 hours after they started. Returns how many. */
export async function abortExpiredUploads(deps, { limit = 50, now = nowOf(deps) } = {}) {
  if (!supportsLargeFiles(deps.fileStorage) || typeof deps.projectRepository?.listExpiredFileUploads !== 'function') return 0;
  let aborted = 0;
  for (const upload of await deps.projectRepository.listExpiredFileUploads({ limit, now })) {
    if (!await deps.projectRepository.setFileUploadStatus({ from: [upload.status], status: 'expired', tenantId: upload.tenantId, uploadId: upload.id })) continue;
    try {
      await dropUploadObject(deps.fileStorage, upload);
    } catch (error) {
      // The bucket's lifecycle rule aborts what this misses.
      logBackendError({ context: buildOperationLogContext('vault.upload.expire', { projectId: upload.projectId, tenantId: upload.tenantId, uploadId: upload.id }), error, level: 'warn', message: 'Could not abort an expired upload.' });
    }
    aborted += 1;
  }
  return aborted;
}

/**
 * A URL that gets one stored object for 5 minutes, sent with this disposition and type: signed by
 * S3, or a signed backend URL with local storage. The caller has checked the reader's rights.
 */
export async function signObjectUrl(deps, { contentDisposition, contentType, storageKey }) {
  const storage = deps.fileStorage;
  const expiresAt = new Date(nowOf(deps).getTime() + DOWNLOAD_URL_SECONDS * 1000);
  let url;
  if (typeof storage?.presignDownload === 'function') {
    url = await storage.presignDownload(storageKey, { contentDisposition, contentType, expiresIn: DOWNLOAD_URL_SECONDS });
  } else if (typeof storage?.createReadStream === 'function') {
    url = transferUrl(deps, `/api/file-transfers/files/${transferSigner(deps).sign({ contentType, disposition: contentDisposition, exp: expiresAt.getTime(), kind: 'file', storageKey })}`);
  } else {
    throw new HttpError(503, 'Downloads by link are not available on this server.', { details: { code: 'large_uploads_unavailable' } });
  }
  return { expiresAt, url };
}

/**
 * A URL that downloads one version for 5 minutes, after its scan passed. Sent as an attachment
 * unless inline is asked for and the type is safe to show.
 */
export async function getDownloadUrlForUser(deps, user, projectId, fileId, options = {}, { agentView = false } = {}) {
  const tenantId = await requireFileCapability(user, projectId, deps.projectRepository, PROJECT_CAPABILITIES.FILE_READ);
  const record = await requireProjectFile(deps.projectRepository, { fileId, projectId, tenantId });
  if (agentView) await requireFileVisibleToAgents(record, deps.projectRepository, { projectId, tenantId });
  return getDownloadUrl(deps, { fileId, tenantId }, options);
}

/** The signed download for a file the caller may read, as checked by them. */
export async function getDownloadUrl(deps, { fileId, tenantId }, { inline = false, version = null } = {}) {
  const described = await deps.projectRepository.describeFileVersion({ fileId, tenantId, version });
  if (!described) throw new HttpError(404, 'File version not found.');
  assertFileScanClean(described.scanStatus);
  const { expiresAt, url } = await signObjectUrl(deps, {
    contentDisposition: downloadDisposition(described.fileName, { contentType: described.contentType, inline }),
    contentType: described.contentType,
    storageKey: described.storageKey,
  });
  return {
    contentType: described.contentType,
    expiresAt: expiresAt.toISOString(),
    fileName: described.fileName,
    fileSize: described.fileSize,
    ok: true,
    sha256: described.sha256 ?? null,
    url,
    version: described.version,
  };
}

/**
 * Deletes an old version (E-14). Needs decision rights. Never the current version, a version a
 * pending or completed signature request froze, or one under a legal hold. The row stays, marked
 * deleted; the stored object goes once nothing else holds it.
 */
export async function deleteFileVersionForUser(deps, user, projectId, fileId, version) {
  const tenantId = assertTenantId(user);
  await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  await requireFileCapability(user, projectId, deps.projectRepository, PROJECT_CAPABILITIES.FILE_WRITE);
  const file = await requireProjectFile(deps.projectRepository, { fileId, projectId, tenantId });
  await assertWritable(deps, { fileId: file.id, projectId, tenantId });
  const pins = await deps.signingRepository?.listFileVersionPins?.({ fileId, tenantId }) ?? [];
  if (pins.some((pin) => pin.version === version)) {
    throw new HttpError(409, 'This version is in a signature request, so it stays.', { details: { code: 'version_under_signature', version } });
  }
  const result = await deps.projectRepository.deleteFileVersion({ fileId, projectId, tenantId, user, version });
  if (!result) throw new HttpError(404, 'File version not found.');
  if (result.storageKey && !await deps.signingRepository?.isStorageKeyPinned?.({ storageKey: result.storageKey, tenantId })) {
    try {
      await deps.fileStorage?.delete?.(result.storageKey);
      // Its PDF preview goes with it.
      if (result.previewStorageKey) await deps.fileStorage?.delete?.(result.previewStorageKey);
    } catch (error) {
      // The row says deleted either way; an object that won't delete is left orphaned.
      logLargeFileFailure({ error, extra: { fileId, version }, operation: 'vault.version.delete', projectId, user });
    }
  }
  return { deletedVersion: version, file: result.file, ok: true, storage: await deps.projectRepository.getProjectFileStorage({ projectId, tenantId }) };
}

/** The storage a project's files use, counting every live version, and who may delete old versions. */
export async function getFileStorageForUser(deps, user, projectId) {
  const tenantId = await requireFileCapability(user, projectId, deps.projectRepository, PROJECT_CAPABILITIES.FILE_READ);
  let canDeleteVersions = true;
  try {
    await requireDecisionRights({ projectId, repository: deps.projectRepository, tenantId, user });
  } catch {
    canDeleteVersions = false;
  }
  return {
    canDeleteVersions,
    maxUploadBytes: maxBytesOf(deps),
    ok: true,
    storage: await deps.projectRepository.getProjectFileStorage({ projectId, tenantId }),
    uploadsByParts: supportsLargeFiles(deps.fileStorage),
  };
}

// --- local storage transfers (signed backend URLs) --------------------------------------------

/** Streams one part to disk for a signed part URL. Refuses a part larger than it should be. */
export async function receiveUploadPart(deps, token, body) {
  const payload = transferSigner(deps).verify(token, { now: nowOf(deps) });
  if (payload?.kind !== 'part') throw new HttpError(403, 'This upload link is not valid or has expired.', { details: { code: 'transfer_link_invalid' } });
  const upload = await deps.projectRepository.getFileUpload({ tenantId: payload.tenantId, uploadId: payload.uploadId });
  if (!upload) throw new HttpError(404, 'Upload not found.');
  requireOpenUpload(deps, upload);
  const maxBytes = expectedPartSize(upload, payload.partNumber);
  try {
    return await deps.fileStorage.writePart(upload.storageKey, upload.storageUploadId, payload.partNumber, body, { maxBytes });
  } catch (error) {
    if (error?.code === 'part_too_large') throw new HttpError(413, error.message, { details: { code: 'part_too_large', maxBytes } });
    if (error?.code === 'upload_not_found') throw new HttpError(409, 'This upload is no longer taking parts.', { details: { code: 'upload_closed' } });
    throw error;
  }
}

/** The object a signed download URL names, with what to send it as. */
export function resolveDownloadToken(deps, token) {
  const payload = transferSigner(deps).verify(token, { now: nowOf(deps) });
  if (payload?.kind !== 'file') throw new HttpError(403, 'This download link is not valid or has expired.', { details: { code: 'transfer_link_invalid' } });
  return payload;
}
