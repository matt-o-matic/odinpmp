<script setup>
import { computed } from 'vue';

import './rounds.css';
import RequirementsAvatar from '../RequirementsAvatar.vue';
import { mailStatus, reviewerCounts, reviewerKindLabel, reviewerStatus, submittedText } from '../../../lib/requirements/requirements-rounds.js';
import { chipToneClass, avatarColor, initials } from '../../../lib/requirements/requirements-topics.js';
import { formatAgo } from '../../../lib/requirements/requirements-time.js';

// Reviewer progress for a round: who submitted, who is partway, and whether each
// invitation went out. Members and up change reviewers, the due date, and the reminder
// (Edit), and resend an invitation to anyone who hasn't submitted.
const props = defineProps({
  canManage: { default: false, type: Boolean },
  open: { default: false, type: Boolean },
  // reviewerId currently being resent.
  resending: { default: '', type: String },
  reviewers: { default: () => [], type: Array },
  // Project roles by user id, for "member", "admin", and so on.
  roles: { default: () => new Map(), type: Map },
});

// Editing reviewers and dates is in the round page header.
const emit = defineEmits(['resend']);

const counts = computed(() => reviewerCounts(props.reviewers));
const rows = computed(() => [...props.reviewers]
  .sort((left, right) => Number(Boolean(left.removedAt)) - Number(Boolean(right.removedAt)) || String(left.name).localeCompare(String(right.name)))
  .map((reviewer) => ({
    kind: reviewerKindLabel({ actorType: reviewer.actorType, role: props.roles.get(reviewer.actorId) }),
    mail: mailStatus(reviewer.mail),
    person: { color: avatarColor(reviewer.actorRef), initials: initials(reviewer.name), name: reviewer.name, ref: reviewer.actorRef },
    reviewer,
    status: reviewerStatus(reviewer),
  })));
</script>

<template>
  <section class="rq-panel rq-stack" aria-labelledby="rq-round-reviewers-heading">
    <div class="rq-row rq-row--between rq-row--wrap">
      <div class="rq-row rq-row--tight rq-row--wrap">
        <h3 id="rq-round-reviewers-heading" class="rq-eyebrow">Reviewers</h3>
        <span class="rq-xs rq-muted">{{ submittedText(counts) }}<template v-if="counts.required"> · {{ counts.requiredSubmitted }} of {{ counts.required }} required</template></span>
      </div>
    </div>
    <ul class="rq-reviewers">
      <li v-for="row in rows" :key="row.reviewer.id" class="rq-reviewer" :class="{ 'rq-reviewer--removed': row.reviewer.removedAt }">
        <RequirementsAvatar :person="row.person" />
        <div class="rq-reviewer__main">
          <span>
            {{ row.reviewer.name }} <span class="rq-xs rq-muted">· {{ row.kind }}</span>
            <span v-if="row.reviewer.required && !row.reviewer.removedAt" class="rq-chip rq-chip--outline ms-1">required</span>
          </span>
          <span class="rq-reviewer__meta">
            <span class="rq-chip" :class="chipToneClass(row.status.tone)">{{ row.status.label }}</span>
            <span v-if="!row.reviewer.removedAt" class="rq-chip" :class="chipToneClass(row.mail.tone)">
              <i v-if="row.mail.problem" class="bi bi-exclamation-triangle" aria-hidden="true"></i>{{ row.mail.label }}
            </span>
            <span v-if="row.reviewer.submittedAt">submitted {{ formatAgo(row.reviewer.submittedAt) }}</span>
            <span v-else-if="row.reviewer.remindedAt">reminded {{ formatAgo(row.reviewer.remindedAt) }}</span>
          </span>
        </div>
        <div v-if="canManage && open && !row.reviewer.removedAt && !row.reviewer.submittedAt" class="rq-reviewer__actions">
          <button
            class="ghost-button ghost-button--compact"
            type="button"
            :disabled="resending === row.reviewer.id"
            :aria-label="`${row.mail.problem ? 'Resend invitation to' : 'Remind'} ${row.reviewer.name}`"
            @click="emit('resend', row.reviewer)"
          >
            <i class="bi" :class="row.mail.problem ? 'bi-envelope-arrow-up' : 'bi-bell'" aria-hidden="true"></i>{{ resending === row.reviewer.id ? 'Sending…' : row.mail.problem ? 'Resend' : 'Remind' }}
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
