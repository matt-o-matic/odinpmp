import { HttpError } from './http-error.js';

// A time entry an invoice has claimed stays as it was billed (docs/invoice-gen-connection, E-06):
// nobody edits or deletes it, the person who logged it included, until invoice-gen releases the
// claim by voiding or deleting the invoice. The finance repositories refuse the write, so every
// path to it (the app, MCP, the assistant, task access links) gets this same answer.
export const TIME_ENTRY_INVOICED = 'time_entry_invoiced';

export function timeEntryInvoicedError() {
  return new HttpError(409, 'This time entry is on an invoice, so it cannot be changed or deleted. Void the invoice or take the entry off the draft in invoice-gen first.', {
    details: { code: TIME_ENTRY_INVOICED },
  });
}
