// Local drafts for the annotation editor. The editor emits create, update and delete events and shows the result
// at once; the draft stays until the parent's `marks` prop reflects it, so a slow or failed save never makes a
// mark vanish or jump back.
//
// Draft entries, keyed by annotation ID:
//   { kind: 'create', mark }            new annotation, not yet in `marks`
//   { kind: 'update', shapes, base }    new shapes; `base` is the JSON of the shapes in `marks` when editing began
//   { kind: 'delete', base }            hidden until it leaves `marks`

const shapesKey = (shapes) => JSON.stringify(shapes ?? []);

function indexMarks(marks) {
  const byId = new Map();
  for (const mark of marks || []) if (mark?.id) byId.set(mark.id, mark);
  return byId;
}

// The editable part of the current actor's marks, in display order. History stores these snapshots.
export function ownSnapshot(marks, authorRef) {
  return (marks || [])
    .filter((mark) => authorRef && mark.authorRef === authorRef)
    .map((mark) => ({ id: mark.id, shapes: mark.shapes || [] }));
}

export function diffSnapshots(before, after) {
  const previous = new Map((before || []).map((entry) => [entry.id, entry]));
  const next = new Map((after || []).map((entry) => [entry.id, entry]));
  const created = [];
  const updated = [];
  const deleted = [];
  for (const entry of after || []) {
    const old = previous.get(entry.id);
    if (!old) created.push({ id: entry.id, shapes: entry.shapes });
    else if (shapesKey(old.shapes) !== shapesKey(entry.shapes)) updated.push({ id: entry.id, shapes: entry.shapes });
  }
  for (const entry of before || []) if (!next.has(entry.id)) deleted.push(entry.id);
  return { created, updated, deleted };
}

// Records one change. `change` is { type: 'create', id, shapes, mark } | { type: 'update', id, shapes } | { type: 'delete', id }.
export function recordDraft(drafts, marks, change) {
  const next = { ...drafts };
  const stored = indexMarks(marks).get(change.id);
  const existing = next[change.id];

  if (change.type === 'create') {
    if (stored) next[change.id] = { kind: 'update', shapes: change.shapes, base: existing?.base ?? shapesKey(stored.shapes) };
    else next[change.id] = { kind: 'create', mark: { ...change.mark, id: change.id, shapes: change.shapes } };
    return next;
  }

  if (change.type === 'update') {
    if (existing?.kind === 'create') next[change.id] = { kind: 'create', mark: { ...existing.mark, shapes: change.shapes } };
    else if (existing) next[change.id] = { kind: 'update', shapes: change.shapes, base: existing.base };
    else if (stored) next[change.id] = { kind: 'update', shapes: change.shapes, base: shapesKey(stored.shapes) };
    return next;
  }

  if (change.type === 'delete') {
    if (existing?.kind === 'create') delete next[change.id];
    else if (existing) next[change.id] = { kind: 'delete', base: existing.base };
    else if (stored) next[change.id] = { kind: 'delete', base: shapesKey(stored.shapes) };
    return next;
  }

  return next;
}

// Drops drafts that `marks` has caught up with. An update or delete also settles once the stored shapes change
// from where the edit began: the parent has applied something newer, so the prop is the truth again.
export function reconcileDrafts(marks, drafts) {
  const byId = indexMarks(marks);
  const next = {};
  let changed = false;
  for (const [id, entry] of Object.entries(drafts || {})) {
    const stored = byId.get(id);
    const settled = entry.kind === 'create' ? Boolean(stored) : !stored || shapesKey(stored.shapes) !== entry.base;
    if (settled) changed = true;
    else next[id] = entry;
  }
  return changed ? next : drafts;
}

export function applyDrafts(marks, drafts) {
  const entries = drafts || {};
  const result = [];
  for (const mark of marks || []) {
    const entry = entries[mark.id];
    if (entry?.kind === 'delete') continue;
    result.push(entry?.kind === 'update' ? { ...mark, shapes: entry.shapes } : mark);
  }
  const present = indexMarks(marks);
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.kind === 'create' && !present.has(id)) result.push(entry.mark);
  }
  return result;
}

export function hasDrafts(drafts) {
  return Object.keys(drafts || {}).length > 0;
}
