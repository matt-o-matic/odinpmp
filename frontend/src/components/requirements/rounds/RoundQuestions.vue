<script setup>
import { RouterLink } from 'vue-router';

import './rounds.css';

// The package's questions with each reviewer's answer. Answers are also posted to the
// linked topic's thread, so each question links there. Reviewers who have not answered are
// listed by name rather than counted as agreeing.
const props = defineProps({
  projectId: { required: true, type: String },
  // From questionRows(results).
  rows: { default: () => [], type: Array },
});

function topicLocation(topicId) {
  return { name: 'project-requirements-topic', params: { projectId: props.projectId, topicId } };
}
</script>

<template>
  <section class="rq-panel rq-stack" aria-labelledby="rq-round-questions-heading">
    <h3 id="rq-round-questions-heading" class="rq-eyebrow">Questions<template v-if="rows.length"> · {{ rows.length }}</template></h3>
    <p v-if="rows.length === 0" class="rq-small rq-muted mb-0">This package asks no questions.</p>
    <ol v-else class="rq-questions">
      <li v-for="question in rows" :key="question.questionId" class="rq-question">
        <div class="rq-row rq-row--between rq-row--wrap rq-row--top">
          <p class="rq-small mb-0"><strong>{{ question.prompt }}</strong></p>
          <span class="rq-xs rq-muted">{{ question.answersText }}</span>
        </div>
        <ul v-if="question.answers.length" class="rq-answers" :aria-label="`Answers to: ${question.prompt}`">
          <li v-for="answer in question.answers" :key="answer.actorRef">
            <span class="rq-muted">{{ answer.name }}:</span> {{ answer.text }}
          </li>
        </ul>
        <p v-if="question.missing.length" class="rq-xs rq-muted mb-0">Not answered: {{ question.missing.join(', ') }}</p>
        <p v-if="question.topicId" class="rq-xs mb-0">
          <RouterLink :to="topicLocation(question.topicId)">Open its topic<span class="visually-hidden">: {{ question.prompt }}</span></RouterLink>
        </p>
      </li>
    </ol>
  </section>
</template>
