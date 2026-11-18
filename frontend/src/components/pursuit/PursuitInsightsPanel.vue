<script setup>
import { computed, ref, watch } from 'vue';

import '../projects/insights/insights.css';
import InsightsCard from '../projects/insights/InsightsCard.vue';
import InsightsColumnChart from '../projects/insights/InsightsColumnChart.vue';
import InsightsDataTable from '../projects/insights/InsightsDataTable.vue';
import InsightsLineChart from '../projects/insights/InsightsLineChart.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { formatDateTime, formatDay } from '../../lib/insights/insights-format.js';
import { daysLabel, sowSteps, tasksBurnup, weeklyActivity } from '../../lib/pursuit/pursuit.js';

// An engagement's Insights tab, and the insights on a converted project's Pursuit tab.
// No stages: the SOW's state, the tasks, activity in channels and files, the people, and the
// engagement's age. The cards refresh on live events through `refreshVersion`, as project
// Insights do.

const props = defineProps({
  projectId: { required: true, type: String },
  refreshVersion: { default: 0, type: Number },
});

const payload = ref(null);
const loading = ref(false);
const loadError = ref('');
let sequence = 0;

const cards = computed(() => payload.value?.cards ?? {});
const refreshing = computed(() => loading.value && Boolean(payload.value));
const statusOf = (key) => (payload.value ? cards.value[key]?.status ?? 'error' : 'loading');
const sow = computed(() => cards.value.sow?.data ?? null);
const steps = computed(() => (sow.value?.linked ? sowSteps(sow.value) : []));
const tasks = computed(() => cards.value.tasks?.data ?? null);
const burnup = computed(() => (tasks.value ? tasksBurnup(tasks.value) : null));
const activity = computed(() => (cards.value.activity?.data ? weeklyActivity(cards.value.activity.data, (week) => formatDay(week)) : null));
const people = computed(() => cards.value.people?.data ?? null);
const age = computed(() => cards.value.age?.data ?? null);

async function load() {
  if (!props.projectId || !authSession.state.token) return;
  const current = ++sequence;
  loading.value = true;
  try {
    const result = await apiClient.passive.getPursuitInsights(props.projectId, authSession.state.token);
    if (current === sequence) {
      payload.value = result;
      loadError.value = '';
    }
  } catch (error) {
    if (current === sequence) loadError.value = error?.message || 'Insights could not load.';
  } finally {
    if (current === sequence) loading.value = false;
  }
}

watch(() => [props.projectId, props.refreshVersion], load, { immediate: true });
</script>

<template>
  <section class="insights pursuit-insights" aria-labelledby="pursuit-insights-title">
    <header class="insights-head">
      <div>
        <h2 id="pursuit-insights-title" class="insights-head__title">Insights</h2>
        <p v-if="payload" class="insights-head__lead">As of {{ formatDateTime(payload.asOf) }}</p>
      </div>
    </header>
    <div v-if="loadError" class="error-banner" role="alert">
      {{ loadError }}
      <button class="btn btn-sm btn-outline-secondary ms-2" type="button" @click="load">Retry</button>
    </div>

    <div class="insights-grid">
      <InsightsCard card-id="pursuit-card-sow" :message="cards.sow?.message ?? ''" :refreshing="refreshing" :status="statusOf('sow')" :table-available="false" title="SOW" size="wide">
        <div v-if="sow?.linked" class="pursuit-sow">
          <p class="pursuit-sow__title">
            <a v-if="sow.url" :href="sow.url" target="_blank" rel="noopener noreferrer">{{ sow.title || 'Statement of work' }} <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></a>
            <span v-else>{{ sow.title || 'Statement of work' }}</span>
          </p>
          <ol class="pursuit-sow__steps">
            <li v-for="step in steps" :key="step.state" class="pursuit-sow__step" :class="`pursuit-sow__step--${step.progress}`" :aria-current="step.progress === 'current' ? 'step' : undefined">
              <i class="bi" :class="step.progress === 'ahead' ? 'bi-circle' : step.progress === 'current' ? 'bi-record-circle-fill' : 'bi-check-circle-fill'" aria-hidden="true"></i>
              <span>{{ step.label }}</span>
              <small v-if="step.at">{{ formatDay(step.at, { withYear: true }) }}</small>
            </li>
          </ol>
        </div>
      </InsightsCard>

      <InsightsCard card-id="pursuit-card-age" :refreshing="refreshing" :status="statusOf('age')" :table-available="false" title="Age" size="narrow">
        <dl v-if="age" class="pursuit-tiles">
          <div><dt>Open for</dt><dd>{{ daysLabel(age.daysOpen) }}</dd></div>
          <div><dt>Since last activity</dt><dd>{{ daysLabel(age.daysSinceActivity) }}</dd></div>
        </dl>
      </InsightsCard>

      <InsightsCard card-id="pursuit-card-tasks" :message="cards.tasks?.message ?? ''" :refreshing="refreshing" :status="statusOf('tasks')" title="Tasks" size="full">
        <template #default="{ showTable }">
          <dl v-if="tasks" class="pursuit-tiles">
            <div><dt>Open</dt><dd>{{ tasks.counts.open }}</dd></div>
            <div><dt>Overdue</dt><dd :class="{ 'pursuit-tiles__alert': tasks.counts.overdue > 0 }">{{ tasks.counts.overdue }}</dd></div>
            <div><dt>Done</dt><dd>{{ tasks.counts.done }}</dd></div>
          </dl>
          <div class="pursuit-tasks">
            <div class="pursuit-tasks__chart">
              <InsightsDataTable v-if="showTable" caption="Tasks burnup" :columns="[{ key: 'date', label: 'Date' }, { key: 'scope', label: 'Tasks', numeric: true }, { key: 'done', label: 'Done', numeric: true }]" :rows="burnup.rows" />
              <InsightsLineChart v-else-if="burnup && tasks.burnup.length" :aria-label="burnup.ariaLabel" :height="200" :series="burnup.series" />
            </div>
            <div class="pursuit-tasks__due">
              <h4 class="pursuit-subhead">Next due</h4>
              <ul v-if="tasks?.nextDue?.length" class="pursuit-list">
                <li v-for="task in tasks.nextDue" :key="task.id">
                  <span class="pursuit-list__name">{{ task.name }}</span>
                  <small>{{ formatDay(task.dueDate) }}<template v-if="task.assigneeName"> · {{ task.assigneeName }}</template></small>
                </li>
              </ul>
              <p v-else class="muted-copy mb-0">Nothing due.</p>
            </div>
          </div>
        </template>
      </InsightsCard>

      <InsightsCard card-id="pursuit-card-activity" :message="cards.activity?.message ?? ''" :refreshing="refreshing" :status="statusOf('activity')" title="Activity" subtitle="Posts and file versions, last 8 weeks" size="wide">
        <template #default="{ showTable }">
          <InsightsDataTable v-if="showTable" caption="Activity by channel" :columns="[{ key: 'name', label: 'Channel' }, { key: 'posts', label: 'Posts', numeric: true }, { key: 'files', label: 'File versions', numeric: true }]" :rows="activity.channels" />
          <InsightsColumnChart v-else-if="activity" :aria-label="activity.ariaLabel" :categories="activity.categories" :height="200" :series="activity.series" />
          <p v-if="cards.activity?.data?.lastActivityAt" class="insights-card__note">Last activity {{ formatDateTime(cards.activity.data.lastActivityAt) }}</p>
        </template>
      </InsightsCard>

      <InsightsCard card-id="pursuit-card-people" :refreshing="refreshing" :status="statusOf('people')" title="People" size="narrow">
        <template #default="{ showTable }">
          <dl v-if="people" class="pursuit-tiles">
            <div><dt>Members</dt><dd>{{ people.counts.members }}</dd></div>
            <div><dt>Guests</dt><dd>{{ people.counts.guests }}</dd></div>
            <div><dt>Active, 7 days</dt><dd>{{ people.counts.active7 }}</dd></div>
            <div><dt>Active, 30 days</dt><dd>{{ people.counts.active30 }}</dd></div>
          </dl>
          <InsightsDataTable
            v-if="showTable && people"
            caption="People"
            :columns="[{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Role' }, { key: 'last', label: 'Last active' }]"
            :rows="people.people.map((person) => ({ key: person.id, kind: person.kind === 'guest' ? 'Guest' : 'Member', last: person.lastActiveOn ? formatDay(person.lastActiveOn) : '—', name: person.name }))"
          />
          <ul v-else-if="people?.people?.some((person) => person.active30)" class="pursuit-list">
            <li v-for="person in people.people.filter((entry) => entry.active30)" :key="person.id">
              <span class="pursuit-list__name">{{ person.name }}</span>
              <small>{{ person.active7 ? 'This week' : 'This month' }}</small>
            </li>
          </ul>
        </template>
      </InsightsCard>
    </div>
  </section>
</template>

<style scoped>
.pursuit-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
  gap: 0.5rem;
  margin: 0;
}

.pursuit-tiles dt {
  color: var(--muted);
  font-size: 0.75rem;
  font-weight: 500;
}

.pursuit-tiles dd {
  margin: 0.1rem 0 0;
  font-size: 1.25rem;
  font-weight: 600;
}

.pursuit-tiles__alert {
  color: var(--bs-danger-text-emphasis, #b3261e);
}

.pursuit-tasks {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 1rem;
}

.pursuit-subhead {
  margin: 0 0 0.35rem;
  font-size: 0.8125rem;
  font-weight: 600;
}

.pursuit-list {
  display: grid;
  gap: 0.35rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pursuit-list li {
  display: grid;
  min-width: 0;
}

.pursuit-list__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pursuit-list small {
  color: var(--muted);
}

.pursuit-sow__title {
  margin: 0 0 0.5rem;
  font-weight: 600;
}

.pursuit-sow__steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pursuit-sow__step {
  display: grid;
  gap: 0.15rem;
  justify-items: start;
  font-size: 0.8125rem;
}

.pursuit-sow__step small {
  color: var(--muted);
}

.pursuit-sow__step--ahead {
  color: var(--muted);
}

.pursuit-sow__step--current {
  font-weight: 600;
}

@media (max-width: 48rem) {
  .pursuit-tasks,
  .pursuit-sow__steps {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
