// Keeping a message list at its newest message (components/channels/ChannelConversation.vue).
//
// The list follows the end while the reader is there: when a message arrives, and while that
// message still grows (images, link previews, polls, diagrams and fonts finish after the first
// render). Only the reader scrolling up stops it.
//
// A scroll event alone does not say who moved. Setting scrollTop to the end queues a scroll
// event, and by the time it runs the new message may have grown again. The old rule ("not near
// the end, so the reader left") then stopped following, and the list stayed short by that
// growth. So: content that grows under a still or downward scroll position keeps following;
// only an upward move away from the end stops it.

// Near enough to the end to count as at the end, in pixels.
export const END_THRESHOLD_PX = 80;

export function distanceFromEnd({ clientHeight, scrollHeight, scrollTop }) {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

/**
 * Whether to keep following after a scroll event. `previousTop` is the scroll position before
 * it: after the last scroll event, or after the list moved itself to the end.
 */
export function nextFollow({ clientHeight, follow, previousTop, scrollHeight, scrollTop, threshold = END_THRESHOLD_PX }) {
  if (distanceFromEnd({ clientHeight, scrollHeight, scrollTop }) <= threshold) return true;
  // Moved up (more than rounding): the reader went back to read.
  if (scrollTop < previousTop - 1) return false;
  // Moved down or not at all: the content grew below, or scroll anchoring moved the view.
  return follow;
}
