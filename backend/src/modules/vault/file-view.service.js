// A file for the model to look at (odin_view_project_file): an image (PNG, JPEG, GIF or WebP) up
// to IMAGE_MAX_BYTES, or a PDF up to PDF_MAX_BYTES, as base64, with the rights of a download.
// Agents only: the route answers only the agent view (agentView=1 or an MCP credential).
import { PROJECT_CAPABILITIES } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { assertFileScanClean } from '../../lib/files/file-scan-status.js';
import { mediaKindOf } from '../../lib/agent/agent-media.js';
import { requireFileCapability, requireFileVisibleToAgents } from './vault.service.js';

export async function viewFileForUser(user, projectId, fileId, { version = null } = {}, repository, { agentView = false } = {}) {
  if (!agentView) throw new HttpError(404, 'Not found.');
  const tenantId = await requireFileCapability(user, projectId, repository, PROJECT_CAPABILITIES.FILE_READ);
  const described = await repository.describeFileVersion({ fileId, tenantId, version: version ?? null });
  if (!described?.file?.projectId || described.file.projectId !== projectId) throw new HttpError(404, 'File not found.');
  assertFileScanClean(described.scanStatus);
  const file = await requireFileVisibleToAgents(described.file, repository, { projectId, tenantId });
  const media = mediaKindOf({ contentType: described.contentType ?? file.contentType, fileName: described.fileName ?? file.fileName });
  if (!media) throw new HttpError(415, 'Only images (PNG, JPEG, GIF, WebP) and PDFs can be viewed.', { details: { code: 'not_viewable' } });
  if (Number(described.fileSize ?? 0) > media.maxBytes) throw new HttpError(413, 'This file is too large to view.', { details: { code: 'too_large', maxBytes: media.maxBytes } });
  // The bytes are read only after the checks, so a large or unviewable file is never loaded.
  const asset = await repository.getFileAsset({ fileId, tenantId, version: version ?? null });
  if (!asset?.bytes) throw new HttpError(404, 'File not found.');
  const bytes = Buffer.from(asset.bytes);
  if (bytes.length > media.maxBytes) throw new HttpError(413, 'This file is too large to view.', { details: { code: 'too_large', maxBytes: media.maxBytes } });
  return { contentBase64: bytes.toString('base64'), contentType: media.contentType, file, kind: media.kind, ok: true, version: described.version ?? null };
}
