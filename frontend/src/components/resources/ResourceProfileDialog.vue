<script setup>
import { computed, reactive, ref, useId, watch } from 'vue';

import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import PillInput from './PillInput.vue';
import SkillPillInput from './SkillPillInput.vue';
import { apiClient, authSession } from '../../lib/auth/index.js';
import { amountText, parseAmount, roleSuggestions, skillSuggestions } from '../../lib/resources/resources.js';
import { accessLinkStateText, canTurnOffLink, looksLikeEmail } from '../../lib/task-access/task-access-admin.js';

// Add or edit one person's resource profile: who they are, the Odin login they use (if any),
// the email their task link goes to when they have no login, capacity, roles and skills, and
// (for finance managers) their rates. One form, one Save. Turning off the task link is its own
// confirmed action.

const props = defineProps({
  busy: { default: false, type: Boolean },
  canSeeRates: { default: false, type: Boolean },
  error: { default: '', type: String },
  open: { default: false, type: Boolean },
  pools: { default: () => [], type: Array },
  // Prefill for a new profile, e.g. { name, userId } when creating one for a login.
  preset: { default: null, type: Object },
  resource: { default: null, type: Object },
  resources: { default: () => [], type: Array },
  users: { default: () => [], type: Array },
});
const emit = defineEmits(['close', 'link-revoked', 'save']);

const uid = useId();
const fieldId = (name) => `resource-profile-${uid}-${name}`;
const form = reactive({});
const localError = ref('');
const revoke = reactive({ busy: false, error: '', open: false });
// The email's access link as managers see it. `loaded` stays false when the server doesn't
// answer (for example, someone who can't manage resources), and the section stays hidden.
const accessLink = reactive({ link: null, loaded: false, note: '' });

function reset() {
  const source = props.resource ?? props.preset ?? {};
  Object.assign(form, {
    billRate: amountText(source.billRate || ''),
    capacityHoursPerWeek: String(source.capacityHoursPerWeek ?? 40),
    costRate: amountText(source.costRate || ''),
    currency: source.currency ?? 'USD',
    email: source.email ?? '',
    location: source.location ?? '',
    minBillRate: amountText(source.minBillRate ?? ''),
    name: source.name ?? '',
    poolId: source.poolId ?? null,
    roles: [...(source.roles ?? [])],
    skills: (source.skills ?? []).map((skill) => ({ level: Number(skill.level) || 3, name: skill.name })),
    status: source.status ?? 'active',
    userId: source.userId ?? null,
  });
  localError.value = '';
  Object.assign(revoke, { busy: false, error: '', open: false });
  loadAccessLink();
}
watch(() => props.open, (open) => { if (open) reset(); }, { immediate: true });

// ---- Task link (profiles with an email) ----
// The saved profile's link, not the form's: the link belongs to the email already stored.
async function loadAccessLink() {
  Object.assign(accessLink, { link: null, loaded: false, note: '' });
  const resource = props.resource;
  if (!resource?.email) return;
  try {
    const result = await apiClient.passive.getResourceAccessLink(resource.id, authSession.state.token);
    if (!props.open || props.resource?.id !== resource.id) return;
    Object.assign(accessLink, { link: result?.link ?? null, loaded: true });
  } catch {
    // Not offered to this person, or not reachable: leave the section out.
  }
}
const linkText = computed(() => accessLink.note || accessLinkStateText(accessLink.link));
const canRevoke = computed(() => canTurnOffLink(accessLink.link));

async function confirmRevoke() {
  if (revoke.busy || !props.resource) return;
  revoke.busy = true;
  revoke.error = '';
  try {
    const result = await apiClient.revokeResourceAccessLink(props.resource.id, authSession.state.token);
    // `revoked: false` means there was no link after all.
    const revoked = result?.revoked !== false;
    Object.assign(accessLink, revoked
      ? { link: { ...accessLink.link, status: 'revoked' }, note: '' }
      : { link: null, note: 'There was no link to turn off.' });
    revoke.open = false;
    emit('link-revoked', { resource: props.resource, revoked });
  } catch (error) {
    revoke.error = error.message ?? 'The link wasn’t turned off. Try again.';
  } finally {
    revoke.busy = false;
  }
}

const others = computed(() => props.resources.filter((entry) => entry.id !== props.resource?.id));
const profileOwner = computed(() => new Map(others.value.filter((entry) => entry.userId).map((entry) => [entry.userId, entry])));
const roleOptions = computed(() => roleSuggestions(props.resources));
const skillOptions = computed(() => skillSuggestions(props.resources));
const mergeTarget = computed(() => (form.userId ? profileOwner.value.get(form.userId) ?? null : null));
const linkedUser = computed(() => props.users.find((user) => user.id === form.userId) ?? null);
const title = computed(() => (props.resource ? `Edit ${props.resource.name}` : 'Add resource'));

function chooseUser(value) {
  form.userId = value || null;
  const user = props.users.find((entry) => entry.id === value);
  if (user && !form.name.trim()) form.name = user.name;
}

function submit() {
  localError.value = '';
  if (!form.name.trim()) { localError.value = 'Give the resource a name.'; return; }
  const capacity = parseAmount(form.capacityHoursPerWeek, { label: 'Weekly capacity', max: 168 });
  if (capacity.error) { localError.value = capacity.error; return; }
  const payload = {
    capacityHoursPerWeek: capacity.value ?? 0,
    location: form.location.trim(),
    name: form.name.trim(),
    poolId: form.poolId || null,
    roles: form.roles,
    skills: form.skills,
    status: form.status,
    userId: form.userId || null,
  };
  // People with a login use their login's email; only profiles without one store an email.
  if (!form.userId) {
    const email = String(form.email ?? '').trim();
    if (email && !looksLikeEmail(email)) { localError.value = 'Enter a full email address, like name@example.com.'; return; }
    payload.email = email || null;
  }
  if (props.canSeeRates) {
    const rates = {};
    for (const [key, label] of [['costRate', 'Cost rate'], ['billRate', 'Suggested bill rate'], ['minBillRate', 'Minimum bill rate']]) {
      const parsed = parseAmount(form[key], { label });
      if (parsed.error) { localError.value = parsed.error; return; }
      rates[key] = parsed.value;
    }
    if (rates.minBillRate != null && rates.billRate != null && rates.billRate < rates.minBillRate) {
      localError.value = 'The suggested bill rate is below the minimum.';
      return;
    }
    const currency = String(form.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) { localError.value = 'Currency is a three-letter code, like USD.'; return; }
    Object.assign(payload, { billRate: rates.billRate ?? 0, costRate: rates.costRate ?? 0, currency, minBillRate: rates.minBillRate });
  }
  emit('save', payload);
}
</script>

<template>
  <RequirementsDialog :busy="busy" :open="open" :title="title" @close="emit('close')" @submit="submit">
    <div class="resource-profile">
      <div class="rq-field">
        <label :for="fieldId('name')">Name</label>
        <input :id="fieldId('name')" v-model="form.name" class="form-control" maxlength="240" required data-autofocus />
      </div>

      <div class="rq-field">
        <label :for="fieldId('user')">Odin login</label>
        <select :id="fieldId('user')" class="form-select" :value="form.userId ?? ''" @change="chooseUser($event.target.value)">
          <option value="">No login (contractor or external)</option>
          <option v-for="user in users" :key="user.id" :value="user.id">
            {{ user.name }} · {{ user.email }}{{ profileOwner.get(user.id) ? ` (has profile: ${profileOwner.get(user.id).name})` : '' }}
          </option>
        </select>
        <p v-if="mergeTarget && resource" class="rq-field__hint resource-profile__warn">
          <i class="bi bi-intersect" aria-hidden="true"></i>
          {{ linkedUser?.name }} already has the profile “{{ mergeTarget.name }}”. Saving merges it into this one: its project
          allocations, time off, time and rates move here, and it is removed.
        </p>
        <p v-else-if="mergeTarget" class="rq-field__hint resource-profile__warn">
          <i class="bi bi-exclamation-triangle" aria-hidden="true"></i>
          {{ linkedUser?.name }} already has the profile “{{ mergeTarget.name }}”. Edit that profile instead.
        </p>
        <p v-else class="rq-field__hint">Linking lets this person own work as themselves. Work the profile already owns moves to them.</p>
      </div>

      <div v-if="!form.userId" class="rq-field">
        <label :for="fieldId('email')">Email <span class="rq-muted">(optional)</span></label>
        <input
          :id="fieldId('email')"
          v-model="form.email"
          class="form-control"
          type="email"
          maxlength="254"
          autocomplete="off"
          :aria-describedby="fieldId('email-hint')"
        />
        <p :id="fieldId('email-hint')" class="rq-field__hint">Where their task link goes. It can’t be the email of someone who signs in to this workspace.</p>
      </div>

      <section v-if="accessLink.loaded" class="resource-profile__link" :aria-labelledby="fieldId('link-title')">
        <div>
          <p :id="fieldId('link-title')" class="resource-profile__link-title mb-0">Task link</p>
          <p class="rq-field__hint" role="status">{{ linkText }}</p>
        </div>
        <button
          v-if="canRevoke"
          class="ghost-button ghost-button--danger"
          type="button"
          :disabled="busy || revoke.busy"
          @click="Object.assign(revoke, { error: '', open: true })"
        >
          <i class="bi bi-link-45deg" aria-hidden="true"></i>Turn off link
        </button>
      </section>

      <div class="resource-profile__grid">
        <div class="rq-field">
          <label :for="fieldId('capacity')">Weekly capacity (hours)</label>
          <input :id="fieldId('capacity')" v-model="form.capacityHoursPerWeek" class="form-control" inputmode="decimal" />
        </div>
        <div class="rq-field">
          <label :for="fieldId('status')">Status</label>
          <select :id="fieldId('status')" v-model="form.status" class="form-select">
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div class="rq-field">
          <label :for="fieldId('location')">Location</label>
          <input :id="fieldId('location')" v-model="form.location" class="form-control" maxlength="240" />
        </div>
        <div class="rq-field">
          <label :for="fieldId('pool')">Pool</label>
          <select :id="fieldId('pool')" v-model="form.poolId" class="form-select">
            <option :value="null">No pool</option>
            <option v-for="pool in pools" :key="pool.id" :value="pool.id">{{ pool.name }}</option>
          </select>
        </div>
      </div>

      <div class="rq-field">
        <label :for="fieldId('roles')">Roles</label>
        <PillInput v-model="form.roles" :input-id="fieldId('roles')" label="Roles" placeholder="Add a role" :suggestions="roleOptions" />
      </div>

      <div class="rq-field">
        <label :for="fieldId('skills')">Skills</label>
        <SkillPillInput v-model="form.skills" :input-id="fieldId('skills')" :suggestions="skillOptions" />
      </div>

      <fieldset v-if="canSeeRates" class="rq-field resource-profile__rates">
        <legend>Rates per hour</legend>
        <div class="resource-profile__grid resource-profile__grid--rates">
          <div class="rq-field">
            <label :for="fieldId('cost')">Cost</label>
            <input :id="fieldId('cost')" v-model="form.costRate" class="form-control" inputmode="decimal" placeholder="0.00" />
          </div>
          <div class="rq-field">
            <label :for="fieldId('bill')">Suggested bill</label>
            <input :id="fieldId('bill')" v-model="form.billRate" class="form-control" inputmode="decimal" placeholder="0.00" />
          </div>
          <div class="rq-field">
            <label :for="fieldId('min')">Minimum bill</label>
            <input :id="fieldId('min')" v-model="form.minBillRate" class="form-control" inputmode="decimal" placeholder="None" />
          </div>
          <div class="rq-field">
            <label :for="fieldId('currency')">Currency</label>
            <input :id="fieldId('currency')" v-model="form.currency" class="form-control" maxlength="3" />
          </div>
        </div>
        <p class="rq-field__hint">Projects start from the suggested rate and can't go below the minimum.</p>
      </fieldset>

      <p v-if="localError || error" class="error-banner mb-0" role="alert">{{ localError || error }}</p>
    </div>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
      <button class="primary-button" type="submit" :disabled="busy || (Boolean(mergeTarget) && !resource)">{{ busy ? 'Saving…' : 'Save' }}</button>
    </template>
  </RequirementsDialog>

  <RequirementsConfirmDialog
    :busy="revoke.busy"
    confirm-label="Turn off link"
    :error="revoke.error"
    :open="revoke.open"
    :title="`Turn off ${resource?.name ?? 'this person'}’s link?`"
    @close="revoke.open = false"
    @confirm="confirmRevoke"
  >
    <p class="mb-0">
      The link sent to {{ resource?.email }} stops working at once, on every project, including requirements pages opened from it.
      Their task access settings stay as they are.
    </p>
  </RequirementsConfirmDialog>
</template>

<style scoped>
.resource-profile { display: grid; gap: 0.75rem; }
.resource-profile__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
.resource-profile__grid--rates { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.resource-profile__rates { padding-top: 0.25rem; border-top: 1px solid var(--line); }
.resource-profile__warn { display: flex; gap: 0.4rem; align-items: flex-start; color: var(--ink-soft); }
.resource-profile__link { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 0.75rem; padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 0.45rem; background: var(--surface-soft); }
.resource-profile__link-title { color: var(--ink-soft); font-size: 0.82rem; font-weight: 700; }
.resource-profile__link .ghost-button { min-height: 2.75rem; }
@media (max-width: 36rem) {
  .resource-profile__grid, .resource-profile__grid--rates { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
