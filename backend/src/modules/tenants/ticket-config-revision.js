import { createHash } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';

// The ticket configuration PUT replaces the whole list. Every save bumps the version of every
// row it writes or retires, so a fingerprint of (id, version) pairs changes on any save and
// lets a client that loaded the list detect that someone else saved in between.
export function ticketConfigRevision(entries = []) {
  const pairs = entries.map((entry) => `${entry.id}:${Number(entry.version ?? 1)}`).sort();
  return createHash('sha256').update(pairs.join('\n')).digest('hex').slice(0, 32);
}

export function assertTicketConfigRevision(entries, expectedRevision) {
  if (expectedRevision == null) return;
  const actualRevision = ticketConfigRevision(entries);
  if (actualRevision !== expectedRevision) {
    throw new HttpError(409, 'This list changed since it was loaded. Reload it and reapply your changes.', {
      details: { actualRevision, code: 'ticket_config_revision_conflict', expectedRevision },
    });
  }
}
