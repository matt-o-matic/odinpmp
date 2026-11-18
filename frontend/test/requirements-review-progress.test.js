import assert from 'node:assert/strict';
import test from 'node:test';

import {
  answerableQuestions,
  answerText,
  aspectSummary,
  buildSubmitSummary,
  computeProgress,
  directionSentence,
  normalizePosition,
  positionPayload,
  previousAnswerLine,
  progressPercent,
  reviewContent,
  reviewSteps,
  scaleSteps,
  stepDone,
  validateAnswer,
  verdictChipClass,
  verdictLabel,
} from '../src/lib/requirements/review-progress.js';

const manifest = {
  sections: [
    { body: 'What we heard.', id: 'context', type: 'context' },
    {
      id: 'directions',
      items: [
        { id: 'action-first', summary: 'Book first.', title: 'Action first' },
        { id: 'schedule-first', summary: 'Calendar first.', title: 'Schedule first' },
      ],
      type: 'directions',
    },
    { body: 'Not payments.', id: 'boundaries', type: 'boundaries' },
  ],
  summary: 'Round 2.',
  title: 'Client booking',
};

const state = {
  package: { feedbackDimensions: [{ key: 'type', label: 'Type & size' }, { key: 'hierarchy', label: 'Hierarchy & navigation' }], manifest },
  questions: [
    { id: 'price', kind: 'single', options: [{ id: 'home', label: 'On home' }, { id: 'later', label: 'Later' }], prompt: 'Where should the price appear?' },
    { id: 'channels', kind: 'multi', options: [{ id: 'sms', label: 'Text message' }, { id: 'email', label: 'Email' }, { id: 'call', label: 'Phone call' }], prompt: 'Which reminders?' },
    { id: 'notice', kind: 'text', prompt: 'How much notice?' },
    { id: 'speed', kind: 'scale', prompt: 'How quick?', scale: { max: 5, maxLabel: 'Very quick', min: 1, minLabel: 'Slow' } },
  ],
  round: { title: 'Client booking' },
  screens: [
    { directionId: 'action-first', kind: 'image', screenId: 'home', title: 'Booking home' },
    { kind: 'prototype', screenId: 'flow', title: 'Booking flow' },
    { kind: 'image', screenId: 'confirm', title: 'Confirm' },
  ],
};

test('reviewContent reads directions, screens, and sections, lettering directions', () => {
  const content = reviewContent(state);
  assert.deepEqual(content.directions.map((direction) => `${direction.letter}:${direction.id}`), ['A:action-first', 'B:schedule-first']);
  assert.equal(content.screens[0].id, 'home');
  assert.equal(content.screens[0].direction.title, 'Action first');
  assert.equal(content.context.body, 'What we heard.');
  assert.equal(content.boundaries, 'Not payments.');
  assert.equal(content.title, 'Client booking');
});

test('steps skip Directions and Questions when the round has none', () => {
  const content = reviewContent(state);
  assert.deepEqual(reviewSteps(content).map((step) => `${step.number}.${step.label}`), ['1.Overview', '2.Directions', '3.Screens', '4.Questions', '5.Submit']);
  assert.deepEqual(reviewSteps({ directions: [], questions: [], screens: [{ id: 'a' }] }).map((step) => step.id), ['overview', 'screens', 'submit']);
});

test('a saved position resumes where the reviewer was, and an unknown one falls back', () => {
  const content = reviewContent(state);
  assert.deepEqual(normalizePosition({ screenId: 'flow', stateKey: 'pick-time', step: 'screens' }, content), {
    directionId: null, questionId: null, screenId: 'flow', stateKey: 'pick-time', step: 'screens',
  });
  const fallback = normalizePosition({ screenId: 'gone', step: 'flows' }, content);
  assert.equal(fallback.step, 'overview');
  assert.equal(fallback.screenId, 'home');
  assert.deepEqual(positionPayload({ screenId: 'flow', stateKey: 'pick-time', step: 'screens' }), { screenId: 'flow', stateKey: 'pick-time', step: 'screens' });
  assert.deepEqual(positionPayload({ screenId: 'flow', step: 'questions' }), { step: 'questions' });
});

test('progress counts stances, overall verdicts, and answers in this round only', () => {
  const content = reviewContent(state);
  const progress = computeProgress({
    answers: { price: { value: 'home' } },
    content,
    stances: { 'action-first': { stance: 'preferred' } },
    verdicts: { flow: { dimensions: { type: 'keep' } }, home: { overall: 'undecided' } },
  });
  assert.deepEqual(progress.directions, { done: 1, total: 2 });
  assert.deepEqual(progress.screens, { done: 1, total: 3 }, 'aspects alone are not a verdict; Undecided is');
  assert.deepEqual(progress.questions, { done: 1, total: 4 });
  assert.equal(progress.done, 3);
  assert.equal(progress.total, 9);
  assert.equal(progressPercent(progress), 33);
  assert.equal(progressPercent({ done: 0, total: 0 }), 0);
  assert.equal(stepDone('directions', { progress }), false);
  assert.equal(stepDone('overview', { visited: ['overview'] }), false);
  assert.equal(stepDone('overview', { visited: ['overview', 'directions'] }), true);
  assert.equal(stepDone('submit', { submittedAt: '2026-10-07T10:00:00Z' }), true);
});

test('a removed question counts nowhere: not in progress, the submit summary, or the questions still asked', () => {
  const removedState = { ...state, questions: state.questions.map((question) => ({ ...question, removed: question.id === 'speed' })) };
  const content = reviewContent(removedState);
  assert.deepEqual(answerableQuestions(content).map((question) => question.id), ['price', 'channels', 'notice']);
  assert.equal(content.questions.length, 4, 'the step still lists it, to say it was removed');
  const answers = { price: { value: 'home' }, speed: { value: 4 } };
  assert.deepEqual(computeProgress({ answers, content }).questions, { done: 1, total: 3 });
  const summary = buildSubmitSummary({ answers, content });
  assert.deepEqual(summary.questions.map((question) => question.id), ['price', 'channels', 'notice']);
  assert.equal(summary.answeredCount, 1);
});

test('answers are checked by kind, matching the server', () => {
  const [single, multi, text, scale] = state.questions;
  assert.deepEqual(validateAnswer(single, 'home'), { ok: true, value: 'home' });
  assert.equal(validateAnswer(single, 'nowhere').ok, false);
  assert.equal(validateAnswer(single, ['home']).ok, false);
  assert.deepEqual(validateAnswer(multi, ['call', 'sms']), { ok: true, value: ['sms', 'call'] }, 'options keep manifest order');
  assert.equal(validateAnswer(multi, []).message, 'Choose at least one option.');
  assert.equal(validateAnswer(multi, ['sms', 'sms']).ok, false);
  assert.equal(validateAnswer(multi, ['fax']).ok, false);
  assert.deepEqual(validateAnswer(text, '  24 hours  '), { ok: true, value: '24 hours' });
  assert.equal(validateAnswer(text, '   ').message, 'Write an answer.');
  assert.equal(validateAnswer(text, 'x'.repeat(4001)).ok, false);
  assert.deepEqual(validateAnswer(scale, 4), { ok: true, value: 4 });
  assert.equal(validateAnswer(scale, 6).ok, false);
  assert.equal(validateAnswer(scale, 2.5).ok, false);
  assert.equal(validateAnswer(scale, '3').ok, false);
  assert.equal(validateAnswer({ kind: 'unknown' }, 'x').ok, false);
});

test('answer text reads back each kind', () => {
  const [single, multi, text, scale] = state.questions;
  assert.equal(answerText(single, 'home'), 'On home');
  assert.equal(answerText(multi, ['sms', 'email']), 'Text message, Email');
  assert.equal(answerText(text, '24 hours'), '24 hours');
  assert.equal(answerText(scale, 5), '5 of 5 (Very quick)');
  assert.equal(answerText(scale, 3), '3 of 5');
  assert.equal(answerText(single, null), '');
  assert.deepEqual(scaleSteps(scale.scale).map((step) => `${step.value}${step.label ? `:${step.label}` : ''}`), ['1:Slow', '2', '3', '4', '5:Very quick']);
  assert.deepEqual(scaleSteps({ max: 1, min: 3 }), []);
  assert.equal(previousAnswerLine({ packageVersion: 2, roundNumber: 2, text: 'On home' }), 'You answered “On home” on version 2.');
});

test('labels default to Not reviewed and aspects summarize Change first', () => {
  assert.equal(verdictLabel('keep-with-changes'), 'Keep with changes');
  assert.equal(verdictLabel(null), 'Not reviewed');
  assert.equal(verdictChipClass(null), 'rq-chip--outline');
  assert.equal(verdictChipClass('change'), 'rq-chip--warn');
  const dimensions = state.package.feedbackDimensions;
  assert.equal(aspectSummary({ dimensions: { hierarchy: 'change', type: 'keep' } }, dimensions), 'hierarchy & navigation: change');
  assert.equal(aspectSummary({ dimensions: { type: 'keep' } }, dimensions), 'type & size: keep');
  assert.equal(aspectSummary({ dimensions: {} }, dimensions), '');
});

test('the submit summary marks anything untouched as Not reviewed or not answered', () => {
  const content = reviewContent(state);
  const summary = buildSubmitSummary({
    answers: { price: { text: 'On home', value: 'home' }, speed: { value: 4 } },
    content,
    marksByScreen: { flow: 2, home: 3 },
    stances: { 'action-first': { stance: 'preferred' }, 'schedule-first': { remix: 'the week calendar', stance: 'acceptable' } },
    verdicts: { flow: { dimensions: { hierarchy: 'change' }, overall: 'change' }, home: { dimensions: {}, overall: 'keep-with-changes' } },
  });
  assert.deepEqual(summary.screens.map((screen) => [screen.title, screen.label, screen.notReviewed, screen.detail]), [
    ['Booking home', 'Keep with changes', false, '3 marks'],
    ['Booking flow', 'Change', false, '2 marks · hierarchy & navigation: change'],
    ['Confirm', 'Not reviewed', true, 'You haven’t looked at this screen'],
  ]);
  assert.equal(summary.notReviewedScreens, 1);
  assert.equal(summary.answeredCount, 2);
  assert.deepEqual(summary.questions.map((question) => [question.id, question.answered, question.text]), [
    ['price', true, 'On home'], ['channels', false, ''], ['notice', false, ''], ['speed', true, '4 of 5'],
  ]);
  assert.equal(summary.directionLine, 'You prefer A · Action first; B · Schedule first is acceptable.');
  assert.deepEqual(summary.remixes.map((entry) => entry.remix), ['the week calendar']);
});

test('the direction sentence names directions that were not reviewed', () => {
  assert.equal(directionSentence([{ letter: 'A', stance: 'rejected', title: 'One' }, { letter: 'B', stance: null, title: 'Two' }]), 'You rejected A · One; B · Two is not reviewed.');
  assert.equal(directionSentence([]), '');
});
