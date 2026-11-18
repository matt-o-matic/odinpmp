import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOdinMcpServer } from '../src/mcp/server.js';
import { OdinApiError } from '../src/mcp/api-client.js';

const version = '2026-10-01T12:00:00.000Z';
const project = {
  id: 'project-1', name: 'Disposable project', status: 'Active', updatedAt: version,
  epics: [{ id: 'epic-1', name: 'Epic', description: 'Epic details', version: 2, status: 'Not Started', priority: 4,
    stories: [{ id: 'story-1', name: 'Story', description: 'Story details', version: 3, status: 'In Progress', priority: 2,
      tasks: [{ id: 'task-1', name: 'Task', description: 'Task details', version: 4, status: 'Not Started', priority: 1 }] }] }],
};

async function session(t, request) {
  const calls = [];
  const api = { request: async (...args) => { calls.push(args); return request(...args); } };
  const server = createOdinMcpServer({ api });
  const client = new Client({ name: 'odin-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 2000 });
  return { client, call, calls };
}

function data(result) {
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}

test('MCP initialization advertises all 151 tools, strict top-level schemas, and mutation annotations', async (t) => {
  const { client } = await session(t, () => { throw new Error('Discovery must not call Odin.'); });
  assert.equal(client.getServerVersion().name, 'odin-v2');
  assert.match(client.getInstructions(), /Dry runs change nothing and check no permissions/);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), [
    'odin_activate_sprint', 'odin_add_comment', 'odin_complete_sprint', 'odin_create_item', 'odin_create_project', 'odin_create_sprint', 'odin_delete_comment', 'odin_delete_item',
    'odin_get_project_brief', 'odin_update_project_brief', 'odin_get_board', 'odin_get_board_config', 'odin_get_item', 'odin_get_project', 'odin_list_comments',
    'odin_create_package_upload', 'odin_get_package_status', 'odin_get_requirements_context', 'odin_get_round_feedback',
    'odin_link_work_items', 'odin_list_item_relations', 'odin_unlink_work_items',
    'odin_get_workflows', 'odin_list_items', 'odin_list_projects', 'odin_list_sprints', 'odin_reorder_board_card', 'odin_update_board_config', 'odin_update_comment', 'odin_update_item', 'odin_update_project', 'odin_update_sprint',
    'odin_list_clarifications', 'odin_get_clarification', 'odin_preview_clarification_assignment', 'odin_assign_clarification',
    'odin_list_stakeholders', 'odin_add_stakeholder', 'odin_list_stakeholder_links', 'odin_preview_stakeholder_invitation', 'odin_send_stakeholder_invitation',
    'odin_revoke_stakeholder_link', 'odin_extend_stakeholder_link', 'odin_list_project_members', 'odin_update_project_members', 'odin_add_project_resource',
    'odin_create_requirement_topic', 'odin_update_requirement_topic', 'odin_dismiss_requirement_topic', 'odin_reopen_requirement_topic', 'odin_delete_requirement_topic',
    'odin_move_requirement_topic', 'odin_add_requirement_topic_comment', 'odin_list_requirement_topic_summaries', 'odin_record_requirement_decision',
    'odin_preview_round_publish', 'odin_publish_round', 'odin_preview_round_reviewers', 'odin_update_round_reviewers', 'odin_update_stakeholder',
    // Resources, task access, allocations, time, time off and sprint capacity.
    'odin_update_project_resource', 'odin_get_task_access', 'odin_set_task_access', 'odin_send_task_access_link',
    // What changed in a project since a cursor.
    'odin_get_project_changes', 'odin_get_item_details', 'odin_apply_item_changes',
    'odin_add_project_allocation', 'odin_update_project_allocation', 'odin_remove_project_allocation', 'odin_move_allocation_hours',
    'odin_log_time', 'odin_list_time_entries', 'odin_update_time_entry', 'odin_delete_time_entry',
    'odin_list_time_off', 'odin_add_time_off', 'odin_delete_time_off', 'odin_get_sprint_capacity', 'odin_set_sprint_capacity',
    // Tickets and mentions.
    'odin_create_ticket', 'odin_delete_ticket', 'odin_list_tickets_awaiting_review', 'odin_review_ticket', 'odin_get_ticket_options', 'odin_list_mentionable_people',
    // Approvals, custom fields, revisions, splits and templates.
    'odin_list_approvals', 'odin_request_approval', 'odin_decide_approval', 'odin_get_custom_fields', 'odin_set_custom_field',
    'odin_restore_item_revision', 'odin_split_story', 'odin_list_project_templates',
    // Project files and requirements extras.
    'odin_list_project_files', 'odin_read_project_file', 'odin_view_project_file', 'odin_upload_project_file', 'odin_delete_project_file',
    'odin_download_project_file', 'odin_list_file_versions', 'odin_upload_file_version', 'odin_restore_file_version', 'odin_link_project_file', 'odin_unlink_project_file',
    // The file tree: the project, its channels and their folders, and moving files in it.
    'odin_list_file_folders', 'odin_create_folder', 'odin_rename_folder', 'odin_move_folder', 'odin_delete_folder', 'odin_move_file', 'odin_rename_file',
    'odin_get_my_requirements_work', 'odin_update_requirement_topic_comment', 'odin_delete_requirement_topic_comment',
    // Sharing files with stakeholders and signature requests.
    'odin_set_file_audience', 'odin_list_signing_requests', 'odin_get_signing_request', 'odin_request_signatures',
    'odin_cancel_signing_request', 'odin_remove_signer', 'odin_remind_signers',
    // A project's billing from invoice-gen and the SOW milestone each story bills to.
    'odin_get_project_billing', 'odin_set_story_milestones',
    // The workspace tools MCP clients share with the assistant, and governance.
    'odin_project_overview', 'odin_find_items', 'odin_create_plan_items', 'odin_update_items', 'odin_assign_items_to_sprint', 'odin_check_plan_quality',
    'odin_list_item_revisions', 'odin_list_tickets', 'odin_update_ticket', 'odin_get_governance', 'odin_get_schedule_analysis',
    'odin_create_governance_item', 'odin_update_governance_item', 'odin_delete_governance_item', 'odin_create_milestone', 'odin_update_milestone',
    'odin_delete_milestone', 'odin_create_dependency', 'odin_update_dependency', 'odin_delete_dependency', 'odin_update_working_calendar',
    'odin_create_schedule_baseline', 'odin_get_timeline', 'odin_get_insights', 'odin_get_project_team', 'odin_get_my_work', 'odin_search',
  ].sort());
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  assert.equal(tools.find(({ name }) => name === 'odin_get_item').annotations.readOnlyHint, true);
  assert.equal(tools.find(({ name }) => name === 'odin_update_item').annotations.readOnlyHint, false);
  assert.equal(tools.find(({ name }) => name === 'odin_delete_item').annotations.destructiveHint, true);
});

test('project and item reads return versions and hierarchy without child collections', async (t) => {
  const { call, calls } = await session(t, () => ({ ok: true, project }));
  const metadata = data(await call('odin_get_project', { projectId: project.id }));
  assert.equal(metadata.project.updatedAt, version);
  assert.equal(metadata.project.epics, undefined);
  const list = data(await call('odin_list_items', { projectId: project.id, limit: 2 }));
  assert.equal(list.total, 3);
  assert.deepEqual(list.items.map(({ id, parentId, itemType }) => ({ id, parentId, itemType })), [
    { id: 'epic-1', parentId: null, itemType: 'epic' }, { id: 'story-1', parentId: 'epic-1', itemType: 'story' },
  ]);
  assert.equal(list.items[0].stories, undefined);
  assert.equal(list.items[1].tasks, undefined);
  const task = data(await call('odin_get_item', { projectId: project.id, itemId: 'task-1' })).item;
  assert.equal(task.version, 4);
  assert.equal(task.priority, 1);
  assert.equal(task.description, 'Task details');
  assert.ok(calls.every(([method, path]) => method === 'GET' && path === '/api/projects/project-1'));
});

test('Brief discovery matches the API fields, and patch validation never fills omitted fields', async (t) => {
  const { projectAssistantBriefWriteSchema } = await import('../src/modules/projects/projects.schema.js');
  const { client, call, calls } = await session(t, () => { throw new Error('Dry runs must not call Odin.'); });
  const definition = (await client.listTools()).tools.find(({ name }) => name === 'odin_update_project_brief');
  assert.deepEqual(Object.keys(definition.inputSchema.properties.input.properties.patch.properties).sort(), Object.keys(projectAssistantBriefWriteSchema.shape).sort());
  assert.equal(definition.annotations.destructiveHint, true);
  const args = { projectId: 'fixture', dryRun: true, input: { expectedUpdatedAt: null, patch: { constraints: [' One '], implementationEffort: null } } };
  const preview = data(await call('odin_update_project_brief', args));
  assert.equal(preview.validation, 'schema_only');
  assert.equal(preview.authorizationChecked, false);
  assert.deepEqual(preview.request, { method: 'PATCH', path: '/api/projects/fixture/assistant-brief', body: { expectedUpdatedAt: null, patch: { constraints: ['One'], implementationEffort: '' } } });
  const invalid = [
    {}, { expectedUpdatedAt: null, patch: {} }, { expectedUpdatedAt: 'bad', patch: { objective: 'x' } },
    { patch: { objective: 'x' } }, { expectedUpdatedAt: null, patch: { narrative: 'readonly' } },
    { expectedUpdatedAt: null, patch: { sourceSessionId: 'readonly' } }, { expectedUpdatedAt: null, patch: { committedAt: version } },
    { expectedUpdatedAt: null, patch: { invented: 'x' } }, { expectedUpdatedAt: null, patch: { constraints: 'not a list' } },
    { expectedUpdatedAt: null, patch: { requirements: [' '] } }, { expectedUpdatedAt: null, patch: { stakeholders: [{ name: 'contact' }] } },
    { expectedUpdatedAt: null, patch: { name: 'x'.repeat(161) } }, { expectedUpdatedAt: null, patch: { objective: 'x'.repeat(5001) } },
    { expectedUpdatedAt: null, patch: { constraints: Array(21).fill('x') } }, { expectedUpdatedAt: null, patch: { requirements: Array(41).fill('x') } },
    { expectedUpdatedAt: null, patch: { requirements: ['x'.repeat(5001)] } },
  ];
  for (const input of invalid) assert.equal(data(await call('odin_update_project_brief', { ...args, input })).error.code, 'validation_error');
  const limits = { name: 'x'.repeat(160), objective: 'x'.repeat(5000), constraints: Array(20).fill('x'), requirements: Array(40).fill('x'.repeat(5000)) };
  assert.equal(data(await call('odin_update_project_brief', { ...args, input: { expectedUpdatedAt: version, patch: limits } })).ok, true);
  assert.equal(calls.length, 0);
});

test('project pagination terminates and rejects changed snapshots, filters, and malformed cursors', async (t) => {
  let projects = [project, { ...project, id: 'project-2', name: 'Second disposable project' }, { ...project, id: 'project-3', name: 'Third project' }];
  const { call } = await session(t, () => ({ ok: true, projects }));
  const first = data(await call('odin_list_projects', { limit: 1 }));
  const second = data(await call('odin_list_projects', { limit: 2, cursor: first.nextCursor }));
  assert.deepEqual(second.items.map(({ id }) => id), ['project-2', 'project-3']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.total, 3);
  const changedFilter = data(await call('odin_list_projects', { limit: 1, cursor: first.nextCursor, search: 'disposable' }));
  assert.equal(changedFilter.error.code, 'stale_cursor');
  projects = projects.map((entry) => ({ ...entry, updatedAt: '2026-10-01T12:01:00.000Z' }));
  assert.equal(data(await call('odin_list_projects', { cursor: first.nextCursor })).error.code, 'stale_cursor');
  for (const cursor of ['not-json', Buffer.from(JSON.stringify({ offset: -1, snapshot: 'bad' })).toString('base64url'), Buffer.from(JSON.stringify({ offset: 99, snapshot: 'bad' })).toString('base64url')]) {
    assert.equal(data(await call('odin_list_projects', { cursor })).error.code, 'invalid_cursor');
  }
});

test('item pagination scopes cursors to parent, type, and project filters', async (t) => {
  const { call } = await session(t, () => ({ ok: true, project }));
  const first = data(await call('odin_list_items', { projectId: project.id, limit: 1 }));
  const next = data(await call('odin_list_items', { projectId: project.id, limit: 2, cursor: first.nextCursor }));
  assert.deepEqual(next.items.map(({ id }) => id), ['story-1', 'task-1']);
  assert.equal(next.nextCursor, null);
  for (const changed of [{ projectId: 'project-2' }, { itemType: 'task' }, { parentId: null }, { status: 'Not Started' }, { search: 'Task' }]) {
    const result = data(await call('odin_list_items', { projectId: project.id, limit: 1, cursor: first.nextCursor, ...changed }));
    assert.ok(['stale_cursor', 'invalid_cursor'].includes(result.error.code));
  }
});

test('comments paginate whole threads and preserve target query parameters', async (t) => {
  const comments = [{ id: 'comment-1', comment: 'First', children: [{ id: 'reply-1', comment: 'Reply', children: [] }] }, { id: 'comment-2', comment: 'Second', children: [] }];
  const { call, calls } = await session(t, () => ({ ok: true, comments }));
  const args = { projectId: project.id, targetType: 'task', targetId: 'task-1', limit: 1 };
  const first = data(await call('odin_list_comments', args));
  assert.equal(first.items[0].children.length, 1);
  const next = data(await call('odin_list_comments', { ...args, cursor: first.nextCursor }));
  assert.equal(next.items[0].id, 'comment-2');
  assert.equal(next.nextCursor, null);
  assert.deepEqual(calls[0], ['GET', '/api/projects/project-1/comments', { query: { targetType: 'task', targetId: 'task-1' } }]);
});

test('board reads retain metadata and request only story/task cards by default', async (t) => {
  const board = { columns: [{ name: 'Doing', statuses: ['In Progress'], defaultStatus: 'In Progress' }], filters: {}, members: [{ id: 'user-1' }], sprints: [], cards: [{ id: 'story-1' }, { id: 'task-1' }] };
  const { call, calls } = await session(t, () => ({ ok: true, board }));
  const first = data(await call('odin_get_board', { projectId: project.id, limit: 1 }));
  assert.deepEqual(first.board.columns, board.columns);
  assert.deepEqual(first.board.members, board.members);
  assert.equal(first.board.cards, undefined);
  assert.deepEqual(calls[0][2].query.issueTypes, ['story', 'task']);
  const next = data(await call('odin_get_board', { projectId: project.id, limit: 1, cursor: first.nextCursor }));
  assert.deepEqual(next.cards, [{ id: 'task-1' }]);
  assert.equal(next.nextCursor, null);
});

test('saved board presets normalize application filter metadata for strict config round trips', async (t) => {
  const config = { columns: [{ name: 'Doing', statuses: ['In Progress'], defaultStatus: 'In Progress' }], swimlane: 'epic', presets: [
    { id: 'preset-1', name: 'Mine', filters: { search: 'Disposable', columns: [], presets: [], swimlane: 'none', assigneeIds: [], selectedSprintIds: [], statusValues: [], issueTypes: ['story'], hideDone: false, includeBacklog: true } },
  ] };
  const { call, calls } = await session(t, () => ({ ok: true, config }));
  const saved = data(await call('odin_get_board_config', { projectId: project.id })).config;
  assert.equal(saved.presets[0].filters.columns, undefined);
  assert.equal(saved.presets[0].filters.presets, undefined);
  assert.equal(saved.presets[0].filters.swimlane, undefined);
  assert.equal(saved.presets[0].filters.search, 'Disposable');
  const result = data(await call('odin_update_board_config', { projectId: project.id, config: saved, dryRun: true }));
  assert.equal(result.ok, true);
  assert.equal(result.validation, 'schema_only');
  assert.equal(calls.length, 1);
});

test('all mutation dry runs validate input schemas without making API requests', async (t) => {
  const { call, calls } = await session(t, () => { throw new Error('A dry run must not reach Odin.'); });
  const mutations = [
    ['odin_create_project', { input: { name: 'Disposable', status: 'Active' } }, 'POST'],
    ['odin_update_project', { projectId: project.id, input: { name: 'Disposable', status: 'Active', expectedUpdatedAt: version } }, 'PUT'],
    ['odin_create_item', { projectId: project.id, input: { itemType: 'task', parentId: 'missing-story', item: { name: 'Disposable task', status: 'Unknown workflow state' } } }, 'POST'],
    ['odin_update_item', { projectId: project.id, itemId: 'missing-task', input: { expectedVersion: 999, patch: { priority: 7 } } }, 'PATCH'],
    ['odin_delete_item', { projectId: project.id, itemId: 'missing-task', expectedVersion: 999 }, 'DELETE'],
    ['odin_add_comment', { projectId: project.id, input: { targetType: 'task', targetId: 'missing-task', comment: 'Disposable comment' } }, 'POST'],
    ['odin_update_comment', { projectId: project.id, targetType: 'task', targetId: 'missing-task', commentId: 'missing-comment', comment: 'Updated' }, 'PUT'],
    ['odin_delete_comment', { projectId: project.id, targetType: 'task', targetId: 'missing-task', commentId: 'missing-comment' }, 'DELETE'],
    ['odin_update_board_config', { projectId: project.id, config: { columns: [{ name: 'Doing', defaultStatus: 'Unknown workflow state', statuses: ['Unknown workflow state'] }] } }, 'PUT'],
    ['odin_create_sprint', { projectId: project.id, input: { name: 'Disposable sprint' } }, 'POST'],
    ['odin_update_sprint', { projectId: project.id, sprintId: 'missing-sprint', input: { name: 'Updated sprint' } }, 'PUT'],
    ['odin_activate_sprint', { projectId: project.id, sprintId: 'missing-sprint' }, 'POST'],
    ['odin_complete_sprint', { projectId: project.id, sprintId: 'missing-sprint' }, 'POST'],
  ];
  for (const [name, args, method] of mutations) {
    const result = data(await call(name, { ...args, dryRun: true }));
    assert.equal(result.ok, true, name);
    assert.equal(result.dryRun, true, name);
    assert.equal(result.validation, 'schema_only', name);
    assert.equal(result.authorizationChecked, false, name);
    assert.equal(result.request.method, method, name);
  }
  assert.equal(calls.length, 0);
});

test('strict validation rejects unknown fields, invalid IDs, unsupported types and missing versions before API calls', async (t) => {
  const { call, calls } = await session(t, () => { throw new Error('Invalid input must not reach Odin.'); });
  const invalid = [
    ['odin_list_projects', { unknown: true }], ['odin_list_projects', { limit: 101 }], ['odin_list_projects', { limit: '1' }],
    ['odin_get_project', { projectId: '../secret' }],
    ['odin_create_project', { input: { name: 'Disposable', status: 'Active', unknown: true }, dryRun: true }],
    ['odin_create_project', { input: { name: 'Disposable', status: 'Active' }, dryRun: 'true' }],
    ['odin_update_project', { projectId: project.id, input: { name: 'Disposable', status: 'Active' } }],
    ['odin_create_item', { projectId: project.id, input: { itemType: 'ticket', item: { name: 'Not supported' } } }],
    ['odin_create_item', { projectId: project.id, input: { itemType: 'epic', item: { name: 'Epic', priority: 8 } } }],
    ['odin_create_item', { projectId: project.id, input: { itemType: 'epic', item: { name: 'Epic', unknown: true } } }],
    ['odin_create_item', { projectId: project.id, input: { itemType: 'epic', item: { name: 'Epic', severity: 'S1' } } }],
    ['odin_update_item', { projectId: project.id, itemId: 'task-1', input: { patch: { name: 'Updated' } } }],
    ['odin_update_item', { projectId: project.id, itemId: 'task-1', input: { expectedVersion: 1, patch: {} }, dryRun: true }],
    ['odin_update_item', { projectId: project.id, itemId: 'task-1', input: { expectedVersion: 1, patch: {} } }],
    ['odin_update_item', { projectId: project.id, itemId: 'task-1', input: { expectedVersion: 1, patch: { unknown: true } }, dryRun: true }],
    ['odin_update_item', { projectId: project.id, itemId: 'task-1', input: { expectedVersion: 1, patch: { externalReviewState: 'validated' } }, dryRun: true }],
    ['odin_delete_item', { projectId: project.id, itemId: 'task-1', expectedVersion: 0 }],
    ['odin_add_comment', { projectId: project.id, input: { targetType: 'sprint', targetId: 'sprint-1', comment: 'Unsupported' } }],
    ['odin_add_comment', { projectId: project.id, input: { targetType: 'task', targetId: 'task-1', comment: 'Hi', mentions: Array(21).fill('user-1') } }],
    ['odin_update_comment', { projectId: project.id, targetType: 'task', targetId: 'task-1', commentId: 'comment-1', comment: '  ' }],
    ['odin_update_comment', { projectId: project.id, targetType: 'clarification', targetId: 'clarification-1', commentId: 'comment-1', comment: 'Updated' }],
    ['odin_delete_comment', { projectId: project.id, targetType: 'sprint', targetId: 'sprint-1', commentId: 'comment-1' }],
    ['odin_get_board', { projectId: project.id, filters: { issueTypes: ['ticket'] } }],
    ['odin_update_board_config', { projectId: project.id, config: { columns: [{ name: 'Doing', statuses: ['In Progress'], defaultStatus: 'In Progress', unknown: true }] }, dryRun: true }],
    ['odin_update_board_config', { projectId: project.id, config: { presets: [{ id: 'preset-1', name: 'Mine', filters: { unknown: true } }] }, dryRun: true }],
    ['odin_create_sprint', { projectId: project.id, input: { name: 'Sprint', status: 'unknown' }, dryRun: true }],
    ['odin_update_sprint', { projectId: project.id, sprintId: '../sprint', input: { name: 'Sprint' }, dryRun: true }],
    ['odin_get_workflows', { projectId: project.id, offset: -1 }],
  ];
  for (const [name, args] of invalid) {
    const result = await call(name, args);
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
    assert.equal(data(result).error.code, 'validation_error', `${name}: ${JSON.stringify(args)}`);
  }
  assert.equal(calls.length, 0);
});

test('validation errors do not echo attacker-controlled keys or enum values', async (t) => {
  const { call } = await session(t, () => { throw new Error('Must not reach Odin.'); });
  const marker = 'secret-token-do-not-return';
  for (const [name, args] of [
    ['odin_get_project', { projectId: project.id, [marker]: true }],
    ['odin_create_item', { projectId: project.id, input: { itemType: marker, item: { name: 'Disposable' } } }],
  ]) {
    let output;
    try { output = JSON.stringify(await call(name, args)); } catch (error) { output = error.message; }
    assert.equal(output.includes(marker), false);
  }
});

test('versioned item updates preserve exact patches and return stale conflicts without retries', async (t) => {
  const { call, calls } = await session(t, (method) => {
    if (method === 'GET') return { ok: true, project };
    throw new OdinApiError(409, 'http_409', 'Odin reported a conflict. Read the latest state before retrying.');
  });
  const input = { expectedVersion: 1, patch: { name: 'Updated task', description: 'Updated details', status: 'In Progress', priority: 5 } };
  const result = await call('odin_update_item', { projectId: project.id, itemId: 'task-1', input });
  assert.equal(result.isError, true);
  assert.equal(data(result).error.status, 409);
  assert.deepEqual(calls, [
    // An item is looked up by id with pursuit work included (lib/projects/pursuit.js).
    ['GET', '/api/projects/project-1', { query: { pursuit: 'include' } }], ['PATCH', '/api/projects/project-1/items/task-1', { body: input }],
  ]);
});

test('project updates and item deletes forward optimistic concurrency preconditions', async (t) => {
  const { call, calls } = await session(t, (method) => method === 'GET' ? { ok: true, project } : { ok: true, project, item: project.epics[0] });
  const input = { name: 'Updated', status: 'Active', expectedUpdatedAt: version };
  const updated = data(await call('odin_update_project', { projectId: project.id, input }));
  assert.equal(updated.project.epics, undefined);
  // The project is read first for the caller's role (change-scope.js).
  const [, , { body }] = calls.find(([method]) => method === 'PUT');
  assert.equal(body.expectedUpdatedAt, version);
  assert.equal(body.description, '');
  assert.equal(body.startDate, null);
  await call('odin_delete_item', { projectId: project.id, itemId: 'task-1', expectedVersion: 4 });
  assert.deepEqual(calls.at(-1), ['DELETE', '/api/projects/project-1/items/task-1', { body: { expectedVersion: 4 } }]);
});

test('unknown items cannot reach update or delete routes', async (t) => {
  const { call, calls } = await session(t, () => ({ ok: true, project }));
  for (const [name, args] of [
    ['odin_update_item', { input: { expectedVersion: 1, patch: { name: 'Updated' } } }],
    ['odin_delete_item', { expectedVersion: 1 }],
  ]) {
    const result = data(await call(name, { projectId: project.id, itemId: 'missing-item', ...args }));
    assert.equal(result.error.code, 'item_not_found');
    assert.equal(result.error.status, 404);
  }
  assert.ok(calls.every(([method]) => method === 'GET'));
});

test('authorization errors preserve classifications and unknown internal failures are redacted', async (t) => {
  let failure = new OdinApiError(401, 'http_401', 'Odin session is invalid, expired, or revoked.');
  const { call } = await session(t, () => { throw failure; });
  for (const status of [401, 403, 404]) {
    failure = new OdinApiError(status, `http_${status}`, 'Safe error');
    const result = await call('odin_get_project', { projectId: project.id });
    assert.equal(result.isError, true);
    assert.equal(data(result).error.status, status);
  }
  failure = new Error('secret-token-do-not-return upstream stack');
  const result = await call('odin_get_project', { projectId: project.id });
  assert.equal(data(result).error.code, 'internal_error');
  assert.equal(JSON.stringify(result).includes('secret-token-do-not-return'), false);
});

test('sprint pagination detects changed sprint state and mutation routes preserve metadata', async (t) => {
  let sprints = [{ id: 'sprint-1', name: 'First sprint', status: 'planned' }, { id: 'sprint-2', name: 'Second sprint', status: 'planned' }];
  const { call, calls } = await session(t, (method) => method === 'GET' ? { ok: true, sprints } : { ok: true, sprint: sprints[0] });
  const first = data(await call('odin_list_sprints', { projectId: project.id, limit: 1 }));
  const next = data(await call('odin_list_sprints', { projectId: project.id, limit: 1, cursor: first.nextCursor }));
  assert.deepEqual(next.items, [sprints[1]]);
  assert.equal(next.nextCursor, null);
  sprints = sprints.map((sprint) => ({ ...sprint, status: 'active' }));
  assert.equal(data(await call('odin_list_sprints', { projectId: project.id, cursor: first.nextCursor })).error.code, 'stale_cursor');
  const input = { name: 'Updated sprint', goal: 'Complete disposable fixture', startDate: '2026-10-01', endDate: '2026-10-14', status: 'planned' };
  await call('odin_update_sprint', { projectId: project.id, sprintId: 'sprint-1', input });
  assert.deepEqual(calls.at(-1), ['PUT', '/api/projects/project-1/sprints/sprint-1', { body: input }]);
  await call('odin_activate_sprint', { projectId: project.id, sprintId: 'sprint-1' });
  assert.deepEqual(calls.at(-1), ['POST', '/api/projects/project-1/sprints/sprint-1/activate', { body: undefined }]);
  await call('odin_complete_sprint', { projectId: project.id, sprintId: 'sprint-1' });
  assert.deepEqual(calls.at(-1), ['POST', '/api/projects/project-1/sprints/sprint-1/complete', { body: undefined }]);
});

test('workflow discovery sends project scope and reports native pagination and version limitations', async (t) => {
  const workflow = { id: 'workflow-1', name: 'Project workflow', states: [{ name: 'Not Started' }], transitions: [] };
  const { call, calls } = await session(t, () => ({ ok: true, workflows: [workflow], bindings: [
    { projectId: project.id, itemType: 'story', workflowId: workflow.id },
    { projectId: 'other-project', itemType: 'story', workflowId: workflow.id },
    { projectId: project.id, itemType: 'ticket', workflowId: workflow.id },
  ], total: 3, limit: 1, offset: 0 }));
  const result = data(await call('odin_get_workflows', { projectId: project.id, limit: 1 }));
  assert.deepEqual(result.workflows, [workflow]);
  assert.deepEqual(result.bindings, [{ projectId: project.id, itemType: 'story', workflowId: workflow.id }]);
  assert.equal(result.nextOffset, 1);
  assert.deepEqual(result.priority, { min: 1, max: 7, default: 4 });
  assert.deepEqual(result.versionPolicy, { project: 'expectedUpdatedAt', item: 'expectedVersion', comment: null, boardConfig: null, boardOrder: null, sprint: null });
  assert.deepEqual(calls[0], ['GET', '/api/workflows', { query: { projectId: project.id, limit: 1, offset: 0 } }]);
});

test('unknown tool names and unsupported task execution produce redacted errors without API calls', async (t) => {
  const { client, call, calls } = await session(t, () => { throw new Error('Must not reach Odin.'); });
  const marker = 'secret-token-do-not-return';
  const unknown = await call(marker);
  assert.equal(data(unknown).error.code, 'invalid_tool_call');
  assert.equal(JSON.stringify(unknown).includes(marker), false);
  const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
  await assert.rejects(() => client.request({ method: 'tools/call', params: { name: 'odin_list_projects', arguments: {}, task: { ttl: 1000 } } }, CallToolResultSchema, { timeout: 2000 }), /Server does not support task creation/);
  assert.equal(calls.length, 0);
});

test('uncertain write errors reach MCP clients without retries', async (t) => {
  const { call, calls } = await session(t, () => { throw new OdinApiError(null, 'timeout', 'Odin request timed out.', { outcomeUnknown: true }); });
  const result = await call('odin_create_project', { input: { name: 'Disposable', status: 'Active' } });
  assert.equal(result.isError, true);
  assert.equal(data(result).error.outcomeUnknown, true);
  assert.equal(data(result).error.code, 'timeout');
  assert.equal(calls.length, 1);
});

test('comment edits and deletions verify the declared target thread and include nested replies', async (t) => {
  const comments = [{ id: 'comment-1', targetType: 'task', targetId: 'task-1', children: [{ id: 'reply-1', targetType: 'task', targetId: 'task-1', children: [] }] }];
  const { call, calls } = await session(t, (method) => method === 'GET' ? { ok: true, comments } : { ok: true });
  const target = { projectId: project.id, targetType: 'task', targetId: 'task-1' };
  await call('odin_update_comment', { ...target, commentId: 'reply-1', comment: 'Updated reply' });
  assert.deepEqual(calls, [
    ['GET', '/api/projects/project-1/comments', { query: { targetType: 'task', targetId: 'task-1' } }],
    ['PUT', '/api/projects/project-1/comments/reply-1', { body: { comment: 'Updated reply' } }],
  ]);
  await call('odin_delete_comment', { ...target, commentId: 'reply-1' });
  assert.deepEqual(calls.at(-1), ['DELETE', '/api/projects/project-1/comments/reply-1', { body: undefined }]);
  await call('odin_add_comment', { projectId: project.id, input: { targetType: 'task', targetId: 'task-1', parentId: 'reply-1', comment: 'Nested reply' } });
  assert.deepEqual(calls.at(-1), ['POST', '/api/projects/project-1/comments', { body: { targetType: 'task', targetId: 'task-1', parentId: 'reply-1', comment: 'Nested reply' } }]);
});

test('ticket comment IDs and reply parents from another target cannot reach mutation routes', async (t) => {
  const { call, calls } = await session(t, () => ({ ok: true, comments: [{ id: 'task-comment-1', targetType: 'task', targetId: 'task-1', children: [] }] }));
  const target = { projectId: project.id, targetType: 'task', targetId: 'task-1' };
  for (const [name, args] of [
    ['odin_update_comment', { ...target, commentId: 'ticket-comment-1', comment: 'Unsupported edit' }],
    ['odin_delete_comment', { ...target, commentId: 'ticket-comment-1' }],
    ['odin_add_comment', { projectId: project.id, input: { targetType: 'task', targetId: 'task-1', parentId: 'other-target-comment', comment: 'Wrong target reply' } }],
  ]) {
    const result = await call(name, args);
    assert.equal(result.isError, true, name);
    assert.equal(data(result).error.status, 404, name);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([method]) => method === 'GET'));
});

// Tickets the project read does not return are unknown here; mcp-ticket-tools.test.js covers visible and hidden tickets.
test('relation tools drop ends they cannot find, and unknown ids cannot be linked or listed', async (t) => {
  const relations = [
    { id: 'relation-1', direction: 'outgoing', fromItemId: 'story-1', toItemId: 'task-1', relationType: 'blocks', createdAt: version, createdBy: 'user-1', relatedItem: { available: true, id: 'task-1', itemType: 'task', name: 'Task', status: 'Not Started', epicId: 'epic-1', storyId: 'story-1' } },
    { id: 'relation-2', direction: 'incoming', fromItemId: 'ticket-1', toItemId: 'story-1', relationType: 'caused_by', createdAt: version, createdBy: 'user-1', relatedItem: { available: true, id: 'ticket-1', itemType: 'ticket', name: 'Customer report', status: 'new' } },
  ];
  const { call, calls } = await session(t, (method, path) => {
    if (method === 'GET' && path.endsWith('/relations')) return { ok: true, canEdit: true, relations };
    if (method === 'GET') return { ok: true, project };
    return { ok: true, relation: relations[0] };
  });
  const listed = data(await call('odin_list_item_relations', { projectId: project.id, itemId: 'story-1' }));
  assert.deepEqual(listed.relations, [{ createdAt: version, direction: 'outgoing', fromItemId: 'story-1', id: 'relation-1', relatedItem: { id: 'task-1', itemType: 'task', name: 'Task', status: 'Not Started' }, relationType: 'blocks', toItemId: 'task-1' }]);

  assert.equal(data(await call('odin_list_item_relations', { projectId: project.id, itemId: 'ticket-1' })).error.code, 'item_not_found');
  assert.equal(data(await call('odin_link_work_items', { projectId: project.id, fromItemId: 'ticket-1', relationType: 'caused_by', toItemId: 'story-1' })).error.code, 'item_not_found');
  assert.equal(data(await call('odin_link_work_items', { projectId: project.id, fromItemId: 'story-1', relationType: 'blocks', toItemId: 'story-1' })).error.code, 'invalid_relation');
  assert.equal(data(await call('odin_link_work_items', { projectId: project.id, fromItemId: 'story-1', relationType: 'relates_to', toItemId: 'task-1' })).error.code, 'validation_error');
  assert.equal(data(await call('odin_unlink_work_items', { projectId: project.id, itemId: 'story-1', relationId: 'relation-2' })).error.code, 'relation_not_found');
  assert.ok(calls.every(([method]) => method === 'GET'), 'no refused call reached a mutation route');

  await call('odin_link_work_items', { projectId: project.id, fromItemId: 'story-1', relationType: 'blocks', toItemId: 'task-1' });
  assert.deepEqual(calls.at(-1), ['POST', '/api/projects/project-1/items/story-1/relations', { body: { relationType: 'blocks', toItemId: 'task-1' } }]);
  await call('odin_unlink_work_items', { projectId: project.id, itemId: 'story-1', relationId: 'relation-1' });
  assert.deepEqual(calls.at(-1), ['DELETE', '/api/projects/project-1/relations/relation-1', { body: undefined }]);

  const before = calls.length;
  const preview = data(await call('odin_link_work_items', { projectId: project.id, fromItemId: 'story-1', relationType: 'duplicate_of', toItemId: 'epic-1', dryRun: true }));
  assert.equal(preview.validation, 'schema_only');
  assert.equal(calls.length, before);
});
