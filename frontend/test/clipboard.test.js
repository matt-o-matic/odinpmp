import assert from 'node:assert/strict';
import test from 'node:test';

import { copyText } from '../src/lib/clipboard.js';

function withGlobals({ clipboard, execResult = true }, run) {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousDocument = globalThis.document;
  const appended = [];
  const area = { remove() { area.removed = true; }, select() {}, setAttribute() {}, setSelectionRange() {}, style: {}, value: '' };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
  globalThis.document = {
    activeElement: null,
    body: { appendChild: (element) => appended.push(element) },
    createElement: () => area,
    execCommand: (command) => (command === 'copy' ? execResult : false),
  };
  return run({ appended, area }).finally(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
    globalThis.document = previousDocument;
  });
}

test('copyText uses the Clipboard API when it works', async () => {
  const written = [];
  await withGlobals({ clipboard: { writeText: async (text) => written.push(text) } }, async ({ appended }) => {
    assert.equal(await copyText('hello'), true);
    assert.deepEqual(written, ['hello']);
    assert.equal(appended.length, 0);
  });
});

test('copyText falls back to a selected textarea when the Clipboard API is blocked', async () => {
  const blocked = { writeText: async () => { throw new DOMException('blocked', 'NotAllowedError'); } };
  await withGlobals({ clipboard: blocked }, async ({ appended, area }) => {
    assert.equal(await copyText('fallback text'), true);
    assert.equal(appended[0], area);
    assert.equal(area.value, 'fallback text');
    assert.equal(area.removed, true);
  });
  await withGlobals({ clipboard: undefined, execResult: false }, async () => {
    assert.equal(await copyText('nowhere'), false, 'reports failure so the caller can show the text');
  });
  assert.equal(await copyText(''), false);
});
