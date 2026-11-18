import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_ATTACHMENT_LIMITS,
  attachmentLimitsText,
  filterIntakeLinks,
  filterReporterTickets,
  formatFileSize,
  intakeLinkState,
  isClosedTicketStatus,
  submissionFieldErrors,
  validateAttachments,
} from '../src/lib/projects/ticket-intake.js';

const routerSource = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8');
const reportViewSource = readFileSync(new URL('../src/views/TicketReportView.vue', import.meta.url), 'utf8');
const linksSource = readFileSync(new URL('../src/components/projects/ProjectTicketIntakeLinks.vue', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/components/projects/ProjectTicketsPanel.vue', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../src/lib/api/client.js', import.meta.url), 'utf8');

const MB = 1024 * 1024;

test('attachments are checked against count, type, per-file and combined size', () => {
  const file = (name, size, type = 'image/png') => ({ name, size, type });

  assert.deepEqual(validateAttachments([file('a.png', MB)]), []);
  assert.match(validateAttachments([file('virus.exe', MB, 'application/x-msdownload')])[0], /virus\.exe isn’t a supported file type/);
  assert.match(validateAttachments([file('big.png', 11 * MB)])[0], /big\.png is larger than 10 MB/);
  assert.match(validateAttachments([file('empty.png', 0)])[0], /empty\.png is empty/);
  assert.match(validateAttachments(Array.from({ length: 6 }, (_, index) => file(`${index}.png`, 10)))[0], /at most 5 files/);
  assert.deepEqual(validateAttachments([file('a.png', 8 * MB), file('b.png', 8 * MB), file('c.png', 8 * MB)]), ['Together the files are larger than 20 MB.']);
});

test('limits read as one plain sentence', () => {
  assert.equal(attachmentLimitsText(DEFAULT_ATTACHMENT_LIMITS), 'Up to 5 files, 10 MB each and 20 MB in total. PDF, GIF, JPEG, PNG, WebP, CSV or plain text.');
  assert.equal(formatFileSize(1536), '2 KB');
  assert.equal(formatFileSize(1.5 * MB), '1.5 MB');
});

test('server validation details map onto the form fields', () => {
  const errors = submissionFieldErrors({ data: { details: [{ message: 'Required', path: 'name' }, { message: 'Invalid', path: 'attachments.0.contentType' }] } });
  assert.deepEqual(Object.keys(errors).sort(), ['attachments', 'name']);
  assert.match(errors.name, /summary/);
  assert.deepEqual(submissionFieldErrors(new Error('boom')), {});
});

test('a reporter filters their tickets into open and finished, newest first, a page at a time', () => {
  const tickets = [
    { id: '1', status: 'new' },
    { id: '2', status: 'closed' },
    { id: '3', status: 'in_progress' },
    { id: '4', status: 'rejected' },
    { id: '5', status: 'custom_state' },
  ];
  assert.deepEqual(filterReporterTickets(tickets, { filter: 'open' }).visible.map((ticket) => ticket.id), ['1', '3', '5']);
  assert.deepEqual(filterReporterTickets(tickets, { filter: 'closed' }).visible.map((ticket) => ticket.id), ['2', '4']);
  assert.deepEqual(filterReporterTickets(tickets, { limit: 2 }), { total: 5, visible: tickets.slice(0, 2) });
  assert.equal(isClosedTicketStatus('resolved'), true);
});

test('intake links are active, expired, or revoked, and filter by state and reporter', () => {
  const now = Date.parse('2026-10-09T12:00:00.000Z');
  const links = [
    { createdAt: '2026-10-01', id: 'a', reporterEmail: 'ann@client.com', reporterName: 'Ann' },
    { createdAt: '2026-10-03', expiresAt: '2026-10-05T00:00:00.000Z', id: 'b', reporterEmail: 'bob@client.com' },
    { createdAt: '2026-10-02', id: 'c', reporterEmail: 'cat@client.com', revokedAt: '2026-10-04' },
    { createdAt: '2026-10-04', expiresAt: '2026-11-01T00:00:00.000Z', id: 'd', reporterEmail: 'dan@client.com' },
  ];
  assert.deepEqual(links.map((link) => intakeLinkState(link, now)), ['active', 'expired', 'revoked', 'active']);
  assert.deepEqual(filterIntakeLinks(links, { state: 'active' }, now).map((link) => link.id), ['d', 'a']);
  assert.deepEqual(filterIntakeLinks(links, { query: 'ANN', state: 'all' }, now).map((link) => link.id), ['a']);
});

test('the reporter page is a public, chrome-less portal route', () => {
  assert.match(routerSource, /path: '\/report\/:token',\s*name: 'ticket-report',\s*component: TicketReportView,\s*meta: \{ portal: true \}/);
  assert.equal(/requiresAuth/.test(routerSource.slice(routerSource.indexOf("'/report/:token'"), routerSource.indexOf("'/report/:token'") + 200)), false);
  assert.match(clientSource, /async getTicketIntake\(intakeToken\)/);
  assert.match(clientSource, /async submitTicketIntake\(intakeToken, payload\)/);
  assert.match(reportViewSource, /client\.getTicketIntake\(token\.value\)/);
  assert.match(reportViewSource, /apiClient\.submitTicketIntake\(/);
  assert.match(reportViewSource, /This link isn’t available/);
  assert.match(reportViewSource, /role="alert"/);
  assert.match(reportViewSource, /aria-invalid/);
  assert.match(reportViewSource, /#ticket-/);
});

test('the intake links tab shows and copies each link and reuses the shared dialogs', () => {
  assert.match(panelSource, /<ProjectTicketIntakeLinks v-if="activeView === 'intake'"/);
  assert.match(linksSource, /import \{ copyText \} from '..\/..\/lib\/clipboard.js'/);
  assert.match(linksSource, /RequirementsDialog/);
  assert.match(linksSource, /RequirementsConfirmDialog/);
  assert.match(linksSource, /row\.invitation\.url/);
  assert.match(linksSource, /:aria-label="`Copy the link for \$\{row\.label\}`"/);
  assert.match(linksSource, /reporterName: create\.name\.trim\(\)/);
  assert.match(linksSource, /expiresAt,/);
  for (const source of [linksSource, reportViewSource]) {
    assert.equal(/window\.|\balert\(|\bconfirm\(/.test(source), false, 'no native dialogs');
    assert.match(source, /2\.75rem/);
  }
});
