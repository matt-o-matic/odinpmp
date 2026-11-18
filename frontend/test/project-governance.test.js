import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  flattenProjectWorkItems,
  goalChangeAccess,
  goalChangesLabel,
  goalConstraintsFromDraft,
  goalOwnerName,
  governanceItemCounts,
  governanceKindLabel,
  selectGovernanceItems,
} from '../src/lib/projects/project-governance.js';

test('project governance helpers flatten work and summarize register types', () => {
  const workItems = flattenProjectWorkItems({
    epics: [{ id: 'epic-1', name: 'Launch', stories: [{ id: 'story-1', name: 'Pilot', tasks: [{ id: 'task-1', name: 'Invite users' }] }] }],
  });
  assert.deepEqual(workItems.map((item) => item.id), ['epic-1', 'story-1', 'task-1']);
  assert.equal(workItems[2].label, 'Launch / Pilot / Invite users');
  assert.deepEqual(governanceItemCounts([{ kind: 'risk' }, { kind: 'risk' }, { kind: 'decision' }]), {
    assumption: 0, change_request: 0, decision: 1, issue: 0, risk: 2,
  });
  assert.equal(governanceKindLabel('change_request'), 'Change request');
});

test('project governance selection filters, sorts, and paginates deterministically', () => {
  const items = [
    { id: '1', impact: 'low', kind: 'risk', status: 'open', title: 'Zeta', updatedAt: '2026-01-01T00:00:00Z' },
    { id: '2', impact: 'critical', kind: 'risk', status: 'open', title: 'Alpha', updatedAt: '2026-01-02T00:00:00Z' },
    { id: '3', impact: 'medium', kind: 'issue', status: 'resolved', title: 'Beta', updatedAt: '2026-01-03T00:00:00Z' },
  ];
  const result = selectGovernanceItems(items, { kind: 'risk', page: 1, pageSize: 1, query: 'a', sort: 'impact_desc', status: 'open' });
  assert.equal(result.total, 2);
  assert.equal(result.pageCount, 2);
  assert.equal(result.items[0].id, '2');
});

const workspaceSource = readFileSync(new URL('../src/components/projects/ProjectGovernanceWorkspace.vue', import.meta.url), 'utf8');
const draft = (autoApply) => ({ allowWebResearch: false, autoApply, escalationAfterRuns: 1, escalationEmail: true, escalationWebhook: false, maxAttempts: 5 });

test("a goal's owner sees the switch and saves their choice with the rest of the constraints", () => {
  const goal = { constraints: { autoApply: true }, ownerUserId: 'user-ada' };
  const access = goalChangeAccess(goal, 'user-ada');
  assert.deepEqual(access, { makesChanges: true, owner: true, readOnly: false });
  assert.deepEqual(goalConstraintsFromDraft(draft(true), access), {
    allowWebResearch: false, autoApply: true, escalation: { afterRuns: 1, channels: ['in_app', 'email'] }, maxAttempts: 5,
  });
  assert.equal(goalConstraintsFromDraft(draft(false), access).autoApply, false);
  // Whoever creates a goal owns it, and new goals start off.
  assert.equal(goalChangeAccess(null, 'user-ada').owner, true);
  assert.equal(goalChangeAccess(null, '').owner, false);
  assert.match(workspaceSource, /const blankGoal = \(\) => \(\{ allowWebResearch: false, autoApply: false,/);
  assert.match(workspaceSource, /v-else-if="goalAccess\.owner">\s*<label class="governance-check"><input v-model="goalDraft\.autoApply" type="checkbox"[^>]*\/> Let this goal make changes on its own<\/label>/);
  assert.match(workspaceSource, /Its runs happen with nobody watching and act as you\. They can change anything you can\./);
  assert.match(workspaceSource, /constraints: goalConstraintsFromDraft\(goalDraft, goalAccess\.value\),/);
});

test('someone else sees whether the goal makes changes as text, and their save never sends autoApply true', () => {
  const goal = { constraints: { autoApply: true }, ownerUserId: 'user-ada' };
  const access = goalChangeAccess(goal, 'user-grace');
  assert.deepEqual(access, { makesChanges: true, owner: false, readOnly: false });
  assert.equal(goalConstraintsFromDraft(draft(true), access).autoApply, false);
  assert.equal(goalOwnerName(goal, [{ id: 'user-ada', name: 'Ada Lovelace' }]), 'Ada Lovelace');
  assert.equal(goalOwnerName(goal, [{ email: 'ada@example.com', id: 'user-ada' }]), 'ada@example.com');
  assert.equal(goalOwnerName(goal, []), "the goal's owner");
  assert.match(workspaceSource, /Makes changes on its own \(set by \$\{goalEditorOwnerName\}\)\./);
  assert.match(workspaceSource, /<p v-if="goalAccess\.makesChanges && !goalAccess\.owner" class="form-text mb-0">Saving stops this goal making changes on its own\. Only \{\{ goalEditorOwnerName \}\} can turn that back on\.<\/p>\s*<div class="governance-editor__actions">/);
});

test('a read-only goal shows no switch and always watches only', () => {
  const goal = { constraints: { autoApply: true, readOnly: true }, ownerUserId: 'user-ada' };
  const access = goalChangeAccess(goal, 'user-ada');
  assert.deepEqual(access, { makesChanges: false, owner: true, readOnly: true });
  assert.equal(goalConstraintsFromDraft(draft(true), access).autoApply, false);
  assert.equal(goalChangesLabel(goal), 'Watches only');
  // The read-only branch comes first, so its owner never reaches the switch.
  assert.ok(workspaceSource.indexOf('v-if="goalAccess.readOnly"') < workspaceSource.indexOf('v-else-if="goalAccess.owner"'));
});

test('the goal list says in a few words whether each goal makes changes', () => {
  assert.equal(goalChangesLabel({ constraints: { autoApply: true } }), 'Makes changes on its own');
  assert.equal(goalChangesLabel({ constraints: {} }), 'Watches only');
  assert.match(workspaceSource, /<small>\{\{ goalChangesLabel\(goal\) \}\} · /);
});
