import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  addTicketConfigDraftRow,
  buildTicketConfigPayload,
  createTicketConfigDraft,
  filterTicketConfigEntries,
  moveTicketConfigDraftRow,
  removeNewTicketConfigDraftRow,
  setTicketConfigDraftStatus,
  ticketConfigDraftChanged,
  validateTicketConfigDraft,
} from '../src/lib/admin/ticket-config-draft.js';
import { deniedAccessFor } from '../src/lib/auth/access.js';
import { ticketConfigChoices, ticketConfigName, ticketReferencePatch } from '../src/lib/projects/ticket-config-options.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const routerSource = read('../src/router/index.js');
const appSource = read('../src/App.vue');
const viewSource = read('../src/views/TicketConfigAdminView.vue');
const panelSource = read('../src/components/projects/ProjectTicketsPanel.vue');
const ticketsViewSource = read('../src/views/TicketsView.vue');

const entries = [
  { id: 'env-prod', name: 'Production', projectId: null, sortOrder: 2, status: 'active', version: 1 },
  { id: 'env-dev', name: 'Development', projectId: null, sortOrder: 0, status: 'active', version: 1 },
  { id: 'env-uat', name: 'UAT', projectId: 'project-a', sortOrder: 1, status: 'inactive', version: 2 },
];

test('the draft keeps saved order and the payload renumbers it with the loaded revision', () => {
  let rows = createTicketConfigDraft(entries);
  assert.deepEqual(rows.map((row) => row.id), ['env-dev', 'env-uat', 'env-prod']);
  rows = moveTicketConfigDraftRow(rows, 'env-prod', -1);
  rows = setTicketConfigDraftStatus(rows, 'env-uat', 'active');
  rows = addTicketConfigDraftRow(rows, { projectId: 'project-a' });
  rows[3].name = '  Hotfix  ';
  const payload = buildTicketConfigPayload(rows, 'rev-1');
  assert.deepEqual(payload, {
    entries: [
      { id: 'env-dev', name: 'Development', projectId: null, sortOrder: 0, status: 'active' },
      { id: 'env-prod', name: 'Production', projectId: null, sortOrder: 1, status: 'active' },
      { id: 'env-uat', name: 'UAT', projectId: 'project-a', sortOrder: 2, status: 'active' },
      { name: 'Hotfix', projectId: 'project-a', sortOrder: 3, status: 'active' },
    ],
    expectedRevision: 'rev-1',
  });
  assert.equal(ticketConfigDraftChanged(rows, entries), true);
  assert.equal(ticketConfigDraftChanged(createTicketConfigDraft(entries), entries), false);
});

test('only unsaved rows can be removed; saved rows are deactivated instead', () => {
  let rows = addTicketConfigDraftRow(createTicketConfigDraft(entries));
  const added = rows.at(-1).key;
  assert.equal(removeNewTicketConfigDraftRow(rows, 'env-dev').length, rows.length);
  rows = removeNewTicketConfigDraftRow(rows, added);
  assert.equal(rows.length, entries.length);
  assert.equal(moveTicketConfigDraftRow(rows, 'env-dev', -1), rows, 'the first row cannot move up');
});

test('names are required and unique within a scope', () => {
  const rows = [
    { key: 'a', name: 'Staging', projectId: '' },
    { key: 'b', name: 'staging', projectId: '' },
    { key: 'c', name: 'Staging', projectId: 'project-a' },
    { key: 'd', name: '   ', projectId: '' },
  ];
  const errors = validateTicketConfigDraft(rows);
  assert.deepEqual(Object.keys(errors).sort(), ['a', 'b', 'd']);
  assert.match(errors.d, /Enter a name/);
});

test('the read-only list filters by text, scope, and status', () => {
  assert.deepEqual(filterTicketConfigEntries(entries).map((entry) => entry.id), ['env-dev', 'env-prod']);
  assert.deepEqual(filterTicketConfigEntries(entries, { status: 'all', scope: 'project-a' }).map((entry) => entry.id), ['env-uat']);
  assert.deepEqual(filterTicketConfigEntries(entries, { status: 'all', scope: 'tenant', query: 'prod' }).map((entry) => entry.id), ['env-prod']);
});

test('pickers offer active entries and keep an inactive current value labelled', () => {
  assert.deepEqual(ticketConfigChoices(entries).map((choice) => choice.id), ['env-prod', 'env-dev']);
  assert.deepEqual(ticketConfigChoices(entries, 'env-uat').at(-1), { id: 'env-uat', label: 'UAT (inactive)' });
  assert.equal(ticketConfigName(entries, 'env-uat'), 'UAT (inactive)');
  assert.equal(ticketConfigName(entries, 'missing'), 'Unavailable entry');
  assert.equal(ticketConfigName(entries, null), '—');
});

test('reference edits patch only the fields that changed', () => {
  const ticket = { environmentId: 'env-uat', fixedInReleaseId: null, foundInReleaseId: 'rel-1' };
  assert.deepEqual(ticketReferencePatch(ticket, { environmentId: 'env-uat', fixedInReleaseId: 'rel-2', foundInReleaseId: 'rel-1' }), { fixedInReleaseId: 'rel-2' });
  assert.deepEqual(ticketReferencePatch(ticket, { environmentId: '', fixedInReleaseId: '', foundInReleaseId: 'rel-1' }), { environmentId: null });
});

test('the ticket list screen is admin-only, read-only by default, and saves with the revision', () => {
  assert.match(routerSource, /path: '\/admin\/ticketing\/:kind\(environments\|releases\)\?'/);
  assert.match(routerSource, /name: 'ticket-config-admin',\r?\n\s+component: TicketConfigAdminView,\r?\n\s+meta: \{ requiresAuth: true, requiredAccess: 'ticketConfig' \}/);
  assert.equal(deniedAccessFor({ requiredAccess: 'ticketConfig' }, { role: 'user' }), 'ticketConfig');
  assert.equal(deniedAccessFor({ requiredAccess: 'ticketConfig' }, { role: 'admin' }), null);
  assert.match(appSource, /to="\/admin\/ticketing"/);
  assert.match(viewSource, /Edit list/);
  assert.match(viewSource, /buildTicketConfigPayload\(rows\.value, revision\.value\)/);
  assert.match(viewSource, /onBeforeRouteLeave\(confirmNavigation\)/);
  assert.equal(/window\.(alert|confirm)|<[a-z][a-z0-9-]*\s[^>]*\btitle="/.test(viewSource), false);
  const ids = [...viewSource.matchAll(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
  for (const id of ids) assert.ok(viewSource.includes(`for="${id}"`), `control ${id} has a label`);
});

test('ticket surfaces read the project-scoped config for pickers and names', () => {
  assert.match(panelSource, /getProjectTicketConfig\(props\.projectId/);
  assert.match(panelSource, /id="new-ticket-environment"/);
  assert.match(panelSource, /id="ticket-ref-fixed-in"/);
  assert.match(panelSource, /ticketReferencePatch\(ticket, referenceDraft\)/);
  assert.match(ticketsViewSource, /getProjectTicketConfig\(ticket\.projectId/);
});
