import {
  assignBoardColumnKeys,
  normalizeBoardColumnKey,
  slugifyBoardColumnKey,
  uniqueBoardColumnKey,
} from './kanban-placement.js';
import { createDefaultKanbanConfig } from './project-planning.js';

let clientIdCounter = 0;

function nextClientId(prefix) {
  clientIdCounter += 1;
  return `${prefix}-${clientIdCounter}`;
}

function uniqueStrings(values = []) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

export const KANBAN_ISSUE_TYPES = ['story', 'task', 'ticket'];

function normalizeSwimlane(value) {
  return ['none', 'assignee', 'epic', 'sprint', 'issueType'].includes(value) ? value : 'none';
}

function normalizeIssueTypes(values = []) {
  return uniqueStrings(values).filter((value) => KANBAN_ISSUE_TYPES.includes(value));
}

function extractKanbanFilters(source = {}) {
  return {
    assigneeIds: uniqueStrings(source.assigneeIds),
    hideDone: Boolean(source.hideDone),
    includeBacklog: source.includeBacklog !== false,
    issueTypes: normalizeIssueTypes(source.issueTypes),
    search: String(source.search ?? '').trim(),
    selectedSprintIds: uniqueStrings(source.selectedSprintIds),
    statusValues: uniqueStrings(source.statusValues),
  };
}

function normalizeColumn(column, index, statuses = []) {
  const fallbackStatus = String(
    column?.defaultStatus
      ?? column?.statuses?.[0]
      ?? statuses[0]
      ?? 'Not Started',
  ).trim() || 'Not Started';
  const normalizedStatuses = uniqueStrings(column?.statuses?.length ? column.statuses : [fallbackStatus]);
  const defaultStatus = normalizedStatuses.includes(String(column?.defaultStatus ?? '').trim())
    ? String(column.defaultStatus).trim()
    : normalizedStatuses[0];
  const name = String(column?.name ?? defaultStatus).trim() || defaultStatus;

  return {
    clientId: String(column?.clientId ?? nextClientId(`kanban-column-${index + 1}`)).trim(),
    defaultStatus,
    key: normalizeBoardColumnKey(column?.key),
    keyFollowsName: Boolean(column?.keyFollowsName),
    name,
    statuses: normalizedStatuses,
  };
}

function normalizePreset(preset) {
  if (!preset) {
    return null;
  }

  const filtersSource = preset.filters && typeof preset.filters === 'object'
    ? preset.filters
    : preset;
  const name = String(preset.name ?? '').trim();

  if (!name) {
    return null;
  }

  return {
    filters: extractKanbanFilters(filtersSource),
    id: String(preset.id ?? nextClientId('kanban-preset')).trim(),
    name,
  };
}

export function createKanbanColumnDraft(statuses = [], existingColumns = []) {
  const columnCount = existingColumns.length;
  const name = `Column ${columnCount + 1}`;
  const usedKeys = new Set(existingColumns.map((column) => column.key).filter(Boolean));

  return normalizeColumn({
    defaultStatus: statuses[0] ?? 'Not Started',
    key: uniqueBoardColumnKey(slugifyBoardColumnKey(name), usedKeys),
    keyFollowsName: true,
    name,
    statuses: [statuses[0] ?? 'Not Started'],
  }, columnCount, statuses);
}

export function hydrateKanbanConfig(config = {}, statuses = []) {
  const defaults = createDefaultKanbanConfig(statuses);
  const source = {
    ...defaults,
    ...(config ?? {}),
  };
  const columnsSource = Array.isArray(source.columns) && source.columns.length > 0
    ? source.columns
    : defaults.columns;

  return {
    ...extractKanbanFilters(source),
    columns: assignBoardColumnKeys(columnsSource.map((column, index) => normalizeColumn(column, index, statuses))),
    presets: Array.isArray(source.presets)
      ? source.presets.map(normalizePreset).filter(Boolean)
      : [],
    swimlane: normalizeSwimlane(source.swimlane),
  };
}

export function createKanbanConfigPayload(config = {}, statuses = []) {
  const hydrated = hydrateKanbanConfig(config, statuses);

  return {
    ...extractKanbanFilters(hydrated),
    columns: hydrated.columns.map(({ clientId: _clientId, keyFollowsName: _keyFollowsName, ...column }) => ({
      ...column,
    })),
    presets: hydrated.presets.map((preset) => ({
      filters: {
        ...preset.filters,
      },
      id: preset.id,
      name: preset.name,
    })),
    swimlane: hydrated.swimlane,
  };
}

/**
 * Renames a column. Columns that have never been saved keep their key in step with the
 * name; saved columns keep their key so existing card placements survive a rename.
 */
export function renameKanbanColumn(columns = [], index, name) {
  return columns.map((column, columnIndex) => {
    if (columnIndex !== index) {
      return column;
    }

    if (!column.keyFollowsName) {
      return { ...column, name };
    }

    const usedKeys = new Set(columns.filter((_, otherIndex) => otherIndex !== index).map((entry) => entry.key).filter(Boolean));
    return {
      ...column,
      key: uniqueBoardColumnKey(slugifyBoardColumnKey(name, `column-${index + 1}`), usedKeys),
      name,
    };
  });
}

export function setKanbanColumnKey(columns = [], index, value) {
  const usedKeys = new Set(columns.filter((_, otherIndex) => otherIndex !== index).map((entry) => entry.key).filter(Boolean));
  const base = slugifyBoardColumnKey(value, columns[index]?.key ?? `column-${index + 1}`);

  return columns.map((column, columnIndex) => (
    columnIndex === index
      ? { ...column, key: uniqueBoardColumnKey(base, usedKeys), keyFollowsName: false }
      : column
  ));
}

export function reorderKanbanColumns(columns = [], fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= columns.length || toIndex >= columns.length) {
    return columns;
  }

  const next = [...columns];
  const [column] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, column);
  return next;
}

/** Maps each status to the names of every column that accepts it. */
export function kanbanStatusOwners(columns = []) {
  const owners = new Map();

  for (const column of columns) {
    for (const status of column.statuses ?? []) {
      owners.set(status, [...(owners.get(status) ?? []), column.name]);
    }
  }

  return owners;
}

export function createKanbanPreset(name, config = {}) {
  const trimmedName = String(name ?? '').trim();
  if (!trimmedName) {
    return null;
  }

  return {
    filters: extractKanbanFilters(config),
    id: nextClientId('kanban-preset'),
    name: trimmedName,
  };
}

export function applyKanbanPreset(config = {}, preset, statuses = []) {
  const normalizedPreset = normalizePreset(preset);
  if (!normalizedPreset) {
    return hydrateKanbanConfig(config, statuses);
  }

  return hydrateKanbanConfig({
    ...config,
    ...normalizedPreset.filters,
  }, statuses);
}
