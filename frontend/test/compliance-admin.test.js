import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  attestationPayload,
  canExecuteErasure,
  complianceErrorMessage,
  erasureResultSummary,
  exportRangeLabel,
  paginate,
  parseEvidenceRefs,
  policyDraftFrom,
  policyPayload,
  validateAttestationDraft,
  validateDateRange,
  validatePolicyDraft,
} from '../src/lib/admin/compliance.js';
import { accessNoticeMessage, deniedAccessFor } from '../src/lib/auth/access.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const routerSource = read('../src/router/index.js');
const appSource = read('../src/App.vue');
const viewSource = read('../src/views/ComplianceAdminView.vue');
const panelSources = ['Policy', 'Exports', 'LegalHolds', 'Attestations', 'Privacy'].map((name) => [name, read(`../src/components/admin/compliance/Compliance${name}Panel.vue`)]);

test('policy drafts round-trip into the versioned update payload', () => {
  const draft = policyDraftFrom({ auditRetentionDays: 730, dataRegion: 'eu', legalHold: true, privacyDeletionDays: 14, version: 3, wormRetentionDays: 400 });
  assert.deepEqual(policyPayload(draft, 3), { auditRetentionDays: 730, dataRegion: 'eu', expectedVersion: 3, legalHold: true, privacyDeletionDays: 14, wormRetentionDays: 400 });
  assert.deepEqual(validatePolicyDraft(draft), {});
});

test('policy validation mirrors the API ranges', () => {
  const errors = validatePolicyDraft({ auditRetentionDays: 29, dataRegion: 'mars', privacyDeletionDays: 366, wormRetentionDays: 3651 });
  assert.deepEqual(Object.keys(errors).sort(), ['auditRetentionDays', 'dataRegion', 'privacyDeletionDays', 'wormRetentionDays']);
  assert.match(errors.auditRetentionDays, /30 to 3650/);
});

test('date ranges must be complete and ordered', () => {
  assert.deepEqual(validateDateRange('2026-07-10', '2026-07-11'), {});
  assert.match(validateDateRange('2026-07-12', '2026-07-11').end, /on or after/);
  assert.ok(validateDateRange('', '2026-07-11').start);
});

test('attestation drafts validate the control key, statement, and evidence list', () => {
  const draft = { controlKey: 'privacy_rights', evidenceText: 'export-1\n\n  hold-2  \n', periodEnd: '2026-09-30', periodStart: '2026-07-01', statement: 'I reviewed every erasure request this quarter.' };
  assert.deepEqual(validateAttestationDraft(draft), {});
  assert.deepEqual(attestationPayload(draft).evidenceRefs, ['export-1', 'hold-2']);
  const bad = validateAttestationDraft({ controlKey: 'Bad Key', evidenceText: '', periodEnd: '2026-01-01', periodStart: '2026-02-01', statement: 'short' });
  assert.deepEqual(Object.keys(bad).sort(), ['controlKey', 'evidenceText', 'periodEnd', 'statement']);
  assert.equal(parseEvidenceRefs(Array.from({ length: 101 }, (_, index) => `ref-${index}`).join('\n')).length, 101);
});

test('only a different administrator can execute a pending erasure', () => {
  const request = { requestedBy: 'admin-a', status: 'pending' };
  assert.equal(canExecuteErasure(request, 'admin-a'), false);
  assert.equal(canExecuteErasure(request, 'admin-b'), true);
  assert.equal(canExecuteErasure({ ...request, status: 'completed' }, 'admin-b'), false);
  assert.equal(canExecuteErasure(request, ''), false);
});

test('API failures become actionable messages', () => {
  assert.match(complianceErrorMessage({ data: { details: { code: 'compliance_version_conflict' } }, message: 'x', status: 409 }), /changed this record/);
  assert.match(complianceErrorMessage({ message: 'A record-scoped legal hold blocks this change.', status: 423 }), /^Blocked by a legal hold\. A record-scoped/);
  assert.match(complianceErrorMessage({ message: 'Immutable compliance object storage is unavailable.', status: 503 }), /Object Lock/);
  assert.equal(complianceErrorMessage({ message: 'Tenant legal hold blocks privacy erasure.', status: 409 }), 'Tenant legal hold blocks privacy erasure.');
  assert.match(complianceErrorMessage({ data: { details: [{ message: 'Too short.' }] }, message: 'Invalid request payload.', status: 400 }), /Too short/);
});

test('export ranges show the inclusive last day and pagination clamps', () => {
  assert.equal(exportRangeLabel({ endAt: '2026-07-12T00:00:00.000Z', startAt: '2026-07-10T00:00:00.000Z' }), '2026-07-10 to 2026-07-11');
  assert.equal(exportRangeLabel({ endAt: '2026-07-11T00:00:00.000Z', startAt: '2026-07-10T00:00:00.000Z' }), '2026-07-10');
  const state = paginate(Array.from({ length: 30 }, (_, index) => index), 9, 25);
  assert.equal(state.page, 2);
  assert.deepEqual(state.items, [25, 26, 27, 28, 29]);
  assert.equal(erasureResultSummary({ identityPseudonymized: true, memoriesDeleted: 2, projectMembershipsRemoved: 1, sessionsRevoked: 3 }), 'identity pseudonymized, 3 sessions revoked, 1 project memberships removed, 2 memories deleted');
});

test('the compliance area is an admin-only route reachable from the account menu', () => {
  assert.match(routerSource, /path: '\/admin\/compliance\/:section\(policy\|exports\|legal-holds\|attestations\|privacy\)\?'/);
  assert.match(routerSource, /name: 'compliance-admin',\r?\n\s+component: ComplianceAdminView,\r?\n\s+meta: \{ requiresAuth: true, requiredAccess: 'compliance' \}/);
  assert.equal(deniedAccessFor({ requiredAccess: 'compliance' }, { role: 'admin' }), null);
  assert.equal(deniedAccessFor({ requiredAccess: 'compliance' }, { role: 'manager' }), 'compliance');
  assert.match(accessNoticeMessage('compliance'), /workspace admins/);
  assert.match(appSource, /<li v-if="isAdmin">\s*<RouterLink class="dropdown-item" to="\/admin\/compliance">Compliance<\/RouterLink>/);
  assert.match(viewSource, /aria-label="Compliance sections"/);
});

test('compliance panels use the shared dialog and avoid native prompts and title tooltips', () => {
  for (const [name, source] of panelSources) {
    assert.match(source, /<RequirementsDialog/, `${name} uses RequirementsDialog`);
    assert.equal(/window\.(alert|confirm)|\balert\(|\bconfirm\(/.test(source), false, `${name} has no native prompts`);
    // Dialog components take a `title` prop; only native elements would render a tooltip.
    assert.equal(/<[a-z][a-z0-9-]*\s[^>]*\btitle="/.test(source), false, `${name} has no title tooltips`);
    const ids = [...source.matchAll(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
    for (const id of ids) assert.ok(source.includes(`for="${id}"`), `${name} control ${id} has a label`);
  }
});

test('attestations are create-only and erasure needs a typed confirmation', () => {
  const attestations = panelSources.find(([name]) => name === 'Attestations')[1];
  assert.equal(/delete|Edit attestation/i.test(attestations.replace(/cannot be edited or deleted/g, '')), false);
  const privacy = panelSources.find(([name]) => name === 'Privacy')[1];
  assert.match(privacy, /canExecuteErasure\(item, currentUserId\)/);
  assert.match(privacy, /This cannot be undone\./);
  assert.match(privacy, /confirmText\.trim\(\) !== CONFIRM_WORD/);
});
