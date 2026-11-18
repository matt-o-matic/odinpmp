// What Odin keeps of invoice-gen's records: the link on a project, invoice summaries, the
// claims that lock time entries to an invoice, and the SOW milestone each story bills to.
// invoice-gen owns all of it but the story mapping.
//
// Every write takes `changeEntries(result)`: the project change log entries for what it did,
// written in the same transaction as the change (MySQL) or right after it (in memory).
import { randomUUID } from 'node:crypto';

import { HttpError } from '../../lib/errors/http-error.js';
import { appendMysqlProjectChanges } from '../changes/project-change-log.js';

export const BILLING_PROVIDER = 'invoice-gen';

const clone = (value) => (value == null ? value : structuredClone(value));
const iso = (value) => (value == null ? null : new Date(value).toISOString());
const roundHours = (value) => Math.round(Number(value) * 100) / 100;
// invoice-gen's ids are integers; Odin stores them as text and gives them back as they came.
const externalId = (value) => (value == null || value === '' ? null : /^\d+$/.test(String(value)) ? Number(value) : String(value));
const latest = (...values) => values.filter(Boolean).sort().at(-1) ?? null;

function claimInProgress() {
  return new HttpError(409, 'Another claim for this invoice is being saved. Try again.', { details: { code: 'claim_in_progress' } });
}

function otherProjectClaim() {
  return new HttpError(409, 'This invoice already holds time on another project.', { details: { code: 'invoice_on_other_project' } });
}

// The checks a claim makes on each entry. `entry` carries the
// claim that holds it, if any, with that claim's invoice and number.
function claimConflicts({ add, entries, externalInvoiceId, projectId, remove }) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const conflicts = [];
  for (const entryId of add) {
    const entry = byId.get(entryId);
    const heldBy = entry?.claim?.externalInvoiceId ?? null;
    if (!entry || entry.projectId !== projectId) conflicts.push({ entryId, externalInvoiceId: null, invoiceNumber: null, reason: 'not_found' });
    else if (heldBy && heldBy !== externalInvoiceId) conflicts.push({ entryId, externalInvoiceId: heldBy, invoiceNumber: entry.claim.invoiceNumber ?? null, reason: 'claimed' });
    else if (!heldBy && entry.status !== 'approved') conflicts.push({ entryId, externalInvoiceId: null, invoiceNumber: null, reason: 'not_approved' });
    else if (!heldBy && !entry.billable) conflicts.push({ entryId, externalInvoiceId: null, invoiceNumber: null, reason: 'not_billable' });
  }
  for (const entryId of remove) {
    const entry = byId.get(entryId);
    const heldBy = entry && entry.projectId === projectId ? entry.claim?.externalInvoiceId ?? null : null;
    if (heldBy !== externalInvoiceId) conflicts.push({ entryId, externalInvoiceId: heldBy, invoiceNumber: heldBy ? entry.claim.invoiceNumber ?? null : null, reason: 'not_claimed' });
  }
  return conflicts;
}

// ---- in memory ------------------------------------------------------------------------------------

/**
 * The billing records in memory, for tests and local runs. Claims change the finance repository's
 * own time entry records (billingTimeEntryStore), as the MySQL repository updates its table.
 */
export function createInMemoryBillingRepository({ recordChanges = () => {}, resourceFinanceRepository = null } = {}) {
  const links = new Map();
  const invoices = new Map();
  const claims = new Map();
  const milestones = new Map();
  const timeEntries = () => resourceFinanceRepository?.billingTimeEntryStore?.() ?? new Map();
  const now = () => new Date().toISOString();
  const linkKey = (tenantId, projectId) => `${tenantId}:${projectId}`;
  const invoiceKey = (tenantId, id) => `${tenantId}:${id}`;
  const record = (changeEntries, result) => { if (changeEntries) recordChanges((changeEntries(result) ?? []).filter(Boolean)); };

  const activeClaim = (tenantId, externalInvoiceId) => [...claims.values()]
    .find((claim) => claim.tenantId === tenantId && claim.externalInvoiceId === externalInvoiceId && !claim.releasedAt) ?? null;
  // What a claimed entry shows of its invoice (the finance repository's `invoice` field).
  function entryInvoice(claim) {
    const invoice = invoices.get(invoiceKey(claim.tenantId, claim.externalInvoiceId));
    return { externalInvoiceId: claim.externalInvoiceId, number: invoice?.number || claim.invoiceNumber || null, status: invoice?.status ?? null, url: invoice?.url || null };
  }
  function refreshEntries(claim) {
    for (const entry of timeEntries().values()) if (entry.invoiceClaimId === claim.id) entry.invoice = entryInvoice(claim);
  }
  function release(claim) {
    let released = 0;
    for (const entry of timeEntries().values()) {
      if (entry.invoiceClaimId !== claim.id) continue;
      Object.assign(entry, { invoice: null, invoiceClaimId: null, invoiceClaimedAt: null });
      released += 1;
    }
    claim.releasedAt = now();
    claim.updatedAt = claim.releasedAt;
    return released;
  }
  function held(claim) {
    if (!claim) return [];
    return [...timeEntries().values()].filter((entry) => entry.invoiceClaimId === claim.id)
      .sort((left, right) => left.workDate.localeCompare(right.workDate) || left.id.localeCompare(right.id));
  }
  function billingEntry(entry, resources) {
    const claim = entry.invoiceClaimId ? claims.get(entry.invoiceClaimId) : null;
    return {
      billable: Boolean(entry.billable), claim: claim ? { externalInvoiceId: claim.externalInvoiceId, id: claim.id, invoiceNumber: entryInvoice(claim).number } : null,
      hours: Number(entry.hours), id: entry.id, note: entry.note ?? '', projectId: entry.projectId, resourceId: entry.resourceId ?? null,
      resourceName: resources.get(entry.resourceId) ?? null, status: entry.status, workDate: entry.workDate, workItemId: entry.workItemId ?? null,
    };
  }

  return {
    async getLink({ projectId, tenantId }) { return clone(links.get(linkKey(tenantId, projectId)) ?? null); },
    async putLink({ changeEntries, link, projectId, tenantId }) {
      const key = linkKey(tenantId, projectId);
      const existing = links.get(key);
      const at = now();
      if (existing && Date.parse(existing.sourceUpdatedAt) > Date.parse(link.sourceUpdatedAt)) {
        existing.receivedAt = at;
        return { ignored: true, link: clone(existing) };
      }
      const saved = {
        agreement: clone(link.agreement ?? null), createdAt: existing?.createdAt ?? at, customer: clone(link.customer),
        lineOfBusiness: clone(link.lineOfBusiness ?? null), projectId, provider: BILLING_PROVIDER, receivedAt: at,
        sourceUpdatedAt: iso(link.sourceUpdatedAt), tenantId, updatedAt: at,
      };
      links.set(key, saved);
      const result = { created: !existing, ignored: false, link: clone(saved) };
      record(changeEntries, result);
      return result;
    },
    async deleteLink({ changeEntries, projectId, tenantId }) {
      const deleted = links.delete(linkKey(tenantId, projectId));
      if (deleted) record(changeEntries, { deleted });
      return deleted;
    },
    async listInvoices({ projectId, tenantId }) {
      return [...invoices.values()].filter((invoice) => invoice.tenantId === tenantId && invoice.projectId === projectId).map(clone);
    },
    async putInvoice({ changeEntries, externalId: id, projectId, summary, tenantId }) {
      const key = invoiceKey(tenantId, id);
      const existing = invoices.get(key);
      const at = now();
      if (existing && Date.parse(existing.sourceUpdatedAt) > Date.parse(summary.sourceUpdatedAt)) {
        existing.receivedAt = at;
        return { ignored: true, invoice: clone(existing), released: 0 };
      }
      const saved = { ...clone(summary), externalId: id, projectId, provider: BILLING_PROVIDER, receivedAt: at, sourceUpdatedAt: iso(summary.sourceUpdatedAt), tenantId, updatedAt: at };
      invoices.set(key, saved);
      const claim = activeClaim(tenantId, id);
      let released = 0;
      if (claim) {
        claim.invoiceNumber = summary.number || claim.invoiceNumber;
        if (summary.status === 'void') released = release(claim);
        else refreshEntries(claim);
      }
      const result = { ignored: false, invoice: clone(saved), previousStatus: existing?.status ?? null, released };
      record(changeEntries, result);
      return result;
    },
    async deleteInvoice({ changeEntries, externalId: id, projectId, tenantId }) {
      const key = invoiceKey(tenantId, id);
      const existing = invoices.get(key);
      const deleted = Boolean(existing && existing.projectId === projectId) && invoices.delete(key);
      const claim = activeClaim(tenantId, id);
      const released = claim && claim.projectId === projectId ? release(claim) : 0;
      const result = { deleted, released };
      if (deleted || released) record(changeEntries, result);
      return result;
    },
    async claimEntries({ add, applicationId = null, changeEntries, externalInvoiceId, idempotencyKey = null, projectId, remove, tenantId }) {
      let claim = activeClaim(tenantId, externalInvoiceId);
      if (claim && claim.projectId !== projectId) throw otherProjectClaim();
      const store = timeEntries();
      const entries = [...new Set([...add, ...remove])].map((id) => store.get(id)).filter((entry) => entry && entry.tenantId === tenantId).map((entry) => billingEntry(entry, new Map()));
      const conflicts = claimConflicts({ add, entries, externalInvoiceId, projectId, remove });
      if (conflicts.length) return { conflicts };
      const at = now();
      if (!claim && add.length) {
        const invoice = invoices.get(invoiceKey(tenantId, externalInvoiceId));
        claim = { claimedByApp: applicationId, createdAt: at, externalInvoiceId, id: randomUUID(), idempotencyKey, invoiceNumber: invoice?.number || null, projectId, provider: BILLING_PROVIDER, releasedAt: null, tenantId, updatedAt: at };
        claims.set(claim.id, claim);
      }
      const added = [];
      const removed = [];
      if (claim) {
        for (const id of add) {
          const entry = store.get(id);
          if (entry.invoiceClaimId === claim.id) continue;
          Object.assign(entry, { invoice: entryInvoice(claim), invoiceClaimId: claim.id, invoiceClaimedAt: at });
          added.push(id);
        }
        for (const id of remove) {
          Object.assign(store.get(id), { invoice: null, invoiceClaimId: null, invoiceClaimedAt: null });
          removed.push(id);
        }
        Object.assign(claim, { idempotencyKey: idempotencyKey ?? claim.idempotencyKey, updatedAt: at });
        if (!held(claim).length) release(claim);
      }
      const holding = held(claim && !claim.releasedAt ? claim : null);
      const result = { added, entryIds: holding.map((entry) => entry.id), externalInvoiceId, hours: roundHours(holding.reduce((sum, entry) => sum + Number(entry.hours), 0)), removed };
      if (added.length || removed.length) record(changeEntries, result);
      return result;
    },
    async releaseClaims({ changeEntries, externalInvoiceId, projectId, tenantId }) {
      const claim = activeClaim(tenantId, externalInvoiceId);
      const released = claim && claim.projectId === projectId ? release(claim) : 0;
      if (released) record(changeEntries, { released });
      return released;
    },
    async listProjectTimeEntries({ projectId, tenantId }) {
      const snapshot = resourceFinanceRepository?.listSnapshot ? await resourceFinanceRepository.listSnapshot({ tenantId }) : { resources: [] };
      const resources = new Map((snapshot.resources ?? []).map((resource) => [resource.id, resource.name]));
      return [...timeEntries().values()].filter((entry) => entry.tenantId === tenantId && entry.projectId === projectId)
        .map((entry) => billingEntry(entry, resources))
        .sort((left, right) => left.workDate.localeCompare(right.workDate) || left.id.localeCompare(right.id));
    },
    async listStoryMilestones({ projectId, tenantId }) {
      return [...milestones.values()].filter((row) => row.tenantId === tenantId && row.projectId === projectId).map(clone);
    },
    async setStoryMilestones({ assignments, changeEntries, projectId, tenantId, userId }) {
      const changed = [];
      const at = now();
      for (const { milestoneId, storyId } of assignments) {
        const before = milestones.get(storyId);
        const from = before && before.tenantId === tenantId ? before.milestoneId : null;
        if (from === milestoneId) continue;
        if (milestoneId == null) milestones.delete(storyId);
        else milestones.set(storyId, { milestoneId, projectId, storyId, tenantId, updatedAt: at, updatedBy: userId });
        changed.push({ from, storyId, to: milestoneId });
      }
      if (changed.length) record(changeEntries, { changed });
      return { changed };
    },
    async lastHeardAt({ projectId, tenantId }) {
      const link = links.get(linkKey(tenantId, projectId));
      const invoiceTimes = [...invoices.values()].filter((invoice) => invoice.tenantId === tenantId && invoice.projectId === projectId).map((invoice) => invoice.receivedAt);
      const claimTimes = [...claims.values()].filter((claim) => claim.tenantId === tenantId && claim.projectId === projectId).map((claim) => claim.updatedAt);
      return latest(link?.receivedAt, ...invoiceTimes, ...claimTimes);
    },
  };
}

// ---- MySQL ----------------------------------------------------------------------------------------

const parseJson = (value) => {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

function mapLink(row) {
  if (!row) return null;
  return {
    agreement: parseJson(row.agreement_json),
    createdAt: iso(row.created_at),
    customer: { id: externalId(row.external_customer_id), name: row.customer_name ?? '' },
    lineOfBusiness: row.external_line_of_business_id == null ? null : { id: externalId(row.external_line_of_business_id), name: row.line_of_business_name ?? '' },
    projectId: row.project_id,
    provider: row.provider,
    receivedAt: iso(row.received_at),
    sourceUpdatedAt: iso(row.source_updated_at),
    tenantId: row.tenant_id,
    updatedAt: iso(row.updated_at),
  };
}

// Dates are selected as text (DATE_FORMAT) so the server's time zone cannot move them.
const INVOICE_COLUMNS = `tenant_id, project_id, provider, external_id, number, status, DATE_FORMAT(issue_date, '%Y-%m-%d') AS issue_date,
  DATE_FORMAT(submitted_date, '%Y-%m-%d') AS submitted_date, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date, DATE_FORMAT(paid_date, '%Y-%m-%d') AS paid_date,
  overdue, hours, total_cents, currency, url, source_updated_at, received_at, updated_at`;

function mapInvoice(row) {
  if (!row) return null;
  return {
    currency: row.currency, dueDate: row.due_date ?? null, externalId: row.external_id, hours: Number(row.hours), issueDate: row.issue_date ?? null,
    number: row.number, overdue: Boolean(row.overdue), paidDate: row.paid_date ?? null, projectId: row.project_id, provider: row.provider,
    receivedAt: iso(row.received_at), sourceUpdatedAt: iso(row.source_updated_at), status: row.status, submittedDate: row.submitted_date ?? null,
    tenantId: row.tenant_id, totalCents: Number(row.total_cents), updatedAt: iso(row.updated_at), url: row.url ?? '',
  };
}

const ENTRY_SELECT = `SELECT t.id, t.project_id, t.resource_id, t.work_item_id, DATE_FORMAT(t.work_date, '%Y-%m-%d') AS work_date, t.hours, t.billable, t.status, t.note,
  t.invoice_claim_id, c.external_invoice_id AS claim_external_invoice_id, COALESCE(NULLIF(i.number, ''), c.invoice_number) AS claim_invoice_number, r.name AS resource_name
  FROM project_time_entries t
  LEFT JOIN time_entry_invoice_claims c ON c.id = t.invoice_claim_id AND c.tenant_id = t.tenant_id
  LEFT JOIN project_external_invoices i ON i.tenant_id = c.tenant_id AND i.provider = c.provider AND i.external_id = c.external_invoice_id
  LEFT JOIN enterprise_resources r ON r.id = t.resource_id AND r.tenant_id = t.tenant_id`;

function mapEntry(row) {
  return {
    billable: Boolean(row.billable),
    claim: row.invoice_claim_id ? { externalInvoiceId: row.claim_external_invoice_id ?? null, id: row.invoice_claim_id, invoiceNumber: row.claim_invoice_number || null } : null,
    hours: Number(row.hours), id: row.id, note: row.note ?? '', projectId: row.project_id, resourceId: row.resource_id ?? null,
    resourceName: row.resource_name ?? null, status: row.status, workDate: row.work_date, workItemId: row.work_item_id ?? null,
  };
}

const placeholders = (values) => values.map(() => '?').join(', ');

// Two writes that each insert a row the other's read locked the gap for (two new invoices, two
// first claims) can deadlock; MySQL rolls one back, and it runs again from the start.
const DEADLOCK_ATTEMPTS = 3;

export function createMysqlBillingRepository({ pool }) {
  async function transaction(work) {
    for (let attempt = 1; ; attempt += 1) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => {});
        if (error?.code === 'ER_LOCK_DEADLOCK' && attempt < DEADLOCK_ATTEMPTS) continue;
        if (error?.code === 'ER_DUP_ENTRY' && /uq_invoice_claims_active/.test(String(error.message))) throw claimInProgress();
        throw error;
      } finally {
        connection.release();
      }
    }
  }
  async function writeChanges(connection, changeEntries, result) {
    if (changeEntries) await appendMysqlProjectChanges(connection, (changeEntries(result) ?? []).filter(Boolean));
  }
  // The invoice's active claim, locked by its id. Found with a plain read, so a missing claim
  // locks no gap; a second active claim is stopped by uq_invoice_claims_active instead.
  async function activeClaim(connection, tenantId, externalInvoiceId) {
    const [found] = await connection.execute(
      'SELECT id FROM time_entry_invoice_claims WHERE tenant_id = ? AND provider = ? AND external_invoice_id = ? AND released_at IS NULL LIMIT 1',
      [tenantId, BILLING_PROVIDER, externalInvoiceId],
    );
    if (!found[0]) return null;
    const [rows] = await connection.execute('SELECT * FROM time_entry_invoice_claims WHERE id = ? AND released_at IS NULL FOR UPDATE', [found[0].id]);
    return rows[0] ?? null;
  }
  async function releaseClaim(connection, claim) {
    const [result] = await connection.execute('UPDATE project_time_entries SET invoice_claim_id = NULL, invoice_claimed_at = NULL WHERE tenant_id = ? AND invoice_claim_id = ?', [claim.tenant_id, claim.id]);
    await connection.execute('UPDATE time_entry_invoice_claims SET released_at = NOW(3), updated_at = NOW(3) WHERE id = ?', [claim.id]);
    return Number(result.affectedRows ?? 0);
  }

  return {
    async getLink({ projectId, tenantId }) {
      const [rows] = await pool.execute('SELECT * FROM project_billing_links WHERE tenant_id = ? AND project_id = ? AND provider = ? LIMIT 1', [tenantId, projectId, BILLING_PROVIDER]);
      return mapLink(rows[0]);
    },
    async putLink({ changeEntries, link, projectId, tenantId }) {
      return transaction(async (connection) => {
        const [rows] = await connection.execute('SELECT * FROM project_billing_links WHERE tenant_id = ? AND project_id = ? AND provider = ? FOR UPDATE', [tenantId, projectId, BILLING_PROVIDER]);
        const existing = mapLink(rows[0]);
        const sourceUpdatedAt = new Date(link.sourceUpdatedAt);
        if (existing && Date.parse(existing.sourceUpdatedAt) > sourceUpdatedAt.getTime()) {
          await connection.execute('UPDATE project_billing_links SET received_at = NOW(3) WHERE tenant_id = ? AND project_id = ? AND provider = ?', [tenantId, projectId, BILLING_PROVIDER]);
          return { ignored: true, link: existing };
        }
        const values = [
          String(link.customer.id), link.customer.name ?? '',
          link.lineOfBusiness ? String(link.lineOfBusiness.id) : null, link.lineOfBusiness?.name ?? '',
          link.agreement ? String(link.agreement.id) : null, link.agreement ? JSON.stringify(link.agreement) : null, sourceUpdatedAt,
        ];
        await connection.execute(
          `INSERT INTO project_billing_links (tenant_id, project_id, provider, external_customer_id, customer_name, external_line_of_business_id, line_of_business_name,
             external_agreement_id, agreement_json, source_updated_at, received_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3), NOW(3))
           ON DUPLICATE KEY UPDATE external_customer_id = VALUES(external_customer_id), customer_name = VALUES(customer_name),
             external_line_of_business_id = VALUES(external_line_of_business_id), line_of_business_name = VALUES(line_of_business_name),
             external_agreement_id = VALUES(external_agreement_id), agreement_json = VALUES(agreement_json), source_updated_at = VALUES(source_updated_at),
             received_at = NOW(3), updated_at = NOW(3)`,
          [tenantId, projectId, BILLING_PROVIDER, ...values],
        );
        const [saved] = await connection.execute('SELECT * FROM project_billing_links WHERE tenant_id = ? AND project_id = ? AND provider = ?', [tenantId, projectId, BILLING_PROVIDER]);
        const result = { created: !existing, ignored: false, link: mapLink(saved[0]) };
        await writeChanges(connection, changeEntries, result);
        return result;
      });
    },
    async deleteLink({ changeEntries, projectId, tenantId }) {
      return transaction(async (connection) => {
        const [result] = await connection.execute('DELETE FROM project_billing_links WHERE tenant_id = ? AND project_id = ? AND provider = ?', [tenantId, projectId, BILLING_PROVIDER]);
        const deleted = Number(result.affectedRows) > 0;
        if (deleted) await writeChanges(connection, changeEntries, { deleted });
        return deleted;
      });
    },
    async listInvoices({ projectId, tenantId }) {
      const [rows] = await pool.execute(`SELECT ${INVOICE_COLUMNS} FROM project_external_invoices WHERE tenant_id = ? AND project_id = ? AND provider = ?`, [tenantId, projectId, BILLING_PROVIDER]);
      return rows.map(mapInvoice);
    },
    async putInvoice({ changeEntries, externalId: id, projectId, summary, tenantId }) {
      return transaction(async (connection) => {
        const [rows] = await connection.execute(`SELECT ${INVOICE_COLUMNS} FROM project_external_invoices WHERE tenant_id = ? AND provider = ? AND external_id = ? FOR UPDATE`, [tenantId, BILLING_PROVIDER, id]);
        const existing = mapInvoice(rows[0]);
        const sourceUpdatedAt = new Date(summary.sourceUpdatedAt);
        if (existing && Date.parse(existing.sourceUpdatedAt) > sourceUpdatedAt.getTime()) {
          await connection.execute('UPDATE project_external_invoices SET received_at = NOW(3) WHERE tenant_id = ? AND provider = ? AND external_id = ?', [tenantId, BILLING_PROVIDER, id]);
          return { ignored: true, invoice: existing, released: 0 };
        }
        await connection.execute(
          `INSERT INTO project_external_invoices (tenant_id, project_id, provider, external_id, number, status, issue_date, submitted_date, due_date, paid_date,
             overdue, hours, total_cents, currency, url, source_updated_at, received_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))
           ON DUPLICATE KEY UPDATE project_id = VALUES(project_id), number = VALUES(number), status = VALUES(status), issue_date = VALUES(issue_date),
             submitted_date = VALUES(submitted_date), due_date = VALUES(due_date), paid_date = VALUES(paid_date), overdue = VALUES(overdue), hours = VALUES(hours),
             total_cents = VALUES(total_cents), currency = VALUES(currency), url = VALUES(url), source_updated_at = VALUES(source_updated_at),
             received_at = NOW(3), updated_at = NOW(3)`,
          [tenantId, projectId, BILLING_PROVIDER, id, summary.number ?? '', summary.status, summary.issueDate ?? null, summary.submittedDate ?? null, summary.dueDate ?? null,
            summary.paidDate ?? null, summary.overdue ? 1 : 0, summary.hours ?? 0, summary.totalCents ?? 0, summary.currency ?? 'USD', summary.url ?? '', sourceUpdatedAt],
        );
        const claim = await activeClaim(connection, tenantId, id);
        let released = 0;
        if (claim) {
          if (summary.number) await connection.execute('UPDATE time_entry_invoice_claims SET invoice_number = ? WHERE id = ?', [summary.number, claim.id]);
          if (summary.status === 'void') released = await releaseClaim(connection, claim);
        }
        const [saved] = await connection.execute(`SELECT ${INVOICE_COLUMNS} FROM project_external_invoices WHERE tenant_id = ? AND provider = ? AND external_id = ?`, [tenantId, BILLING_PROVIDER, id]);
        const result = { ignored: false, invoice: mapInvoice(saved[0]), previousStatus: existing?.status ?? null, released };
        await writeChanges(connection, changeEntries, result);
        return result;
      });
    },
    async deleteInvoice({ changeEntries, externalId: id, projectId, tenantId }) {
      return transaction(async (connection) => {
        const [result] = await connection.execute('DELETE FROM project_external_invoices WHERE tenant_id = ? AND provider = ? AND external_id = ? AND project_id = ?', [tenantId, BILLING_PROVIDER, id, projectId]);
        const claim = await activeClaim(connection, tenantId, id);
        const released = claim && claim.project_id === projectId ? await releaseClaim(connection, claim) : 0;
        const outcome = { deleted: Number(result.affectedRows) > 0, released };
        if (outcome.deleted || released) await writeChanges(connection, changeEntries, outcome);
        return outcome;
      });
    },
    async claimEntries({ add, applicationId = null, changeEntries, externalInvoiceId, idempotencyKey = null, projectId, remove, tenantId }) {
      return transaction(async (connection) => {
        const ids = [...new Set([...add, ...remove])].sort();
        let entries = [];
        if (ids.length) {
          // Lock the entries first, in id order, so a claim or an edit that reached them earlier
          // commits before these are read, and two claims of the same entries queue.
          await connection.execute(`SELECT id FROM project_time_entries WHERE tenant_id = ? AND id IN (${placeholders(ids)}) ORDER BY id FOR UPDATE`, [tenantId, ...ids]);
          const [rows] = await connection.execute(`${ENTRY_SELECT} WHERE t.tenant_id = ? AND t.id IN (${placeholders(ids)})`, [tenantId, ...ids]);
          entries = rows.map(mapEntry);
        }
        let claim = await activeClaim(connection, tenantId, externalInvoiceId);
        if (claim && claim.project_id !== projectId) throw otherProjectClaim();
        const conflicts = claimConflicts({ add, entries, externalInvoiceId, projectId, remove });
        if (conflicts.length) return { conflicts };
        if (!claim && add.length) {
          const [numbers] = await connection.execute('SELECT number FROM project_external_invoices WHERE tenant_id = ? AND provider = ? AND external_id = ?', [tenantId, BILLING_PROVIDER, externalInvoiceId]);
          const id = randomUUID();
          await connection.execute(
            `INSERT INTO time_entry_invoice_claims (id, tenant_id, project_id, provider, external_invoice_id, invoice_number, idempotency_key, claimed_by_app, created_at, updated_at, released_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3), NULL)`,
            [id, tenantId, projectId, BILLING_PROVIDER, externalInvoiceId, numbers[0]?.number || null, idempotencyKey, applicationId],
          );
          claim = { id, project_id: projectId, tenant_id: tenantId };
        }
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        const added = add.filter((id) => byId.get(id)?.claim?.id !== claim?.id);
        const removed = [...remove];
        if (claim) {
          if (added.length) {
            await connection.execute(`UPDATE project_time_entries SET invoice_claim_id = ?, invoice_claimed_at = NOW(3) WHERE tenant_id = ? AND id IN (${placeholders(added)}) AND invoice_claim_id IS NULL`, [claim.id, tenantId, ...added]);
          }
          if (removed.length) {
            await connection.execute(`UPDATE project_time_entries SET invoice_claim_id = NULL, invoice_claimed_at = NULL WHERE tenant_id = ? AND id IN (${placeholders(removed)}) AND invoice_claim_id = ?`, [tenantId, ...removed, claim.id]);
          }
          await connection.execute('UPDATE time_entry_invoice_claims SET idempotency_key = COALESCE(?, idempotency_key), updated_at = NOW(3) WHERE id = ?', [idempotencyKey, claim.id]);
        }
        const [holding] = claim
          ? await connection.execute("SELECT id, hours FROM project_time_entries WHERE tenant_id = ? AND invoice_claim_id = ? ORDER BY work_date, id", [tenantId, claim.id])
          : [[]];
        if (claim && !holding.length) await connection.execute('UPDATE time_entry_invoice_claims SET released_at = NOW(3), updated_at = NOW(3) WHERE id = ?', [claim.id]);
        const result = { added, entryIds: holding.map((row) => row.id), externalInvoiceId, hours: roundHours(holding.reduce((sum, row) => sum + Number(row.hours), 0)), removed };
        if (added.length || removed.length) await writeChanges(connection, changeEntries, result);
        return result;
      });
    },
    async releaseClaims({ changeEntries, externalInvoiceId, projectId, tenantId }) {
      return transaction(async (connection) => {
        const claim = await activeClaim(connection, tenantId, externalInvoiceId);
        const released = claim && claim.project_id === projectId ? await releaseClaim(connection, claim) : 0;
        if (released) await writeChanges(connection, changeEntries, { released });
        return released;
      });
    },
    async listProjectTimeEntries({ projectId, tenantId }) {
      const [rows] = await pool.execute(`${ENTRY_SELECT} WHERE t.tenant_id = ? AND t.project_id = ? ORDER BY t.work_date, t.id`, [tenantId, projectId]);
      return rows.map(mapEntry);
    },
    async listStoryMilestones({ projectId, tenantId }) {
      const [rows] = await pool.execute('SELECT story_id, external_milestone_id, updated_by, updated_at FROM story_billing_milestones WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]);
      return rows.map((row) => ({ milestoneId: Number(row.external_milestone_id), projectId, storyId: row.story_id, tenantId, updatedAt: iso(row.updated_at), updatedBy: row.updated_by }));
    },
    async setStoryMilestones({ assignments, changeEntries, projectId, tenantId, userId }) {
      return transaction(async (connection) => {
        const storyIds = assignments.map((entry) => entry.storyId);
        const [rows] = storyIds.length
          ? await connection.execute(`SELECT story_id, external_milestone_id FROM story_billing_milestones WHERE tenant_id = ? AND story_id IN (${placeholders(storyIds)}) FOR UPDATE`, [tenantId, ...storyIds])
          : [[]];
        const current = new Map(rows.map((row) => [row.story_id, Number(row.external_milestone_id)]));
        const changed = [];
        for (const { milestoneId, storyId } of assignments) {
          const from = current.get(storyId) ?? null;
          if (from === milestoneId) continue;
          if (milestoneId == null) {
            await connection.execute('DELETE FROM story_billing_milestones WHERE tenant_id = ? AND story_id = ?', [tenantId, storyId]);
          } else {
            await connection.execute(
              `INSERT INTO story_billing_milestones (tenant_id, project_id, story_id, external_milestone_id, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, NOW(3))
               ON DUPLICATE KEY UPDATE external_milestone_id = VALUES(external_milestone_id), updated_by = VALUES(updated_by), updated_at = NOW(3)`,
              [tenantId, projectId, storyId, milestoneId, userId],
            );
          }
          changed.push({ from, storyId, to: milestoneId });
        }
        if (changed.length) await writeChanges(connection, changeEntries, { changed });
        return { changed };
      });
    },
    async lastHeardAt({ projectId, tenantId }) {
      const [rows] = await pool.execute(
        `SELECT (SELECT MAX(received_at) FROM project_billing_links WHERE tenant_id = ? AND project_id = ?) AS link_at,
           (SELECT MAX(received_at) FROM project_external_invoices WHERE tenant_id = ? AND project_id = ?) AS invoice_at,
           (SELECT MAX(updated_at) FROM time_entry_invoice_claims WHERE tenant_id = ? AND project_id = ?) AS claim_at`,
        [tenantId, projectId, tenantId, projectId, tenantId, projectId],
      );
      const row = rows[0] ?? {};
      return latest(iso(row.link_at), iso(row.invoice_at), iso(row.claim_at));
    },
  };
}
