import { HttpError } from '../../lib/errors/http-error.js';

/**
 * Throws file_under_signature (409) when any of these files is in a pending or completed signature
 * request: such a file stays shared with stakeholders and cannot be deleted (docs/document-signing,
 * E-04). Kept apart from the signing service so the vault can use it without the portal's imports.
 */
export async function assertFilesNotUnderSignature(signingRepository, { fileIds, tenantId }) {
  if (!signingRepository?.listProtectedFileIds) return;
  const held = await signingRepository.listProtectedFileIds({ fileIds, tenantId });
  if (held.length) {
    throw new HttpError(409, 'This file is in a signature request, so it stays shared and cannot be deleted. Cancel the request first if it has not completed.', {
      details: { code: 'file_under_signature', fileIds: held },
    });
  }
}
