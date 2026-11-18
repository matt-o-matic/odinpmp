<script setup>
import { nextTick, onMounted, ref } from 'vue';

// Links from clarification emails sent before requirements topics replaced clarifications.
// Those questions are now requirements topics, reached through a requirements link.
const heading = ref(null);

onMounted(async () => {
  await nextTick();
  heading.value?.focus();
});
</script>

<template>
  <div class="rq-review-page">
    <section class="rq-review-card rq-stack rq-linkproblem" aria-labelledby="rq-moved-heading">
      <i class="bi bi-signpost-split rq-linkproblem__icon" aria-hidden="true"></i>
      <h1 id="rq-moved-heading" ref="heading" class="rq-title rq-title--lg rq-section-heading" tabindex="-1">This question has moved</h1>
      <p class="mb-0">The project team now collects answers in a new place, and this older link no longer opens it.</p>
      <p class="mb-0">Ask the project team to send you a new link.</p>
    </section>
  </div>
</template>
