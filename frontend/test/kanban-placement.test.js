import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildKanbanMovePatch,
  moveKanbanCard,
  resolveKanbanColumn,
  resolveKanbanDropAnchors,
} from '../src/lib/projects/kanban-placement.js';
import {
  createKanbanColumnDraft,
  hydrateKanbanConfig,
  renameKanbanColumn,
  reorderKanbanColumns,
  setKanbanColumnKey,
} from '../src/lib/projects/project-kanban-config.js';
import { buildKanbanLanes } from '../src/lib/projects/project-planning.js';

const STATUSES = ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed'];
const COLUMNS = [
  { defaultStatus: 'In Progress', key: 'doing', name: 'Doing', statuses: ['In Progress'] },
  { defaultStatus: 'At Risk', key: 'blocked-external', name: 'Blocked: external', statuses: ['At Risk'] },
  { defaultStatus: 'At Risk', key: 'blocked-human', name: 'Blocked: needs human', statuses: ['At Risk'] },
];

test('a placed card lands in its column even when an earlier column shares the status', () => {
  const lanes = buildKanbanLanes([
    { boardColumn: 'blocked-human', id: 'a', status: 'At Risk' },
    { boardColumn: null, id: 'b', status: 'At Risk' },
  ], COLUMNS, 'none');

  const cardsByColumn = Object.fromEntries(lanes[0].columns.map((column) => [column.key, column.cards.map((card) => card.id)]));
  assert.deepEqual(cardsByColumn, { 'blocked-external': ['b'], 'blocked-human': ['a'], doing: [] });
});

test('a stale placement falls back to the first column accepting the status', () => {
  assert.equal(resolveKanbanColumn({ boardColumn: 'blocked-human', status: 'In Progress' }, COLUMNS).key, 'doing');
  assert.equal(resolveKanbanColumn({ boardColumn: 'missing', status: 'At Risk' }, COLUMNS).key, 'blocked-external');
});

test('moving between columns that share a status keeps the status', () => {
  assert.deepEqual(buildKanbanMovePatch({ status: 'At Risk' }, COLUMNS[2]), { boardColumn: 'blocked-human', status: 'At Risk' });
  assert.deepEqual(buildKanbanMovePatch({ status: 'In Progress' }, COLUMNS[2]), { boardColumn: 'blocked-human', status: 'At Risk' });
});

test('hydrated columns get unique keys derived from their names', () => {
  const config = hydrateKanbanConfig({
    columns: [
      { defaultStatus: 'At Risk', name: 'Blocked', statuses: ['At Risk'] },
      { defaultStatus: 'At Risk', name: 'Blocked', statuses: ['At Risk'] },
    ],
  }, STATUSES);

  assert.deepEqual(config.columns.map((column) => column.key), ['blocked', 'blocked-2']);
});

test('new columns track their name until saved; saved columns keep their key on rename', () => {
  const saved = hydrateKanbanConfig({ columns: COLUMNS }, STATUSES).columns;
  const draft = createKanbanColumnDraft(STATUSES, saved);
  const withDraft = renameKanbanColumn([...saved, draft], 3, 'Waiting on review');
  const renamedSaved = renameKanbanColumn(withDraft, 0, 'Working');

  assert.equal(withDraft[3].key, 'waiting-on-review');
  assert.equal(renamedSaved[0].key, 'doing');
  assert.equal(renamedSaved[0].name, 'Working');
  assert.equal(setKanbanColumnKey(renamedSaved, 3, 'Blocked External')[3].key, 'blocked-external-2');
});

test('reorderKanbanColumns moves a column to the drop index', () => {
  assert.deepEqual(reorderKanbanColumns(COLUMNS, 2, 0).map((column) => column.key), ['blocked-human', 'doing', 'blocked-external']);
  assert.equal(reorderKanbanColumns(COLUMNS, 1, 1), COLUMNS);
});

test('drop anchors are the neighbors at the drop index, ignoring the dragged card', () => {
  assert.deepEqual(resolveKanbanDropAnchors(['a', 'b', 'c'], 'c', 0), { afterItemId: null, beforeItemId: 'a' });
  assert.deepEqual(resolveKanbanDropAnchors(['a', 'b', 'c'], 'a', 1), { afterItemId: 'b', beforeItemId: 'c' });
  assert.deepEqual(resolveKanbanDropAnchors(['a', 'b'], 'x', 2), { afterItemId: 'b', beforeItemId: null });
  assert.deepEqual(resolveKanbanDropAnchors([], 'x', 0), { afterItemId: null, beforeItemId: null });
});

test('moving a card locally places it after its anchor and applies the column patch', () => {
  const cards = [{ id: 'a', status: 'Doing' }, { id: 'b', status: 'Doing' }, { id: 'c', status: 'Review' }];

  assert.deepEqual(moveKanbanCard(cards, 'c', { afterItemId: 'a' }, { status: 'Doing' }), [
    { id: 'a', status: 'Doing' },
    { id: 'c', status: 'Doing' },
    { id: 'b', status: 'Doing' },
  ]);
  assert.deepEqual(moveKanbanCard(cards, 'a', { beforeItemId: 'c' }).map((card) => card.id), ['b', 'a', 'c']);
  assert.deepEqual(moveKanbanCard(cards, 'b', {}, { status: 'Review' }).map((card) => card.status), ['Doing', 'Review', 'Review']);
});
