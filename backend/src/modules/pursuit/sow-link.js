// The SOW card's source: the project's link to invoice-gen (project_billing_links, migration
// 0099_billing). A reader returns
// `{ status, title, url, executedAt, history: [{ status, at }] }` for a linked SOW, or null when
// the project has no link, the link has no SOW, or the table is not there yet.

export const SOW_STATES = Object.freeze({
  awaiting_signature: 'Awaiting signature',
  drafting: 'Drafting',
  shared_for_review: 'Shared for review',
  signed: 'Signed',
});

function normalizeState(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['executed', 'signed'].includes(key)) return 'signed';
  if (['draft', 'drafting'].includes(key)) return 'drafting';
  if (['review', 'in_review', 'shared', 'shared_for_review'].includes(key)) return 'shared_for_review';
  if (['awaiting_signature', 'sent_for_signature', 'pending_signature'].includes(key)) return 'awaiting_signature';
  return key || null;
}

/** A reader's result as the SOW card shows it, or null for no SOW. */
export function presentSowLink(link) {
  if (!link) return null;
  const state = normalizeState(link.status);
  if (!state) return null;
  return {
    history: (link.history ?? [])
      .map((entry) => ({ at: entry.at ? new Date(entry.at).toISOString() : null, label: SOW_STATES[normalizeState(entry.status)] ?? String(entry.status ?? ''), state: normalizeState(entry.status) }))
      .filter((entry) => entry.state)
      .sort((left, right) => String(left.at).localeCompare(String(right.at))),
    executedAt: link.executedAt ? new Date(link.executedAt).toISOString() : null,
    label: SOW_STATES[state] ?? String(link.status),
    state,
    title: String(link.title ?? ''),
    url: /^https?:\/\//i.test(String(link.url ?? '')) ? String(link.url) : null,
  };
}

/**
 * The SOW as Odin's channel notes put it (odin-context.js): "Signed: Northwind phase 2 (signed
 * 2026-11-20)", or null without one. Members' turns only; guests' turns get no SOW.
 */
export function describeSowForOdin(sow) {
  if (!sow) return null;
  const title = sow.title ? `: ${sow.title}` : '';
  const signed = sow.state === 'signed' && sow.executedAt ? ` (signed ${sow.executedAt.slice(0, 10)})` : '';
  return `${sow.label}${title}${signed}`;
}

/** Reads the SOW through `reader` (null means no billing connection), and never throws. */
export async function readSowLink({ projectId, reader, tenantId }) {
  if (!reader) return null;
  try {
    return presentSowLink(await reader({ projectId, tenantId }));
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') return null;
    throw error;
  }
}

/**
 * A reader over billing's link to invoice-gen (billing.repository.js `getLink`, in memory or
 * MySQL). The link holds the agreement as invoice-gen last sent it (PUT billing-link): title,
 * status, url and executedAt. Billing keeps no status history, so the
 * card shows the current status, and the signing date when there is one.
 */
export function createBillingSowLinkReader({ billingRepository }) {
  if (!billingRepository?.getLink) return null;
  return async function readBillingSowLink({ projectId, tenantId }) {
    const agreement = (await billingRepository.getLink({ projectId, tenantId }))?.agreement ?? null;
    if (!agreement) return null;
    const executedAt = agreement.executedAt ?? null;
    return {
      executedAt,
      history: executedAt ? [{ at: executedAt, status: 'executed' }] : [],
      status: agreement.status,
      title: agreement.title ?? '',
      url: agreement.url ?? agreement.link ?? null,
    };
  };
}
