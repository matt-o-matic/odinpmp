<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import RequirementsAvatar from '../../components/requirements/RequirementsAvatar.vue';
import ReviewAnnotationThread from '../../components/requirements/review/ReviewAnnotationThread.vue';
import ReviewSessionProvider from '../../components/requirements/review/ReviewSessionProvider.vue';
import MarkLightbox from '../../components/requirements/rounds/MarkLightbox.vue';
import MarkPreview from '../../components/requirements/rounds/MarkPreview.vue';
import RoundMarkComments from '../../components/requirements/rounds/RoundMarkComments.vue';
import RoundViewTabs from '../../components/requirements/rounds/RoundViewTabs.vue';
import '../../components/requirements/rounds/rounds.css';
import { apiClient } from '../../lib/auth/index.js';
import { useRequirementsWorkspace } from '../../lib/requirements/requirements-context.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { batchTouchesRound } from '../../lib/requirements/requirements-live-updates.js';
import { feedbackTarget, groupRoundFeedback, markExcerpt, markPeople, markSurface, roundFeedbackPeople, verdictMeta } from '../../lib/requirements/requirements-rounds.js';
import { formatDateTime, formatShortDate } from '../../lib/requirements/requirements-time.js';
import { plural, reviewLocation } from '../../lib/requirements/requirements-tracks.js';
import { createReviewAdapter, createTeamReviewFeed, reviewScope } from '../../lib/requirements/review-adapters.js';
import { annotationStatusLabel, personColor, toCanvasMark } from '../../lib/requirements/review-annotations.js';
import { useMediaQuery } from '../../lib/requirements/review-viewport.js';

// Every mark in a round with its discussion, and each reviewer's written screen notes. The
// list summarizes each mark (its first words, who posted it, and everyone in its thread or
// tagged there); the selected mark opens beside it on the picture it was made on, with its
// thread. Members who can collaborate reply, tag, and resolve there through the same review
// session the guided review uses; the round's Odin summaries cover those comments too. The
// round's tabs, and "Open in your review", go back and forth with the guided review on the
// same mark. Addresses: #mark-<id>, and #comment-<id> from summary citations.
const route = useRoute();
const router = useRouter();
const workspace = useRequirementsWorkspace();
const wide = useMediaQuery('(min-width: 64rem)');

const data = ref(null);
const loading = ref(true);
const loadError = ref('');
const notFound = ref(false);
const query = ref('');
const screenId = ref('');
const reviewer = ref('');
const showResolved = ref(false);
const selectedId = ref('');
const highlightedComment = ref('');
const lightboxOpen = ref(false);
// Snapshot path -> { status: 'loading' | 'ready' | 'failed', url, width, height }.
const snapshots = reactive(new Map());

const projectId = computed(() => workspace.projectId.value);
const roundId = computed(() => String(route.params.roundId ?? ''));
const round = computed(() => data.value?.round ?? null);
const roundLocation = computed(() => ({ name: 'project-requirements-round', params: { projectId: projectId.value, roundId: roundId.value } }));
const canComment = computed(() => Boolean(workspace.abilities.value?.comment));
const people = computed(() => roundFeedbackPeople(data.value ?? {}));
const view = computed(() => groupRoundFeedback(data.value ?? {}, { query: query.value, reviewer: reviewer.value, screenId: screenId.value, showResolved: showResolved.value }));
const total = computed(() => groupRoundFeedback(data.value ?? {}, { showResolved: true }).counts);
const filtered = computed(() => Boolean(query.value.trim() || screenId.value || reviewer.value));
const summaryLine = computed(() => [plural(total.value.marks, 'mark'), plural(total.value.comments, 'comment'), plural(total.value.notes, 'written note')].join(' · '));
const screensById = computed(() => new Map((data.value?.screens ?? []).map((screen) => [screen.screenId, screen])));
const categoryLabels = computed(() => Object.fromEntries((data.value?.annotations ?? []).filter((annotation) => annotation.category).map((annotation) => [annotation.category, annotation.categoryLabel])));
const shownMarks = computed(() => view.value.groups.flatMap((group) => group.annotations));
const selected = computed(() => (data.value?.annotations ?? []).find((annotation) => annotation.id === selectedId.value) ?? null);
const selectedIndex = computed(() => shownMarks.value.findIndex((annotation) => annotation.id === selectedId.value));
const previousMark = computed(() => (selectedIndex.value > 0 ? shownMarks.value[selectedIndex.value - 1] : null));
const nextMark = computed(() => (selectedIndex.value >= 0 ? shownMarks.value[selectedIndex.value + 1] ?? null : shownMarks.value[0] ?? null));
const selectedScreen = computed(() => (selected.value ? screensById.value.get(selected.value.screenId) ?? null : null));
const selectedPeople = computed(() => markPeople(selected.value ?? {}));
const commentLabels = computed(() => Object.fromEntries((selected.value?.thread ?? []).filter((comment) => comment.label).map((comment) => [comment.id, comment.label])));
const selectedTitle = computed(() => (selected.value ? `Mark ${selected.value.number} · ${selectedScreen.value?.title ?? 'Screen'}${selected.value.stateLabel ? ` · ${selected.value.stateLabel}` : ''}` : ''));
// The picture the selected mark sits on, and the mark drawn to its scale.
const surface = computed(() => {
  const mark = selected.value;
  if (!mark) return null;
  const base = markSurface(mark, selectedScreen.value);
  if (base.kind === 'image') return { height: base.height, imageUrl: base.url, loading: false, width: base.width };
  if (base.kind === 'blank') return { height: base.height, imageUrl: '', loading: false, width: base.width };
  const viewport = markSurface({}, selectedScreen.value);
  const loaded = snapshots.get(base.path);
  if (loaded?.status === 'ready') return { height: loaded.height, imageUrl: loaded.url, loading: false, width: loaded.width };
  return { height: viewport.height, imageUrl: '', loading: loaded?.status !== 'failed', width: viewport.width };
});
const previewMarks = computed(() => (selected.value && surface.value ? [toCanvasMark(selected.value, { bounds: surface.value, readOnly: true })] : []));
const reviewMarkLocation = computed(() => (selected.value
  ? { name: 'project-requirements-round-review', params: { projectId: projectId.value, roundId: roundId.value }, query: { mark: selected.value.id } }
  : null));
const showList = computed(() => wide.value || !selected.value);
const showDetail = computed(() => wide.value || Boolean(selected.value));
const sessionKey = computed(() => `${projectId.value}:${roundId.value}:${sessionAdapter.value ? 'session' : 'read-only'}`);

// Replies, tags, and status changes go through a team review session for this round.
const sessionAdapter = shallowRef(null);
let feed = null;

watch([projectId, roundId, canComment], ([project, roundValue, allowed]) => {
  feed?.stop();
  feed = null;
  sessionAdapter.value = null;
  if (!project || !roundValue || !allowed) return;
  feed = createTeamReviewFeed({ apiClient, getToken: workspace.token, projectId: project });
  sessionAdapter.value = createReviewAdapter({ apiClient, getToken: workspace.token, liveFeed: feed, scope: reviewScope({ projectId: project, roundId: roundValue }) });
}, { immediate: true });

let sequence = 0;
async function load({ passive = false } = {}) {
  if (!projectId.value || !roundId.value) return;
  const current = ++sequence;
  if (!passive) loading.value = true;
  try {
    const result = await apiClient.passive.getRequirementsRoundAnnotations(projectId.value, roundId.value, workspace.token());
    if (current !== sequence) return;
    // Keep each image screen's first address, so a refetch's new grant doesn't reload the picture.
    const known = new Map((data.value?.screens ?? []).map((screen) => [screen.screenId, screen.imageUrl]));
    result.screens = (result.screens ?? []).map((screen) => ({ ...screen, imageUrl: known.get(screen.screenId) || screen.imageUrl }));
    data.value = result;
    loadError.value = '';
    notFound.value = false;
  } catch (error) {
    if (current !== sequence) return;
    if (error?.status === 404) notFound.value = true;
    else loadError.value = describeRequirementsError(error, 'Unable to load the marks and comments.').message;
  } finally {
    if (current === sequence) loading.value = false;
  }
}

function measure(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ height: image.naturalHeight, width: image.naturalWidth });
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

async function loadSnapshot(path) {
  if (!path || snapshots.has(path)) return;
  snapshots.set(path, { status: 'loading' });
  try {
    const result = await apiClient.passive.getRequirementsReviewSnapshot(path, workspace.token());
    const url = URL.createObjectURL(result.blob);
    const size = await measure(url);
    snapshots.set(path, size ? { height: size.height, status: 'ready', url, width: size.width } : { status: 'failed' });
  } catch {
    snapshots.set(path, { status: 'failed' });
  }
}

function forgetSnapshots() {
  for (const entry of snapshots.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  snapshots.clear();
}

watch([projectId, roundId], () => {
  data.value = null;
  selectedId.value = '';
  forgetSnapshots();
  load();
}, { immediate: true });

watch(workspace.liveBatch, (batch) => {
  if (data.value && batchTouchesRound(batch, roundId.value)) load({ passive: true });
});

watch(selected, (mark) => {
  if (mark?.snapshotUrl) loadSnapshot(mark.snapshotUrl);
}, { immediate: true });

onBeforeUnmount(() => {
  feed?.stop();
  feed = null;
  forgetSnapshots();
});

// The address picks the mark (and a cited comment); a closed mark shows the resolved ones too.
watch(
  () => [route.hash, Boolean(data.value)],
  async ([hash, ready]) => {
    if (!ready) return;
    const target = feedbackTarget(data.value, hash);
    if (!target.markId) {
      highlightedComment.value = '';
      if (hash) selectedId.value = '';
      return;
    }
    const mark = data.value.annotations.find((annotation) => annotation.id === target.markId);
    if (['resolved', 'superseded', 'outdated'].includes(mark?.status)) showResolved.value = true;
    selectedId.value = target.markId;
    highlightedComment.value = target.commentId;
    await nextTick();
    if (typeof document === 'undefined') return;
    document.getElementById(`mark-${target.markId}`)?.scrollIntoView({ block: 'nearest' });
    if (target.commentId) focusComment(target.commentId);
  },
  { immediate: true },
);

// On a wide screen something is always open: the first mark shown, until one is picked.
watch([wide, shownMarks], () => {
  if (wide.value && !selected.value && !route.hash && shownMarks.value.length) selectedId.value = shownMarks.value[0].id;
}, { immediate: true });

// The session's thread renders a moment after the mark opens; wait for the cited comment.
async function focusComment(commentId, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const element = document.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`) ?? document.getElementById(`comment-${commentId}`);
    if (element) {
      element.scrollIntoView({ block: 'center' });
      element.focus({ preventScroll: true });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function select(id) {
  if (!id) return;
  router.replace({ hash: `#mark-${id}` });
  if (!wide.value) nextTick(() => document.getElementById('rq-markdetail-title')?.focus());
}

function backToList() {
  const id = selectedId.value;
  router.replace({ hash: '' });
  selectedId.value = '';
  nextTick(() => document.getElementById(`mark-${id}`)?.focus());
}

function clearFilters() {
  query.value = '';
  screenId.value = '';
  reviewer.value = '';
}

function markMeta(annotation) {
  const parts = [annotation.authorName];
  const screen = screensById.value.get(annotation.screenId);
  if (annotation.stateLabel) parts.push(annotation.stateLabel);
  else if (screen?.kind === 'prototype') parts.push(screen.title);
  if (annotation.thread.length) parts.push(plural(annotation.thread.length, 'comment'));
  if (annotation.lastActivityAt) parts.push(formatShortDate(annotation.lastActivityAt));
  return parts.join(' · ');
}

function rowPeople(annotation) {
  const everyone = markPeople(annotation).people;
  return { more: Math.max(0, everyone.length - 4), shown: everyone.slice(0, 4) };
}

// "Mark 2 by Alex Kim: The price range gets lost. Involves Alex Kim, Ravi Shah."
function rowLabel(annotation) {
  const involved = markPeople(annotation).people.map((person) => person.name);
  const excerpt = markExcerpt(annotation);
  const opening = `Mark ${annotation.number} by ${annotation.authorName}${excerpt ? `: ${excerpt}` : ''}`;
  const parts = [/[.!?…”"]$/.test(opening) ? opening : `${opening}.`];
  if (involved.length > 1) parts.push(`Involves ${involved.join(', ')}.`);
  return parts.join(' ');
}

function sessionMark(session) {
  return session?.state.loaded ? session.findAnnotation(selectedId.value) : null;
}
</script>

<template>
  <article class="rq-stack rq-round rq-marks" aria-labelledby="rq-feedback-title">
    <nav class="rq-breadcrumb" aria-label="Breadcrumb">
      <ol>
        <li><RouterLink :to="{ name: 'project-requirements', params: { projectId } }">Requirements</RouterLink></li>
        <li><RouterLink :to="reviewLocation(projectId)">Review</RouterLink></li>
        <li><RouterLink :to="roundLocation">{{ round ? `Round ${round.number}` : 'Round' }}</RouterLink></li>
        <li aria-current="page">Marks and comments</li>
      </ol>
    </nav>

    <div v-if="notFound" class="rq-empty">
      <h2 id="rq-feedback-title" class="rq-title rq-title--md" tabindex="-1" data-rq-focus>This round doesn’t exist</h2>
      <p class="rq-small">It may belong to another project. The project's rounds are listed on the Review tab.</p>
      <RouterLink class="ghost-button ghost-button--compact" :to="reviewLocation(projectId)">Back to Review</RouterLink>
    </div>

    <template v-else>
      <header class="rq-stack rq-stack--sm">
        <h2 id="rq-feedback-title" class="rq-title rq-title--lg" tabindex="-1" data-rq-focus>
          {{ round ? `Round ${round.number} · Marks and comments` : 'Marks and comments' }}
        </h2>
        <p v-if="data" class="rq-small rq-muted mb-0">{{ summaryLine }}</p>
      </header>

      <RoundViewTabs current="marks" :mark-id="selectedId" :marks="data ? total.marks : null" :project-id="projectId" :review="canComment" :round-id="roundId" />

      <div v-if="loadError" class="error-banner rq-row rq-row--between" role="alert">
        <span>{{ loadError }}</span>
        <button class="ghost-button ghost-button--compact" type="button" @click="load()">Try again</button>
      </div>

      <p v-if="loading && !data" class="rq-small rq-muted mb-0">Loading marks and comments…</p>

      <template v-else-if="data">
        <div v-if="showList" class="rq-regbar" role="group" aria-label="Filter marks and comments">
          <label class="visually-hidden" for="rq-feedback-search">Filter by text</label>
          <input id="rq-feedback-search" v-model="query" class="form-control form-control-sm rq-feedback__search" placeholder="Filter by text…" type="search" />
          <label class="visually-hidden" for="rq-feedback-screen">Screen</label>
          <select id="rq-feedback-screen" v-model="screenId" class="form-select form-select-sm rq-feedback__select">
            <option value="">All screens</option>
            <option v-for="screen in data.screens" :key="screen.screenId" :value="screen.screenId">{{ screen.title }}</option>
          </select>
          <label class="visually-hidden" for="rq-feedback-reviewer">Reviewer</label>
          <select id="rq-feedback-reviewer" v-model="reviewer" class="form-select form-select-sm rq-feedback__select">
            <option value="">Everyone</option>
            <option v-for="person in people" :key="person.ref" :value="person.ref">{{ person.name }}</option>
          </select>
          <label class="rq-feedback__toggle">
            <input v-model="showResolved" class="form-check-input mt-0" type="checkbox" />
            <span>Show resolved</span>
          </label>
          <span class="rq-grow"></span>
          <button v-if="filtered" class="rq-text-action" type="button" @click="clearFilters">Clear filters</button>
        </div>

        <p v-if="total.marks + total.notes === 0" class="rq-small rq-muted mb-0">No marks, comments, or written notes in this round yet.</p>

        <ReviewSessionProvider v-else :key="sessionKey" v-slot="{ session }" :adapter="sessionAdapter">
          <div class="rq-marks__layout" :class="{ 'rq-marks__layout--wide': wide }">
            <div v-if="showList" class="rq-marks__list">
              <p v-if="view.groups.length === 0" class="rq-small rq-muted mb-0" role="status">Nothing matches these filters.</p>
              <section v-for="group in view.groups" :key="group.screenId" class="rq-stack rq-stack--sm" :aria-labelledby="`rq-feedback-screen-${group.screenId}`">
                <div class="rq-row rq-row--between rq-row--wrap">
                  <h3 :id="`rq-feedback-screen-${group.screenId}`" class="rq-title rq-title--sm mb-0">{{ group.title }}</h3>
                  <span class="rq-xs rq-muted">{{ [group.annotations.length ? plural(group.annotations.length, 'mark') : '', group.notes.length ? plural(group.notes.length, 'written note') : ''].filter(Boolean).join(' · ') }}</span>
                </div>

                <ol v-if="group.annotations.length" class="rq-markrows">
                  <li v-for="annotation in group.annotations" :key="annotation.id">
                    <button
                      :id="`mark-${annotation.id}`"
                      class="rq-markrow"
                      :class="{ 'rq-markrow--on': annotation.id === selectedId }"
                      type="button"
                      :aria-current="annotation.id === selectedId ? 'true' : undefined"
                      :aria-label="rowLabel(annotation)"
                      @click="select(annotation.id)"
                    >
                      <span class="rq-feedback__pin" :style="{ '--pin-color': annotation.color || personColor(annotation.authorRef) }" aria-hidden="true">{{ annotation.number }}</span>
                      <span class="rq-markrow__main">
                        <span class="rq-markrow__text" :class="{ 'rq-markrow__text--empty': !markExcerpt(annotation) }">{{ markExcerpt(annotation) || 'No comments yet' }}</span>
                        <span class="rq-markrow__meta">{{ markMeta(annotation) }}</span>
                      </span>
                      <span class="rq-markrow__side">
                        <span class="rq-avatars" aria-hidden="true">
                          <RequirementsAvatar v-for="person in rowPeople(annotation).shown" :key="person.ref" :person="person" />
                          <span v-if="rowPeople(annotation).more" class="rq-avatar rq-avatar--sm rq-avatar--more">+{{ rowPeople(annotation).more }}</span>
                        </span>
                        <span v-if="annotationStatusLabel(annotation.status)" class="rq-chip rq-chip--outline">{{ annotationStatusLabel(annotation.status) }}</span>
                      </span>
                    </button>
                  </li>
                </ol>

                <div v-if="group.notes.length" class="rq-stack rq-stack--sm">
                  <h4 class="rq-feedback__subhead">Written notes</h4>
                  <ul class="rq-feedback__notes">
                    <li v-for="note in group.notes" :key="`${note.actorRef}-${note.screenId}`" class="rq-thread-comment">
                      <div class="rq-comment__meta">
                        <strong>{{ note.name }}</strong>
                        <span class="rq-chip rq-chip--outline">{{ verdictMeta(note.overall).label }}</span>
                      </div>
                      <dl class="rq-feedback__note mb-0">
                        <template v-if="note.stay"><dt>Should stay</dt><dd>{{ note.stay }}</dd></template>
                        <template v-if="note.change"><dt>Should change</dt><dd>{{ note.change }}</dd></template>
                        <template v-if="note.mixed"><dt>Mixed feelings</dt><dd>{{ note.mixed }}</dd></template>
                      </dl>
                    </li>
                  </ul>
                </div>
              </section>
            </div>

            <section v-if="showDetail" class="rq-markdetail" aria-labelledby="rq-markdetail-title">
              <template v-if="selected">
                <header class="rq-markdetail__head">
                  <button v-if="!wide" class="rq-text-action rq-markdetail__back" type="button" @click="backToList">
                    <i class="bi bi-arrow-left" aria-hidden="true"></i>All marks
                  </button>
                  <div class="rq-row rq-row--tight rq-row--wrap">
                    <span class="rq-feedback__pin" :style="{ '--pin-color': selected.color || personColor(selected.authorRef) }" aria-hidden="true">{{ selected.number }}</span>
                    <h3 id="rq-markdetail-title" class="rq-title rq-title--sm mb-0" tabindex="-1">{{ selectedTitle }}</h3>
                    <span v-if="selected.categoryLabel" class="rq-chip rq-chip--outline">{{ selected.categoryLabel }}</span>
                    <span v-if="annotationStatusLabel(selected.status)" class="rq-chip rq-chip--outline">{{ annotationStatusLabel(selected.status) }}</span>
                  </div>
                  <div class="rq-row rq-row--tight rq-row--wrap rq-markdetail__actions">
                    <RouterLink v-if="canComment && reviewMarkLocation" class="primary-button primary-button--compact" :to="reviewMarkLocation">
                      <i class="bi bi-pencil-square" aria-hidden="true"></i>Open in your review
                    </RouterLink>
                    <span class="rq-grow"></span>
                    <span class="rq-row rq-row--tight" role="group" aria-label="Other marks">
                      <button class="ghost-button ghost-button--compact" type="button" :disabled="!previousMark" :aria-label="previousMark ? `Previous: mark ${previousMark.number}` : 'Previous mark'" @click="select(previousMark?.id)">
                        <i class="bi bi-chevron-up" aria-hidden="true"></i>Previous
                      </button>
                      <button class="ghost-button ghost-button--compact" type="button" :disabled="!nextMark || nextMark.id === selectedId" :aria-label="nextMark ? `Next: mark ${nextMark.number}` : 'Next mark'" @click="select(nextMark?.id)">
                        <i class="bi bi-chevron-down" aria-hidden="true"></i>Next
                      </button>
                    </span>
                  </div>
                </header>

                <div class="rq-markdetail__body">
                  <div class="rq-markdetail__visual rq-stack rq-stack--sm">
                    <MarkPreview
                      v-if="surface"
                      :active-id="selected.id"
                      :height="surface.height"
                      :image-url="surface.imageUrl"
                      :label="`Enlarge the picture of mark ${selected.number}`"
                      :loading="surface.loading"
                      :marks="previewMarks"
                      :width="surface.width"
                      @open="lightboxOpen = true"
                    />
                    <p v-if="selected.snapshotUnavailable" class="rq-xs rq-muted mb-0">The prototype’s snapshot failed when this mark was made, so it sits on a blank frame of the screen.</p>
                    <p v-if="selected.elementText" class="rq-xs rq-muted mb-0">On “{{ selected.elementText }}”</p>

                    <dl class="rq-markpeople">
                      <div v-if="selectedPeople.posted">
                        <dt>Posted by</dt>
                        <dd>
                          <span class="rq-markpeople__person"><RequirementsAvatar :person="selectedPeople.posted" />{{ selectedPeople.posted.name }}</span>
                          <time v-if="selected.createdAt" class="rq-xs rq-muted" :datetime="selected.createdAt">{{ formatDateTime(selected.createdAt) }}</time>
                        </dd>
                      </div>
                      <div v-if="selectedPeople.commented.length">
                        <dt>In the discussion</dt>
                        <dd>
                          <span v-for="person in selectedPeople.commented" :key="person.ref" class="rq-markpeople__person"><RequirementsAvatar :person="person" />{{ person.name }}</span>
                        </dd>
                      </div>
                      <div v-if="selectedPeople.tagged.length">
                        <dt>Tagged</dt>
                        <dd>
                          <span v-for="person in selectedPeople.tagged" :key="person.ref" class="rq-markpeople__person"><RequirementsAvatar :person="person" />{{ person.name }}</span>
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div class="rq-markdetail__thread">
                    <ReviewAnnotationThread
                      v-if="sessionMark(session)"
                      :annotation="sessionMark(session)"
                      :comment-labels="commentLabels"
                      :highlight-id="highlightedComment"
                      :number="selected.number"
                      variant="page"
                    />
                    <p v-else-if="session && !session.state.loaded && !session.state.loadError && !session.state.notFound" class="rq-xs rq-muted mb-0">Loading the discussion…</p>
                    <RoundMarkComments v-else :highlight-id="highlightedComment" :thread="selected.thread" />
                  </div>
                </div>

                <MarkLightbox
                  v-if="surface"
                  :active-id="selected.id"
                  :category-labels="categoryLabels"
                  :height="surface.height"
                  :image-alt="selectedTitle"
                  :image-url="surface.imageUrl"
                  :marks="previewMarks"
                  :open="lightboxOpen"
                  :title="selectedTitle"
                  :width="surface.width"
                  @close="lightboxOpen = false"
                />
              </template>
              <p v-else class="rq-small rq-muted mb-0 rq-markdetail__empty">Select a mark to see it on its screen, with its discussion.</p>
            </section>
          </div>
        </ReviewSessionProvider>
      </template>
    </template>
  </article>
</template>

<style scoped>
.rq-feedback__search {
  flex: 1 1 14rem;
  max-width: 24rem;
}

.rq-feedback__select {
  flex: 0 1 12rem;
  width: auto;
}

.rq-feedback__subhead {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.rq-feedback__toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-height: 2.75rem;
  font-size: 0.875rem;
}

.rq-feedback__notes,
.rq-markrows {
  display: grid;
  gap: 0.375rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rq-feedback__pin {
  display: inline-grid;
  flex: none;
  place-items: center;
  min-width: 1.5rem;
  height: 1.5rem;
  padding: 0 0.25rem;
  border-radius: 999px;
  background: var(--pin-color);
  color: #ffffff;
  font-size: 0.75rem;
  font-weight: 700;
}

.rq-feedback__note {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 0.75rem;
  font-size: 0.875rem;
}

.rq-feedback__note dt {
  color: var(--muted);
  font-weight: 600;
}

.rq-feedback__note dd {
  margin: 0;
}

.rq-marks__layout {
  display: grid;
  gap: 1rem;
}

.rq-marks__layout--wide {
  grid-template-columns: minmax(20rem, 26rem) minmax(0, 1fr);
  align-items: start;
}

.rq-marks__list {
  display: grid;
  gap: 1rem;
  min-width: 0;
}

.rq-marks__layout--wide .rq-marks__list {
  position: sticky;
  top: 0.75rem;
  max-height: calc(100vh - 1.5rem);
  overflow-y: auto;
  padding-right: 0.25rem;
}

.rq-markrow {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  width: 100%;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--surface);
  color: var(--ink);
  text-align: left;
}

.rq-markrow:hover {
  border-color: var(--line-strong);
  background: var(--surface-soft);
}

.rq-markrow--on,
.rq-markrow--on:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  box-shadow: inset 3px 0 0 var(--accent);
}

.rq-markrow:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 1px;
}

.rq-markrow__main {
  display: grid;
  flex: 1 1 auto;
  gap: 0.15rem;
  min-width: 0;
}

.rq-markrow__text {
  display: -webkit-box;
  overflow: hidden;
  font-size: 0.875rem;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.rq-markrow__text--empty {
  color: var(--muted);
  font-style: italic;
}

.rq-markrow__meta {
  overflow: hidden;
  color: var(--muted);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rq-markrow__side {
  display: grid;
  flex: none;
  justify-items: end;
  gap: 0.3rem;
}

.rq-markdetail {
  display: grid;
  gap: 0.85rem;
  min-width: 0;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  background: var(--surface);
  container-type: inline-size;
}

.rq-markdetail__head {
  display: grid;
  gap: 0.5rem;
}

.rq-markdetail__back {
  justify-self: start;
}

.rq-markdetail__head h3:focus {
  outline: none;
}

.rq-markdetail__actions {
  align-items: center;
}

.rq-markdetail__body {
  display: grid;
  gap: 1rem;
}

.rq-markdetail__thread {
  display: grid;
  align-content: start;
  gap: 0.5rem;
  min-width: 0;
}

.rq-markdetail__empty {
  padding: 2rem 1rem;
  text-align: center;
}

@container (min-width: 50rem) {
  .rq-markdetail__body {
    grid-template-columns: minmax(0, 1.15fr) minmax(18rem, 1fr);
    align-items: start;
  }

  .rq-markdetail__visual {
    position: sticky;
    top: 0.75rem;
  }
}

.rq-markpeople {
  display: grid;
  gap: 0.45rem;
  margin: 0;
  font-size: 0.82rem;
}

.rq-markpeople > div {
  display: grid;
  grid-template-columns: 7.5rem minmax(0, 1fr);
  gap: 0.5rem;
  align-items: baseline;
}

.rq-markpeople dt {
  color: var(--muted);
  font-weight: 600;
}

.rq-markpeople dd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.75rem;
  margin: 0;
}

.rq-markpeople__person {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

@media (max-width: 40rem) {
  .rq-feedback__search,
  .rq-feedback__select {
    flex: 1 1 100%;
    max-width: none;
  }

  .rq-feedback__note {
    grid-template-columns: 1fr;
  }

  .rq-markdetail {
    padding: 0.75rem;
  }

  .rq-markpeople > div {
    grid-template-columns: 1fr;
    gap: 0.2rem;
  }
}
</style>
