<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';

import { HEALTH_ICONS, evidenceLocation } from '../../../lib/insights/insights-format.js';

// The "At risk:" headline. It comes from the shared health-signal rules on the server, and
// every line of evidence links to the item, sprint or milestone that triggered it.

const props = defineProps({
  health: { required: true, type: Object },
  projectId: { required: true, type: String },
});

const SCOPE_LABELS = { person: 'Your work', project: 'Schedule', sprint: 'Sprint' };

// A signal whose only evidence restates its headline links the headline itself.
const groups = computed(() => (props.health.signals ?? [])
  .filter((signal) => signal.kind !== 'on-track' || props.health.kind === 'on-track')
  .map((signal) => {
    const evidence = signal.kind === 'on-track' ? [] : signal.evidence.map((entry, index) => ({ ...entry, key: `${signal.scope}-${index}`, location: evidenceLocation(entry.link, props.projectId) }));
    const restated = evidence.length === 1 && evidence[0].label === signal.headline ? evidence[0] : null;
    return {
      evidence: restated ? [] : evidence,
      headline: signal.headline,
      headlineLocation: restated?.location ?? null,
      key: `${signal.scope}-${signal.subject?.id ?? ''}`,
      kind: signal.kind,
      scope: SCOPE_LABELS[signal.scope] ?? signal.scope,
    };
  }));
</script>

<template>
  <section class="insights-health" :class="`insights-health--${health.kind}`" aria-labelledby="insights-health-headline">
    <i class="bi insights-health__icon" :class="HEALTH_ICONS[health.kind]" aria-hidden="true"></i>
    <div class="insights-health__body">
      <p id="insights-health-headline" class="insights-health__headline">{{ health.headline }}</p>
      <ul class="insights-health__signals">
        <li v-for="group in groups" :key="group.key" class="insights-health__signal">
          <span class="insights-health__scope">{{ group.scope }}</span>
          <RouterLink v-if="group.headlineLocation" :to="group.headlineLocation">{{ group.headline }}</RouterLink>
          <span v-else>{{ group.headline }}</span>
          <ul v-if="group.evidence.length" class="insights-health__evidence">
            <li v-for="entry in group.evidence" :key="entry.key">
              <RouterLink v-if="entry.location" :to="entry.location">{{ entry.label }}</RouterLink>
              <span v-else>{{ entry.label }}</span>
            </li>
          </ul>
        </li>
      </ul>
    </div>
  </section>
</template>
