import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_MESSAGE_FILES, useAttachmentTray } from '../src/lib/channels/attachment-tray.js';

const file = (name, size = 10, type = 'text/plain') => new File(['x'.repeat(size)], name, { lastModified: 1, type });

test('the tray takes files up to the size limit and ten at a time, and says why it refused one', () => {
  const errors = [];
  const tray = useAttachmentTray({ maxBytes: () => 100, onError: (message) => errors.push(message) });
  tray.add([file('big.bin', 101), file('notes.txt')]);
  assert.deepEqual(tray.entries.value.map((entry) => entry.file.name), ['notes.txt']);
  assert.match(errors[0], /^big\.bin is .+\. Files can be up to /);

  tray.add(Array.from({ length: MAX_MESSAGE_FILES }, (_, index) => file(`f${index}.txt`)));
  assert.equal(tray.entries.value.length, MAX_MESSAGE_FILES);
  assert.equal(errors.at(-1), `A message can carry up to ${MAX_MESSAGE_FILES} files.`);

  tray.remove(tray.entries.value[0].key);
  assert.equal(tray.entries.value.length, MAX_MESSAGE_FILES - 1);
  tray.clear();
  assert.equal(tray.entries.value.length, 0);
});

test('a paste of files is taken; text, or text with a picture of itself, is left to the editor', () => {
  const tray = useAttachmentTray({ maxBytes: () => 1000, onError: () => {} });
  const paste = (files, text = '') => {
    const event = { clipboardData: { files, getData: () => text }, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    return { event, taken: tray.takePaste(event) };
  };
  const shot = paste([file('shot.png', 50, 'image/png')]);
  assert.equal(shot.taken, true);
  assert.equal(shot.event.prevented, true);
  assert.equal(tray.entries.value[0].fileId, null);

  const word = paste([file('image.png', 50, 'image/png')], 'Quarterly numbers');
  assert.equal(word.taken, false);
  assert.equal(word.event.prevented, false);
  assert.equal(tray.entries.value.length, 1);
});
