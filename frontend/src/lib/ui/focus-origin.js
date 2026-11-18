// Where focus should go back to when something opened by a press closes. Safari, on an iPad and
// on a Mac, doesn't focus a button or link when it is pressed: focus goes to the nearest focusable
// ancestor, or the body. So document.activeElement says nothing about what the person just used,
// and the last control pressed answers instead.

const PRESSABLE = 'button, a[href], [role="button"], [tabindex], input, select, textarea, summary';

let lastPressed = null;
let tracking = false;

function notePress(event) {
  lastPressed = event.target instanceof Element ? event.target.closest(PRESSABLE) : null;
}

export function trackPresses(page = globalThis.document) {
  if (!page?.addEventListener || (tracking && page === globalThis.document)) return;
  if (page === globalThis.document) tracking = true;
  // Capture, so a press still counts when a handler stops it or removes the control.
  page.addEventListener('pointerdown', notePress, true);
  // Moving by keyboard puts the browser's own focus back in charge.
  page.addEventListener('keydown', () => { lastPressed = null; }, true);
}

/**
 * Focuses something that isn't a control, such as a comment a link jumps to, for as long as it
 * holds focus. A lasting tabindex would be a trap in Safari: pressing a button inside gives the
 * tabindex element focus instead, which can scroll the page between the press and the release, so
 * the click lands on the wrong element and the button does nothing.
 */
export function focusForNow(element, options) {
  if (!element) return;
  element.setAttribute('tabindex', '-1');
  element.addEventListener('blur', () => element.removeAttribute('tabindex'), { once: true });
  element.focus(options);
}

/** The element focus should return to, or null when neither the browser nor a press can say. */
export function focusOrigin(page = globalThis.document) {
  if (!page) return null;
  const active = page.activeElement;
  const pressed = lastPressed && page.contains(lastPressed) ? lastPressed : null;
  if (pressed && (!active || active.contains(pressed))) return pressed;
  return active && active !== page.body ? active : pressed;
}

trackPresses();
