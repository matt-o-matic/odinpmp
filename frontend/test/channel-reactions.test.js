import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  QUICK_REACTIONS,
  buildEmojiCatalog,
  quoteFor,
  quoteText,
  reactionButtonLabel,
  searchEmoji,
  toggledReactions,
  whoReacted,
  withReactions,
} from '../src/lib/channels/reactions.js';

const compact = JSON.parse(readFileSync(new URL('../node_modules/emojibase-data/en/compact.json', import.meta.url), 'utf8'));

test('the catalogue groups emoji in emojibase order, without skin tone parts or lone letters', () => {
  const groups = buildEmojiCatalog(compact);
  assert.deepEqual(groups.map((group) => group.label), ['Smileys and emotion', 'People and body', 'Animals and nature', 'Food and drink', 'Travel and places', 'Activities', 'Objects', 'Symbols', 'Flags']);
  assert.equal(groups[0].emoji[0].emoji, '😀');
  const all = groups.flatMap((group) => group.emoji.map((entry) => entry.emoji));
  assert.ok(all.length > 1800);
  assert.ok(!all.includes('🏻'), 'no bare skin tone');
  assert.ok(!all.includes('🇦'), 'no lone flag letter');
  for (const { emoji } of QUICK_REACTIONS) assert.ok(all.includes(emoji), `${emoji} is in the catalogue`);
});

test('search matches the start of each word typed, names before keywords', () => {
  const groups = buildEmojiCatalog(compact);
  assert.equal(searchEmoji(groups, 'thumbs up')[0].emoji, '👍');
  assert.equal(searchEmoji(groups, 'pizza')[0].emoji, '🍕');
  assert.ok(searchEmoji(groups, 'tada').some((entry) => entry.emoji === '🎉'), 'by keyword');
  assert.deepEqual(searchEmoji(groups, ''), []);
  assert.deepEqual(searchEmoji(groups, 'zzzqqq'), []);
  assert.equal(searchEmoji(groups, 'face', 5).length, 5);
});

test('who reacted puts you first and counts the rest', () => {
  const people = (...names) => names.map((name) => ({ id: name, name, ...(name === 'Mo' ? { isViewer: true } : {}) }));
  assert.equal(whoReacted({ count: 1, mine: true, people: people('Mo') }), 'You');
  assert.equal(whoReacted({ count: 2, mine: true, people: people('Olu', 'Mo') }), 'You and Olu');
  assert.equal(whoReacted({ count: 3, mine: false, people: people('Olu', 'Lena', 'Ada') }), 'Olu, Lena and Ada');
  assert.equal(whoReacted({ count: 25, mine: true, people: people('Olu', 'Mo', 'Lena', 'Ada') }), 'You, Olu, Lena and 22 others');
  assert.equal(reactionButtonLabel({ count: 2, emoji: '👍', mine: true, people: people('Olu', 'Mo') }), '👍 2 people: You and Olu. Remove your reaction');
  assert.equal(reactionButtonLabel({ count: 1, emoji: '🎉', mine: false, people: people('Olu') }), '🎉 1 person: Olu. Add yours');
});

test('a toggle shows at once, and reactions land on the post or reply they belong to', () => {
  const start = [{ count: 1, emoji: '👍', mine: false, people: [{ id: 'o', name: 'Olu' }] }];
  const added = toggledReactions(start, '👍', true);
  assert.deepEqual(added.map(({ count, mine }) => [count, mine]), [[2, true]]);
  assert.equal(toggledReactions(added, '👍', true), added, 'already mine');
  assert.deepEqual(toggledReactions(added, '👍', false), [{ count: 1, emoji: '👍', mine: false, people: [{ id: 'o', name: 'Olu' }] }]);
  assert.deepEqual(toggledReactions(start, '🎉', true).map((reaction) => reaction.emoji), ['👍', '🎉']);
  assert.deepEqual(toggledReactions(toggledReactions([], '🎉', true), '🎉', false), [], 'the last one goes');

  const posts = [{ id: 'a', reactions: [], replies: [{ id: 'b', reactions: [] }] }, { id: 'c', reactions: [] }];
  assert.deepEqual(withReactions(posts, 'b', start)[0].replies[0].reactions, start);
  assert.deepEqual(withReactions(posts, 'c', start)[1].reactions, start);
  assert.equal(withReactions(posts, 'c', start)[0], posts[0], 'others are untouched');
});

test('a quote is one line of plain text, tags as @Name, cut at a word', () => {
  assert.equal(quoteText('Add the **budget** review to @[Olu Other](user:u-1)\n\n> and _risks_'), 'Add the budget review to @Olu Other and risks');
  assert.equal(quoteText('See [the plan](https://x.test/p) and `npm test`'), 'See the plan and npm test');
  assert.equal(quoteText('```js\nconst a = 1;\n```\nDone'), '[code] Done');
  const long = quoteText('word '.repeat(40), 30);
  assert.ok(long.endsWith('…') && long.length <= 31 && !long.includes('wo…'));

  const thread = [
    { author: { name: 'Olu Other' }, body: 'Add the **budget** review', id: 'r1' },
    { author: { name: 'Lena Lead' }, body: '', deleted: true, id: 'r2' },
    { attachments: [{ id: 'f' }], author: { name: 'Ada' }, body: '', id: 'r3' },
  ];
  assert.deepEqual(quoteFor({ replyToId: 'r1' }, thread), { author: 'Olu Other', id: 'r1', text: 'Add the budget review' });
  assert.deepEqual(quoteFor({ replyToId: 'r2' }, thread), { deleted: true, id: 'r2' });
  assert.equal(quoteFor({ replyToId: 'r3' }, thread).text, 'Attachment');
  assert.deepEqual(quoteFor({ replyToId: 'gone' }, thread), { id: 'gone', missing: true });
  assert.equal(quoteFor({ replyToId: null }, thread), null);
});
