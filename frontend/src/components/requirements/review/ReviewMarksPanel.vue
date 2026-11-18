<script setup>
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';

import AnnotationList from '../annotation/AnnotationList.vue';
import { commentPlainText } from '../../../lib/rich-content/comment-markdown.js';
import { annotationStatusLabel, toCanvasMark } from '../../../lib/requirements/review-annotations.js';
import { describeRequirementsError } from '../../../lib/requirements/requirements-errors.js';
import { useMarksLink, useReviewSession } from '../../../lib/requirements/review-session.js';

// Every mark on the screen as a keyboard list ("1. Pin · Ravi Shah · Hierarchy"), plus the
// marks from earlier versions whose screen changed (Outdated). Their author, or an admin or
// manager, carries each one forward or closes it.
const props = defineProps({
  activeId: { default: null, type: String },
  annotations: { default: () => [], type: Array },
  hiddenAuthors: { default: () => [], type: Array },
  showResolved: { default: false, type: Boolean },
});

const emit = defineEmits(['activate', 'select']);

const session = useReviewSession();
const marksLink = useMarksLink();
const LIST_BOUNDS = { height: 100000, width: 100000 };

const categoryLabels = computed(() => Object.fromEntries((session.state.content?.dimensions ?? []).map((dimension) => [dimension.key, dimension.label])));
const current = computed(() => props.annotations.filter((annotation) => annotation.status !== 'outdated'));
const outdated = computed(() => props.annotations.filter((annotation) => annotation.status === 'outdated'));
const marks = computed(() => current.value.map((annotation) => ({ ...toCanvasMark(annotation, { bounds: LIST_BOUNDS }), authorRef: annotation.authorRef })));
const busyId = ref('');
const error = ref('');
const status = ref('');

async function run(annotation, action, done) {
  busyId.value = annotation.id;
  error.value = '';
  try {
    await action(annotation.id);
    status.value = done;
  } catch (caught) {
    error.value = describeRequirementsError(caught, 'That didn’t work. Try again.').message;
  } finally {
    busyId.value = '';
  }
}

const carry = (annotation) => run(annotation, session.carryAnnotation, `Mark ${annotation.number} carried forward to this version.`);
const close = (annotation) => run(annotation, session.closeAnnotation, `Mark ${annotation.number} closed.`);
</script>

<template>
  <div class="rq-stack">
    <RouterLink v-if="marksLink" class="rq-marks-link" :to="marksLink(activeId)">
      <i class="bi bi-chat-square-text" aria-hidden="true"></i>Every mark in this round, with its discussion
    </RouterLink>
    <AnnotationList
      :active-id="activeId"
      :category-labels="categoryLabels"
      empty-text="No marks on this screen yet. Pick a tool and mark what you want to talk about."
      :hidden-authors="hiddenAuthors"
      label="Marks on this screen"
      :marks="marks"
      :show-resolved="showResolved"
      @activate="emit('activate', $event)"
      @select="emit('select', $event)"
    />

    <section v-if="outdated.length" class="rq-stack rq-stack--sm" aria-labelledby="rq-outdated-heading" data-testid="rq-outdated-marks">
      <h3 id="rq-outdated-heading" class="rq-eyebrow mb-0">From earlier versions · {{ outdated.length }}</h3>
      <p class="rq-xs rq-muted mb-0">This screen changed since these marks were made. Carry a mark forward if it still applies, or close it.</p>
      <ul class="rq-outdated">
        <li v-for="annotation in outdated" :key="annotation.id" class="rq-outdated__item">
          <button class="rq-outdated__open" type="button" @click="emit('activate', annotation.id)">
            <span class="rq-outdated__number" aria-hidden="true">{{ annotation.number }}</span>
            <span>
              <strong>{{ annotation.isMine ? 'You' : annotation.authorName }}</strong>
              <span class="rq-xs rq-muted d-block">Round {{ annotation.roundNumber ?? '?' }} · {{ annotationStatusLabel(annotation.status) }}<template v-if="annotation.thread?.[0]?.body"> · “{{ commentPlainText(annotation.thread[0].body).slice(0, 60) }}”</template></span>
            </span>
          </button>
          <div v-if="annotation.actions?.carry || annotation.actions?.close" class="rq-row rq-row--tight">
            <button v-if="annotation.actions?.carry" class="ghost-button ghost-button--compact" type="button" :disabled="busyId === annotation.id" :aria-label="`Carry mark ${annotation.number} forward`" @click="carry(annotation)">Carry forward</button>
            <button v-if="annotation.actions?.close" class="ghost-button ghost-button--compact" type="button" :disabled="busyId === annotation.id" :aria-label="`Close mark ${annotation.number}`" @click="close(annotation)">Close</button>
          </div>
        </li>
      </ul>
      <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    </section>
    <p class="visually-hidden" role="status">{{ status }}</p>
  </div>
</template>
