<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import RequirementsConfirmDialog from '../../components/requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../../components/requirements/RequirementsDialog.vue';
import RequirementsMarkdown from '../../components/requirements/RequirementsMarkdown.vue';
import RequirementsMermaidFlow from '../../components/requirements/RequirementsMermaidFlow.vue';
import RequirementsPackageChanges from '../../components/requirements/RequirementsPackageChanges.vue';
import RequirementsPackageScreens from '../../components/requirements/RequirementsPackageScreens.vue';
import RequirementsPackageUpload from '../../components/requirements/RequirementsPackageUpload.vue';
import { apiClient } from '../../lib/auth/index.js';
import { useRequirementsWorkspace } from '../../lib/requirements/requirements-context.js';
import { describeRequirementsError, requirementsErrorCode } from '../../lib/requirements/requirements-errors.js';
import { batchTouchesPackage } from '../../lib/requirements/requirements-live-updates.js';
import { safeExternalUrl } from '../../lib/requirements/package-markdown.js';
import {
  feedbackDimensionLabels,
  manifestSections,
  packageChecklist,
  packageMetaLine,
  packageStatusChip,
  questionKindLabel,
  sectionOfType,
} from '../../lib/requirements/requirements-packages.js';
import { formatAgo, formatShortDate } from '../../lib/requirements/requirements-time.js';
import { chipToneClass } from '../../lib/requirements/requirements-topics.js';
import { REVIEW_TRACK, reviewLocation } from '../../lib/requirements/requirements-tracks.js';

// One review package, laid out the way reviewers will meet it: the summary, the checks
// Odin ran, what changed since the last version, then each manifest section in order.
// Drafts can be replaced, withdrawn, or published as a round here; a published package links
// to its round. Replacing uploads a zip that becomes the next draft version and withdraws this one.

const route = useRoute();
const router = useRouter();
const workspace = useRequirementsWorkspace();

const pkg = ref(null);
const loading = ref(true);
const loadError = ref('');
const notFound = ref(false);
const grant = ref(null);
const grantNote = ref('');
const withdrawOpen = ref(false);
const withdrawing = ref(false);
const withdrawError = ref('');
const replaceOpen = ref(false);
const replaceBusy = ref(false);
const screensView = ref(null);

const projectId = computed(() => workspace.projectId.value);
const packageId = computed(() => String(route.params.packageId ?? ''));
// Review is project-wide; the track only picks the default feedback dimensions.
const track = computed(() => pkg.value?.track ?? REVIEW_TRACK);
const abilities = computed(() => workspace.abilities.value);
const manifest = computed(() => pkg.value?.manifest ?? {});
const sections = computed(() => manifestSections(manifest.value));
const statusChip = computed(() => packageStatusChip(pkg.value?.status));
const checklist = computed(() => (pkg.value ? packageChecklist(pkg.value) : []));
const dimensions = computed(() => feedbackDimensionLabels(manifest.value, track.value));
const withdrawn = computed(() => pkg.value?.status === 'withdrawn');
const draftActions = computed(() => pkg.value?.status === 'draft'
  && (abilities.value.uploadPackages || abilities.value.withdrawPackages || abilities.value.publishRounds));
const entryUrls = computed(() => grant.value?.entryUrls ?? {});
const screenItems = computed(() => sectionOfType(manifest.value, 'screens')?.items ?? []);
const imageUrls = computed(() => Object.fromEntries(screenItems.value
  .filter((screen) => screen.kind === 'image' && entryUrls.value[screen.id])
  .map((screen) => [screen.id, entryUrls.value[screen.id]])));
const changeById = computed(() => Object.fromEntries((pkg.value?.changes?.screens ?? [])
  .filter((entry) => entry.change !== 'removed')
  .map((entry) => [entry.screenId, entry.change])));
const directionTitles = computed(() => Object.fromEntries((sectionOfType(manifest.value, 'directions')?.items ?? [])
  .map((direction) => [direction.id, direction.title])));
const screenTitles = computed(() => Object.fromEntries(screenItems.value.map((screen) => [screen.id, screen.title])));
const selectedScreenId = computed({
  get: () => {
    const requested = String(route.query.screen ?? '');
    return screenItems.value.some((screen) => screen.id === requested) ? requested : (screenItems.value[0]?.id ?? '');
  },
  set: (screenId) => {
    router.replace({ query: { ...route.query, screen: screenId || undefined } });
  },
});
const trackLocation = computed(() => reviewLocation(projectId.value));
const uploadedWhen = computed(() => (pkg.value?.createdAt ? formatAgo(pkg.value.createdAt) : ''));
// A published package is one round's package; its header links to that round's results.
const packageRound = ref(null);
const publishLocation = computed(() => ({
  name: 'project-requirements-round-publish',
  params: { packageId: packageId.value, projectId: projectId.value },
}));
const packageRoundLocation = computed(() => (packageRound.value
  ? { name: 'project-requirements-round', params: { projectId: projectId.value, roundId: packageRound.value.id } }
  : null));

let roundSequence = 0;
async function loadPackageRound() {
  const current = ++roundSequence;
  if (pkg.value?.status !== 'published') {
    packageRound.value = null;
    return;
  }
  try {
    const result = await apiClient.passive.listRequirementsRounds(projectId.value, '', token());
    if (current !== roundSequence) return;
    packageRound.value = (result.rounds ?? []).find((round) => round.packageId === pkg.value?.id) ?? null;
  } catch {
    // The link is a shortcut; the Review stage lists every round.
    if (current === roundSequence) packageRound.value = null;
  }
}

watch(() => [pkg.value?.id, pkg.value?.status], loadPackageRound);

function token() {
  return workspace.token();
}

let grantSequence = 0;
async function loadGrant() {
  const id = packageId.value;
  const current = ++grantSequence;
  grantNote.value = '';
  try {
    const result = await apiClient.passive.getRequirementsPackageGrant(projectId.value, id, token());
    if (current !== grantSequence) return;
    grant.value = result;
  } catch (error) {
    if (current !== grantSequence) return;
    grant.value = null;
    if (requirementsErrorCode(error) === 'review_origin_not_configured' || error?.status === 503) {
      grantNote.value = 'Screens can’t be shown because the review site isn’t set up on this server. An administrator sets REVIEW_PUBLIC_URL to turn it on. Everything else in the package is shown below.';
    } else if (error?.status === 404) {
      grantNote.value = 'This package’s files are no longer available.';
    } else {
      grantNote.value = describeRequirementsError(error, 'Screens couldn’t be loaded. Reload the page to try again.').message;
    }
  }
}

let loadSequence = 0;
async function load({ passive = false } = {}) {
  const id = packageId.value;
  if (!id || !projectId.value) return;
  const current = ++loadSequence;
  if (!passive) loading.value = true;
  const previousStatus = pkg.value?.status ?? '';
  try {
    const client = passive ? apiClient.passive : apiClient;
    const result = await client.getRequirementsPackage(projectId.value, id, token());
    if (current !== loadSequence) return;
    pkg.value = result.package ?? null;
    loadError.value = '';
    notFound.value = false;
    if (pkg.value?.status === 'withdrawn') {
      grantSequence += 1;
      grant.value = null;
      grantNote.value = 'This package was withdrawn, so its files were deleted.';
    } else if (!grant.value || previousStatus !== pkg.value?.status) {
      // A new grant changes every frame address and reloads prototypes, so keep the one we have.
      await loadGrant();
    }
  } catch (error) {
    if (current !== loadSequence) return;
    if (error?.status === 404) notFound.value = true;
    else loadError.value = describeRequirementsError(error, 'Unable to load this package.').message;
  } finally {
    if (current === loadSequence) loading.value = false;
  }
}

watch(
  packageId,
  () => {
    pkg.value = null;
    grant.value = null;
    grantNote.value = '';
    notFound.value = false;
    loadError.value = '';
    // A Replace dialog belongs to the package being left. Its upload control unmounts without
    // reporting that it is idle, so clear the busy flag here too.
    replaceOpen.value = false;
    replaceBusy.value = false;
    load();
  },
  { immediate: true },
);

watch(workspace.liveBatch, (batch) => {
  if (batchTouchesPackage(batch, packageId.value)) load({ passive: true });
});

async function showScreen(screenId) {
  await router.replace({ query: { ...route.query, screen: screenId || undefined } });
  await nextTick();
  // The screens view sits inside the sections loop, so its ref is an array.
  const view = Array.isArray(screensView.value) ? screensView.value[0] : screensView.value;
  view?.focusViewer();
}

async function confirmWithdraw() {
  if (withdrawing.value) return;
  withdrawing.value = true;
  withdrawError.value = '';
  try {
    const result = await apiClient.withdrawRequirementsPackage(projectId.value, packageId.value, token());
    pkg.value = result.package ?? { ...pkg.value, status: 'withdrawn' };
    grantSequence += 1;
    grant.value = null;
    grantNote.value = 'This package was withdrawn, so its files were deleted.';
    withdrawOpen.value = false;
    workspace.showMessage(`Version ${pkg.value.version} withdrawn.`);
    workspace.refreshShared();
    // Closing a modal dialog returns focus to its opener, which is gone now; wait for the
    // close, then put focus on the title.
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.getElementById('rq-package-title')?.focus();
  } catch (error) {
    withdrawError.value = error?.status === 409
      ? describeRequirementsError(error, 'This package can no longer be withdrawn.').message
      : describeRequirementsError(error, 'Unable to withdraw the package. Try again.').message;
    if (error?.status === 409) load({ passive: true });
  } finally {
    withdrawing.value = false;
  }
}

async function handleReplaced({ package: next, replaced }) {
  // The upload control unmounts with the dialog, so it may not report that it is idle again.
  replaceBusy.value = false;
  replaceOpen.value = false;
  workspace.showMessage(`Version ${next.version} replaced version ${replaced?.version ?? pkg.value?.version}.`, 'success', { survivesNavigation: true });
  workspace.refreshShared();
  await router.push({ name: 'project-requirements-package', params: { packageId: next.id, projectId: projectId.value } });
}

async function closeReplace() {
  if (replaceBusy.value) return;
  replaceOpen.value = false;
  // After a 409 the Replace button is gone, so the dialog cannot return focus to it.
  if (pkg.value?.status !== 'draft') {
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.getElementById('rq-package-title')?.focus();
  }
}

function topicLocation(topicId) {
  return { name: 'project-requirements-topic', params: { projectId: projectId.value, topicId } };
}
</script>

<template>
  <article class="rq-stack rq-package" aria-labelledby="rq-package-title">
    <nav class="rq-breadcrumb" aria-label="Breadcrumb">
      <ol>
        <li><RouterLink :to="{ name: 'project-requirements', params: { projectId } }">Requirements</RouterLink></li>
        <li><RouterLink :to="trackLocation">Review</RouterLink></li>
        <li aria-current="page">{{ pkg ? `Version ${pkg.version}` : 'Package' }}</li>
      </ol>
    </nav>

    <div v-if="notFound" class="rq-empty">
      <h2 id="rq-package-title" class="rq-title rq-title--md" tabindex="-1" data-rq-focus>This package doesn’t exist</h2>
      <p class="rq-small">It may belong to another project. The project's packages are listed on the Review tab.</p>
      <RouterLink class="ghost-button ghost-button--compact" :to="trackLocation">Back to Review</RouterLink>
    </div>

    <div v-else-if="loadError && !pkg" class="rq-stack">
      <h2 id="rq-package-title" class="visually-hidden" tabindex="-1" data-rq-focus>Package</h2>
      <div class="error-banner rq-row rq-row--between" role="alert">
        <span>{{ loadError }}</span>
        <button class="ghost-button ghost-button--compact" type="button" @click="load()">Try again</button>
      </div>
    </div>

    <template v-else>
      <header class="rq-topic-head">
        <div class="rq-topic-head__main">
          <div v-if="pkg" class="rq-row rq-row--tight rq-row--wrap">
            <span class="rq-chip" :class="chipToneClass(statusChip.tone)">{{ statusChip.label }}</span>
          </div>
          <h2 id="rq-package-title" class="rq-title rq-title--lg" tabindex="-1" data-rq-focus>
            {{ pkg ? `Version ${pkg.version} · ${pkg.title}` : 'Loading package…' }}
          </h2>
          <p v-if="pkg" class="rq-small rq-muted mb-0">
            Uploaded by {{ packageMetaLine(pkg) }}<template v-if="uploadedWhen"> · {{ uploadedWhen }}</template>
          </p>
        </div>
        <div v-if="pkg && (draftActions || packageRound)" class="rq-topic-head__actions">
          <RouterLink v-if="packageRound" class="ghost-button ghost-button--compact" :to="packageRoundLocation">
            <i class="bi bi-bar-chart" aria-hidden="true"></i>Round {{ packageRound.number }} results
          </RouterLink>
          <button
            v-if="pkg.status === 'draft' && abilities.uploadPackages"
            class="ghost-button ghost-button--compact"
            type="button"
            @click="replaceOpen = true"
          >
            <i class="bi bi-arrow-repeat" aria-hidden="true"></i>Replace
          </button>
          <button
            v-if="pkg.status === 'draft' && abilities.withdrawPackages"
            class="ghost-button ghost-button--compact ghost-button--danger"
            type="button"
            @click="withdrawError = ''; withdrawOpen = true"
          >
            <i class="bi bi-archive" aria-hidden="true"></i>Withdraw
          </button>
          <RouterLink v-if="pkg.status === 'draft' && abilities.publishRounds" class="primary-button primary-button--compact" :to="publishLocation">
            <i class="bi bi-send" aria-hidden="true"></i>Publish as a round
          </RouterLink>
        </div>
      </header>

      <p v-if="loading && !pkg" class="rq-small rq-muted mb-0">Loading the package…</p>

      <template v-if="pkg">
        <p v-if="withdrawn" class="rq-notice mb-0" role="note">
          <i class="bi bi-archive" aria-hidden="true"></i>
          Withdrawn<template v-if="pkg.updatedAt"> on {{ formatShortDate(pkg.updatedAt) }}</template>. Its files were deleted; the manifest text stays for the record.
        </p>

        <section v-if="manifest.summary" class="rq-panel rq-stack rq-stack--sm" aria-labelledby="rq-pkg-summary-heading">
          <h3 id="rq-pkg-summary-heading" class="rq-eyebrow">For reviewers</h3>
          <RequirementsMarkdown :source="manifest.summary" />
        </section>

        <div class="rq-package-grid">
          <section class="rq-panel rq-stack rq-stack--sm" aria-labelledby="rq-pkg-checks-heading">
            <div class="rq-row rq-row--between rq-row--wrap">
              <h3 id="rq-pkg-checks-heading" class="rq-eyebrow">Checks</h3>
              <span class="rq-chip rq-chip--ok"><i class="bi bi-check2" aria-hidden="true"></i>Valid · {{ statusChip.label.toLowerCase() }} v{{ pkg.version }}</span>
            </div>
            <ul class="rq-checks">
              <li v-for="(item, index) in checklist" :key="`${item.code}-${index}`" class="rq-check" :class="`rq-check--${item.tone}`">
                <i
                  class="bi"
                  :class="item.tone === 'warn' ? 'bi-exclamation-triangle-fill' : 'bi-check-circle-fill'"
                  aria-hidden="true"
                ></i>
                <span>
                  <span v-if="item.tone === 'warn'" class="visually-hidden">Warning: </span>{{ item.text }}
                  <span v-if="item.tone === 'warn'" class="rq-xs rq-muted d-block">
                    {{ item.meaning }}
                    <template v-if="item.location?.path"> At <code>{{ item.location.path }}</code>.</template>
                  </span>
                </span>
                <span class="rq-xs rq-muted">{{ item.tone === 'warn' ? 'warning' : '' }}</span>
              </li>
            </ul>
            <p v-if="dimensions.length" class="rq-xs rq-muted mb-0">Reviewers rate: {{ dimensions.join(', ') }}.</p>
          </section>

          <RequirementsPackageChanges :changes="pkg.changes" :image-urls="imageUrls" @select="showScreen" />
        </div>

        <section
          v-for="section in sections"
          :id="section.anchor"
          :key="section.id || section.type"
          class="rq-panel rq-stack"
          :aria-labelledby="`${section.anchor}-heading`"
        >
          <div class="rq-row rq-row--between rq-row--wrap">
            <h3 :id="`${section.anchor}-heading`" class="rq-eyebrow">{{ section.heading }}<template v-if="section.items.length"> · {{ section.items.length }}</template></h3>
          </div>

          <RequirementsMarkdown v-if="section.type === 'context' || section.type === 'boundaries'" :source="section.body" />

          <ul v-else-if="section.type === 'references'" class="rq-refs">
            <li v-for="(reference, index) in section.items" :key="`ref-${index}`" class="rq-ref">
              <div class="rq-row rq-row--between rq-row--wrap rq-row--top">
                <span>
                  <a v-if="safeExternalUrl(reference.url)" :href="safeExternalUrl(reference.url)" target="_blank" rel="noopener noreferrer">
                    {{ reference.title }}<span class="visually-hidden"> (opens in a new tab)</span>
                    <i class="bi bi-box-arrow-up-right ms-1" aria-hidden="true"></i>
                  </a>
                  <strong v-else>{{ reference.title }}</strong>
                  <span v-if="reference.creator" class="rq-xs rq-muted"> · {{ reference.creator }}</span>
                </span>
                <span class="rq-chip" :class="reference.inspected ? 'rq-chip--ok' : 'rq-chip--outline'">
                  {{ reference.inspected ? 'Opened by the author' : 'Not opened, from search results' }}
                </span>
              </div>
              <p class="rq-small mb-0"><span class="rq-muted">Borrow:</span> {{ reference.pattern }}</p>
              <p v-if="reference.appliesTo" class="rq-xs rq-muted mb-0">Applies to {{ reference.appliesTo }}</p>
            </li>
          </ul>

          <div v-else-if="section.type === 'directions'" class="rq-directions">
            <article v-for="direction in section.items" :key="direction.id" class="rq-direction" :aria-labelledby="`rq-direction-${direction.id}`">
              <h4 :id="`rq-direction-${direction.id}`" class="rq-title rq-title--sm">{{ direction.title }}</h4>
              <RequirementsMarkdown :source="direction.summary" />
              <template v-if="direction.tradeoffs">
                <p class="rq-eyebrow mb-0">Trade-offs</p>
                <RequirementsMarkdown :source="direction.tradeoffs" />
              </template>
              <div v-if="direction.screenIds?.length" class="rq-row rq-row--tight rq-row--wrap">
                <span class="rq-xs rq-muted">Screens:</span>
                <button
                  v-for="screenId in direction.screenIds"
                  :key="screenId"
                  class="rq-link-button rq-xs"
                  type="button"
                  @click="showScreen(screenId)"
                >{{ screenTitles[screenId] || screenId }}</button>
              </div>
            </article>
          </div>

          <RequirementsPackageScreens
            v-else-if="section.type === 'screens'"
            ref="screensView"
            v-model:selected-id="selectedScreenId"
            :change-by-id="changeById"
            :direction-titles="directionTitles"
            :entry-urls="entryUrls"
            :preview-note="grantNote"
            :screens="section.items"
          />

          <div v-else-if="section.type === 'flows'" class="rq-stack">
            <RequirementsMermaidFlow v-for="flow in section.items" :key="flow.id" :flow="flow" />
          </div>

          <ol v-else-if="section.type === 'questions'" class="rq-questions">
            <li v-for="question in section.items" :key="question.id" class="rq-question">
              <div class="rq-row rq-row--between rq-row--wrap rq-row--top">
                <p class="rq-small mb-0"><strong>{{ question.prompt }}</strong></p>
                <span class="rq-chip rq-chip--neutral">{{ questionKindLabel(question) }}</span>
              </div>
              <p v-if="question.help" class="rq-xs rq-muted mb-0">{{ question.help }}</p>
              <ul v-if="question.options?.length" class="rq-question__options">
                <li v-for="option in question.options" :key="option.id">{{ option.label }}</li>
              </ul>
              <p v-if="question.kind === 'scale' && question.scale && (question.scale.minLabel || question.scale.maxLabel)" class="rq-xs rq-muted mb-0">
                {{ question.scale.min }} = {{ question.scale.minLabel || 'lowest' }}, {{ question.scale.max }} = {{ question.scale.maxLabel || 'highest' }}
              </p>
              <p class="rq-xs rq-muted mb-0">
                <template v-if="question.topicId">
                  Answers go to <RouterLink :to="topicLocation(question.topicId)">its linked topic</RouterLink>.
                </template>
                <template v-else>Publishing the round creates a topic for this question.</template>
              </p>
            </li>
          </ol>
        </section>
      </template>
    </template>

    <RequirementsConfirmDialog
      :busy="withdrawing"
      confirm-label="Withdraw package"
      :error="withdrawError"
      :open="withdrawOpen"
      :title="pkg ? `Withdraw version ${pkg.version}?` : 'Withdraw this package?'"
      @close="withdrawOpen = false"
      @confirm="confirmWithdraw"
    >
      <p class="mb-0">Withdrawing deletes this draft’s files. Nobody can preview or publish it afterwards. To swap in a corrected zip instead, use Replace.</p>
    </RequirementsConfirmDialog>

    <RequirementsDialog
      :busy="replaceBusy"
      :open="replaceOpen"
      :title="pkg ? `Replace version ${pkg.version}` : 'Replace this package'"
      @close="closeReplace"
    >
      <RequirementsPackageUpload
        v-if="replaceOpen && pkg"
        :get-token="token"
        :project-id="projectId"
        :replaces="{ id: pkg.id, version: pkg.version }"
        :track="track"
        @busy="replaceBusy = $event"
        @reconcile="load({ passive: true })"
        @uploaded="handleReplaced"
      />
      <template #footer>
        <button class="ghost-button" type="button" :disabled="replaceBusy" @click="closeReplace">Cancel</button>
      </template>
    </RequirementsDialog>
  </article>
</template>
