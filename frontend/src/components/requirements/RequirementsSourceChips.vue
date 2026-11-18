<script setup>
import { computed } from 'vue';

import { resolveSourceRefs } from '../../lib/requirements/requirements-sources.js';

// Citation chips (C2, C3, ...). Comments in this thread are buttons that jump to the
// comment; anything else is a plain label.
const props = defineProps({
  interactive: { default: true, type: Boolean },
  numbering: { default: null, type: Object },
  sources: { default: () => [], type: Array },
});

const emit = defineEmits(['cite']);

const resolved = computed(() => resolveSourceRefs(props.sources, props.numbering ?? undefined));
</script>

<template>
  <span v-if="resolved.length" class="rq-sources">
    <template v-for="source in resolved" :key="source.ref">
      <button
        v-if="interactive && source.linkable"
        class="rq-source"
        type="button"
        :aria-label="`Source ${source.label}: go to comment`"
        @click="emit('cite', source.commentId)"
      >{{ source.label }}</button>
      <span v-else class="rq-source">{{ source.label }}</span>
    </template>
  </span>
</template>
