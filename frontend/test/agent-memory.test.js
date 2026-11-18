import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MEMORY_PAGE_SIZE,
  PERSONAL_SCOPE,
  buildCorrectionPayload,
  buildGovernancePayload,
  buildMemoryBrowseQuery,
  buildNewMemoryPayload,
  confidenceLabel,
  createGovernanceForm,
  createMemoryFilterState,
  createMemoryForm,
  memoryChangeBlockedReason,
  memoryErrorMessage,
  memoryFiltersToRouteQuery,
  memorySourceLabel,
  pageSummary,
  safeSourceUrl,
  validateMemoryForm,
} from '../src/lib/memory/agent-memory.js';

const viewSource = readFileSync(new URL('../src/views/AgentMemoryView.vue', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('../src/components/memory/AgentMemoryEditorDialog.vue', import.meta.url), 'utf8');
const governanceSource = readFileSync(new URL('../src/components/memory/AgentMemoryGovernanceDialog.vue', import.meta.url), 'utf8');
const workspaceSource = readFileSync(new URL('../src/components/assistant/AssistantWorkspace.vue', import.meta.url), 'utf8');

const memory = {
  canForget: true, content: 'Ship on Tuesdays.', id: 'memory-1', legalHold: false, memoryType: 'decision', projectId: 'project-1',
  provenance: { sourceType: 'person' }, sensitivity: 'internal', title: 'Release day', version: 3,
};

test('filters round-trip through the route query and ignore unknown values', () => {
  const filters = createMemoryFilterState({ page: '3', project: 'project-1', q: ' vendor ', sensitivity: 'secret', sort: 'oldest', type: 'risk' });
  assert.deepEqual(filters, { page: 3, project: 'project-1', query: 'vendor', sensitivity: '', sort: 'oldest', type: 'risk' });
  assert.deepEqual(memoryFiltersToRouteQuery(filters), { page: '3', project: 'project-1', q: 'vendor', sort: 'oldest', type: 'risk' });
  assert.deepEqual(memoryFiltersToRouteQuery(createMemoryFilterState({})), {});
  assert.deepEqual(createMemoryFilterState({ page: '-2', sort: 'random' }), { page: 1, project: '', query: '', sensitivity: '', sort: 'newest', type: '' });
});

test('the browse query pages by offset and sends single-value filters as lists', () => {
  assert.deepEqual(buildMemoryBrowseQuery({ page: 2, project: PERSONAL_SCOPE, query: ' tuesday ', sensitivity: 'restricted', sort: 'confidence', type: 'fact' }), {
    limit: MEMORY_PAGE_SIZE, offset: MEMORY_PAGE_SIZE, project: 'personal', query: 'tuesday', sensitivities: ['restricted'], sort: 'confidence', types: ['fact'],
  });
  assert.equal(pageSummary({ count: 25, offset: 25, total: 60 }), 'Showing 26–50 of 60');
  assert.equal(pageSummary({ count: 0, offset: 0, total: 0 }), 'No memories');
});

test('labels describe sources, confidence and blocked actions in plain words', () => {
  assert.equal(memorySourceLabel({ provenance: { sourceType: 'approved_assistant_run' } }), 'Changes applied in the AI Workspace');
  assert.equal(memorySourceLabel({ provenance: { sourceType: 'decision_register' } }), 'Decision register');
  assert.equal(memorySourceLabel({}), 'Unknown source');
  assert.equal(safeSourceUrl({ provenance: { sourceUrl: 'javascript:alert(1)' } }), '');
  assert.equal(safeSourceUrl({ provenance: { sourceUrl: 'https://example.com/decision' } }), 'https://example.com/decision');
  assert.equal(confidenceLabel(0.875), '88%');
  assert.match(memoryChangeBlockedReason({ ...memory, canForget: false, legalHold: true }), /legal hold/);
  assert.match(memoryChangeBlockedReason({ ...memory, canForget: false }), /project editors/);
  assert.equal(memoryChangeBlockedReason(memory), '');
  assert.match(memoryErrorMessage({ status: 409 }, 'x'), /changed since the list loaded/);
  assert.equal(memoryErrorMessage({ message: 'Held.', status: 423 }, 'x'), 'Held.');
});

test('a new memory is taught by a person and scoped to a project or kept personal', () => {
  const form = { ...createMemoryForm(null, { project: 'project-1' }), content: ' Prefer short status notes. ', memoryType: 'preference', title: ' Status style ' };
  assert.deepEqual(validateMemoryForm(form), {});
  assert.deepEqual(validateMemoryForm(createMemoryForm()), { content: 'Say what the AI should remember.', title: 'Give the memory a short title.' });
  const payload = buildNewMemoryPayload(form, new Date('2026-10-09T12:00:00Z'));
  assert.deepEqual(payload, {
    confidence: 1, content: 'Prefer short status notes.', memoryType: 'preference', projectId: 'project-1',
    provenance: { sourceType: 'person' }, sensitivity: 'internal', sourceAt: '2026-10-09T12:00:00.000Z', title: 'Status style',
  });
  assert.equal(buildNewMemoryPayload({ ...form, project: PERSONAL_SCOPE }).projectId, null);
  assert.equal(createMemoryForm().project, PERSONAL_SCOPE);
});

test('a correction sends only changed fields with the loaded version', () => {
  const form = createMemoryForm(memory);
  assert.equal(buildCorrectionPayload(memory, form), null);
  assert.deepEqual(buildCorrectionPayload(memory, { ...form, content: 'Ship on Wednesdays.', sensitivity: 'confidential' }), { content: 'Ship on Wednesdays.', expectedVersion: 3, sensitivity: 'confidential' });
});

test('a correction can change confidence, edited as a whole percentage', () => {
  const held = { ...memory, confidence: 0.875 };
  const form = createMemoryForm(held);
  assert.equal(form.confidence, 88);
  assert.equal(createMemoryForm(memory).confidence, 100, 'a memory without a stored confidence counts as certain');
  assert.equal(buildCorrectionPayload(held, form), null, 'rounding alone is not a change');
  assert.deepEqual(buildCorrectionPayload(held, { ...form, confidence: 60 }), { confidence: 0.6, expectedVersion: 3 });
  assert.deepEqual(buildCorrectionPayload(memory, { ...createMemoryForm(memory), confidence: 0 }), { confidence: 0, expectedVersion: 3 });
  for (const confidence of ['', 101, -1, 12.5]) assert.equal(validateMemoryForm({ ...form, confidence }).confidence, 'Enter a whole number from 0 to 100.');
  assert.equal(validateMemoryForm({ ...form, confidence: 0 }).confidence, undefined);
  assert.match(editorSource, /<div v-if="isCorrection" class="rq-field">\s*<label for="memory-editor-confidence">Confidence \(%\)<\/label>/);
});

test('retention settings map a date to the end of that day and clear empty values', () => {
  const held = { ...memory, expiresAt: '2026-12-31T23:59:59.999Z', legalHold: true, retentionPolicyId: 'case-42' };
  assert.deepEqual(createGovernanceForm(held), { expiresOn: '2026-12-31', legalHold: true, retentionPolicyId: 'case-42' });
  assert.deepEqual(buildGovernancePayload(memory, { expiresOn: '2027-01-15', legalHold: false, retentionPolicyId: '  ' }), { expectedVersion: 3, expiresAt: '2027-01-15T23:59:59.999Z', legalHold: false, retentionPolicyId: null });
  assert.equal(buildGovernancePayload(memory, { expiresOn: '', legalHold: true, retentionPolicyId: 'x' }).expiresAt, null);
});

test('the memory screen uses app dialogs, explains blocked actions, and keeps governance admin-only', () => {
  assert.doesNotMatch(viewSource, /window\.confirm|\balert\(|\bconfirm\(/);
  assert.doesNotMatch(viewSource, /<(button|a|span|i|div|p|li|RouterLink)\b[^>]*\s:?title="/);
  assert.match(viewSource, /<RequirementsConfirmDialog[\s\S]*?title="Forget this memory\?"/);
  assert.match(viewSource, /<RequirementsConfirmDialog[\s\S]*?title="Purge expired memories\?"/);
  assert.match(viewSource, /v-if="permissions\.canGovern" class="btn btn-outline-danger" type="button" @click="openPurge"/);
  assert.match(viewSource, /v-if="permissions\.canGovern" class="btn btn-outline-secondary" type="button" @click="openGovernance\(memory\)"/);
  assert.match(viewSource, /:disabled="!memory\.canForget" :aria-describedby="memory\.canForget \? undefined : `memory-blocked-\$\{memory\.id\}`"/);
  assert.match(viewSource, /:aria-expanded="expandedId === memory\.id \? 'true' : 'false'"/);
  assert.match(viewSource, /aria-label="Memory pages"/);
  assert.match(editorSource, /<RequirementsDialog /);
  assert.match(governanceSource, /<RequirementsDialog /);
});

test('the assistant links to the memory screen for the current project', () => {
  assert.match(workspaceSource, /<RouterLink class="assistant-icon" :to="memoryRoute" aria-label="What the assistant remembers"/);
  assert.match(workspaceSource, /const memoryRoute = computed\(\(\) => \(\{ name: 'agent-memory', query: projectId\.value \? \{ project: projectId\.value \} : \{\} \}\)\);/);
});
