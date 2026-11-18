import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hoursSummary, openItemCounts, parseAmount, projectAssignees, projectTeamRows, roleSuggestions, skillLevelLabel, skillSuggestions,
} from '../src/lib/resources/resources.js';

test('rates are typed, not nudged: currency symbols and commas are fine, nonsense is explained', () => {
  assert.deepEqual(parseAmount('$1,250.50'), { value: 1250.5 });
  assert.deepEqual(parseAmount(' 150 '), { value: 150 });
  assert.deepEqual(parseAmount('.5'), { value: 0.5 });
  assert.deepEqual(parseAmount(''), { value: null });
  assert.match(parseAmount('12abc', { label: 'Project rate' }).error, /Project rate must be a number/);
  assert.match(parseAmount('-4').error, /must be a number/);
  assert.match(parseAmount('200', { max: 168 }).error, /between 0 and 168/);
});

test('role and skill suggestions put what the workspace uses first, then the catalog', () => {
  const resources = [{ roles: ['Wizard', 'Technical Lead'], skills: [{ level: 5, name: 'Vue' }] }, { roles: ['wizard'], skills: [{ level: 2, name: 'Spells' }] }];
  const roles = roleSuggestions(resources);
  assert.deepEqual(roles.slice(0, 2), ['Wizard', 'Technical Lead']);
  assert.equal(roles.filter((role) => role.toLowerCase() === 'technical lead').length, 1);
  assert.ok(roles.includes('Project Manager'));
  assert.deepEqual(skillSuggestions(resources).slice(0, 2), ['Spells', 'Vue']);
  assert.equal(skillLevelLabel(5), 'Expert');
  assert.equal(skillLevelLabel(1), 'Learning');
});

const team = {
  allocations: [
    { allocationPercent: 50, endDate: '2026-12-31', hoursPerWeek: 20, id: 'a1', projectId: 'p1', resourceId: 'r-ada', scenario: 'baseline', startDate: '2026-10-01', status: 'active' },
    { allocationPercent: 0, endDate: '2026-12-31', hoursPerWeek: 0, id: 'a2', origin: 'assignment', projectId: 'p1', resourceId: 'r-casey', scenario: 'baseline', startDate: '2026-10-01', status: 'active' },
    { allocationPercent: 100, endDate: '2026-12-31', hoursPerWeek: 40, id: 'a3', projectId: 'p1', resourceId: 'r-old', scenario: 'baseline', startDate: '2026-01-01', status: 'completed' },
  ],
  directory: [],
  people: [
    { assigneeId: 'ada', resource: { id: 'r-ada', name: 'Ada Lovelace', userId: 'ada' } },
    { assigneeId: 'resource:r-casey', resource: { id: 'r-casey', name: 'Casey Contractor', userId: null } },
  ],
  projectId: 'p1',
};
const members = [{ email: 'ada@example.com', id: 'ada', name: 'Ada Lovelace', role: 'admin' }, { email: 'bo@example.com', id: 'bo', name: 'Bo Member', role: 'user' }];

test('anyone allocated can own work: members first, then resources without a login', () => {
  assert.deepEqual(projectAssignees(members, team).map((person) => [person.id, person.name, Boolean(person.resourceOnly)]), [
    ['ada', 'Ada Lovelace', false],
    ['bo', 'Bo Member', false],
    ['resource:r-casey', 'Casey Contractor', true],
  ]);
  assert.equal(projectAssignees(members, null).length, 2);
});

test('the Resources tab joins members and allocations through linked logins', () => {
  const rows = projectTeamRows({ members, team });
  assert.deepEqual(rows.map((row) => [row.name, row.access, row.allocation?.id ?? null, row.assigneeId]), [
    ['Ada Lovelace', 'admin', 'a1', 'ada'],
    ['Bo Member', 'user', null, 'bo'],
    ['Casey Contractor', null, 'a2', 'resource:r-casey'],
  ]);
  assert.equal(hoursSummary(rows[0].allocation), '20 h/wk · 50%');
  assert.equal(hoursSummary(rows[2].allocation), 'Hours not set');
  assert.equal(hoursSummary(null), 'Not allocated');
});

test('open item counts skip finished work', () => {
  const counts = openItemCounts({ epics: [{ assigneeId: 'ada', status: 'In Progress', stories: [{ assigneeId: 'ada', status: 'Completed', tasks: [{ assigneeId: 'resource:r-casey', status: 'Not Started' }] }] }] });
  assert.deepEqual([...counts], [['ada', 1], ['resource:r-casey', 1]]);
});
