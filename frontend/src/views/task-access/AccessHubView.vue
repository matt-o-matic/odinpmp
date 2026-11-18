<script setup>
import { computed, ref, shallowRef, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import PortalHeader from '../../components/requirements/portal/PortalHeader.vue';
import AccessLinkProblem from '../../components/task-access/AccessLinkProblem.vue';
import '../../components/task-access/task-access.css';
import { apiClient } from '../../lib/auth/index.js';
import {
  accessLinkText,
  classifyAccessError,
  describeAccessWriteError,
  directTasksProjectId,
  hubProjectSummary,
  hubProjects,
} from '../../lib/task-access/access-view.js';

// The access link's hub at /access/:token: every project the person's email has been given,
// each with Tasks and/or Requirements. With one project and only its tasks, it opens that
// project straight away. The link token is the only credential; the app's chrome is hidden
// (route meta `portal`).
const route = useRoute();
const router = useRouter();

const hub = shallowRef(null);
const problem = ref(null);
const opening = ref('');
const openError = ref('');
let sequence = 0;

const token = computed(() => String(route.params.token ?? ''));
const projects = computed(() => hubProjects(hub.value));
const person = computed(() => (hub.value?.person?.name ? { name: hub.value.person.name } : null));

function tasksLink(projectId) {
  return { name: 'task-access-project', params: { projectId, token: token.value } };
}

async function load() {
  const current = ++sequence;
  if (!token.value) return;
  problem.value = null;
  try {
    const data = await apiClient.getAccessHub(token.value);
    if (current !== sequence) return;
    const direct = directTasksProjectId(data);
    if (direct) {
      await router.replace(tasksLink(direct));
      return;
    }
    hub.value = data;
  } catch (error) {
    if (current !== sequence) return;
    problem.value = classifyAccessError(error);
  }
}

// Requirements open in the existing portal with a token minted for this person's link.
async function openRequirements(project) {
  if (opening.value) return;
  opening.value = project.id;
  openError.value = '';
  try {
    const result = await apiClient.openAccessRequirements(token.value, project.id);
    await router.push({ name: 'requirements-portal', params: { token: result.token } });
  } catch (error) {
    const described = describeAccessWriteError(error);
    if (described.problem?.kind === 'no-project') {
      openError.value = `${project.name}’s requirements are no longer shared with you.`;
      load();
    } else if (described.problem) {
      problem.value = described.problem;
    } else {
      openError.value = 'The requirements didn’t open. Check your connection and try again.';
    }
  } finally {
    opening.value = '';
  }
}

watch(token, () => {
  hub.value = null;
  load();
}, { immediate: true });

watch(hub, (value) => {
  if (typeof document !== 'undefined' && value) document.title = 'Your projects · OdinPMP';
});
</script>

<template>
  <div class="rq-workspace rq-portal access-portal">
    <PortalHeader
      title="Your projects"
      :link="hub?.link ?? null"
      :show-link="Boolean(hub) && !problem"
      :stakeholder="problem ? null : person"
      :validity="accessLinkText(hub?.link)"
    />
    <AccessLinkProblem v-if="problem" :problem="problem" @retry="load()" />
    <div v-else-if="!hub" class="rq-review-page">
      <p class="rq-review-card rq-small rq-muted mb-0" role="status">Loading…</p>
    </div>
    <div v-else class="rq-portal-page rq-stack">
      <h1 class="visually-hidden">Your projects</h1>
      <p v-if="openError" class="error-banner mb-0" role="alert">{{ openError }}</p>

      <section v-if="!projects.length" class="rq-panel rq-stack rq-stack--sm" aria-labelledby="access-hub-empty">
        <h2 id="access-hub-empty" class="rq-title rq-title--md">Nothing is shared with you right now</h2>
        <p class="rq-small rq-muted mb-0">If you expected to see a project here, ask the project team.</p>
      </section>

      <ul v-else class="access-hub" data-testid="access-hub">
        <li v-for="project in projects" :key="project.id" class="rq-panel access-hub__row">
          <div class="access-hub__info">
            <h2 class="rq-title rq-title--sm access-hub__name">{{ project.name }}</h2>
            <p class="rq-xs rq-muted mb-0">{{ hubProjectSummary(project) }}</p>
          </div>
          <div class="access-hub__actions">
            <RouterLink v-if="project.tasks" class="primary-button" :to="tasksLink(project.id)">
              <i class="bi bi-kanban" aria-hidden="true"></i>Tasks<span class="visually-hidden"> on {{ project.name }}</span>
            </RouterLink>
            <button
              v-if="project.requirements"
              class="ghost-button"
              type="button"
              :disabled="Boolean(opening)"
              @click="openRequirements(project)"
            >
              <i class="bi bi-chat-square-text" aria-hidden="true"></i>{{ opening === project.id ? 'Opening…' : 'Requirements' }}<span class="visually-hidden"> on {{ project.name }}</span>
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
