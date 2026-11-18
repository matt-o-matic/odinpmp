<script setup>
import { computed } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

// The ways into one round, side by side on each of its pages: its results, every mark with
// its discussion, and the signed-in member's own guided review. `markId` carries the mark in
// view across, so Marks and comments and the review open on the same mark.
const props = defineProps({
  // 'results' | 'marks' | 'review'
  current: { required: true, type: String },
  markId: { default: '', type: String },
  // The round's mark count, when the page knows it.
  marks: { default: null, type: Number },
  projectId: { required: true, type: String },
  // Whether the member can open the guided review (project.collaborate).
  review: { default: true, type: Boolean },
  reviewLabel: { default: 'Your review', type: String },
  roundId: { required: true, type: String },
});

const router = useRouter();

const items = computed(() => {
  const params = { projectId: props.projectId, roundId: props.roundId };
  const list = [
    { icon: 'bi-bar-chart', id: 'results', label: 'Results', to: { name: 'project-requirements-round', params } },
    {
      count: props.marks,
      icon: 'bi-chat-square-text',
      id: 'marks',
      label: 'Marks and comments',
      to: { hash: props.markId ? `#mark-${props.markId}` : '', name: 'project-requirements-round-annotations', params },
    },
  ];
  if (props.review && router.hasRoute('project-requirements-round-review')) {
    list.push({
      icon: 'bi-pencil-square',
      id: 'review',
      label: props.reviewLabel,
      to: { name: 'project-requirements-round-review', params, query: props.markId ? { mark: props.markId } : {} },
    });
  }
  return list;
});
</script>

<template>
  <nav class="rq-roundtabs" aria-label="Round views">
    <RouterLink
      v-for="item in items"
      :key="item.id"
      class="rq-roundtabs__tab"
      :class="{ 'rq-roundtabs__tab--on': item.id === current }"
      :aria-current="item.id === current ? 'page' : undefined"
      :to="item.to"
    >
      <i class="bi" :class="item.icon" aria-hidden="true"></i>
      <span>{{ item.label }}</span>
      <span v-if="item.count != null" class="rq-roundtabs__count">{{ item.count }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.rq-roundtabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid var(--line);
  border-radius: 0.6rem;
  background: var(--surface-soft);
  width: fit-content;
  max-width: 100%;
}

.rq-roundtabs__tab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 2.5rem;
  padding: 0.3rem 0.85rem;
  border-radius: 0.45rem;
  color: var(--ink-soft);
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
}

.rq-roundtabs__tab:hover {
  background: var(--surface);
  color: var(--ink);
}

.rq-roundtabs__tab--on,
.rq-roundtabs__tab--on:hover {
  background: var(--surface);
  box-shadow: 0 1px 3px rgba(7, 17, 31, 0.12);
  color: var(--accent);
}

.rq-roundtabs__count {
  min-width: 1.4rem;
  padding: 0 0.4rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-size: 0.75rem;
  line-height: 1.4rem;
  text-align: center;
}

@media (max-width: 40rem) {
  .rq-roundtabs {
    width: 100%;
  }

  .rq-roundtabs__tab {
    flex: 1 1 auto;
    justify-content: center;
  }
}
</style>
