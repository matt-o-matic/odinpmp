<script setup>
import { computed } from 'vue';

import RequirementsCommentBody from '../RequirementsCommentBody.vue';
import { formatDateTime } from '../../../lib/requirements/requirements-time.js';
import { threadTree } from '../../../lib/requirements/review-annotations.js';

// A mark's thread, read-only, as Marks and comments lists it for members who can't reply:
// each comment with the label Odin's summaries cite it by (C1, C2, ...), replies under the
// comment they answer. Comments are addressable as #comment-<id>.
const props = defineProps({
  highlightId: { default: '', type: String },
  // [{ id, authorName, body, createdAt, label, parentCommentId }]
  thread: { default: () => [], type: Array },
});

const tree = computed(() => threadTree(props.thread));
</script>

<template>
  <ul v-if="tree.length" class="rq-thread-card__comments">
    <li v-for="entry in tree" :key="entry.comment.id">
      <article
        :id="`comment-${entry.comment.id}`"
        class="rq-thread-comment"
        :class="{ 'rq-thread-comment--focus': highlightId === entry.comment.id }"
        tabindex="-1"
        :aria-label="`${entry.comment.authorName}, comment ${entry.comment.label}`.trim()"
      >
        <div class="rq-comment__meta">
          <span v-if="entry.comment.label" class="rq-source">{{ entry.comment.label }}</span>
          <strong>{{ entry.comment.authorName }}</strong>
          <time v-if="entry.comment.createdAt" :datetime="entry.comment.createdAt">{{ formatDateTime(entry.comment.createdAt) }}</time>
        </div>
        <RequirementsCommentBody class="rq-thread-comment__body" :body="entry.comment.body" />
      </article>
      <ul v-if="entry.replies.length" class="rq-thread-card__replies">
        <li v-for="reply in entry.replies" :key="reply.id">
          <article
            :id="`comment-${reply.id}`"
            class="rq-thread-comment rq-thread-comment--reply"
            :class="{ 'rq-thread-comment--focus': highlightId === reply.id }"
            tabindex="-1"
            :aria-label="`${reply.authorName}, reply ${reply.label}`.trim()"
          >
            <div class="rq-comment__meta">
              <span v-if="reply.label" class="rq-source">{{ reply.label }}</span>
              <strong>{{ reply.authorName }}</strong>
              <time v-if="reply.createdAt" :datetime="reply.createdAt">{{ formatDateTime(reply.createdAt) }}</time>
            </div>
            <RequirementsCommentBody class="rq-thread-comment__body" :body="reply.body" />
          </article>
        </li>
      </ul>
    </li>
  </ul>
  <p v-else class="rq-xs rq-muted mb-0">No comments on this mark.</p>
</template>
