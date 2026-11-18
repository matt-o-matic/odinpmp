// Billing panel, story field and time entry helpers (docs/invoice-gen-connection). Pure functions,
// so they test without a browser.

const STATUS_LABELS = { draft: 'Draft', paid: 'Paid', submitted: 'Submitted', void: 'Void' };
const STATUS_ICONS = { draft: 'bi-pencil', paid: 'bi-check-circle-fill', submitted: 'bi-send', void: 'bi-x-circle' };

export function invoiceStatusLabel(status) {
  return STATUS_LABELS[status] ?? 'Draft';
}

export function invoiceStatusIcon(status) {
  return STATUS_ICONS[status] ?? STATUS_ICONS.draft;
}

/** "12.5 h"; whole hours drop the decimals. */
export function formatHours(value) {
  const hours = Math.round(Number(value ?? 0) * 100) / 100;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(2).replace(/0$/, '')} h`;
}

export function formatMoney(cents, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { currency: currency || 'USD', style: 'currency' }).format(Number(cents ?? 0) / 100);
  } catch {
    return `${(Number(cents ?? 0) / 100).toFixed(2)} ${currency}`;
  }
}

/** A YYYY-MM-DD date as written, or a timestamp with its time when asked; "—" for none. */
export function formatBillingDate(value, { time = false } = {}) {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const at = new Date(value);
  if (Number.isNaN(at.valueOf())) return '—';
  return time ? at.toLocaleString(undefined, { day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short', year: 'numeric' }) : at.toLocaleDateString();
}

/** Budget less what is billed or on drafts; negative once the milestone is over budget. */
export function remainingHours(milestone) {
  return Math.round((Number(milestone.budgetHours ?? 0) - Number(milestone.billedHours ?? 0) - Number(milestone.claimedUnbilledHours ?? 0)) * 100) / 100;
}

/** Stories matching the search text (story or epic name) and the epic filter. */
export function filterStories(stories = [], { epicId = '', query = '' } = {}) {
  const text = String(query ?? '').trim().toLowerCase();
  return stories.filter((story) => (!epicId || story.epicId === epicId)
    && (!text || `${story.title} ${story.epicTitle ?? ''}`.toLowerCase().includes(text)));
}

/** What a claimed time entry says about its invoice: its number, or "Draft invoice". */
export function timeEntryInvoiceLabel(entry) {
  if (!entry?.invoiced && !entry?.invoice) return '';
  const invoice = entry.invoice ?? {};
  return invoice.number && !invoice.draft ? invoice.number : invoice.number ? `${invoice.number} (draft)` : 'Draft invoice';
}

/** A readable message for a billing API error. */
export function billingErrorMessage(error, fallback) {
  const code = error?.data?.details?.code ?? error?.details?.code;
  if (code === 'module_disabled') return 'The Consulting module is switched off for this workspace.';
  if (code === 'billing_not_allowed') return 'Billing is shown to project admins and managers, and workspace admins and managers.';
  if (code === 'billing_not_linked') return 'This project has no SOW linked from invoice-gen yet.';
  if (code === 'invalid_assignments') return 'Some stories or milestones changed since this was opened. Reload and try again.';
  if (code === 'time_entry_invoiced') return 'This time is on an invoice, so it cannot be changed. Void the invoice or take the entry off the draft in invoice-gen first.';
  return error?.message || fallback;
}
