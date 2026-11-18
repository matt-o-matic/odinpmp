// The invoice-gen connection's Odin side (docs/invoice-gen-connection): the /api/v1 billing routes
// per api-contract.md, the lock on claimed time entries, and the member billing routes.
import assert from 'node:assert/strict';
import test from 'node:test';

import { AGREEMENT, OTHER_PROJECT, PROJECT, TENANT, billingFixture, linkBody } from './helpers/billing-fixture.js';

const P = `/projects/${PROJECT}`;
const NOV = 'from=2026-11-01&to=2026-11-30';

async function switchConsulting(fixture, enabled) {
  const current = await fixture.workspaceModulesRepository.getModule({ moduleKey: 'consulting', tenantId: TENANT });
  await fixture.workspaceModulesRepository.setModule({ enabled, expectedVersion: current.version, moduleKey: 'consulting', tenantId: TENANT, userId: 'grace' });
}

async function mapStories(fixture, assignments, as = 'pat') {
  const response = await fixture.api.put(as, `/api/projects/${PROJECT}/billing/milestones`, { assignments });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

// A project linked to the SOW, stories from both epics mapped, and time on stories, tasks and nothing.
async function linkedProject() {
  const fixture = await billingFixture();
  const app = await fixture.application();
  assert.equal((await app.put(`${P}/billing-link`, linkBody())).status, 200);
  await mapStories(fixture, [
    { milestoneId: 101, storyId: 'story-a1' },
    { milestoneId: 101, storyId: 'story-b1' },
    { milestoneId: 102, storyId: 'story-a2' },
  ]);
  const entries = {
    onStory: await fixture.entry({ hours: 2.5, workDate: '2026-11-03', workItemId: 'story-a1' }),
    onTask: await fixture.entry({ hours: 1.5, workDate: '2026-11-04', workItemId: 'task-a1a' }),
    otherEpicTask: await fixture.entry({ hours: 3, workDate: '2026-11-05', workItemId: 'task-b1a', resource: 'pat' }),
    otherMilestone: await fixture.entry({ hours: 4, workDate: '2026-11-06', workItemId: 'story-a2' }),
    unmapped: await fixture.entry({ hours: 1, workDate: '2026-11-07', workItemId: 'story-b2' }),
    onEpic: await fixture.entry({ hours: 0.5, workDate: '2026-11-08', workItemId: 'epic-a' }),
    noItem: await fixture.entry({ hours: 1, workDate: '2026-11-09' }),
    submitted: await fixture.entry({ hours: 8, status: 'submitted', workItemId: 'story-a1' }),
    notBillable: await fixture.entry({ billable: false, hours: 8, workItemId: 'story-a1' }),
    october: await fixture.entry({ hours: 6, workDate: '2026-10-31', workItemId: 'story-a1' }),
  };
  return { ...fixture, app, entries };
}

test('billing.read and billing.write can be granted to an application; unknown scopes are refused', async () => {
  const { api, application } = await billingFixture();
  const app = await application();
  assert.deepEqual([...app.application.scopes].sort(), ['billing.read', 'billing.write', 'projects.read']);
  const unknown = await api.post('grace', '/api/integrations/oauth-applications', { name: 'Bad', projectIds: [PROJECT], scopes: ['billing.admin'] });
  assert.equal(unknown.status, 400);
});

test('GET /api/v1/projects adds kind, engagementStatus and appUrl, and filters by kind', async () => {
  const fixture = await billingFixture();
  const engagement = await fixture.api.post('mia', '/api/engagements', { customer: 'Initech', name: 'Initech phase 3' });
  assert.equal(engagement.status, 201, JSON.stringify(engagement.body));
  const engagementId = engagement.body.project.id;
  const app = await fixture.application({ projectIds: [PROJECT, engagementId] });

  const all = await app.get('/projects?kind=all');
  assert.equal(all.status, 200);
  const byId = new Map(all.body.data.map((project) => [project.id, project]));
  assert.deepEqual(Object.keys(byId.get(PROJECT)).filter((key) => ['id', 'name', 'kind', 'status', 'engagementStatus', 'appUrl'].includes(key)).sort(), ['appUrl', 'engagementStatus', 'id', 'kind', 'name', 'status']);
  assert.equal(byId.get(PROJECT).kind, 'delivery');
  assert.equal(byId.get(PROJECT).engagementStatus, null);
  assert.equal(byId.get(PROJECT).appUrl, `https://odin.example/app/projects/${PROJECT}`);
  assert.equal(byId.get(engagementId).kind, 'engagement');
  assert.equal(byId.get(engagementId).engagementStatus, 'open');
  assert.equal(all.body.total, 2);
  assert.deepEqual((await app.get('/projects')).body.data.map((project) => project.id).sort(), [PROJECT, engagementId].sort(), 'kind defaults to all');
  assert.deepEqual((await app.get('/projects?kind=delivery')).body.data.map((project) => project.id), [PROJECT]);
  assert.deepEqual((await app.get('/projects?kind=engagement')).body.data.map((project) => project.id), [engagementId]);
  assert.equal((await app.get('/projects?kind=other')).status, 400);

  await switchConsulting(fixture, false);
  assert.deepEqual((await app.get('/projects?kind=all')).body.data.map((project) => project.id), [PROJECT], 'engagements stay out with the module off');
});

test('every billing route checks the allowlist (404), the module (403 module_disabled) and the scope (403)', async () => {
  const fixture = await billingFixture();
  const app = await fixture.application();
  const calls = (projectId) => [
    () => app.get(`/projects/${projectId}/billable-time?${NOV}`),
    () => app.put(`/projects/${projectId}/billing-link`, linkBody()),
    () => app.delete(`/projects/${projectId}/billing-link`),
    () => app.post(`/projects/${projectId}/invoice-claims`, { externalInvoiceId: '77', add: [], remove: [] }),
    () => app.delete(`/projects/${projectId}/invoice-claims/77`),
    () => app.put(`/projects/${projectId}/invoices/77`, { number: 'N-1', status: 'draft', sourceUpdatedAt: '2026-11-30T12:00:00Z' }),
    () => app.delete(`/projects/${projectId}/invoices/77`),
  ];
  for (const projectId of [OTHER_PROJECT, 'project-missing']) {
    for (const call of calls(projectId)) {
      const response = await call();
      assert.equal(response.status, 404, `${response.req.method} ${response.req.path}`);
      assert.equal(response.body.error, 'Project not found.');
    }
  }

  await switchConsulting(fixture, false);
  for (const call of calls(PROJECT)) {
    const response = await call();
    assert.equal(response.status, 403, `${response.req.method} ${response.req.path}`);
    assert.equal(response.body.error, 'module_disabled');
    assert.equal(response.body.code, 'module_disabled');
  }
  await switchConsulting(fixture, true);

  // AC-I08: no billing.write, no write.
  const reader = await fixture.application({ name: 'Reader', scopes: ['projects.read', 'billing.read'] });
  assert.equal((await reader.get(`${P}/billable-time?${NOV}`)).status, 200);
  const writes = [
    () => reader.put(`${P}/billing-link`, linkBody()),
    () => reader.delete(`${P}/billing-link`),
    () => reader.post(`${P}/invoice-claims`, { externalInvoiceId: '77', add: [], remove: [] }),
    () => reader.delete(`${P}/invoice-claims/77`),
    () => reader.put(`${P}/invoices/77`, { status: 'draft', sourceUpdatedAt: '2026-11-30T12:00:00Z' }),
    () => reader.delete(`${P}/invoices/77`),
  ];
  for (const call of writes) {
    const response = await call();
    assert.equal(response.status, 403, `${response.req.method} ${response.req.path}`);
    assert.equal(response.body.code, 'forbidden');
  }
  const noBilling = await fixture.application({ name: 'Projects only', scopes: ['projects.read'] });
  assert.equal((await noBilling.get(`${P}/billable-time?${NOV}`)).status, 403);
  const writerOnly = await fixture.application({ name: 'Writer only', scopes: ['billing.write'] });
  assert.equal((await writerOnly.get(`${P}/billable-time?${NOV}`)).status, 403, 'reading takes billing.read');
});

test('the billing link: upsert, older sends ignored, idempotent delete, change log via api:invoice-gen', async () => {
  const fixture = await billingFixture();
  const app = await fixture.application();
  const first = await app.put(`${P}/billing-link`, linkBody(), 'invoice-gen-outbox-1-1');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.data, { agreement: AGREEMENT, customer: { id: 12, name: 'Initech' }, lineOfBusiness: { id: 3, name: '' }, projectId: PROJECT, sourceUpdatedAt: '2026-11-02T15:00:01.000Z' });

  const older = await app.put(`${P}/billing-link`, linkBody({ agreement: { ...AGREEMENT, status: 'draft' }, sourceUpdatedAt: '2026-11-01T00:00:00Z' }), 'invoice-gen-outbox-2-1');
  assert.equal(older.status, 200);
  assert.equal(older.body.ignored, true);
  assert.equal(older.body.data.agreement.status, 'executed');

  const noSow = await app.put(`${P}/billing-link`, linkBody({ agreement: null, sourceUpdatedAt: '2026-11-03T00:00:00Z' }));
  assert.equal(noSow.body.data.agreement, null, 'a link at client and line-of-business level');

  assert.deepEqual((await app.delete(`${P}/billing-link`, 'invoice-gen-outbox-3-1')).body, { data: { deleted: true } });
  assert.deepEqual((await app.delete(`${P}/billing-link`, 'invoice-gen-outbox-4-1')).body, { data: { deleted: false } });

  const logged = (await fixture.changes()).filter((entry) => entry.entityType === 'billing');
  assert.deepEqual(logged.map((entry) => [entry.action, entry.via]), [['link', 'api:invoice-gen'], ['update', 'api:invoice-gen'], ['unlink', 'api:invoice-gen']]);
  assert.equal(logged[0].actorId, `oauth-application:${app.application.id}`);
});

test('billable time: approved, billable, unclaimed entries in the period, with milestones resolved across epics (AC-I01, AC-I11)', async () => {
  const { app, entries } = await linkedProject();
  const response = await app.get(`${P}/billable-time?${NOV}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { data } = response.body;
  assert.equal(data.projectId, PROJECT);
  assert.equal(data.from, '2026-11-01');
  assert.equal(data.to, '2026-11-30');
  const byId = new Map(data.entries.map((entry) => [entry.id, entry]));
  assert.deepEqual([...byId.keys()].sort(), [entries.onStory, entries.onTask, entries.otherEpicTask, entries.otherMilestone, entries.unmapped, entries.onEpic, entries.noItem].map((entry) => entry.id).sort(),
    'submitted, non-billable and out-of-period entries stay out');

  assert.deepEqual(byId.get(entries.onStory.id), {
    claimedBy: null, hours: 2.5, id: entries.onStory.id, milestoneId: 101, note: 'Logged',
    person: { name: 'Carol Member', resourceId: entries.onStory.resourceId },
    story: { id: 'story-a1', title: 'Discovery workshop' }, workDate: '2026-11-03', workItem: { id: 'story-a1', title: 'Discovery workshop', type: 'story' },
  });
  assert.deepEqual([byId.get(entries.onTask.id).story, byId.get(entries.onTask.id).milestoneId, byId.get(entries.onTask.id).workItem.type], [{ id: 'story-a1', title: 'Discovery workshop' }, 101, 'task'], 'a task bills under its story');
  assert.equal(byId.get(entries.otherEpicTask.id).milestoneId, 101, 'a story from another epic, mapped to the same milestone');
  assert.equal(byId.get(entries.otherEpicTask.id).person.name, 'Pat Doe');
  assert.equal(byId.get(entries.otherMilestone.id).milestoneId, 102);
  assert.equal(byId.get(entries.unmapped.id).milestoneId, null, 'an unmapped story bills to No SOW');
  assert.deepEqual([byId.get(entries.onEpic.id).story, byId.get(entries.onEpic.id).milestoneId], [null, null], 'an epic is no story');
  assert.deepEqual([byId.get(entries.noItem.id).workItem, byId.get(entries.noItem.id).story, byId.get(entries.noItem.id).milestoneId], [null, null, null]);

  assert.deepEqual(data.lines, [
    { hours: 7, milestoneId: 101, stories: [{ hours: 4, id: 'story-a1', title: 'Discovery workshop' }, { hours: 3, id: 'story-b1', title: 'Data model' }] },
    { hours: 4, milestoneId: 102, stories: [{ hours: 4, id: 'story-a2', title: 'Interviews' }] },
    { hours: 2.5, milestoneId: null, stories: [{ hours: 1, id: 'story-b2', title: 'Unmapped work' }, { hours: 1.5, id: null, title: 'No story' }] },
  ]);
  assert.equal(data.totalHours, 13.5);

  assert.equal((await app.get(`${P}/billable-time?from=2026-11-30&to=2026-11-01`)).status, 400);
  assert.equal((await app.get(`${P}/billable-time?from=2026-11-01`)).status, 400);
});

test('claims are all or nothing, report conflicts with the holding invoice, and hold the full set (AC-I02)', async () => {
  const { app, entries, changes } = await linkedProject();
  await app.put(`${P}/invoices/75`, { number: 'NESLLC-20261101-001', status: 'draft', sourceUpdatedAt: '2026-11-10T00:00:00Z' });
  const first = await app.post(`${P}/invoice-claims`, { externalInvoiceId: 75, add: [entries.onStory.id], remove: [] }, 'invoice-75-claim-1');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { data: { entryIds: [entries.onStory.id], externalInvoiceId: '75', hours: 2.5 } });

  const blocked = await app.post(`${P}/invoice-claims`, { externalInvoiceId: '77', add: [entries.onTask.id, entries.onStory.id, entries.submitted.id, entries.notBillable.id, 'te-missing'], remove: [entries.unmapped.id] }, 'invoice-77-claim-1');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'time_entries_claimed');
  assert.equal(blocked.body.error, 'Some time entries are already invoiced.');
  assert.deepEqual(blocked.body.conflicts, [
    { entryId: entries.onStory.id, externalInvoiceId: '75', invoiceNumber: 'NESLLC-20261101-001', reason: 'claimed' },
    { entryId: entries.submitted.id, externalInvoiceId: null, invoiceNumber: null, reason: 'not_approved' },
    { entryId: entries.notBillable.id, externalInvoiceId: null, invoiceNumber: null, reason: 'not_billable' },
    { entryId: 'te-missing', externalInvoiceId: null, invoiceNumber: null, reason: 'not_found' },
    { entryId: entries.unmapped.id, externalInvoiceId: null, invoiceNumber: null, reason: 'not_claimed' },
  ]);
  const after = await app.get(`${P}/billable-time?${NOV}&includeInvoice=77`);
  assert.equal(after.body.data.entries.find((entry) => entry.id === entries.onTask.id).claimedBy, null, 'nothing was claimed');

  const claimed = await app.post(`${P}/invoice-claims`, { externalInvoiceId: '77', add: [entries.onTask.id, entries.otherEpicTask.id], remove: [] }, 'invoice-77-claim-2');
  assert.deepEqual(claimed.body.data, { entryIds: [entries.onTask.id, entries.otherEpicTask.id], externalInvoiceId: '77', hours: 4.5 });
  const again = await app.post(`${P}/invoice-claims`, { externalInvoiceId: '77', add: [entries.onTask.id, entries.otherMilestone.id], remove: [entries.otherEpicTask.id] }, 'invoice-77-claim-3');
  assert.equal(again.status, 200, 'an entry this invoice already holds can be added again');
  assert.deepEqual(again.body.data, { entryIds: [entries.onTask.id, entries.otherMilestone.id], externalInvoiceId: '77', hours: 5.5 });

  // Another invoice cannot take them; the claimed ones leave billable time.
  const unclaimed = (await app.get(`${P}/billable-time?${NOV}`)).body.data.entries.map((entry) => entry.id);
  assert.equal(unclaimed.includes(entries.onTask.id), false);
  assert.equal(unclaimed.includes(entries.otherEpicTask.id), true, 'removed entries are billable again');
  assert.ok((await changes()).some((entry) => entry.entityType === 'billing' && entry.action === 'claim' && entry.via === 'api:invoice-gen'));
});

test('includeInvoice returns the entries the invoice holds whatever their date, marked claimedBy, with milestones as they stand', async () => {
  const fixture = await linkedProject();
  const { app, entries } = fixture;
  await app.post(`${P}/invoice-claims`, { externalInvoiceId: '77', add: [entries.october.id, entries.onTask.id], remove: [] });
  await app.post(`${P}/invoice-claims`, { externalInvoiceId: '78', add: [entries.onStory.id], remove: [] });
  await mapStories(fixture, [{ milestoneId: 102, storyId: 'story-a1' }]);
  const response = await app.get(`${P}/billable-time?${NOV}&includeInvoice=77`);
  const byId = new Map(response.body.data.entries.map((entry) => [entry.id, entry]));
  assert.equal(byId.get(entries.october.id).claimedBy, '77', 'held by the invoice, though outside the period');
  assert.equal(byId.get(entries.onTask.id).claimedBy, '77');
  assert.equal(byId.get(entries.onTask.id).milestoneId, 102, 'a changed mapping shows on re-import');
  assert.equal(byId.has(entries.onStory.id), false, 'another invoice\'s entries stay out');
  assert.equal(byId.get(entries.unmapped.id).claimedBy, null);
});

test('invoice summaries: upsert, older ignored, void releases claims, delete releases and is idempotent (AC-I04, AC-I05)', async () => {
  const { app, api, entries } = await linkedProject();
  const summary = { number: 'NESLLC-20261130-001', status: 'draft', overdue: false, issueDate: '2026-11-30', submittedDate: null, dueDate: null, paidDate: null, hours: 4, totalCents: 60000, currency: 'USD', url: 'https://invoices.example/invoices/77', sourceUpdatedAt: '2026-11-30T12:00:00Z' };
  await app.post(`${P}/invoice-claims`, { externalInvoiceId: '77', add: [entries.onStory.id, entries.onTask.id], remove: [] }, 'invoice-77-claim-1');
  const created = await app.put(`${P}/invoices/77`, summary, 'invoice-gen-outbox-9-1');
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.data.number, 'NESLLC-20261130-001');
  assert.equal(created.body.released, 0);

  const submitted = await app.put(`${P}/invoices/77`, { ...summary, status: 'submitted', submittedDate: '2026-12-01', dueDate: '2026-12-31', sourceUpdatedAt: '2026-12-01T09:00:00Z' });
  assert.equal(submitted.body.data.status, 'submitted');
  const stale = await app.put(`${P}/invoices/77`, { ...summary, status: 'draft', sourceUpdatedAt: '2026-11-30T13:00:00Z' });
  assert.equal(stale.body.ignored, true, 'an older send does not overwrite a newer status');
  assert.equal(stale.body.data.status, 'submitted');
  const repeat = await app.put(`${P}/invoices/77`, { ...summary, status: 'submitted', submittedDate: '2026-12-01', dueDate: '2026-12-31', sourceUpdatedAt: '2026-12-01T09:00:00Z' });
  assert.equal(repeat.body.data.status, 'submitted', 'a repeated send changes nothing');

  // The claimed entries show the invoice number.
  const finance = await api.get('mia', `/api/resource-planning?projectId=${PROJECT}`);
  const shown = finance.body.timeEntries.find((entry) => entry.id === entries.onStory.id);
  assert.deepEqual(shown.invoice, { draft: false, number: 'NESLLC-20261130-001', status: 'submitted', url: 'https://invoices.example/invoices/77' });
  assert.equal(shown.invoiced, true);

  const voided = await app.put(`${P}/invoices/77`, { ...summary, status: 'void', sourceUpdatedAt: '2026-12-02T09:00:00Z' });
  assert.equal(voided.body.released, 2, 'void releases the claims in the same write');
  const again = (await app.get(`${P}/billable-time?${NOV}`)).body.data.entries.map((entry) => entry.id);
  assert.ok(again.includes(entries.onStory.id) && again.includes(entries.onTask.id), 'a later import picks them up');

  await app.post(`${P}/invoice-claims`, { externalInvoiceId: '80', add: [entries.onStory.id], remove: [] });
  await app.put(`${P}/invoices/80`, { ...summary, number: 'D-80', sourceUpdatedAt: '2026-12-03T00:00:00Z' });
  assert.deepEqual((await app.delete(`${P}/invoices/80`)).body, { data: { deleted: true, released: 1 } });
  assert.deepEqual((await app.delete(`${P}/invoices/80`)).body, { data: { deleted: false, released: 0 } });
  assert.deepEqual((await app.delete(`${P}/invoices/never`)).body, { data: { deleted: false, released: 0 } });

  await app.post(`${P}/invoice-claims`, { externalInvoiceId: '81', add: [entries.onStory.id, entries.onTask.id], remove: [] });
  assert.deepEqual((await app.delete(`${P}/invoice-claims/81`)).body, { data: { released: 2 } });
  assert.deepEqual((await app.delete(`${P}/invoice-claims/81`)).body, { data: { released: 0 } }, 'releasing nothing is not a 404');
});

test('Idempotency-Key: a replay returns the first response; a reused key with another body is refused', async () => {
  const { app, entries } = await linkedProject();
  const body = { externalInvoiceId: '77', add: [entries.onStory.id], remove: [] };
  const first = await app.post(`${P}/invoice-claims`, body, 'invoice-77-claim-1');
  await app.delete(`${P}/invoice-claims/77`, 'invoice-77-release-1');
  const replay = await app.post(`${P}/invoice-claims`, body, 'invoice-77-claim-1');
  assert.equal(replay.status, 200);
  assert.equal(replay.headers['idempotency-replayed'], 'true');
  assert.deepEqual(replay.body, first.body);
  assert.equal((await app.get(`${P}/billable-time?${NOV}&includeInvoice=77`)).body.data.entries.find((entry) => entry.id === entries.onStory.id).claimedBy, null, 'a replay does not claim again');

  const conflict = await app.post(`${P}/invoice-claims`, { ...body, add: [entries.onTask.id] }, 'invoice-77-claim-1');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'idempotency_key_reused');

  // A 409 for claimed entries is kept and replayed too.
  await app.post(`${P}/invoice-claims`, { externalInvoiceId: '78', add: [entries.onTask.id], remove: [] }, 'invoice-78-claim-1');
  const refused = await app.post(`${P}/invoice-claims`, { externalInvoiceId: '79', add: [entries.onTask.id], remove: [] }, 'invoice-79-claim-1');
  assert.equal(refused.status, 409);
  await app.delete(`${P}/invoice-claims/78`);
  const refusedAgain = await app.post(`${P}/invoice-claims`, { externalInvoiceId: '79', add: [entries.onTask.id], remove: [] }, 'invoice-79-claim-1');
  assert.equal(refusedAgain.status, 409);
  assert.equal(refusedAgain.headers['idempotency-replayed'], 'true');
  assert.equal((await app.put(`${P}/billing-link`, linkBody(), 'bad key!')).status, 400);
});

test('a claimed time entry is locked on every edit and delete path, for everyone (AC-I03)', async () => {
  const fixture = await linkedProject();
  const { api, app, entries, resourceFinanceRepository } = fixture;
  // carol's own submitted entry, approved by a manager and then claimed.
  const own = await fixture.entry({ hours: 2, status: 'submitted', workItemId: 'story-a1' });
  const approved = await api.patch('mia', `/api/resource-planning/projects/${PROJECT}/time-entries/${own.id}`, { expectedVersion: own.version, status: 'approved' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  await app.post(`${P}/invoice-claims`, { externalInvoiceId: '77', add: [own.id, entries.onStory.id], remove: [] });
  const version = approved.body.value.version;
  const locked = (response, label) => {
    assert.equal(response.status, 409, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.details.code, 'time_entry_invoiced', label);
  };

  // The app's finance screen (workspace managers) and the project routes MCP and the assistant call.
  locked(await api.patch('mia', `/api/resource-planning/time-entries/${own.id}`, { expectedVersion: version, hours: 3 }), 'finance edit');
  locked(await api.patch('mia', `/api/resource-planning/time-entries/${own.id}`, { expectedVersion: version, status: 'rejected' }), 'timesheet rejection');
  locked(await api.patch('grace', `/api/resource-planning/time-entries/${own.id}`, { expectedVersion: version, billable: false }), 'billable flag');
  locked(await api.delete('grace', `/api/resource-planning/time-entries/${own.id}`, { expectedVersion: version }), 'finance delete');
  locked(await api.patch('mia', `/api/resource-planning/projects/${PROJECT}/time-entries/${own.id}`, { expectedVersion: version, workDate: '2026-11-12' }), 'project edit');
  locked(await api.delete('mia', `/api/resource-planning/projects/${PROJECT}/time-entries/${own.id}`, { expectedVersion: version }), 'project delete');
  // A task access link deletes through the repository with ownSubmitted.
  await assert.rejects(
    () => resourceFinanceRepository.deleteTimeEntry({ expectedVersion: version, ownSubmitted: { resourceId: own.resourceId }, tenantId: TENANT, timeEntryId: own.id }),
    (error) => error.details?.code === 'time_entry_invoiced',
  );

  // Released, it can change again.
  await app.put(`${P}/invoices/77`, { number: 'N-77', status: 'void', sourceUpdatedAt: '2026-12-01T00:00:00Z' });
  const edited = await api.patch('mia', `/api/resource-planning/time-entries/${own.id}`, { expectedVersion: version, hours: 3 });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
});

test('merging two profiles of one person still moves time an invoice holds', async () => {
  const fixture = await linkedProject();
  const { api, app, entries, resourceFinanceRepository } = fixture;
  await app.post(`${P}/invoice-claims`, { externalInvoiceId: '77', add: [entries.onStory.id], remove: [] });
  // A profile without a login, linked to carol's login: carol's profile (with the claimed time)
  // folds into it, and her time moves across.
  const twin = await resourceFinanceRepository.createResource({ input: { billRate: 0, capacityHoursPerWeek: 40, costRate: 0, currency: 'USD', email: null, location: '', name: 'Carol M', poolId: null, roles: [], skills: [], status: 'active', userId: null }, tenantId: TENANT });
  const merged = await api.patch('grace', `/api/resource-planning/resources/${twin.id}`, { expectedVersion: twin.version, userId: 'carol' });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  const snapshot = await resourceFinanceRepository.listSnapshot({ tenantId: TENANT });
  assert.equal(snapshot.resources.some((record) => record.id === entries.onStory.resourceId), false, 'the old profile is gone');
  const moved = snapshot.timeEntries.find((entry) => entry.id === entries.onStory.id);
  assert.equal(moved.resourceId, twin.id);
  assert.ok(moved.invoiceClaimId, 'still claimed');
  assert.equal(moved.hours, 2.5);
});

test('member billing routes: finance-visible people read, managers change, everyone else is refused', async () => {
  const fixture = await linkedProject();
  const { api, app, entries } = fixture;
  for (const id of ['grace', 'mia', 'pat']) assert.equal((await api.get(id, `/api/projects/${PROJECT}/billing`)).status, 200, id);
  for (const id of ['carol', 'dan']) {
    const refused = await api.get(id, `/api/projects/${PROJECT}/billing`);
    assert.equal(refused.status, 403, id);
    assert.equal(refused.body.details.code, 'billing_not_allowed');
    const write = await api.put(id, `/api/projects/${PROJECT}/billing/milestones`, { assignments: [{ milestoneId: 102, storyId: 'story-b2' }] });
    assert.equal(write.status, 403, `${id} cannot change the mapping`);
    assert.equal((await api.get(id, `/api/projects/${PROJECT}/billing/milestones`)).status, 403);
  }
  assert.equal((await api.get('oscar', `/api/projects/${PROJECT}/billing`)).status, 404);
  assert.equal((await api.get('pat', `/api/projects/project-missing/billing`)).status, 404);

  // A story holds one milestone: assigning another moves it.
  const moved = await mapStories(fixture, [{ milestoneId: 102, storyId: 'story-b1' }, { milestoneId: null, storyId: 'story-a2' }], 'mia');
  assert.deepEqual(moved.changed, [{ from: 101, storyId: 'story-b1', to: 102 }, { from: 102, storyId: 'story-a2', to: null }]);
  assert.deepEqual(moved.stories.map((story) => [story.id, story.milestoneId, story.epicTitle]), [
    ['story-a1', 101, 'Discovery'], ['story-a2', null, 'Discovery'], ['story-b1', 102, 'Build'], ['story-b2', null, 'Build'],
  ]);
  assert.deepEqual(moved.milestones, [{ hours: 40, id: 101, name: 'Discovery', shortLabel: 'Disc' }, { hours: 80, id: 102, name: 'Build', shortLabel: 'Build' }]);
  const bad = await api.put('pat', `/api/projects/${PROJECT}/billing/milestones`, { assignments: [{ milestoneId: 999, storyId: 'story-b1' }, { milestoneId: 101, storyId: 'task-a1a' }, { milestoneId: 101, storyId: 'story-a1' }, { milestoneId: 102, storyId: 'story-a1' }] });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.details.problems.map((problem) => problem.code), ['milestone_not_found', 'story_not_found', 'duplicate_story']);
  const changeLog = (await fixture.changes()).filter((entry) => entry.entityType === 'billing' && entry.detail?.kind === 'story_milestone');
  assert.ok(changeLog.some((entry) => entry.itemId === 'story-b1' && entry.via === 'app' && entry.actorId === 'mia'));

  // The panel's numbers.
  await app.post(`${P}/invoice-claims`, { externalInvoiceId: '70', add: [entries.onStory.id], remove: [] });
  await app.put(`${P}/invoices/70`, { number: 'NESLLC-1', status: 'submitted', overdue: true, dueDate: '2026-11-20', hours: 2.5, totalCents: 37500, currency: 'USD', url: 'https://invoices.example/invoices/70', sourceUpdatedAt: '2026-11-21T00:00:00Z' });
  await app.post(`${P}/invoice-claims`, { externalInvoiceId: '71', add: [entries.onTask.id], remove: [] });
  await app.put(`${P}/invoices/71`, { number: '', status: 'draft', hours: 1.5, url: 'https://invoices.example/invoices/71', sourceUpdatedAt: '2026-11-22T00:00:00Z' });
  const billing = (await api.get('pat', `/api/projects/${PROJECT}/billing`)).body;
  assert.equal(billing.link.agreement.title, 'Initech phase 2');
  assert.equal(billing.invoiceGenUrl, 'https://invoices.example');
  assert.ok(billing.heardAt);
  assert.deepEqual(billing.milestones.map(({ approvedUnclaimedHours, billedHours, budgetHours, claimedUnbilledHours, id, storyCount }) => ({ approvedUnclaimedHours, billedHours, budgetHours, claimedUnbilledHours, id, storyCount })), [
    // October's 6 hours on story-a1 count: the panel spans all time, not one period.
    { approvedUnclaimedHours: 6, billedHours: 2.5, budgetHours: 40, claimedUnbilledHours: 1.5, id: 101, storyCount: 1 },
    { approvedUnclaimedHours: 3, billedHours: 0, budgetHours: 80, claimedUnbilledHours: 0, id: 102, storyCount: 1 },
  ]);
  assert.deepEqual(billing.noSow, { approvedUnclaimedHours: 6.5, billedHours: 0, claimedUnbilledHours: 0 });
  assert.deepEqual(billing.invoices.map((invoice) => [invoice.externalInvoiceId, invoice.status, invoice.overdue]), [['71', 'draft', false], ['70', 'submitted', true]]);

  // Time entries name their invoice; people outside finance see the number but not the link.
  const own = (await api.get('carol', `/api/resource-planning?projectId=${PROJECT}`)).body.timeEntries;
  assert.deepEqual(own.find((entry) => entry.id === entries.onStory.id).invoice, { draft: false, number: 'NESLLC-1', status: 'submitted' });
  assert.deepEqual(own.find((entry) => entry.id === entries.onTask.id).invoice, { draft: true, number: null, status: 'draft' });
  const listed = (await api.get('mia', `/api/resource-planning/time-entries?projectId=${PROJECT}`)).body.entries;
  assert.equal(listed.find((entry) => entry.id === entries.onStory.id).invoiced, true);

  await switchConsulting(fixture, false);
  const off = await api.get('pat', `/api/projects/${PROJECT}/billing`);
  assert.equal(off.status, 403);
  assert.equal(off.body.details.code, 'module_disabled');
});

test('the milestone mapping needs a SOW', async () => {
  const fixture = await billingFixture();
  const response = await fixture.api.put('pat', `/api/projects/${PROJECT}/billing/milestones`, { assignments: [{ milestoneId: 101, storyId: 'story-a1' }] });
  assert.equal(response.status, 409);
  assert.equal(response.body.details.code, 'billing_not_linked');
  const billing = await fixture.api.get('pat', `/api/projects/${PROJECT}/billing`);
  assert.equal(billing.status, 200);
  assert.equal(billing.body.link, null);
  assert.deepEqual(billing.body.milestones, []);
  assert.equal(billing.body.heardAt, null);
});
