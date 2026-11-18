import assert from 'node:assert/strict';
import test from 'node:test';

import { filterMentionables } from '../src/lib/requirements/mention-tokens.js';

test('matching people: names starting with the query first, then word starts, then anywhere', () => {
  const people = [
    { name: 'Casey Lin', ref: 'c' },
    { name: 'Lina Park', ref: 'l' },
    { name: 'Olin Grey', ref: 'o' },
    { name: 'Uma User', ref: 'u' },
  ];
  assert.deepEqual(filterMentionables(people, 'lin').map((person) => person.ref), ['l', 'c', 'o']);
  assert.deepEqual(filterMentionables(people, '').map((person) => person.ref), ['c', 'l', 'o', 'u']);
  assert.deepEqual(filterMentionables(people, 'user').map((person) => person.ref), ['u'], 'a later word matches');
  assert.deepEqual(filterMentionables(people, 'zz'), []);
  assert.equal(filterMentionables(people, '', { limit: 2 }).length, 2);
});
