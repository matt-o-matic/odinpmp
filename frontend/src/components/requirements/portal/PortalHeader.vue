<script setup>
import { computed, ref, useId } from 'vue';

import RequirementsAvatar from '../RequirementsAvatar.vue';
import { odinMarkUrl } from '../../../lib/requirements/portal-context.js';
import { linkValidityText, personLine } from '../../../lib/requirements/portal-view.js';
import { avatarColor, initials } from '../../../lib/requirements/requirements-topics.js';
import { useDarkMode } from '../../../lib/ui/theme.js';

// The portal's own small header: the Odin mark, the project, who the link belongs to, how
// long it stays valid, "Not you?", and the light/dark toggle. The app's navigation never
// shows in the portal. The task access pages reuse it and pass their own `validity` line.
const props = defineProps({
  eyebrow: { default: '', type: String },
  link: { default: null, type: Object },
  showLink: { default: true, type: Boolean },
  stakeholder: { default: null, type: Object },
  title: { default: 'Requirements review', type: String },
  validity: { default: '', type: String },
});

const ids = useId();
const notYouOpen = ref(false);
const mark = odinMarkUrl(import.meta.env.BASE_URL);
const theme = useDarkMode();

const person = computed(() => (props.stakeholder?.name
  ? { color: avatarColor(props.stakeholder.name), initials: initials(props.stakeholder.name), name: props.stakeholder.name }
  : null));
const validity = computed(() => props.validity || linkValidityText(props.link));
</script>

<template>
  <header class="rq-portal-head">
    <div class="rq-portal-head__brand">
      <img :src="mark" alt="OdinPMP" width="36" height="36" />
      <div>
        <p v-if="eyebrow" class="rq-eyebrow mb-0">{{ eyebrow }}</p>
        <p class="rq-portal-head__title mb-0">{{ title }}</p>
      </div>
    </div>
    <div class="rq-portal-head__side">
      <slot name="status"></slot>
      <span v-if="person" class="rq-portal-head__person">
        <RequirementsAvatar :person="person" />
        <span>{{ showLink ? personLine(stakeholder) : stakeholder.name }}</span>
      </span>
      <span v-if="showLink && validity" class="rq-chip rq-chip--neutral rq-portal-head__validity"><i class="bi bi-link-45deg" aria-hidden="true"></i>{{ validity }}</span>
      <button
        v-if="showLink && person"
        class="rq-text-action rq-portal-head__notyou"
        type="button"
        :aria-expanded="notYouOpen ? 'true' : 'false'"
        :aria-controls="`${ids}-notyou`"
        @click="notYouOpen = !notYouOpen"
      >Not you?</button>
      <button
        v-if="theme"
        class="theme-toggle"
        type="button"
        :aria-label="theme.darkMode.value ? 'Switch to light mode' : 'Switch to dark mode'"
        @click="theme.toggleDarkMode()"
      >
        <i :class="theme.darkMode.value ? 'bi bi-sun' : 'bi bi-moon'" aria-hidden="true"></i>
      </button>
    </div>
    <div v-if="notYouOpen" :id="`${ids}-notyou`" class="rq-portal-head__notyou-panel" role="region" aria-label="About this link">
      <p class="rq-small mb-1">This link was sent to <strong>{{ stakeholder.name }}</strong>. Anything you do here is recorded as {{ stakeholder.name }}.</p>
      <p class="rq-small mb-0">If that isn’t you, close this page and let the project team know so they can turn the link off.</p>
    </div>
  </header>
</template>
