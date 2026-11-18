import assert from 'node:assert/strict';
import test from 'node:test';

import { focusOrigin, trackPresses } from '../src/lib/ui/focus-origin.js';

class FakeElement {
  constructor(name, parent = null) { this.name = name; this.parent = parent; }
  closest() { return this; }
  contains(other) {
    for (let node = other; node; node = node.parent) if (node === this) return true;
    return false;
  }
}
globalThis.Element = FakeElement;

function fakePage() {
  const listeners = {};
  const body = new FakeElement('body');
  const page = {
    activeElement: body,
    addEventListener(type, handler) { listeners[type] = handler; },
    body,
    contains: (element) => body.contains(element),
    fire: (type, target) => listeners[type]({ target }),
  };
  return page;
}

// The module tracks one document, so each case below shares this one.
const page = fakePage();
trackPresses(page);
const section = new FakeElement('section', page.body);
const button = new FakeElement('button', section);
const other = new FakeElement('input', page.body);

test('with nothing pressed, focus goes back to what the browser says has it', () => {
  page.activeElement = other;
  assert.equal(focusOrigin(page), other);
  page.activeElement = page.body;
  assert.equal(focusOrigin(page), null);
});

test('Chrome focuses the button pressed', () => {
  page.fire('pointerdown', button);
  page.activeElement = button;
  assert.equal(focusOrigin(page), button);
});

test('Safari leaves focus on the body, or on a focusable ancestor: the press still names the button', () => {
  page.fire('pointerdown', button);
  page.activeElement = page.body;
  assert.equal(focusOrigin(page), button);
  page.activeElement = section;
  assert.equal(focusOrigin(page), button);
});

test('focus somewhere else since the press wins', () => {
  page.fire('pointerdown', button);
  page.activeElement = other;
  assert.equal(focusOrigin(page), other);
});

test('moving by keyboard forgets the press', () => {
  page.fire('pointerdown', button);
  page.fire('keydown', null);
  page.activeElement = section;
  assert.equal(focusOrigin(page), section);
});

test('a control that has gone is no place to return to', () => {
  const gone = new FakeElement('button');
  page.fire('pointerdown', gone);
  page.activeElement = page.body;
  assert.equal(focusOrigin(page), null);
});

test('focus for now: focusable only while focused, so a press inside can never be taken by it', async () => {
  const { focusForNow } = await import('../src/lib/ui/focus-origin.js');
  const attributes = new Map();
  const listeners = {};
  const focused = [];
  const element = {
    addEventListener(type, handler, options) { listeners[type] = { handler, options }; },
    focus(options) { focused.push(options); },
    removeAttribute(name) { attributes.delete(name); },
    setAttribute(name, value) { attributes.set(name, value); },
  };
  focusForNow(element, { preventScroll: true });
  assert.equal(attributes.get('tabindex'), '-1');
  assert.deepEqual(focused, [{ preventScroll: true }]);
  assert.equal(listeners.blur.options.once, true);
  listeners.blur.handler();
  assert.equal(attributes.has('tabindex'), false);
  assert.doesNotThrow(() => focusForNow(null));
});
