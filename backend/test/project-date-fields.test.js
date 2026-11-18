import assert from 'node:assert/strict';
import test from 'node:test';

import { dateOnlyValue } from '../src/modules/projects/projects.repository.js';
import { projectItemUpdateSchema } from '../src/modules/projects/projects.schema.js';

test('DATE columns read from mysql2 leave the repository as YYYY-MM-DD', () => {
  assert.equal(dateOnlyValue(new Date(2026, 9, 26)), '2026-10-26');
  assert.equal(dateOnlyValue('2026-10-26T00:00:00.000Z'), '2026-10-26');
  assert.equal(dateOnlyValue('2026-10-26'), '2026-10-26');
  assert.equal(dateOnlyValue(null), null);
  assert.equal(dateOnlyValue(''), null);
  assert.equal(dateOnlyValue(new Date('nope')), null);
});

test('an item patch that carries a timestamp date still saves hours and points', () => {
  const parsed = projectItemUpdateSchema.parse({
    expectedVersion: 7,
    patch: {
      name: 'SEO migration and launch-critical content',
      points: 1,
      targetEndDate: '2026-10-30T00:00:00.000Z',
      targetHourEstimate: 5,
      targetStartDate: '2026-10-26T00:00:00.000Z',
    },
  });

  assert.equal(parsed.patch.targetStartDate, '2026-10-26');
  assert.equal(parsed.patch.targetEndDate, '2026-10-30');
  assert.equal(parsed.patch.targetHourEstimate, 5);
  assert.throws(() => projectItemUpdateSchema.parse({ expectedVersion: 1, patch: { name: 'x', targetStartDate: '10/26/2026' } }));
});
