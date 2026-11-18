<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import HomeBehindPanel from '../components/home/HomeBehindPanel.vue';
import HomeFocusPanel from '../components/home/HomeFocusPanel.vue';
import HomeRail from '../components/home/HomeRail.vue';
import '../components/home/home.css';
import { buildAssistantRouteQuery, parseAssistantRouteQuery } from '../lib/assistant/assistant-routing.js';
import { apiClient, authSession } from '../lib/auth/index.js';
import { LENSES, dateLine, failedSourcesMessage, firstNameOf, greetingFor, roleSummary } from '../lib/home/home-format.js';
import { useWorkspaceLiveRefresh } from '../lib/live/live-refresh.js';

// Home: what to do first, whether you (or your team's sprint) are behind and how to recover,
// and a summary rail. One request (GET /api/home) per view; the server ranks everything.
const route = useRoute();
const router = useRouter();

const payload = ref(null);
const loading = ref(true);
const errorMessage = ref('');
const announcement = ref('');
const stagingId = ref('');
const staged = ref(null);
const stageError = ref('');
const today = new Date();
let requestSequence = 0;

const currentUser = computed(() => authSession.state.currentUser);
const viewer = computed(() => payload.value?.viewer ?? null);
const lens = computed(() => viewer.value?.lens ?? 'my-work');
const lenses = computed(() => viewer.value?.lenses ?? []);
const greeting = computed(() => `${greetingFor(today)}, ${firstNameOf(viewer.value?.name || currentUser.value?.name)}`);
const role = computed(() => (viewer.value ? roleSummary(viewer.value, currentUser.value?.tenantName ?? '') : ''));
const subtitle = computed(() => [dateLine(today), role.value].filter(Boolean).join(' · '));
const subtitleShort = computed(() => [dateLine(today, { short: true }), role.value].filter(Boolean).join(' · '));
const twoFactorOff = computed(() => {
  if (viewer.value) return !viewer.value.twoFactorEnabled;
  return Boolean(currentUser.value) && !currentUser.value.preferences?.twoFactorEnabled;
});
const showBehind = computed(() => payload.value?.status?.kind === 'behind' && lens.value !== 'workspace');
const failureMessage = computed(() => (payload.value ? failedSourcesMessage(payload.value.sources, payload.value.viewer?.projectCount ?? 0) : ''));

// `quiet` reloads after someone else's change: Home stays as it is while it loads, and on failure.
async function load(requestedLens = null, { quiet = false } = {}) {
  if (!authSession.state.token) {
    loading.value = false;
    return;
  }
  const sequence = ++requestSequence;
  if (!quiet) {
    loading.value = true;
    errorMessage.value = '';
  }
  try {
    // Home draws its own loading state, so the shared working banner stays quiet.
    const result = await apiClient.passive.getHome(requestedLens ? { lens: requestedLens } : {}, authSession.state.token);
    if (sequence !== requestSequence) return;
    payload.value = result;
    // A staged proposal that is no longer offered was applied or overtaken by other changes.
    if (staged.value && !result.recovery?.proposals?.some((proposal) => proposal.id === staged.value.proposalId)) staged.value = null;
  } catch (error) {
    if (sequence === requestSequence && !quiet) errorMessage.value = error.message || 'Home could not load.';
  } finally {
    if (sequence === requestSequence) loading.value = false;
  }
}

async function chooseLens(next) {
  if (next === lens.value) return;
  staged.value = null;
  stageError.value = '';
  // Remembered for next time; if the save fails, Home just opens on the default view.
  apiClient.saveHomeLens(next, authSession.state.token).catch(() => {});
  await load(next);
  if (!errorMessage.value) announcement.value = `Showing ${LENSES[next].label}.`;
}

async function review(proposal) {
  stagingId.value = proposal.id;
  stageError.value = '';
  try {
    const result = await apiClient.stageHomeRecoveryProposal(proposal.id, authSession.state.token);
    staged.value = { proposalId: proposal.id, summary: proposal.summary };
    announcement.value = `Opened in the AI Workspace. ${proposal.summary} is waiting for your approval.`;
    await router.push({ name: 'home', query: buildAssistantRouteQuery(route.query, { open: true, sessionId: result.assistantSessionId }) });
  } catch (error) {
    if (error.status === 404) {
      stageError.value = 'That option was out of date, so Home has been refreshed.';
      await load(lens.value);
    } else {
      stageError.value = error.message || 'That option could not be opened in the AI Workspace.';
    }
  } finally {
    stagingId.value = '';
  }
}

// Closing the AI Workspace may follow an approved change, so Home reads again.
watch(() => parseAssistantRouteQuery(route.query).open, (open, wasOpen) => {
  if (wasOpen && !open && payload.value) load(lens.value);
});

onMounted(() => load());

// Work, approvals and projects changed elsewhere, by people, the assistant or MCP clients. A load
// already under way, such as a lens change, wins.
useWorkspaceLiveRefresh(['projects', 'workflows'], () => {
  if (payload.value && !loading.value) load(lens.value, { quiet: true });
});
</script>

<template>
  <div class="home">
    <p class="visually-hidden" aria-live="polite">{{ announcement }}</p>
    <header class="home-head">
      <div>
        <h1 class="home-title">{{ greeting }}</h1>
        <p class="home-sub"><span class="home-only-desktop">{{ subtitle }}</span><span class="home-only-mobile">{{ subtitleShort }}</span></p>
      </div>
      <div v-if="lenses.length > 1" class="home-seg" role="group" aria-label="Home view">
        <button
          v-for="key in lenses"
          :key="key"
          type="button"
          :aria-pressed="key === lens ? 'true' : 'false'"
          :disabled="loading"
          @click="chooseLens(key)"
        >
          <i class="bi" :class="LENSES[key].icon" aria-hidden="true"></i>{{ LENSES[key].label }}
        </button>
      </div>
    </header>

    <p v-if="twoFactorOff" class="home-notice">
      <i class="bi bi-shield-exclamation" aria-hidden="true"></i>
      <span>Two-factor sign-in is off for your account.</span>
      <RouterLink class="home-link" :to="{ name: 'user', query: { tab: 'security' } }">Set up two-factor sign-in</RouterLink>
    </p>

    <div v-if="errorMessage" class="home-alert" role="alert">
      <i class="bi bi-exclamation-octagon-fill" aria-hidden="true"></i>
      <span>{{ payload ? 'Home could not refresh.' : 'Home could not load.' }} {{ errorMessage }}</span>
      <button class="btn btn-sm btn-outline-secondary home-btn" type="button" @click="load(payload ? lens : null)">
        <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>Retry
      </button>
    </div>

    <div v-if="payload" class="home-layout" :aria-busy="loading ? 'true' : 'false'">
      <div class="home-col">
        <HomeBehindPanel
          v-if="showBehind"
          :key="`behind-${lens}`"
          :as-of="payload.asOf"
          :proposals="payload.recovery?.proposals ?? []"
          :stage-error="stageError"
          :staged="staged"
          :staging-id="stagingId"
          :status="payload.status"
          @review="review"
        />
        <HomeFocusPanel :key="lens" :failure-message="failureMessage" :lens="lens" :payload="payload" @retry="load(lens)" />
      </div>
      <HomeRail :lens="lens" :payload="payload" />
    </div>
    <div v-else-if="loading" class="home-layout" aria-busy="true">
      <p class="visually-hidden">Loading your home…</p>
      <div class="home-col" aria-hidden="true">
        <div class="home-panel home-panel__body d-grid gap-3">
          <span v-for="row in 4" :key="row" class="home-skeleton" :style="{ width: `${90 - row * 12}%` }"></span>
        </div>
      </div>
      <div class="home-col" aria-hidden="true">
        <div class="home-panel home-panel__body d-grid gap-3">
          <span v-for="row in 3" :key="row" class="home-skeleton"></span>
        </div>
      </div>
    </div>
  </div>
</template>
