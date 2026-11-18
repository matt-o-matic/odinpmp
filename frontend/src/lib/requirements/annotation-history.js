// Undo and redo for the annotation editor. Snapshots are stored as JSON strings, so a stored step can never be
// changed by later edits and equal snapshots compare cheaply.

export const HISTORY_LIMIT = 100;

const serialize = (snapshot) => JSON.stringify(snapshot ?? null);

export class AnnotationHistory {
  constructor({ limit = HISTORY_LIMIT } = {}) {
    this.limit = Math.max(1, Math.floor(limit));
    this.past = [];
    this.future = [];
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  // Records the state before a change. Returns false when nothing changed, so a click that selects a mark
  // without moving it leaves no undo step.
  commit(before, after) {
    const previous = serialize(before);
    if (previous === serialize(after)) return false;
    if (this.past.at(-1) !== previous) {
      this.past.push(previous);
      if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    }
    this.future = [];
    return true;
  }

  // Returns the snapshot to restore, or null when there is nothing to undo. Steps equal to the current state
  // (for example after the same change arrived from elsewhere) are skipped.
  undo(current) {
    return this.#step(this.past, this.future, current);
  }

  redo(current) {
    return this.#step(this.future, this.past, current);
  }

  clear() {
    this.past = [];
    this.future = [];
  }

  #step(from, to, current) {
    const now = serialize(current);
    while (from.length && from.at(-1) === now) from.pop();
    if (!from.length) return null;
    const target = from.pop();
    to.push(now);
    if (to.length > this.limit) to.splice(0, to.length - this.limit);
    return JSON.parse(target);
  }
}
