<script setup>
import { computed } from 'vue';

import { renderCommentHtml } from '../../lib/rich-content/comment-markdown.js';

// A recorded decision's statement. Statements are stored as Markdown, like comments; older
// ones are plain text, and single line breaks are kept, so both read as they were written.
const props = defineProps({
  statement: { default: '', type: String },
});

const html = computed(() => renderCommentHtml(props.statement));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- renderCommentHtml escapes raw HTML and sanitizes the result. -->
  <div class="rq-comment-md rq-decision-statement" v-html="html"></div>
</template>
