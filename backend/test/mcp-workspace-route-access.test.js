import assert from 'node:assert/strict';
import test from 'node:test';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';

// The MCP route allowlist for the workspace tools and governance (access/workspace.js): every route
// they call, the scope each needs, and how grants limited to some projects are held to them,
// including on the reads that span projects. The rest of home, reporting and Insights stays outside.

const P = '/api/projects/project-1';
const readOnly = { projectIds: [], scopes: ['projects.read'] };
const readWrite = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
const restricted = { projectIds: ['project-1'], scopes: ['projects.read', 'projects.write'] };
const elsewhere = { projectIds: ['project-2'], scopes: ['projects.read', 'projects.write'] };

function check(method, originalUrl, grant = readWrite, body = undefined) {
  try {
    requireMcpRouteAccess({ body, method, originalUrl }, grant);
    return 'allowed';
  } catch (error) {
    return `${error.statusCode} ${error.message}`;
  }
}

// Reads that name their project, including the project, sprint, member and team reads the tools
// make along the way (listed in route-access.js and access/resources.js).
const PROJECT_READS = [
  P, `${P}/sprints`, `${P}/valid-users`, '/api/resource-planning/projects/project-1/team',
  `${P}/governance`, `${P}/governance/schedule-analysis`, `${P}/insights?days=30`,
  `${P}/items/story-1/revisions?limit=15`, `${P}/tickets?limit=40&statusValues=Open`,
];
const WRITES = [
  ['POST', `${P}/items`], ['PATCH', `${P}/items/story-1`], ['POST', `${P}/sprints/assign-items`],
  ...['items', 'milestones', 'dependencies'].flatMap((collection) => [
    ['POST', `${P}/governance/${collection}`], ['PATCH', `${P}/governance/${collection}/record-1`], ['DELETE', `${P}/governance/${collection}/record-1`],
  ]),
  ['PUT', `${P}/governance/working-calendar`], ['POST', `${P}/governance/schedule-baselines`],
];
const ACROSS = ['/api/home', '/api/home?agentView=1', '/api/projects/tickets?limit=40', '/api/reporting/search?query=launch&limit=20'];

test('the workspace tools\' reads need projects.read and their writes projects.write', () => {
  for (const url of [...PROJECT_READS, ...ACROSS]) assert.equal(check('GET', url, readOnly), 'allowed', url);
  for (const [method, url] of WRITES) {
    assert.equal(check(method, url), 'allowed', `${method} ${url}`);
    assert.equal(check(method, url, readOnly), '403 The MCP grant lacks the required scope.', `${method} ${url}`);
  }
});

test('the rest of home, reporting, Insights and governance stays outside the grant', () => {
  for (const [method, url] of [
    ['PUT', '/api/home/lens'], ['POST', '/api/home/recovery/proposal-1/stage'], ['GET', '/api/home/extra'],
    ['GET', '/api/reporting'], ['GET', '/api/reporting/dashboards'], ['GET', '/api/reporting/analytics/change-trends'], ['POST', '/api/reporting/search/refresh'],
    ['GET', '/api/reporting/bi/projects'], ['POST', '/api/reporting/views'], ['POST', '/api/reporting/reports/report-1/run'], ['POST', '/api/reporting/reports/report-1/download'],
    ['POST', '/api/reporting/subscriptions'], ['DELETE', '/api/reporting/subscriptions/sub-1'],
    ['PUT', `${P}/insights/layout`], ['DELETE', `${P}/insights/layout`], ['GET', `${P}/insights/reports/report-1`],
    ['PATCH', `${P}/governance/working-calendar`], ['GET', `${P}/governance/working-calendar`], ['GET', `${P}/governance/schedule-baselines`],
    ['PATCH', `${P}/governance/schedule-baselines/base-1`], ['DELETE', `${P}/governance/schedule-baselines/base-1`],
    ['PUT', `${P}/governance/items/risk-1`], ['GET', `${P}/governance/items`], ['GET', `${P}/governance/milestones/m-1`], ['POST', `${P}/governance/dependencies/dep-1`],
    ['POST', `${P}/governance/risks`], ['DELETE', `${P}/governance`], ['GET', `${P}/governance/schedule-analysis/extra`],
    ['GET', `${P}/sprints/assign-items`], ['POST', `${P}/items/story-1/revisions`],
  ]) {
    assert.equal(check(method, url), '403 This operation is outside the MCP grant.', `${method} ${url}`);
  }
});

test('grants limited to some projects reach only their projects', () => {
  for (const url of PROJECT_READS) {
    assert.equal(check('GET', url, restricted), 'allowed', url);
    assert.equal(check('GET', url, elsewhere), '404 Project not found.', url);
  }
  for (const [method, url] of WRITES) {
    assert.equal(check(method, url, restricted), 'allowed', `${method} ${url}`);
    assert.equal(check(method, url, elsewhere), '404 Project not found.', `${method} ${url}`);
  }
});

test('reads across projects: grants for every project make them; limited grants search one of theirs, and get no home or cross-project tickets', () => {
  for (const url of ACROSS) assert.equal(check('GET', url), 'allowed', url);
  for (const url of ['/api/home', '/api/home?lens=team', '/api/home?agentView=1', '/api/projects/tickets', '/api/projects/tickets?projectIds=project-1', '/api/reporting/search?query=launch']) {
    assert.equal(check('GET', url, restricted), '404 Project not found.', url);
  }
  assert.equal(check('GET', '/api/reporting/search?query=launch&projectId=project-1', restricted), 'allowed');
  assert.equal(check('GET', '/api/reporting/search?query=launch&projectId=project-1', elsewhere), '404 Project not found.');
  assert.equal(check('GET', '/api/reporting/search?query=launch&projectId=project-2', restricted), '404 Project not found.');
});
