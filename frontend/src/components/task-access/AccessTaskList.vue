<script setup>
import AccessStatusChip from './AccessStatusChip.vue';
import { dueText, hoursText, itemTypeText } from '../../lib/task-access/access-view.js';

// The guest list: epics in a group of their own, then each story with the story itself (when
// it is shown) and its tasks. Each row has its type, status, who has it, the due date and the
// hours; screen readers hear the type in the row's button. Opening a row shows its detail; a
// story the person may add to offers "Add task".
defineProps({
  groups: { default: () => [], type: Array },
  sprintNames: { default: () => new Map(), type: Map },
});

const emit = defineEmits(['add', 'open']);

function storyLine(story, sprintNames) {
  const parts = [];
  if (story?.epicName) parts.push(story.epicName);
  if (story?.sprintId && sprintNames.get(story.sprintId)) parts.push(sprintNames.get(story.sprintId));
  if (story?.assigneeName) parts.push(story.assigneeName);
  return parts.join(' · ');
}
</script>

<template>
  <div class="access-list" data-testid="access-list">
    <section
      v-for="group in groups"
      :key="group.key"
      class="rq-panel access-list__group"
      :aria-labelledby="`access-story-${group.key}`"
    >
      <header class="access-list__head">
        <div class="access-list__story">
          <h2 :id="`access-story-${group.key}`" class="rq-title rq-title--sm">{{ group.title }}</h2>
          <p v-if="group.story" class="rq-xs rq-muted mb-0">
            <AccessStatusChip :status="group.story.status" />
            <template v-if="storyLine(group.story, sprintNames)"> {{ storyLine(group.story, sprintNames) }}</template>
          </p>
        </div>
        <button v-if="group.story?.canAddTask" class="ghost-button access-list__add" type="button" @click="emit('add', group.story.id)">
          <i class="bi bi-plus-lg" aria-hidden="true"></i>Add task<span class="visually-hidden"> to {{ group.story.name }}</span>
        </button>
      </header>
      <ul class="access-list__rows">
        <li v-for="item in group.items" :key="item.id" class="access-list__row" :class="{ 'access-list__row--mine': item.mine }">
          <div class="access-list__name">
            <span class="access-list__type" aria-hidden="true"><i class="bi" :class="itemTypeText(item.itemType).icon"></i>{{ itemTypeText(item.itemType).label }}</span>
            <button class="access-list__open" type="button" @click="emit('open', item.id)">{{ item.name }}<span class="visually-hidden">, {{ itemTypeText(item.itemType).noun }}</span></button>
            <span v-if="item.mine" class="rq-chip rq-chip--solid"><i class="bi bi-person-check" aria-hidden="true"></i>Yours</span>
          </div>
          <AccessStatusChip class="access-list__status" :status="item.status" />
          <span class="access-list__fact">
            <i class="bi bi-person" aria-hidden="true"></i>{{ item.mine ? 'You' : item.assigneeName || 'Unassigned' }}
          </span>
          <span class="access-list__fact" :class="{ 'access-overdue': dueText(item).overdue }">
            <i class="bi bi-calendar-event" aria-hidden="true"></i>{{ dueText(item).text || 'No due date' }}
          </span>
          <span class="access-list__fact">
            <i class="bi bi-hourglass-split" aria-hidden="true"></i>{{ hoursText(item) || 'No hours set' }}
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>
