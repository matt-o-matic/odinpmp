<script setup>
import { computed } from 'vue';

import { renderPackageMarkdown } from '../../lib/requirements/package-markdown.js';

// One markdown field from a review package, rendered by the package rules: no raw HTML,
// https: links only (opening in a new tab), and no images.
const props = defineProps({
  source: { default: '', type: String },
});

const html = computed(() => renderPackageMarkdown(props.source));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- renderPackageMarkdown escapes raw HTML and sanitizes the result. -->
  <div v-if="html" class="rq-md" v-html="html"></div>
</template>
