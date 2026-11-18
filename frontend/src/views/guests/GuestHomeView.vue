<script setup>
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';

import GuestChatFrame from '../../components/guests/GuestChatFrame.vue';
import GuestTaskList from '../../components/guests/GuestTaskList.vue';
import { guestApi } from '../../lib/guests/guest-client.js';
import { guestNotice } from '../../lib/guests/guest-view.js';

// A guest's start page: Odin Chat's layout with the engagements and projects they are a guest
// in, each with only their channels and unread counts. Below them, the pursuit tasks shared
// with them, where they change the status of, comment on and attach files to their own
// (guest-tasks.js on the server).
const route = useRoute();
const notice = computed(() => guestNotice(route.query.notice));
const tasks = ref({});
const projectsById = ref({});
const hasTasks = computed(() => Object.keys(tasks.value).length > 0);

async function loadTasks() {
  const found = {};
  for (const project of Object.values(projectsById.value)) {
    try {
      const result = await guestApi.listTasks(project.id);
      if (result.available && result.tasks?.length) found[project.id] = result;
    } catch {
      // Tasks are extra; the channels still show.
    }
  }
  tasks.value = found;
}

async function onLoaded({ projects, session }) {
  if (typeof document !== 'undefined') document.title = `Your channels · ${session.workspace?.name || 'OdinPMP'}`;
  projectsById.value = Object.fromEntries(projects.map((project) => [project.id, project]));
  await loadTasks();
}
</script>

<template>
  <GuestChatFrame @loaded="onLoaded">
    <template #before-sidebar>
      <div class="guest-home__top">
        <h1 class="guest-home__title">Your channels</h1>
        <p v-if="notice" class="guest-home__notice" role="status">{{ notice }}</p>
      </div>
    </template>
    <!-- Below the channels, so a phone (which opens on the sidebar) shows them too. -->
    <template #below-sidebar>
      <div v-for="(result, projectId) in tasks" :key="projectId" class="guest-home__project">
        <h2 class="guest-home__project-name">{{ projectsById[projectId]?.name }}</h2>
        <GuestTaskList
          :project-id="projectId"
          :read-only="Boolean(projectsById[projectId]?.readOnly)"
          :statuses="result.statuses ?? []"
          :tasks="result.tasks"
          :whole-board="Boolean(result.wholeBoard)"
          @changed="loadTasks()"
        />
      </div>
    </template>
    <section class="guest-home">
      <p class="guest-home__note">{{ hasTasks ? 'Choose a channel, or a task on the left.' : 'Choose a channel.' }}</p>
    </section>
  </GuestChatFrame>
</template>

<style scoped>
.guest-home { display: grid; place-items: center; min-height: 60vh; padding: 2rem 1rem; }
.guest-home__note { margin: 0; color: var(--muted); }
.guest-home__top { display: grid; gap: 0.5rem; padding: 0.75rem 1rem 0; }
/* The legacy stylesheet sizes and underlines every h1/h2 with !important. */
.guest-home__title { margin: 0; padding: 0; border-bottom: 0; font-family: var(--font-display); font-size: 1.2rem !important; }
.guest-home__notice { margin: 0; padding: 0.5rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface-soft); font-size: 0.875rem; }
.guest-home__project { display: grid; gap: 0.25rem; margin: 0 0.5rem 1rem; padding: 0.75rem 0.5rem 0; border-top: 1px solid var(--line); font-size: 0.875rem; }
.guest-home__project-name { margin: 0; padding: 0; border-bottom: 0; color: var(--muted); font-size: 0.75rem !important; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
</style>
