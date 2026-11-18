import assert from 'node:assert/strict';
import test from 'node:test';

import { createSearchSuggestions, signedInKey, suggestionOption } from '../src/lib/search/search-suggestions.js';

// Results as you type in Ctrl+K and the Odin Chat jump box.

function fakeTimers() {
  const pending = new Map();
  let next = 0;
  return {
    clear: (id) => pending.delete(id),
    fire: async () => { const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) await callback(); },
    pending,
    set: (callback) => { next += 1; pending.set(next, callback); return next; },
  };
}

test('suggestions wait for three characters and a pause, and only the latest text\'s answer is kept', async () => {
  const timers = fakeTimers();
  const asked = [];
  const answers = {};
  const suggestions = createSearchSuggestions({ search: async ({ limit, query }) => { asked.push([query, limit]); return answers[query]; }, timers });
  suggestions.update('pa');
  assert.equal(timers.pending.size, 0, 'two characters ask nothing');
  suggestions.update('pay');
  suggestions.update('payroll ');
  assert.equal(timers.pending.size, 1, 'typing replaces the pending ask');
  answers.payroll = { records: Array.from({ length: 8 }, (_, index) => ({ documentType: 'task', id: `d${index}`, title: `T${index}` })) };
  await timers.fire();
  assert.deepEqual(asked, [['payroll', 5]]);
  assert.equal(suggestions.state.results.length, 5);
  assert.equal(suggestions.state.loading, false);

  // A slow answer to older text never replaces the newer one.
  let release;
  const slow = createSearchSuggestions({ search: ({ query }) => (query === 'old' ? new Promise((resolve) => { release = () => resolve({ records: [{ id: 'stale' }] }); }) : Promise.resolve({ records: [{ id: 'fresh' }] })), timers });
  slow.update('old');
  const firing = timers.fire();
  slow.update('new');
  await timers.fire();
  release();
  await firing;
  assert.deepEqual(slow.state.results.map((record) => record.id), ['fresh']);

  // A failure clears the results and says so.
  const failing = createSearchSuggestions({ search: async () => { throw new Error('down'); }, timers });
  failing.update('anything');
  await timers.fire();
  assert.deepEqual([failing.state.results, failing.state.error], [[], true]);
  failing.clear();
  assert.deepEqual([failing.state.query, failing.state.error], ['', false]);
});

test('a result becomes an option with its type, project and link', () => {
  assert.deepEqual(suggestionOption({ documentType: 'comment', facets: { project: 'Northwind' }, id: 'doc-1', title: 'Lena on Pay cycle', url: '/projects/p1?item=story-1' }), {
    detail: 'Comment · Northwind', documentType: 'comment', key: 'result:doc-1', kind: 'result', label: 'Lena on Pay cycle', to: '/projects/p1?item=story-1',
  });
  assert.equal(suggestionOption({ documentType: 'file', id: 'doc-2', projectId: 'p1', title: 'a.pdf', url: 'https://evil.example/x' }).to, '/projects/p1', 'an address outside the app opens the project');
});

test('a new text drops the previous text’s results at once, and a new sign-in has its own key', async () => {
  const timers = fakeTimers();
  const suggestions = createSearchSuggestions({ search: async ({ query }) => ({ records: [{ id: `about-${query}` }] }), timers });
  suggestions.update('travel');
  await timers.fire();
  assert.deepEqual(suggestions.state.results.map((record) => record.id), ['about-travel']);
  suggestions.update('payroll');
  assert.deepEqual(suggestions.state.results, [], 'nothing from the old text while the new one is asked');
  suggestions.update('payroll ');
  await timers.fire();
  assert.deepEqual(suggestions.state.results.map((record) => record.id), ['about-payroll']);

  assert.equal(signedInKey(null), '');
  assert.equal(signedInKey({ id: 'u1', tenantId: 't1' }), 'u1:t1');
  assert.equal(signedInKey({ id: 'u1', memberships: [{ tenantId: 't2' }] }), 'u1:t2');
});
