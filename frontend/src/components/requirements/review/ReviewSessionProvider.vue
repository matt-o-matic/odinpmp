<script setup>
import { onBeforeUnmount, onMounted, provide } from 'vue';

import { REVIEW_SESSION_KEY, createReviewSession } from '../../../lib/requirements/review-session.js';

// A review session for a view outside the guided review that acts on marks, such as
// replying in Marks and comments: the same session, rules, and live updates as the review.
// It loads on mount and saves anything waiting before it goes. Without an adapter (someone
// who can only read) the slot gets no session. Key it by round and adapter.
const props = defineProps({
  adapter: { default: null, type: Object },
});

const session = props.adapter ? createReviewSession({ adapter: props.adapter }) : null;
provide(REVIEW_SESSION_KEY, session);

onMounted(async () => {
  if (!session) return;
  await session.load();
  if (session.state.loaded) session.startLive();
});

onBeforeUnmount(() => {
  if (!session) return;
  session.flushAll();
  session.dispose();
});
</script>

<template>
  <slot :session="session"></slot>
</template>
