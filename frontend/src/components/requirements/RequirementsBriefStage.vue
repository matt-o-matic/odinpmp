<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';

import { plural, trackLabel } from '../../lib/requirements/requirements-tracks.js';

// The committed brief, line by line, with how many of this track's topics cite each line.
const props = defineProps({
  abilities: { required: true, type: Object },
  brief: { default: null, type: Object },
  drafting: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  track: { required: true, type: String },
});

const emit = defineEmits(['draft']);

const lines = computed(() => props.brief?.lines ?? []);
const covered = computed(() => Number(props.brief?.coveredLines) || 0);

function registerLocation(line) {
  return {
    name: 'project-requirements-track',
    params: { projectId: props.projectId, stage: 'discuss', track: props.track },
    query: { line: line.ref },
  };
}
</script>

<template>
  <section class="rq-panel rq-stack" aria-labelledby="rq-brief-heading">
    <div class="rq-row rq-row--between rq-row--wrap">
      <div class="rq-stack rq-stack--sm">
        <h3 id="rq-brief-heading" class="rq-eyebrow">Project brief</h3>
        <p v-if="brief && lines.length" class="rq-xs rq-muted mb-0">
          {{ covered }} of {{ plural(lines.length, 'line') }} have a {{ trackLabel(track) }} topic
        </p>
      </div>
      <button
        v-if="abilities.draftQuestions && lines.length"
        class="ghost-button ghost-button--compact"
        type="button"
        :disabled="drafting"
        @click="emit('draft')"
      >
        <i class="bi bi-journal-text" aria-hidden="true"></i>
        {{ drafting ? 'Drafting questions…' : 'Draft questions from brief' }}
      </button>
    </div>

    <p v-if="!brief" class="rq-small rq-muted mb-0">Loading the brief…</p>
    <div v-else-if="lines.length === 0" class="rq-empty">
      <p><strong>The project brief is empty.</strong></p>
      <p class="rq-small">Add requirements, constraints, or an objective to the brief, then draft questions from it.</p>
      <RouterLink class="ghost-button ghost-button--compact" :to="{ name: 'project-detail', params: { projectId }, query: { projectSettings: 'details' } }">
        Open the project brief
      </RouterLink>
    </div>
    <ol v-else class="rq-brief">
      <li v-for="(line, index) in lines" :key="line.ref" class="rq-brief__line">
        <span class="rq-cite" aria-hidden="true">{{ index + 1 }}</span>
        <div>
          <span class="rq-xs rq-muted"><span class="visually-hidden">Line {{ index + 1 }}, </span>{{ line.label }}</span>
          <p class="rq-brief__text">{{ line.text }}</p>
        </div>
        <RouterLink v-if="line.topicCount > 0" class="rq-xs" :to="registerLocation(line)">
          {{ plural(line.topicCount, 'topic') }}
        </RouterLink>
        <span v-else class="rq-chip rq-chip--outline">No topics yet</span>
      </li>
    </ol>
  </section>
</template>
