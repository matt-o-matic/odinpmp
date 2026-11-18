import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPackageMarkdown, safeExternalUrl } from '../src/lib/requirements/package-markdown.js';
import {
  describeSummaryRefreshError,
  describeSummaryRefreshOutcome,
  describeSummaryStatus,
  summaryPeople,
} from '../src/lib/requirements/requirements-summary-status.js';

const now = new Date('2026-10-07T12:00:00Z');

test('summary freshness shows the last update, and a failed refresh on top of it', () => {
  const summary = { createdAt: '2026-10-07T11:54:00Z', id: 's1' };
  assert.deepEqual(describeSummaryStatus({ now, status: { lastAttemptAt: '2026-10-07T11:54:00Z', lastAttemptStatus: 'ok', refreshPending: false }, summary }), {
    failed: false,
    failedText: '',
    pending: false,
    updatedText: 'Last updated 6 min ago',
  });
  const failed = describeSummaryStatus({ now, status: { lastAttemptAt: '2026-10-07T11:58:00Z', lastAttemptStatus: 'failed', refreshPending: true }, summary });
  assert.equal(failed.updatedText, 'Last updated 6 min ago');
  assert.equal(failed.failedText, 'refresh failed 2 min ago');
  assert.equal(failed.pending, true);
  // The summary's own last-attempt fields count when the status object is missing.
  assert.equal(describeSummaryStatus({ now, summary: { ...summary, lastAttemptAt: '2026-10-07T11:59:30Z', lastAttemptStatus: 'failed' } }).failedText, 'refresh failed just now');
  assert.deepEqual(describeSummaryStatus({ now }), { failed: false, failedText: '', pending: false, updatedText: '' });
  assert.equal(describeSummaryStatus({ now, status: { lastAttemptAt: '2026-10-07T11:00:00Z', lastAttemptStatus: 'failed' } }).failed, true, 'a failure with no summary yet');
});

test('refresh outcomes read clearly', () => {
  assert.deepEqual(describeSummaryRefreshOutcome({ outcome: 'ok' }), { message: 'Odin summary updated.', tone: 'success' });
  assert.match(describeSummaryRefreshOutcome({ outcome: 'no-input' }).message, /^Not enough input yet\./);
  assert.equal(describeSummaryRefreshOutcome({ outcome: 'failed' }).tone, 'error');
  assert.match(describeSummaryRefreshOutcome({ outcome: 'failed' }).message, /previous summary is still shown/);
  const notConfigured = describeSummaryRefreshError({ data: { details: { code: 'ai_not_configured' }, error: 'ai_not_configured' }, status: 503 });
  assert.match(notConfigured.message, /no AI provider is set up/);
  assert.match(describeSummaryRefreshError({ data: {}, status: 503 }).message, /no AI provider is set up/);
  assert.match(describeSummaryRefreshError({ data: {}, status: 500 }).message, /Try again/);
});

test('summary people use the names the API sends, with or without actor refs', () => {
  const context = { users: [{ id: 'u1', name: 'Alex Kim (old)' }] };
  const people = summaryPeople(['user:u1', 'stakeholder:s1'], ['Alex Kim', 'Ravi Shah'], context);
  assert.deepEqual(people.map((person) => [person.ref, person.name, person.initials]), [
    ['user:u1', 'Alex Kim', 'AK'],
    ['stakeholder:s1', 'Ravi Shah', 'RS'],
  ]);
  // No names: fall back to the project's people.
  assert.equal(summaryPeople(['user:u1'], undefined, context)[0].name, 'Alex Kim (old)');
  // Portal shape: names only.
  const portal = summaryPeople(undefined, ['Jamie Ortiz', 'Ravi Shah']);
  assert.deepEqual(portal.map((person) => person.name), ['Jamie Ortiz', 'Ravi Shah']);
  assert.equal(new Set(portal.map((person) => person.ref)).size, 2);
});

test('package markdown escapes raw HTML, keeps https links only, and drops images', () => {
  const html = renderPackageMarkdown('**Bold** <script>alert(1)</script> <b onclick="x">raw</b>');
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<b /);
  assert.match(html, /&lt;script&gt;/);

  const links = renderPackageMarkdown('[safe](https://example.com/a) [plain](http://example.com) [bad](javascript:alert(1))');
  assert.match(links, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">safe<\/a>/);
  assert.doesNotMatch(links, /href="http:\/\//);
  assert.doesNotMatch(links, /href="javascript/i);

  const image = renderPackageMarkdown('![The home screen](https://example.com/x.png)');
  assert.doesNotMatch(image, /<img/);
  assert.match(image, /The home screen/);
  assert.equal(renderPackageMarkdown('   '), '');
  assert.equal(safeExternalUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(safeExternalUrl('http://example.com/x'), '');
  assert.equal(safeExternalUrl('javascript:alert(1)'), '');
});
