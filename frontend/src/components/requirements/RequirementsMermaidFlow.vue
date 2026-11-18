<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import RequirementsMarkdown from './RequirementsMarkdown.vue';
import { mermaidErrorText, renderMermaid } from '../../lib/requirements/requirements-mermaid.js';

// One flow from a package: the diagram drawn by Mermaid in the browser (loaded on first
// use), its description, and the Mermaid source for anyone who wants the text.
const props = defineProps({
  flow: { required: true, type: Object },
  headingTag: { default: 'h4', type: String },
});

const svg = ref('');
const error = ref('');
const loading = ref(true);
const root = ref(null);
let observer = null;
let started = false;
let sequence = 0;

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

async function draw() {
  const current = ++sequence;
  loading.value = true;
  error.value = '';
  try {
    const markup = await renderMermaid(props.flow?.mermaid ?? '', { dark: isDark() });
    if (current !== sequence) return;
    svg.value = markup;
  } catch (caught) {
    if (current !== sequence) return;
    svg.value = '';
    error.value = mermaidErrorText(caught) || 'Mermaid could not draw it.';
  } finally {
    if (current === sequence) loading.value = false;
  }
}

function start() {
  if (started) return;
  started = true;
  draw();
}

onMounted(() => {
  // Draw when the flow scrolls near the viewport, so a long package does not lay out
  // every diagram up front.
  if (typeof IntersectionObserver === 'undefined' || !root.value) {
    start();
    return;
  }
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      observer?.disconnect();
      observer = null;
      start();
    }
  }, { rootMargin: '400px 0px' });
  observer.observe(root.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  sequence += 1;
});

watch(() => props.flow?.mermaid, () => {
  if (started) draw();
});
</script>

<template>
  <article ref="root" class="rq-flow" :aria-labelledby="`rq-flow-${flow.id}`">
    <component :is="headingTag" :id="`rq-flow-${flow.id}`" class="rq-title rq-title--sm">{{ flow.title }}</component>
    <RequirementsMarkdown v-if="flow.description" :source="flow.description" />
    <div class="rq-flow__diagram">
      <p v-if="loading" class="rq-xs rq-muted mb-0">Drawing the diagram…</p>
      <p v-else-if="error" class="rq-small mb-0" role="note">
        <strong>This diagram could not be drawn here.</strong>
        <span class="rq-muted"> {{ error }} The source is below.</span>
      </p>
      <!-- eslint-disable-next-line vue/no-v-html -- Mermaid strict mode sanitizes its SVG output. -->
      <div v-else class="rq-flow__svg" role="img" :aria-label="`${flow.title}, diagram. The Mermaid source below describes it in text.`" v-html="svg"></div>
    </div>
    <details class="rq-flow__source" :open="Boolean(error)">
      <summary>Mermaid source</summary>
      <pre><code>{{ flow.mermaid }}</code></pre>
    </details>
  </article>
</template>
