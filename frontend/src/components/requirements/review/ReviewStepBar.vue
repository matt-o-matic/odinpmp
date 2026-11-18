<script setup>
// Overview → Directions → Screens (n of N) → Questions → Submit (sh-review-screen.png).
// Every step can be opened at any time; done steps show a check.
defineProps({
  current: { required: true, type: String },
  done: { default: () => [], type: Array },
  screenCount: { default: 0, type: Number },
  screenIndex: { default: 0, type: Number },
  steps: { default: () => [], type: Array },
});

const emit = defineEmits(['go']);
</script>

<template>
  <nav class="rq-steps" aria-label="Review steps">
    <ol class="rq-steps__list">
      <li v-for="(step, index) in steps" :key="step.id" class="rq-steps__item">
        <button
          class="rq-step"
          :class="{ 'rq-step--on': current === step.id, 'rq-step--done': done.includes(step.id) && current !== step.id }"
          type="button"
          :aria-current="current === step.id ? 'step' : undefined"
          @click="emit('go', step.id)"
        >
          <span class="rq-step__num" aria-hidden="true">
            <i v-if="done.includes(step.id) && current !== step.id" class="bi bi-check"></i>
            <template v-else>{{ step.number }}</template>
          </span>
          <span>{{ step.label }}<template v-if="step.id === 'screens' && current === 'screens' && screenCount"> · {{ screenIndex + 1 }} of {{ screenCount }}</template></span>
          <span v-if="done.includes(step.id)" class="visually-hidden">, done</span>
        </button>
        <span v-if="index < steps.length - 1" class="rq-steps__sep" aria-hidden="true">›</span>
      </li>
    </ol>
    <span class="rq-grow"></span>
    <slot name="meta"></slot>
  </nav>
</template>
