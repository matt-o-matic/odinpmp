<script setup>
import { computed, useId } from 'vue';

import RequirementsMarkdown from '../RequirementsMarkdown.vue';
import RequirementsMermaidFlow from '../RequirementsMermaidFlow.vue';
import { answerableQuestions, dueDateText, pluralize, progressPercent, reviewSteps } from '../../../lib/requirements/review-progress.js';
import { useReviewSession } from '../../../lib/requirements/review-session.js';

// What the team needs from this round: the package summary, the team's note, the due date,
// the reviewer's progress, and the context, flows, and boundaries the package brings.
defineProps({
  asker: { default: '', type: String },
});

const session = useReviewSession();
const ids = useId();

const content = computed(() => session.state.content);
const round = computed(() => session.state.data?.round ?? {});
const progress = computed(() => session.progress());
const percent = computed(() => progressPercent(progress.value));
const steps = computed(() => reviewSteps(content.value));
const next = computed(() => steps.value[1] ?? null);
const due = computed(() => dueDateText(round.value.dueAt));
const counts = computed(() => {
  const items = [];
  const directions = content.value?.directions.length ?? 0;
  const screens = content.value?.screens.length ?? 0;
  const questions = answerableQuestions(content.value).length;
  if (directions) items.push({ count: directions, label: directions === 1 ? 'direction to compare' : 'directions to compare' });
  if (screens) items.push({ count: screens, label: screens === 1 ? 'screen to mark up' : 'screens to mark up' });
  if (questions) items.push({ count: questions, label: questions === 1 ? 'question to answer' : 'questions to answer' });
  return items;
});
const startLabel = computed(() => {
  if (session.readOnly()) return 'Look through it';
  return progress.value.done > 0 ? 'Continue review' : 'Start review';
});
</script>

<template>
  <div class="rq-review-page">
    <section class="rq-review-card rq-overview" :aria-labelledby="`${ids}-heading`">
      <div class="rq-overview__main rq-stack">
        <div>
          <p class="rq-eyebrow mb-1">Round {{ round.number }} · version {{ round.packageVersion }}<template v-if="due"> · due {{ due }}</template></p>
          <h2 :id="`${ids}-heading`" class="rq-title rq-title--lg rq-section-heading" data-rq-review-heading tabindex="-1">{{ content?.title }}</h2>
        </div>
        <RequirementsMarkdown :source="content?.summary ?? ''" />
        <div v-if="counts.length" class="rq-review-what">
          <div v-for="item in counts" :key="item.label" class="rq-review-what__item"><b>{{ item.count }}</b><span class="rq-xs rq-muted">{{ item.label }}</span></div>
        </div>
        <div v-if="round.note" class="rq-asknote"><strong>From {{ asker || 'the team' }}:</strong> {{ round.note }}</div>

        <section v-if="content?.context?.body" class="rq-stack rq-stack--sm" :aria-labelledby="`${ids}-context`">
          <h3 :id="`${ids}-context`" class="rq-eyebrow mb-0">{{ content.context.title || 'Context' }}</h3>
          <RequirementsMarkdown :source="content.context.body" />
        </section>
        <section v-if="content?.flows?.length" class="rq-stack rq-stack--sm" :aria-labelledby="`${ids}-flows`">
          <h3 :id="`${ids}-flows`" class="rq-eyebrow mb-0">Flows</h3>
          <RequirementsMermaidFlow v-for="flow in content.flows" :key="flow.id" :flow="flow" heading-tag="h4" />
        </section>
        <section v-if="content?.references?.length" class="rq-stack rq-stack--sm" :aria-labelledby="`${ids}-refs`">
          <h3 :id="`${ids}-refs`" class="rq-eyebrow mb-0">References</h3>
          <ul class="rq-refs">
            <li v-for="reference in content.references" :key="reference.url" class="rq-ref">
              <a :href="reference.url" rel="noopener noreferrer" target="_blank">{{ reference.title }}<span class="visually-hidden"> (opens in a new tab)</span></a>
              <span class="rq-xs rq-muted">{{ reference.pattern }}</span>
            </li>
          </ul>
        </section>
        <section v-if="content?.boundaries" class="rq-stack rq-stack--sm" :aria-labelledby="`${ids}-bounds`">
          <h3 :id="`${ids}-bounds`" class="rq-eyebrow mb-0">Not part of this round</h3>
          <RequirementsMarkdown :source="content.boundaries" />
        </section>
      </div>

      <aside class="rq-panel rq-panel--soft rq-stack rq-overview__progress" :aria-labelledby="`${ids}-progress`">
        <p :id="`${ids}-progress`" class="rq-eyebrow mb-0">Your progress</p>
        <div class="rq-title rq-title--md">{{ progress.done }} of {{ pluralize(progress.total, 'step') }}</div>
        <div class="rq-review-meter" role="img" :aria-label="`${percent}% done`"><span :style="{ width: `${percent}%` }"></span></div>
        <p class="rq-xs rq-muted mb-0">Your work saves as you go, and you can stop and come back where you left off.</p>
        <button v-if="next" class="primary-button" type="button" @click="session.goTo({ step: next.id })">
          {{ startLabel }}<i class="bi bi-arrow-right" aria-hidden="true"></i>
        </button>
        <p class="rq-xs rq-muted mb-0">Anything you skip shows as “Not reviewed”. Nobody assumes you agree.</p>
      </aside>
    </section>
  </div>
</template>
