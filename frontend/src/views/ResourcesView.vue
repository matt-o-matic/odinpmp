<script setup>
import { computed, onMounted, reactive, ref, useId, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import RequirementsConfirmDialog from '../components/requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../components/requirements/RequirementsDialog.vue';
import ResourceProfileDialog from '../components/resources/ResourceProfileDialog.vue';
import { apiClient, authSession } from '../lib/auth/index.js';
import { useWorkspaceLiveRefresh } from '../lib/live/live-refresh.js';
import { amountText, initials, money, parseAmount, skillLevelLabel } from '../lib/resources/resources.js';
import { resourceProfileErrorMessage } from '../lib/task-access/task-access-admin.js';

// Resources: the people who do the work. Browse the directory; adding or editing a person, an
// allocation or time off opens its own dialog. Finance (ledgers, rates history, time, expenses)
// lives on its own page.

const route = useRoute();
const router = useRouter();
const uid = useId();
const fieldId = (name) => `resources-${uid}-${name}`;
const token = computed(() => authSession.state.token);

const emptyWorkspace = () => ({ allocations: [], analysis: { forecasts: [], levelingRecommendations: [], scenarios: [], weekly: [] }, calendarEntries: [], canManageFinance: false, canManageResources: false, capacity: [], pools: [], projects: [], resources: [], total: 0, users: [] });
const workspace = ref(emptyWorkspace());
const loading = ref(true);
const errorMessage = ref('');
const successMessage = ref('');
const activeTab = ref('people');
const filters = reactive({ login: 'all', poolId: '', query: '', scenario: 'baseline', status: 'active' });
const TABS = [['people', 'People', 'bi-people'], ['allocations', 'Allocations', 'bi-calendar2-range'], ['timeoff', 'Time off', 'bi-airplane'], ['planning', 'Planning', 'bi-graph-up']];

// `quiet` reloads after someone else's change: the page stays as it is while it loads, and on
// failure. The latest load wins, so a reload never overwrites a newer scenario.
let loadSequence = 0;
async function load({ quiet = false } = {}) {
  const sequence = ++loadSequence;
  if (!quiet) {
    loading.value = true;
    errorMessage.value = '';
  }
  try {
    const result = await (quiet ? apiClient.passive : apiClient).getResourceFinanceWorkspace({ limit: 200, scenario: filters.scenario }, token.value);
    if (sequence === loadSequence) workspace.value = { ...emptyWorkspace(), ...result, analysis: { ...emptyWorkspace().analysis, ...(result.analysis ?? {}) } };
  } catch (error) {
    if (!quiet && sequence === loadSequence) errorMessage.value = error.message ?? 'Unable to load resources.';
  } finally {
    if (!quiet && sequence === loadSequence) loading.value = false;
  }
}
onMounted(async () => {
  await load();
  openFromQuery();
});
watch(() => filters.scenario, () => load());
// People, allocations and time off changed elsewhere, by people, the assistant or MCP clients.
useWorkspaceLiveRefresh(['resources'], () => {
  if (!loading.value) load({ quiet: true });
});
watch(() => route.query.resource, openFromQuery);

const canManage = computed(() => workspace.value.canManageResources);
const canSeeRates = computed(() => workspace.value.canManageFinance);
const resourceMap = computed(() => new Map(workspace.value.resources.map((item) => [item.id, item])));
const projectMap = computed(() => new Map(workspace.value.projects.map((item) => [item.id, item])));
const poolMap = computed(() => new Map(workspace.value.pools.map((item) => [item.id, item])));
const capacityMap = computed(() => new Map(workspace.value.capacity.map((item) => [item.resourceId, item])));
const userMap = computed(() => new Map(workspace.value.users.map((item) => [item.id, item])));
const LIVE = new Set(['proposed', 'approved', 'active', 'held']);
const liveByResource = computed(() => {
  const map = new Map();
  for (const allocation of workspace.value.allocations.filter((entry) => LIVE.has(entry.status))) {
    map.set(allocation.resourceId, [...(map.get(allocation.resourceId) ?? []), allocation]);
  }
  return map;
});
const unlinkedUsers = computed(() => {
  const linked = new Set(workspace.value.resources.map((resource) => resource.userId).filter(Boolean));
  return workspace.value.users.filter((user) => !linked.has(user.id));
});

const people = computed(() => {
  const text = filters.query.trim().toLowerCase();
  return workspace.value.resources.filter((resource) => {
    if (filters.status && resource.status !== filters.status) return false;
    if (filters.poolId && (resource.poolId ?? 'none') !== filters.poolId) return false;
    if (filters.login === 'linked' && !resource.userId) return false;
    if (filters.login === 'none' && resource.userId) return false;
    if (!text) return true;
    const haystack = `${resource.name} ${resource.location} ${(resource.roles ?? []).join(' ')} ${(resource.skills ?? []).map((skill) => skill.name).join(' ')} ${userMap.value.get(resource.userId)?.email ?? ''}`;
    return haystack.toLowerCase().includes(text);
  });
});
const PAGE_SIZE = 24;
const page = ref(1);
const pages = computed(() => Math.max(1, Math.ceil(people.value.length / PAGE_SIZE)));
const pagePeople = computed(() => people.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));
watch(() => [filters.query, filters.status, filters.poolId, filters.login], () => { page.value = 1; });

function utilization(resource) {
  const entry = capacityMap.value.get(resource.id);
  const available = entry?.availableHours ?? resource.capacityHoursPerWeek;
  const allocated = entry?.allocatedHours ?? 0;
  const percent = available ? Math.round((allocated / available) * 100) : allocated ? 100 : 0;
  return { allocated, available, over: Boolean(entry?.overallocated), percent };
}
function topSkills(resource) {
  return [...(resource.skills ?? [])].sort((left, right) => right.level - left.level || left.name.localeCompare(right.name));
}
function flash(message) {
  successMessage.value = message;
  errorMessage.value = '';
}

// ---- Profile dialog ----
const profile = reactive({ busy: false, error: '', open: false, preset: null, resource: null });
function openProfile(resource = null, preset = null) {
  Object.assign(profile, { busy: false, error: '', open: true, preset, resource });
}
function openFromQuery() {
  const id = route.query.resource;
  if (!id || loading.value) return;
  const resource = resourceMap.value.get(String(id));
  if (resource && canManage.value) openProfile(resource);
}
function closeProfile() {
  if (profile.busy) return;
  profile.open = false;
  if (route.query.resource) router.replace({ query: { ...route.query, resource: undefined } });
}
async function saveProfile(payload) {
  profile.busy = true;
  profile.error = '';
  try {
    if (profile.resource) await apiClient.updateEnterpriseResource(profile.resource.id, { ...payload, expectedVersion: profile.resource.version }, token.value);
    else await apiClient.createEnterpriseResource(payload, token.value);
    const name = payload.name;
    profile.busy = false;
    closeProfile();
    await load();
    flash(profile.resource ? `${name} saved.` : `${name} added.`);
  } catch (error) {
    profile.error = resourceProfileErrorMessage(error);
    profile.busy = false;
  }
}
// The profile dialog stays open after turning off a link; the directory reloads behind it.
async function profileLinkRevoked({ resource, revoked }) {
  await load();
  flash(revoked ? `${resource.name}’s task link is turned off.` : `${resource.name} had no task link to turn off.`);
}

// ---- Allocation dialog ----
const allocation = reactive({ busy: false, error: '', open: false, record: null });
const allocationForm = reactive({});
function today() { return new Date().toISOString().slice(0, 10); }
function plusDays(days, from = today()) { const value = new Date(`${from}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function openAllocation(record = null, resourceId = '') {
  Object.assign(allocation, { busy: false, error: '', open: true, record });
  Object.assign(allocationForm, record
    ? { ...record, allocationPercent: String(record.allocationPercent), billRate: amountText(record.billRate ?? ''), hoursPerWeek: String(record.hoursPerWeek) }
    : { allocationPercent: '', billRate: '', endDate: plusDays(90), hoursPerWeek: '', projectId: '', resourceId, role: '', scenario: filters.scenario || 'baseline', startDate: today(), status: 'proposed' });
}
const allocationResource = computed(() => resourceMap.value.get(allocationForm.resourceId) ?? null);
function syncPercent() {
  const hours = parseAmount(allocationForm.hoursPerWeek, { max: 168 });
  const capacity = Number(allocationResource.value?.capacityHoursPerWeek) || 40;
  if (!hours.error && hours.value != null) allocationForm.allocationPercent = String(Math.round((hours.value / capacity) * 1000) / 10);
}
async function saveAllocation() {
  allocation.error = '';
  if (!allocationForm.resourceId || !allocationForm.projectId) { allocation.error = 'Choose a person and a project.'; return; }
  const hours = parseAmount(allocationForm.hoursPerWeek, { label: 'Hours per week', max: 168 });
  const percent = parseAmount(allocationForm.allocationPercent, { label: 'Allocation', max: 200 });
  const rate = parseAmount(allocationForm.billRate, { label: 'Project rate' });
  const problem = hours.error || percent.error || (canSeeRates.value && rate.error) || (allocationForm.endDate < allocationForm.startDate ? 'The end date is before the start date.' : '');
  if (problem) { allocation.error = problem; return; }
  const payload = {
    allocationPercent: percent.value ?? 0, endDate: allocationForm.endDate, hoursPerWeek: hours.value ?? 0, projectId: allocationForm.projectId,
    resourceId: allocationForm.resourceId, role: String(allocationForm.role ?? '').trim(), scenario: allocationForm.scenario, startDate: allocationForm.startDate, status: allocationForm.status,
    ...(canSeeRates.value ? { billRate: rate.value } : {}),
  };
  allocation.busy = true;
  try {
    if (allocation.record) await apiClient.updateResourceAllocation(allocation.record.id, { ...payload, expectedVersion: allocation.record.version }, token.value);
    else await apiClient.createResourceAllocation(payload, token.value);
    allocation.open = false;
    await load();
    flash('Allocation saved.');
  } catch (error) {
    allocation.error = error.message ?? 'Unable to save the allocation.';
  } finally {
    allocation.busy = false;
  }
}

// ---- Time off dialog ----
const timeOff = reactive({ busy: false, error: '', open: false, record: null });
const timeOffForm = reactive({});
const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
function openTimeOff(record = null) {
  Object.assign(timeOff, { busy: false, error: '', open: true, record });
  Object.assign(timeOffForm, record
    ? { ...record, hoursPerDay: String(record.hoursPerDay), weekdays: [...(record.weekdays ?? [1, 2, 3, 4, 5])] }
    : { endDate: today(), entryType: 'leave', hoursPerDay: '8', note: '', resourceId: people.value[0]?.id ?? '', startDate: today(), status: 'approved', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', weekdays: [1, 2, 3, 4, 5] });
}
async function saveTimeOff() {
  timeOff.error = '';
  const hours = parseAmount(timeOffForm.hoursPerDay, { label: 'Hours per day', max: 24 });
  if (hours.error) { timeOff.error = hours.error; return; }
  if (!timeOffForm.resourceId) { timeOff.error = 'Choose a person.'; return; }
  if (timeOffForm.endDate < timeOffForm.startDate) { timeOff.error = 'The end date is before the start date.'; return; }
  if (!timeOffForm.weekdays.length) { timeOff.error = 'Pick at least one weekday.'; return; }
  const payload = {
    endDate: timeOffForm.endDate, entryType: timeOffForm.entryType, hoursPerDay: hours.value ?? 0, note: String(timeOffForm.note ?? '').trim(),
    resourceId: timeOffForm.resourceId, startDate: timeOffForm.startDate, status: timeOffForm.status, timezone: timeOffForm.timezone, weekdays: timeOffForm.weekdays,
  };
  timeOff.busy = true;
  try {
    if (timeOff.record) await apiClient.updateResourceCalendarEntry(timeOff.record.id, { ...payload, expectedVersion: timeOff.record.version }, token.value);
    else await apiClient.createResourceCalendarEntry(payload, token.value);
    timeOff.open = false;
    await load();
    flash('Time off saved.');
  } catch (error) {
    timeOff.error = error.message ?? 'Unable to save time off.';
  } finally {
    timeOff.busy = false;
  }
}
const ENTRY_LABELS = { holiday: 'Holiday', leave: 'Leave', working_override: 'Working override' };
const timeOffEntries = computed(() => [...workspace.value.calendarEntries].sort((left, right) => right.startDate.localeCompare(left.startDate)));

// ---- Pool dialog ----
const pool = reactive({ busy: false, description: '', error: '', name: '', open: false });
function openPool() { Object.assign(pool, { busy: false, description: '', error: '', name: '', open: true }); }
async function savePool() {
  if (!pool.name.trim()) { pool.error = 'Name the pool.'; return; }
  pool.busy = true;
  try {
    await apiClient.createResourcePool({ description: pool.description.trim(), name: pool.name.trim() }, token.value);
    pool.open = false;
    await load();
    flash('Pool added.');
  } catch (error) {
    pool.error = error.message ?? 'Unable to add the pool.';
  } finally {
    pool.busy = false;
  }
}

// ---- Leveling ----
const leveling = reactive({ allocationId: '', busy: false, error: '', expectedVersion: 0, fromResourceId: '', hours: '', maxHours: 0, open: false, projectId: '', targetResourceId: '' });
function openLeveling(recommendation) {
  const source = workspace.value.allocations.find((item) => item.id === recommendation.allocationId);
  if (!source) { errorMessage.value = 'That allocation changed. Refresh and try again.'; return; }
  Object.assign(leveling, {
    allocationId: source.id, busy: false, error: '', expectedVersion: source.version, fromResourceId: source.resourceId,
    hours: String(Math.min(Number(recommendation.hours), Number(source.hoursPerWeek))), maxHours: Number(source.hoursPerWeek), open: true,
    projectId: source.projectId, targetResourceId: recommendation.toResourceId,
  });
}
async function applyLeveling() {
  const hours = parseAmount(leveling.hours, { label: 'Hours', max: leveling.maxHours });
  if (hours.error || !hours.value) { leveling.error = hours.error || 'Move at least some hours.'; return; }
  leveling.busy = true;
  try {
    await apiClient.levelResourceAllocation(leveling.allocationId, { expectedVersion: leveling.expectedVersion, hours: hours.value, targetResourceId: leveling.targetResourceId }, token.value);
    leveling.open = false;
    await load();
    flash('Workload moved.');
  } catch (error) {
    leveling.error = error.message ?? 'Unable to move the workload.';
  } finally {
    leveling.busy = false;
  }
}
const weeklySummary = computed(() => [...workspace.value.analysis.weekly.reduce((result, item) => {
  const row = result.get(item.weekStart) ?? { availableHours: 0, demandHours: 0, overallocatedHours: 0, weekStart: item.weekStart };
  row.availableHours += item.availableHours; row.demandHours += item.demandHours; row.overallocatedHours += item.overallocatedHours;
  result.set(item.weekStart, row);
  return result;
}, new Map()).values()]);

// ---- Delete confirmation ----
const removal = reactive({ action: null, body: '', busy: false, error: '', open: false, title: '' });
function confirmDelete(title, body, action) { Object.assign(removal, { action, body, busy: false, error: '', open: true, title }); }
async function runDelete() {
  removal.busy = true;
  removal.error = '';
  try {
    await removal.action();
    removal.open = false;
    await load();
    flash('Deleted.');
  } catch (error) {
    removal.error = error.message ?? 'Unable to delete.';
  } finally {
    removal.busy = false;
  }
}
function deleteResource(resource) {
  confirmDelete(`Delete ${resource.name}?`, 'Their profile is removed. Profiles with allocations, time off, time or expenses can’t be deleted; set them to Inactive instead.',
    () => apiClient.deleteEnterpriseResource(resource.id, resource.version, token.value));
}
function deleteAllocation(record) {
  confirmDelete('Delete this allocation?', `${resourceMap.value.get(record.resourceId)?.name ?? 'This person'} comes off ${projectMap.value.get(record.projectId)?.name ?? 'the project'}. Work they own there stays assigned to them.`,
    () => apiClient.deleteResourceAllocation(record.id, record.version, token.value));
}
function deleteTimeOff(record) {
  confirmDelete('Delete this time off?', `${resourceMap.value.get(record.resourceId)?.name ?? 'Their'} ${record.startDate} – ${record.endDate} entry is removed.`,
    () => apiClient.deleteResourceCalendarEntry(record.id, record.version, token.value));
}
</script>

<template>
  <main class="resources-page">
    <header class="resources-page__head">
      <div>
        <h1>Resources</h1>
        <p>The people who do the work: skills, capacity and the projects they're on.<template v-if="canSeeRates"> Ledgers, rate history, time and expenses are on <RouterLink :to="{ name: 'finance' }">Finance</RouterLink>.</template></p>
      </div>
      <div v-if="canManage" class="resources-page__actions">
        <button v-if="activeTab === 'people'" class="ghost-button" type="button" @click="openPool"><i class="bi bi-collection" aria-hidden="true"></i> Add pool</button>
        <button v-if="activeTab === 'allocations'" class="primary-button" type="button" @click="openAllocation()"><i class="bi bi-calendar-plus" aria-hidden="true"></i> Add allocation</button>
        <button v-else-if="activeTab === 'timeoff'" class="primary-button" type="button" @click="openTimeOff()"><i class="bi bi-calendar-plus" aria-hidden="true"></i> Add time off</button>
        <button v-else class="primary-button" type="button" @click="openProfile()"><i class="bi bi-person-plus" aria-hidden="true"></i> Add resource</button>
      </div>
    </header>

    <p v-if="errorMessage" class="error-banner" role="alert">{{ errorMessage }}</p>
    <p v-else-if="successMessage" class="success-banner" role="status">{{ successMessage }}</p>

    <nav class="resources-page__tabs" aria-label="Resource sections">
      <button v-for="[key, label, icon] in TABS" :key="key" type="button" :class="{ active: activeTab === key }" :aria-current="activeTab === key ? 'page' : undefined" @click="activeTab = key">
        <i :class="['bi', icon]" aria-hidden="true"></i> {{ label }}
      </button>
    </nav>

    <p v-if="loading" class="resources-page__empty" role="status">Loading resources…</p>
    <template v-else>
      <!-- People -->
      <section v-if="activeTab === 'people'" aria-label="People">
        <div class="resources-page__filters">
          <label class="resources-page__search">
            <span class="visually-hidden">Search people</span>
            <i class="bi bi-search" aria-hidden="true"></i>
            <input v-model="filters.query" class="form-control" type="search" placeholder="Search names, roles, skills" />
          </label>
          <label>Status
            <select v-model="filters.status" class="form-select"><option value="active">Active</option><option value="inactive">Inactive</option><option value="">All</option></select>
          </label>
          <label>Login
            <select v-model="filters.login" class="form-select"><option value="all">Everyone</option><option value="linked">Has a login</option><option value="none">No login</option></select>
          </label>
          <label v-if="workspace.pools.length">Pool
            <select v-model="filters.poolId" class="form-select"><option value="">All pools</option><option value="none">No pool</option><option v-for="item in workspace.pools" :key="item.id" :value="item.id">{{ item.name }}</option></select>
          </label>
        </div>

        <div v-if="canManage && unlinkedUsers.length" class="resources-page__notice">
          <i class="bi bi-person-exclamation" aria-hidden="true"></i>
          <span>{{ unlinkedUsers.length }} workspace {{ unlinkedUsers.length === 1 ? 'user has' : 'users have' }} no resource profile:
            <template v-for="(user, index) in unlinkedUsers.slice(0, 4)" :key="user.id">
              <button type="button" class="resources-page__link" @click="openProfile(null, { name: user.name, userId: user.id })">{{ user.name }}</button>{{ index < Math.min(unlinkedUsers.length, 4) - 1 ? ', ' : '' }}
            </template><template v-if="unlinkedUsers.length > 4"> and {{ unlinkedUsers.length - 4 }} more</template>.
            Giving them work creates one automatically.</span>
        </div>

        <ul v-if="pagePeople.length" class="resources-page__cards">
          <li v-for="resource in pagePeople" :key="resource.id" class="person-card" :class="{ 'person-card--inactive': resource.status !== 'active' }">
            <div class="person-card__head">
              <span class="person-card__avatar" aria-hidden="true">{{ initials(resource.name) }}</span>
              <div class="person-card__who">
                <h2>{{ resource.name }}</h2>
                <p v-if="resource.userId" class="person-card__login"><i class="bi bi-person-check" aria-hidden="true"></i> {{ userMap.get(resource.userId)?.email ?? 'Odin user' }}</p>
                <p v-else class="person-card__login person-card__login--none"><i class="bi bi-person-badge" aria-hidden="true"></i> No Odin login</p>
              </div>
              <div v-if="canManage" class="person-card__actions">
                <button type="button" class="person-card__icon" :aria-label="`Edit ${resource.name}`" @click="openProfile(resource)"><i class="bi bi-pencil" aria-hidden="true"></i></button>
                <button type="button" class="person-card__icon" :aria-label="`Delete ${resource.name}`" @click="deleteResource(resource)"><i class="bi bi-trash" aria-hidden="true"></i></button>
              </div>
            </div>

            <p class="person-card__meta">
              {{ poolMap.get(resource.poolId)?.name ?? 'No pool' }}<template v-if="resource.location"> · {{ resource.location }}</template><template v-if="resource.status !== 'active'"> · Inactive</template>
              <template v-if="canSeeRates && resource.billRate"> · {{ money(resource.billRate, resource.currency) }}/h<template v-if="resource.minBillRate != null"> (min {{ money(resource.minBillRate, resource.currency) }})</template></template>
            </p>

            <ul v-if="resource.roles?.length" class="person-card__pills" aria-label="Roles">
              <li v-for="role in resource.roles.slice(0, 3)" :key="role" class="person-card__pill person-card__pill--role">{{ role }}</li>
              <li v-if="resource.roles.length > 3" class="person-card__pill person-card__pill--more">+{{ resource.roles.length - 3 }} roles</li>
            </ul>
            <ul v-if="resource.skills?.length" class="person-card__pills" aria-label="Skills">
              <li v-for="skill in topSkills(resource).slice(0, 4)" :key="skill.name" class="person-card__pill">{{ skill.name }} <span>{{ skillLevelLabel(skill.level) }}</span></li>
              <li v-if="resource.skills.length > 4" class="person-card__pill person-card__pill--more">+{{ resource.skills.length - 4 }} skills</li>
            </ul>
            <p v-if="!resource.roles?.length && !resource.skills?.length" class="person-card__meta">No roles or skills yet.</p>

            <div class="person-card__load">
              <div class="person-card__load-label">
                <span>This week</span>
                <strong :class="{ 'person-card__over': utilization(resource).over }">
                  <i v-if="utilization(resource).over" class="bi bi-exclamation-triangle-fill" aria-hidden="true"></i>
                  {{ utilization(resource).allocated }} of {{ utilization(resource).available }} h<template v-if="utilization(resource).over"> · over</template>
                </strong>
              </div>
              <div class="person-card__bar" role="img" :aria-label="`${utilization(resource).percent}% allocated this week`">
                <span :class="{ over: utilization(resource).over }" :style="{ width: `${Math.min(100, utilization(resource).percent)}%` }"></span>
              </div>
            </div>

            <ul v-if="liveByResource.get(resource.id)?.length" class="person-card__projects" aria-label="Projects">
              <li v-for="item in liveByResource.get(resource.id)" :key="item.id">
                <RouterLink :to="{ name: 'project-resources', params: { projectId: item.projectId } }">{{ projectMap.get(item.projectId)?.name ?? 'Project' }}</RouterLink>
                <span>{{ Number(item.hoursPerWeek) ? `${item.hoursPerWeek} h/wk` : 'hours not set' }}</span>
              </li>
            </ul>
            <p v-else class="person-card__meta">Not on any project in this scenario.</p>
          </li>
        </ul>
        <p v-else class="resources-page__empty">
          {{ workspace.resources.length ? 'Nobody matches these filters.' : 'No resources yet. Add the people who do the work, or give someone work on a project.' }}
        </p>
        <nav v-if="pages > 1" class="resources-page__pager" aria-label="People pages">
          <button class="ghost-button" type="button" :disabled="page === 1" @click="page -= 1">Previous</button>
          <span>Page {{ page }} of {{ pages }} · {{ people.length }} people</span>
          <button class="ghost-button" type="button" :disabled="page === pages" @click="page += 1">Next</button>
        </nav>
      </section>

      <!-- Allocations -->
      <section v-else-if="activeTab === 'allocations'" aria-label="Allocations">
        <div class="resources-page__filters">
          <label>Scenario
            <select v-model="filters.scenario" class="form-select"><option value="baseline">Baseline</option><option value="optimistic">Optimistic</option><option value="constrained">Constrained</option></select>
          </label>
        </div>
        <div class="resources-page__table-wrap">
          <table class="resources-page__table">
            <thead><tr><th>Person</th><th>Project</th><th>Role</th><th>Dates</th><th>Hours</th><th v-if="canSeeRates">Project rate</th><th>Status</th><th v-if="canManage"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              <tr v-for="item in workspace.allocations" :key="item.id">
                <td>{{ resourceMap.get(item.resourceId)?.name ?? 'Unknown' }}</td>
                <td><RouterLink :to="{ name: 'project-resources', params: { projectId: item.projectId } }">{{ projectMap.get(item.projectId)?.name ?? item.projectId }}</RouterLink></td>
                <td>{{ item.role || '—' }}</td>
                <td>{{ item.startDate }} – {{ item.endDate }}</td>
                <td>{{ Number(item.hoursPerWeek) ? `${item.hoursPerWeek} h/wk (${item.allocationPercent}%)` : 'Not set' }}<small v-if="item.origin === 'assignment'">Added when given work</small></td>
                <td v-if="canSeeRates">{{ item.billRate != null ? `${money(item.billRate, resourceMap.get(item.resourceId)?.currency, { cents: true })}/h` : 'Suggested rate' }}</td>
                <td>{{ item.status }}</td>
                <td v-if="canManage" class="resources-page__row-actions">
                  <button type="button" class="person-card__icon" aria-label="Edit allocation" @click="openAllocation(item)"><i class="bi bi-pencil" aria-hidden="true"></i></button>
                  <button type="button" class="person-card__icon" aria-label="Delete allocation" @click="deleteAllocation(item)"><i class="bi bi-trash" aria-hidden="true"></i></button>
                </td>
              </tr>
              <tr v-if="!workspace.allocations.length"><td :colspan="8" class="resources-page__empty">No allocations in this scenario.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Time off -->
      <section v-else-if="activeTab === 'timeoff'" aria-label="Time off">
        <div class="resources-page__table-wrap">
          <table class="resources-page__table">
            <thead><tr><th>Person</th><th>Type</th><th>Dates</th><th>Hours a day</th><th>Status</th><th>Note</th><th v-if="canManage"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              <tr v-for="item in timeOffEntries" :key="item.id">
                <td>{{ resourceMap.get(item.resourceId)?.name ?? 'Unknown' }}</td>
                <td>{{ ENTRY_LABELS[item.entryType] ?? item.entryType }}</td>
                <td>{{ item.startDate }} – {{ item.endDate }}<small>{{ (item.weekdays ?? []).map((day) => WEEKDAYS.find((entry) => entry[0] === day)?.[1]).join(' ') }} · {{ item.timezone }}</small></td>
                <td>{{ item.hoursPerDay }}</td>
                <td>{{ item.status }}</td>
                <td>{{ item.note || '—' }}</td>
                <td v-if="canManage" class="resources-page__row-actions">
                  <button type="button" class="person-card__icon" aria-label="Edit time off" @click="openTimeOff(item)"><i class="bi bi-pencil" aria-hidden="true"></i></button>
                  <button type="button" class="person-card__icon" aria-label="Delete time off" @click="deleteTimeOff(item)"><i class="bi bi-trash" aria-hidden="true"></i></button>
                </td>
              </tr>
              <tr v-if="!timeOffEntries.length"><td colspan="7" class="resources-page__empty">No time off recorded.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Planning -->
      <section v-else aria-label="Planning">
        <div class="resources-page__filters">
          <label>Scenario
            <select v-model="filters.scenario" class="form-select"><option value="baseline">Baseline</option><option value="optimistic">Optimistic</option><option value="constrained">Constrained</option></select>
          </label>
        </div>
        <div class="resources-page__planning">
          <article>
            <h2>Demand by week</h2>
            <div class="resources-page__table-wrap">
              <table class="resources-page__table">
                <thead><tr><th>Week of</th><th>Available</th><th>Allocated</th><th>Over</th></tr></thead>
                <tbody>
                  <tr v-for="item in weeklySummary" :key="item.weekStart"><td>{{ item.weekStart }}</td><td>{{ item.availableHours }} h</td><td>{{ item.demandHours }} h</td><td :class="{ 'person-card__over': item.overallocatedHours }">{{ item.overallocatedHours }} h</td></tr>
                  <tr v-if="!weeklySummary.length"><td colspan="4" class="resources-page__empty">No allocations to plan from.</td></tr>
                </tbody>
              </table>
            </div>
          </article>
          <article>
            <h2>Project forecasts</h2>
            <div class="resources-page__table-wrap">
              <table class="resources-page__table">
                <thead><tr><th>Project</th><th>Complete</th><th>Velocity</th><th>Weeks left</th></tr></thead>
                <tbody>
                  <tr v-for="item in workspace.analysis.forecasts" :key="item.projectId"><td>{{ projectMap.get(item.projectId)?.name ?? item.projectId }}</td><td>{{ item.completionPercent }}%</td><td>{{ item.weeklyVelocityHours }} h/wk</td><td>{{ item.projectedWeeksRemaining ?? 'No history' }}</td></tr>
                  <tr v-if="!workspace.analysis.forecasts.length"><td colspan="4" class="resources-page__empty">No forecasts yet.</td></tr>
                </tbody>
              </table>
            </div>
          </article>
          <article>
            <h2>Rebalancing suggestions</h2>
            <ul v-if="workspace.analysis.levelingRecommendations.length" class="resources-page__suggestions">
              <li v-for="item in workspace.analysis.levelingRecommendations" :key="`${item.allocationId}-${item.weekStart}`">
                <strong>Move {{ item.hours }} h/wk</strong>
                <span>{{ resourceMap.get(item.fromResourceId)?.name ?? 'Someone' }} → {{ resourceMap.get(item.toResourceId)?.name ?? 'someone' }} on {{ projectMap.get(item.projectId)?.name ?? 'a project' }}, week of {{ item.weekStart }}</span>
                <button v-if="canManage" class="ghost-button" type="button" @click="openLeveling(item)">Review</button>
              </li>
            </ul>
            <p v-else class="resources-page__empty">Nobody is overallocated in a way another person can absorb.</p>
          </article>
          <article>
            <h2>Scenarios</h2>
            <div class="resources-page__table-wrap">
              <table class="resources-page__table">
                <thead><tr><th>Scenario</th><th>Hours</th><th v-if="canSeeRates">Cost</th><th v-if="canSeeRates">Revenue</th><th v-if="canSeeRates">Margin</th></tr></thead>
                <tbody>
                  <tr v-for="item in workspace.analysis.scenarios" :key="item.scenario">
                    <td>{{ item.scenario }}</td><td>{{ item.allocatedHoursPerWeek }} h/wk</td>
                    <template v-if="canSeeRates">
                      <td>{{ item.reportingTotals ? money(item.reportingTotals.projectedWeeklyCost, item.reportingTotals.currency) : '—' }}</td>
                      <td>{{ item.reportingTotals ? money(item.reportingTotals.projectedWeeklyRevenue, item.reportingTotals.currency) : '—' }}</td>
                      <td>{{ item.reportingTotals ? money(item.reportingTotals.projectedWeeklyMargin, item.reportingTotals.currency) : '—' }}</td>
                    </template>
                  </tr>
                </tbody>
              </table>
            </div>
          </article>
        </div>
      </section>
    </template>

    <ResourceProfileDialog
      :busy="profile.busy"
      :can-see-rates="canSeeRates"
      :error="profile.error"
      :open="profile.open"
      :pools="workspace.pools"
      :preset="profile.preset"
      :resource="profile.resource"
      :resources="workspace.resources"
      :users="workspace.users"
      @close="closeProfile"
      @link-revoked="profileLinkRevoked"
      @save="saveProfile"
    />

    <RequirementsDialog :busy="allocation.busy" :open="allocation.open" :title="allocation.record ? 'Edit allocation' : 'Add allocation'" @close="allocation.open = false" @submit="saveAllocation">
      <div class="resources-page__form">
        <div class="resources-page__grid">
          <div class="rq-field">
            <label :for="fieldId('alloc-person')">Person</label>
            <select :id="fieldId('alloc-person')" v-model="allocationForm.resourceId" class="form-select" data-autofocus>
              <option value="" disabled>Choose</option>
              <option v-for="item in workspace.resources.filter((entry) => entry.status === 'active' || entry.id === allocationForm.resourceId)" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </div>
          <div class="rq-field">
            <label :for="fieldId('alloc-project')">Project</label>
            <select :id="fieldId('alloc-project')" v-model="allocationForm.projectId" class="form-select">
              <option value="" disabled>Choose</option>
              <option v-for="item in workspace.projects" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </div>
          <div class="rq-field">
            <label :for="fieldId('alloc-role')">Role on project</label>
            <input :id="fieldId('alloc-role')" v-model="allocationForm.role" class="form-control" :list="fieldId('alloc-roles')" maxlength="120" />
            <datalist :id="fieldId('alloc-roles')"><option v-for="role in allocationResource?.roles ?? []" :key="role" :value="role"></option></datalist>
          </div>
          <div class="rq-field">
            <label :for="fieldId('alloc-status')">Status</label>
            <select :id="fieldId('alloc-status')" v-model="allocationForm.status" class="form-select">
              <option value="proposed">Proposed</option><option value="approved">Approved</option><option value="active">Active</option><option value="held">On hold</option><option value="completed">Completed</option>
            </select>
          </div>
          <div class="rq-field">
            <label :for="fieldId('alloc-hours')">Hours per week</label>
            <input :id="fieldId('alloc-hours')" v-model="allocationForm.hoursPerWeek" class="form-control" inputmode="decimal" placeholder="0" @input="syncPercent" />
          </div>
          <div class="rq-field">
            <label :for="fieldId('alloc-percent')">Share of their week (%)</label>
            <input :id="fieldId('alloc-percent')" v-model="allocationForm.allocationPercent" class="form-control" inputmode="decimal" placeholder="0" />
          </div>
          <div class="rq-field">
            <label :for="fieldId('alloc-start')">Start</label>
            <input :id="fieldId('alloc-start')" v-model="allocationForm.startDate" class="form-control" type="date" />
          </div>
          <div class="rq-field">
            <label :for="fieldId('alloc-end')">End</label>
            <input :id="fieldId('alloc-end')" v-model="allocationForm.endDate" class="form-control" type="date" />
          </div>
          <div class="rq-field">
            <label :for="fieldId('alloc-scenario')">Scenario</label>
            <select :id="fieldId('alloc-scenario')" v-model="allocationForm.scenario" class="form-select"><option value="baseline">Baseline</option><option value="optimistic">Optimistic</option><option value="constrained">Constrained</option></select>
          </div>
          <div v-if="canSeeRates" class="rq-field">
            <label :for="fieldId('alloc-rate')">Project bill rate per hour</label>
            <input :id="fieldId('alloc-rate')" v-model="allocationForm.billRate" class="form-control" inputmode="decimal" :placeholder="allocationResource?.billRate ? `${allocationResource.billRate} (suggested)` : 'Suggested rate'" />
          </div>
        </div>
        <p v-if="canSeeRates && allocationResource?.minBillRate != null" class="rq-field__hint">{{ allocationResource.name }}'s minimum is {{ money(allocationResource.minBillRate, allocationResource.currency, { cents: true }) }}.</p>
        <p v-if="allocation.error" class="error-banner mb-0" role="alert">{{ allocation.error }}</p>
      </div>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="allocation.busy" @click="allocation.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="allocation.busy">{{ allocation.busy ? 'Saving…' : 'Save' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsDialog :busy="timeOff.busy" :open="timeOff.open" :title="timeOff.record ? 'Edit time off' : 'Add time off'" @close="timeOff.open = false" @submit="saveTimeOff">
      <div class="resources-page__form">
        <div class="resources-page__grid">
          <div class="rq-field">
            <label :for="fieldId('off-person')">Person</label>
            <select :id="fieldId('off-person')" v-model="timeOffForm.resourceId" class="form-select" data-autofocus>
              <option v-for="item in workspace.resources" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </div>
          <div class="rq-field">
            <label :for="fieldId('off-type')">Type</label>
            <select :id="fieldId('off-type')" v-model="timeOffForm.entryType" class="form-select"><option value="leave">Leave</option><option value="holiday">Holiday</option><option value="working_override">Working override</option></select>
          </div>
          <div class="rq-field">
            <label :for="fieldId('off-start')">Start</label>
            <input :id="fieldId('off-start')" v-model="timeOffForm.startDate" class="form-control" type="date" />
          </div>
          <div class="rq-field">
            <label :for="fieldId('off-end')">End</label>
            <input :id="fieldId('off-end')" v-model="timeOffForm.endDate" class="form-control" type="date" />
          </div>
          <div class="rq-field">
            <label :for="fieldId('off-hours')">{{ timeOffForm.entryType === 'working_override' ? 'Hours worked a day' : 'Hours off a day' }}</label>
            <input :id="fieldId('off-hours')" v-model="timeOffForm.hoursPerDay" class="form-control" inputmode="decimal" />
          </div>
          <div class="rq-field">
            <label :for="fieldId('off-status')">Status</label>
            <select :id="fieldId('off-status')" v-model="timeOffForm.status" class="form-select"><option value="requested">Requested</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select>
          </div>
        </div>
        <fieldset class="rq-field">
          <legend>Weekdays</legend>
          <div class="resources-page__weekdays">
            <label v-for="[day, label] in WEEKDAYS" :key="day"><input v-model="timeOffForm.weekdays" type="checkbox" :value="day" /> {{ label }}</label>
          </div>
        </fieldset>
        <div class="rq-field">
          <label :for="fieldId('off-tz')">Time zone</label>
          <input :id="fieldId('off-tz')" v-model.trim="timeOffForm.timezone" class="form-control" />
        </div>
        <div class="rq-field">
          <label :for="fieldId('off-note')">Note</label>
          <textarea :id="fieldId('off-note')" v-model="timeOffForm.note" class="form-control" rows="2"></textarea>
        </div>
        <p v-if="timeOff.error" class="error-banner mb-0" role="alert">{{ timeOff.error }}</p>
      </div>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="timeOff.busy" @click="timeOff.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="timeOff.busy">{{ timeOff.busy ? 'Saving…' : 'Save' }}</button>
      </template>
    </RequirementsDialog>

    <RequirementsDialog :busy="pool.busy" :open="pool.open" title="Add pool" @close="pool.open = false" @submit="savePool">
      <div class="resources-page__form">
        <div class="rq-field">
          <label :for="fieldId('pool-name')">Name</label>
          <input :id="fieldId('pool-name')" v-model="pool.name" class="form-control" maxlength="240" data-autofocus />
        </div>
        <div class="rq-field">
          <label :for="fieldId('pool-description')">Description</label>
          <textarea :id="fieldId('pool-description')" v-model="pool.description" class="form-control" rows="2"></textarea>
        </div>
        <p v-if="pool.error" class="error-banner mb-0" role="alert">{{ pool.error }}</p>
      </div>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="pool.busy" @click="pool.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="pool.busy">Add pool</button>
      </template>
    </RequirementsDialog>

    <RequirementsDialog :busy="leveling.busy" :open="leveling.open" title="Move workload" @close="leveling.open = false" @submit="applyLeveling">
      <div class="resources-page__form">
        <p class="mb-0">{{ resourceMap.get(leveling.fromResourceId)?.name }} on {{ projectMap.get(leveling.projectId)?.name }} has {{ leveling.maxHours }} h/wk.</p>
        <div class="rq-field">
          <label :for="fieldId('level-target')">Move to</label>
          <select :id="fieldId('level-target')" v-model="leveling.targetResourceId" class="form-select">
            <option v-for="item in workspace.resources.filter((entry) => entry.status === 'active' && entry.id !== leveling.fromResourceId)" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </div>
        <div class="rq-field">
          <label :for="fieldId('level-hours')">Hours per week to move</label>
          <input :id="fieldId('level-hours')" v-model="leveling.hours" class="form-control" inputmode="decimal" data-autofocus />
          <p class="rq-field__hint">Moving all {{ leveling.maxHours }} h hands over the whole allocation.</p>
        </div>
        <p v-if="leveling.error" class="error-banner mb-0" role="alert">{{ leveling.error }}</p>
      </div>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="leveling.busy" @click="leveling.open = false">Cancel</button>
        <button class="primary-button" type="submit" :disabled="leveling.busy">Move hours</button>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog :busy="removal.busy" confirm-label="Delete" :error="removal.error" :open="removal.open" :title="removal.title" @close="removal.open = false" @confirm="runDelete">
      <p class="mb-0">{{ removal.body }}</p>
    </RequirementsConfirmDialog>
  </main>
</template>

<style scoped>
.resources-page { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.75rem; padding: 1rem 1.5rem 2rem; font-size: 0.875rem; }
.resources-page__head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
.resources-page__head h1 { margin: 0; font-size: 1.375rem; line-height: 1.2; }
.resources-page__head p { margin: 0.25rem 0 0; color: var(--muted); }
.resources-page__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.resources-page__actions button, .resources-page__pager button { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; }
.resources-page__tabs { display: flex; gap: 0.25rem; overflow-x: auto; border-bottom: 1px solid var(--line); }
.resources-page__tabs button { display: inline-flex; align-items: center; gap: 0.4rem; min-height: 2.75rem; padding: 0.5rem 0.75rem; border: 0; border-bottom: 0.15rem solid transparent; background: transparent; color: var(--muted); font-weight: 600; white-space: nowrap; }
.resources-page__tabs button.active { border-color: var(--accent); color: var(--accent); }
.resources-page__tabs button:focus-visible { outline: 0.15rem solid var(--accent); outline-offset: -0.15rem; }
.resources-page__filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.5rem; margin-bottom: 0.75rem; }
.resources-page__filters label { display: grid; gap: 0.25rem; min-width: 9rem; color: var(--ink-soft); font-size: 0.75rem; font-weight: 700; }
.resources-page__filters .form-select, .resources-page__filters .form-control { min-height: 2.75rem; font-size: 0.875rem; }
.resources-page__search { position: relative; flex: 1 1 18rem; }
.resources-page__search i { position: absolute; top: 50%; left: 0.75rem; color: var(--muted); line-height: 1; transform: translateY(-50%); pointer-events: none; }
.resources-page__search input { padding-left: 2.1rem; }
.resources-page__notice { display: flex; gap: 0.5rem; align-items: flex-start; margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface-soft); }
.resources-page__link { padding: 0; border: 0; background: none; color: var(--accent); font-weight: 600; text-decoration: underline; }
.resources-page__cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr)); gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
.person-card { display: grid; align-content: start; gap: 0.5rem; padding: 0.75rem; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface); }
.person-card--inactive { opacity: 0.75; }
.person-card__head { display: flex; align-items: flex-start; gap: 0.6rem; }
.person-card__avatar { display: inline-grid; flex: none; place-items: center; width: 2.5rem; height: 2.5rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-soft); color: var(--ink-soft); font-weight: 700; }
.person-card__who { flex: 1; min-width: 0; }
.person-card__who h2 { margin: 0; font-size: 1rem; line-height: 1.2; }
.person-card__login { display: flex; gap: 0.3rem; align-items: center; margin: 0.15rem 0 0; color: var(--ink-soft); font-size: 0.75rem; overflow-wrap: anywhere; }
.person-card__login--none { color: var(--muted); }
.person-card__actions { display: flex; margin: -0.5rem -0.5rem 0 0; }
.person-card__icon { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border: 0; border-radius: 0.375rem; background: transparent; color: var(--ink-soft); }
.person-card__icon:hover { background: var(--surface-soft); }
.person-card__icon:focus-visible { outline: 0.15rem solid var(--accent); outline-offset: 0.05rem; }
.person-card__meta { margin: 0; color: var(--muted); font-size: 0.8125rem; }
.person-card__pills { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
.person-card__pill { padding: 0.1rem 0.5rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-soft); color: var(--ink); font-size: 0.75rem; line-height: 1.4; }
.person-card__pill span { color: var(--muted); }
.person-card__pill--role { border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }
.person-card__pill--more { background: transparent; color: var(--muted); border-style: dashed; }
.person-card__load { display: grid; gap: 0.25rem; }
.person-card__load-label { display: flex; justify-content: space-between; gap: 0.5rem; color: var(--muted); font-size: 0.75rem; }
.person-card__load-label strong { color: var(--ink); font-weight: 600; }
.person-card__over { color: #b42318 !important; }
.person-card__bar { height: 0.4rem; overflow: hidden; border-radius: 999px; background: var(--surface-soft); border: 1px solid var(--line); }
.person-card__bar span { display: block; height: 100%; background: var(--accent); }
.person-card__bar span.over { background: #b42318; }
html.dark .person-card__over { color: #ff9b8f !important; }
html.dark .person-card__bar span.over { background: #ff6b5c; }
.person-card__projects { display: grid; gap: 0.15rem; margin: 0; padding: 0.5rem 0 0; border-top: 1px solid var(--line); list-style: none; }
.person-card__projects li { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.8125rem; }
.person-card__projects span { color: var(--muted); white-space: nowrap; }
.resources-page__table-wrap { position: relative; overflow-x: auto; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface); }
.resources-page__table { width: 100%; border-collapse: collapse; }
.resources-page__table th { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--line); background: var(--surface-soft); color: var(--ink-soft); font-size: 0.75rem; font-weight: 700; text-align: left; white-space: nowrap; }
.resources-page__table td { padding: 0.4rem 0.75rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
.resources-page__table tr:last-child td { border-bottom: 0; }
.resources-page__table small { display: block; color: var(--muted); font-size: 0.75rem; }
.resources-page__row-actions { white-space: nowrap; text-align: right; }
.resources-page__empty { padding: 1.5rem; color: var(--muted); text-align: center; }
.resources-page__pager { display: flex; align-items: center; justify-content: center; gap: 0.75rem; margin-top: 0.75rem; }
.resources-page__planning { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.resources-page__planning article { display: grid; align-content: start; gap: 0.5rem; min-width: 0; }
.resources-page__planning h2 { margin: 0; font-size: 1rem; }
.resources-page__suggestions { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
.resources-page__suggestions li { display: grid; gap: 0.2rem; padding: 0.5rem 0.75rem; border-left: 0.2rem solid var(--accent); background: var(--surface-soft); }
.resources-page__suggestions .ghost-button { justify-self: start; min-height: 2.75rem; }
.resources-page__form { display: grid; gap: 0.75rem; }
.resources-page__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
.resources-page__weekdays { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; }
.resources-page__weekdays label { display: inline-flex; align-items: center; gap: 0.3rem; min-height: 2.75rem; font-weight: 500; }
@media (max-width: 64rem) { .resources-page__planning { grid-template-columns: 1fr; } }
@media (max-width: 48rem) {
  .resources-page { padding: 0.75rem; }
  .resources-page__actions { width: 100%; }
  .resources-page__actions button { flex: 1; justify-content: center; }
  .resources-page__filters label { flex: 1 1 8rem; min-width: 0; }
  .resources-page__cards { grid-template-columns: 1fr; }
  .resources-page__grid { grid-template-columns: 1fr; }
}
</style>
