// Kanban placement keeps board columns loosely coupled to item status. Mirrors
// backend/src/lib/projects/kanban-placement.js: a column accepts a set of statuses, several
// columns may accept the same status, and an item's `boardColumn` picks between them.

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

export function uniqueBoardColumnKey(base, usedKeys) {
  let key = base;
  let suffix = 2;
  while (usedKeys.has(key)) {
    key = `${base.slice(0, BOARD_COLUMN_KEY_MAX_LENGTH - String(suffix).length - 1)}-${suffix}`;
    suffix += 1;
  }
  return key;
}

export function assignBoardColumnKeys(columns = []) {
  const used = new Set();

  return (columns ?? []).map((column, index) => {
    const base = normalizeBoardColumnKey(column?.key) ?? slugifyBoardColumnKey(column?.name, `column-${index + 1}`);
    const key = uniqueBoardColumnKey(base, used);
    used.add(key);
    return { ...column, key };
  });
}

export function resolveKanbanColumn(card, columns = []) {
  const placement = normalizeBoardColumnKey(card?.boardColumn);

  if (placement) {
    const placed = columns.find((column) => column.key === placement && (column.statuses ?? []).includes(card.status));
    if (placed) return placed;
  }

  return columns.find((column) => (column.statuses ?? []).includes(card?.status)) ?? null;
}

/**
 * Builds the item patch for dropping a card into a column. The card keeps its status when
 * the column accepts it, so moving between two "Blocked" columns only changes placement.
 */
export function buildKanbanMovePatch(card, column) {
  const accepted = (column?.statuses ?? []).includes(card?.status);
  return {
    boardColumn: column?.key ?? null,
    status: accepted ? card.status : column?.defaultStatus ?? card?.status,
  };
}

/**
 * Finds the neighbors of a dropped card in its destination cell. The server places the card
 * next to them in the project-wide board order, which stays separate from sprint order.
 */
export function resolveKanbanDropAnchors(cellCardIds = [], cardId, newIndex) {
  const others = (cellCardIds ?? []).filter((id) => id !== cardId);
  const index = Math.max(0, Math.min(Number.isFinite(newIndex) ? newIndex : others.length, others.length));
  return {
    afterItemId: others[index - 1] ?? null,
    beforeItemId: others[index] ?? null,
  };
}

// Applies a drop to the local card list so the board updates before the save returns.
export function moveKanbanCard(cards = [], cardId, { afterItemId = null, beforeItemId = null } = {}, patch = {}) {
  const fromIndex = cards.findIndex((card) => card.id === cardId);
  if (fromIndex < 0) return cards;

  const moved = { ...cards[fromIndex], ...patch };
  const rest = cards.filter((card) => card.id !== cardId);
  const afterIndex = afterItemId ? rest.findIndex((card) => card.id === afterItemId) : -1;
  const beforeIndex = beforeItemId ? rest.findIndex((card) => card.id === beforeItemId) : -1;
  const insertAt = afterIndex >= 0 ? afterIndex + 1 : beforeIndex >= 0 ? beforeIndex : fromIndex;

  rest.splice(insertAt, 0, moved);
  return rest;
}
