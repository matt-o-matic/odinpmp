import assert from 'node:assert/strict';
import test from 'node:test';

import { createReviewSession } from '../src/lib/requirements/review-session.js';

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    clear(id) { pending.delete(id); },
    async fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
      await settle();
    },
    pending,
    set(callback) { const id = nextId++; pending.set(id, callback); return id; },
  };
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

const pinShape = (x, number = 1) => ({ number, schemaVersion: 1, style: { color: '#c2410c', stroke: 3 }, type: 'pin', x, y: 50 });

function reviewState(overrides = {}) {
  return {
    annotations: [],
    answers: {},
    directions: {},
    me: { actorRef: 'person:me', canSubmit: true, isReviewer: true, name: 'Ravi Shah', position: { screenId: 'flow', step: 'screens' }, submittedAt: null },
    package: { feedbackDimensions: [{ key: 'type', label: 'Type & size' }], manifest: { sections: [{ id: 'd', items: [{ id: 'a', title: 'A', summary: '' }], type: 'directions' }] } },
    previousAnswers: {},
    questions: [{ id: 'q1', kind: 'text', prompt: 'Why?' }, { id: 'q2', kind: 'single', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], prompt: 'OK?' }],
    round: { id: 'r1', readOnly: false, status: 'open', title: 'Round' },
    screens: [{ kind: 'image', screenId: 'home', title: 'Home' }, { kind: 'prototype', screenId: 'flow', title: 'Flow' }],
    verdicts: {},
    ...overrides,
  };
}

function fakeAdapter(initial = reviewState()) {
  const calls = [];
  let current = initial;
  const failures = new Map();
  const adapter = {
    calls,
    failNext(name, error) { failures.set(name, error); },
    listen: () => () => {},
    async load() { calls.push(['load']); return structuredClone(current); },
    scope: { roundId: 'r1' },
    setServer(next) { current = next; },
  };
  const record = (name, result = { ok: true }) => async (...args) => {
    calls.push([name, ...args]);
    if (failures.has(name)) {
      const error = failures.get(name);
      failures.delete(name);
      throw error;
    }
    return typeof result === 'function' ? result(...args) : result;
  };
  Object.assign(adapter, {
    addComment: record('addComment', (id) => ({ annotation: { ...current.annotations.find((entry) => entry.id === id), thread: [{ body: 'Hi', id: 'c1', isMine: true }] }, ok: true })),
    clearAnswer: record('clearAnswer'),
    clearDirection: record('clearDirection'),
    clearVerdict: record('clearVerdict'),
    deleteAnnotation: record('deleteAnnotation'),
    saveAnnotation: record('saveAnnotation', (id, payload) => {
      const annotation = { actions: { edit: true, comment: true }, authorName: 'Ravi Shah', authorRef: 'person:me', id, isMine: true, number: 7, screenId: payload.screenId, shapes: payload.shapes.map((shape) => (shape.type === 'pin' ? { ...shape, number: 7 } : shape)), snapshotFileId: payload.snapshotFileId, stateKey: payload.stateKey, status: 'open', thread: [] };
      current = { ...current, annotations: [...current.annotations.filter((entry) => entry.id !== id), annotation] };
      return { annotation, created: true, ok: true };
    }),
    saveAnswer: record('saveAnswer', (id, value) => ({ answer: { text: String(value), value }, ok: true })),
    saveDirection: record('saveDirection'),
    savePosition: record('savePosition'),
    saveVerdict: record('saveVerdict'),
    submit: record('submit', () => ({ ok: true, submittedAt: '2026-10-07T11:04:00.000Z' })),
    uploadSnapshot: record('uploadSnapshot', () => ({ height: 800, ok: true, snapshotFileId: 'snap-server', url: '/api/x', width: 1280 })),
  });
  return adapter;
}

const names = (adapter) => adapter.calls.map((call) => call[0]);
const offline = () => Object.assign(new Error('offline'), { status: 0 });

test('loading resumes at the saved position', async () => {
  const adapter = fakeAdapter();
  const session = createReviewSession({ adapter, timers: fakeTimers() });
  await session.load();
  assert.equal(session.state.position.step, 'screens');
  assert.equal(session.state.position.screenId, 'flow');
  assert.deepEqual(session.state.visited, ['overview', 'screens']);
  assert.equal(session.canRespond(), true);
});

test('verdicts save at once; notes and aspects wait for an overall verdict', async () => {
  const adapter = fakeAdapter();
  const session = createReviewSession({ adapter, timers: fakeTimers() });
  await session.load();
  session.setNote('home', 'change', 'Price needs before tax');
  session.commitNotes('home');
  session.setAspect('home', 'type', 'keep');
  await settle();
  assert.ok(!names(adapter).includes('saveVerdict'));
  assert.equal(session.isHeld('verdict:home'), true);
  assert.equal(session.progress().screens.done, 0, 'notes alone are not a verdict');

  session.setOverall('home', 'keep-with-changes');
  await settle();
  const save = adapter.calls.find((call) => call[0] === 'saveVerdict');
  assert.deepEqual(save, ['saveVerdict', 'home', { change: 'Price needs before tax', dimensions: { type: 'keep' }, mixed: '', overall: 'keep-with-changes', stay: '' }]);
  assert.equal(session.isHeld('verdict:home'), false);
  assert.equal(session.progress().screens.done, 1);
  assert.equal(session.state.save.state, 'saved');
});

test('a failed save keeps the local choice through a refetch and Retry sends it', async () => {
  const adapter = fakeAdapter();
  const session = createReviewSession({ adapter, timers: fakeTimers() });
  await session.load();
  adapter.failNext('saveDirection', offline());
  session.setStance('a', 'preferred');
  await settle();
  assert.equal(session.state.save.state, 'error');
  await session.refresh();
  assert.equal(session.state.stances.a.stance, 'preferred', 'the refetch did not wipe the unsaved stance');
  session.retry();
  await settle();
  assert.equal(names(adapter).filter((name) => name === 'saveDirection').length, 2);
  assert.equal(session.state.save.state, 'saved');
});

test('a rejected change is dropped with a message instead of retried forever', async () => {
  const adapter = fakeAdapter();
  const session = createReviewSession({ adapter, timers: fakeTimers() });
  await session.load();
  adapter.failNext('saveAnswer', Object.assign(new Error('Request failed.'), { data: { details: { code: 'answer_invalid' }, error: 'Choose one of the question\'s options.' }, status: 400 }));
  session.setAnswer('q2', 'yes');
  await settle();
  assert.notEqual(session.state.save.state, 'error', 'nothing is left failing');
  assert.match(session.state.rejection, /Choose one/);
});

test('an answer to a question removed while the review was open says so, and the refetch shows it removed', async () => {
  const adapter = fakeAdapter();
  const session = createReviewSession({ adapter, timers: fakeTimers() });
  await session.load();
  // The team deletes the question's topic; the server refuses the answer and now lists it as removed.
  adapter.setServer(reviewState({ questions: reviewState().questions.map((question) => ({ ...question, removed: question.id === 'q2' })) }));
  adapter.failNext('saveAnswer', Object.assign(new Error('Request failed.'), {
    data: { details: { code: 'question_removed', message: 'This question has been removed and no longer needs an answer.' }, error: 'This question has been removed and no longer needs an answer.' },
    status: 409,
  }));
  session.setAnswer('q2', 'yes');
  await settle();
  assert.notEqual(session.state.save.state, 'error', 'the refused answer is not kept for Retry');
  assert.equal(session.state.rejection, 'This question has been removed and no longer needs an answer.');
  assert.equal(session.state.content.questions.find((question) => question.id === 'q2').removed, true);
  assert.deepEqual(session.progress().questions, { done: 0, total: 1 });
});

test('text answers save on blur and do not count while being typed', async () => {
  const adapter = fakeAdapter();
  const session = createReviewSession({ adapter, timers: fakeTimers() });
  await session.load();
  session.setAnswer('q1', '24 hours', { commit: false });
  assert.equal(session.progress().questions.done, 0);
  assert.ok(!names(adapter).includes('saveAnswer'));
  session.commitAnswer('q1');
  await settle();
  assert.deepEqual(adapter.calls.find((call) => call[0] === 'saveAnswer'), ['saveAnswer', 'q1', '24 hours']);
  assert.equal(session.progress().questions.done, 1);
  session.setAnswer('q2', 'maybe');
  assert.equal(session.state.answers.q2, undefined, 'an invalid choice is not kept');
  session.clearAnswer('q1');
  await settle();
  assert.ok(names(adapter).includes('clearAnswer'));
});

test('marks save with server numbers; edits coalesce; an unsaved mark deletes without a request', async () => {
  const timers = fakeTimers();
  const adapter = fakeAdapter();
  const session = createReviewSession({ adapter, timers });
  await session.load();
  const surface = { bounds: { height: 800, width: 1280 }, screenId: 'home' };
  session.createAnnotation(surface, { id: '11111111-1111-4111-8111-111111111111', number: 1, shapes: [pinShape(100)] });
  await settle();
  const saved = session.findAnnotation('11111111-1111-4111-8111-111111111111');
  assert.equal(saved.number, 7);
  assert.equal(saved.shapes[0].number, 7);
  assert.equal(saved.localOnly, false);

  session.updateAnnotationShapes(saved.id, [pinShape(105, 7)]);
  session.updateAnnotationShapes(saved.id, [pinShape(110, 7)]);
  session.updateAnnotationShapes(saved.id, [pinShape(115, 7)]);
  assert.equal(names(adapter).filter((name) => name === 'saveAnnotation').length, 1);
  await timers.fire();
  const saves = adapter.calls.filter((call) => call[0] === 'saveAnnotation');
  assert.equal(saves.length, 2, 'three nudges become one save');
  assert.equal(saves[1][2].shapes[0].x, 115);

  adapter.failNext('saveAnnotation', offline());
  session.createAnnotation(surface, { id: '22222222-2222-4222-8222-222222222222', number: 2, shapes: [pinShape(300)] });
  await settle();
  assert.equal(session.state.save.state, 'error');
  assert.ok(session.findAnnotation('22222222-2222-4222-8222-222222222222'), 'the unsaved mark stays on screen');
  session.deleteAnnotation('22222222-2222-4222-8222-222222222222');
  await settle();
  assert.ok(!names(adapter).includes('deleteAnnotation'), 'the server never saw it');
  assert.equal(session.state.save.state, 'saved');

  session.deleteAnnotation(saved.id);
  await settle();
  assert.deepEqual(adapter.calls.at(-1), ['deleteAnnotation', saved.id]);
});

test('focusMark opens the screens step on a mark’s screen and state, for links from Marks and comments', async () => {
  const mark = { actions: { comment: true }, authorName: 'Jamie', authorRef: 'stakeholder:jamie', id: 'm1', isMine: false, number: 4, screenId: 'flow', shapes: [pinShape(10)], snapshotFileId: null, stateKey: 'pick-time', status: 'open', thread: [] };
  const adapter = fakeAdapter(reviewState({ annotations: [mark], me: { ...reviewState().me, position: { step: 'overview' } } }));
  const session = createReviewSession({ adapter, timers: fakeTimers() });
  await session.load();
  assert.equal(session.state.position.step, 'overview');
  assert.equal(session.focusMark('nope'), false);
  assert.equal(session.focusMark('m1'), true);
  assert.deepEqual([session.state.position.step, session.state.position.screenId, session.state.position.stateKey], ['screens', 'flow', 'pick-time']);
  assert.equal(session.state.focusMarkId, 'm1');
});

test('a prototype mark uploads its snapshot first and records the element hint', async () => {
  const adapter = fakeAdapter();
  const session = createReviewSession({ adapter, timers: fakeTimers() });
  await session.load();
  const snapshot = session.addSnapshot({ dataUrl: `data:image/png;base64,${Buffer.from('png').toString('base64')}`, height: 800, stateKey: 'pick-time', width: 1280 });
  const hint = Promise.resolve({ box: { height: 40, width: 300, x: 10, y: 20 }, odinId: 'slot-day', tag: 'div', text: 'Mon 13' });
  session.createAnnotation({ bounds: { height: 800, width: 1280 }, screenId: 'flow', snapshot }, { hint, id: '33333333-3333-4333-8333-333333333333', number: 1, shapes: [pinShape(40)] });
  await settle();
  const upload = adapter.calls.find((call) => call[0] === 'uploadSnapshot');
  assert.equal(upload[2].screenId, 'flow');
  assert.equal(upload[2].stateKey, 'pick-time');
  const payload = adapter.calls.find((call) => call[0] === 'saveAnnotation')[2];
  assert.equal(payload.snapshotFileId, 'snap-server');
  assert.equal(payload.stateKey, 'pick-time');
  assert.equal(payload.elementHint.odinId, 'slot-day');
  assert.deepEqual(names(adapter).filter((name) => ['uploadSnapshot', 'saveAnnotation'].includes(name)), ['uploadSnapshot', 'saveAnnotation']);

  // A second mark on the same snapshot, after the upload finished, carries the stored snapshot too.
  session.createAnnotation({ bounds: { height: 800, width: 1280 }, screenId: 'flow', snapshot }, { id: '55555555-5555-4555-8555-555555555555', number: 3, shapes: [pinShape(80)] });
  await settle();
  const second = adapter.calls.filter((call) => call[0] === 'saveAnnotation').at(-1);
  assert.equal(second[1], '55555555-5555-4555-8555-555555555555');
  assert.equal(second[2].snapshotFileId, 'snap-server');
  assert.equal(adapter.calls.filter((call) => call[0] === 'uploadSnapshot').length, 1, 'the snapshot uploads once');

  // Capture failed: a blank frame of the declared viewport, with a note.
  session.createAnnotation({ bounds: { height: 800, width: 1280 }, screenId: 'flow', snapshot: { stateKey: 'confirm', unavailable: true } }, { id: '44444444-4444-4444-8444-444444444444', number: 2, shapes: [pinShape(60)] });
  await settle();
  const blank = adapter.calls.filter((call) => call[0] === 'saveAnnotation').at(-1)[2];
  assert.deepEqual(blank.anchor, { note: 'Snapshot unavailable', snapshotUnavailable: true });
  assert.equal(blank.snapshotFileId, null);
  assert.equal(blank.stateKey, 'confirm');
});

test('a comment on a new mark waits for the mark to save', async () => {
  const timers = fakeTimers();
  const adapter = fakeAdapter();
  const session = createReviewSession({ adapter, timers });
  await session.load();
  session.createAnnotation({ bounds: { height: 800, width: 1280 }, screenId: 'home' }, { id: '55555555-5555-4555-8555-555555555555', number: 1, shapes: [pinShape(10)] });
  session.updateAnnotationShapes('55555555-5555-4555-8555-555555555555', [pinShape(12)]);
  await session.addComment('55555555-5555-4555-8555-555555555555', { body: 'Hi' });
  const order = names(adapter).filter((name) => ['saveAnnotation', 'addComment'].includes(name));
  assert.deepEqual(order, ['saveAnnotation', 'saveAnnotation', 'addComment']);
  assert.equal(session.findAnnotation('55555555-5555-4555-8555-555555555555').thread.length, 1);
});

test('position saves are coalesced, and submit flushes everything first', async () => {
  const timers = fakeTimers();
  const adapter = fakeAdapter();
  const session = createReviewSession({ adapter, timers });
  await session.load();
  session.goTo({ step: 'questions' });
  session.goTo({ step: 'submit' });
  assert.ok(!names(adapter).includes('savePosition'));
  const ok = await session.submit();
  assert.equal(ok, true);
  assert.deepEqual(adapter.calls.filter((call) => call[0] === 'savePosition'), [['savePosition', { step: 'submit' }]]);
  assert.equal(session.state.submittedAt, '2026-10-07T11:04:00.000Z');
});

test('a refetch keeps the screen addresses in use while their grant is valid', async () => {
  const adapter = fakeAdapter(reviewState({
    grant: { expiresAt: '2026-10-07T12:00:00.000Z' },
    screens: [{ entryUrl: 'https://review.example/p/1/grant-a/home.png', kind: 'image', screenId: 'home', title: 'Home' }],
  }));
  let clock = new Date('2026-10-07T10:00:00.000Z');
  const session = createReviewSession({ adapter, now: () => clock, timers: fakeTimers() });
  await session.load();
  adapter.setServer(reviewState({
    grant: { expiresAt: '2026-10-07T12:05:00.000Z' },
    screens: [{ entryUrl: 'https://review.example/p/1/grant-b/home.png', kind: 'image', screenId: 'home', title: 'Home' }],
  }));
  await session.refresh();
  assert.equal(session.state.content.screens[0].entryUrl, 'https://review.example/p/1/grant-a/home.png', 'a live update does not reload the screen');
  clock = new Date('2026-10-07T11:55:00.000Z');
  await session.refresh();
  assert.equal(session.state.content.screens[0].entryUrl, 'https://review.example/p/1/grant-b/home.png', 'a grant about to expire is replaced');
});

test('a closed round is read-only', async () => {
  const adapter = fakeAdapter(reviewState({ round: { id: 'r1', readOnly: true, status: 'closed' } }));
  const session = createReviewSession({ adapter, timers: fakeTimers() });
  await session.load();
  assert.equal(session.readOnly(), true);
  session.setOverall('home', 'keep');
  session.setAnswer('q2', 'yes');
  session.createAnnotation({ bounds: { height: 800, width: 1280 }, screenId: 'home' }, { id: '66666666-6666-4666-8666-666666666666', number: 1, shapes: [pinShape(10)] });
  await settle();
  assert.deepEqual(names(adapter), ['load']);
});

test('an expired link mid-review hands over to the portal', async () => {
  const adapter = fakeAdapter();
  const problems = [];
  const session = createReviewSession({ adapter, onLinkProblem: (error) => problems.push(error.status), timers: fakeTimers() });
  await session.load();
  adapter.failNext('saveVerdict', Object.assign(new Error('link_expired'), { data: { details: { code: 'link_expired' } }, status: 410 }));
  session.setOverall('home', 'keep');
  await settle();
  assert.deepEqual(problems, [410]);
});
