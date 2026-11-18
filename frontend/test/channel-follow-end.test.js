import assert from 'node:assert/strict';
import test from 'node:test';

import { END_THRESHOLD_PX, distanceFromEnd, nextFollow } from '../src/lib/channels/follow-end.js';

// A list 500 px tall in a 1000 px scroller: the end is at scrollTop 500.
const view = { clientHeight: 500, scrollHeight: 1000 };

test('at the end, the list keeps following', () => {
  assert.equal(distanceFromEnd({ ...view, scrollTop: 500 }), 0);
  assert.equal(nextFollow({ ...view, follow: false, previousTop: 400, scrollTop: 500 }), true);
  assert.equal(nextFollow({ ...view, follow: false, previousTop: 500, scrollTop: 500 - END_THRESHOLD_PX }), true, 'near enough counts');
  assert.equal(nextFollow({ ...view, follow: true, previousTop: 500, scrollTop: 499.5 }), true, 'sub-pixel rounding');
});

test('a message that grows after the list moved to the end keeps it following', () => {
  // The list moved to the end (scrollTop 500), then an image in the new message loaded and added
  // 300 px before the scroll event ran. The old rule saw 300 px from the end and stopped.
  assert.equal(nextFollow({ clientHeight: 500, follow: true, previousTop: 500, scrollHeight: 1300, scrollTop: 500 }), true);
  // Scroll anchoring moved the view down as content above grew: still following.
  assert.equal(nextFollow({ clientHeight: 500, follow: true, previousTop: 500, scrollHeight: 1400, scrollTop: 600 }), true);
});

test('scrolling up to read history stops following, and nothing pulls the reader back down', () => {
  assert.equal(nextFollow({ ...view, follow: true, previousTop: 500, scrollTop: 300 }), false);
  // New content arrives while they read: their position holds.
  assert.equal(nextFollow({ clientHeight: 500, follow: false, previousTop: 300, scrollHeight: 1600, scrollTop: 300 }), false);
  // Scrolling down part way is still reading.
  assert.equal(nextFollow({ ...view, follow: false, previousTop: 200, scrollTop: 350 }), false);
  // Back at the end: following again.
  assert.equal(nextFollow({ ...view, follow: false, previousTop: 350, scrollTop: 500 }), true);
});
