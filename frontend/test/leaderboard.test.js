import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  LEADERBOARD_PERIODS,
  avatarUrl,
  formatHours,
  leaderboardRows,
  positionSummary,
} from '../src/lib/metrics/leaderboard.js';

const viewSource = await readFile(new URL('../src/views/LeaderboardView.vue', import.meta.url), 'utf8');

test('the signed-in user is appended below the top ten when they rank lower', () => {
  const top = Array.from({ length: 10 }, (_, index) => ({ id: `user-${index}`, isCurrentUser: false, points: 50 - index, rank: index + 1 }));
  const current = { id: 'user-me', isCurrentUser: true, points: 1, rank: 14 };
  const rows = leaderboardRows({ currentUser: current, leaderboard: top });
  assert.equal(rows.length, 11);
  assert.deepEqual(rows.at(-1), { ...current, detached: true });
  assert.equal(rows.slice(0, 10).every((row) => row.detached === false), true);

  const inTop = leaderboardRows({ currentUser: { ...top[2], isCurrentUser: true }, leaderboard: top });
  assert.equal(inTop.length, 10, 'a user already in the top ten is not repeated');
  assert.deepEqual(leaderboardRows({}), []);
});

test('the position summary covers ranked and unranked users', () => {
  assert.equal(
    positionSummary({ contributorCount: 14, currentUser: { points: 1, rank: 14, tasksCompleted: 1 }, days: 7 }),
    'You are #14 of 14 with 1 point and 1 item done in the last 7 days.',
  );
  assert.equal(
    positionSummary({ contributorCount: 3, currentUser: { points: 8, rank: 1, tasksCompleted: 2 }, days: 30 }),
    'You are #1 of 3 with 8 points and 2 items done in the last 30 days.',
  );
  assert.equal(positionSummary({ currentUser: null, days: 90 }), 'You have no completed work in the last 90 days.');
});

test('hours and avatar paths are formatted for display', () => {
  assert.equal(formatHours(0), '0h');
  assert.equal(formatHours(1.5), '1.5h');
  assert.equal(formatHours(2.25), '2.25h');
  assert.equal(formatHours(null), '0h');
  assert.equal(avatarUrl('/images/users/ada.png', 'http://localhost:3001/'), 'http://localhost:3001/images/users/ada.png');
  assert.equal(avatarUrl('https://cdn.example/ada.png', 'http://localhost:3001'), 'https://cdn.example/ada.png');
  assert.equal(avatarUrl(null, 'http://localhost:3001'), '');
});

test('the leaderboard offers 7, 30, and 90 day periods as one radio group', () => {
  assert.deepEqual(LEADERBOARD_PERIODS.map((period) => period.days), [7, 30, 90]);
  assert.match(viewSource, /<fieldset class="leaderboard-periods">\s*<legend class="visually-hidden">Period<\/legend>/);
  assert.match(viewSource, /type="radio"/);
  assert.match(viewSource, /getContributorLeaderboard\(\{ days: days\.value \}/);
});

test('the leaderboard explains how points are earned and marks the signed-in user without relying on color', () => {
  assert.match(viewSource, /No completed work in the last \{\{ days \}\} days/);
  assert.match(viewSource, /How points are earned/);
  assert.match(viewSource, /<span v-if="row\.isCurrentUser" class="badge text-bg-primary">You<\/span>/);
  assert.match(viewSource, /:aria-current="row\.isCurrentUser \? 'true' : undefined"/);
  assert.doesNotMatch(viewSource, /\balert\(|\bconfirm\(|\stitle="/);
});
