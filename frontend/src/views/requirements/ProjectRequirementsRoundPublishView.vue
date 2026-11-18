<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import RequirementsPackageChanges from '../../components/requirements/RequirementsPackageChanges.vue';
import RoundCloseFields from '../../components/requirements/rounds/RoundCloseFields.vue';
import RoundReviewerPicker from '../../components/requirements/rounds/RoundReviewerPicker.vue';
import '../../components/requirements/rounds/rounds.css';
import { apiClient } from '../../lib/auth/index.js';
import { useRequirementsWorkspace } from '../../lib/requirements/requirements-context.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { packageChecklist, packageMetaLine, sectionOfType } from '../../lib/requirements/requirements-packages.js';
import {
  REMINDER_OPTIONS,
  buildReviewerCandidates,
  closeFormError,
  closePayload,
  defaultDueInputValue,
  describePublishError,
  nextRoundNumber,
  openRoundOf,
  publishFormErrors,
  publishPayload,
  publishResultLines,
  publishSummaryLine,
} from '../../lib/requirements/requirements-rounds.js';
import { formatAgo } from '../../lib/requirements/requirements-time.js';
import { REVIEW_TRACK, reviewLocation } from '../../lib/requirements/requirements-tracks.js';

// Publish a draft package as the project's next review round (journey 4, design-v1 team-upload):
// 1 the package, 2 reviewers with required flags, 3 the ask (due date, reminder, note).
// One form, one submit. When another round is still open, people with decision rights
// close it as part of publishing (closePrevious); members are told who can.

const route = useRoute();
const workspace = useRequirementsWorkspace();

const pkg = ref(null);
const loading = ref(true);
const loadError = ref('');
const notFound = ref(false);
const rounds = ref([]);
const links = ref([]);
const openRound = ref(null);
const openRoundDirections = ref([]);
const selected = ref([]);
const due = ref(defaultDueInputValue());
const reminder = ref('2');
const note = ref('');
const closeFirst = ref({ directionId: '', outcome: '', statement: '' });
const fieldErrors = ref({});
const formError = ref('');
const closeError = ref('');
const publishing = ref(false);
const published = ref(null);
const doneHeading = ref(null);

const projectId = computed(() => workspace.projectId.value);
const packageId = computed(() => String(route.params.packageId ?? ''));
const track = computed(() => pkg.value?.track ?? REVIEW_TRACK);
const abilities = computed(() => workspace.abilities.value);
const canDecide = computed(() => Boolean(workspace.canDecide.value));
// The list can be stale (a round opened after the page loaded), so an open round known from a 409 counts too.
const roundNumber = computed(() => Math.max(nextRoundNumber(rounds.value), (Number(openRound.value?.number) || 0) + 1));
const candidates = computed(() => buildReviewerCandidates({ links: links.value, stakeholders: workspace.stakeholders.value, users: workspace.validUsers.value }));
const externalCount = computed(() => selected.value.filter((entry) => entry.actorType === 'stakeholder').length);
const memberCount = computed(() => selected.value.length - externalCount.value);
const summaryLine = computed(() => publishSummaryLine({ externalCount: externalCount.value, memberCount: memberCount.value }));
const checklist = computed(() => (pkg.value ? packageChecklist(pkg.value) : []));
const isDraft = computed(() => pkg.value?.status === 'draft');
const blockedByOpenRound = computed(() => Boolean(openRound.value) && !canDecide.value);
const submitLabel = computed(() => {
  if (publishing.value) return 'Publishing…';
  return openRound.value && canDecide.value ? `Close round ${openRound.value.number} and publish round ${roundNumber.value}` : `Publish round ${roundNumber.value}`;
});
const trackLocation = computed(() => reviewLocation(projectId.value));
const packageLocation = computed(() => ({ name: 'project-requirements-package', params: { packageId: packageId.value, projectId: projectId.value } }));
const questionPrompts = computed(() => Object.fromEntries((sectionOfType(pkg.value?.manifest ?? {}, 'questions')?.items ?? []).map((question) => [question.id, question.prompt])));
const createdTopics = computed(() => {
  if (!published.value) return [];
  const created = new Set(published.value.createdTopicIds ?? []);
  return Object.entries(published.value.round?.questionTopics ?? {})
    .filter(([, topicId]) => created.has(topicId))
    .map(([questionId, topicId]) => ({ prompt: questionPrompts.value[questionId] || questionId, topicId }));
});

function token() {
  return workspace.token();
}

async function loadOpenRoundDirections(round) {
  openRoundDirections.value = [];
  if (!round?.id || !canDecide.value) return;
  try {
    const result = await apiClient.passive.getRequirementsRoundResults(projectId.value, round.id, token());
    openRoundDirections.value = (result.directions ?? []).map((direction) => ({ directionId: direction.directionId, title: direction.title }));
  } catch {
    openRoundDirections.value = [];
  }
}

function setOpenRound(round) {
  const same = openRound.value?.id && openRound.value.id === round?.id;
  openRound.value = round ? { id: round.id ?? null, number: round.number ?? null } : null;
  if (!same) {
    closeFirst.value = { directionId: '', outcome: '', statement: '' };
    loadOpenRoundDirections(openRound.value);
  }
}

async function load() {
  if (!projectId.value || !packageId.value) return;
  loading.value = true;
  try {
    const result = await apiClient.getRequirementsPackage(projectId.value, packageId.value, token());
    pkg.value = result.package ?? null;
    loadError.value = '';
    notFound.value = false;
  } catch (error) {
    if (error?.status === 404) notFound.value = true;
    else loadError.value = describeRequirementsError(error, 'Unable to load this package.').message;
  } finally {
    loading.value = false;
  }
  if (!pkg.value) return;
  try {
    // One round open at a time across the project.
    const result = await apiClient.passive.listRequirementsRounds(projectId.value, '', token());
    rounds.value = result.rounds ?? [];
    setOpenRound(openRoundOf(rounds.value));
  } catch {
    rounds.value = [];
  }
  if (abilities.value.manageLinks) {
    try {
      const result = await apiClient.passive.listRequirementsLinks(projectId.value, token());
      links.value = result.links ?? [];
    } catch {
      links.value = [];
    }
  }
}

watch(
  packageId,
  () => {
    pkg.value = null;
    published.value = null;
    selected.value = [];
    formError.value = '';
    fieldErrors.value = {};
    load();
  },
  { immediate: true },
);

watch(due, (value) => {
  if (!value && reminder.value) reminder.value = '';
});

async function submit() {
  if (publishing.value || !pkg.value || !isDraft.value) return;
  formError.value = '';
  closeError.value = '';
  fieldErrors.value = publishFormErrors({ due: due.value, reminder: reminder.value, selected: selected.value });
  let closePrevious = null;
  if (openRound.value && canDecide.value) {
    closeError.value = closeFormError(closeFirst.value);
    if (!closeError.value) closePrevious = closePayload(closeFirst.value);
  }
  if (Object.keys(fieldErrors.value).length > 0 || closeError.value) {
    formError.value = 'Fix the highlighted fields, then publish again.';
    return;
  }
  publishing.value = true;
  try {
    const result = await apiClient.publishRequirementsRound(projectId.value, publishPayload({
      closePrevious,
      due: due.value,
      note: note.value,
      packageId: packageId.value,
      reminder: reminder.value,
      selected: selected.value,
    }), token());
    published.value = result;
    pkg.value = { ...pkg.value, status: 'published' };
    workspace.refreshShared();
    await nextTick();
    doneHeading.value?.focus();
  } catch (error) {
    const known = describePublishError(error, { canDecide: canDecide.value, candidates: candidates.value });
    if (known?.code === 'round_open') setOpenRound(known.openRound);
    if (known?.code === 'package_not_draft') load();
    formError.value = known?.message ?? describeRequirementsError(error, 'Unable to publish the round. Try again.').message;
  } finally {
    publishing.value = false;
  }
}
</script>

<template>
  <article class="rq-stack rq-publish" aria-labelledby="rq-publish-title">
    <nav class="rq-breadcrumb" aria-label="Breadcrumb">
      <ol>
        <li><RouterLink :to="{ name: 'project-requirements', params: { projectId } }">Requirements</RouterLink></li>
        <li><RouterLink :to="trackLocation">Review</RouterLink></li>
        <li aria-current="page">New round</li>
      </ol>
    </nav>

    <div v-if="notFound" class="rq-empty">
      <h2 id="rq-publish-title" class="rq-title rq-title--md" tabindex="-1" data-rq-focus>This package doesn’t exist</h2>
      <p class="rq-small">It may belong to another project. The project's packages are listed on the Review tab.</p>
      <RouterLink class="ghost-button ghost-button--compact" :to="trackLocation">Back to Review</RouterLink>
    </div>

    <div v-else-if="loadError && !pkg" class="rq-stack">
      <h2 id="rq-publish-title" class="visually-hidden" tabindex="-1" data-rq-focus>New round</h2>
      <div class="error-banner rq-row rq-row--between" role="alert">
        <span>{{ loadError }}</span>
        <button class="ghost-button ghost-button--compact" type="button" @click="load()">Try again</button>
      </div>
    </div>

    <section v-else-if="published" class="rq-panel rq-panel--accent rq-stack" aria-labelledby="rq-publish-done-heading">
      <h2 id="rq-publish-title" class="visually-hidden">New round</h2>
      <h3 id="rq-publish-done-heading" ref="doneHeading" class="rq-title rq-title--md" tabindex="-1" data-rq-focus>
        Round {{ published.round?.number }} published
      </h3>
      <div class="rq-publish-done rq-small" role="status">
        <p v-for="line in publishResultLines(published)" :key="line" class="mb-0">{{ line }}</p>
      </div>
      <ul v-if="createdTopics.length" class="rq-created-topics rq-small" aria-label="Topics created for package questions">
        <li v-for="topic in createdTopics" :key="topic.topicId">
          <RouterLink :to="{ name: 'project-requirements-topic', params: { projectId, topicId: topic.topicId } }">{{ topic.prompt }}</RouterLink>
        </li>
      </ul>
      <div class="rq-row rq-row--wrap">
        <RouterLink
          class="primary-button primary-button--compact"
          :to="{ name: 'project-requirements-round', params: { projectId, roundId: published.round?.id } }"
        >Open round {{ published.round?.number }}</RouterLink>
        <RouterLink class="ghost-button ghost-button--compact" :to="trackLocation">Back to Review</RouterLink>
      </div>
    </section>

    <template v-else>
      <header class="rq-topic-head">
        <div class="rq-topic-head__main">
          <h2 id="rq-publish-title" class="rq-title rq-title--lg" tabindex="-1" data-rq-focus>
            {{ pkg ? `Round ${roundNumber} · ${pkg.title}` : 'Loading package…' }}
          </h2>
        </div>
        <div v-if="pkg" class="rq-topic-head__actions">
          <RouterLink class="ghost-button" :to="packageLocation"><i class="bi bi-eye" aria-hidden="true"></i>Preview as a reviewer</RouterLink>
          <button
            v-if="isDraft && abilities.publishRounds"
            class="primary-button"
            type="submit"
            form="rq-publish-form"
            :disabled="publishing || blockedByOpenRound"
          >
            <i class="bi bi-send" aria-hidden="true"></i>{{ submitLabel }}
          </button>
        </div>
      </header>

      <p v-if="loading && !pkg" class="rq-small rq-muted mb-0">Loading the package…</p>

      <template v-if="pkg">
        <p v-if="!abilities.publishRounds" class="rq-notice mb-0" role="note">
          <i class="bi bi-lock" aria-hidden="true"></i>Publishing a round needs member access or above on this project.
        </p>
        <p v-else-if="!isDraft" class="rq-notice mb-0" role="note">
          <i class="bi bi-info-circle" aria-hidden="true"></i>
          Version {{ pkg.version }} is {{ pkg.status === 'withdrawn' ? 'withdrawn' : 'already published' }}, so it can’t be published again. Upload a new version to start another round.
        </p>

        <p v-if="formError" class="error-banner mb-0" role="alert">{{ formError }}</p>

        <form
          id="rq-publish-form"
          class="rq-publish-grid"
          novalidate
          :aria-busy="publishing ? 'true' : 'false'"
          @submit.prevent="submit"
        >
          <section class="rq-panel rq-stack" aria-labelledby="rq-publish-package-heading">
            <div class="rq-row rq-row--between rq-row--wrap">
              <div class="rq-row rq-row--tight">
                <span class="rq-sect-num" aria-hidden="true">1</span>
                <h3 id="rq-publish-package-heading" class="rq-title rq-title--sm">Package</h3>
              </div>
              <span class="rq-chip rq-chip--ok"><i class="bi bi-check2" aria-hidden="true"></i>Valid · {{ pkg.status }} v{{ pkg.version }}</span>
            </div>
            <div class="rq-notice">
              <i class="bi bi-file-earmark-zip" aria-hidden="true"></i>
              <span class="rq-grow">
                <strong>{{ pkg.title }}</strong>
                <span class="rq-xs rq-muted d-block">{{ packageMetaLine(pkg) }}<template v-if="pkg.createdAt"> · {{ formatAgo(pkg.createdAt) }}</template></span>
              </span>
            </div>
            <ul class="rq-checks">
              <li v-for="(item, index) in checklist" :key="`${item.code}-${index}`" class="rq-check" :class="`rq-check--${item.tone}`">
                <i class="bi" :class="item.tone === 'warn' ? 'bi-exclamation-triangle-fill' : 'bi-check-circle-fill'" aria-hidden="true"></i>
                <span><span v-if="item.tone === 'warn'" class="visually-hidden">Warning: </span>{{ item.text }}</span>
                <span class="rq-xs rq-muted">{{ item.tone === 'warn' ? 'warning' : '' }}</span>
              </li>
            </ul>
            <RequirementsPackageChanges :changes="pkg.changes" />
          </section>

          <div v-if="isDraft && abilities.publishRounds" class="rq-stack rq-publish-grid__form">
            <section
              v-if="openRound"
              class="rq-panel rq-panel--warn rq-stack"
              aria-labelledby="rq-publish-open-heading"
            >
              <h3 id="rq-publish-open-heading" class="rq-title rq-title--sm">Round {{ openRound.number }} is still open</h3>
              <template v-if="canDecide">
                <p class="rq-small mb-0">Only one review round can be open at a time. Close round {{ openRound.number }} first; publishing does both in one step.</p>
                <RoundCloseFields
                  v-model="closeFirst"
                  :directions="openRoundDirections"
                  :error="closeError"
                  id-prefix="rq-publish-close"
                  :round-number="openRound.number"
                />
              </template>
              <p v-else class="rq-small mb-0">
                Only one review round can be open at a time. An admin or manager has to close round {{ openRound.number }} before this package can be published.
              </p>
              <RouterLink
                v-if="openRound.id"
                class="rq-xs"
                :to="{ name: 'project-requirements-round', params: { projectId, roundId: openRound.id } }"
              >See round {{ openRound.number }} results</RouterLink>
            </section>

            <section class="rq-panel rq-stack" aria-labelledby="rq-publish-reviewers-heading">
              <div class="rq-row rq-row--tight">
                <span class="rq-sect-num" aria-hidden="true">2</span>
                <h3 id="rq-publish-reviewers-heading" class="rq-title rq-title--sm">Reviewers</h3>
              </div>
              <p v-if="candidates.length === 0" class="rq-small rq-muted mb-0">Nobody can review yet. Add project members or stakeholders to the project first.</p>
              <fieldset v-else class="rq-field" :aria-describedby="fieldErrors.reviewers ? 'rq-publish-reviewers-error' : undefined">
                <legend class="visually-hidden">Choose reviewers</legend>
                <RoundReviewerPicker v-model="selected" :candidates="candidates" name="publish" />
              </fieldset>
              <p v-if="fieldErrors.reviewers" id="rq-publish-reviewers-error" class="rq-field__hint rq-field__error">{{ fieldErrors.reviewers }}</p>
              <p class="rq-xs rq-muted mb-0">
                <i class="bi bi-link-45deg" aria-hidden="true"></i>
                External reviewers get a personal link by email. It stays valid while they have an open round or topic, then for 14 more days. Admins and managers can extend or revoke it.
              </p>
            </section>

            <section class="rq-panel rq-stack" aria-labelledby="rq-publish-ask-heading">
              <div class="rq-row rq-row--tight">
                <span class="rq-sect-num" aria-hidden="true">3</span>
                <h3 id="rq-publish-ask-heading" class="rq-title rq-title--sm">Ask</h3>
              </div>
              <div class="rq-field-row">
                <div class="rq-field">
                  <label for="rq-publish-due">Due</label>
                  <input
                    id="rq-publish-due"
                    v-model="due"
                    class="form-control"
                    type="datetime-local"
                    :aria-invalid="fieldErrors.due ? 'true' : undefined"
                    :aria-describedby="fieldErrors.due ? 'rq-publish-due-error' : undefined"
                  />
                  <p v-if="fieldErrors.due" id="rq-publish-due-error" class="rq-field__hint rq-field__error">{{ fieldErrors.due }}</p>
                </div>
                <div class="rq-field">
                  <label for="rq-publish-reminder">Reminder</label>
                  <select
                    id="rq-publish-reminder"
                    v-model="reminder"
                    class="form-select"
                    :disabled="!due"
                    :aria-invalid="fieldErrors.reminder ? 'true' : undefined"
                    :aria-describedby="fieldErrors.reminder ? 'rq-publish-reminder-error' : undefined"
                  >
                    <option v-for="option in REMINDER_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
                  </select>
                  <p v-if="fieldErrors.reminder" id="rq-publish-reminder-error" class="rq-field__hint rq-field__error">{{ fieldErrors.reminder }}</p>
                </div>
              </div>
              <div class="rq-field">
                <label for="rq-publish-note">Note to reviewers</label>
                <textarea id="rq-publish-note" v-model="note" class="form-control" maxlength="4000" rows="4"></textarea>
                <p class="rq-field__hint">Goes in the invitation email and at the start of the review.</p>
              </div>
              <p id="rq-publish-summary" class="rq-xs rq-muted mb-0" aria-live="polite">{{ summaryLine }} Reviewers see the package exactly as in Preview.</p>
            </section>
          </div>
        </form>
      </template>
    </template>
  </article>
</template>
