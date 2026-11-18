// Three-way merge for concurrent project edits. `base` is what the editor started from,
// `mine` is the local draft, and `theirs` is the latest server state. Changes made on only
// one side apply automatically; fields changed differently on both sides become conflicts
// that the caller resolves with a map of conflict key -> 'mine' | 'theirs' (default mine).

import { usesChildEstimates } from './work-estimates.js';

const ITEM_IGNORED_KEYS = new Set(['assigneeName', 'progress', 'stories', 'tasks', 'updatedAt', 'version']);
// Rolled-up points and hours are recomputed after the merge, so they never conflict.
const ROLLED_UP_KEYS = new Set(['points', 'targetHourEstimate']);
const PROJECT_METADATA_FIELDS = ['name', 'description', 'status', 'startDate', 'endDate'];
const ITEM_TYPE_LABELS = { epic: 'Epic', story: 'Story', task: 'Task' };

function stableValue(value) {
  return JSON.stringify(value ?? null);
}

function sameValue(left, right) {
  return stableValue(left) === stableValue(right);
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function humanizeFieldName(field) {
  const words = String(field ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : '';
}

function resolutionFor(resolutions, key) {
  return resolutions?.[key] === 'theirs' ? 'theirs' : 'mine';
}

/**
 * Merges one value. Returns the merged value plus a conflict flag when both sides changed
 * it to different things.
 */
export function mergeValue(base, mine, theirs) {
  if (sameValue(mine, theirs)) return { conflict: false, value: cloneValue(mine) };
  if (sameValue(mine, base)) return { conflict: false, value: cloneValue(theirs) };
  if (sameValue(theirs, base)) return { conflict: false, value: cloneValue(mine) };
  return { conflict: true, value: cloneValue(mine) };
}

/**
 * Merges the listed fields of a flat record. Fields outside `fields` keep the local value.
 */
export function mergeRecord({ base = {}, fieldLabels = {}, fields, keyPrefix = 'record', label = '', mine = {}, resolutions = {}, theirs = {} }) {
  const merged = { ...cloneValue(mine) };
  const conflicts = [];
  const keys = fields ?? [...new Set([...Object.keys(base ?? {}), ...Object.keys(mine ?? {}), ...Object.keys(theirs ?? {})])];

  for (const field of keys) {
    const result = mergeValue(base?.[field], mine?.[field], theirs?.[field]);
    if (!result.conflict) {
      merged[field] = result.value;
      continue;
    }

    const key = `${keyPrefix}:${field}`;
    conflicts.push({
      field,
      fieldLabel: fieldLabels[field] ?? humanizeFieldName(field),
      key,
      label,
      mine: cloneValue(mine?.[field]),
      theirs: cloneValue(theirs?.[field]),
    });
    merged[field] = cloneValue(resolutionFor(resolutions, key) === 'theirs' ? theirs?.[field] : mine?.[field]);
  }

  return { conflicts, merged };
}

/** True when the listed fields differ between two records. */
export function recordsDiffer(left = {}, right = {}, fields) {
  const keys = fields ?? [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])];
  return keys.some((field) => !sameValue(left?.[field], right?.[field]));
}

function flattenProjectTree(project) {
  const entries = new Map();
  const childOrder = new Map();
  const pushChild = (parentKey, id) => {
    childOrder.set(parentKey, [...(childOrder.get(parentKey) ?? []), id]);
  };
  const add = (node, itemType, parentId) => {
    const fields = {};
    const rollsUp = usesChildEstimates(node);
    for (const [key, value] of Object.entries(node ?? {})) {
      if (!ITEM_IGNORED_KEYS.has(key) && !(rollsUp && ROLLED_UP_KEYS.has(key))) fields[key] = value;
    }
    entries.set(node.id, { fields, id: node.id, itemType, node, parentId });
    pushChild(parentId ?? '__root', node.id);
  };

  for (const epic of project?.epics ?? []) {
    add(epic, 'epic', null);
    for (const story of epic.stories ?? []) {
      add(story, 'story', epic.id);
      for (const task of story.tasks ?? []) add(task, 'task', story.id);
    }
  }

  return { childOrder, entries };
}

function itemLabel(entry) {
  const typeLabel = ITEM_TYPE_LABELS[entry?.itemType] ?? 'Item';
  const name = String(entry?.fields?.name ?? '').trim();
  return name ? `${typeLabel} "${name}"` : typeLabel;
}

function touchedIds(side, base) {
  const touched = new Set();
  for (const [id, entry] of side.entries) {
    const baseEntry = base.entries.get(id);
    if (!baseEntry || entry.parentId !== baseEntry.parentId || recordsDiffer(entry.fields, baseEntry.fields)) {
      touched.add(id);
    }
  }
  return touched;
}

function subtreeIds(tree, rootId) {
  const ids = [rootId];
  for (let index = 0; index < ids.length; index += 1) {
    ids.push(...(tree.childOrder.get(ids[index]) ?? []));
  }
  return ids;
}

function subtreeTouched(tree, touched, rootId) {
  return subtreeIds(tree, rootId).some((id) => touched.has(id));
}

function ancestorIds(tree, id) {
  const ancestors = [];
  let current = tree.entries.get(id)?.parentId ?? null;
  while (current) {
    ancestors.push(current);
    current = tree.entries.get(current)?.parentId ?? null;
  }
  return ancestors;
}

function insertAfterPreviousSibling(order, id, sourceOrder) {
  if (order.includes(id)) return;
  const sourceIndex = sourceOrder.indexOf(id);
  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    const anchor = order.indexOf(sourceOrder[index]);
    if (anchor >= 0) {
      order.splice(anchor + 1, 0, id);
      return;
    }
  }
  order.unshift(id);
}

function mergeChildOrder({ baseOrder, memberIds, mineOrder, theirsOrder }) {
  const members = new Set(memberIds);
  const common = (order) => order.filter((id) => members.has(id) && baseOrder.includes(id));
  const mineReordered = !sameValue(common(mineOrder), common(baseOrder));
  const primary = (mineReordered ? mineOrder : theirsOrder).filter((id) => members.has(id));
  const secondary = mineReordered ? theirsOrder : mineOrder;
  const order = [...primary];

  for (const id of secondary) {
    if (members.has(id)) insertAfterPreviousSibling(order, id, secondary);
  }
  for (const id of memberIds) {
    if (!order.includes(id)) order.push(id);
  }

  return order;
}

// A server-deleted item kept from the local draft is re-created under a new id, because
// the deleted row still owns the old one.
function createRestoredId() {
  return `draft-restored-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Merges full project drafts. Returns the merged project (built on `theirs`, so it carries
 * the latest server versions) and the list of conflicts found.
 */
export function mergeProjects({ base, mine, normalizeBrief = (brief) => brief ?? {}, resolutions = {}, theirs }) {
  const conflicts = [];

  const metadata = mergeRecord({
    base,
    fields: PROJECT_METADATA_FIELDS,
    keyPrefix: 'project',
    label: 'Project',
    mine,
    resolutions,
    theirs,
  });
  conflicts.push(...metadata.conflicts);

  const baseBrief = normalizeBrief(base?.assistantState?.brief ?? {});
  const mineBrief = normalizeBrief(mine?.assistantState?.brief ?? {});
  const theirsBrief = normalizeBrief(theirs?.assistantState?.brief ?? {});
  const brief = mergeRecord({
    base: baseBrief,
    keyPrefix: 'brief',
    label: 'Project brief',
    mine: mineBrief,
    resolutions,
    theirs: theirsBrief,
  });
  conflicts.push(...brief.conflicts);

  const baseTree = flattenProjectTree(base);
  const mineTree = flattenProjectTree(mine);
  const theirsTree = flattenProjectTree(theirs);
  const mineTouched = touchedIds(mineTree, baseTree);
  const theirsTouched = touchedIds(theirsTree, baseTree);
  const kept = new Map();
  const restored = new Map();
  const decidedByAncestor = new Map();

  const orderedIds = [
    ...theirsTree.entries.keys(),
    ...[...mineTree.entries.keys()].filter((id) => !theirsTree.entries.has(id)),
    ...[...baseTree.entries.keys()].filter((id) => !theirsTree.entries.has(id) && !mineTree.entries.has(id)),
  ];

  for (const id of orderedIds) {
    const inBase = baseTree.entries.has(id);
    const inMine = mineTree.entries.has(id);
    const inTheirs = theirsTree.entries.has(id);
    const baseEntry = baseTree.entries.get(id);
    const mineEntry = mineTree.entries.get(id);
    const theirsEntry = theirsTree.entries.get(id);

    const inheritedDecision = [...ancestorIds(inMine ? mineTree : inTheirs ? theirsTree : baseTree, id)]
      .map((ancestorId) => decidedByAncestor.get(ancestorId))
      .find(Boolean);

    if (!inBase && inMine && !inTheirs) {
      kept.set(id, { entry: mineEntry, fields: cloneValue(mineEntry.fields), parentId: mineEntry.parentId });
      continue;
    }

    if (!inBase && !inMine && inTheirs) {
      kept.set(id, { entry: theirsEntry, fields: cloneValue(theirsEntry.fields), parentId: theirsEntry.parentId });
      continue;
    }

    if (inBase && !inMine && inTheirs) {
      // Deleted locally while still on the server.
      let keepTheirs = inheritedDecision ? inheritedDecision === 'keep' : false;
      if (!inheritedDecision && subtreeTouched(theirsTree, theirsTouched, id)) {
        const key = `${id}:__deleted`;
        conflicts.push({
          field: '__deleted',
          fieldLabel: 'Deleted',
          key,
          label: itemLabel(theirsEntry),
          mine: 'You deleted it',
          theirs: 'They changed it',
        });
        keepTheirs = resolutionFor(resolutions, key) === 'theirs';
        decidedByAncestor.set(id, keepTheirs ? 'keep' : 'delete');
      } else if (!inheritedDecision) {
        decidedByAncestor.set(id, 'delete');
      }
      if (keepTheirs) {
        kept.set(id, { entry: theirsEntry, fields: cloneValue(theirsEntry.fields), parentId: theirsEntry.parentId });
      }
      continue;
    }

    if (inBase && inMine && !inTheirs) {
      // Deleted on the server while still in the local draft.
      let keepMine = inheritedDecision ? inheritedDecision === 'keep' : false;
      if (!inheritedDecision && subtreeTouched(mineTree, mineTouched, id)) {
        const key = `${id}:__deleted`;
        conflicts.push({
          field: '__deleted',
          fieldLabel: 'Deleted',
          key,
          label: itemLabel(mineEntry),
          mine: 'You changed it',
          theirs: 'They deleted it',
        });
        keepMine = resolutionFor(resolutions, key) === 'mine';
        decidedByAncestor.set(id, keepMine ? 'keep' : 'delete');
      } else if (!inheritedDecision) {
        decidedByAncestor.set(id, 'delete');
      }
      if (keepMine) {
        const restoredId = createRestoredId();
        restored.set(id, restoredId);
        kept.set(id, { entry: mineEntry, fields: { ...cloneValue(mineEntry.fields), id: restoredId }, parentId: mineEntry.parentId });
      }
      continue;
    }

    if (!inMine && !inTheirs) {
      continue;
    }

    // Present on both sides: merge fields and parent.
    const reference = baseEntry ?? theirsEntry;
    const label = itemLabel(baseEntry ?? mineEntry);
    const fields = mergeRecord({
      base: reference.fields,
      keyPrefix: id,
      label,
      mine: mineEntry.fields,
      resolutions,
      theirs: theirsEntry.fields,
    });
    conflicts.push(...fields.conflicts);

    const parent = mergeValue(reference.parentId, mineEntry.parentId, theirsEntry.parentId);
    let parentId = parent.value;
    if (parent.conflict) {
      const key = `${id}:__parent`;
      conflicts.push({ field: '__parent', fieldLabel: 'Location', key, label, mine: mineEntry.parentId, theirs: theirsEntry.parentId });
      parentId = resolutionFor(resolutions, key) === 'theirs' ? theirsEntry.parentId : mineEntry.parentId;
    }

    kept.set(id, { entry: theirsEntry, fields: { ...fields.merged, id }, parentId });
  }

  // Items whose parent did not survive the merge are dropped with it.
  const survivingParent = (parentId) => parentId == null || kept.has(parentId);
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const [id, item] of kept) {
      if (!survivingParent(item.parentId)) {
        kept.delete(id);
        pruned = true;
      }
    }
  }

  const childrenOf = (parentId) => {
    const parentKey = parentId ?? '__root';
    const memberIds = [...kept.entries()].filter(([, item]) => (item.parentId ?? null) === (parentId ?? null)).map(([id]) => id);
    return mergeChildOrder({
      baseOrder: baseTree.childOrder.get(parentKey) ?? [],
      memberIds,
      mineOrder: mineTree.childOrder.get(parentKey) ?? [],
      theirsOrder: theirsTree.childOrder.get(parentKey) ?? [],
    });
  };

  const buildNode = (id) => {
    const item = kept.get(id);
    const node = { ...cloneValue(item.entry.node), ...cloneValue(item.fields) };
    delete node.stories;
    delete node.tasks;
    if (restored.has(id)) delete node.version;
    return node;
  };

  const epics = childrenOf(null)
    .filter((id) => kept.get(id).entry.itemType === 'epic')
    .map((epicId) => ({
      ...buildNode(epicId),
      stories: childrenOf(epicId).map((storyId) => ({
        ...buildNode(storyId),
        tasks: childrenOf(storyId).map(buildNode),
      })),
    }));

  const merged = {
    ...cloneValue(theirs),
    ...Object.fromEntries(PROJECT_METADATA_FIELDS.map((field) => [field, metadata.merged[field]])),
    assistantState: {
      ...cloneValue(theirs?.assistantState ?? {}),
      brief: { ...cloneValue(theirs?.assistantState?.brief ?? {}), ...brief.merged },
    },
    epics,
  };

  return { conflicts, merged };
}
