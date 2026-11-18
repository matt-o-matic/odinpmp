// One reviewer's guided review: the round as loaded, the reviewer's local answers, verdicts,
// stances and marks, and how each change is saved. Every change shows at once and saves in
// the background (review-autosave.js); a refetch, for example after another reviewer's mark
// arrives, never overwrites a change that has not been saved yet.

import { inject, reactive } from 'vue';

import { describeRequirementsError, requirementsErrorCode } from './requirements-errors.js';
import {
  annotationPayload,
  dataUrlToBlob,
  localAnnotation,
  mergeAnnotationLists,
  nextLocalSnapshotId,
  numberShapes,
} from './review-annotations.js';
import { createAutosave } from './review-autosave.js';
import { batchTouchesRound } from './review-live.js';
import {
  answerText,
  computeProgress,
  normalizePosition,
  positionPayload,
  reviewContent,
  validateAnswer,
} from './review-progress.js';

export const REVIEW_SESSION_KEY = Symbol('requirements-review-session');

/** The session ReviewGuided provides to its steps. */
export function useReviewSession() {
  const session = inject(REVIEW_SESSION_KEY, null);
  if (!session) throw new Error('Review steps must render inside ReviewGuided.');
  return session;
}

// Where a mark opens in the team's Marks and comments view: `(markId) => route location`.
// Only the team's review provides it; the portal has no such view.
export const REVIEW_MARKS_LINK_KEY = Symbol('requirements-review-marks-link');

export function useMarksLink() {
  return inject(REVIEW_MARKS_LINK_KEY, null);
}

export const ANNOTATION_SAVE_DELAY_MS = 400;
export const POSITION_SAVE_DELAY_MS = 500;
// Screen addresses are kept until their grant has this long left.
export const GRANT_REUSE_MARGIN_MS = 10 * 60 * 1000;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function emptyVerdict() {
  return { change: '', dimensions: {}, mixed: '', overall: null, stay: '' };
}

function verdictFromServer(verdict) {
  if (!verdict) return emptyVerdict();
  return {
    change: verdict.change ?? '',
    dimensions: { ...(verdict.dimensions ?? {}) },
    mixed: verdict.mixed ?? '',
    overall: verdict.overall ?? null,
    stay: verdict.stay ?? '',
  };
}

function isPermanentFailure(error) {
  const status = Number(error?.status) || 0;
  return status >= 400 && status < 500 && ![401, 408, 429].includes(status);
}

/**
 * `adapter` comes from review-adapters.js. `onLinkProblem(error)` is called when the portal
 * link stops working mid-review. `bridge` lets the prototype stage answer element hints.
 */
export function createReviewSession({ adapter, now = () => new Date(), onLinkProblem = () => {}, timers } = {}) {
  const state = reactive({
    annotations: [],
    answers: {},
    content: null,
    data: null,
    // A mark the screens step should open, once its screen shows (focusMark).
    focusMarkId: null,
    heldKeys: [],
    loadError: '',
    loaded: false,
    loading: false,
    // Counts moves the reviewer made, so focus follows them but not the initial resume.
    moves: 0,
    notFound: false,
    position: { directionId: null, questionId: null, screenId: null, stateKey: null, step: 'overview' },
    previousAnswers: {},
    rejection: '',
    save: { error: null, failed: 0, savedAt: null, saving: false, state: 'idle' },
    stances: {},
    submitError: '',
    submittedAt: null,
    submitting: false,
    verdicts: {},
    visited: ['overview'],
  });

  const deletedIds = new Set();
  const restoredIds = new Set();
  // Marks the server has stored, so deleting one the server never saw sends nothing.
  const savedIds = new Set();
  const snapshots = new Map();
  let refreshing = null;
  let refreshAgain = false;
  let grantExpiresAt = null;
  let stopListening = null;
  let disposed = false;

  const autosave = createAutosave({
    now,
    onChange(status) {
      state.save = status;
    },
    onError(key, error) {
      if (Number(error?.status) === 410 || requirementsErrorCode(error) === 'link_not_found') {
        onLinkProblem(error);
        return true;
      }
      if (requirementsErrorCode(error) === 'round_closed') {
        refresh();
        return true;
      }
      if (isPermanentFailure(error)) {
        state.rejection = describeRequirementsError(error, 'One change wasn’t accepted.').message;
        refresh();
        return true;
      }
      return false;
    },
    timers,
  });

  // --- Reading ----------------------------------------------------------------------

  function roundId() {
    return adapter.scope.roundId;
  }

  function readOnly() {
    return Boolean(state.data?.round?.readOnly) || state.data?.round?.status !== 'open';
  }

  function canRespond() {
    return !readOnly() && Boolean(state.data?.me?.isReviewer);
  }

  function canAnnotate() {
    return !readOnly();
  }

  function progress() {
    return computeProgress({ answers: state.answers, content: state.content, stances: state.stances, verdicts: state.verdicts });
  }

  function dirtyKeys() {
    const keys = autosave.pendingKeys();
    for (const key of state.heldKeys) keys.add(key);
    return keys;
  }

  function hold(key) {
    if (!state.heldKeys.includes(key)) state.heldKeys.push(key);
  }

  function release(key) {
    const index = state.heldKeys.indexOf(key);
    if (index >= 0) state.heldKeys.splice(index, 1);
  }

  function isHeld(key) {
    return state.heldKeys.includes(key);
  }

  function findAnnotation(id) {
    return state.annotations.find((annotation) => annotation.id === id) ?? null;
  }

  // --- Loading and merging ----------------------------------------------------------

  // Each load issues a fresh review-origin grant, so screen addresses change. Keep the ones in
  // use while their grant is valid, or every refetch would reload the prototype and images.
  function stableContent(data, { initial }) {
    const content = reviewContent(data);
    const previous = state.content?.screens ?? [];
    const keepUntil = Date.parse(grantExpiresAt ?? '') || 0;
    if (!initial && previous.length && keepUntil - now().valueOf() > GRANT_REUSE_MARGIN_MS) {
      const kept = new Map(previous.map((screen) => [screen.id, screen.entryUrl]));
      content.screens = content.screens.map((screen) => (kept.get(screen.id) ? { ...screen, entryUrl: kept.get(screen.id) } : screen));
    } else {
      grantExpiresAt = data.grant?.expiresAt ?? null;
    }
    return content;
  }

  function applyServerState(data, { initial = false } = {}) {
    const dirty = dirtyKeys();
    state.data = data;
    state.content = stableContent(data, { initial });

    const stances = {};
    for (const direction of state.content.directions) {
      const key = `direction:${direction.id}`;
      const value = dirty.has(key) ? state.stances[direction.id] : data.directions?.[direction.id];
      if (value) stances[direction.id] = { remix: value.remix ?? '', stance: value.stance ?? null };
    }
    state.stances = stances;

    const verdicts = {};
    for (const screen of state.content.screens) {
      const key = `verdict:${screen.id}`;
      verdicts[screen.id] = dirty.has(key) && state.verdicts[screen.id] ? state.verdicts[screen.id] : verdictFromServer(data.verdicts?.[screen.id]);
    }
    state.verdicts = verdicts;

    const answers = {};
    for (const question of state.content.questions) {
      const key = `answer:${question.id}`;
      if (dirty.has(key)) {
        if (state.answers[question.id]) answers[question.id] = state.answers[question.id];
      } else if (data.answers?.[question.id]) {
        answers[question.id] = clone(data.answers[question.id]);
      }
    }
    state.answers = answers;
    state.previousAnswers = clone(data.previousAnswers ?? {});

    for (const annotation of data.annotations ?? []) savedIds.add(annotation.id);
    const pendingIds = new Set([...dirty].filter((key) => key.startsWith('annotation:')).map((key) => key.slice('annotation:'.length)));
    const local = new Map(state.annotations.map((annotation) => [annotation.id, annotation]));
    state.annotations = mergeAnnotationLists({ deletedIds, local, pendingIds, server: clone(data.annotations ?? []) }).map((annotation) => {
      const previous = local.get(annotation.id);
      return previous?.bounds ? { ...annotation, bounds: previous.bounds } : annotation;
    });
    state.submittedAt = data.me?.submittedAt ?? null;

    if (initial) {
      state.position = normalizePosition(data.me?.position ?? null, state.content);
      if (state.position.step !== 'overview') state.visited = ['overview', state.position.step];
    }
  }

  async function load() {
    state.loading = true;
    state.loadError = '';
    try {
      const data = await adapter.load();
      if (disposed) return;
      applyServerState(data, { initial: true });
      state.loaded = true;
      state.notFound = false;
    } catch (error) {
      if (disposed) return;
      if (Number(error?.status) === 410 || requirementsErrorCode(error) === 'link_not_found') onLinkProblem(error);
      else if (Number(error?.status) === 404) state.notFound = true;
      else state.loadError = describeRequirementsError(error, 'Unable to load this review.').message;
    } finally {
      state.loading = false;
    }
  }

  /** Refetches the round and merges it. Calls that arrive during a refetch run once after it. */
  async function refresh() {
    if (!state.loaded || disposed) return;
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false;
          const data = await adapter.load({ passive: true });
          if (disposed) return;
          applyServerState(data);
        } while (refreshAgain && !disposed);
      } catch (error) {
        if (Number(error?.status) === 410 || requirementsErrorCode(error) === 'link_not_found') onLinkProblem(error);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function startLive() {
    stopListening?.();
    stopListening = adapter.listen((batch) => {
      if (batchTouchesRound(batch, roundId())) refresh();
    });
  }

  // --- Position -----------------------------------------------------------------------

  function goTo(next) {
    const position = { ...state.position, ...next };
    if (next.step && next.step !== 'screens' && next.stateKey === undefined) position.stateKey = null;
    const moved = position.step !== state.position.step || position.screenId !== state.position.screenId;
    state.position = position;
    if (moved) state.moves += 1;
    if (!state.visited.includes(position.step)) state.visited.push(position.step);
    if (canRespond()) {
      const payload = positionPayload(position);
      autosave.schedule('position', () => adapter.savePosition(payload), { delay: POSITION_SAVE_DELAY_MS, silent: true });
    }
  }

  /**
   * Goes to a mark's screen, in the prototype state it was made on, and asks the screens step
   * to open the mark and its thread. Used by links from Marks and comments. Returns false for
   * a mark this review doesn't have.
   */
  function focusMark(id) {
    const annotation = findAnnotation(id);
    if (!annotation || !(state.content?.screens ?? []).some((screen) => screen.id === annotation.screenId)) return false;
    goTo({ screenId: annotation.screenId, stateKey: annotation.stateKey ?? null, step: 'screens' });
    state.focusMarkId = id;
    return true;
  }

  // --- Directions ---------------------------------------------------------------------

  function saveDirection(directionId) {
    const key = `direction:${directionId}`;
    const current = state.stances[directionId];
    if (!current?.stance) {
      // A remix note without a stance waits for one; the stance is what the server stores.
      if (current?.remix?.trim()) hold(key);
      else release(key);
      return;
    }
    release(key);
    autosave.schedule(key, () => {
      const latest = state.stances[directionId];
      return latest?.stance
        ? adapter.saveDirection(directionId, { remix: (latest.remix ?? '').trim(), stance: latest.stance })
        : adapter.clearDirection(directionId);
    });
  }

  function setStance(directionId, stance) {
    if (!canRespond()) return;
    const current = state.stances[directionId] ?? { remix: '', stance: null };
    state.stances = { ...state.stances, [directionId]: { ...current, stance } };
    if (stance) {
      saveDirection(directionId);
      return;
    }
    const key = `direction:${directionId}`;
    release(key);
    if (current.remix?.trim()) hold(key);
    autosave.schedule(key, () => adapter.clearDirection(directionId));
  }

  function setRemix(directionId, remix) {
    const current = state.stances[directionId] ?? { remix: '', stance: null };
    state.stances = { ...state.stances, [directionId]: { ...current, remix } };
  }

  function commitRemix(directionId) {
    if (!canRespond()) return;
    saveDirection(directionId);
  }

  // --- Screen verdicts ----------------------------------------------------------------

  function verdictFor(screenId) {
    return state.verdicts[screenId] ?? emptyVerdict();
  }

  function scheduleVerdict(screenId) {
    const key = `verdict:${screenId}`;
    const verdict = verdictFor(screenId);
    if (!verdict.overall) {
      // Aspects and notes save with an overall verdict; until then they stay here.
      const hasDraft = verdict.stay.trim() || verdict.change.trim() || verdict.mixed.trim() || Object.keys(verdict.dimensions).length;
      if (hasDraft) hold(key);
      else release(key);
      return;
    }
    release(key);
    autosave.schedule(key, () => {
      const latest = verdictFor(screenId);
      if (!latest.overall) return adapter.clearVerdict(screenId);
      return adapter.saveVerdict(screenId, {
        change: latest.change.trim(),
        dimensions: { ...latest.dimensions },
        mixed: latest.mixed.trim(),
        overall: latest.overall,
        stay: latest.stay.trim(),
      });
    });
  }

  function updateVerdict(screenId, patch) {
    state.verdicts = { ...state.verdicts, [screenId]: { ...verdictFor(screenId), ...patch } };
  }

  function setOverall(screenId, overall) {
    if (!canRespond()) return;
    updateVerdict(screenId, { overall: overall || null });
    if (overall) {
      scheduleVerdict(screenId);
      return;
    }
    const key = `verdict:${screenId}`;
    release(key);
    autosave.schedule(key, () => adapter.clearVerdict(screenId));
    scheduleVerdict(screenId);
  }

  function setAspect(screenId, dimension, value) {
    if (!canRespond()) return;
    const dimensions = { ...verdictFor(screenId).dimensions };
    if (value) dimensions[dimension] = value;
    else delete dimensions[dimension];
    updateVerdict(screenId, { dimensions });
    scheduleVerdict(screenId);
  }

  function setNote(screenId, field, text) {
    if (!['stay', 'change', 'mixed'].includes(field)) return;
    updateVerdict(screenId, { [field]: text });
  }

  function commitNotes(screenId) {
    if (!canRespond()) return;
    scheduleVerdict(screenId);
  }

  // --- Answers ------------------------------------------------------------------------

  function questionById(questionId) {
    return state.content?.questions.find((question) => question.id === questionId) ?? null;
  }

  /** Sets an answer locally. `commit` saves it (choices commit at once; text on blur). */
  function setAnswer(questionId, value, { commit = true } = {}) {
    if (!canRespond()) return { ok: false, message: '' };
    const question = questionById(questionId);
    if (!question) return { ok: false, message: '' };
    const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0) || (typeof value === 'string' && !value.trim() && question.kind === 'text');
    if (empty) {
      const next = { ...state.answers };
      if (question.kind === 'text') next[questionId] = { draft: true, text: '', value: typeof value === 'string' ? value : '' };
      else delete next[questionId];
      state.answers = next;
      if (commit) clearAnswer(questionId);
      return { ok: true };
    }
    if (question.kind === 'text' && !commit) {
      state.answers = { ...state.answers, [questionId]: { ...(state.answers[questionId] ?? {}), draft: true, text: value, value } };
      hold(`answer:${questionId}`);
      return { ok: true };
    }
    const checked = validateAnswer(question, value);
    if (!checked.ok) return checked;
    state.answers = { ...state.answers, [questionId]: { text: answerText(question, checked.value), value: checked.value } };
    const key = `answer:${questionId}`;
    release(key);
    autosave.schedule(key, async () => {
      const result = await adapter.saveAnswer(questionId, checked.value);
      const current = state.answers[questionId];
      if (result?.answer && current && JSON.stringify(current.value) === JSON.stringify(checked.value)) {
        state.answers = { ...state.answers, [questionId]: { ...result.answer } };
      }
    });
    return checked;
  }

  function commitAnswer(questionId) {
    const current = state.answers[questionId];
    if (!current?.draft) return { ok: true };
    return setAnswer(questionId, current.value, { commit: true });
  }

  function clearAnswer(questionId) {
    if (!canRespond()) return;
    const key = `answer:${questionId}`;
    release(key);
    const next = { ...state.answers };
    if (!next[questionId]?.draft) delete next[questionId];
    else next[questionId] = { ...next[questionId], value: '', text: '' };
    state.answers = next;
    autosave.schedule(key, () => adapter.clearAnswer(questionId));
  }

  // --- Annotations --------------------------------------------------------------------

  function replaceAnnotation(id, patch) {
    state.annotations = state.annotations.map((annotation) => (annotation.id === id ? { ...annotation, ...patch } : annotation));
  }

  function applyServerAnnotation(remote, { keepShapes = false } = {}) {
    if (!remote) return;
    savedIds.add(remote.id);
    const existing = findAnnotation(remote.id);
    if (!existing) {
      if (!deletedIds.has(remote.id)) state.annotations = [...state.annotations, remote];
      return;
    }
    const pending = autosave.hasPending(`annotation:${remote.id}`);
    const keep = keepShapes || pending;
    replaceAnnotation(remote.id, {
      ...remote,
      bounds: existing.bounds,
      category: pending ? existing.category : remote.category,
      localOnly: false,
      localSnapshotId: existing.localSnapshotId ?? null,
      shapes: keep ? numberShapes(existing.shapes, remote.number) : remote.shapes,
    });
  }

  async function ensureSnapshotUploaded(localId, screenId) {
    const snapshot = snapshots.get(localId);
    if (!snapshot) throw new Error('The snapshot for this mark is missing.');
    if (snapshot.snapshotFileId) return snapshot.snapshotFileId;
    if (!snapshot.upload) {
      const blob = dataUrlToBlob(snapshot.dataUrl);
      snapshot.upload = adapter.uploadSnapshot(blob, { screenId, stateKey: snapshot.stateKey ?? '' }).then((result) => {
        snapshot.snapshotFileId = result.snapshotFileId;
        snapshot.url = result.url ?? null;
        state.annotations = state.annotations.map((annotation) => (annotation.localSnapshotId === localId ? { ...annotation, snapshotFileId: result.snapshotFileId } : annotation));
        return result.snapshotFileId;
      }).catch((error) => {
        snapshot.upload = null;
        throw error;
      });
    }
    return snapshot.upload;
  }

  function scheduleAnnotationSave(id, { delay = 0 } = {}) {
    const key = `annotation:${id}`;
    autosave.schedule(key, async () => {
      let record = findAnnotation(id);
      if (!record || deletedIds.has(id)) return;
      // Every mark on the snapshot carries its stored id, including marks made after the upload finished.
      if (record.localSnapshotId && !record.snapshotFileId) {
        replaceAnnotation(id, { snapshotFileId: await ensureSnapshotUploaded(record.localSnapshotId, record.screenId) });
      }
      if (record.hintPending) {
        const hint = await record.hintPending.catch(() => null);
        replaceAnnotation(id, { elementHint: hint ?? record.elementHint ?? null, hintPending: null });
      }
      record = findAnnotation(id);
      if (!record || deletedIds.has(id)) return;
      const restored = restoredIds.has(id);
      const result = await adapter.saveAnnotation(id, annotationPayload(record, { bounds: record.bounds, restored }));
      restoredIds.delete(id);
      applyServerAnnotation(result?.annotation);
    }, { delay });
  }

  /**
   * The editor made a new mark. `surface` is { screenId, bounds, snapshot? } and `hint` an
   * optional promise of the prototype element under it.
   */
  function createAnnotation(surface, { hint = null, id, number, restored = false, shapes }) {
    if (!canAnnotate()) return;
    deletedIds.delete(id);
    if (restored) restoredIds.add(id);
    const existing = findAnnotation(id);
    if (existing) {
      replaceAnnotation(id, { shapes });
    } else {
      const me = state.data?.me ?? {};
      const record = localAnnotation({ authorName: me.name || 'You', authorRef: me.actorRef, id, number, screenId: surface.screenId, shapes, snapshot: surface.snapshot ?? null });
      record.bounds = surface.bounds;
      record.hintPending = hint;
      state.annotations = [...state.annotations, record];
    }
    scheduleAnnotationSave(id);
  }

  function updateAnnotationShapes(id, shapes) {
    if (!canAnnotate() || !findAnnotation(id)) return;
    replaceAnnotation(id, { shapes });
    scheduleAnnotationSave(id, { delay: ANNOTATION_SAVE_DELAY_MS });
  }

  function setCategory(id, category) {
    if (!canAnnotate() || !findAnnotation(id)) return;
    replaceAnnotation(id, { category: category || null });
    scheduleAnnotationSave(id);
  }

  function deleteAnnotation(id) {
    const record = findAnnotation(id);
    if (!record) return;
    deletedIds.add(id);
    state.annotations = state.annotations.filter((annotation) => annotation.id !== id);
    const key = `annotation:${id}`;
    autosave.schedule(key, async () => {
      // A mark the server never saw needs no request.
      if (!savedIds.has(id)) return;
      await adapter.deleteAnnotation(id);
      savedIds.delete(id);
    });
  }

  /** Runs any waiting save for a mark now, so a comment can be added to it. */
  async function ensureAnnotationSaved(id) {
    await autosave.flush(`annotation:${id}`);
  }

  async function threadAction(id, run) {
    const result = await run();
    if (result?.annotation) applyServerAnnotation(result.annotation, { keepShapes: true });
    return result;
  }

  async function addComment(id, { body, parentCommentId = '' }) {
    await ensureAnnotationSaved(id);
    return threadAction(id, () => adapter.addComment(id, { body, parentCommentId }));
  }

  /** People this reviewer may tag in the mark's thread; the mark is saved first. */
  async function mentionables(id) {
    await ensureAnnotationSaved(id);
    return adapter.mentionables ? adapter.mentionables(id) : [];
  }

  function editComment(id, commentId, { body }) {
    return threadAction(id, () => adapter.editComment(id, commentId, { body }));
  }

  function deleteComment(id, commentId) {
    return threadAction(id, () => adapter.deleteComment(id, commentId));
  }

  function setAnnotationStatus(id, status) {
    return threadAction(id, () => adapter.setAnnotationStatus(id, status));
  }

  /** Carries an outdated mark from an earlier version into this round. */
  async function carryAnnotation(id) {
    const result = await threadAction(id, () => adapter.carryAnnotation(id));
    await refresh();
    return result;
  }

  async function closeAnnotation(id) {
    const result = await threadAction(id, () => adapter.closeAnnotation(id));
    await refresh();
    return result;
  }

  // --- Prototype snapshots ------------------------------------------------------------

  /** Keeps a captured snapshot locally; it uploads with the first mark made on it. */
  function addSnapshot({ dataUrl, height, stateKey, width }) {
    const localId = nextLocalSnapshotId();
    const snapshot = { dataUrl, height, localId, snapshotFileId: null, stateKey: stateKey || null, upload: null, url: null, width };
    snapshots.set(localId, snapshot);
    return { dataUrl, height, localId, snapshotFileId: null, stateKey: snapshot.stateKey, unavailable: false, width };
  }

  // --- Submit -------------------------------------------------------------------------

  async function submit() {
    if (!canRespond() || state.submitting) return false;
    state.submitting = true;
    state.submitError = '';
    try {
      await autosave.flushAll();
      if (autosave.status().failed > 0) {
        state.submitError = 'Some changes haven’t saved yet. Retry them, then submit.';
        return false;
      }
      const result = await adapter.submit();
      state.submittedAt = result?.submittedAt ?? now().toISOString();
      if (state.data?.me) state.data = { ...state.data, me: { ...state.data.me, submittedAt: state.submittedAt } };
      return true;
    } catch (error) {
      if (Number(error?.status) === 410) onLinkProblem(error);
      state.submitError = describeRequirementsError(error, 'Your review couldn’t be submitted. Try again.').message;
      return false;
    } finally {
      state.submitting = false;
    }
  }

  function dispose() {
    disposed = true;
    stopListening?.();
    autosave.dispose();
  }

  return {
    addComment,
    addSnapshot,
    autosave,
    canAnnotate,
    canRespond,
    carryAnnotation,
    clearAnswer,
    closeAnnotation,
    commitAnswer,
    commitNotes,
    commitRemix,
    createAnnotation,
    deleteAnnotation,
    deleteComment,
    dispose,
    editComment,
    findAnnotation,
    flushAll: () => autosave.flushAll(),
    focusMark,
    goTo,
    isHeld,
    load,
    loadSnapshot: (path) => adapter.loadSnapshot(path),
    mentionables,
    progress,
    readOnly,
    refresh,
    retry: () => autosave.retry(),
    setAnnotationStatus,
    setAnswer,
    setAspect,
    setCategory,
    setNote,
    setOverall,
    setRemix,
    setStance,
    startLive,
    state,
    submit,
    updateAnnotationShapes,
    verdictFor,
  };
}
