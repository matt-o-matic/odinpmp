<script setup>
import { computed, onMounted, reactive, ref } from 'vue';

import { apiClient, authSession } from '../lib/auth/index.js';
import {
  DEFAULT_LEADERBOARD_DAYS,
  LEADERBOARD_PERIODS,
  POINT_RULES,
  avatarUrl,
  formatHours,
  leaderboardRows,
  positionSummary,
} from '../lib/metrics/leaderboard.js';
import { avatarColor, initials } from '../lib/requirements/requirements-topics.js';

const days = ref(DEFAULT_LEADERBOARD_DAYS);
const errorMessage = ref('');
const loading = ref(true);
const result = ref(null);
const failedAvatars = reactive(new Set());
let requestSequence = 0;

const rows = computed(() => leaderboardRows(result.value ?? {}));
const summary = computed(() => positionSummary(result.value ?? { days: days.value }));

async function loadLeaderboard() {
  if (!authSession.state.token) {
    result.value = null;
    loading.value = false;
    return;
  }

  const sequence = ++requestSequence;
  loading.value = true;
  errorMessage.value = '';

  try {
    const response = await apiClient.getContributorLeaderboard({ days: days.value }, authSession.state.token);
    if (sequence === requestSequence) result.value = response;
  } catch (error) {
    if (sequence === requestSequence) errorMessage.value = error.message ?? 'Unable to load the leaderboard.';
  } finally {
    if (sequence === requestSequence) loading.value = false;
  }
}

function choosePeriod(value) {
  if (days.value === value) return;
  days.value = value;
  loadLeaderboard();
}

function pictureFor(row) {
  return failedAvatars.has(row.id) ? '' : avatarUrl(row.picture, authSession.state.apiBaseUrl);
}

onMounted(loadLeaderboard);
</script>

<template>
  <section class="leaderboard-page" aria-labelledby="leaderboard-title">
    <header class="leaderboard-header">
      <div>
        <h1 id="leaderboard-title">Leaderboard</h1>
        <p>Who finished the most work in this workspace.</p>
      </div>
      <fieldset class="leaderboard-periods">
        <legend class="visually-hidden">Period</legend>
        <template v-for="period in LEADERBOARD_PERIODS" :key="period.days">
          <input
            :id="`leaderboard-period-${period.days}`"
            class="btn-check"
            type="radio"
            name="leaderboard-period"
            :value="period.days"
            :checked="days === period.days"
            @change="choosePeriod(period.days)"
          />
          <label class="btn btn-sm btn-outline-primary" :for="`leaderboard-period-${period.days}`">{{ period.label }}</label>
        </template>
      </fieldset>
    </header>

    <div v-if="errorMessage" class="alert alert-danger" role="alert">{{ errorMessage }}</div>

    <p v-if="loading" class="leaderboard-status" role="status">
      <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
      Loading the leaderboard…
    </p>

    <template v-else-if="!errorMessage">
      <section v-if="rows.length === 0" class="leaderboard-empty" aria-labelledby="leaderboard-empty-title">
        <i class="bi bi-trophy" aria-hidden="true"></i>
        <h2 id="leaderboard-empty-title">No completed work in the last {{ days }} days</h2>
        <p>Points appear here as soon as someone finishes work.</p>
        <ul class="leaderboard-rules">
          <li v-for="rule in POINT_RULES" :key="rule">{{ rule }}</li>
        </ul>
      </section>

      <template v-else>
        <p class="leaderboard-position" :class="{ 'leaderboard-position--ranked': result?.currentUser }">
          <i class="bi bi-person-check" aria-hidden="true"></i>
          {{ summary }}
        </p>

        <div class="leaderboard-table-wrap" role="region" aria-label="Contributor rankings" tabindex="0">
          <table class="table table-sm align-middle leaderboard-table">
            <caption class="visually-hidden">Top contributors in the last {{ days }} days, ranked by points</caption>
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Contributor</th>
                <th scope="col" class="text-end">Points</th>
                <th scope="col" class="text-end">Items done</th>
                <th scope="col" class="text-end">Hours</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in rows" :key="row.id">
                <tr v-if="row.detached" class="leaderboard-gap" aria-hidden="true">
                  <td colspan="5"><i class="bi bi-three-dots" aria-hidden="true"></i></td>
                </tr>
                <tr :class="{ 'leaderboard-row--me': row.isCurrentUser }" :aria-current="row.isCurrentUser ? 'true' : undefined">
                  <td class="leaderboard-rank" data-label="Rank">#{{ row.rank }}</td>
                  <td class="leaderboard-person-cell" data-label="Contributor">
                    <div class="leaderboard-person">
                      <img
                        v-if="pictureFor(row)"
                        class="leaderboard-avatar"
                        :src="pictureFor(row)"
                        alt=""
                        @error="failedAvatars.add(row.id)"
                      />
                      <span v-else class="rq-avatar leaderboard-avatar" :style="{ '--c': avatarColor(row.id) }" aria-hidden="true">{{ initials(row.name) }}</span>
                      <span class="leaderboard-name">{{ row.name }}</span>
                      <span v-if="row.isCurrentUser" class="badge text-bg-primary">You</span>
                    </div>
                  </td>
                  <td class="text-end leaderboard-metric" data-label="Points"><strong>{{ row.points }}</strong></td>
                  <td class="text-end leaderboard-metric" data-label="Items done">{{ row.tasksCompleted }}</td>
                  <td class="text-end leaderboard-metric" data-label="Hours">{{ formatHours(row.hoursLogged) }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <details class="leaderboard-help">
          <summary><i class="bi bi-info-circle" aria-hidden="true"></i> How points are earned</summary>
          <ul class="leaderboard-rules">
            <li v-for="rule in POINT_RULES" :key="rule">{{ rule }}</li>
          </ul>
        </details>
      </template>
    </template>
  </section>
</template>

<style scoped>
.leaderboard-page{padding:1rem 1.5rem 2rem;font-size:.875rem;line-height:1.25}
.leaderboard-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1rem}
.leaderboard-header h1{font-size:1.375rem;line-height:1.2;margin:0}
.leaderboard-header p{color:var(--bs-secondary-color);margin:.25rem 0 0}
.leaderboard-periods{display:flex;gap:.25rem;margin:0;padding:0;border:0}
.leaderboard-periods .btn{min-height:2.75rem;min-width:5rem;display:inline-flex;align-items:center;justify-content:center}
.leaderboard-periods .btn-check:focus-visible + .btn{outline:.18rem solid var(--bs-primary);outline-offset:.1rem}
.leaderboard-status{display:flex;align-items:center;gap:.5rem;color:var(--bs-secondary-color);padding:1rem 0}
.leaderboard-position{display:flex;align-items:center;gap:.5rem;margin:0 0 .75rem;padding:.5rem .75rem;border:1px solid var(--bs-border-color);border-radius:.5rem;color:var(--bs-secondary-color)}
.leaderboard-position--ranked{color:var(--bs-body-color);border-left:.25rem solid var(--bs-primary)}
.leaderboard-table-wrap{border:1px solid var(--bs-border-color);border-radius:.5rem;overflow-x:auto}
.leaderboard-table-wrap:focus-visible{outline:.18rem solid var(--bs-primary);outline-offset:.1rem}
.leaderboard-table{margin:0}
.leaderboard-table th{font-size:.75rem;color:var(--bs-secondary-color);white-space:nowrap;background:var(--bs-body-bg)}
.leaderboard-table td,.leaderboard-table th{padding:.5rem .75rem}
.leaderboard-rank{font-weight:700;white-space:nowrap;width:4rem}
.leaderboard-person{display:flex;align-items:center;gap:.5rem;min-width:0}
.leaderboard-avatar{width:2rem;height:2rem;border-radius:999px;object-fit:cover;flex:0 0 auto}
.leaderboard-name{overflow-wrap:anywhere}
.leaderboard-metric{white-space:nowrap;font-variant-numeric:tabular-nums}
.leaderboard-row--me > td{background:var(--bs-tertiary-bg)}
.leaderboard-row--me > td:first-child{box-shadow:inset .25rem 0 0 var(--bs-primary)}
.leaderboard-gap td{text-align:center;color:var(--bs-secondary-color);padding:.25rem}
.leaderboard-empty{display:grid;justify-items:center;gap:.5rem;padding:2rem 1rem;border:1px dashed var(--bs-border-color);border-radius:.5rem;text-align:center}
.leaderboard-empty > .bi{font-size:1.5rem;color:var(--bs-secondary-color)}
.leaderboard-empty h2{font-size:1.125rem;line-height:1.2;margin:0}
.leaderboard-empty p{margin:0;color:var(--bs-secondary-color)}
.leaderboard-rules{margin:.25rem 0 0;padding-inline-start:1.25rem;text-align:left;max-width:120ch}
.leaderboard-rules li + li{margin-top:.25rem}
.leaderboard-help{margin-top:1rem}
.leaderboard-help summary{display:inline-flex;align-items:center;gap:.4rem;min-height:2.75rem;cursor:pointer;color:var(--accent-dark);font-weight:600}
html.dark .leaderboard-help summary{color:var(--accent)}
.leaderboard-help summary:focus-visible{outline:.18rem solid var(--bs-primary);outline-offset:.1rem;border-radius:.25rem}
@media(max-width:36rem){
.leaderboard-page{padding:.75rem}
.leaderboard-header{display:grid}
.leaderboard-periods{width:100%}
.leaderboard-periods .btn{flex:1;min-width:0}
.leaderboard-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.leaderboard-table tbody tr:not(.leaderboard-gap){display:grid;grid-template-columns:3rem repeat(3,minmax(0,1fr));grid-template-areas:"rank person person person" ". points items hours";column-gap:.75rem;row-gap:.25rem;padding:.5rem .75rem;border-bottom:1px solid var(--bs-border-color)}
.leaderboard-table tbody tr > td{background:transparent;box-shadow:none}
.leaderboard-table tbody tr:not(.leaderboard-gap) > td{padding:0;border:0;width:auto}
.leaderboard-table tbody tr.leaderboard-row--me{background:var(--bs-tertiary-bg);box-shadow:inset .25rem 0 0 var(--bs-primary)}
.leaderboard-table tbody tr.leaderboard-row--me > td{background:transparent;box-shadow:none}
.leaderboard-rank{grid-area:rank}
.leaderboard-person-cell{grid-area:person}
.leaderboard-metric{text-align:left!important;color:var(--bs-secondary-color)}
.leaderboard-metric::before{content:attr(data-label) " ";font-size:.75rem}
.leaderboard-row--me .leaderboard-metric{color:var(--bs-body-color)}
.leaderboard-table tbody tr > td:nth-child(3){grid-area:points}
.leaderboard-table tbody tr > td:nth-child(4){grid-area:items}
.leaderboard-table tbody tr > td:nth-child(5){grid-area:hours}
.leaderboard-gap td{display:block}
}
</style>
