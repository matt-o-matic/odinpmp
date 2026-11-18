import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OdinApiError } from '../src/mcp/api-client.js';
import { createOdinMcpServer } from '../src/mcp/server.js';
import { toolNeedsConfirmation } from '../src/lib/agent/agent-tools.js';

// The requirements extras in the file area (access/files.js) against a fake Odin REST API: My
// items, and editing or deleting one's own topic comment. The flow over HTTP with OAuth is in
// mcp-file-e2e.test.js.

const REQ = '/api/projects/project-1/requirements';
const COMMENT = `${REQ}/topics/topic-1/comments/comment-1`;
const topic = { assignments: [], comments: [], id: 'topic-1', prompt: 'Where should the price appear?', state: 'open', track: 'experience' };

async function session(t, respond) {
  const calls = [];
  const server = createOdinMcpServer({ api: { request: async (...args) => { calls.push(args); return respond(...args); } } });
  const client = new Client({ name: 'odin-mcp-file-requirements-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 2000 });
    return { data: result.structuredContent, isError: result.isError === true };
  };
  return { call, calls, client };
}

test('My items comes back grouped, compact and capped', async (t) => {
  const answer = Array.from({ length: 30 }, (_, index) => ({ action: 'reply', createdAt: 'x', id: `topic-${index}`, kind: 'topic', meta: { commentCount: 2, lastActivityAt: '2026-10-01T00:00:00.000Z', role: 'primary', state: 'open' }, title: 'Q'.repeat(400), track: 'experience', updatedAt: 'x' }));
  const { call, calls } = await session(t, () => ({
    canCollaborate: true, canDecide: true, canEditPlans: true, counts: { answer: 30, decide: 1, drafts: 1, review: 1, total: 33 }, ok: true, projectRole: 'manager',
    groups: {
      answer,
      decide: [{ action: 'decide', id: 'topic-ready', kind: 'topic', meta: { evidence: { comments: 4 }, proposedAnswerStatus: 'agreed', signals: {}, status: 'open' }, title: 'Ready one', track: 'architecture' }],
      drafts: [{ action: 'preview', id: 'package-1', kind: 'package', meta: { source: 'mcp', version: 3 }, title: 'Draft v3', track: 'experience' }],
      review: [{ action: 'review', id: 'round-1', kind: 'round', meta: { dueAt: '2026-11-01T00:00:00.000Z', number: 2, packageId: 'package-0', required: true }, title: 'Round 2', track: 'experience' }],
    },
  }));
  const { data, isError } = await call('odin_get_my_requirements_work', { projectId: 'project-1' });
  assert.equal(isError, false);
  assert.deepEqual(calls, [['GET', `${REQ}/my-items`, undefined]]);
  assert.deepEqual([data.canDecide, data.counts.total, data.truncated], [true, 33, true]);
  assert.deepEqual([data.answer.total, data.answer.items.length, data.answer.omitted], [30, 25, 5]);
  assert.match(data.answer.items[0].title, /…\[\+100 chars\]$/);
  assert.deepEqual(data.decide.items[0], { id: 'topic-ready', kind: 'topic', proposedAnswer: 'agreed', title: 'Ready one', track: 'architecture' });
  assert.deepEqual(data.review.items[0], { dueAt: '2026-11-01T00:00:00.000Z', id: 'round-1', kind: 'round', number: 2, required: true, title: 'Round 2', track: 'experience' });
  assert.deepEqual(data.drafts.items[0], { id: 'package-1', kind: 'package', title: 'Draft v3', track: 'experience', version: 3 });
});

test('editing a comment sends only its text, refuses stakeholder tags, and remaps refusals', async (t) => {
  const { call, calls, client } = await session(t, () => ({ comment: { body: 'Reworded.', id: 'comment-1' }, ok: true, topic }));
  const annotations = Object.fromEntries((await client.listTools()).tools.map((tool) => [tool.name, tool.annotations]));
  assert.deepEqual([annotations.odin_update_requirement_topic_comment.destructiveHint, annotations.odin_delete_requirement_topic_comment.destructiveHint], [true, true]);
  const edited = await call('odin_update_requirement_topic_comment', { body: 'Reworded.', commentId: 'comment-1', projectId: 'project-1', topicId: 'topic-1' });
  assert.equal(edited.isError, false);
  assert.deepEqual(calls, [['PATCH', COMMENT, { body: { body: 'Reworded.' } }]]);
  assert.deepEqual([edited.data.comment.body, edited.data.clarification.id], ['Reworded.', 'topic-1']);

  const tagged = await call('odin_update_requirement_topic_comment', { body: 'Over to @[Sam](stakeholder:sh-1).', commentId: 'comment-1', projectId: 'project-1', topicId: 'topic-1' });
  assert.deepEqual([tagged.isError, tagged.data.error.code, calls.length], [true, 'stakeholder_mention', 1]);
  const preview = await call('odin_update_requirement_topic_comment', { body: 'Reworded.', commentId: 'comment-1', dryRun: true, projectId: 'project-1', topicId: 'topic-1' });
  assert.deepEqual([preview.data.dryRun, preview.data.request.path, calls.length], [true, COMMENT, 1]);

  for (const [status, code] of [[404, 'comment_not_found'], [409, 'comments_closed']]) {
    const refused = await session(t, () => { throw new OdinApiError(status, `http_${status}`, 'upstream'); });
    const { data } = await refused.call('odin_update_requirement_topic_comment', { body: 'x', commentId: 'comment-1', projectId: 'project-1', topicId: 'topic-1' });
    assert.equal(data.error.code, code);
  }
});

test('deleting a comment asks the user first and reports how it went', async (t) => {
  assert.equal(toolNeedsConfirmation('odin_delete_requirement_topic_comment', { commentId: 'comment-1', projectId: 'project-1', topicId: 'topic-1' }), true);
  assert.equal(toolNeedsConfirmation('odin_update_requirement_topic_comment', { body: 'x', commentId: 'comment-1', projectId: 'project-1', topicId: 'topic-1' }), false);
  const { call, calls } = await session(t, () => ({ comment: { deletedAt: 'x', id: 'comment-1' }, deleteMode: 'soft', ok: true, topic }));
  const { data, isError } = await call('odin_delete_requirement_topic_comment', { commentId: 'comment-1', projectId: 'project-1', topicId: 'topic-1' });
  assert.equal(isError, false);
  assert.deepEqual(calls, [['DELETE', COMMENT]]);
  assert.deepEqual([data.deleteMode, data.clarification.id], ['soft', 'topic-1']);
});
