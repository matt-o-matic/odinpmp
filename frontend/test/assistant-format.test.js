import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activitySummary,
  attachmentKind,
  chatListTime,
  liveStatus,
  pageContextFor,
  parseOdinHref,
  planProgress,
  proposalCounts,
  renderAssistantMarkdown,
  suggestedPrompts,
} from '../src/lib/assistant/assistant-format.js';

test('replies render as markdown with real headings, lists and links into Odin', () => {
  const html = renderAssistantMarkdown('## Summary\n\n**Status:** on track.\n\n- [Pay by card](odin://item/story-1)\n- [Shop](odin://project/project-1)', 'http://localhost:3001');
  assert.match(html, /<h2>Summary<\/h2>/);
  assert.match(html, /<strong>Status:<\/strong> on track\./);
  assert.match(html, /<a href="#odin-item:story-1">Pay by card<\/a>/);
  assert.match(html, /<a href="#odin-project:project-1">Shop<\/a>/);
  assert.deepEqual(parseOdinHref('#odin-item:story-1'), { id: 'story-1', kind: 'item' });
  assert.equal(parseOdinHref('https://example.com'), null);
});

test('citation markup the model wrote as text never shows, live or saved', () => {
  const html = renderAssistantMarkdown('Started a week ago. citenone Rates rose citeturn0finance0 this year.', 'http://localhost:3001');
  assert.doesNotMatch(html, /cite|none|turn0|[-]/);
  assert.match(html, /Started a week ago\. Rates rose this year\./);
});

test('activity, plan and proposal summaries read plainly', () => {
  assert.equal(activitySummary([]), '');
  assert.equal(activitySummary([{ ok: true }]), 'Used 1 tool');
  assert.equal(activitySummary([{ ok: true }, { ok: false }, { ok: true }]), "Used 3 tools · 1 didn't work");
  assert.deepEqual(planProgress([{ status: 'done' }, { status: 'in_progress' }, { status: 'skipped' }]), { done: 2, total: 3 });
  assert.deepEqual(proposalCounts({ items: [{ status: 'pending' }, { status: 'applied' }, { status: 'withdrawn' }] }), { applied: 1, dismissed: 1, failed: 0, pending: 1 });
});

test('the page context names what the user is looking at', () => {
  assert.deepEqual(pageContextFor({ name: 'project-kanban', params: { projectId: 'p' }, query: {} }), { view: 'the Kanban board' });
  assert.deepEqual(pageContextFor({ name: 'project-requirements-topic', query: {} }), { view: 'project Requirements' });
  assert.deepEqual(pageContextFor({ name: 'project-detail', query: { item: 'story-1' } }), { itemId: 'story-1', view: 'the project plan' });
  assert.equal(pageContextFor({}), null);
});

test('attachments accept text files and images only, and prompts fit the page', () => {
  assert.equal(attachmentKind({ name: 'notes.md', type: '' }), 'text');
  assert.equal(attachmentKind({ name: 'shot.png', type: 'image/png' }), 'image');
  assert.equal(attachmentKind({ name: 'contract.pdf', type: 'application/pdf' }), null);
  assert.equal(suggestedPrompts({}).length, 3);
  assert.ok(suggestedPrompts({ projectName: 'Shop', view: 'the Kanban board' }).some((prompt) => /board/.test(prompt)));
  assert.ok(suggestedPrompts({ projectName: 'Shop' })[0].includes('Shop'));
});

test('the working indicator names the tool in use, says Writing while text streams, and Thinking otherwise', () => {
  const startedAt = new Date(1_000_000).toISOString();
  const base = { activity: [], phase: 'thinking', phaseAt: 1_000_000, startedAt };
  assert.deepEqual(liveStatus(base, 1_004_000), { elapsed: '4s', label: 'Thinking' });
  assert.equal(liveStatus({ ...base, activity: [{ label: 'Searching work items', status: 'running' }] }, 1_005_000).label, 'Searching work items');
  assert.equal(liveStatus({ ...base, activity: [{ label: 'Reading governance', status: 'running' }, { label: 'Listing tickets', status: 'running' }] }, 1_005_000).label, 'Reading governance and 1 more');
  assert.equal(liveStatus({ ...base, phase: 'writing', phaseAt: 1_090_000 }, 1_090_500).label, 'Writing');
  assert.equal(liveStatus({ ...base, phase: 'writing', phaseAt: 1_090_000 }, 1_095_000).label, 'Thinking', 'a pause after writing is thinking again');
  assert.equal(liveStatus(base, 1_095_000).elapsed, '1:35');
  assert.equal(liveStatus(null), null);
});

test('chat list times say today, yesterday, a date this year, or a date with its year', () => {
  const now = new Date(2026, 9, 28, 15, 0).getTime();
  assert.equal(chatListTime(new Date(2026, 9, 28, 14, 14).toISOString(), now), 'today, 2:14 PM');
  assert.equal(chatListTime(new Date(2026, 9, 27, 16, 5).toISOString(), now), 'yesterday, 4:05 PM');
  assert.equal(chatListTime(new Date(2026, 9, 26, 9, 14).toISOString(), now), 'Oct 26, 9:14 AM');
  assert.equal(chatListTime(new Date(2025, 9, 26, 9, 14).toISOString(), now), 'Oct 26, 2025');
  assert.equal(chatListTime(null, now), '');
});
