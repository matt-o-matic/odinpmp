<script setup>
import { computed } from 'vue';

import { splitAssistantContent } from '../../lib/assistant/assistant-visuals.js';
import AssistantVisual from '../assistant/AssistantVisual.vue';
import RequirementsCommentBody from '../requirements/RequirementsCommentBody.vue';

// A post's body: Markdown with tags, and fenced ```mermaid, ```dot (or ```graphviz) and ```chart
// blocks drawn inline, the same way the AI Workspace draws them. A post is stored whole, so a
// fence left open is not a drawing in progress: the body then renders as plain Markdown.
const props = defineProps({
  body: { default: '', type: String },
});

const segments = computed(() => {
  const parts = splitAssistantContent(props.body);
  return parts.some((part) => part.pending) ? [{ kind: 'text', text: props.body }] : parts;
});
</script>

<template>
  <div class="channel-post-body">
    <template v-for="(segment, index) in segments" :key="index">
      <AssistantVisual v-if="segment.kind === 'visual'" :visual="segment" />
      <RequirementsCommentBody v-else :body="segment.text" />
    </template>
  </div>
</template>

<style scoped>
.channel-post-body { display: grid; gap: 0.5rem; min-width: 0; }
</style>
