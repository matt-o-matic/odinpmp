import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OdinApiError } from '../src/mcp/api-client.js';
import { MAX_UPLOAD_BYTES } from '../src/mcp/file-tools.js';
import { createOdinMcpServer } from '../src/mcp/server.js';
import { toolNeedsConfirmation } from '../src/lib/agent/agent-tools.js';

// The project file tools against a fake Odin REST API: the requests they send, what they
// return, and the messages they give for Odin's refusals. The routes themselves are in
// mcp-file-api.test.js and the flow over HTTP with OAuth in mcp-file-e2e.test.js.

const FILES = '/api/projects/project-1/files';
const stored = (overrides = {}) => ({
  contentType: 'text/markdown', createdAt: '2026-10-01T09:00:00.000Z', description: 'Kickoff', fileName: 'kickoff.md', fileSize: 120, id: 'file-1',
  inlineImage: false, projectId: 'project-1', targetId: 'project-1', targetType: 'project', tenantId: 'tenant-1',
  updatedAt: '2026-10-01T09:00:00.000Z', uploadedBy: { id: 'user-1', name: 'Ada Admin' }, ...overrides,
});

async function session(t, respond) {
  const calls = [];
  const server = createOdinMcpServer({ api: { request: async (...args) => { calls.push(args); return respond(...args); } } });
  const client = new Client({ name: 'odin-mcp-file-test', version: '1.0.0' });
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

test('the file tools are annotated for what they do, and the assistant asks before a delete', async (t) => {
  const { client } = await session(t, () => ({ ok: true }));
  const tools = Object.fromEntries((await client.listTools()).tools.map((tool) => [tool.name, tool.annotations]));
  assert.deepEqual([tools.odin_list_project_files.readOnlyHint, tools.odin_read_project_file.readOnlyHint], [true, true]);
  assert.deepEqual([tools.odin_upload_project_file.readOnlyHint, tools.odin_upload_project_file.destructiveHint], [false, false], 'a replacement keeps the file it replaces as an earlier version');
  assert.deepEqual([tools.odin_list_file_versions.readOnlyHint, tools.odin_download_project_file.readOnlyHint], [true, true]);
  for (const name of ['odin_upload_file_version', 'odin_restore_file_version', 'odin_link_project_file', 'odin_unlink_project_file']) {
    assert.deepEqual([tools[name].readOnlyHint, tools[name].destructiveHint], [false, false], name);
    assert.equal(toolNeedsConfirmation(name, { fileId: 'file-1', projectId: 'project-1' }), false, name);
  }
  assert.deepEqual([tools.odin_delete_project_file.readOnlyHint, tools.odin_delete_project_file.destructiveHint], [false, true]);
  assert.equal(toolNeedsConfirmation('odin_delete_project_file', { fileId: 'file-1', projectId: 'project-1' }), true);
  assert.equal(toolNeedsConfirmation('odin_upload_project_file', { fileName: 'a.md', projectId: 'project-1', text: 'x' }), false);
  assert.equal(toolNeedsConfirmation('odin_upload_project_file', { fileName: 'a.md', projectId: 'project-1', replace: true, text: 'x' }), false);
});

test('listing names the project or one target, and returns compact entries without tenant or user ids', async (t) => {
  const { call, calls } = await session(t, () => ({ ok: true, files: [
    stored(),
    stored({ contentType: 'application/pdf', description: 'Signed SOW', fileName: 'sow.pdf', id: 'file-2', targetId: 'topic-1', targetType: 'clarification' }),
  ] }));
  const all = await call('odin_list_project_files', { projectId: 'project-1' });
  assert.equal(all.isError, false);
  assert.deepEqual(calls[0], ['GET', FILES, { query: { agentView: 1, targetId: 'project-1', targetType: 'project' } }], 'every file call asks for the agent view (D-027)');
  assert.equal(all.data.total, 2);
  assert.deepEqual(all.data.items[0], {
    attachedTo: { id: 'project-1', type: 'project' }, audience: 'internal', contentType: 'text/markdown', description: 'Kickoff', fileName: 'kickoff.md', fileSize: 120,
    id: 'file-1', path: '/', readable: true, updatedAt: '2026-10-01T09:00:00.000Z', uploadedBy: 'Ada Admin', version: 1,
  });
  // A file in the project's files or a channel library carries its folder path, from the file tree.
  assert.deepEqual(calls[1], ['GET', '/api/projects/project-1/file-tree']);
  assert.equal(all.data.items[1].path, undefined, 'a file on a topic is not in the tree');
  assert.deepEqual([all.data.items[1].attachedTo, all.data.items[1].readable], [{ id: 'topic-1', type: 'topic' }, true], 'a PDF is read through text extraction');

  const searched = await call('odin_list_project_files', { projectId: 'project-1', search: 'sow' });
  assert.deepEqual(searched.data.items.map((file) => file.id), ['file-2']);
  await call('odin_list_project_files', { projectId: 'project-1', targetId: 'topic-1', targetType: 'topic' });
  assert.deepEqual(calls.findLast(([, path]) => path === FILES)[2], { query: { agentView: 1, targetId: 'topic-1', targetType: 'clarification' } });
  const missing = await call('odin_list_project_files', { projectId: 'project-1', targetType: 'story' });
  assert.deepEqual([missing.isError, missing.data.error.code], [true, 'target_required']);
});

test('reading returns a window of text and says where to read on', async (t) => {
  const { call, calls } = await session(t, () => ({ ok: true, file: stored(), text: { content: '# Kickoff', end: 9, nextOffset: 9, offset: 0, totalChars: 40 } }));
  const { data, isError } = await call('odin_read_project_file', { fileId: 'file-1', maxChars: 9, projectId: 'project-1' });
  assert.equal(isError, false);
  assert.deepEqual(calls, [['GET', `${FILES}/file-1/text`, { query: { agentView: 1, maxChars: 9, offset: 0, version: undefined } }]]);
  assert.deepEqual([data.text, data.range, data.nextOffset, data.file.id, data.file.tenantId], ['# Kickoff', { end: 9, offset: 0, totalChars: 40 }, 9, 'file-1', undefined]);
});

test('versions: list, read an earlier one, upload one with its expected version, and restore', async (t) => {
  const { call, calls } = await session(t, (method, path) => {
    if (path.endsWith('/versions') && method === 'GET') return { ok: true, file: stored({ version: 2 }), versions: [{ contentType: 'text/markdown', current: true, fileName: 'kickoff.md', fileSize: 9, note: 'Scope', uploadedAt: '2026-10-02T09:00:00.000Z', uploadedBy: { id: 'user-1', name: 'Ada Admin' }, version: 2 }] };
    if (path.endsWith('/text')) return { ok: true, file: stored({ version: 1 }), text: { content: 'old', end: 3, nextOffset: null, offset: 0, totalChars: 3 } };
    return { ok: true, file: stored({ version: 3, versionNote: 'Scope' }), unchanged: false };
  });
  const listed = await call('odin_list_file_versions', { fileId: 'file-1', projectId: 'project-1' });
  assert.deepEqual(listed.data.items, [{ contentType: 'text/markdown', current: true, fileName: 'kickoff.md', fileSize: 9, note: 'Scope', uploadedAt: '2026-10-02T09:00:00.000Z', uploadedBy: 'Ada Admin', version: 2 }]);

  await call('odin_read_project_file', { fileId: 'file-1', projectId: 'project-1', version: 1 });
  assert.equal(calls.at(-1)[2].query.version, 1);

  const text = await call('odin_upload_file_version', { expectedVersion: 2, fileId: 'file-1', note: 'Scope', projectId: 'project-1', text: '# New' });
  assert.equal(text.isError, false, JSON.stringify(text.data));
  assert.deepEqual([text.data.file.version, text.data.unchanged], [3, false]);
  const [method, path, options] = calls.at(-1);
  assert.deepEqual([method, path, options.query], ['POST', `${FILES}/file-1/versions`, { agentView: 1 }]);
  assert.deepEqual({ ...options.body, fileContentsBase64: Buffer.from(options.body.fileContentsBase64, 'base64').toString() }, { expectedVersion: 2, fileContentsBase64: '# New', fileType: 'text/markdown', note: 'Scope' });

  const renamed = await call('odin_upload_file_version', { contentBase64: Buffer.from('%PDF').toString('base64'), contentType: 'application/pdf', expectedVersion: 2, fileId: 'file-1', fileName: 'kickoff-v3.pdf', projectId: 'project-1' });
  assert.deepEqual([calls.at(-1)[2].body.fileName, calls.at(-1)[2].body.fileType], ['kickoff-v3.pdf', 'application/pdf']);
  assert.equal(renamed.isError, false);

  await call('odin_restore_file_version', { expectedVersion: 3, fileId: 'file-1', projectId: 'project-1', version: 1 });
  assert.deepEqual(calls.at(-1).slice(0, 2), ['POST', `${FILES}/file-1/versions/1/restore`]);
  assert.deepEqual(calls.at(-1)[2].body, { expectedVersion: 3 });

  const before = calls.length;
  const dry = await call('odin_restore_file_version', { dryRun: true, expectedVersion: 3, fileId: 'file-1', projectId: 'project-1', version: 1 });
  assert.deepEqual([dry.data.dryRun, calls.length], [true, before]);
});

test('a version on a stale file or a held file says so, and a text version needs a text name', async (t) => {
  for (const [status, code] of [[409, 'file_changed'], [423, 'legal_hold'], [403, 'http_403'], [404, 'file_not_found']]) {
    const { call } = await session(t, (method) => { if (method === 'POST') throw new OdinApiError(status, `http_${status}`, 'upstream'); return { file: stored() }; });
    const { data, isError } = await call('odin_upload_file_version', { expectedVersion: 1, fileId: 'file-1', projectId: 'project-1', text: 'x' });
    assert.deepEqual([isError, data.error.code], [true, code]);
  }
  const { call } = await session(t, () => ({ file: stored({ contentType: 'application/pdf', fileName: 'sow.pdf' }) }));
  assert.equal((await call('odin_upload_file_version', { expectedVersion: 1, fileId: 'file-1', projectId: 'project-1', text: 'x' })).data.error.code, 'text_file_name');
});

test('download gives a link by default and the bytes only when asked', async (t) => {
  const { call, calls } = await session(t, (method, path, { query }) => ({ ok: true, file: stored(), url: 'https://app.example/app/projects/project-1?projectSettings=files&file=file-1', ...(query.inline ? { contentBase64: 'aGk=' } : {}) }));
  const link = await call('odin_download_project_file', { fileId: 'file-1', projectId: 'project-1' });
  assert.deepEqual([calls[0][1], calls[0][2].query.inline, link.data.url.endsWith('file=file-1'), link.data.contentBase64], [`${FILES}/file-1/download`, 0, true, undefined]);
  const bytes = await call('odin_download_project_file', { fileId: 'file-1', inline: true, projectId: 'project-1', version: 2 });
  assert.deepEqual([calls[1][2].query.inline, calls[1][2].query.version, bytes.data.contentBase64], [1, 2, 'aGk=']);
});

test('links: a file goes on a work item and comes off by its link id', async (t) => {
  const { call, calls } = await session(t, () => ({ file: stored({ links: [{ id: 'link-1', linkedAt: '2026-10-01T09:00:00.000Z', targetId: 'story-1', targetName: 'Checkout', targetType: 'story' }] }), linked: true, ok: true }));
  const linked = await call('odin_link_project_file', { fileId: 'file-1', projectId: 'project-1', targetId: 'story-1', targetType: 'story' });
  assert.deepEqual([calls[0][0], calls[0][1], calls[0][2].body], ['POST', `${FILES}/file-1/links`, { targetId: 'story-1', targetType: 'story' }]);
  assert.deepEqual([linked.data.linked, linked.data.file.links], [true, [{ id: 'link-1', itemId: 'story-1', name: 'Checkout', type: 'story' }]]);
  await call('odin_unlink_project_file', { fileId: 'file-1', linkId: 'link-1', projectId: 'project-1' });
  assert.deepEqual(calls[1].slice(0, 2), ['DELETE', `${FILES}/file-1/links/link-1`]);
  const topic = await call('odin_link_project_file', { fileId: 'file-1', projectId: 'project-1', targetId: 'topic-1', targetType: 'topic' });
  assert.equal(topic.isError, true, 'a topic reaches stakeholders outside the team, so a link cannot go there');
});

test('reading a binary, oversized or missing file says what to do instead', async (t) => {
  for (const [status, code, pattern] of [
    [415, 'not_text', /spreadsheet, slides, an image/],
    [413, 'text_too_large', /over 5 MB for text, 15 MB for a PDF/],
    [422, 'no_text_extracted', /password-protected, damaged, scanned pages/],
    [503, 'text_busy', /Try again/],
    [404, 'file_not_found', /odin_list_project_files/],
  ]) {
    const { call } = await session(t, () => { throw new OdinApiError(status, `http_${status}`, 'upstream'); });
    const { data, isError } = await call('odin_read_project_file', { fileId: 'file-1', projectId: 'project-1' });
    assert.equal(isError, true);
    assert.equal(data.error.code, code);
    assert.match(data.error.message, pattern);
  }
});

test('uploading text picks the type from the name, checks for the name first, and returns the stored file', async (t) => {
  const { call, calls } = await session(t, (method) => (method === 'GET'
    ? { ok: true, files: [stored({ fileName: 'Kickoff.md', id: 'file-other', targetId: 'story-1', targetType: 'story' })] }
    : { ok: true, file: stored({ fileName: 'notes.md', id: 'file-new' }) }));
  const notes = '# Weekly sync\n\n- Launch stays on 1 Dec';
  const { data, isError } = await call('odin_upload_project_file', { description: 'Weekly sync notes', fileName: 'notes.md', projectId: 'project-1', text: notes });
  assert.equal(isError, false, JSON.stringify(data));
  assert.deepEqual(calls, [
    ['GET', FILES, { query: { agentView: 1, targetId: 'project-1', targetType: 'project' } }],
    ['POST', FILES, { body: { createOnly: true, fileContentsBase64: Buffer.from(notes).toString('base64'), fileDescription: 'Weekly sync notes', fileName: 'notes.md', fileType: 'text/markdown', targetId: 'project-1', targetType: 'project' } }],
  ]);
  assert.deepEqual([data.replaced, data.file.id, data.file.readable], [false, 'file-new', true]);
});

test('a name already on the target is refused unless replace is true', async (t) => {
  const { call, calls } = await session(t, (method) => (method === 'GET'
    ? { ok: true, files: [stored({ fileName: 'Notes.MD', id: 'file-old', targetId: 'story-1', targetType: 'story' })] }
    : { ok: true, file: stored({ fileName: 'notes.md', id: 'file-old', targetId: 'story-1', targetType: 'story' }) }));
  const args = { fileName: 'notes.md', projectId: 'project-1', targetId: 'story-1', targetType: 'story', text: 'v2' };
  const refused = await call('odin_upload_project_file', args);
  assert.deepEqual([refused.isError, refused.data.error.code, refused.data.error.details], [true, 'file_exists', { fileId: 'file-old' }]);
  assert.equal(calls.filter(([method]) => method === 'POST').length, 0);
  const replaced = await call('odin_upload_project_file', { ...args, replace: true });
  assert.deepEqual([replaced.isError, replaced.data.replaced], [false, true]);
});

test('Odin checks the name again as it saves: a file uploaded after the listing, or one replaced since, is not saved over', async (t) => {
  let files = [];
  const { call, calls } = await session(t, (method) => {
    if (method === 'GET') return { ok: true, files };
    throw new OdinApiError(409, 'http_409', 'upstream');
  });
  const args = { fileName: 'notes.md', projectId: 'project-1', text: 'ours' };
  const taken = await call('odin_upload_project_file', args);
  assert.deepEqual([taken.isError, taken.data.error.code], [true, 'file_exists']);
  assert.match(taken.data.error.message, /now exists/);
  assert.equal(calls.at(-1)[2].body.createOnly, true, 'a name free at the listing is saved only as a new file');

  files = [stored({ fileName: 'notes.md', id: 'file-old', signature: 'sig-listed' })];
  const changed = await call('odin_upload_project_file', { ...args, replace: true });
  assert.deepEqual([changed.isError, changed.data.error.code], [true, 'file_changed']);
  assert.deepEqual([calls.at(-1)[2].body.expectedSignature, calls.at(-1)[2].body.createOnly], ['sig-listed', undefined], 'a replacement goes over only the file listed, as it was');
});

test('base64 uploads need an allowed type and stay under the size cap; text needs a text name', async (t) => {
  const { call, calls } = await session(t, (method) => (method === 'GET' ? { ok: true, files: [] } : { ok: true, file: stored({ contentType: 'application/pdf', fileName: 'sow.pdf' }) }));
  const pdf = Buffer.from('%PDF-1.7 fixture').toString('base64');
  const ok = await call('odin_upload_project_file', { contentBase64: pdf, contentType: 'application/pdf', fileName: 'sow.pdf', projectId: 'project-1', targetId: 'task-1', targetType: 'task' });
  assert.equal(ok.isError, false, JSON.stringify(ok.data));
  assert.deepEqual(calls.at(-1)[2].body, { createOnly: true, fileContentsBase64: pdf, fileDescription: '', fileName: 'sow.pdf', fileType: 'application/pdf', targetId: 'task-1', targetType: 'task' });

  const before = calls.length;
  for (const [args, code] of [
    [{ contentBase64: pdf, fileName: 'sow.pdf' }, 'content_type_required'],
    [{ contentBase64: 'not base64!', contentType: 'application/pdf', fileName: 'sow.pdf' }, 'invalid_base64'],
    [{ contentBase64: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1).toString('base64').slice(0, Math.ceil(MAX_UPLOAD_BYTES / 3) * 4), contentType: 'application/pdf', fileName: 'big.pdf' }, 'file_too_large'],
    [{ fileName: 'page.html', text: '<script>alert(1)</script>' }, 'text_file_name'],
    [{ fileName: 'notes', text: 'x' }, 'text_file_name'],
    [{ contentBase64: pdf, contentType: 'application/pdf', fileName: 'a.pdf', text: 'x' }, 'content_required'],
    [{ fileName: 'a.md' }, 'content_required'],
    [{ contentBase64: pdf, contentType: 'text/html', fileName: 'a.html' }, 'validation_error'],
    [{ fileName: '../a.md', text: 'x' }, 'validation_error'],
  ]) {
    const refused = await call('odin_upload_project_file', { projectId: 'project-1', ...args });
    assert.deepEqual([refused.isError, refused.data.error.code], [true, code], JSON.stringify(args).slice(0, 120));
  }
  assert.equal(calls.length, before, 'nothing reaches Odin');
});

test('a dry run sends nothing and leaves the bytes out of the preview', async (t) => {
  const { call, calls } = await session(t, () => { throw new Error('Must not call Odin.'); });
  const upload = await call('odin_upload_project_file', { dryRun: true, fileName: 'notes.md', projectId: 'project-1', text: 'hello' });
  assert.deepEqual([upload.isError, upload.data.dryRun, upload.data.request.body.fileContentsBase64, upload.data.request.body.fileType], [false, true, '[5 bytes]', 'text/markdown']);
  const removal = await call('odin_delete_project_file', { dryRun: true, fileId: 'file-1', projectId: 'project-1' });
  assert.deepEqual(removal.data.request, { method: 'DELETE', path: `${FILES}/file-1` });
  assert.equal(calls.length, 0);
});

test('deleting names the project, and Odin\'s refusals come back as next steps', async (t) => {
  const { call, calls } = await session(t, () => ({ deletedFileId: 'file-1', ok: true }));
  const deleted = await call('odin_delete_project_file', { fileId: 'file-1', projectId: 'project-1' });
  assert.deepEqual([deleted.isError, deleted.data.deletedFileId], [false, 'file-1']);
  assert.deepEqual(calls, [['DELETE', `${FILES}/file-1`, { query: { agentView: 1 } }]]);
  for (const [status, code, pattern] of [[423, 'legal_hold', /legal hold/], [404, 'file_not_found', /odin_list_project_files/], [403, 'http_403', /viewers/]]) {
    const refused = await session(t, () => { throw new OdinApiError(status, `http_${status}`, 'upstream'); });
    const { data } = await refused.call('odin_delete_project_file', { fileId: 'file-1', projectId: 'project-1' });
    assert.deepEqual([data.error.code, pattern.test(data.error.message)], [code, true]);
  }
  for (const [status, code] of [[400, 'file_rejected'], [423, 'legal_hold'], [404, 'http_404']]) {
    const refused = await session(t, (method) => { if (method === 'GET') return { ok: true, files: [] }; throw new OdinApiError(status, `http_${status}`, 'upstream'); });
    const { data } = await refused.call('odin_upload_project_file', { fileName: 'a.md', projectId: 'project-1', text: 'x' });
    assert.equal(data.error.code, code);
  }
});
