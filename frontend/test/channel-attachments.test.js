import assert from 'node:assert/strict';
import test from 'node:test';

import { attachmentIcon, attachmentKind, dragHasFiles, isStillScanning, pastedFiles, previewStillValid, showsLocalThumbnail } from '../src/lib/channels/attachments.js';

test('images and videos show inline; every other file, SVG and HTML included, is a card', () => {
  const kind = (contentType, fileName) => attachmentKind({ contentType, fileName });
  assert.equal(kind('image/png', 'shot.png'), 'image');
  assert.equal(kind('application/octet-stream', 'photo.JPG'), 'image');
  assert.equal(kind('video/mp4', 'demo.mp4'), 'video');
  assert.equal(kind('image/svg+xml', 'logo.svg'), 'file');
  assert.equal(kind('text/html', 'page.html'), 'file');
  assert.equal(kind('application/pdf', 'sow.pdf'), 'file');
  assert.equal(kind('', 'notes.docx'), 'file');
});

test('a card\'s icon follows the file type', () => {
  assert.equal(attachmentIcon({ contentType: 'application/pdf', fileName: 'a.pdf' }), 'bi-file-earmark-pdf');
  assert.equal(attachmentIcon({ contentType: '', fileName: 'Budget.xlsx' }), 'bi-file-earmark-excel');
  assert.equal(attachmentIcon({ contentType: '', fileName: 'Plan.docx' }), 'bi-file-earmark-word');
  assert.equal(attachmentIcon({ contentType: '', fileName: 'Deck.pptx' }), 'bi-file-earmark-ppt');
  assert.equal(attachmentIcon({ contentType: 'text/markdown', fileName: 'a.md' }), 'bi-file-earmark-text');
  assert.equal(attachmentIcon({ contentType: 'application/zip', fileName: 'a.zip' }), 'bi-file-earmark');
});

test('only a scan still running is worth another try', () => {
  assert.equal(isStillScanning({ data: { details: { code: 'file_scanning' } }, status: 409 }), true);
  assert.equal(isStillScanning({ data: { details: { code: 'file_infected' } }, status: 409 }), false);
  assert.equal(isStillScanning({ status: 404 }), false);
  assert.equal(isStillScanning(null), false);
});

test('a signed URL is signed again shortly before it ends', () => {
  const now = Date.parse('2026-11-15T10:00:00.000Z');
  assert.equal(previewStillValid('2026-11-15T10:04:00.000Z', now), true);
  assert.equal(previewStillValid('2026-11-15T10:00:20.000Z', now), false);
  assert.equal(previewStillValid(null, now), true);
});

test('only raster images show as a thumbnail before they are sent', () => {
  assert.equal(showsLocalThumbnail({ type: 'image/png' }), true);
  assert.equal(showsLocalThumbnail({ type: 'image/jpeg' }), true);
  assert.equal(showsLocalThumbnail({ type: 'image/svg+xml' }), false);
  assert.equal(showsLocalThumbnail({ type: 'application/pdf' }), false);
});

test('a pasted screenshot attaches; text copied from Word, with its picture beside, pastes as text', () => {
  const clipboard = (files, text = '') => ({ files, getData: (type) => (type === 'text/plain' ? text : '') });
  const shot = { name: 'image.png', type: 'image/png' };
  assert.deepEqual(pastedFiles(clipboard([shot])), [shot]);
  assert.deepEqual(pastedFiles(clipboard([shot], 'Quarterly numbers')), []);
  assert.deepEqual(pastedFiles(clipboard([], 'text')), []);
  assert.deepEqual(pastedFiles(null), []);
});

test('only a drag that carries files is taken as an attachment', () => {
  assert.equal(dragHasFiles({ types: ['Files'] }), true);
  assert.equal(dragHasFiles({ types: ['text/plain', 'text/uri-list'] }), false);
  assert.equal(dragHasFiles(null), false);
});
