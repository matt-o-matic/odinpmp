import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadPreviewText, previewKindOf, previewNotice } from '../src/lib/projects/file-preview.js';

const viewer = readFileSync(new URL('../src/components/projects/FilePreviewDialog.vue', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/components/projects/ProjectFilesPanel.vue', import.meta.url), 'utf8');

test('the viewer offers Open for the kinds the server previews, and never for HTML or SVG', () => {
  const kind = (contentType, fileName = 'file') => previewKindOf({ contentType, fileName });
  assert.equal(kind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'), 'office');
  assert.equal(kind('application/octet-stream', 'Budget.XLSX'), 'office');
  for (const extension of ['doc', 'xls', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']) assert.equal(kind('', `f.${extension}`), 'office', extension);
  assert.equal(kind('application/pdf', 'a.pdf'), 'pdf');
  assert.equal(kind('image/jpeg', 'a.jpg'), 'image');
  assert.equal(kind('video/webm', 'a.webm'), 'video');
  assert.equal(kind('text/markdown; charset=utf-8', 'a.md'), 'markdown');
  assert.equal(kind('text/plain', 'README.md'), 'markdown');
  assert.equal(kind('application/octet-stream', 'notes.markdown'), 'markdown');
  assert.equal(kind('text/plain', 'a.txt'), 'text');
  assert.equal(kind('text/html', 'a.html'), null);
  assert.equal(kind('text/html', 'a.txt'), null);
  assert.equal(kind('image/svg+xml', 'a.svg'), null);
  assert.equal(kind('image/svg+xml', 'a.png'), null);
  assert.equal(kind('application/zip', 'a.zip'), null);
  assert.equal(kind('video/quicktime', 'a.mov'), null);
});

test('a file with nothing to show says it is being prepared, or that it has no preview and why', () => {
  assert.deepEqual(previewNotice({ kind: 'preparing' }).title, 'Preparing preview');
  assert.equal(previewNotice({ kind: 'preparing' }).preparing, true);
  for (const reason of ['failed', 'too_large', 'unavailable', 'unsupported', null]) {
    const notice = previewNotice({ kind: 'none', reason });
    assert.equal(notice.title, 'No preview', String(reason));
    assert.ok(notice.detail.length > 10);
  }
  assert.match(previewNotice({ kind: 'none', reason: 'failed' }).detail, /could not be converted/);
});

test('text loads from its signed URL without the session, and a refused URL is an error', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push([url, init.credentials]);
    return url.endsWith('ok') ? new Response('﻿# Notes') : new Response('gone', { status: 403 });
  };
  assert.equal(await loadPreviewText('https://bucket.example/ok', { fetch }), '# Notes');
  await assert.rejects(loadPreviewText('https://bucket.example/expired', { fetch }), { status: 403 });
  assert.deepEqual(seen.map(([, credentials]) => credentials), ['omit', 'omit']);
});

test('the viewer renders Markdown only through the sanitized renderer, and shows PDFs in an object', () => {
  assert.match(viewer, /<RequirementsMarkdown :source="text" \/>/);
  assert.doesNotMatch(viewer, /v-html|innerHTML/);
  assert.match(viewer, /<object v-if="kind === 'pdf'"[^>]*type="application\/pdf"/);
  assert.doesNotMatch(viewer, /<iframe/);
  assert.match(viewer, /onProjectRefresh\(/);
  // Download is the dialog's one submit action.
  assert.equal((viewer.match(/type="submit"/g) ?? []).length, 1);
  assert.match(panel, /<FilePreviewDialog/);
  assert.match(panel, /fileStorage\.uploadsByParts \? Boolean\(previewKindOf\(file\)\) : canPreviewFile\(file\)/);
});
