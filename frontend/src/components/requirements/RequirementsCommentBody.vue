<script setup>
import { computed } from 'vue';

import { renderCommentHtml } from '../../lib/rich-content/comment-markdown.js';

// A stored Requirements comment: Markdown with inline tags, rendered to sanitized HTML.
const props = defineProps({
  body: { default: '', type: String },
});

const html = computed(() => renderCommentHtml(props.body));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- renderCommentHtml escapes raw HTML and sanitizes the result. -->
  <div class="rq-comment-md" v-html="html"></div>
</template>
