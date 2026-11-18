// The /api/v1 billing routes driven the way invoice-gen drives them. `odin` below copies the
// request shapes of invoice-gen's src/server/odinClient.ts (feature/odin-connection, a0663f6): the
// token request, headers, Idempotency-Key formats, bodies, and how it reads replies and errors,
// and the scenarios follow its fake Odin in src/server/odin-connection.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';

import { PROJECT, TENANT, AGREEMENT, billingFixture } from './helpers/billing-fixture.js';

const ODIN_SCOPES = 'projects.read billing.read billing.write';

class OdinError extends Error {
  constructor(message, status, code, body = {}) { super(message); Object.assign(this, { body, code, status }); }
  get conflicts() { return Array.isArray(this.body.conflicts) ? this.body.conflicts : []; }
}

// odinClient.ts, transport and calls, without the TypeScript.
function invoiceGenClient({ baseUrl, clientId, clientSecret }) {
  let cachedToken = null;
  const calls = [];
  async function readBody(response) {
    const text = await response.text();
    if (!text) return {};
    try { const parsed = JSON.parse(text); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { data: parsed }; } catch { return { error: text.slice(0, 200) }; }
  }
  function errorFrom(status, body) {
    const message = typeof body.error === 'string' ? body.error : `HTTP ${status}`;
    const code = typeof body.code === 'string' ? body.code : message === 'module_disabled' ? 'module_disabled' : status === 404 ? 'odin_not_found' : `odin_http_${status}`;
    return new OdinError(message, status, code, body);
  }
  async function fetchToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
    const basic = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
    const response = await fetch(`${baseUrl}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: ODIN_SCOPES }).toString(),
    });
    const body = await readBody(response);
    if (!response.ok || typeof body.access_token !== 'string') throw new OdinError(`token request failed: ${body.error}`, response.status, 'odin_token_failed', body);
    cachedToken = { expiresAt: Date.now() + Math.max(0, Number(body.expires_in ?? 3600) - 60) * 1000, token: body.access_token, tokenType: body.token_type, scope: body.scope };
    return body.access_token;
  }
  async function call(path, options = {}) {
    const attempt = async () => {
      const token = await fetchToken();
      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
      calls.push({ method: options.method ?? 'GET', path, idempotencyKey: options.idempotencyKey ?? null });
      return fetch(`${baseUrl}${path}`, { method: options.method ?? 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    };
    let response = await attempt();
    if (response.status === 401) { cachedToken = null; response = await attempt(); }
    const body = await readBody(response);
    if (!response.ok) throw errorFrom(response.status, body);
    return { data: body.data ?? body, headers: response.headers, raw: body };
  }
  const project = (projectId) => `/api/v1/projects/${encodeURIComponent(projectId)}`;
  return {
    calls,
    get cachedToken() { return cachedToken; },
    breakToken() { cachedToken = { expiresAt: Date.now() + 60_000, token: 'odin_oauth_revoked_token_that_is_long_enough_to_look_real_123456' }; },
    listProjects: (kind = 'all') => call(`/api/v1/projects?kind=${kind}`),
    putBillingLink: (projectId, link, idempotencyKey) => call(`${project(projectId)}/billing-link`, { method: 'PUT', body: link, idempotencyKey }),
    deleteBillingLink: (projectId, idempotencyKey) => call(`${project(projectId)}/billing-link`, { method: 'DELETE', idempotencyKey }),
    getBillableTime: (projectId, from, to, includeInvoice) => call(`${project(projectId)}/billable-time?from=${from}&to=${to}${includeInvoice ? `&includeInvoice=${encodeURIComponent(includeInvoice)}` : ''}`),
    claim: (projectId, body, idempotencyKey) => call(`${project(projectId)}/invoice-claims`, { method: 'POST', body, idempotencyKey }),
    releaseClaims: (projectId, externalInvoiceId, idempotencyKey) => call(`${project(projectId)}/invoice-claims/${encodeURIComponent(externalInvoiceId)}`, { method: 'DELETE', idempotencyKey }),
    putInvoice: (projectId, externalInvoiceId, summary, idempotencyKey) => call(`${project(projectId)}/invoices/${encodeURIComponent(externalInvoiceId)}`, { method: 'PUT', body: summary, idempotencyKey }),
    deleteInvoice: (projectId, externalInvoiceId, idempotencyKey) => call(`${project(projectId)}/invoices/${encodeURIComponent(externalInvoiceId)}`, { method: 'DELETE', idempotencyKey }),
  };
}

// invoiceSummaryBody in invoice-gen's odinSync.ts.
const summary = (overrides = {}) => ({
  number: 'NESLLC-20261130-001', status: 'draft', overdue: false, issueDate: '2026-11-30', submittedDate: null, dueDate: null, paidDate: null,
  hours: 8, totalCents: 120000, currency: 'USD', url: 'http://invoices.example/admin/invoices/7', sourceUpdatedAt: new Date().toISOString(), ...overrides,
});
// billingLinkBody in odinSync.ts, for an agreement.
const link = (overrides = {}) => ({
  customer: { id: 12, name: 'Initech' },
  lineOfBusiness: { id: 3, name: '' },
  agreement: { ...AGREEMENT, url: 'http://invoices.example/admin/agreements/41', milestones: AGREEMENT.milestones.map((bucket) => ({ ...bucket, hours: Number(bucket.hours) })) },
  sourceUpdatedAt: new Date().toISOString(),
  ...overrides,
});
const sameEntrySet = (left, right) => left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index]);

async function servedOdin(t) {
  const fixture = await billingFixture();
  const server = await new Promise((resolve) => { const listening = fixture.app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const registered = await fixture.application();
  const odin = invoiceGenClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, clientId: registered.application.clientId, clientSecret: registered.clientSecret });
  return { ...fixture, odin };
}

function assertEntryShape(entry) {
  assert.equal(typeof entry.id, 'string');
  assert.match(entry.workDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof entry.hours, 'number');
  assert.ok(entry.person === null || (typeof entry.person.name === 'string' && 'resourceId' in entry.person));
  assert.ok(entry.note === null || typeof entry.note === 'string');
  assert.ok(entry.workItem === null || (typeof entry.workItem.id === 'string' && typeof entry.workItem.type === 'string' && typeof entry.workItem.title === 'string'));
  assert.ok(entry.story === null || (typeof entry.story.id === 'string' && typeof entry.story.title === 'string'));
  assert.ok(entry.milestoneId === null || Number.isInteger(entry.milestoneId));
  assert.ok(entry.claimedBy === null || typeof entry.claimedBy === 'string');
}

test('contract: token, project list, link, import, claim, conflict, re-import, status, void and deletes, as invoice-gen sends them', async (t) => {
  const fixture = await servedOdin(t);
  const { odin } = fixture;
  const te = {
    one: await fixture.entry({ hours: 2.5, workItemId: 'task-a1a', workDate: '2026-11-03' }),
    two: await fixture.entry({ hours: 3, workItemId: 'story-b1', workDate: '2026-11-04', resource: 'pat' }),
    three: await fixture.entry({ hours: 1.5, workItemId: 'story-b2', workDate: '2026-11-05' }),
    four: await fixture.entry({ hours: 1, workDate: '2026-11-06' }),
    late: await fixture.entry({ hours: 0.75, workItemId: 'story-a1', workDate: '2026-12-02' }),
  };

  // Projects, with the fields OdinProject reads.
  const projects = await odin.listProjects('all');
  assert.equal(odin.cachedToken.tokenType, 'Bearer');
  assert.equal(odin.cachedToken.scope, ODIN_SCOPES);
  assert.ok(Array.isArray(projects.data));
  const project = projects.data.find((entry) => entry.id === PROJECT);
  assert.deepEqual({ id: project.id, kind: project.kind, engagementStatus: project.engagementStatus, appUrl: project.appUrl, name: project.name, status: project.status },
    { id: PROJECT, kind: 'delivery', engagementStatus: null, appUrl: `https://odin.example/app/projects/${PROJECT}`, name: 'Initech delivery', status: 'In Progress' });

  // link_odin_project (an outbox send).
  const linked = await odin.putBillingLink(PROJECT, link(), 'invoice-gen-outbox-1-1');
  assert.equal(linked.data.projectId, PROJECT);
  assert.equal(linked.data.agreement.id, 41);
  const mapped = await fixture.api.put('pat', `/api/projects/${PROJECT}/billing/milestones`, { assignments: [{ storyId: 'story-a1', milestoneId: 101 }, { storyId: 'story-b1', milestoneId: 102 }] });
  assert.equal(mapped.status, 200);

  // get_billing_context and create_draft_invoice read billable time.
  const time = (await odin.getBillableTime(PROJECT, '2026-11-01', '2026-11-30')).data;
  assert.deepEqual(Object.keys(time).sort(), ['entries', 'from', 'lines', 'projectId', 'to', 'totalHours']);
  time.entries.forEach(assertEntryShape);
  assert.deepEqual(time.entries.map((entry) => entry.id).sort(), [te.one.id, te.two.id, te.three.id, te.four.id].sort());
  assert.deepEqual(time.lines.map((line) => [line.milestoneId, line.hours]), [[101, 2.5], [102, 3], [null, 2.5]]);
  for (const line of time.lines) for (const story of line.stories) assert.ok((story.id === null || typeof story.id === 'string') && typeof story.title === 'string' && typeof story.hours === 'number');
  assert.equal(time.totalHours, 8);

  // The draft claims what it imported, with invoice-gen's key format, then sends its summary.
  const entryIds = time.entries.map((entry) => entry.id);
  const claimed = await odin.claim(PROJECT, { externalInvoiceId: '7', add: entryIds, remove: [] }, 'invoice-7-claim-1');
  assert.ok(sameEntrySet(claimed.data.entryIds, entryIds), 'claimed the set invoice-gen imported');
  assert.deepEqual([claimed.data.externalInvoiceId, claimed.data.hours], ['7', 8]);
  await odin.putInvoice(PROJECT, '7', summary(), 'invoice-gen-outbox-2-1');

  // A second draft over the same period: nothing saved, the conflicts name the holder.
  const error = await odin.claim(PROJECT, { externalInvoiceId: '8', add: [te.one.id, te.two.id], remove: [] }, 'invoice-8-claim-1').then(() => null, (failure) => failure);
  assert.ok(error instanceof OdinError);
  assert.equal(error.status, 409);
  assert.equal(error.code, 'time_entries_claimed');
  assert.deepEqual(error.conflicts.map(({ entryId, externalInvoiceId, invoiceNumber }) => ({ entryId, externalInvoiceId, invoiceNumber })), [
    { entryId: te.one.id, externalInvoiceId: '7', invoiceNumber: 'NESLLC-20261130-001' },
    { entryId: te.two.id, externalInvoiceId: '7', invoiceNumber: 'NESLLC-20261130-001' },
  ]);

  // update_draft_invoice: re-import with includeInvoice, add the late entry, drop one.
  const reread = (await odin.getBillableTime(PROJECT, '2026-11-01', '2026-12-31', '7')).data;
  reread.entries.forEach(assertEntryShape);
  assert.ok(reread.entries.filter((entry) => entryIds.includes(entry.id)).every((entry) => entry.claimedBy === '7'));
  assert.equal(reread.entries.find((entry) => entry.id === te.late.id).claimedBy, null);
  assert.equal(odin.calls.at(-1).path.endsWith('includeInvoice=7'), true);
  const refreshed = await odin.claim(PROJECT, { externalInvoiceId: '7', add: [te.late.id], remove: [te.four.id] }, 'invoice-7-claim-2');
  assert.ok(sameEntrySet(refreshed.data.entryIds, [te.one.id, te.two.id, te.three.id, te.late.id]));
  assert.equal(refreshed.data.hours, 7.75);
  // A rollback reverses it with the next key.
  const reversed = await odin.claim(PROJECT, { externalInvoiceId: '7', add: [te.four.id], remove: [te.late.id] }, 'invoice-7-claim-3');
  assert.ok(sameEntrySet(reversed.data.entryIds, entryIds));

  // Status sends: submitted, a retried send with a new key, then an older one arriving late.
  const submittedAt = new Date(Date.now() + 1000).toISOString();
  await odin.putInvoice(PROJECT, '7', summary({ status: 'submitted', submittedDate: '2026-11-30', dueDate: '2026-12-30', sourceUpdatedAt: submittedAt }), 'invoice-gen-outbox-3-1');
  await odin.putInvoice(PROJECT, '7', summary({ status: 'submitted', submittedDate: '2026-11-30', dueDate: '2026-12-30', sourceUpdatedAt: submittedAt }), 'invoice-gen-outbox-3-2');
  const late = await odin.putInvoice(PROJECT, '7', summary({ status: 'draft', sourceUpdatedAt: new Date(Date.now() - 60_000).toISOString() }), 'invoice-gen-outbox-4-1');
  assert.equal(late.raw.ignored, true);
  assert.equal(late.data.status, 'submitted');

  // Voiding releases; a later import picks the hours up again.
  const voided = await odin.putInvoice(PROJECT, '7', summary({ status: 'void', sourceUpdatedAt: new Date(Date.now() + 2000).toISOString() }), 'invoice-gen-outbox-5-1');
  assert.equal(voided.raw.released, 4);
  const again = (await odin.getBillableTime(PROJECT, '2026-11-01', '2026-11-30')).data;
  assert.equal(again.totalHours, 8);

  // The orphan sweep and draft deletes: idempotent, never a 404 for something already gone.
  assert.deepEqual((await odin.releaseClaims(PROJECT, '9999', 'invoice-gen-outbox-6-1')).data, { released: 0 });
  await odin.claim(PROJECT, { externalInvoiceId: '9', add: [te.one.id], remove: [] }, 'invoice-9-claim-1');
  assert.deepEqual((await odin.deleteInvoice(PROJECT, '9', 'invoice-gen-outbox-7-1')).data, { deleted: false, released: 1 });
  assert.deepEqual((await odin.deleteInvoice(PROJECT, '9', 'invoice-gen-outbox-7-2')).data, { deleted: false, released: 0 });
  assert.deepEqual((await odin.deleteBillingLink(PROJECT, 'invoice-gen-outbox-8-1')).data, { deleted: true });
  assert.deepEqual((await odin.deleteBillingLink(PROJECT, 'invoice-gen-outbox-8-2')).data, { deleted: false });

  // Replays of a key answer as the first time, with the replay header.
  const replay = await odin.claim(PROJECT, { externalInvoiceId: '7', add: entryIds, remove: [] }, 'invoice-7-claim-1');
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.ok(sameEntrySet(replay.data.entryIds, entryIds));
});

test('contract: the errors invoice-gen reads (module_disabled, allowlist 404, 401 retry, scopes)', async (t) => {
  const fixture = await servedOdin(t);
  const { odin } = fixture;
  await odin.listProjects();

  // A revoked or rotated token: one 401, a new token, and the retry succeeds.
  odin.breakToken();
  const retried = await odin.getBillableTime(PROJECT, '2026-11-01', '2026-11-30');
  assert.equal(retried.data.totalHours, 0);

  // Outside the allowlist.
  const outside = await odin.getBillableTime('project-internal', '2026-11-01', '2026-11-30').then(() => null, (error) => error);
  assert.equal(outside.status, 404);
  assert.equal(outside.message, 'Project not found.');

  // The Consulting module off: invoice-gen's errorFrom reads code module_disabled.
  const current = await fixture.workspaceModulesRepository.getModule({ moduleKey: 'consulting', tenantId: TENANT });
  await fixture.workspaceModulesRepository.setModule({ enabled: false, expectedVersion: current.version, moduleKey: 'consulting', tenantId: TENANT, userId: 'grace' });
  const off = await odin.getBillableTime(PROJECT, '2026-11-01', '2026-11-30').then(() => null, (error) => error);
  assert.equal(off.status, 403);
  assert.equal(off.code, 'module_disabled');
  assert.equal(off.message, 'module_disabled');
});
