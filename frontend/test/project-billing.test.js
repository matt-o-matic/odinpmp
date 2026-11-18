import assert from 'node:assert/strict';
import test from 'node:test';

import {
  billingErrorMessage, filterStories, formatHours, invoiceStatusIcon, invoiceStatusLabel, remainingHours, timeEntryInvoiceLabel,
} from '../src/lib/projects/project-billing.js';
import { canDeleteTimeEntry } from '../src/lib/task-access/access-view.js';

test('hours read as whole or two-decimal numbers', () => {
  assert.equal(formatHours(40), '40 h');
  assert.equal(formatHours(2.5), '2.5 h');
  assert.equal(formatHours(1.25), '1.25 h');
  assert.equal(formatHours(null), '0 h');
});

test('a milestone has its budget less billed and draft hours left, negative when over', () => {
  assert.equal(remainingHours({ billedHours: 10, budgetHours: 40, claimedUnbilledHours: 5 }), 25);
  assert.equal(remainingHours({ billedHours: 30, budgetHours: 40, claimedUnbilledHours: 12.5 }), -2.5);
});

test('the story picker filters by story or epic name and by epic', () => {
  const stories = [
    { epicId: 'e1', epicTitle: 'Discovery', id: 's1', title: 'Workshop' },
    { epicId: 'e2', epicTitle: 'Build', id: 's2', title: 'Data model' },
    { epicId: 'e2', epicTitle: 'Build', id: 's3', title: 'Workshop follow-up' },
  ];
  assert.deepEqual(filterStories(stories, { query: 'workshop' }).map((story) => story.id), ['s1', 's3']);
  assert.deepEqual(filterStories(stories, { query: 'build' }).map((story) => story.id), ['s2', 's3']);
  assert.deepEqual(filterStories(stories, { epicId: 'e2', query: 'work' }).map((story) => story.id), ['s3']);
  assert.equal(filterStories(stories).length, 3);
});

test('a claimed entry names its invoice, or says it is on a draft', () => {
  assert.equal(timeEntryInvoiceLabel({ invoiced: false, invoice: null }), '');
  assert.equal(timeEntryInvoiceLabel({ invoiced: true, invoice: { draft: true, number: null } }), 'Draft invoice');
  assert.equal(timeEntryInvoiceLabel({ invoiced: true, invoice: { draft: false, number: 'NESLLC-20261130-001' } }), 'NESLLC-20261130-001');
  assert.equal(timeEntryInvoiceLabel({ invoiced: true, invoice: { draft: true, number: 'NESLLC-7' } }), 'NESLLC-7 (draft)');
});

test('invoice status has a label and an icon, so it never relies on color', () => {
  assert.deepEqual(['draft', 'submitted', 'paid', 'void'].map(invoiceStatusLabel), ['Draft', 'Submitted', 'Paid', 'Void']);
  assert.ok(['draft', 'submitted', 'paid', 'void', 'other'].every((status) => invoiceStatusIcon(status).startsWith('bi-')));
});

test('billing errors read as what to do', () => {
  assert.match(billingErrorMessage({ data: { details: { code: 'time_entry_invoiced' } } }, 'x'), /on an invoice/);
  assert.match(billingErrorMessage({ data: { details: { code: 'module_disabled' } } }, 'x'), /Consulting module/);
  assert.equal(billingErrorMessage({}, 'Fallback'), 'Fallback');
});

test('a task access link cannot delete invoiced time', () => {
  assert.equal(canDeleteTimeEntry({ status: 'submitted' }), true);
  assert.equal(canDeleteTimeEntry({ invoiced: true, status: 'submitted' }), false);
});
