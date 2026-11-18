import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryWorkflowRepository } from '../src/modules/workflows/workflows.repository.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';

test('stdio startup rejects missing or unsafe configuration without exposing values or protocol output', { timeout: 5000 }, async () => {
  for (const baseUrl of ['', 'https://credential-marker:secret-marker@example.invalid']) {
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/mcp/stdio.js', import.meta.url))], { timeout: 2000, env: { ODIN_MCP_BASE_URL: baseUrl, ODIN_MCP_ACCESS_TOKEN: 'token-marker', NODE_ENV: 'test' } }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /Odin MCP could not start/);
      assert.doesNotMatch(error.stderr, /credential-marker|secret-marker|token-marker|Error:| at /);
      return true;
    });
  }
});

async function fixture(t) {
  const users = [
    ['admin', 'admin', 'tenant-local'], ['viewer', 'user', 'tenant-local'],
    ['outsider', 'user', 'tenant-local'], ['member', 'user', 'tenant-local'], ['foreign', 'admin', 'tenant-other'],
  ].map(([id, role, tenantId]) => ({ id, email: `${id}@example.com`, name: id, authMethod: 'basic', password: 'Fixture-password-123!', preferences: { twoFactorEnabled: false }, memberships: [{ role, tenantId }] }));
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, users, tenants: [{ id: 'tenant-local', name: 'Local fixtures', domains: ['example.com'] }, { id: 'tenant-other', name: 'Other fixtures', domains: ['other.example'] }] });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: {
    projectMemberships: { 'project-local': [{ id: 'admin', role: 'admin' }, { id: 'viewer', role: 'viewer' }, { id: 'member', role: 'member' }] },
    projects: [
      { id: 'project-local', tenantId: 'tenant-local', name: 'Disposable project', status: 'Planned', updatedAt: '2026-01-01T00:00:00.000Z', epics: [] },
      { id: 'project-foreign', tenantId: 'tenant-other', name: 'Foreign fixture', status: 'Planned', epics: [] },
    ],
  } });
  const workflowRepository = createInMemoryWorkflowRepository();
  const definition = await workflowRepository.createWorkflow({ tenantId: 'tenant-local', input: {
    name: 'Fixture task workflow', status: 'active', itemTypes: ['task'],
    states: [{ key: 'Not Started', label: 'Not Started', initial: true }, { key: 'In Progress', label: 'In Progress' }, { key: 'Completed', label: 'Completed', terminal: true }],
    transitions: [{ key: 'start', fromState: 'Not Started', toState: 'In Progress', allowedRoles: ['admin'], requiredFields: [] }, { key: 'complete', fromState: 'In Progress', toState: 'Completed', allowedRoles: ['admin'], requiredFields: [] }],
  } });
  await workflowRepository.createBinding({ tenantId: 'tenant-local', input: { projectId: 'project-local', itemType: 'task', workflowId: definition.id } });
  const sessionsRepository = createInMemorySessionsRepository();
  const assistantRepository = createInMemoryAssistantRepository();
  const app = createApp({ assistantRepository, authRepository, projectRepository, workflowRepository, sessionsRepository, tokenService: createTokenService({ issuer: 'odin-mcp-fixture', secret: 'disposable-local-test-secret' }) });
  let requests = 0;
  const http = createServer((req, res) => { requests += 1; app(req, res); });
  t.after(async () => {
    await app.locals.beginDrain({ timeoutMs: 1000 });
    http.closeAllConnections();
    await new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    assert.equal(http.listening, false);
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  async function connect(userId) {
    const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auth-Response': 'bearer' }, body: JSON.stringify({ email: `${userId}@example.com`, password: 'Fixture-password-123!' }) });
    assert.equal(response.status, 200);
    const { session } = await response.json();
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp/stdio.js', import.meta.url))], env: { ODIN_MCP_BASE_URL: origin, ODIN_MCP_ACCESS_TOKEN: session.token, NODE_ENV: 'test' }, stderr: 'pipe' });
    const client = new Client({ name: 'odin-local-fixture-client', version: '1.0.0' });
    let stderr = '';
    transport.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(async () => {
      const pid = transport.pid;
      await client.close();
      if (pid) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.equal(stderr, '');
    });
    await client.connect(transport, { timeout: 5000 });
    return { client, session, async call(name, args = {}, status) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      const data = JSON.parse(result.content[0].text);
      assert.deepEqual(result.structuredContent, data);
      if (status) { assert.equal(result.isError, true); assert.equal(data.error.status, status); }
      else assert.equal(result.isError, undefined, JSON.stringify(data));
      return data;
    } };
  }
  return { connect, assistantRepository, projectRepository, sessionsRepository, requests: () => requests };
}

test('structured Brief MCP reads, patches and rejects stale or unauthorized writes over stdio and HTTP', { timeout: 30000 }, async (t) => {
  const env = await fixture(t);
  const admin = await env.connect('admin');
  const projectId = 'project-local';
  const scope = { projectId, tenantId: 'tenant-local' };
  const initial = await admin.call('odin_get_project_brief', { projectId });
  assert.equal(initial.briefUpdatedAt, null);
  assert.equal(Object.keys(initial.brief).length, 15);
  const brief = {
    name: 'Brief title', objective: 'Objective', currentState: 'Current state', proposedSolution: 'Scope',
    benefits: 'Benefits', implementationEffort: 'Effort', stakeholders: ['Stakeholder'], requirements: ['Requirement'],
    dependencies: ['Dependency'], constraints: ['Constraint'], successMetrics: ['Metric'], assumptions: ['Assumption'],
  };
  const saved = await admin.call('odin_update_project_brief', { projectId, input: { expectedUpdatedAt: null, patch: brief } });
  for (const [key, value] of Object.entries(brief)) assert.deepEqual(saved.brief[key], value, key);
  assert.ok(saved.briefUpdatedAt);
  const project = (await admin.call('odin_get_project', { projectId })).project;
  assert.equal(project.name, 'Disposable project');
  assert.equal(project.description, '');
  assert.equal(project.tenantId, scope.tenantId);
  assert.deepEqual(project.brief, saved.brief);
  await admin.call('odin_update_project_brief', { projectId, input: { expectedUpdatedAt: null, patch: { objective: 'Stale' } } }, 409);
  await env.assistantRepository.saveProjectAssistantState({ ...scope, value: {
    brief: { ...brief, narrative: 'Original narrative', sourceSessionId: 'session-fixture', committedAt: '2026-01-01T00:00:00.000Z' },
    artifacts: [{ id: 'artifact-fixture', name: 'Retain artifact' }],
  } });
  await admin.call('odin_update_project_brief', { projectId, input: { expectedUpdatedAt: saved.briefUpdatedAt, patch: { benefits: 'Stale after assistant write' } } }, 409);
  const fresh = await admin.call('odin_get_project_brief', { projectId });
  const cleared = await admin.call('odin_update_project_brief', { projectId, input: { expectedUpdatedAt: fresh.briefUpdatedAt, patch: { constraints: [], implementationEffort: '', stakeholders: [' New ', 'New'] } } });
  assert.deepEqual(cleared.brief.constraints, []);
  assert.equal(cleared.brief.implementationEffort, '');
  assert.deepEqual(cleared.brief.stakeholders, ['New']);
  assert.equal(cleared.brief.objective, brief.objective);
  assert.equal(cleared.brief.narrative, 'Original narrative');
  assert.equal(cleared.brief.sourceSessionId, 'session-fixture');
  assert.equal(cleared.brief.committedAt, '2026-01-01T00:00:00.000Z');
  assert.equal((await env.assistantRepository.getProjectAssistantState(scope)).artifacts.length, 1);
  assert.equal(cleared.stakeholderContacts, undefined);
  for (const who of ['viewer', 'member', 'outsider', 'foreign']) {
    const actor = await env.connect(who);
    if (who === 'viewer' || who === 'member') await actor.call('odin_get_project_brief', { projectId });
    else await actor.call('odin_get_project_brief', { projectId }, 404);
    await actor.call('odin_update_project_brief', { projectId, input: { expectedUpdatedAt: cleared.briefUpdatedAt, patch: { name: 'Denied' } } }, 404);
  }
});

test('stdio MCP uses real Odin HTTP routes, sessions, permissions and disposable repositories', { timeout: 30000 }, async (t) => {
  const env = await fixture(t);
  const admin = await env.connect('admin');
  const projectId = 'project-local';
  await t.test('initialize and discover all 151 tools', async () => {
    assert.equal(admin.client.getServerVersion().name, 'odin-v2');
    assert.ok(admin.client.getServerCapabilities().tools);
    const { tools } = await admin.client.listTools({}, { timeout: 5000 });
    assert.equal(tools.length, 151);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, 151);
    assert.ok(admin.client.getInstructions().includes('Dry runs change nothing and check no permissions'));
    const projects = await admin.call('odin_list_projects');
    assert.deepEqual(projects.items.map((project) => project.id), [projectId]);
  });
  let epic, story, task;
  await t.test('create hierarchy and maintain descriptions, priority, versions and parents', async () => {
    const createdProject = await admin.call('odin_create_project', { input: { name: 'Disposable created project', status: 'Planned', description: 'Fixture only' } });
    assert.equal(createdProject.project.name, 'Disposable created project');
    env.projectRepository.state.projectMemberships.set(createdProject.project.id, [{ id: 'admin', role: 'admin' }]);
    const initial = await admin.call('odin_get_project', { projectId });
    const input = { name: 'Maintained fixture', description: 'Updated fixture description', status: 'In Progress', expectedUpdatedAt: initial.project.updatedAt };
    await admin.call('odin_update_project', { projectId, input });
    await admin.call('odin_update_project', { projectId, input }, 409);
    epic = (await admin.call('odin_create_item', { projectId, input: { itemType: 'epic', item: { name: 'Fixture epic', status: 'Not Started' } } })).item;
    story = (await admin.call('odin_create_item', { projectId, input: { itemType: 'story', parentId: epic.id, item: { name: 'Fixture story' } } })).item;
    task = (await admin.call('odin_create_item', { projectId, input: { itemType: 'task', parentId: story.id, item: { name: 'Fixture task' } } })).item;
    const patch = { expectedVersion: task.version, patch: { description: 'Maintained task', priority: 2, status: 'In Progress' } };
    task = (await admin.call('odin_update_item', { projectId, itemId: task.id, input: patch })).item;
    assert.equal(task.priority, 2);
    assert.equal(task.description, 'Maintained task');
    assert.equal(task.status, 'In Progress');
    await admin.call('odin_update_item', { projectId, itemId: task.id, input: patch }, 409);
    await admin.call('odin_delete_item', { projectId, itemId: task.id, expectedVersion: patch.expectedVersion }, 409);
    const read = await admin.call('odin_get_item', { projectId, itemId: task.id });
    assert.equal(read.item.parentId, story.id);
    await admin.call('odin_create_item', { projectId, input: { itemType: 'task', parentId: epic.id, item: { name: 'Wrong parent' } } }, 400);
    await admin.call('odin_update_item', { projectId, itemId: task.id, input: { expectedVersion: task.version, patch: { status: 'Invalid workflow state' } } }, 409);
  });
  await t.test('pagination rejects stale snapshots and changed filters', async () => {
    const first = await admin.call('odin_list_items', { projectId, limit: 1 });
    assert.equal(first.total, 3);
    const second = await admin.call('odin_list_items', { projectId, limit: 1, cursor: first.nextCursor });
    assert.notEqual(first.items[0].id, second.items[0].id);
    await admin.call('odin_list_items', { projectId, limit: 1, cursor: first.nextCursor, search: 'Fixture' }, 409);
    task = (await admin.call('odin_update_item', { projectId, itemId: task.id, input: { expectedVersion: task.version, patch: { priority: 3 } } })).item;
    await admin.call('odin_list_items', { projectId, limit: 1, cursor: first.nextCursor }, 409);
  });
  await t.test('comments retain replies and use Odin author checks', async () => {
    const input = { targetType: 'task', targetId: task.id, comment: 'Disposable comment' };
    const root = (await admin.call('odin_add_comment', { projectId, input })).comment;
    const target = { projectId, targetType: 'task', targetId: task.id };
    await admin.call('odin_add_comment', { projectId, input: { ...input, parentId: root.id, comment: 'Disposable reply' } });
    await admin.call('odin_update_comment', { ...target, commentId: root.id, comment: 'Edited comment' });
    const threads = await admin.call('odin_list_comments', { projectId, targetType: 'task', targetId: task.id, limit: 1 });
    assert.equal(threads.items.length, 1);
    assert.equal(threads.items[0].children.length, 1);
    const member = await env.connect('member');
    await member.call('odin_update_comment', { ...target, commentId: root.id, comment: 'Denied author edit' }, 403);
    await member.call('odin_delete_comment', { ...target, commentId: root.id }, 403);
    await admin.call('odin_update_comment', { projectId, targetType: 'story', targetId: story.id, commentId: root.id, comment: 'Wrong target' }, 404);
    await admin.call('odin_add_comment', { projectId, input: { ...input, targetId: story.id, targetType: 'story', parentId: root.id } }, 404);
    await admin.call('odin_delete_comment', { ...target, commentId: root.id });
    assert.equal((await admin.call('odin_list_comments', { projectId, targetType: 'task', targetId: task.id })).total, 0);
  });
  await t.test('item relations link through Odin routes, stay idempotent and need plan-edit rights', async () => {
    const args = { projectId, fromItemId: story.id, relationType: 'blocks', toItemId: task.id };
    const linked = (await admin.call('odin_link_work_items', args)).relation;
    assert.equal((await admin.call('odin_link_work_items', args)).relation.id, linked.id);
    const onTask = await admin.call('odin_list_item_relations', { projectId, itemId: task.id });
    assert.deepEqual(onTask.relations.map((relation) => [relation.direction, relation.relationType, relation.relatedItem.id, relation.relatedItem.name]), [['incoming', 'blocks', story.id, 'Fixture story']]);
    await admin.call('odin_link_work_items', { ...args, toItemId: story.id }, 400);
    await admin.call('odin_link_work_items', { ...args, toItemId: 'missing-item' }, 404);
    const member = await env.connect('member');
    assert.equal((await member.call('odin_list_item_relations', { projectId, itemId: story.id })).relations.length, 1);
    await member.call('odin_link_work_items', { ...args, relationType: 'affects' }, 404);
    await member.call('odin_unlink_work_items', { projectId, itemId: story.id, relationId: linked.id }, 404);
    await admin.call('odin_unlink_work_items', { projectId, itemId: epic.id, relationId: linked.id }, 404);
    await admin.call('odin_unlink_work_items', { projectId, itemId: story.id, relationId: linked.id });
    assert.deepEqual((await admin.call('odin_list_item_relations', { projectId, itemId: task.id })).relations, []);
  });
  await t.test('board configuration round trips, filters paginate, and sprints assign through versioned items', async () => {
    const config = { columns: [{ name: 'Working', defaultStatus: 'In Progress', statuses: ['In Progress'] }], presets: [{ id: 'working', name: 'Working items', filters: { statusValues: ['In Progress'] } }], swimlane: 'sprint' };
    await admin.call('odin_update_board_config', { projectId, config });
    const saved = await admin.call('odin_get_board_config', { projectId });
    await admin.call('odin_update_board_config', { projectId, config: saved.config });
    const board = await admin.call('odin_get_board', { projectId, limit: 1 });
    assert.equal(board.board.columns[0].name, 'Working');
    assert.equal(board.total, 2);
    assert.equal((await admin.call('odin_get_board', { projectId, filters: { statusValues: ['In Progress'] } })).total, 1);
    const [firstCard, lastCard] = (await admin.call('odin_get_board', { projectId })).cards;
    await admin.call('odin_reorder_board_card', { projectId, itemId: lastCard.id, beforeItemId: firstCard.id });
    assert.deepEqual((await admin.call('odin_get_board', { projectId })).cards.map((card) => card.id), [lastCard.id, firstCard.id]);
    const sprint = (await admin.call('odin_create_sprint', { projectId, input: { name: 'Fixture sprint' } })).sprint;
    await admin.call('odin_update_sprint', { projectId, sprintId: sprint.id, input: { name: 'Updated sprint', goal: 'Local validation' } });
    assert.equal((await admin.call('odin_activate_sprint', { projectId, sprintId: sprint.id })).sprint.status, 'active');
    task = (await admin.call('odin_update_item', { projectId, itemId: task.id, input: { expectedVersion: task.version, patch: { sprintId: sprint.id, sprintSortOrder: 0 } } })).item;
    assert.equal((await admin.call('odin_get_board', { projectId, filters: { selectedSprintIds: [sprint.id], includeBacklog: false } })).total, 1);
    assert.equal((await admin.call('odin_complete_sprint', { projectId, sprintId: sprint.id })).sprint.status, 'completed');
    assert.equal((await admin.call('odin_list_sprints', { projectId })).items[0].name, 'Updated sprint');
    const workflows = await admin.call('odin_get_workflows', { projectId, limit: 1 });
    assert.equal(workflows.bindings[0].itemType, 'task');
    assert.equal(workflows.workflows[0].states[0].key, 'Not Started');
  });
  await t.test('schema-only dry runs make zero HTTP requests even for invalid application state', async () => {
    const before = env.requests();
    const preview = await admin.call('odin_update_item', { projectId: 'missing-project', itemId: 'missing-item', dryRun: true, input: { expectedVersion: 9999, patch: { status: 'Invalid workflow state' } } });
    assert.equal(preview.validation, 'schema_only');
    assert.equal(preview.authorizationChecked, false);
    assert.equal(env.requests(), before);
    const invalid = await admin.client.callTool({ name: 'odin_update_item', arguments: { projectId, itemId: task.id, dryRun: true, input: { expectedVersion: task.version, patch: {} } } }, undefined, { timeout: 5000 });
    assert.equal(invalid.isError, true);
    assert.equal(env.requests(), before);
  });
  await t.test('viewer, outsider, foreign tenant and revoked session cannot bypass Odin authorization', async () => {
    const viewer = await env.connect('viewer');
    await viewer.call('odin_get_project', { projectId });
    await viewer.call('odin_create_item', { projectId, input: { itemType: 'epic', item: { name: 'Denied' } } }, 404);
    const outsider = await env.connect('outsider');
    assert.equal((await outsider.call('odin_list_projects')).total, 0);
    await outsider.call('odin_get_project', { projectId }, 404);
    const foreign = await env.connect('foreign');
    await foreign.call('odin_get_project', { projectId }, 404);
    await admin.call('odin_get_project', { projectId: 'project-foreign' }, 404);
    await env.sessionsRepository.revokeToken({ token: viewer.session.refreshToken });
    await viewer.call('odin_get_project', { projectId }, 401);
  });
  await t.test('versioned deletion respects workflows and removes children before parents', async () => {
    const blocked = await admin.call('odin_delete_item', { projectId, itemId: epic.id, expectedVersion: epic.version }, 409);
    assert.equal(blocked.error.code, 'children_exist');
    const previousVersion = task.version;
    task = (await admin.call('odin_update_item', { projectId, itemId: task.id, input: { expectedVersion: task.version, patch: { status: 'Completed' } } })).item;
    await admin.call('odin_delete_item', { projectId, itemId: task.id, expectedVersion: previousVersion }, 409);
    await admin.call('odin_delete_item', { projectId, itemId: task.id, expectedVersion: task.version });
    const currentStory = await admin.call('odin_get_item', { projectId, itemId: story.id });
    await admin.call('odin_delete_item', { projectId, itemId: story.id, expectedVersion: currentStory.item.version });
    const current = await admin.call('odin_get_item', { projectId, itemId: epic.id });
    await admin.call('odin_delete_item', { projectId, itemId: epic.id, expectedVersion: current.item.version });
    assert.equal((await admin.call('odin_list_items', { projectId })).total, 0);
    await admin.call('odin_get_item', { projectId, itemId: task.id }, 404);
  });
});
