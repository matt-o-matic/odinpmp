import { PROJECT_CAPABILITIES } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { DEFAULT_PREVIEW_MAX_BYTES, NO_PREVIEW, PREVIEW_TEXT_MAX_BYTES, previewFormatOf } from '../../lib/files/file-preview.js';
import { assertFileScanClean } from '../../lib/files/file-scan-status.js';
import { downloadDisposition, signObjectUrl } from './large-files.service.js';
import { requireFileCapability, requireFileVisibleToAgents, requireProjectFile } from './vault.service.js';

// What the files panel's viewer shows for one version (docs/engagements/plan.md, Download and
// preview; AC-08). The same rights as a download, and nothing before the scan passes.
//
// kind is one of:
// - pdf: a PDF, or an Office file's converted PDF (lib/files/file-preview.js).
// - image, video (MP4 or WebM): shown as they are.
// - text, markdown: the viewer fetches the text from url. Markdown is rendered by the app's
//   sanitized renderer. Both are served as plain text, so the URL never renders as a page.
// - preparing: an Office file the preview worker has not converted yet. No url.
// - none: no preview; reason says why (failed, too_large, unavailable, unsupported). No url.
//
// url is signed for 5 minutes, inline, as download-url signs it. HTML and SVG are never inline.

function pdfName(fileName) {
  const name = String(fileName ?? 'file').replace(/\.[^./\\]{1,10}$/, '');
  return `${name || 'file'}.pdf`;
}

export async function getPreviewUrlForUser(deps, user, projectId, fileId, options = {}, { agentView = false } = {}) {
  const tenantId = await requireFileCapability(user, projectId, deps.projectRepository, PROJECT_CAPABILITIES.FILE_READ);
  const record = await requireProjectFile(deps.projectRepository, { fileId, projectId, tenantId });
  if (agentView) await requireFileVisibleToAgents(record, deps.projectRepository, { projectId, tenantId });
  return getPreviewUrl(deps, { fileId, tenantId }, options);
}

/** What the viewer shows for a file the caller may read, as checked by them. */
export async function getPreviewUrl(deps, { fileId, tenantId }, { version = null } = {}) {
  const described = await deps.projectRepository.describeFileVersion({ fileId, tenantId, version });
  if (!described) throw new HttpError(404, 'File version not found.');
  assertFileScanClean(described.scanStatus);

  const result = { expiresAt: null, fileName: described.fileName, kind: 'none', ok: true, reason: null, url: null, version: described.version };
  const none = (reason) => ({ ...result, reason });
  const signed = async ({ contentType, fileName = described.fileName, kind, storageKey = described.storageKey }) => {
    const { expiresAt, url } = await signObjectUrl(deps, { contentDisposition: downloadDisposition(fileName, { contentType, inline: true }), contentType, storageKey });
    return { ...result, expiresAt: expiresAt.toISOString(), kind, url };
  };

  const format = previewFormatOf(described);
  switch (format.kind) {
    case 'office': {
      const maxBytes = Number(deps.previewMaxBytes ?? DEFAULT_PREVIEW_MAX_BYTES);
      if (described.fileSize > maxBytes) return none('too_large');
      if (described.previewStorageKey === NO_PREVIEW) return none('failed');
      if (described.previewStorageKey) {
        return signed({ contentType: 'application/pdf', fileName: pdfName(described.fileName), kind: 'pdf', storageKey: described.previewStorageKey });
      }
      // Until the worker has looked for LibreOffice, a preview may still come.
      return await deps.filePreviews?.available?.() === false ? none('unavailable') : { ...result, kind: 'preparing' };
    }
    case 'text':
    case 'markdown':
      if (described.fileSize > PREVIEW_TEXT_MAX_BYTES) return none('too_large');
      return signed(format);
    case 'pdf':
    case 'image':
    case 'video':
      return signed(format);
    default:
      return none('unsupported');
  }
}
