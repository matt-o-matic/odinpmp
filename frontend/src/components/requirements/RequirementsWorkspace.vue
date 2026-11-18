<script setup>
import { computed, nextTick, onBeforeUnmount, provide, ref, shallowRef, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';

import { apiClient, authSession } from '../../lib/auth/index.js';
import { REQUIREMENTS_CONTEXT } from '../../lib/requirements/requirements-context.js';
import { describeRequirementsError } from '../../lib/requirements/requirements-errors.js';
import { batchNeedsSharedRefresh, createRequirementsLiveUpdates } from '../../lib/requirements/requirements-live-updates.js';
import { myItemsBadgeCount } from '../../lib/requirements/requirements-my-items.js';
import { requirementsAbilities, workspaceMembers } from '../../lib/requirements/requirements-permissions.js';
import { REQUIREMENTS_TRACKS, normalizeStage, trackIcon, trackLabel } from '../../lib/requirements/requirements-tracks.js';
import { focusForNow } from '../../lib/ui/focus-origin.js';

const props = defineProps({
  project: { required: true, type: Object },
  stakeholders: { default: () => [], type: Array },
  validUsers: { default: () => [], type: Array },
});

const emit = defineEmits(['counts']);

const route = useRoute();
const root = ref(null);
const overview = ref(null);
const overviewError = ref('');
const myItems = ref(null);
const myItemsError = ref('');
const myItemsLoading = ref(false);
const liveBatch = shallowRef(null);
const flash = ref({ message: '', tone: 'success' });

const projectId = computed(() => String(props.project?.id ?? ''));
const canDecide = computed(() => Boolean(overview.value?.canDecide ?? myItems.value?.canDecide ?? false));
// The overview and My open items carry the server's view of what this caller may do.
const serverAbilities = computed(() => overview.value ?? myItems.value ?? null);
const abilities = computed(() => requirementsAbilities({
  canCollaborate: serverAbilities.value?.canCollaborate ?? null,
  canDecide: canDecide.value,
  canEditPlans: serverAbilities.value?.canEditPlans ?? null,
  projectRole: props.project?.role || serverAbilities.value?.projectRole || '',
  tenantRole: authSession.state.currentUser?.role ?? '',
}));
const badgeCount = computed(() => myItemsBadgeCount(myItems.value));

const activeTab = computed(() => {
  if (route.name === 'project-requirements-track') return String(route.params.track ?? '');
  if (route.name === 'project-requirements') return 'mine';
  if (route.name === 'project-requirements-review') return 'review';
  return '';
});
const showTabs = computed(() => ['project-requirements', 'project-requirements-review', 'project-requirements-track'].includes(String(route.name ?? '')));
// The Review tab shows whether a round is open, so it is one glance from any tab.
const openRound = computed(() => (overview.value?.review?.latestRound?.status === 'open' ? overview.value.review.latestRound : null));
const currentStage = computed(() => (route.name === 'project-requirements-track' ? normalizeStage(route.params.stage) : undefined));

function token() {
  return authSession.state.token;
}

let overviewSequence = 0;
async function refreshOverview({ passive = true } = {}) {
  if (!projectId.value || !token()) return;
  const sequence = ++overviewSequence;
  const client = passive ? apiClient.passive : apiClient;
  try {
    const result = await client.getRequirementsOverview(projectId.value, token());
    if (sequence !== overviewSequence) return;
    overview.value = result;
    overviewError.value = '';
  } catch (error) {
    if (sequence !== overviewSequence) return;
    overviewError.value = describeRequirementsError(error, 'Unable to load the requirements overview.').message;
  }
}

let myItemsSequence = 0;
async function refreshMyItems({ passive = true } = {}) {
  if (!projectId.value || !token()) return;
  const sequence = ++myItemsSequence;
  const client = passive ? apiClient.passive : apiClient;
  myItemsLoading.value = myItems.value == null;
  try {
    const result = await client.getRequirementsMyItems(projectId.value, token());
    if (sequence !== myItemsSequence) return;
    myItems.value = result;
    myItemsError.value = '';
    emit('counts', result);
  } catch (error) {
    if (sequence !== myItemsSequence) return;
    myItemsError.value = describeRequirementsError(error, 'Unable to load your open items.').message;
  } finally {
    if (sequence === myItemsSequence) myItemsLoading.value = false;
  }
}

function refreshShared() {
  return Promise.all([refreshOverview(), refreshMyItems()]);
}

// `survivesNavigation` keeps a message through the next route change, for actions that
// end by moving somewhere else (deleting a topic returns to the register).
function showMessage(message, tone = 'success', { survivesNavigation = false } = {}) {
  flash.value = { message: String(message ?? ''), survivesNavigation, tone };
}

function clearMessage() {
  flash.value = { message: '', survivesNavigation: false, tone: flash.value.tone };
}

let liveVersion = 0;
let stopLiveUpdates = null;

watch(
  () => [projectId.value, authSession.state.token ?? ''],
  ([id, sessionToken]) => {
    stopLiveUpdates?.();
    stopLiveUpdates = null;
    overview.value = null;
    myItems.value = null;
    if (!id || !sessionToken) return;
    refreshOverview({ passive: false });
    refreshMyItems({ passive: false });
    stopLiveUpdates = createRequirementsLiveUpdates({
      apiClient,
      getToken: token,
      onChange(batch) {
        liveVersion += 1;
        liveBatch.value = { ...batch, version: liveVersion };
        // Annotation saves and verdicts arrive often during a review and change neither the
        // overview nor My open items; submissions come as rounds events, which still reload.
        if (batchNeedsSharedRefresh(batch)) refreshShared();
      },
      projectId: id,
    });
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  stopLiveUpdates?.();
  stopLiveUpdates = null;
});

// Route changes inside the workspace replace the view under the tabs. When the element
// that had focus went away with the old view, move focus to the new view's heading so
// keyboard and screen-reader users land at the start of what changed.
watch(
  () => route.fullPath,
  async (next, previous) => {
    if (!previous || typeof document === 'undefined') return;
    if (flash.value.survivesNavigation) flash.value = { ...flash.value, survivesNavigation: false };
    else clearMessage();
    const before = document.activeElement;
    await nextTick();
    await nextTick();
    const active = document.activeElement;
    // Safari leaves focus on this section after a press, which says no more than the body does.
    const lost = !active || active === document.body || active === root.value || (before && !document.contains(before));
    if (!lost) return;
    const heading = root.value?.querySelector('[data-rq-focus]');
    if (heading) heading.focus({ preventScroll: false });
    else focusForNow(root.value, { preventScroll: false });
  },
);

provide(REQUIREMENTS_CONTEXT, {
  abilities,
  canDecide,
  clearMessage,
  liveBatch,
  myItems,
  myItemsError,
  myItemsLoading,
  overview,
  overviewError,
  project: computed(() => props.project),
  projectId,
  refreshMyItems,
  refreshOverview,
  refreshShared,
  showMessage,
  stakeholders: computed(() => props.stakeholders ?? []),
  token,
  validUsers: computed(() => workspaceMembers({ overview: overview.value, validUsers: props.validUsers })),
});

function trackLocation(track) {
  return {
    name: 'project-requirements-track',
    params: { projectId: projectId.value, stage: currentStage.value, track },
  };
}
</script>

<template>
  <section ref="root" class="rq-workspace" aria-label="Requirements">
    <div v-if="showTabs" class="rq-reqtabs">
      <nav class="rq-reqtabs__nav" aria-label="Requirements views">
        <RouterLink
          class="rq-reqtab"
          :class="{ 'rq-reqtab--on': activeTab === 'mine' }"
          :aria-current="activeTab === 'mine' ? 'page' : undefined"
          :to="{ name: 'project-requirements', params: { projectId } }"
        >
          My open items
          <span v-if="badgeCount > 0" class="rq-count" aria-hidden="true">{{ badgeCount }}</span>
          <span v-if="badgeCount > 0" class="visually-hidden">, {{ badgeCount }} waiting on you</span>
        </RouterLink>
        <RouterLink
          class="rq-reqtab"
          :class="{ 'rq-reqtab--on': activeTab === 'review' }"
          :aria-current="activeTab === 'review' ? 'page' : undefined"
          :to="{ name: 'project-requirements-review', params: { projectId } }"
        >
          <i class="bi bi-easel" aria-hidden="true"></i>
          Review
          <span v-if="openRound" class="rq-chip rq-chip--exp rq-reqtab__chip">Round {{ openRound.number }} open</span>
        </RouterLink>
        <RouterLink
          v-for="track in REQUIREMENTS_TRACKS"
          :key="track"
          class="rq-reqtab"
          :class="{ 'rq-reqtab--on': activeTab === track }"
          :aria-current="activeTab === track ? 'page' : undefined"
          :to="trackLocation(track)"
        >
          <i class="bi" :class="trackIcon(track)" aria-hidden="true"></i>
          {{ trackLabel(track) }}
        </RouterLink>
      </nav>
      <div v-if="abilities.manageLinks" class="rq-reqtabs__actions">
        <RouterLink class="ghost-button ghost-button--compact" :to="{ name: 'project-requirements-links', params: { projectId } }">
          <i class="bi bi-link-45deg" aria-hidden="true"></i>
          Stakeholder links
        </RouterLink>
      </div>
    </div>

    <div role="status" aria-live="polite" class="rq-status">
      <div v-if="flash.message && flash.tone !== 'error'" class="success-banner rq-row rq-row--between">
        <span>{{ flash.message }}</span>
        <button class="rq-dialog__close" type="button" aria-label="Dismiss message" @click="clearMessage">
          <i class="bi bi-x-lg" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <div v-if="flash.message && flash.tone === 'error'" class="error-banner rq-row rq-row--between" role="alert">
      <span>{{ flash.message }}</span>
      <button class="rq-dialog__close" type="button" aria-label="Dismiss message" @click="clearMessage">
        <i class="bi bi-x-lg" aria-hidden="true"></i>
      </button>
    </div>

    <RouterView />
  </section>
</template>
