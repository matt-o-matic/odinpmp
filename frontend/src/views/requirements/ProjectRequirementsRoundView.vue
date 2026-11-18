<script setup>
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import RequirementsPreferenceAcceptDialog from '../../components/requirements/RequirementsPreferenceAcceptDialog.vue';
import RoundCloseDialog from '../../components/requirements/rounds/RoundCloseDialog.vue';
import RoundDirectionBar from '../../components/requirements/rounds/RoundDirectionBar.vue';
import RoundEditDialog from '../../components/requirements/rounds/RoundEditDialog.vue';
import RoundPreferences from '../../components/requirements/rounds/RoundPreferences.vue';
import RoundQuestions from '../../components/requirements/rounds/RoundQuestions.vue';
import RoundRemindDialog from '../../components/requirements/rounds/RoundRemindDialog.vue';
import RoundReviewers from '../../components/requirements/rounds/RoundReviewers.vue';
import RoundSummary from '../../components/requirements/rounds/RoundSummary.vue';
import RoundVerdictGrid from '../../components/requirements/rounds/RoundVerdictGrid.vue';
import RoundViewTabs from '../../components/requirements/rounds/RoundViewTabs.vue';
import '../../components/requirements/rounds/rounds.css';
import { apiClient } from '../../lib/auth/index.js';
import { useRequirementsWorkspace } from '../../lib/requirements/requirements-context.js';
import { describeRequirementsError, requirementsErrorCode } from '../../lib/requirements/requirements-errors.js';
import { batchTouchesRound } from '../../lib/requirements/requirements-live-updates.js';
import {
  annotationTotals,
  buildDirectionPreference,
  buildReviewerCandidates,
  buildVerdictGrid,
  closedTopicsText,
  outcomeLabel,
  proposalsForRound,
  questionRows,
  reviewerCounts,
  roundPeople,
  roundStatusChip,
  submittedText,
} from '../../lib/requirements/requirements-rounds.js';
import { describeSummaryRefreshOutcome, describeSummaryRefreshError } from '../../lib/requirements/requirements-summary-status.js';
import { formatShortDate } from '../../lib/requirements/requirements-time.js';
import { chipToneClass } from '../../lib/requirements/requirements-topics.js';
import { REVIEW_TRACK, plural, reviewLocation as reviewTabLocation } from '../../lib/requirements/requirements-tracks.js';
import { commentPlainText } from '../../lib/rich-content/comment-markdown.js';

// One round's results and alignment (journeys 6, 7, and 8; design-v1 team-results): the
// header with progress and actions, verdicts by reviewer, direction preference, the
// selected screen's Odin summary, proposed preferences, reviewers, the round summary, and
// the questions. Closing needs decision rights (Q-04); changing reviewers and dates needs
// member and up (Q-05).

const route = useRoute();
const router = useRouter();
const workspace = useRequirementsWorkspace();

const detail = ref(null);
const canClose = ref(false);
const results = ref(null);
const loading = ref(true);
const loadError = ref('');
const notFound = ref(false);
const commentCount = ref(null);
const proposed = ref([]);
const proposedLoaded = ref(false);
const proposedError = ref('');
const latestPackageVersion = ref(null);
const imageUrls = ref({});
const links = ref([]);
const selectedCell = ref(null);
const refreshing = ref({});
const refreshResults = ref({});
const resending = ref('');
const closeOpen = ref(false);
const editOpen = ref(false);
const remindOpen = ref(false);
const accept = ref({ focus: 'statement', item: null, open: false });

const projectId = computed(() => workspace.projectId.value);
const roundId = computed(() => String(route.params.roundId ?? ''));
// Review is project-wide; a round's stored track picks its package and preference reads.
const track = computed(() => detail.value?.track ?? REVIEW_TRACK);
const abilities = computed(() => workspace.abilities.value);
const summary = computed(() => results.value?.round ?? detail.value ?? null);
const isOpen = computed(() => summary.value?.status === 'open');
const reviewers = computed(() => results.value?.reviewers ?? detail.value?.reviewers ?? []);
const counts = computed(() => reviewerCounts(reviewers.value));
const grid = computed(() => buildVerdictGrid(results.value ?? {}));
const preference = computed(() => buildDirectionPreference(results.value ?? {}));
const people = computed(() => roundPeople(results.value ?? {}));
const questions = computed(() => questionRows(results.value ?? {}));
const screenTitles = computed(() => Object.fromEntries((results.value?.screens ?? []).map((screen) => [screen.screenId, screen.title])));
const marks = computed(() => annotationTotals(results.value?.annotationCounts));
// Every mark and comment in the round, with its discussion; summary citations open there too.
const annotationsLocation = computed(() => ({ name: 'project-requirements-round-annotations', params: { projectId: projectId.value, roundId: roundId.value } }));
const statusChip = computed(() => (summary.value ? roundStatusChip(summary.value) : null));
const roles = computed(() => new Map((workspace.validUsers.value ?? []).map((user) => [String(user.id), user.role])));
const candidates = computed(() => buildReviewerCandidates({ links: links.value, stakeholders: workspace.stakeholders.value, users: workspace.validUsers.value }));
const nextNumber = computed(() => (Number(summary.value?.number) || 0) + 1);
const roundProposals = computed(() => proposalsForRound(proposed.value, roundId.value, { screenTitles: screenTitles.value }));
const directionOptions = computed(() => (results.value?.directions ?? []).map((direction) => ({ directionId: direction.directionId, title: direction.title })));
const me = computed(() => detail.value?.me ?? null);
const nextVersion = computed(() => (latestPackageVersion.value ?? (Number(detail.value?.package?.version ?? summary.value?.packageVersion) || 0)) + 1);
const notSubmitted = computed(() => counts.value.notSubmitted);

const selectedScreenId = computed(() => {
  const screens = results.value?.screens ?? [];
  const requested = String(route.query.screen ?? '');
  return screens.some((screen) => screen.screenId === requested) ? requested : (screens[0]?.screenId ?? '');
});
const selectedScreen = computed(() => (results.value?.screens ?? []).find((screen) => screen.screenId === selectedScreenId.value) ?? null);

const headerMeta = computed(() => {
  if (!summary.value) return '';
  const parts = [submittedText(counts.value)];
  if (summary.value.packageVersion != null) parts.push(`package v${summary.value.packageVersion}`);
  if (results.value) parts.push(plural(marks.value, 'mark'));
  if (commentCount.value != null) parts.push(plural(commentCount.value, 'comment'));
  return parts.join(' · ');
});

const trackLocation = computed(() => reviewTabLocation(projectId.value));
const uploadLocation = computed(() => ({ ...trackLocation.value, query: { upload: '1' } }));
const packageLocation = computed(() => (summary.value?.packageId
  ? { name: 'project-requirements-package', params: { packageId: summary.value.packageId, projectId: projectId.value }, ...(selectedScreenId.value ? { query: { screen: selectedScreenId.value } } : {}) }
  : null));

function token() {
  return workspace.token();
}

let loadSequence = 0;
async function load({ passive = false } = {}) {
  const id = roundId.value;
  if (!id || !projectId.value) return;
  const current = ++loadSequence;
  if (!passive) loading.value = true;
  const client = passive ? apiClient.passive : apiClient;
  try {
    const [detailResult, resultsResult] = await Promise.all([
      client.getRequirementsRound(projectId.value, id, token()),
      client.getRequirementsRoundResults(projectId.value, id, token()),
    ]);
    if (current !== loadSequence) return;
    detail.value = detailResult.round ?? null;
    canClose.value = Boolean(detailResult.canClose);
    results.value = resultsResult ?? null;
    loadError.value = '';
    notFound.value = false;
  } catch (error) {
    if (current !== loadSequence) return;
    if (error?.status === 404) notFound.value = true;
    else loadError.value = describeRequirementsError(error, 'Unable to load this round.').message;
  } finally {
    if (current === loadSequence) loading.value = false;
  }
}

let commentSequence = 0;
async function loadComments() {
  const id = roundId.value;
  const current = ++commentSequence;
  try {
    let cursor = '';
    let total = 0;
    for (let page = 0; page < 10; page += 1) {
      const result = await apiClient.passive.getRequirementsRoundFeedback(projectId.value, id, { cursor, limit: 500 }, token());
      total += (result.annotations ?? []).reduce((sum, annotation) => sum + (annotation.thread?.length ?? 0), 0);
      cursor = result.page?.nextCursor ?? '';
      if (!cursor) break;
    }
    if (current === commentSequence) commentCount.value = total;
  } catch {
    if (current === commentSequence) commentCount.value = null;
  }
}

let proposedSequence = 0;
async function loadProposed() {
  const current = ++proposedSequence;
  try {
    const result = await apiClient.passive.listRequirementsPreferences(projectId.value, track.value, token());
    if (current !== proposedSequence) return;
    proposed.value = result.proposed ?? [];
    proposedError.value = '';
  } catch (error) {
    if (current !== proposedSequence) return;
    proposedError.value = describeRequirementsError(error, 'Unable to load proposed preferences.').message;
  } finally {
    if (current === proposedSequence) proposedLoaded.value = true;
  }
}

async function loadPackages() {
  try {
    const result = await apiClient.passive.listRequirementsPackages(projectId.value, track.value, token());
    const versions = (result.packages ?? []).map((pkg) => Number(pkg.version) || 0);
    latestPackageVersion.value = versions.length ? Math.max(...versions) : null;
  } catch {
    latestPackageVersion.value = null;
  }
}

async function loadGrant(packageId) {
  if (!packageId) return;
  try {
    const result = await apiClient.passive.getRequirementsPackageGrant(projectId.value, packageId, token());
    imageUrls.value = result?.entryUrls ?? {};
  } catch {
    imageUrls.value = {};
  }
}

async function loadLinks() {
  if (!abilities.value.manageLinks) return;
  try {
    const result = await apiClient.passive.listRequirementsLinks(projectId.value, token());
    links.value = result.links ?? [];
  } catch {
    links.value = [];
  }
}

watch(
  roundId,
  async () => {
    detail.value = null;
    results.value = null;
    notFound.value = false;
    loadError.value = '';
    commentCount.value = null;
    proposedLoaded.value = false;
    selectedCell.value = null;
    imageUrls.value = {};
    await load();
    if (!detail.value) return;
    loadComments();
    loadProposed();
    loadPackages();
    loadGrant(detail.value.packageId ?? summary.value?.packageId);
  },
  { immediate: true },
);

watch(workspace.liveBatch, (batch) => {
  if (!detail.value || !batchTouchesRound(batch, roundId.value)) return;
  load({ passive: true });
  loadComments();
  loadProposed();
});

function selectScreen(screenId) {
  router.replace({ query: { ...route.query, screen: screenId || undefined } });
}

function selectCell(cell) {
  const same = selectedCell.value?.actorRef === cell.actorRef && selectedCell.value?.screenId === cell.screenId;
  selectedCell.value = same ? null : cell;
  if (cell.screenId !== selectedScreenId.value) selectScreen(cell.screenId);
}

async function refreshSummary(screenId = '') {
  const key = screenId || 'round';
  if (refreshing.value[key]) return;
  refreshing.value = { ...refreshing.value, [key]: true };
  refreshResults.value = { ...refreshResults.value, [key]: null };
  try {
    const result = await apiClient.refreshRequirementsRoundSummary(projectId.value, roundId.value, { screenId }, token());
    refreshResults.value = { ...refreshResults.value, [key]: describeSummaryRefreshOutcome(result) };
    await load({ passive: true });
  } catch (error) {
    refreshResults.value = {
      ...refreshResults.value,
      [key]: error?.status === 404
        ? { message: 'This round or screen no longer exists, or you can’t refresh its summary.', tone: 'error' }
        : describeSummaryRefreshError(error),
    };
  } finally {
    refreshing.value = { ...refreshing.value, [key]: false };
  }
}

async function resend(reviewer) {
  if (resending.value) return;
  resending.value = reviewer.id;
  try {
    const result = await apiClient.resendRequirementsRoundInvitation(projectId.value, roundId.value, reviewer.id, token());
    if (result?.round) detail.value = result.round;
    workspace.showMessage(`Sent ${reviewer.name} the invitation again.`);
    await load({ passive: true });
  } catch (error) {
    workspace.showMessage(
      requirementsErrorCode(error) === 'round_closed'
        ? 'This round is closed, so invitations can’t be sent.'
        : describeRequirementsError(error, `Unable to send ${reviewer.name} a reminder. Try again.`).message,
      'error',
    );
  } finally {
    resending.value = '';
  }
}

function remind() {
  if (notSubmitted.value.length === 1) {
    resend(notSubmitted.value[0]);
    return;
  }
  remindOpen.value = true;
}

async function handleReminded({ partial, sent }) {
  if (!partial) remindOpen.value = false;
  workspace.showMessage(`Sent reminders to ${sent.join(', ')}.`);
  await load({ passive: true });
}

async function handleClosed(result) {
  closeOpen.value = false;
  const number = summary.value?.number;
  workspace.showMessage(`Round ${number} closed${result?.round?.outcome ? `: ${outcomeLabel(result.round.outcome).toLowerCase()}` : ''}. The decision is recorded in your name.${closedTopicsText(result?.closedTopics)}`);
  await load({ passive: true });
  workspace.refreshShared();
  document.getElementById('rq-round-title')?.focus();
}

async function handleSaved(result) {
  editOpen.value = false;
  if (result?.round) detail.value = result.round;
  workspace.showMessage('Round updated.');
  await load({ passive: true });
}

async function openEdit() {
  editOpen.value = true;
  loadLinks();
}

// ?edit=1 (from the Review tab) opens Edit reviewers and dates once the round has loaded.
watch(
  () => [route.query.edit, detail.value?.id, isOpen.value, abilities.value.manageRounds],
  async ([edit, id, open, canManage]) => {
    if (edit !== '1' || !id || !open || !canManage) return;
    const { edit: _edit, ...query } = route.query;
    await router.replace({ query });
    openEdit();
  },
);

function openAccept({ focus, item }) {
  accept.value = { focus, item, open: true };
}

async function handleAccepted() {
  accept.value = { ...accept.value, open: false };
  workspace.showMessage('Preference accepted and added to the decision log.');
  await loadProposed();
  workspace.refreshShared();
}
</script>

<template>
  <article class="rq-stack rq-round" aria-labelledby="rq-round-title">
    <nav class="rq-breadcrumb" aria-label="Breadcrumb">
      <ol>
        <li><RouterLink :to="{ name: 'project-requirements', params: { projectId } }">Requirements</RouterLink></li>
        <li><RouterLink :to="trackLocation">Review</RouterLink></li>
        <li aria-current="page">{{ summary ? `Round ${summary.number}` : 'Round' }}</li>
      </ol>
    </nav>

    <div v-if="notFound" class="rq-empty">
      <h2 id="rq-round-title" class="rq-title rq-title--md" tabindex="-1" data-rq-focus>This round doesn’t exist</h2>
      <p class="rq-small">It may belong to another project. The project's rounds are listed on the Review tab.</p>
      <RouterLink class="ghost-button ghost-button--compact" :to="trackLocation">Back to Review</RouterLink>
    </div>

    <div v-else-if="loadError && !summary" class="rq-stack">
      <h2 id="rq-round-title" class="visually-hidden" tabindex="-1" data-rq-focus>Round</h2>
      <div class="error-banner rq-row rq-row--between" role="alert">
        <span>{{ loadError }}</span>
        <button class="ghost-button ghost-button--compact" type="button" @click="load()">Try again</button>
      </div>
    </div>

    <template v-else>
      <header class="rq-topic-head">
        <div class="rq-topic-head__main">
          <h2 id="rq-round-title" class="rq-title rq-title--lg" tabindex="-1" data-rq-focus>
            {{ summary ? `Round ${summary.number} results${summary.title ? ` · ${summary.title}` : ''}` : 'Loading round…' }}
          </h2>
          <div v-if="summary" class="rq-row rq-row--tight rq-row--wrap">
            <span class="rq-chip" :class="statusChip.tone === 'solid' ? 'rq-chip--solid' : chipToneClass(statusChip.tone)">{{ statusChip.label }}</span>
            <span class="rq-small rq-muted">{{ headerMeta }}</span>
          </div>
          <p v-if="summary?.status === 'closed'" class="rq-small mb-0">
            Closed by <strong>{{ detail?.closedBy?.name || detail?.decision?.decidedBy?.name || 'a team member' }}</strong>
            <template v-if="summary.closedAt"> on {{ formatShortDate(summary.closedAt) }}</template><template v-if="detail?.decision?.statement">: {{ commentPlainText(detail.decision.statement) }}</template>
          </p>
          <p v-if="summary?.note" class="rq-xs rq-muted mb-0">Note to reviewers: {{ summary.note }}</p>
        </div>
        <div v-if="summary" class="rq-topic-head__actions">
          <button v-if="isOpen && abilities.manageRounds && detail" class="ghost-button" type="button" @click="openEdit">
            <i class="bi bi-people" aria-hidden="true"></i>Edit reviewers and dates
          </button>
          <button
            v-if="isOpen && abilities.manageRounds && notSubmitted.length"
            class="ghost-button"
            type="button"
            :disabled="Boolean(resending)"
            @click="remind"
          >
            <i class="bi bi-bell" aria-hidden="true"></i>{{ notSubmitted.length === 1 ? `Remind ${notSubmitted[0].name}` : `Remind (${notSubmitted.length})` }}
          </button>
          <RouterLink v-if="abilities.uploadPackages" class="ghost-button" :to="uploadLocation">
            <i class="bi bi-upload" aria-hidden="true"></i>Upload v{{ nextVersion }}
          </RouterLink>
          <button v-if="isOpen && canClose" class="primary-button" type="button" @click="closeOpen = true">
            <i class="bi bi-flag" aria-hidden="true"></i>Close round
          </button>
        </div>
      </header>

      <RoundViewTabs
        current="results"
        :marks="results ? marks : null"
        :project-id="projectId"
        :review="Boolean(abilities.comment)"
        :review-label="me && !me.submittedAt && isOpen ? 'Review' : 'Your review'"
        :round-id="roundId"
      />

      <p v-if="loading && !summary" class="rq-small rq-muted mb-0">Loading the round…</p>
      <p v-if="loadError && summary" class="error-banner mb-0" role="alert">{{ loadError }}</p>

      <template v-if="results">
        <div class="rq-round-grid">
          <div class="rq-panel rq-stack">
            <RoundVerdictGrid
              :dimensions="results.dimensions ?? []"
              :grid="grid"
              :selected-cell="selectedCell"
              :selected-screen-id="selectedScreenId"
              @select-cell="selectCell"
              @select-screen="selectScreen"
            />
            <template v-if="preference.rows.length">
              <div class="rq-divider" aria-hidden="true"></div>
              <RoundDirectionBar :preference="preference" />
            </template>
          </div>

          <section v-if="selectedScreen" class="rq-panel rq-stack" :aria-label="`Selected screen: ${selectedScreen.title}`">
            <div class="rq-row rq-row--between rq-row--wrap">
              <div class="rq-screen-pick">
                <span class="rq-screen-pick__thumb" :class="{ 'rq-screen-pick__thumb--empty': !imageUrls[selectedScreen.screenId] || selectedScreen.kind !== 'image' }" aria-hidden="true">
                  <img v-if="selectedScreen.kind === 'image' && imageUrls[selectedScreen.screenId]" :src="imageUrls[selectedScreen.screenId]" alt="" referrerpolicy="no-referrer" />
                  <i v-else class="bi" :class="selectedScreen.kind === 'prototype' ? 'bi-window-stack' : 'bi-image'"></i>
                </span>
                <div>
                  <p class="rq-eyebrow mb-0">Selected screen</p>
                  <strong>{{ selectedScreen.title }}</strong>
                </div>
              </div>
              <RouterLink v-if="packageLocation" class="rq-xs" :to="packageLocation" :aria-label="`Open ${selectedScreen.title} in the package`">Open in package</RouterLink>
            </div>
            <RoundSummary
              :can-refresh="abilities.refreshSummary"
              :feedback-location="annotationsLocation"
              heading-id="rq-screen-summary-heading"
              :people="people"
              :refresh-result="refreshResults[selectedScreen.screenId]"
              :refreshing="Boolean(refreshing[selectedScreen.screenId])"
              :scope="results.summaries?.screens?.[selectedScreen.screenId] ?? null"
              :screen-titles="screenTitles"
              :subject="selectedScreen.title"
              @refresh="refreshSummary(selectedScreen.screenId)"
            />
          </section>
        </div>

        <RoundPreferences
          :can-accept="abilities.acceptPreferences"
          :can-ask="abilities.publishRounds"
          :closed="!isOpen"
          :error="proposedError"
          :items="roundProposals"
          :loaded="proposedLoaded"
          :next-number="nextNumber"
          :round="summary"
          :track="track"
          @accept="openAccept"
          @retry="loadProposed"
        />

        <div class="rq-round-grid">
          <RoundReviewers
            :can-manage="abilities.manageRounds"
            :open="isOpen"
            :resending="resending"
            :reviewers="reviewers"
            :roles="roles"
            @resend="resend"
          />
          <div class="rq-stack">
            <section class="rq-panel rq-stack" aria-labelledby="rq-round-summary-heading">
              <RoundSummary
                :can-refresh="abilities.refreshSummary"
                :feedback-location="annotationsLocation"
                heading-id="rq-round-summary-heading"
                :people="people"
                :refresh-result="refreshResults.round"
                :refreshing="Boolean(refreshing.round)"
                :scope="results.summaries?.round ?? null"
                :screen-titles="screenTitles"
                show-screen
                :subject="`Round ${summary.number}`"
                @refresh="refreshSummary('')"
              />
            </section>
            <RoundQuestions :project-id="projectId" :rows="questions" />
          </div>
        </div>
      </template>
    </template>

    <RoundCloseDialog
      :directions="directionOptions"
      :open="closeOpen"
      :project-id="projectId"
      :round="summary"
      @close="closeOpen = false"
      @closed="handleClosed"
      @stale="load({ passive: true })"
    />
    <RoundEditDialog
      :candidates="candidates"
      :open="editOpen"
      :project-id="projectId"
      :roles="roles"
      :round="detail"
      @close="editOpen = false"
      @saved="handleSaved"
    />
    <RoundRemindDialog
      :open="remindOpen"
      :project-id="projectId"
      :reviewers="notSubmitted"
      :round-id="roundId"
      :round-number="summary?.number ?? null"
      @close="remindOpen = false"
      @done="handleReminded"
    />
    <RequirementsPreferenceAcceptDialog
      :focus="accept.focus"
      :item="accept.item"
      :open="accept.open"
      :project-id="projectId"
      :track="track"
      @accepted="handleAccepted"
      @close="accept = { ...accept, open: false }"
    />
  </article>
</template>
