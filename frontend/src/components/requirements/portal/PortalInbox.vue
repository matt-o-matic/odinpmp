<script setup>
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { apiClient } from '../../../lib/auth/index.js';
import { signingKindLabel, signingProgressLabel } from '../../../lib/projects/project-signing.js';
import { usePortal } from '../../../lib/requirements/portal-context.js';
import {
  closedRounds,
  decisionLine,
  openRounds,
  questionMeta,
  roundAsk,
  roundContents,
  roundProgress,
  summaryLine,
  waitingQuestions,
} from '../../../lib/requirements/portal-view.js';
import { formatShortDate } from '../../../lib/requirements/requirements-time.js';
import { trackChipClass, trackLabel } from '../../../lib/requirements/requirements-tracks.js';
import { commentPlainText } from '../../../lib/rich-content/comment-markdown.js';

// The stakeholder's inbox (sh-inbox.png): one clear ask per open round, the questions
// waiting for them (assigned ones first, then every open question, Q-13a), and what was
// recently decided, which they can still comment on.
const { portal, rounds, token } = usePortal();

const projectName = computed(() => portal.value?.project?.name ?? '');
const open = computed(() => openRounds(rounds.value));
const closed = computed(() => closedRounds(rounds.value));
const questions = computed(() => waitingQuestions(portal.value?.topics));
const decisions = computed(() => (portal.value?.decisions ?? []).slice(0, 6));
// Shared documents and signature requests (docs/document-signing). A server without them, or a
// failed load, leaves the inbox as it was.
const signing = ref(null);
const awaitingSignature = computed(() => {
  const byId = new Map((signing.value?.requests ?? []).map((request) => [request.id, request]));
  return (signing.value?.awaitingMe ?? []).map((id) => byId.get(id)).filter(Boolean);
});
const sharedCount = computed(() => signing.value?.documents?.length ?? 0);
const documentsLink = computed(() => ({ name: 'requirements-portal-documents', params: { token: token.value } }));

function signingLink(request) {
  return { name: 'requirements-portal-signing', params: { requestId: request.id, token: token.value } };
}

async function loadSigning() {
  try {
    signing.value = await apiClient.passive.getRequirementsPortalDocuments(token.value);
  } catch {
    signing.value = null;
  }
}

watch(token, loadSigning, { immediate: true });
// The portal reloads its data on live changes; documents follow it.
watch(portal, (next, previous) => { if (previous && next) loadSigning(); });

function ask(round) {
  return roundAsk(round, { projectName: projectName.value });
}

function reviewLink(round) {
  return { name: 'requirements-portal-review', params: { roundId: round.id, token: token.value } };
}

function questionLink(topicId) {
  return { name: 'requirements-portal-question', params: { token: token.value, topicId } };
}

watch(projectName, (name) => {
  if (typeof document !== 'undefined' && name) document.title = `${name} · Requirements review`;
}, { immediate: true });
</script>

<template>
  <div class="rq-portal-page rq-stack">
    <h1 class="visually-hidden">Requirements review for {{ projectName || 'this project' }}</h1>

    <section
      v-for="request in awaitingSignature"
      :key="request.id"
      class="dashboard-panel rq-panel rq-stack rq-stack--sm"
      :aria-labelledby="`rq-sign-${request.id}`"
      data-testid="rq-signing-ask"
    >
      <p class="rq-eyebrow mb-0">{{ signingKindLabel(request.kind) }} · {{ signingProgressLabel(request.progress) }}</p>
      <h2 :id="`rq-sign-${request.id}`" class="rq-title rq-title--md mb-0">Your signature is needed: {{ request.title }}</h2>
      <RouterLink class="primary-button rq-portal-sign__start" :to="signingLink(request)">
        Review and sign<span class="visually-hidden">: {{ request.title }}</span><i class="bi bi-arrow-right" aria-hidden="true"></i>
      </RouterLink>
    </section>

    <section
      v-for="round in open"
      :key="round.id"
      class="dashboard-panel rq-portal-hero"
      :aria-labelledby="`rq-ask-${round.id}`"
      data-testid="rq-round-ask"
    >
      <div class="rq-stack">
        <p class="rq-eyebrow mb-0">{{ trackLabel(round.track) }} · Round {{ round.number }}</p>
        <h2 :id="`rq-ask-${round.id}`" class="rq-title rq-portal-hero__title">{{ ask(round).headline }}</h2>
        <div v-if="roundContents(round.progress).length" class="rq-review-what">
          <div v-for="item in roundContents(round.progress)" :key="item.label" class="rq-review-what__item"><b>{{ item.count }}</b><span class="rq-xs rq-muted">{{ item.label }}</span></div>
        </div>
        <div v-if="round.note" class="rq-asknote"><strong>From {{ ask(round).asker.known ? ask(round).asker.name.split(' ')[0] : 'the team' }}:</strong> {{ round.note }}</div>
      </div>
      <div class="rq-panel rq-panel--soft rq-stack rq-portal-hero__progress">
        <p class="rq-eyebrow mb-0">Your progress</p>
        <div class="rq-title rq-title--md">{{ roundProgress(round).text }}</div>
        <div class="rq-review-meter" role="img" :aria-label="`${roundProgress(round).percent}% done`"><span :style="{ width: `${roundProgress(round).percent}%` }"></span></div>
        <p v-if="round.submittedAt" class="rq-xs mb-0"><i class="bi bi-check2-circle rq-review-ok" aria-hidden="true"></i> Sent {{ formatShortDate(round.submittedAt) }}. You can keep commenting until the round closes.</p>
        <p v-else class="rq-xs rq-muted mb-0">Your work saves as you go, and you can stop and come back with this link.</p>
        <RouterLink class="primary-button rq-portal-hero__start" :to="reviewLink(round)">
          {{ roundProgress(round).action }}<span class="visually-hidden">: round {{ round.number }}</span><i class="bi bi-arrow-right" aria-hidden="true"></i>
        </RouterLink>
        <p class="rq-xs rq-muted mb-0">Anything you skip shows as “Not reviewed”. Nobody assumes you agree.</p>
      </div>
    </section>

    <section v-if="!open.length && !awaitingSignature.length" class="rq-panel rq-stack rq-stack--sm" aria-labelledby="rq-no-rounds">
      <h2 id="rq-no-rounds" class="rq-title rq-title--md">Nothing to review right now</h2>
      <p class="rq-small rq-muted mb-0">When the team asks for your review, it shows up here and in your email.</p>
    </section>

    <div class="rq-portal-grid">
      <section class="rq-panel rq-stack" aria-labelledby="rq-questions-heading">
        <h2 id="rq-questions-heading" class="rq-eyebrow">Questions waiting for you · {{ questions.length }}</h2>
        <p v-if="!questions.length" class="rq-small rq-muted mb-0">No open questions right now.</p>
        <ul v-else class="rq-portal-cards">
          <li v-for="topic in questions" :key="topic.id" class="rq-comment rq-portal-card">
            <div class="rq-comment__meta">
              <span class="rq-chip" :class="trackChipClass(topic.track)">{{ trackLabel(topic.track) }}</span>
              <span>{{ questionMeta(topic).role }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ questionMeta(topic).comments }}</span>
            </div>
            <RouterLink class="rq-portal-card__title" :to="questionLink(topic.id)">{{ topic.prompt }}</RouterLink>
            <p class="rq-xs rq-muted mb-0">Odin summary: {{ summaryLine(topic.summary) }}</p>
          </li>
        </ul>
        <p class="rq-xs rq-muted mb-0"><i class="bi bi-envelope" aria-hidden="true"></i> You can also reply to any question by answering its email.</p>
      </section>

      <section class="rq-panel rq-stack" aria-labelledby="rq-decided-heading">
        <h2 id="rq-decided-heading" class="rq-eyebrow">Recently decided</h2>
        <p v-if="!decisions.length" class="rq-small rq-muted mb-0">Nothing decided yet.</p>
        <ul v-else class="rq-portal-decisions">
          <li v-for="decision in decisions" :key="decision.id" class="rq-row rq-row--top rq-small">
            <i class="bi bi-check2-circle rq-review-ok" aria-hidden="true"></i>
            <div>
              <RouterLink class="rq-portal-decision__statement" :to="questionLink(decision.topicId)">{{ commentPlainText(decision.statement) }}</RouterLink>
              <div class="rq-xs rq-muted">{{ decisionLine(decision) }}<template v-if="decision.topicPrompt"> · on “{{ decision.topicPrompt }}”</template></div>
            </div>
          </li>
        </ul>
        <p class="rq-xs rq-muted mb-0">Disagree with a decision? Comment on it and the team will see it.</p>
      </section>
    </div>

    <section v-if="sharedCount || signing?.requests?.length" class="rq-panel rq-row rq-row--between rq-row--wrap" aria-labelledby="rq-documents-heading">
      <h2 id="rq-documents-heading" class="rq-eyebrow mb-0">Shared documents · {{ sharedCount }}</h2>
      <RouterLink class="rq-portal-back" :to="documentsLink"><i class="bi bi-folder2-open" aria-hidden="true"></i>Documents and signatures</RouterLink>
    </section>

    <section v-if="closed.length" class="rq-panel rq-stack rq-stack--sm" aria-labelledby="rq-earlier-heading">
      <h2 id="rq-earlier-heading" class="rq-eyebrow">Earlier rounds</h2>
      <ul class="rq-portal-earlier">
        <li v-for="round in closed" :key="round.id" class="rq-row rq-row--between rq-row--wrap rq-small">
          <span><strong>Round {{ round.number }}</strong> · {{ round.title }}<span class="rq-muted"> · closed{{ round.closedAt ? ` ${formatShortDate(round.closedAt)}` : '' }}</span></span>
          <RouterLink :to="reviewLink(round)">View your review<span class="visually-hidden"> for round {{ round.number }}</span></RouterLink>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.rq-portal-sign__start { justify-self: start; display: inline-flex; align-items: center; gap: 0.4rem; min-height: 2.75rem; }
</style>
