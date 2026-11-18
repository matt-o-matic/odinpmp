// The billing tools and the claimed-entry lock through MCP and the assistant (AC-I03, AC-I11). The
// tools run against Odin's real routes over HTTP, signed in as a person, as the assistant runs.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createOdinApiClient } from '../src/mcp/api-client.js';
import { createOdinToolCatalog } from '../src/mcp/catalog.js';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';
import { KEYWORD_GROUPS } from '../src/lib/agent/agent-tools.js';
import { PROJECT, billingFixture, linkBody } from './helpers/billing-fixture.js';

async function served(t) {
  const fixture = await billingFixture();
  const server = await new Promise((resolve) => { const listening = fixture.app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const toolsFor = (userId) => {
    const api = createOdinApiClient({ baseUrl: origin, token: fixture.tokens.get(userId) });
    const catalog = new Map(createOdinToolCatalog({ api, extended: true }).map((entry) => [entry.name, entry]));
    return (name, args) => catalog.get(name).handler(catalog.get(name).schema.parse(args));
  };
  const app = await fixture.application();
  assert.equal((await app.put(`/projects/${PROJECT}/billing-link`, linkBody())).status, 200);
  return { ...fixture, invoiceGen: app, toolsFor };
}

test('MCP and the assistant cannot change or delete a claimed time entry (AC-I03)', async (t) => {
  const fixture = await served(t);
  const entry = await fixture.entry({ hours: 2, workItemId: 'story-a1' });
  await fixture.invoiceGen.post(`/projects/${PROJECT}/invoice-claims`, { externalInvoiceId: '77', add: [entry.id], remove: [] });
  const asMia = fixture.toolsFor('mia');
  const listed = await asMia('odin_list_time_entries', { projectId: PROJECT });
  const shown = listed.entries.find((row) => row.id === entry.id);
  assert.equal(shown.invoiced, true);
  assert.deepEqual(shown.invoice, { draft: true, number: null, status: 'draft', url: null });

  await assert.rejects(asMia('odin_update_time_entry', { projectId: PROJECT, timeEntryId: entry.id, input: { expectedVersion: entry.version, hours: 3 } }), { code: 'time_entry_invoiced', status: 409 });
  await assert.rejects(asMia('odin_update_time_entry', { projectId: PROJECT, timeEntryId: entry.id, input: { expectedVersion: entry.version, status: 'rejected' } }), { code: 'time_entry_invoiced', status: 409 });
  await assert.rejects(asMia('odin_delete_time_entry', { projectId: PROJECT, timeEntryId: entry.id, expectedVersion: entry.version }), { code: 'time_entry_invoiced', status: 409 });
});

test('the billing tools follow finance visibility, and only managers set story milestones (AC-I11)', async (t) => {
  const fixture = await served(t);
  const asPat = fixture.toolsFor('pat');
  const preview = await asPat('odin_set_story_milestones', { projectId: PROJECT, assignments: [{ storyId: 'story-a1', milestoneId: 101 }], dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.request, { method: 'PUT', path: `/api/projects/${PROJECT}/billing/milestones`, body: { assignments: [{ storyId: 'story-a1', milestoneId: 101 }] } });

  let billing = await asPat('odin_get_project_billing', { projectId: PROJECT });
  assert.equal(billing.stories.find((story) => story.id === 'story-a1').milestoneId, null, 'a dry run changes nothing');

  const set = await asPat('odin_set_story_milestones', { projectId: PROJECT, assignments: [{ storyId: 'story-a1', milestoneId: 101 }, { storyId: 'story-b1', milestoneId: 101 }] });
  assert.deepEqual(set.changed.map((row) => [row.storyId, row.to]), [['story-a1', 101], ['story-b1', 101]]);
  billing = await asPat('odin_get_project_billing', { projectId: PROJECT });
  assert.equal(billing.link.agreement.id, 41);
  assert.deepEqual(billing.milestones.map((milestone) => [milestone.id, milestone.storyCount]), [[101, 2], [102, 0]]);
  const viaAssistant = (await fixture.changes()).filter((entry) => entry.entityType === 'billing' && entry.detail?.kind === 'story_milestone');
  assert.ok(viaAssistant.length >= 2);

  // A contributor edits the plan but cannot see billing or change the mapping; a member neither.
  for (const id of ['dan', 'carol']) {
    const tools = fixture.toolsFor(id);
    await assert.rejects(tools('odin_get_project_billing', { projectId: PROJECT }), { code: 'billing_not_allowed', status: 403 });
    await assert.rejects(tools('odin_set_story_milestones', { projectId: PROJECT, assignments: [{ storyId: 'story-b2', milestoneId: 102 }] }), (error) => ['billing_not_allowed', 'needs_project_manager'].includes(error.code));
  }
  const mapping = await fixture.billingRepository.listStoryMilestones({ projectId: PROJECT, tenantId: 'tenant-northwind' });
  assert.equal(mapping.some((row) => row.storyId === 'story-b2'), false);
});

test('MCP grants reach the billing routes like other project routes, and no claim route', () => {
  const allow = (method, originalUrl, grant) => {
    try { requireMcpRouteAccess({ body: {}, method, originalUrl }, grant); return 'allowed'; } catch (error) { return `${error.statusCode}`; }
  };
  const all = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
  const readOnly = { projectIds: [], scopes: ['projects.read'] };
  const elsewhere = { projectIds: ['project-2'], scopes: ['projects.read', 'projects.write'] };
  assert.equal(allow('GET', `/api/projects/${PROJECT}/billing`, readOnly), 'allowed');
  assert.equal(allow('GET', `/api/projects/${PROJECT}/billing/milestones`, readOnly), 'allowed');
  assert.equal(allow('PUT', `/api/projects/${PROJECT}/billing/milestones`, all), 'allowed');
  assert.equal(allow('PUT', `/api/projects/${PROJECT}/billing/milestones`, readOnly), '403');
  assert.equal(allow('GET', `/api/projects/${PROJECT}/billing`, elsewhere), '404');
  assert.equal(allow('POST', `/api/v1/projects/${PROJECT}/invoice-claims`, all), '403');
  assert.equal(allow('PUT', `/api/projects/${PROJECT}/billing`, all), '403');
});

test('the assistant offers the billing tools for billing words, ahead of files and governance milestones', () => {
  const offered = (text) => KEYWORD_GROUPS.filter((group) => group.pattern.test(text)).flatMap((group) => group.operations);
  for (const text of ['Which stories bill to the Discovery milestone?', 'Show the invoices for this project', 'How many unbilled hours are left on the SOW milestones?']) {
    assert.equal(offered(text)[0], 'odin_get_project_billing', text);
  }
});
