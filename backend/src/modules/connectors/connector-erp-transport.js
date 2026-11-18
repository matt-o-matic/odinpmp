import { HttpError } from '../../lib/errors/http-error.js';
import { resolveTenantSecretReference } from '../../lib/secrets/tenant-secret-reference.js';

const PROVIDER_HOSTS = Object.freeze({
  netsuite: ['.suitetalk.api.netsuite.com'],
  sap_s4hana: ['.s4hana.ondemand.com', '.api.sap.com'],
});

function parseCredential(value) { const text = String(value ?? '').trim(); if (!text) throw new HttpError(503, 'Connector credential is unavailable.'); try { const parsed = JSON.parse(text); return typeof parsed === 'object' && parsed ? parsed : { accessToken: text }; } catch { return { accessToken: text }; } }
function defaultSecretResolver(reference, { tenantId } = {}) { return resolveTenantSecretReference(reference, { tenantId }); }
function baseUrlFor(connection) {
  const configured = String(connection.settings?.baseUrl ?? '').trim(); let value = configured;
  if (!value && connection.provider === 'netsuite' && connection.settings?.accountId) value = `https://${String(connection.settings.accountId).toLowerCase().replaceAll('_', '-')}.suitetalk.api.netsuite.com`;
  const parsed = new URL(value); const allowed = PROVIDER_HOSTS[connection.provider] ?? [];
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443') || !allowed.some((suffix) => parsed.hostname.toLowerCase().endsWith(suffix))) throw new HttpError(503, 'Connector provider endpoint is not an approved public HTTPS host.');
  return parsed.origin;
}
function authorization(connection, credential) { const token = String(credential.accessToken ?? credential.token ?? '').trim(); if (!token) throw new HttpError(503, 'Connector access token is unavailable.'); return `${connection.authType === 'pat' && connection.provider === 'sap_s4hana' && credential.scheme === 'Basic' ? 'Basic' : 'Bearer'} ${token}`; }
function journalBody(connection, entry) {
  if (connection.provider === 'netsuite') return { approved: true, externalId: entry.id, memo: entry.category, subsidiary: connection.settings?.subsidiaryId ? { id: String(connection.settings.subsidiaryId) } : undefined, tranDate: entry.effectiveDate, currency: { refName: entry.currency }, line: { item: [{ account: { id: String(connection.settings?.debitAccountId ?? '') }, credit: entry.amount < 0 ? Math.abs(entry.amount) : 0, debit: entry.amount >= 0 ? entry.amount : 0, memo: entry.note || entry.category }] } };
  return { CompanyCode: String(connection.settings?.companyCode ?? ''), DocumentDate: entry.effectiveDate, DocumentHeaderText: entry.category, DocumentReferenceID: entry.id, PostingDate: entry.effectiveDate, TransactionCurrency: entry.currency, to_JournalEntryItem: [{ AmountInTransactionCurrency: entry.amount, GLAccount: String(connection.settings?.glAccount ?? ''), ProjectReference: entry.projectId }] };
}
function postingPath(connection) { return connection.provider === 'netsuite' ? '/services/rest/record/v1/journalEntry' : '/sap/opu/odata/sap/API_JOURNALENTRY_SRV/A_JournalEntry'; }
function responseExternalId(response) { const location = response.headers?.location ?? response.headers?.Location; const body = response.body ?? {}; return String(body.id ?? body.internalId ?? body.AccountingDocument ?? (location ? location.split('/').filter(Boolean).at(-1) : '')).trim(); }

async function defaultRequest({ body, headers, method, url }) {
  const response = await fetch(url, { body: body == null ? undefined : JSON.stringify(body), headers, method, redirect: 'error', signal: AbortSignal.timeout(15_000) }); const text = await response.text(); if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Connector response exceeded 64 KiB.'); let parsed = {}; if (text) try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 4000) }; } return { body: parsed, headers: Object.fromEntries(response.headers), status: response.status };
}

export function createErpConnectorTransport({ request = defaultRequest, secretResolver = defaultSecretResolver } = {}) {
  return {
    async postAndReconcile({ connection, financialEntry, idempotencyKey }) {
      if (!['netsuite', 'sap_s4hana'].includes(connection.provider)) throw new HttpError(400, 'ERP transport supports NetSuite and SAP S/4HANA only.');
      const credential = parseCredential(await secretResolver(connection.secretReference, { connectionId: connection.id, tenantId: connection.tenantId })); const baseUrl = baseUrlFor(connection); const path = postingPath(connection); const headers = { accept: 'application/json', authorization: authorization(connection, credential), 'content-type': 'application/json', 'idempotency-key': idempotencyKey, ...(connection.provider === 'netsuite' ? { 'x-netsuite-idempotency-key': idempotencyKey } : {}) };
      const posted = await request({ body: journalBody(connection, financialEntry), headers, method: 'POST', url: `${baseUrl}${path}` });
      if (posted.status < 200 || posted.status >= 300) throw new Error(`ERP posting returned HTTP ${posted.status}.`); const externalId = responseExternalId(posted); if (!externalId) throw new Error('ERP posting response did not include an external journal id.');
      const reconciled = await request({ headers: { accept: 'application/json', authorization: headers.authorization }, method: 'GET', url: `${baseUrl}${path}/${encodeURIComponent(externalId)}` });
      const matched = reconciled.status >= 200 && reconciled.status < 300; return { externalId, reconciliation: { checkedAt: new Date().toISOString(), matched, providerStatus: matched ? String(reconciled.body?.status ?? reconciled.body?.PostingStatus ?? 'posted') : `http_${reconciled.status}` } };
    },
  };
}
