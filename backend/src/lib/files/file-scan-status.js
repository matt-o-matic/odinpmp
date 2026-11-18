import { HttpError } from '../errors/http-error.js';

// A file's scan status: pending until the scan worker reads it,
// then clean, infected or failed. Only clean contents can be downloaded.

const NOT_READY = {
  failed: ['file_scan_failed', 'This file could not be scanned for viruses, so it cannot be opened.'],
  infected: ['file_infected', 'A virus was found in this file, so it was removed.'],
  pending: ['file_scanning', 'This file is still being scanned for viruses. Try again in a minute.'],
};

export const SCAN_STATUSES = ['pending', 'clean', 'infected', 'failed'];

/** Refuses contents whose scan has not passed (409 file_scanning, file_infected or file_scan_failed). */
export function assertFileScanClean(scanStatus) {
  const status = scanStatus ?? 'clean';
  if (status === 'clean') return;
  const [code, message] = NOT_READY[status] ?? NOT_READY.failed;
  throw new HttpError(409, message, { details: { code, scanStatus: status } });
}
