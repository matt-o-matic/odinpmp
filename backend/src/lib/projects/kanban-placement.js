// Kanban placement keeps board columns loosely coupled to item status. A column accepts a
// set of statuses, and several columns may accept the same status. An item's optional
// `boardColumn` names the column it was placed in; it wins whenever that column still
// accepts the item's status. Otherwise the item falls back to the first accepting column.

export const BOARD_COLUMN_KEY_MAX_LENGTH = 80;

export function normalizeBoardColumnKey(value) {
  const key = String(value ?? '').trim().slice(0, BOARD_COLUMN_KEY_MAX_LENGTH);
  return key || null;
}

export function slugifyBoardColumnKey(value, fallback = 'column') {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BOARD_COLUMN_KEY_MAX_LENGTH);
  return slug || fallback;
}

/**
 * Gives every column a stable key, keeping saved keys and deriving missing ones from the
 * column name. Duplicates get a numeric suffix so placement never becomes ambiguous.
 */
export function assignBoardColumnKeys(columns = []) {
  const used = new Set();

  return (columns ?? []).map((column, index) => {
    const base = normalizeBoardColumnKey(column?.key) ?? slugifyBoardColumnKey(column?.name, `column-${index + 1}`);
    let key = base;
    let suffix = 2;
    while (used.has(key)) {
      key = `${base.slice(0, BOARD_COLUMN_KEY_MAX_LENGTH - String(suffix).length - 1)}-${suffix}`;
      suffix += 1;
    }
    used.add(key);
    return { ...column, key };
  });
}

export function resolveKanbanColumn(item, columns = []) {
  const status = item?.status;
  const placement = normalizeBoardColumnKey(item?.boardColumn);

  if (placement) {
    const placed = columns.find((column) => column.key === placement && (column.statuses ?? []).includes(status));
    if (placed) return placed;
  }

  return columns.find((column) => (column.statuses ?? []).includes(status)) ?? null;
}

/**
 * A status change that does not also move the item to a new column clears the stale
 * placement, so a later return to the old status does not resurrect an outdated column.
 */
export function resolveBoardColumnForPatch(current = {}, patch = {}) {
  const currentColumn = normalizeBoardColumnKey(current.boardColumn);
  const requestedColumn = patch.boardColumn === undefined ? undefined : normalizeBoardColumnKey(patch.boardColumn);
  const statusChanged = patch.status !== undefined && patch.status !== current.status;

  if (statusChanged && (requestedColumn === undefined || requestedColumn === currentColumn)) {
    return null;
  }

  return requestedColumn === undefined ? currentColumn : requestedColumn;
}

// Board order is a project-wide Kanban rank, kept apart from sprint and tree order. Ranked
// items come first by rank; unranked items (new work) follow in their existing order.
export function sortKanbanItems(items = [], ranks = new Map()) {
  return (items ?? [])
    .map((item, index) => ({ index, item, rank: ranks.get(item.id) }))
    .sort((left, right) => {
      const leftRanked = Number.isFinite(left.rank);
      const rightRanked = Number.isFinite(right.rank);
      if (leftRanked && rightRanked && left.rank !== right.rank) return left.rank - right.rank;
      if (leftRanked !== rightRanked) return leftRanked ? -1 : 1;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

/**
 * Moves one id within the full board order. `afterItemId` wins over `beforeItemId`, since a
 * drop lands directly below the card above it. Returns null when neither anchor exists,
 * because the board the user dropped onto no longer matches the saved order.
 */
export function moveKanbanItem(orderedIds = [], itemId, { afterItemId = null, beforeItemId = null } = {}) {
  if (!orderedIds.includes(itemId)) return null;

  const remaining = orderedIds.filter((id) => id !== itemId);
  const afterIndex = afterItemId ? remaining.indexOf(afterItemId) : -1;
  const beforeIndex = beforeItemId ? remaining.indexOf(beforeItemId) : -1;
  let insertAt;

  if (afterIndex >= 0) {
    insertAt = afterIndex + 1;
  } else if (beforeIndex >= 0) {
    insertAt = beforeIndex;
  } else if (!afterItemId && !beforeItemId) {
    return orderedIds;
  } else {
    return null;
  }

  remaining.splice(insertAt, 0, itemId);
  return remaining;
}
