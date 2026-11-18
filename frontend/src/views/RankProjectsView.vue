<script setup>
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';

import { apiClient, authSession } from '../lib/auth/index.js';
import { formatDateRange } from '../lib/projects/project-editor.js';

const errorMessage = ref('');
const currentPair = ref(null);
const completionStatus = ref(null);
const leaderboard = ref([]);
const headToHead = ref(null);
const view = ref('ranking'); // ranking | done | leaderboard | headToHead
const working = ref(false);

const threshold = 70;

const progressText = computed(() => {
  if (!completionStatus.value) {
    return '';
  }
  return `${completionStatus.value.completionPercentage}%`;
});

function statusBadgeClass(status) {
  const normalized = String(status ?? '').toLowerCase();

  if (normalized.includes('progress')) return 'badge bg-primary';
  if (normalized.includes('completed')) return 'badge bg-success';
  if (normalized.includes('hold') || normalized.includes('risk')) return 'badge bg-warning text-dark';
  if (normalized.includes('cancel')) return 'badge bg-danger';
  return 'badge bg-secondary';
}

async function loadCompletionStatus() {
  if (!authSession.state.token) {
    return;
  }

  try {
    const result = await apiClient.getRankingCompletionStatus({ threshold }, authSession.state.token);
    completionStatus.value = result.status;
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load ranking progress.';
  }
}

async function loadLeaderboard() {
  if (!authSession.state.token) {
    return;
  }

  const result = await apiClient.getRankingLeaderboard(authSession.state.token);
  leaderboard.value = result.leaderboard ?? [];
}

async function fetchPair() {
  if (!authSession.state.token) {
    return;
  }

  errorMessage.value = '';
  working.value = true;

  try {
    const result = await apiClient.getNextRankingPair(authSession.state.token);
    currentPair.value = result.pair;

    if (!currentPair.value?.projectA || !currentPair.value?.projectB) {
      await loadCompletionStatus();

      if (completionStatus.value?.isComplete) {
        await loadLeaderboard();
        view.value = 'leaderboard';
      } else {
        view.value = 'done';
      }
      return;
    }

    view.value = 'ranking';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load the next ranking pair.';
  } finally {
    working.value = false;
  }
}

async function submitVote(winnerId, loserId) {
  if (!authSession.state.token) {
    return;
  }

  errorMessage.value = '';
  working.value = true;

  try {
    await apiClient.submitRankingVote({ winnerId, loserId }, authSession.state.token);
    await loadCompletionStatus();
    await fetchPair();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to submit the ranking vote.';
    working.value = false;
  }
}

async function skipPair() {
  if (!authSession.state.token || !currentPair.value) {
    return;
  }

  errorMessage.value = '';
  working.value = true;

  try {
    await apiClient.skipRankingPair(
      {
        projectAId: currentPair.value.projectA.id,
        projectBId: currentPair.value.projectB.id,
      },
      authSession.state.token,
    );
    await loadCompletionStatus();
    await fetchPair();
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to skip the pair.';
    working.value = false;
  }
}

function viewLeaderboard() {
  view.value = 'leaderboard';
  headToHead.value = null;
}

function continueRanking() {
  view.value = 'ranking';
  headToHead.value = null;
  fetchPair();
}

async function openHeadToHead(project) {
  if (!authSession.state.token || !project?.id) {
    return;
  }

  errorMessage.value = '';
  working.value = true;

  try {
    const result = await apiClient.getRankingHeadToHead(project.id, authSession.state.token);
    headToHead.value = result;
    view.value = 'headToHead';
  } catch (error) {
    errorMessage.value = error.message ?? 'Unable to load head-to-head details.';
  } finally {
    working.value = false;
  }
}

onMounted(async () => {
  await loadCompletionStatus();
  await fetchPair();
});
</script>

<template>
  <section class="dashboard-panel">
    <div class="actions-row actions-row--spaced">
      <div>
        <p class="section-eyebrow">Ranking</p>
        <h2 class="hero-title">Which project is more important?</h2>
      </div>
      <div v-if="completionStatus" class="muted-copy">
        Progress: <strong>{{ progressText }}</strong>
      </div>
    </div>

    <div v-if="errorMessage" class="error-banner" style="margin-top: 1rem">{{ errorMessage }}</div>

    <div v-if="view === 'ranking' && currentPair" class="rank-grid" style="margin-top: 1.25rem">
      <article class="rank-card">
        <div class="rank-card__body">
          <h3 class="rank-card__title">{{ currentPair.projectA.name }}</h3>
          <p class="rank-card__meta">
            <span :class="statusBadgeClass(currentPair.projectA.status)">{{ currentPair.projectA.status || 'No status' }}</span>
            <span v-if="currentPair.projectA.userRole" class="muted-copy" style="margin-left: 0.5rem">Role: {{ currentPair.projectA.userRole }}</span>
          </p>
          <p class="muted-copy" style="margin-top: 0.5rem">
            {{ formatDateRange(currentPair.projectA.startDate, currentPair.projectA.endDate) }}
          </p>

          <div class="rank-card__description rich-copy" v-html="currentPair.projectA.description"></div>

          <div class="rank-stats">
            <div>
              <strong>{{ currentPair.projectA.taskStats?.totalTasks ?? 0 }}</strong>
              <span class="muted-copy">Tasks</span>
            </div>
            <div>
              <strong>{{ currentPair.projectA.taskStats?.topLevelTasks ?? 0 }}</strong>
              <span class="muted-copy">Epics</span>
            </div>
            <div>
              <strong>{{ currentPair.projectA.taskStats?.totalPoints ?? 0 }}</strong>
              <span class="muted-copy">Points</span>
            </div>
            <div>
              <strong>{{ currentPair.projectA.taskStats?.totalEstimatedHours ?? 0 }}</strong>
              <span class="muted-copy">Hours</span>
            </div>
          </div>
        </div>

        <button
          class="primary-button"
          type="button"
          :disabled="working"
          @click="submitVote(currentPair.projectA.id, currentPair.projectB.id)"
        >
          This project is more important
        </button>
      </article>

      <article class="rank-card">
        <div class="rank-card__body">
          <h3 class="rank-card__title">{{ currentPair.projectB.name }}</h3>
          <p class="rank-card__meta">
            <span :class="statusBadgeClass(currentPair.projectB.status)">{{ currentPair.projectB.status || 'No status' }}</span>
            <span v-if="currentPair.projectB.userRole" class="muted-copy" style="margin-left: 0.5rem">Role: {{ currentPair.projectB.userRole }}</span>
          </p>
          <p class="muted-copy" style="margin-top: 0.5rem">
            {{ formatDateRange(currentPair.projectB.startDate, currentPair.projectB.endDate) }}
          </p>

          <div class="rank-card__description rich-copy" v-html="currentPair.projectB.description"></div>

          <div class="rank-stats">
            <div>
              <strong>{{ currentPair.projectB.taskStats?.totalTasks ?? 0 }}</strong>
              <span class="muted-copy">Tasks</span>
            </div>
            <div>
              <strong>{{ currentPair.projectB.taskStats?.topLevelTasks ?? 0 }}</strong>
              <span class="muted-copy">Epics</span>
            </div>
            <div>
              <strong>{{ currentPair.projectB.taskStats?.totalPoints ?? 0 }}</strong>
              <span class="muted-copy">Points</span>
            </div>
            <div>
              <strong>{{ currentPair.projectB.taskStats?.totalEstimatedHours ?? 0 }}</strong>
              <span class="muted-copy">Hours</span>
            </div>
          </div>
        </div>

        <button
          class="primary-button"
          type="button"
          :disabled="working"
          @click="submitVote(currentPair.projectB.id, currentPair.projectA.id)"
        >
          This project is more important
        </button>
      </article>
    </div>

    <div v-if="view === 'ranking'" class="actions-row" style="margin-top: 1rem">
      <button class="secondary-button" type="button" :disabled="working" @click="skipPair">
        Skip pair
      </button>
      <RouterLink class="pill-link" to="/projects">Back to projects</RouterLink>
    </div>

    <div v-else-if="view === 'done' && completionStatus" style="margin-top: 1.5rem">
      <div class="workbench-card">
        <div class="workbench-card__header">
          <div>
            <p class="card-eyebrow">Progress</p>
            <h3 class="workbench-card__title">{{ completionStatus.completionPercentage }}%</h3>
          </div>
        </div>
        <p class="panel-copy">
          Votes cast: <strong>{{ completionStatus.userVotes }}</strong> / <strong>{{ completionStatus.totalPairs }}</strong>
        </p>
        <div class="actions-row" style="margin-top: 1rem">
          <button
            v-if="completionStatus.isComplete"
            class="primary-button"
            type="button"
            @click="viewLeaderboard"
          >
            View leaderboard
          </button>
          <RouterLink class="pill-link" to="/projects">Back to projects</RouterLink>
        </div>
      </div>
    </div>

    <div v-else-if="view === 'leaderboard'" style="margin-top: 1.5rem">
      <div class="actions-row actions-row--spaced">
        <div>
          <p class="section-eyebrow">Ranking</p>
          <h2 class="panel-title">Project Leaderboard</h2>
        </div>
        <button class="secondary-button" type="button" @click="continueRanking">Continue ranking</button>
      </div>

      <div class="project-table-wrap" style="margin-top: 1rem">
        <table class="project-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Project</th>
              <th>Status</th>
              <th>Wins</th>
              <th>Total Votes</th>
              <th>Win Rate</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="project in leaderboard" :key="project.id">
              <td>{{ project.rank ?? '—' }}</td>
              <td>
                <button class="task-table__link" type="button" @click="openHeadToHead(project)">
                  {{ project.name }}
                </button>
              </td>
              <td><span class="tree-badge">{{ project.status }}</span></td>
              <td>{{ project.wins }}</td>
              <td>{{ project.totalComparisons }}</td>
              <td>{{ project.winPercentage }}%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-else-if="view === 'headToHead' && headToHead" style="margin-top: 1.5rem">
      <div class="actions-row actions-row--spaced">
        <div>
          <p class="section-eyebrow">Ranking</p>
          <h2 class="panel-title">Head-to-Head Details: {{ headToHead.project.name }}</h2>
        </div>
        <button class="secondary-button" type="button" @click="viewLeaderboard">Back to leaderboard</button>
      </div>

      <div class="rank-stats" style="margin-top: 1rem">
        <div>
          <strong>{{ headToHead.overallStats.totalWins }}</strong>
          <span class="muted-copy">Total wins</span>
        </div>
        <div>
          <strong>{{ headToHead.overallStats.totalVotes }}</strong>
          <span class="muted-copy">Total votes</span>
        </div>
        <div>
          <strong>{{ headToHead.overallStats.winPercentage }}%</strong>
          <span class="muted-copy">Win rate</span>
        </div>
      </div>

      <div class="project-table-wrap" style="margin-top: 1rem">
        <table class="project-table">
          <thead>
            <tr>
              <th>Opponent</th>
              <th>Wins</th>
              <th>Losses</th>
              <th>Total</th>
              <th>Win Rate</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="opponent in headToHead.opponents" :key="opponent.id">
              <td>{{ opponent.name }}</td>
              <td>{{ opponent.wins }}</td>
              <td>{{ opponent.losses }}</td>
              <td>{{ opponent.totalVotes }}</td>
              <td>{{ opponent.winPercentage }}%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.rank-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}

.rank-card {
  display: grid;
  gap: 1rem;
  padding: 0.9rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: var(--shadow);
  min-width: 0;
}

.rank-card__body {
  min-width: 0;
}

.rank-card__title {
  margin: 0;
  font-size: 1.4rem;
  letter-spacing: -0.03em;
}

.rank-card__meta {
  margin: 0.45rem 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
  align-items: center;
}

.rank-card__description {
  margin-top: 0.8rem;
  max-height: 12rem;
  overflow: auto;
  border: 1px solid rgba(20, 60, 96, 0.1);
  border-radius: 0.5rem;
  padding: 0.75rem 0.8rem;
  background: rgba(248, 250, 253, 0.9);
}

.rank-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
  margin-top: 1rem;
}

.rank-stats div {
  display: grid;
  gap: 0.25rem;
  padding: 0.55rem 0.6rem;
  border: 1px solid rgba(20, 60, 96, 0.12);
  border-radius: 0.5rem;
  background: rgba(246, 249, 252, 0.95);
}

.rank-stats strong {
  font-size: 1.15rem;
}

@media (max-width: 1080px) {
  .rank-grid {
    grid-template-columns: 1fr;
  }

  .rank-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
