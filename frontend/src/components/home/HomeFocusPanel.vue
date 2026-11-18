<script setup>
import { computed, nextTick, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { dueLabel, itemsForTab, reasonIcon } from '../../lib/home/home-format.js';

// Focus now and the other lists for the view, as tabs. The server ranks the items; this
// draws them, the status line when nothing is behind, and any source that failed to load.
const props = defineProps({
  failureMessage: { default: '', type: String },
  lens: { required: true, type: String },
  payload: { required: true, type: Object },
});
const emit = defineEmits(['retry']);

const activeTab = ref('focus');
const showAll = ref(false);
const helpOpen = ref(false);

const tabs = computed(() => props.payload.tabs ?? []);
const rows = computed(() => itemsForTab(props.payload, activeTab.value));
const activeCount = computed(() => tabs.value.find((tab) => tab.key === activeTab.value)?.count ?? rows.value.length);
const status = computed(() => props.payload.status ?? {});
// The behind panel above the list carries the status for My work and Team; Workspace and
// on-track statuses show here as one line.
const statusLine = computed(() => {
  if (status.value.kind === 'on-track') return { headline: status.value.headline, icon: 'bi-check-circle-fill', kind: 'ok', say: status.value.say };
  if (status.value.kind === 'behind' && props.lens === 'workspace') return { headline: status.value.headline, icon: 'bi-exclamation-triangle-fill', kind: 'behind', say: status.value.say };
  return null;
});
const footNote = computed(() => {
  const note = props.lens === 'workspace' ? 'Workspace work ranked by risk and deadline.' : 'Ranked by what keeps your projects moving.';
  // The server reads at most 50 projects, in rank order (home.service.js HOME_PROJECT_LIMIT).
  return props.payload.viewer?.projectsTruncated ? `${note} Only your first 50 projects by rank are included.` : note;
});
const noProjects = computed(() => props.lens !== 'workspace' && (props.payload.viewer?.projectCount ?? 0) === 0);
const nextUp = computed(() => itemsForTab(props.payload, 'assigned')[0] ?? null);
const capped = computed(() => activeTab.value === 'focus' && !showAll.value && rows.value.length > 4);

function selectTab(key) {
  activeTab.value = key;
  showAll.value = false;
}

// Arrow keys move between tabs, as in the ARIA tabs pattern.
async function onTabKey(event, index) {
  const keys = { ArrowLeft: -1, ArrowRight: 1, End: tabs.value.length, Home: -tabs.value.length };
  if (!(event.key in keys)) return;
  event.preventDefault();
  const next = Math.max(0, Math.min(tabs.value.length - 1, index + keys[event.key]));
  selectTab(tabs.value[next].key);
  await nextTick();
  document.getElementById(`home-tab-${tabs.value[next].key}`)?.focus();
}
</script>

<template>
  <section class="home-panel" aria-labelledby="home-focus-title">
    <h2 id="home-focus-title" class="visually-hidden">Focus now</h2>
    <div class="home-tabs" role="tablist" aria-label="Home lists">
      <button
        v-for="(tab, index) in tabs"
        :id="`home-tab-${tab.key}`"
        :key="tab.key"
        class="home-tab"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.key ? 'true' : 'false'"
        aria-controls="home-tabpanel"
        :tabindex="activeTab === tab.key ? 0 : -1"
        @click="selectTab(tab.key)"
        @keydown="onTabKey($event, index)"
      >
        {{ tab.label }} <span class="home-count">{{ tab.count }}</span>
      </button>
    </div>

    <div id="home-tabpanel" role="tabpanel" :aria-labelledby="`home-tab-${activeTab}`">
      <div v-if="failureMessage" class="home-alert" role="alert">
        <i class="bi bi-exclamation-octagon-fill" aria-hidden="true"></i>
        <span>{{ failureMessage }}</span>
        <button class="btn btn-sm btn-outline-secondary home-btn" type="button" @click="emit('retry')">
          <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>Retry
        </button>
      </div>
      <p v-if="statusLine && activeTab === 'focus'" class="home-status" :class="`home-status--${statusLine.kind}`">
        <i class="bi" :class="statusLine.icon" aria-hidden="true"></i>
        <span><b>{{ statusLine.headline }}</b> {{ statusLine.say }}</span>
      </p>

      <ol v-if="rows.length" class="home-list" :class="{ 'home-list--focus': activeTab === 'focus', 'home-list--capped': capped }">
        <li v-for="(item, index) in rows" :key="item.id">
          <component
            :is="item.link ? RouterLink : 'div'"
            class="home-row"
            :to="item.link ?? undefined"
          >
            <span class="home-rank" aria-hidden="true">{{ index + 1 }}</span>
            <span class="home-row__main">
              <span class="home-row__title">{{ item.title }}</span>
              <span class="home-why">
                <template v-for="reason in item.reasons" :key="reason.code">
                  <b :class="{ 'home-hot': reason.tone === 'hot' }"><i class="bi" :class="reasonIcon(reason.code)" aria-hidden="true"></i>{{ reason.label }}</b>
                  <span class="home-sep" aria-hidden="true">·</span>
                </template>
                <span>{{ item.projectName }}</span>
              </span>
            </span>
            <span class="home-due">{{ dueLabel(item.due, payload.asOf) }}</span>
            <i v-if="item.link" class="bi bi-chevron-right home-chev" aria-hidden="true"></i>
            <span v-else></span>
          </component>
        </li>
      </ol>

      <div v-else-if="noProjects" class="home-empty">
        <i class="bi bi-compass home-empty__icon" aria-hidden="true"></i>
        <h3 class="home-h3">Nothing to focus on yet</h3>
        <p class="home-muted">When you join a project or get work assigned, your top things to do appear here.</p>
        <RouterLink class="btn btn-outline-secondary btn-sm home-btn" :to="{ name: 'projects' }">Browse projects</RouterLink>
        <p class="home-small home-muted">Not on a project yet? Ask a workspace admin to add you.</p>
      </div>
      <div v-else-if="activeTab === 'focus'" class="home-empty">
        <i class="bi bi-check2-circle home-empty__icon" aria-hidden="true"></i>
        <h3 class="home-h3">Nothing urgent right now</h3>
        <template v-if="nextUp">
          <p class="home-muted">Next up: “{{ nextUp.title }}”<template v-if="nextUp.due?.at">, due {{ dueLabel(nextUp.due, payload.asOf) }}</template>.</p>
          <RouterLink v-if="nextUp.link" class="home-link" :to="nextUp.link">Open it <i class="bi bi-arrow-right" aria-hidden="true"></i></RouterLink>
        </template>
        <RouterLink v-else class="home-link" :to="{ name: 'projects' }">Pull the next item from a backlog <i class="bi bi-arrow-right" aria-hidden="true"></i></RouterLink>
      </div>
      <p v-else class="home-empty home-muted">Nothing here right now.</p>
    </div>

    <ul v-show="helpOpen" id="home-ranking-help" class="home-help">
      <li><b>First:</b> past its SLA, overdue on the critical path, blocking someone, an S1 ticket, or a critical Odin alert.</li>
      <li><b>Then:</b> due within a working day, a required review closing soon, a sprint ending within two working days, or a decision someone is waiting on.</li>
      <li><b>Next:</b> in progress in the active sprint, or high priority.</li>
      <li>Within each group: most people blocked, then soonest due, then priority, then least schedule float.</li>
    </ul>
    <div class="home-foot">
      <span :class="{ 'home-only-desktop': capped }">{{ footNote }}</span>
      <button v-if="capped" class="home-link home-only-mobile" type="button" @click="showAll = true">See all {{ activeCount }}</button>
      <button class="home-link" type="button" aria-controls="home-ranking-help" :aria-expanded="helpOpen ? 'true' : 'false'" @click="helpOpen = !helpOpen">
        How ranking works
      </button>
    </div>
  </section>
</template>
