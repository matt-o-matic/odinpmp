import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTreeMetrics,
  createProjectSelection,
  filterProjectTree,
  formatDateRange,
  normalizeDateValue,
  resolveProjectSelection,
  serializeProjectSnapshot,
} from '../src/lib/projects/project-editor.js';

function createProjectFixture() {
  return {
    description: 'Modernize the editor.',
    endDate: '',
    epics: [
      {
        description: 'Main workspace.',
        id: 'epic-1',
        name: 'Workbench',
        status: 'In Progress',
        stories: [
          {
            description: 'Restore the story editor.',
            id: 'story-1',
            name: 'Story polish',
            status: 'In Progress',
            tasks: [
              {
                assigneeName: 'Riley',
                description: 'Implement selection state.',
              id: 'task-1',
                name: 'Selection model',
                priority: 1,
                sprintId: 'sprint-1',
                status: 'Completed',
                targetEndDate: '',
                targetHourEstimate: 6,
                targetStartDate: '',
              },
              {
                assigneeName: 'Morgan',
                description: 'Build the task table.',
                id: 'task-2',
                name: 'Task table',
                priority: 2,
                status: 'In Progress',
                targetEndDate: '',
                targetStartDate: '',
              },
            ],
          },
          {
            description: 'Polish the side pane.',
            id: 'story-2',
            name: 'Tree controls',
            status: 'Not Started',
            tasks: [
              {
                assigneeName: '',
                description: 'Add a filter box.',
                id: 'task-3',
                name: 'Filter tree',
                priority: 2,
                status: 'Not Started',
                targetEndDate: '',
                targetStartDate: '',
              },
            ],
          },
        ],
      },
    ],
    id: 'project-1',
    name: 'OdinPMP',
    startDate: '2026-05-12',
    status: 'In Progress',
  };
}

test('createProjectSelection and resolveProjectSelection fall back to the project root', () => {
  const project = createProjectFixture();

  assert.deepEqual(createProjectSelection({ type: 'story', epicId: 'missing' }), { type: 'project' });

  const resolved = resolveProjectSelection(project, { type: 'task', epicId: 'epic-1', storyId: 'story-1', taskId: 'missing' });

  assert.equal(resolved.type, 'project');
  assert.equal(resolved.item.id, 'project-1');
});

test('filterProjectTree preserves parent nodes for matching descendants', () => {
  const project = createProjectFixture();

  const filtered = filterProjectTree(project, 'task table');

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'epic-1');
  assert.equal(filtered[0].stories.length, 1);
  assert.equal(filtered[0].stories[0].id, 'story-1');
  assert.equal(filtered[0].stories[0].tasks.length, 1);
  assert.equal(filtered[0].stories[0].tasks[0].id, 'task-2');
});

test('serializeProjectSnapshot normalizes optional values in the nested draft', () => {
  const snapshot = serializeProjectSnapshot(createProjectFixture());

  assert.equal(snapshot.endDate, null);
  assert.equal(snapshot.epics[0].stories[0].tasks[0].targetStartDate, null);
  assert.equal(snapshot.epics[0].stories[0].tasks[0].priority, 1);
  assert.equal(snapshot.epics[0].stories[0].tasks[0].sprintId, 'sprint-1');
  assert.equal(snapshot.epics[0].stories[0].tasks[0].targetHourEstimate, 6);
});

test('buildTreeMetrics summarizes story and task totals plus estimate-weighted completion', () => {
  const project = createProjectFixture();
  const metrics = buildTreeMetrics('epic', project.epics[0]);

  assert.equal(metrics.storyCount, 2);
  assert.equal(metrics.taskCount, 3);
  // 6h completed plus half of a 16h default task, out of 6h + 16h + 16h.
  assert.equal(metrics.completedPercent, 37);
  const active = metrics.progress.buckets.find((bucket) => bucket.key === 'active');
  assert.equal(active.hours, 8);
  assert.equal(active.itemCount, 1);
});

test('serializeProjectSnapshot carries a clamped percent complete and actual hours', () => {
  const project = createProjectFixture();
  project.epics[0].stories[0].tasks[1].percentComplete = '42.4';
  project.epics[0].stories[0].tasks[1].actualHours = '3.456';

  const snapshot = serializeProjectSnapshot(project);

  assert.equal(snapshot.epics[0].stories[0].tasks[1].percentComplete, 42);
  assert.equal(snapshot.epics[0].stories[0].tasks[1].actualHours, 3.46);
  assert.equal(snapshot.epics[0].stories[0].tasks[0].percentComplete, null);
  assert.equal(snapshot.epics[0].stories[0].tasks[0].actualHours, null);
});

test('serializeProjectSnapshot carries remaining hours only for items that have the field', () => {
  const project = createProjectFixture();
  project.epics[0].stories[0].tasks[1].remainingHours = '4.567';
  project.epics[0].stories[0].tasks[0].remainingHours = '';

  const snapshot = serializeProjectSnapshot(project);

  assert.equal(snapshot.epics[0].stories[0].tasks[1].remainingHours, 4.57);
  assert.equal(snapshot.epics[0].stories[0].tasks[0].remainingHours, null, 'a cleared field saves as not set');
  assert.equal('remainingHours' in snapshot.epics[0].stories[0], false, 'an item loaded without the field never sends it');
});

test('formatDateRange returns a readable fallback', () => {
  assert.equal(formatDateRange('', ''), 'Dates TBD');
  assert.equal(formatDateRange('2026-05-12', ''), 'Starts 2026-05-12');
});

test('timestamp dates from the API become values the date inputs can show', () => {
  assert.equal(normalizeDateValue('2026-10-26T00:00:00.000Z'), '2026-10-26');
  assert.equal(normalizeDateValue('2026-10-26'), '2026-10-26');
  assert.equal(normalizeDateValue(''), null);
  assert.equal(normalizeDateValue(null), null);

  const snapshot = serializeProjectSnapshot({
    epics: [{ id: 'e1', name: 'Epic', stories: [], targetEndDate: '2026-10-30T00:00:00.000Z', targetStartDate: '2026-10-26T00:00:00.000Z' }],
    name: 'Project',
  });
  assert.equal(snapshot.epics[0].targetStartDate, '2026-10-26');
  assert.equal(snapshot.epics[0].targetEndDate, '2026-10-30');
});
