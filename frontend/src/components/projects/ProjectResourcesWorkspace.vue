<script setup>
import { computed, reactive, ref, useId, watch } from 'vue';
import { RouterLink } from 'vue-router';

import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { copyText } from '../../lib/clipboard.js';
import {
  amountText, hoursSummary, initials, liveAllocations, money, openItemCounts, parseAmount, projectTeamRows,
} from '../../lib/resources/resources.js';
import {
  TASK_ACCESS_OPTIONS, accessLinkStateText, linkSendBlocker, taskAccessErrorMessage, taskAccessLabel, taskAccessScope,
} from '../../lib/task-access/task-access-admin.js';

// The project's Resources tab: everyone on the project (members with access, and resources
// allocated to it), their access level, allocation and project rate. Add, edit and remove each
// open a dialog; the table itself is read-only. People without a login can get task access
// by link: it is set in their edit dialog and their link is sent from its own dialog.

const props = defineProps({
  canManageAccess: { default: false, type: Boolean },
  members: { default: () => [], type: Array },
  project: { required: true, type: Object },
  team: { default: null, type: Object },
  teamError: { default: '', type: String },
  tenantUsers: { default: () => [], type: Array },
});
const emit = defineEmits(['changed']);

const uid = useId();
const fieldId = (name) => `project-resources-${uid}-${name}`;
const token = computed(() => authSession.state.token);
const canManageAllocations = computed(() => Boolean(props.team?.canManage));
const canSeeRates = computed(() => Boolean(props.team?.canSeeRates));
const rows = computed(() => projectTeamRows({ members: props.members, projectId: props.project.id, team: props.team }));
const owned = computed(() => openItemCounts(props.project));
const allocatedHours = computed(() => liveAllocations(props.team, props.project.id).reduce((sum, allocation) => sum + Number(allocation.hoursPerWeek || 0), 0));
const query = ref('');
const visibleRows = computed(() => {
  const text = query.value.trim().toLowerCase();
  if (!text) return rows.value;
  return rows.value.filter((row) => `${row.name} ${row.email} ${(row.resource?.roles ?? []).join(' ')} ${row.allocation?.role ?? ''}`.toLowerCase().includes(text));
});
const canAdd = computed(() => canManageAllocations.value || props.canManageAccess);

// ---- Task access by link (resources without a login) ----
// Null when the server doesn't offer it to this person; the controls stay hidden then.
const taskAccess = ref(null);
async function loadTaskAccess() {
  if (!canAdd.value || !props.project?.id) {
    taskAccess.value = null;
    return;
  }
  try {
    const result = await apiClient.passive.getProjectTaskAccess(props.project.id, token.value);
    taskAccess.value = new Map((result?.entries ?? []).map((entry) => [entry.resourceId, entry]));
  } catch {
    taskAccess.value = null;
  }
}
// The team reloads after every change on this tab, so task access follows it.
watch(() => [props.project?.id, props.team, canAdd.value], loadTaskAccess, { immediate: true });
function accessEntry(row) {
  if (!row?.resource || row.userId) return null;
  return taskAccess.value?.get(row.resource.id) ?? null;
}

const ACCESS_LABELS = { admin: 'Admin', manager: 'Manager', member: 'Member', user: 'Member' };
function accessLabel(row) {
  if (row.access) return ACCESS_LABELS[row.access] ?? row.access;
  return row.userId ? 'No access' : 'No login';
}

function today() { return new Date().toISOString().slice(0, 10); }
function plusDays(date, days) { const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function defaultWindow() {
  const startDate = props.project.startDate || today();
  const endDate = props.project.endDate && props.project.endDate >= startDate ? props.project.endDate : plusDays(startDate, 90);
  return { endDate, startDate };
}
function dateRange(allocation) {
  return allocation ? `${allocation.startDate} – ${allocation.endDate}` : '';
}
function projectRate(row) {
  if (!canSeeRates.value || !row.resource) return null;
  return row.allocation?.billRate ?? null;
}

// ---- Edit / add dialog (one form) ----
const dialog = reactive({ busy: false, error: '', mode: '', open: false, row: null });
const form = reactive({ access: 'user', billRate: '', endDate: '', hours: '', percent: '', person: '', role: '', startDate: '', status: 'active', taskScope: 'off' });
const dialogEntry = computed(() => (dialog.mode === 'edit' ? accessEntry(dialog.row) : null));

const directory = computed(() => props.team?.directory ?? []);
const directoryByUser = computed(() => new Map(directory.value.filter((resource) => resource.userId).map((resource) => [resource.userId, resource])));
const onProjectResourceIds = computed(() => new Set(rows.value.filter((row) => row.resource && row.allocation).map((row) => row.resource.id)));
const memberIds = computed(() => new Set(props.members.map((member) => member.id)));
const addableResources = computed(() => directory.value
  .filter((resource) => resource.status === 'active' && !onProjectResourceIds.value.has(resource.id) && !(resource.userId && memberIds.value.has(resource.userId) && !canManageAllocations.value))
  .sort((left, right) => left.name.localeCompare(right.name)));
const addableUsers = computed(() => props.tenantUsers
  .filter((user) => !memberIds.value.has(user.id) && !directoryByUser.value.has(user.id))
  .sort((left, right) => String(left.name).localeCompare(String(right.name))));
const selected = computed(() => {
  if (dialog.mode === 'edit') {
    const row = dialog.row;
    return row && !row.resource && row.userId ? { ...row, user: { email: row.email, id: row.userId, name: row.name } } : row;
  }
  const [kind, id] = String(form.person).split(':');
  if (kind === 'resource') {
    const resource = directory.value.find((entry) => entry.id === id);
    return resource ? { access: resource.userId && memberIds.value.has(resource.userId) ? 'user' : null, name: resource.name, resource, userId: resource.userId ?? null } : null;
  }
  if (kind === 'user') {
    const user = props.tenantUsers.find((entry) => entry.id === id);
    return user ? { access: null, name: user.name, resource: null, userId: user.id, user } : null;
  }
  return null;
});
const selectedResource = computed(() => selected.value?.resource ?? null);
const capacity = computed(() => Number(selectedResource.value?.capacityHoursPerWeek) || 40);
const suggestedRate = computed(() => selectedResource.value?.billRate || null);
const minimumRate = computed(() => selectedResource.value?.minBillRate ?? null);
const roleOptions = computed(() => [...new Set([...(selectedResource.value?.roles ?? []), ...directory.value.flatMap((resource) => resource.roles ?? [])])]);
const showAccess = computed(() => props.canManageAccess && Boolean(selected.value?.userId));
const showAllocation = computed(() => canManageAllocations.value && (Boolean(selectedResource.value) || Boolean(selected.value?.user)));

function openAdd() {
  Object.assign(dialog, { busy: false, error: '', mode: 'add', open: true, row: null });
  Object.assign(form, { access: 'user', billRate: '', hours: '', percent: '', person: '', role: '', status: 'active', ...defaultWindow() });
}

function openEdit(row) {
  const allocation = row.allocation;
  Object.assign(dialog, { busy: false, error: '', mode: 'edit', open: true, row });
  Object.assign(form, {
    access: normalizeAccess(row.access),
    billRate: amountText(allocation?.billRate ?? ''),
    hours: allocation ? String(allocation.hoursPerWeek) : '',
    percent: allocation ? String(allocation.allocationPercent) : '',
    person: '',
    role: allocation?.role ?? '',
    status: allocation?.status ?? 'active',
    taskScope: taskAccessScope(accessEntry(row)),
    ...(allocation ? { endDate: allocation.endDate, startDate: allocation.startDate } : defaultWindow()),
  });
}

function closeDialog() { if (!dialog.busy) dialog.open = false; }

// Hours and percent of the person's weekly capacity stay in step.
function onHours() {
  const parsed = parseAmount(form.hours, { max: 168 });
  if (!parsed.error && parsed.value != null) form.percent = String(Math.round((parsed.value / capacity.value) * 1000) / 10);
}
function onPercent() {
  const parsed = parseAmount(form.percent, { max: 200 });
  if (!parsed.error && parsed.value != null) form.hours = String(Math.round(((parsed.value / 100) * capacity.value) * 100) / 100);
}

function membersPayload(list) {
  return list.map((member) => ({
    email: member.email ?? '', id: member.id, name: member.name ?? '',
    project_allocation: member.project_allocation ?? null, project_bill_rate: member.project_bill_rate ?? null, role: member.role ?? 'user',
  }));
}

function normalizeAccess(role) {
  if (!role) return 'none';
  return role === 'member' ? 'user' : role;
}

async function saveAccess(userId, access) {
  const current = props.members.find((member) => member.id === userId);
  if (normalizeAccess(current?.role) === access) return;
  let next = props.members.filter((member) => member.id !== userId);
  if (access !== 'none') {
    const user = props.tenantUsers.find((entry) => entry.id === userId) ?? current ?? {};
    next = [...props.members.filter((member) => member.id !== userId), { ...(current ?? {}), email: user.email ?? '', id: userId, name: user.name ?? selected.value?.name ?? '', role: access }];
  }
  await apiClient.saveProjectPermissions(props.project.id, { validUsers: membersPayload(next) }, token.value);
}

function allocationValues() {
  const hours = parseAmount(form.hours, { label: 'Hours per week', max: 168 });
  if (hours.error) return { error: hours.error };
  const percent = parseAmount(form.percent, { label: 'Allocation', max: 200 });
  if (percent.error) return { error: percent.error };
  if (!form.startDate || !form.endDate) return { error: 'Give the allocation a start and end date.' };
  if (form.endDate < form.startDate) return { error: 'The end date is before the start date.' };
  const values = { allocationPercent: percent.value ?? 0, endDate: form.endDate, hoursPerWeek: hours.value ?? 0, role: form.role.trim(), startDate: form.startDate, status: form.status };
  if (canSeeRates.value) {
    const rate = parseAmount(form.billRate, { label: 'Project rate' });
    if (rate.error) return { error: rate.error };
    if (rate.value != null && minimumRate.value != null && rate.value < minimumRate.value) {
      return { error: `The project rate can't be below ${selected.value?.name}'s minimum of ${money(minimumRate.value, selectedResource.value?.currency, { cents: true })}.` };
    }
    values.billRate = rate.value;
  }
  return { values };
}

async function submitDialog() {
  if (dialog.busy) return;
  dialog.error = '';
  const person = selected.value;
  if (!person) { dialog.error = 'Choose who to add.'; return; }
  let allocation = null;
  if (showAllocation.value) {
    const result = allocationValues();
    if (result.error) { dialog.error = result.error; return; }
    allocation = result.values;
  }
  dialog.busy = true;
  try {
    let resource = person.resource;
    if (allocation && !resource && person.user) {
      resource = await apiClient.createEnterpriseResource({ name: person.user.name || person.user.email, userId: person.user.id }, token.value);
    }
    if (allocation && resource) {
      const existing = dialog.mode === 'edit' ? person.allocation : null;
      if (existing) await apiClient.updateResourceAllocation(existing.id, { ...allocation, expectedVersion: existing.version }, token.value);
      else await apiClient.createResourceAllocation({ ...allocation, projectId: props.project.id, resourceId: resource.id, scenario: 'baseline' }, token.value);
    }
    if (showAccess.value) await saveAccess(person.userId, form.access);
    const entry = dialogEntry.value;
    const scopeChanged = Boolean(entry) && form.taskScope !== taskAccessScope(entry);
    if (scopeChanged) await apiClient.setProjectTaskAccess(props.project.id, entry.resourceId, { scope: form.taskScope }, token.value);
    dialog.open = false;
    const turnedOn = scopeChanged && form.taskScope !== 'off' && taskAccessScope(entry) === 'off';
    emit('changed', dialog.mode === 'add'
      ? `${person.name} added to the project.`
      : `${person.name} updated.${turnedOn && !entry.link ? ' Send their task link next.' : ''}`);
  } catch (error) {
    const described = taskAccessErrorMessage(error, 'Unable to save.');
    dialog.error = described.message;
    // The server's view of their task access differs from this tab's; read it again.
    if (described.known) loadTaskAccess();
  } finally {
    dialog.busy = false;
  }
}

// ---- Send task link (one form: how to send it) ----
const linkDialog = reactive({ busy: false, copied: null, delivery: 'email', error: '', open: false, row: null, url: '' });
const linkEntry = computed(() => accessEntry(linkDialog.row));
const linkBlocker = computed(() => linkSendBlocker(linkEntry.value));

function openLink(row) {
  Object.assign(linkDialog, { busy: false, copied: null, delivery: 'email', error: '', open: true, row, url: '' });
}
function closeLink() {
  if (linkDialog.busy) return;
  // The manual link is shown once; closing forgets it.
  Object.assign(linkDialog, { open: false, url: '' });
}
async function copyLink() {
  linkDialog.copied = await copyText(linkDialog.url);
}
async function submitLink() {
  if (linkDialog.url) { closeLink(); return; }
  const entry = linkEntry.value;
  if (linkDialog.busy || !entry || linkBlocker.value) return;
  linkDialog.busy = true;
  linkDialog.error = '';
  try {
    const result = await apiClient.sendProjectTaskAccessLink(props.project.id, entry.resourceId, { delivery: linkDialog.delivery }, token.value);
    if (linkDialog.delivery === 'manual') {
      linkDialog.url = result?.url ?? '';
      if (!linkDialog.url) linkDialog.error = 'The link wasn’t created. Try again.';
      else await copyLink();
    } else if (result?.emailed === false) {
      linkDialog.error = `The link wasn’t emailed. ${entry.name} may have turned off emails from Odin. Choose “Copy a link” and send it yourself.`;
    } else {
      Object.assign(linkDialog, { open: false });
      emit('changed', `Task link emailed to ${entry.email}.`);
    }
    await loadTaskAccess();
  } catch (error) {
    const described = taskAccessErrorMessage(error, 'The link wasn’t sent. Try again.');
    linkDialog.error = described.message;
    if (described.known) loadTaskAccess();
  } finally {
    linkDialog.busy = false;
  }
}

// ---- Remove ----
const removal = reactive({ busy: false, error: '', open: false, row: null });
function openRemove(row) { Object.assign(removal, { busy: false, error: '', open: true, row }); }
function canRemove(row) {
  return (row.access && props.canManageAccess) || (row.allocation && canManageAllocations.value);
}
async function confirmRemove() {
  const row = removal.row;
  if (!row || removal.busy) return;
  removal.busy = true;
  removal.error = '';
  try {
    if (row.allocation && canManageAllocations.value) {
      for (const allocation of liveAllocations(props.team, props.project.id).filter((entry) => entry.resourceId === row.resource?.id)) {
        await apiClient.deleteResourceAllocation(allocation.id, allocation.version, token.value);
      }
    }
    if (row.access && props.canManageAccess) {
      await apiClient.saveProjectPermissions(props.project.id, { validUsers: membersPayload(props.members.filter((member) => member.id !== row.userId)) }, token.value);
    }
    removal.open = false;
    emit('changed', `${row.name} removed from the project.`);
  } catch (error) {
    removal.error = error.message ?? 'Unable to remove.';
  } finally {
    removal.busy = false;
  }
}
</script>

<template>
  <section class="project-resources" aria-labelledby="project-resources-title">
    <header class="project-resources__head">
      <div>
        <h2 id="project-resources-title">Resources</h2>
        <p class="project-resources__summary">
          {{ rows.length }} {{ rows.length === 1 ? 'person' : 'people' }} · {{ allocatedHours }} h/wk allocated
        </p>
      </div>
      <div class="project-resources__actions">
        <label class="visually-hidden" :for="fieldId('search')">Search people</label>
        <input :id="fieldId('search')" v-model="query" class="form-control" type="search" placeholder="Search people, roles" />
        <RouterLink class="ghost-button" :to="{ name: 'resources' }">
          <i class="bi bi-people" aria-hidden="true"></i> All resources
        </RouterLink>
        <button v-if="canAdd" class="primary-button" type="button" @click="openAdd">
          <i class="bi bi-person-plus" aria-hidden="true"></i> Add person
        </button>
      </div>
    </header>

    <p v-if="teamError" class="error-banner" role="alert">{{ teamError }}</p>

    <div class="project-resources__table-wrap">
      <table class="project-resources__table">
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Access</th>
            <th scope="col">Role on project</th>
            <th scope="col">Allocation</th>
            <th v-if="canSeeRates" scope="col">Project rate</th>
            <th scope="col" class="project-resources__num">Open items</th>
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in visibleRows" :key="row.key" :class="{ 'project-resources__row--link': canAdd && accessEntry(row) }">
            <td data-label="Person">
              <div class="project-resources__person">
                <span class="project-resources__avatar" aria-hidden="true">{{ initials(row.name) }}</span>
                <div>
                  <strong>{{ row.name }}</strong>
                  <small>{{ row.email || (row.userId ? 'Odin user' : 'No Odin login') }}</small>
                </div>
              </div>
            </td>
            <td data-label="Access">
              <span :class="['project-resources__access', { 'project-resources__access--none': !row.access }]">
                <i :class="row.access ? 'bi bi-shield-check' : row.userId ? 'bi bi-shield-slash' : 'bi bi-person-badge'" aria-hidden="true"></i>
                {{ accessLabel(row) }}
              </span>
              <template v-if="accessEntry(row)">
                <small>Tasks by link: {{ taskAccessLabel(taskAccessScope(accessEntry(row))) }}</small>
                <small>{{ accessEntry(row).email ? accessLinkStateText(accessEntry(row).link) : 'No email on their profile' }}</small>
              </template>
            </td>
            <td data-label="Role on project">{{ row.allocation?.role || row.resource?.roles?.[0] || '—' }}</td>
            <td data-label="Allocation">
              <span :class="{ 'project-resources__unset': row.allocation && !Number(row.allocation.hoursPerWeek) }">{{ hoursSummary(row.allocation) }}</span>
              <small v-if="row.allocation">{{ dateRange(row.allocation) }}<template v-if="row.allocation.status !== 'active'"> · {{ row.allocation.status }}</template></small>
              <small v-if="row.allocation?.origin === 'assignment' && !Number(row.allocation.hoursPerWeek)">Added when given work</small>
            </td>
            <td v-if="canSeeRates" data-label="Project rate">
              <template v-if="row.resource">
                <span v-if="projectRate(row) != null">{{ money(projectRate(row), row.resource.currency, { cents: true }) }}/h</span>
                <span v-else-if="row.resource.billRate">{{ money(row.resource.billRate, row.resource.currency, { cents: true }) }}/h <small>suggested</small></span>
                <span v-else class="project-resources__unset">No rate</span>
                <small v-if="row.resource.minBillRate != null">Min {{ money(row.resource.minBillRate, row.resource.currency, { cents: true }) }}</small>
              </template>
              <span v-else class="project-resources__unset">No profile</span>
            </td>
            <td data-label="Open items" class="project-resources__num">{{ owned.get(row.assigneeId) ?? 0 }}</td>
            <td class="project-resources__row-actions">
              <button v-if="canAdd" class="project-resources__icon" type="button" :aria-label="`Edit ${row.name}`" @click="openEdit(row)">
                <i class="bi bi-pencil" aria-hidden="true"></i>
              </button>
              <button v-if="canAdd && accessEntry(row)" class="project-resources__icon" type="button" :aria-label="`Send ${row.name} their task link`" @click="openLink(row)">
                <i class="bi bi-link-45deg" aria-hidden="true"></i>
              </button>
              <button v-if="canRemove(row)" class="project-resources__icon" type="button" :aria-label="`Remove ${row.name} from the project`" @click="openRemove(row)">
                <i class="bi bi-person-dash" aria-hidden="true"></i>
              </button>
            </td>
          </tr>
          <tr v-if="!visibleRows.length">
            <td :colspan="canSeeRates ? 7 : 6" class="project-resources__empty">
              {{ rows.length ? 'Nobody matches that search.' : 'Nobody is on this project yet. Add the people who will do the work.' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <RequirementsDialog
      :busy="dialog.busy"
      :open="dialog.open"
      :title="dialog.mode === 'add' ? `Add a person to ${project.name}` : `${dialog.row?.name ?? ''} on ${project.name}`"
      @close="closeDialog"
      @submit="submitDialog"
    >
      <div class="project-resources__form">
        <div v-if="dialog.mode === 'add'" class="rq-field">
          <label :for="fieldId('person')">Person</label>
          <select :id="fieldId('person')" v-model="form.person" class="form-select" data-autofocus>
            <option value="" disabled>Choose a person</option>
            <optgroup v-if="canManageAllocations && addableResources.length" label="Resources">
              <option v-for="resource in addableResources" :key="resource.id" :value="`resource:${resource.id}`">
                {{ resource.name }}{{ resource.userId ? '' : ' · no login' }}{{ resource.roles?.[0] ? ` · ${resource.roles[0]}` : '' }}
              </option>
            </optgroup>
            <optgroup v-if="addableUsers.length" label="Workspace users without a resource profile">
              <option v-for="user in addableUsers" :key="user.id" :value="`user:${user.id}`">{{ user.name }} · {{ user.email }}</option>
            </optgroup>
          </select>
          <p v-if="selected?.user && canManageAllocations" class="rq-field__hint">Odin creates their resource profile when you save.</p>
          <p v-if="!addableResources.length && !addableUsers.length" class="rq-field__hint">
            Everyone is already on this project. Add new people on <RouterLink :to="{ name: 'resources' }">Resources</RouterLink>.
          </p>
        </div>

        <div v-if="showAccess" class="rq-field">
          <label :for="fieldId('access')">Project access</label>
          <select :id="fieldId('access')" v-model="form.access" class="form-select">
            <option v-if="dialog.mode === 'edit'" value="none">No access</option>
            <option value="user">Member: sees and works on the project</option>
            <option value="manager">Manager: also plans and edits the project</option>
            <option value="admin">Admin: also manages its people and settings</option>
          </select>
        </div>
        <p v-else-if="selected && !selected.userId" class="rq-field__hint">
          <i class="bi bi-person-badge" aria-hidden="true"></i>
          No Odin login, so no project access. They can still own work. Link a login on
          <RouterLink :to="{ name: 'resources' }">Resources</RouterLink> to hand it over.
        </p>

        <div v-if="dialogEntry" class="rq-field">
          <label :for="fieldId('task-access')">Task access by link</label>
          <select
            :id="fieldId('task-access')"
            v-model="form.taskScope"
            class="form-select"
            :disabled="!dialogEntry.email && form.taskScope === 'off'"
            :aria-describedby="fieldId('task-access-hint')"
          >
            <option v-for="option in TASK_ACCESS_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <p v-if="!dialogEntry.email" :id="fieldId('task-access-hint')" class="rq-field__hint">
            Add an email on
            <RouterLink :to="{ name: 'resources', query: { resource: dialogEntry.resourceId } }">{{ dialogEntry.name || dialog.row?.name }}'s profile</RouterLink>
            to turn this on.
          </p>
          <p v-else :id="fieldId('task-access-hint')" class="rq-field__hint">
            They open their tasks from a link sent to {{ dialogEntry.email }}, without signing in.
          </p>
        </div>

        <template v-if="showAllocation">
          <div class="project-resources__grid">
            <div class="rq-field">
              <label :for="fieldId('role')">Role on project</label>
              <input :id="fieldId('role')" v-model="form.role" class="form-control" :list="fieldId('roles')" maxlength="120" />
              <datalist :id="fieldId('roles')"><option v-for="role in roleOptions" :key="role" :value="role"></option></datalist>
            </div>
            <div class="rq-field">
              <label :for="fieldId('status')">Allocation status</label>
              <select :id="fieldId('status')" v-model="form.status" class="form-select">
                <option value="proposed">Proposed</option>
                <option value="approved">Approved</option>
                <option value="active">Active</option>
                <option value="held">On hold</option>
                <option value="completed">Completed</option>
              </select>
            </div>
            <div class="rq-field">
              <label :for="fieldId('hours')">Hours per week</label>
              <input :id="fieldId('hours')" v-model="form.hours" class="form-control" inputmode="decimal" placeholder="0" @input="onHours" />
            </div>
            <div class="rq-field">
              <label :for="fieldId('percent')">Share of their {{ capacity }} h week (%)</label>
              <input :id="fieldId('percent')" v-model="form.percent" class="form-control" inputmode="decimal" placeholder="0" @input="onPercent" />
            </div>
            <div class="rq-field">
              <label :for="fieldId('start')">Start</label>
              <input :id="fieldId('start')" v-model="form.startDate" class="form-control" type="date" />
            </div>
            <div class="rq-field">
              <label :for="fieldId('end')">End</label>
              <input :id="fieldId('end')" v-model="form.endDate" class="form-control" type="date" />
            </div>
          </div>
          <div v-if="canSeeRates" class="rq-field">
            <label :for="fieldId('rate')">Project bill rate per hour</label>
            <input
              :id="fieldId('rate')"
              v-model="form.billRate"
              class="form-control"
              inputmode="decimal"
              :placeholder="suggestedRate ? `${suggestedRate} (suggested)` : 'Use their suggested rate'"
            />
            <p class="rq-field__hint">
              Suggested {{ suggestedRate ? money(suggestedRate, selectedResource?.currency, { cents: true }) : 'not set' }}
              · Minimum {{ minimumRate != null ? money(minimumRate, selectedResource?.currency, { cents: true }) : 'none' }}.
              Leave blank to bill at the suggested rate.
            </p>
          </div>
        </template>
        <p v-else-if="dialog.mode === 'edit' && !canManageAllocations" class="rq-field__hint">Allocations and rates are set by workspace managers.</p>

        <p v-if="selectedResource && dialog.mode === 'edit'" class="rq-field__hint">
          Roles, skills, capacity and standard rates live on
          <RouterLink :to="{ name: 'resources', query: { resource: selectedResource.id } }">{{ selectedResource.name }}'s profile</RouterLink>.
        </p>
        <p v-if="dialog.error" class="error-banner mb-0" role="alert">{{ dialog.error }}</p>
      </div>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="dialog.busy" @click="closeDialog">Cancel</button>
        <button class="primary-button" type="submit" :disabled="dialog.busy || !selected">
          {{ dialog.busy ? 'Saving…' : dialog.mode === 'add' ? 'Add to project' : 'Save' }}
        </button>
      </template>
    </RequirementsDialog>

    <RequirementsDialog
      :busy="linkDialog.busy"
      :open="linkDialog.open"
      :title="`${linkDialog.row?.name ?? ''}’s task link`"
      @close="closeLink"
      @submit="submitLink"
    >
      <div class="project-resources__form">
        <template v-if="linkDialog.url">
          <p class="mb-0">
            <template v-if="linkDialog.copied">Copied to your clipboard. </template>
            Send this link to {{ linkDialog.row?.name }} yourself.
            <strong>It’s shown only once.</strong>
          </p>
          <code class="rq-secret" data-testid="task-link-url">{{ linkDialog.url }}</code>
          <div>
            <button class="ghost-button" type="button" @click="copyLink">
              <i class="bi bi-clipboard" aria-hidden="true"></i>{{ linkDialog.copied ? 'Copy again' : 'Copy link' }}
            </button>
          </div>
          <p v-if="linkDialog.copied === false" class="rq-field__hint" role="status">Couldn’t copy automatically. Select the link and copy it.</p>
        </template>

        <template v-else-if="linkBlocker === 'no-email'">
          <p class="mb-0">
            {{ linkDialog.row?.name }} has no email yet. Add one on
            <RouterLink :to="{ name: 'resources', query: { resource: linkEntry?.resourceId } }">their profile</RouterLink>
            before sending a link.
          </p>
        </template>

        <template v-else-if="linkBlocker === 'off'">
          <p class="mb-0">
            Task access is off for {{ linkDialog.row?.name }} on {{ project.name }}. Edit them and choose
            Their work or Everyone’s work before sending a link.
          </p>
        </template>

        <template v-else>
          <p class="rq-small mb-0">
            One link opens every project where {{ linkDialog.row?.name }} has task access.
            <span class="project-resources__muted">{{ accessLinkStateText(linkEntry?.link) }}.</span>
          </p>
          <fieldset class="rq-field">
            <legend>How to send it</legend>
            <label class="project-resources__choice">
              <input v-model="linkDialog.delivery" type="radio" :name="fieldId('delivery')" value="email" data-autofocus />
              <span>Email it to <strong>{{ linkEntry?.email }}</strong></span>
            </label>
            <label class="project-resources__choice">
              <input v-model="linkDialog.delivery" type="radio" :name="fieldId('delivery')" value="manual" />
              <span>Copy a link to send yourself</span>
            </label>
          </fieldset>
        </template>
        <p v-if="linkDialog.error" class="error-banner mb-0" role="alert">{{ linkDialog.error }}</p>
      </div>
      <template #footer>
        <template v-if="linkDialog.url">
          <button class="primary-button" type="submit">Done</button>
        </template>
        <template v-else>
          <button class="ghost-button" type="button" :disabled="linkDialog.busy" @click="closeLink">Cancel</button>
          <button class="primary-button" type="submit" :disabled="linkDialog.busy || Boolean(linkBlocker)">
            {{ linkDialog.busy ? 'Sending…' : linkDialog.delivery === 'manual' ? 'Copy link' : 'Email link' }}
          </button>
        </template>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog
      :busy="removal.busy"
      confirm-label="Remove"
      :error="removal.error"
      :open="removal.open"
      :title="`Remove ${removal.row?.name ?? ''} from ${project.name}?`"
      @close="removal.open = false"
      @confirm="confirmRemove"
    >
      <p class="mb-0">
        <template v-if="removal.row?.access && canManageAccess">They lose access to this project. </template>
        <template v-if="removal.row?.allocation && canManageAllocations">Their allocation here is deleted. </template>
        Work they own stays assigned to them until you reassign it.
      </p>
    </RequirementsConfirmDialog>
  </section>
</template>

<style scoped>
.project-resources { display: grid; gap: 0.75rem; padding: 1rem 1.5rem 2rem; font-size: 0.875rem; }
.project-resources__head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 0.75rem; }
.project-resources__head h2 { margin: 0; font-size: 1.125rem; line-height: 1.2; }
.project-resources__summary { margin: 0.25rem 0 0; color: var(--muted); }
.project-resources__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.project-resources__actions input { width: 16rem; min-height: 2.75rem; }
.project-resources__actions .ghost-button, .project-resources__actions .primary-button { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; text-decoration: none; }
.project-resources__table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface); }
.project-resources__table { width: 100%; border-collapse: collapse; }
.project-resources__table th { position: sticky; top: 0; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--line); background: var(--surface-soft); color: var(--ink-soft); font-size: 0.75rem; font-weight: 700; text-align: left; white-space: nowrap; }
.project-resources__table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
.project-resources__table tr:last-child td { border-bottom: 0; }
.project-resources__table small { display: block; color: var(--muted); font-size: 0.75rem; }
.project-resources__num { text-align: right; }
.project-resources__person { display: flex; align-items: center; gap: 0.6rem; }
.project-resources__person strong { display: block; }
.project-resources__avatar { display: inline-grid; flex: none; place-items: center; width: 2rem; height: 2rem; border-radius: 999px; background: var(--surface-soft); border: 1px solid var(--line); color: var(--ink-soft); font-size: 0.75rem; font-weight: 700; }
.project-resources__access { display: inline-flex; align-items: center; gap: 0.3rem; white-space: nowrap; }
.project-resources__access--none { color: var(--muted); }
.project-resources__unset { color: var(--muted); font-style: italic; }
.project-resources__row-actions { white-space: nowrap; text-align: right; }
.project-resources__icon { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border: 0; border-radius: 0.375rem; background: transparent; color: var(--ink-soft); }
.project-resources__icon:hover { background: var(--surface-soft); }
.project-resources__icon:focus-visible { outline: 0.15rem solid var(--accent); outline-offset: 0.05rem; }
.project-resources__empty { padding: 1.5rem !important; color: var(--muted); text-align: center; }
.project-resources__form { display: grid; gap: 0.75rem; }
.project-resources__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
.project-resources__muted { color: var(--muted); }
.project-resources__form legend { float: none; width: auto; }
.project-resources__choice { display: flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; font-size: 0.875rem; cursor: pointer; }
.project-resources__choice input { flex: none; width: 1.1rem; height: 1.1rem; margin: 0; }

@media (max-width: 48rem) {
  .project-resources { padding: 0.75rem; }
  .project-resources__actions, .project-resources__actions input { width: 100%; }
  .project-resources__actions .ghost-button, .project-resources__actions .primary-button { flex: 1; justify-content: center; }
  .project-resources__table thead { display: none; }
  .project-resources__table, .project-resources__table tbody, .project-resources__table tr, .project-resources__table td { display: block; width: 100%; }
  .project-resources__table tr { position: relative; padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
  .project-resources__table td { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); gap: 0.5rem; padding: 0.25rem 0.75rem; border: 0; text-align: left; }
  .project-resources__table td::before { content: attr(data-label); color: var(--muted); font-size: 0.75rem; font-weight: 700; }
  .project-resources__table td:first-child { grid-template-columns: 1fr; padding-right: 6.5rem; }
  .project-resources__table tr.project-resources__row--link td:first-child { padding-right: 9.25rem; }
  .project-resources__table td:first-child::before, .project-resources__row-actions::before { content: none; }
  .project-resources__row-actions { position: absolute; top: 0.4rem; right: 0.25rem; display: flex !important; width: auto !important; padding: 0 !important; }
  .project-resources__empty { display: block !important; }
  .project-resources__empty::before { content: none !important; }
  .project-resources__grid { grid-template-columns: 1fr; }
}
</style>
