<script setup>
import { computed, ref, watch } from 'vue';

import ProjectKanbanWorkspace from '../projects/ProjectKanbanWorkspace.vue';
import PursuitMoveDialog from './PursuitMoveDialog.vue';
import PursuitTaskDrawer from './PursuitTaskDrawer.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { findPursuitTask, PURSUIT_STATUS_OPTIONS, pursuitTasks, withAssigneeNames } from '../../lib/pursuit/pursuit.js';
import { projectAssignees } from '../../lib/resources/resources.js';

// The pursuit board: an engagement's Board tab, and a converted project's Pursuit tab. Odin's
// kanban board shows the pursuit tasks; the hidden Pursuit story they sit under is not a
// card. On a converted project, people who can edit the plan move tasks to it.

const props = defineProps({
  allowMove: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  readOnly: { default: false, type: Boolean },
  refreshVersion: { default: 0, type: Number },
});

const emit = defineEmits(['moved']);

const pursuit = ref(null);
const loadError = ref('');
const message = ref('');
const teamPeople = ref([]);
// Members and allocated people, then the engagement's guests and stakeholders, whom a pursuit
// task is often for (`stakeholder:<id>`).
const people = computed(() => {
  const seen = new Set(teamPeople.value.map((person) => person.id));
  const outside = (pursuit.value?.outsideAssignees ?? [])
    .filter((person) => !seen.has(person.id))
    .map((person) => ({ email: '', guest: Boolean(person.guest), id: person.id, name: person.name, outside: true, role: null }));
  return [...teamPeople.value, ...outside];
});
const openTaskId = ref('');
const moveOpen = ref(false);
let sequence = 0;

const token = computed(() => authSession.state.token);
const canEdit = computed(() => Boolean(pursuit.value?.viewer?.canEdit) && !props.readOnly);
const boardProject = computed(() => withAssigneeNames(pursuit.value?.project ?? null, people.value));
const openTask = computed(() => (openTaskId.value ? findPursuitTask(boardProject.value, openTaskId.value) : null));
const hasTasks = computed(() => pursuitTasks(pursuit.value?.project).length > 0);

// Members, people allocated to the project, and for resource managers the workspace's people
// without a login, who are the outside people a pursuit task is usually for.
async function loadPeople() {
  const [members, team] = await Promise.all([
    apiClient.passive.getProjectValidUsers(props.projectId, token.value).then((result) => result?.project_users ?? []).catch(() => []),
    apiClient.passive.getProjectTeam(props.projectId, token.value).catch(() => null),
  ]);
  const assignees = projectAssignees(members, team);
  const seen = new Set(assignees.map((person) => person.id));
  for (const resource of team?.directory ?? []) {
    const id = `resource:${resource.id}`;
    if (resource.userId || resource.status !== 'active' || seen.has(id)) continue;
    seen.add(id);
    assignees.push({ email: '', id, name: resource.name, resourceOnly: true, role: null });
  }
  teamPeople.value = assignees;
}

async function load() {
  if (!props.projectId || !token.value) return;
  const current = ++sequence;
  try {
    const result = await apiClient.passive.getPursuit(props.projectId, token.value);
    if (current !== sequence) return;
    pursuit.value = result;
    loadError.value = '';
  } catch (error) {
    if (current === sequence) loadError.value = error?.message || 'The board could not load.';
  }
}

watch(() => props.projectId, () => {
  pursuit.value = null;
  void load();
  void loadPeople();
}, { immediate: true });
watch(() => props.refreshVersion, () => { void load(); });

function handleProjectUpdated(project) {
  if (project && pursuit.value) pursuit.value = { ...pursuit.value, project };
}

function openCard(_selection, card) {
  if (card?.id) openTaskId.value = card.id;
}

function handleSaved(result) {
  handleProjectUpdated(result?.project);
  openTaskId.value = '';
  message.value = 'Task saved.';
  void load();
}

function handleMoved(result) {
  moveOpen.value = false;
  if (result?.pursuit && pursuit.value) pursuit.value = { ...pursuit.value, project: result.pursuit };
  const count = result?.moved?.length ?? 0;
  message.value = `${count === 1 ? '1 task' : `${count} tasks`} moved to the project plan.`;
  emit('moved', result);
  void load();
}
</script>

<template>
  <section class="pursuit-board" aria-label="Pursuit board">
    <p v-if="loadError" class="error-banner" role="alert">{{ loadError }}</p>
    <div v-if="message" class="success-banner d-flex align-items-start justify-content-between gap-2" role="status">
      <span>{{ message }}</span>
      <button class="btn-close flex-shrink-0" type="button" aria-label="Dismiss message" @click="message = ''"></button>
    </div>
    <div v-if="allowMove && canEdit && hasTasks" class="pursuit-board__actions">
      <button class="secondary-button secondary-button--compact" type="button" @click="moveOpen = true">
        <i class="bi bi-box-arrow-right" aria-hidden="true"></i>
        <span>Move to project</span>
      </button>
    </div>
    <ProjectKanbanWorkspace
      v-if="pursuit"
      :can-edit="canEdit && Boolean(pursuit.storyId)"
      :project="boardProject"
      :project-id="projectId"
      :refresh-version="refreshVersion"
      scope="pursuit"
      :token="token"
      :valid-users="people"
      :work-status-options="PURSUIT_STATUS_OPTIONS"
      @edit-item="openCard"
      @error="loadError = $event"
      @message="message = $event"
      @project-updated="handleProjectUpdated"
    />
    <p v-else-if="!loadError" class="muted-copy" role="status">Loading board…</p>

    <PursuitTaskDrawer
      :can-edit="canEdit"
      :people="people"
      :project-id="projectId"
      :task="openTask"
      @close="openTaskId = ''"
      @saved="handleSaved"
    />
    <PursuitMoveDialog :open="moveOpen" :project-id="projectId" :pursuit-project="pursuit?.project ?? null" @close="moveOpen = false" @moved="handleMoved" />
  </section>
</template>

<style scoped>
.pursuit-board {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}

.pursuit-board__actions {
  display: flex;
  justify-content: flex-end;
}
</style>
