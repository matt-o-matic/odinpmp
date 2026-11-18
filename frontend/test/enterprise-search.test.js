import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildSearchRequest,
  buildSearchRouteQuery,
  groupSearchResults,
  parseSearchRouteQuery,
  searchPageCount,
  searchResultLink,
  searchSnippet,
  searchTypeLabel,
} from '../src/lib/search/enterprise-search.js';

const reportingSource = readFileSync(new URL('../src/views/ReportingView.vue', import.meta.url), 'utf8');

test('search route query round-trips and ignores unknown or malformed values', () => {
  assert.deepEqual(parseSearchRouteQuery({ page: '3', project: 'project-1', q: '  vendor  ', type: 'governance' }), { category: 'governance', page: 3, projectId: 'project-1', q: 'vendor' });
  assert.deepEqual(parseSearchRouteQuery({ page: '-2', q: ['first', 'second'], type: 'secrets' }), { category: '', page: 1, projectId: '', q: 'first' });
  assert.deepEqual(buildSearchRouteQuery({ category: 'work', page: 2, projectId: 'project-1', q: 'pilot' }), { page: '2', project: 'project-1', q: 'pilot', type: 'work' });
  assert.deepEqual(buildSearchRouteQuery({ page: 1, q: 'pilot' }), { q: 'pilot' });
});

test('search requests map categories to document types and pages to offsets', () => {
  assert.deepEqual(buildSearchRequest({ category: 'work', page: 3, projectId: '', q: 'pilot' }, 20), { limit: 20, offset: 40, projectId: '', query: 'pilot', types: 'epic,story,task' });
  assert.equal(buildSearchRequest({ category: '', page: 1, projectId: 'p', q: 'x' }).types, '');
  assert.equal(searchPageCount(0), 1);
  assert.equal(searchPageCount(41, 20), 3);
});

test('result links open the governance route, including rows indexed with the old tab query', () => {
  assert.equal(searchResultLink({ url: '/projects/project-1/governance' }), '/projects/project-1/governance');
  assert.equal(searchResultLink({ url: '/projects/project-1?tab=governance' }), '/projects/project-1/governance');
  assert.equal(searchResultLink({ url: '/projects/project-1' }), '/projects/project-1');
  assert.equal(searchResultLink({ projectId: 'project-1', url: 'https://evil.example/' }), '/projects/project-1');
  assert.equal(searchResultLink({ url: '//evil.example/' }), '/');
});

test('results group by category in rank order with readable type labels and snippets', () => {
  const groups = groupSearchResults([
    { documentType: 'risk', id: 'r1' }, { documentType: 'project', id: 'p1' }, { documentType: 'milestone', id: 'm1' }, { documentType: 'mystery', id: 'x1' },
  ]);
  assert.deepEqual(groups.map((group) => [group.key, group.records.map((record) => record.id)]), [['governance', ['r1', 'm1']], ['projects', ['p1']], ['other', ['x1']]]);
  assert.equal(searchTypeLabel('change_request'), 'Change request');
  assert.equal(searchTypeLabel('new_kind'), 'new kind');
  assert.equal(searchSnippet('  a   b  '), 'a b');
  assert.equal(searchSnippet('x'.repeat(300), 10).length, 10);
});

test('channels, posts and channel files group with their own types and open the channel', () => {
  const groups = groupSearchResults([
    { documentType: 'post', id: 'post-1' }, { documentType: 'file', id: 'file-1' }, { documentType: 'channel', id: 'channel-1' }, { documentType: 'task', id: 't1' },
  ]);
  assert.deepEqual(groups.map((group) => [group.key, group.records.map((record) => record.id)]), [['channels', ['post-1', 'channel-1']], ['files', ['file-1']], ['work', ['t1']]]);
  assert.deepEqual(['channel', 'post', 'file'].map(searchTypeLabel), ['Channel', 'Post', 'File']);
  assert.equal(buildSearchRequest({ category: 'channels', page: 1, projectId: '', q: 'pricing' }).types, 'channel,post');
  assert.equal(buildSearchRequest({ category: 'files', page: 1, projectId: '', q: 'sow' }).types, 'file');
  assert.equal(parseSearchRouteQuery({ q: 'x', type: 'files' }).category, 'files');
  assert.equal(searchResultLink({ url: '/engagements/e-1/channels?channel=c-1&post=p-1' }), '/engagements/e-1/channels?channel=c-1&post=p-1');
  assert.equal(searchResultLink({ url: '/projects/p-1/channels?channel=c-1&tab=files&file=f-1' }), '/projects/p-1/channels?channel=c-1&tab=files&file=f-1');
});

test('the reporting search tab starts empty and does not call the API without a query', () => {
  assert.doesNotMatch(reportingSource, /query: 'launch'/);
  assert.match(reportingSource, /if \(!searchedQuery\.value\) \{ searchResults\.value = \{ facetCounts: \{\}, records: \[\], total: 0 \}; return; \}/);
  assert.match(reportingSource, /<RouterLink :to="searchResultLink\(item\)">/);
});
