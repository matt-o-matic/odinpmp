<script setup>
import { computed, ref, useId } from 'vue';

import { QUESTION_REMOVED_MESSAGE } from '../../../lib/requirements/requirements-errors.js';
import { NOT_ANSWERED, answerableQuestions, isAnswered, previousAnswerLine, reviewSteps, scaleSteps } from '../../../lib/requirements/review-progress.js';
import { useReviewSession } from '../../../lib/requirements/review-session.js';

// The package's questions, by kind: one choice, several choices, a written answer, or a
// scale. Choices save at once and written answers when the field loses focus. An answer
// given on an earlier version is shown, but it only counts once it is given again here.
// A question whose topic the team deleted or dismissed shows only that it was removed.
const session = useReviewSession();
const ids = useId();
const errors = ref({});

const content = computed(() => session.state.content);
const questions = computed(() => content.value?.questions ?? []);
const asked = computed(() => answerableQuestions(content.value));
const steps = computed(() => reviewSteps(content.value));
const at = computed(() => steps.value.findIndex((step) => step.id === 'questions'));
const previous = computed(() => steps.value[at.value - 1] ?? null);
const disabled = computed(() => !session.canRespond());
const answeredCount = computed(() => asked.value.filter((question) => isAnswered(session.state.answers, question.id)).length);

function answer(question) {
  return session.state.answers[question.id] ?? null;
}

function previousAnswer(question) {
  return isAnswered(session.state.answers, question.id) ? null : session.state.previousAnswers?.[question.id] ?? null;
}

function setError(question, result) {
  errors.value = { ...errors.value, [question.id]: result?.ok === false ? result.message : '' };
}

function choose(question, value) {
  setError(question, session.setAnswer(question.id, value));
}

function toggle(question, optionId, checked) {
  const current = Array.isArray(answer(question)?.value) ? answer(question).value : [];
  const next = checked ? [...current, optionId] : current.filter((entry) => entry !== optionId);
  setError(question, session.setAnswer(question.id, next));
}

function type(question, text) {
  session.setAnswer(question.id, text, { commit: false });
}

function commit(question) {
  setError(question, session.commitAnswer(question.id));
}

function reuse(question) {
  const earlier = session.state.previousAnswers?.[question.id];
  if (earlier) setError(question, session.setAnswer(question.id, earlier.value));
}

function clear(question) {
  session.clearAnswer(question.id);
  setError(question, { ok: true });
}

function checkedIn(question, optionId) {
  const value = answer(question)?.value;
  return Array.isArray(value) && value.includes(optionId);
}
</script>

<template>
  <div class="rq-review-page">
    <section class="rq-review-card rq-stack" :aria-labelledby="`${ids}-heading`">
      <div>
        <p class="rq-eyebrow mb-1">{{ answeredCount }} of {{ asked.length }} answered</p>
        <h2 :id="`${ids}-heading`" class="rq-title rq-title--lg rq-section-heading" data-rq-review-heading tabindex="-1">Questions from the team</h2>
        <p class="rq-small rq-muted mb-0">Each answer posts to the related question, credited to you, where the team and the Odin summary see it. Skip any you can’t answer; they stay “Not answered”.</p>
      </div>
      <p v-if="!session.state.data?.me?.isReviewer" class="rq-notice mb-0">You’re not on this round’s reviewer list, so you can read the questions but not answer them here.</p>

      <ol class="rq-review-questions">
        <li v-for="(question, index) in questions" :id="`rq-question-${question.id}`" :key="question.id" class="rq-review-question">
          <template v-if="question.removed">
            <p class="rq-review-question__prompt mb-0"><span class="rq-review-question__number" aria-hidden="true">{{ index + 1 }}</span>{{ question.prompt }}</p>
            <p class="rq-notice mb-0"><i class="bi bi-slash-circle" aria-hidden="true"></i>{{ QUESTION_REMOVED_MESSAGE }}</p>
          </template>
          <template v-else>
            <fieldset v-if="question.kind !== 'text'" class="rq-field" :disabled="disabled" :aria-describedby="question.help ? `${ids}-help-${question.id}` : undefined">
              <legend class="rq-review-question__prompt"><span class="rq-review-question__number" aria-hidden="true">{{ index + 1 }}</span>{{ question.prompt }}<span v-if="question.kind === 'multi'" class="rq-xs rq-muted"> · choose any</span></legend>
              <p v-if="question.help" :id="`${ids}-help-${question.id}`" class="rq-xs rq-muted mb-0">{{ question.help }}</p>

              <div v-if="question.kind === 'single'" class="rq-choices">
                <label v-for="option in question.options" :key="option.id" class="rq-choice">
                  <input type="radio" class="form-check-input" :name="`${ids}-${question.id}`" :value="option.id" :checked="answer(question)?.value === option.id" @change="choose(question, option.id)" />
                  <span>{{ option.label }}</span>
                </label>
              </div>

              <div v-else-if="question.kind === 'multi'" class="rq-choices">
                <label v-for="option in question.options" :key="option.id" class="rq-choice">
                  <input type="checkbox" class="form-check-input" :value="option.id" :checked="checkedIn(question, option.id)" @change="toggle(question, option.id, $event.target.checked)" />
                  <span>{{ option.label }}</span>
                </label>
              </div>

              <div v-else-if="question.kind === 'scale'" class="rq-scale">
                <span v-if="question.scale?.minLabel" class="rq-xs rq-muted rq-scale__end" aria-hidden="true">{{ question.scale.minLabel }}</span>
                <div class="rq-seg rq-scale__options">
                  <label v-for="step in scaleSteps(question.scale)" :key="step.value" class="rq-seg__option">
                    <input type="radio" :name="`${ids}-${question.id}`" :value="step.value" :checked="answer(question)?.value === step.value" :aria-label="step.label ? `${step.value}, ${step.label}` : String(step.value)" @change="choose(question, step.value)" />
                    <span aria-hidden="true">{{ step.value }}</span>
                  </label>
                </div>
                <span v-if="question.scale?.maxLabel" class="rq-xs rq-muted rq-scale__end" aria-hidden="true">{{ question.scale.maxLabel }}</span>
              </div>
            </fieldset>

            <div v-else class="rq-field">
              <label :for="`${ids}-${question.id}`" class="rq-review-question__prompt"><span class="rq-review-question__number" aria-hidden="true">{{ index + 1 }}</span>{{ question.prompt }}</label>
              <p v-if="question.help" :id="`${ids}-help-${question.id}`" class="rq-xs rq-muted mb-0">{{ question.help }}</p>
              <textarea
                :id="`${ids}-${question.id}`"
                class="rq-textarea"
                :aria-describedby="question.help ? `${ids}-help-${question.id}` : undefined"
                :disabled="disabled"
                maxlength="4000"
                rows="3"
                :value="answer(question)?.value ?? ''"
                @blur="commit(question)"
                @input="type(question, $event.target.value)"
              ></textarea>
            </div>

            <div class="rq-row rq-row--wrap rq-row--tight rq-review-question__status">
              <span v-if="isAnswered(session.state.answers, question.id)" class="rq-chip rq-chip--ok"><i class="bi bi-check2" aria-hidden="true"></i>Answered</span>
              <span v-else class="rq-chip rq-chip--outline">{{ NOT_ANSWERED }}</span>
              <button v-if="isAnswered(session.state.answers, question.id) && !disabled" class="rq-text-action" type="button" :aria-label="`Clear your answer to: ${question.prompt}`" @click="clear(question)">Clear answer</button>
            </div>
            <p v-if="previousAnswer(question)" class="rq-xs rq-muted mb-0 rq-review-question__earlier">
              {{ previousAnswerLine(previousAnswer(question)) }} It doesn’t count for this version until you answer again.
              <button v-if="!disabled" class="rq-text-action" type="button" @click="reuse(question)">Give the same answer</button>
            </p>
            <p v-if="errors[question.id]" class="error-banner mb-0" role="alert">{{ errors[question.id] }}</p>
          </template>
        </li>
      </ol>

      <div class="rq-row rq-row--between rq-review-card__foot">
        <button v-if="previous" class="ghost-button" type="button" @click="session.goTo({ step: previous.id })">
          <i class="bi bi-arrow-left" aria-hidden="true"></i>{{ previous.label }}
        </button>
        <span v-else></span>
        <button class="primary-button" type="button" @click="session.goTo({ step: 'submit' })">
          Review and submit<i class="bi bi-arrow-right" aria-hidden="true"></i>
        </button>
      </div>
    </section>
  </div>
</template>
