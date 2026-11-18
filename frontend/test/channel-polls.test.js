import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POLL_OPTIONS_MAX,
  answerDraft,
  answerPayload,
  closingLabel,
  kindLabel,
  moveEntry,
  newPollDraft,
  percent,
  pollPayload,
  takesOptions,
  votesLabel,
  withOption,
  withoutOption,
  withPreset,
} from '../src/lib/channels/polls.js';

// The composer's poll and a post's voting form (lib/channels/polls.js). The server checks each
// poll and vote again (backend/test/polls.test.js).

const now = new Date('2026-11-15T12:00:00Z');
const labelled = (draft, labels) => ({ ...draft, options: labels.map((label, index) => ({ key: `k${index}`, label })) });

test('the composer sends a tidy poll, or says what to fix first', () => {
  const draft = labelled({ ...newPollDraft(), question: '  Kick-off   day? ' }, [' Monday ', 'Tuesday', '']);
  assert.deepEqual(pollPayload(draft, { now }), { poll: { kind: 'single', options: ['Monday', 'Tuesday'], question: 'Kick-off day?', settings: { anonymous: false, showResults: 'always' } } });
  assert.equal(pollPayload({ ...draft, question: ' ' }, { now }).error, 'Write the question.');
  assert.equal(pollPayload(labelled(draft, ['Only one']), { now }).error, 'Give at least 2 options.');
  assert.equal(pollPayload(labelled(draft, ['Yes', 'yes']), { now }).error, '"yes" is listed twice.');
  assert.equal(pollPayload({ ...draft, kind: 'multiple', maxChoices: '3' }, { now }).error, 'Allow from 1 to 2 choices.');
  assert.deepEqual(pollPayload({ ...draft, kind: 'multiple', maxChoices: '1' }, { now }).poll.settings, { anonymous: false, maxChoices: 1, showResults: 'always' });
  assert.equal(pollPayload({ ...draft, closesAt: '2026-11-15T11:00:00Z' }, { now }).error, 'Pick a closing time in the future.');
  assert.ok(pollPayload({ ...draft, closesAt: '2026-11-20T09:00' }, { now }).poll.closesAt);
  // Text and rating polls take no options, whatever the form still holds.
  assert.deepEqual(pollPayload({ ...draft, kind: 'text' }, { now }).poll.options, []);
  assert.deepEqual(pollPayload({ ...draft, anonymous: true, kind: 'rating', scaleMax: 10, showResults: 'after_vote' }, { now }).poll.settings, { anonymous: true, scaleMax: 10, showResults: 'after_vote' });
});

test('options are added up to 20, removed down to 2, moved, and filled by a preset', () => {
  let draft = newPollDraft();
  assert.equal(draft.options.length, 2);
  assert.equal(withoutOption(draft, draft.options[0].key), draft, 'never fewer than two');
  for (let index = 0; index < 30; index += 1) draft = withOption(draft);
  assert.equal(draft.options.length, POLL_OPTIONS_MAX);
  draft = withoutOption(draft, draft.options[5].key);
  assert.equal(draft.options.length, POLL_OPTIONS_MAX - 1);
  assert.deepEqual(moveEntry(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moveEntry(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
  const preset = withPreset({ ...newPollDraft(), kind: 'multiple' }, ['Yes', 'No', 'Maybe']);
  assert.deepEqual([preset.kind, preset.options.map((option) => option.label)], ['single', ['Yes', 'No', 'Maybe']]);
  assert.equal(takesOptions('ranking'), true);
  assert.equal(takesOptions('rating'), false);
  assert.equal(kindLabel('text'), 'Fill in the blank');
});

test('a post\'s voting form starts from the person\'s answer and sends only a complete one', () => {
  const options = [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }, { id: 'o3', label: 'C' }];
  const single = { kind: 'single', myAnswer: null, options, settings: {} };
  assert.deepEqual(answerDraft(single), { optionIds: [] });
  assert.equal(answerPayload(single, { optionIds: [] }), null);
  assert.deepEqual(answerPayload(single, { optionIds: ['o2'] }), { optionIds: ['o2'] });
  const multiple = { kind: 'multiple', myAnswer: { optionIds: ['o1'] }, options, settings: { maxChoices: 2 } };
  assert.deepEqual(answerDraft(multiple), { optionIds: ['o1'] });
  assert.equal(answerPayload(multiple, { optionIds: ['o1', 'o2', 'o3'] }), null);
  const ranking = { kind: 'ranking', myAnswer: null, options, settings: {} };
  assert.deepEqual(answerDraft(ranking), { order: ['o1', 'o2', 'o3'] }, 'starts in the listed order');
  assert.deepEqual(answerDraft({ ...ranking, myAnswer: { order: ['o3', 'o1', 'o2'] } }), { order: ['o3', 'o1', 'o2'] });
  const text = { kind: 'text', myAnswer: null, options: [], settings: {} };
  assert.equal(answerPayload(text, { text: '   ' }), null);
  assert.deepEqual(answerPayload(text, { text: ' Falcon  wing ' }), { text: 'Falcon wing' });
  const rating = { kind: 'rating', myAnswer: { value: 4 }, options: [], settings: { scaleMax: 5 } };
  assert.deepEqual(answerDraft(rating), { value: 4 });
  assert.equal(answerPayload(rating, { value: null }), null);
});

test('counts, shares and closing times read plainly', () => {
  assert.equal(percent(0.666), '67%');
  assert.equal(votesLabel(1), '1 person voted');
  assert.equal(votesLabel(0), '0 people voted');
  assert.equal(closingLabel({ closed: true }), 'Closed');
  assert.equal(closingLabel({ closesAt: null }), '');
  assert.equal(closingLabel({ closesAt: '2026-11-15T11:00:00Z' }, { now }), 'Closed');
  assert.match(closingLabel({ closesAt: '2026-11-16T15:00:00Z' }, { locale: 'en-US', now }), /^Closes Nov 16/);
});
