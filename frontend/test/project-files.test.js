import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MAX_FILE_BYTES,
  canPreviewFile,
  fileAttachments,
  fileErrorMessage,
  fileSizeLabel,
  fileToBase64,
  filterFiles,
  isHomeFile,
  linkableFiles,
  linkableItems,
  openFile,
  previewBlob,
  sameNamedFile,
  saveBlob,
} from '../src/lib/projects/project-files.js';

const panel = readFileSync(new URL('../src/components/projects/ProjectFilesPanel.vue', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../src/components/projects/ProjectWorkbenchEditor.vue', import.meta.url), 'utf8');
const ticketsView = readFileSync(new URL('../src/views/TicketsView.vue', import.meta.url), 'utf8');

const story = { targetId: 'story-1', targetType: 'story' };
const sow = { fileName: 'SOW.pdf', id: 'file-1', links: [{ id: 'link-1', targetId: 'story-1', targetName: 'Checkout', targetType: 'story' }], targetId: 'project-1', targetName: null, targetType: 'project' };
const mock = { description: 'Latest mock', fileName: 'mock.png', id: 'file-2', links: [], targetId: 'story-1', targetName: 'Checkout', targetType: 'story' };

test('Open is offered only for types the browser shows and cannot run', () => {
  for (const contentType of ['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv', 'text/markdown; charset=utf-8']) assert.equal(canPreviewFile({ contentType }), true, contentType);
  for (const contentType of ['text/html', 'image/svg+xml', 'application/javascript', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '']) assert.equal(canPreviewFile({ contentType }), false, contentType);
});

test('a file lists where it was uploaded, then each work item linked to it', () => {
  const places = fileAttachments(sow, 'project-1');
  assert.deepEqual(places.map(({ label, linkId, name, route }) => [label, linkId, name, route]), [
    ['Project', '', 'Project files', null],
    ['Story', 'link-1', 'Checkout', { name: 'project-detail', params: { projectId: 'project-1' }, query: { item: 'story-1' } }],
  ]);
  const ticket = fileAttachments({ ...mock, links: [], targetId: 'ticket-1', targetName: 'Crash', targetType: 'ticket' }, 'project-1')[0];
  assert.deepEqual(ticket.route, { name: 'tickets', query: { project: 'project-1', ticket: 'ticket-1' } });
  const topic = fileAttachments({ ...mock, links: [], targetId: 'topic-1', targetName: 'Which regions?', targetType: 'clarification' }, 'project-1')[0];
  assert.deepEqual(topic.route, { name: 'project-requirements-topic', params: { projectId: 'project-1', topicId: 'topic-1' } });
});

test('search reaches names, descriptions and the items a file is on', () => {
  assert.deepEqual(filterFiles([sow, mock], 'sow').map((file) => file.id), ['file-1']);
  assert.deepEqual(filterFiles([sow, mock], 'latest').map((file) => file.id), ['file-2']);
  assert.deepEqual(filterFiles([sow, mock], 'checkout').map((file) => file.id), ['file-1', 'file-2']);
  assert.equal(filterFiles([sow, mock], '  ').length, 2);
});

test('the pickers leave out what is already there', () => {
  assert.equal(isHomeFile(mock, story), true);
  assert.equal(isHomeFile(sow, story), false);
  const other = { fileName: 'plan.md', id: 'file-3', links: [], targetId: 'project-1', targetType: 'project' };
  assert.deepEqual(linkableFiles([sow, mock, other], story).map((file) => file.id), ['file-3']);
  const items = [{ id: 'story-1', itemType: 'story', name: 'Checkout' }, { id: 'task-1', itemType: 'task', name: 'Card form' }, { id: 'project-1', itemType: 'epic', name: 'Odd' }];
  assert.deepEqual(linkableItems(items, sow).map((item) => item.id), ['task-1']);
  assert.deepEqual(linkableItems(items, mock, 'task').map((item) => item.id), ['task-1']);
});

test('an upload names the file it will version, and only on this target', () => {
  assert.equal(sameNamedFile([sow, mock], story, ' MOCK.png '), mock);
  assert.equal(sameNamedFile([sow, mock], story, 'sow.pdf'), null, 'a linked file is not replaced by an upload');
  assert.equal(sameNamedFile([sow, mock], story, ''), null);
});

test('errors say what to do', () => {
  assert.match(fileErrorMessage({ message: 'Invalid file target.', status: 400 }, 'x'), /Save this item/);
  assert.match(fileErrorMessage({ message: 'The file under this name changed since it was listed.', status: 409 }, 'x'), /latest version/);
  assert.match(fileErrorMessage({ message: 'A file with this name is already there.', status: 409 }, 'x'), /already has that name/);
  assert.equal(fileErrorMessage({}, 'Fallback.'), 'Fallback.');
});

test('sizes read as people say them', () => {
  assert.deepEqual([fileSizeLabel(900), fileSizeLabel(2048), fileSizeLabel(3.5 * 1024 * 1024)], ['900 B', '2 KB', '3.5 MB']);
  assert.ok(Math.ceil(MAX_FILE_BYTES / 3) * 4 <= 20_000_000, 'the limit fits the API once base64-encoded');
});

test('base64 survives a file larger than one chunk', async () => {
  const bytes = new Uint8Array(0x8000 * 2 + 7).map((_, index) => index % 251);
  const encoded = await fileToBase64(new Blob([bytes]));
  assert.deepEqual(Buffer.from(encoded, 'base64'), Buffer.from(bytes));
});

function fakePage() {
  const clicked = [];
  const url = { createObjectURL: () => 'blob:odin/1', revokeObjectURL() {} };
  const page = { body: { append() {} }, createElement: () => { const link = { click() { clicked.push({ download: link.download, href: link.href }); }, remove() {}, style: {} }; return link; } };
  return { clicked, page, url };
}

test('a download saves under the file\'s own name', () => {
  const { clicked, page, url } = fakePage();
  saveBlob(new Blob(['x']), 'Résumé final.docx', { document: page, url });
  assert.deepEqual(clicked, [{ download: 'Résumé final.docx', href: 'blob:odin/1' }]);
});

test('Open takes a tab inside the click, cuts it off from Odin, and shows text as text', async () => {
  const { page, url } = fakePage();
  const tab = { close() { tab.closed = true; }, location: {}, opener: 'odin' };
  const opened = [];
  const host = { open: (...args) => { opened.push(args); return tab; }, setTimeout() {} };
  let loaded = false;
  const pending = openFile(async () => { assert.equal(opened.length, 1, 'the tab opens before the file loads'); loaded = true; return { blob: new Blob(['# Notes']) }; }, { contentType: 'text/markdown', fileName: 'notes.md' }, { document: page, url, window: host });
  await pending;
  assert.deepEqual([loaded, tab.opener, tab.location.href], [true, null, 'blob:odin/1']);
  assert.equal(previewBlob(new Blob(['a']), 'text/markdown').type, 'text/plain;charset=utf-8');
  assert.equal(previewBlob(new Blob(['a']), 'application/pdf').type, 'application/pdf');

  const failing = { ...tab, close() { failing.closed = true; } };
  await assert.rejects(openFile(async () => { throw new Error('nope'); }, { contentType: 'text/plain' }, { document: page, url, window: { open: () => failing, setTimeout() {} } }), /nope/);
  assert.equal(failing.closed, true, 'a failed load leaves no empty tab behind');
});

test('with tabs blocked, Open saves the file instead', async () => {
  const { clicked, page, url } = fakePage();
  await openFile(async () => ({ blob: new Blob(['x']) }), { contentType: 'application/pdf', fileName: 'sow.pdf' }, { document: page, url, window: { open: () => null, setTimeout() {} } });
  assert.equal(clicked[0].download, 'sow.pdf');
});

test('epics, stories, tasks and tickets show their files, and the panel asks before deleting', () => {
  assert.match(editor, /<ProjectFilesPanel[\s\S]*?:target-id="editorTargetId"[\s\S]*?:target-type="editorTargetType"/);
  assert.match(ticketsView, /<ProjectFilesPanel[\s\S]*?target-type="ticket"/);
  assert.match(panel, /RequirementsConfirmDialog/);
  assert.doesNotMatch(panel, /window\.(alert|confirm)|(?<![:\w])title="/);
});
