<script setup>
import { computed, ref } from 'vue';

import { percentWidth, proposalIcon, sprintEndLabel, unitShort } from '../../lib/home/home-format.js';

// Shown when the person (My work) or a sprint on their projects (Team) is behind: the time
// and work bars, what the rule found, and rule-based ways back on track. Choosing one stages
// it into an AI Workspace session; nothing changes until it is approved there.
const props = defineProps({
  asOf: { required: true, type: String },
  proposals: { default: () => [], type: Array },
  stageError: { default: '', type: String },
  staged: { default: null, type: Object },
  stagingId: { default: '', type: String },
  status: { required: true, type: Object },
});
const emit = defineEmits(['review']);

const whyOpen = ref(false);
const sprint = computed(() => props.status.sprint ?? {});
const unit = computed(() => unitShort(sprint.value.unit));
const scopeLine = computed(() => [sprint.value.projectName, sprintEndLabel(sprint.value.endDate, props.asOf)].filter(Boolean).join(' · '));
const firstPermitted = computed(() => props.proposals.find((proposal) => proposal.permitted)?.id ?? null);
</script>

<template>
  <section class="home-panel home-behind" aria-labelledby="home-behind-title">
    <div class="home-panel__head">
      <span class="home-flag"><i class="bi bi-exclamation-triangle-fill" aria-hidden="true"></i>At risk</span>
      <h2 id="home-behind-title" class="home-h2">{{ status.headline }}</h2>
      <span class="home-small home-muted ms-auto">{{ scopeLine }}</span>
    </div>

    <div class="home-burn" role="img" :aria-label="`Time elapsed ${sprint.elapsedPct}%. Work done: ${sprint.donePoints} of ${sprint.committedPoints} ${unit}.`">
      <div class="home-burn__row">
        <span>Time elapsed</span>
        <span class="home-bar home-bar--time"><span :style="{ width: `${sprint.elapsedPct}%` }"></span></span>
        <span>{{ sprint.elapsedPct }}%</span>
      </div>
      <div class="home-burn__row">
        <span>Work done</span>
        <span class="home-bar home-bar--behind"><span :style="{ width: `${percentWidth(sprint.donePoints, sprint.committedPoints)}%` }"></span></span>
        <span>{{ sprint.donePoints }} of {{ sprint.committedPoints }} {{ unit }}</span>
      </div>
    </div>
    <p class="home-say">{{ status.say }}</p>

    <template v-if="proposals.length">
      <h3 class="home-props__head"><i class="bi bi-signpost-2" aria-hidden="true"></i>Ways to get back on track</h3>
      <ul class="home-props home-props--capped">
        <li v-for="proposal in proposals" :key="proposal.id" class="home-prop" :class="{ 'home-prop--off': !proposal.permitted }">
          <span class="home-prop__icon" aria-hidden="true"><i class="bi" :class="proposalIcon(proposal.type)"></i></span>
          <span>
            <span class="home-prop__title">{{ proposal.summary }}</span>
            <span class="home-prop__impact">
              {{ proposal.permitted ? proposal.detail : proposal.blockedReason }}
              <b v-if="proposal.permitted">{{ proposal.impact?.text }}</b>
            </span>
          </span>
          <button
            v-if="proposal.permitted"
            class="btn btn-sm home-btn"
            :class="proposal.id === firstPermitted ? 'btn-dark' : 'btn-outline-secondary'"
            type="button"
            :disabled="Boolean(stagingId)"
            :aria-label="`Review in AI Workspace: ${proposal.summary}`"
            @click="emit('review', proposal)"
          >
            <span v-if="stagingId === proposal.id" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
            <i v-else class="bi bi-stars" aria-hidden="true"></i>Review in AI Workspace
          </button>
          <span v-else class="home-small home-muted home-prop__off">Not permitted</span>
        </li>
      </ul>
    </template>

    <p v-if="staged" class="home-opened">
      <i class="bi bi-window-sidebar" aria-hidden="true"></i>
      <span><b>Opened in the AI Workspace.</b> “{{ staged.summary }}” is waiting for your approval. Nothing has changed yet.</span>
    </p>
    <p v-if="stageError" class="home-alert" role="alert"><i class="bi bi-exclamation-octagon-fill" aria-hidden="true"></i><span>{{ stageError }}</span></p>

    <ul v-show="whyOpen" id="home-behind-why" class="home-why-list">
      <li v-for="entry in status.evidence" :key="entry.rule + entry.label">{{ entry.label }}</li>
    </ul>
    <div class="home-note">
      <i class="bi bi-shield-check" aria-hidden="true"></i>
      <span>Odin suggests. Nothing changes until you approve it in the AI Workspace.</span>
      <button class="home-link ms-auto" type="button" aria-controls="home-behind-why" :aria-expanded="whyOpen ? 'true' : 'false'" @click="whyOpen = !whyOpen">
        {{ whyOpen ? 'Hide why' : 'Why behind?' }}
      </button>
    </div>
  </section>
</template>
