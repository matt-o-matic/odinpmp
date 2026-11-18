<script setup>
import { computed, reactive, ref, useId, watch } from 'vue';

import { apiClient } from '../../lib/auth/index.js';
import { channelErrorMessage, postTimeLabel } from '../../lib/channels/channels.js';
import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';

// A channel's guests, for members: who is in the channel from outside, when each last used
// Odin, and, for people with decision rights, inviting by name, email and organization,
// adding a guest of another channel, and removing.
const props = defineProps({
  channel: { default: null, type: Object },
  open: { default: false, type: Boolean },
  projectId: { required: true, type: String },
  token: { default: '', type: String },
});
const emit = defineEmits(['changed', 'close']);

const uid = useId();
const guests = ref([]);
const otherGuests = ref([]);
const canManage = ref(false);
const loading = ref(false);
const loadError = ref('');
const status = ref('');
const form = reactive({ busy: false, email: '', error: '', name: '', organization: '', pick: '' });
const removal = reactive({ busy: false, error: '', guest: null });

const open = computed(() => props.open && Boolean(props.channel));
const archived = computed(() => Boolean(props.channel?.archivedAt));
const canInvite = computed(() => canManage.value && !archived.value);
const picked = computed(() => otherGuests.value.find((guest) => guest.stakeholderId === form.pick) ?? null);

function lastSeen(guest) {
  return guest.lastSeenAt ? `Last seen ${postTimeLabel(guest.lastSeenAt)}` : 'Not signed in yet';
}

async function load() {
  if (!props.channel) return;
  loading.value = true;
  loadError.value = '';
  try {
    const result = await apiClient.listChannelGuests(props.projectId, props.channel.id, props.token);
    guests.value = result.guests ?? [];
    otherGuests.value = result.otherGuests ?? [];
    canManage.value = result.canManage === true;
  } catch (error) {
    loadError.value = channelErrorMessage(error, 'The guests could not load.');
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  Object.assign(form, { busy: false, email: '', error: '', name: '', organization: '', pick: '' });
}

async function invite() {
  if (form.busy || !canInvite.value) return;
  const payload = picked.value
    ? { email: picked.value.email, name: picked.value.name }
    : { email: form.email.trim(), name: form.name.trim(), organization: form.organization.trim() };
  if (!payload.email) { form.error = 'Enter the guest’s email address.'; return; }
  if (!picked.value && !payload.name) { form.error = 'Enter the guest’s name.'; return; }
  form.busy = true;
  form.error = '';
  try {
    const result = await apiClient.inviteChannelGuest(props.projectId, props.channel.id, payload, props.token);
    const who = result.guest?.name || payload.email;
    resetForm();
    status.value = result.added
      ? `${who} is invited.${result.invitationQueued ? ' They get an email with a link to this channel.' : ''}`
      : `${who} is already in this channel.`;
    await load();
    emit('changed');
  } catch (error) {
    form.error = error?.data?.details?.code === 'guest_is_member'
      ? 'This person is a member of the workspace. Add them to the project instead.'
      : channelErrorMessage(error, 'The guest could not be invited.');
  } finally {
    form.busy = false;
  }
}

async function confirmRemoval() {
  if (!removal.guest) return;
  removal.busy = true;
  removal.error = '';
  try {
    const result = await apiClient.removeChannelGuest(props.projectId, props.channel.id, removal.guest.stakeholderId, props.token);
    status.value = result.accessEnded
      ? `${removal.guest.name} is removed. They were in no other channel, so they are signed out.`
      : `${removal.guest.name} is removed from this channel.`;
    removal.guest = null;
    await load();
    emit('changed');
  } catch (error) {
    removal.error = channelErrorMessage(error, 'The guest could not be removed.');
  } finally {
    removal.busy = false;
  }
}

watch(open, (value) => {
  if (!value) return;
  resetForm();
  status.value = '';
  load();
}, { immediate: true });
</script>

<template>
  <RequirementsDialog :busy="form.busy" :open="open" :title="`Guests in #${channel?.name ?? ''}`" @close="emit('close')" @submit="invite">
    <p class="rq-field__hint mb-0">Guests see only this channel: its messages and its files. They sign in with a code emailed to them.</p>
    <p v-if="loadError" class="error-banner mb-0" role="alert">{{ loadError }}</p>
    <p v-else-if="loading && !guests.length" class="rq-field__hint mb-0" role="status">Loading guests…</p>
    <ul v-else-if="guests.length" class="channel-guests" aria-label="Guests" data-testid="channel-guests">
      <li v-for="guest in guests" :key="guest.stakeholderId" class="channel-guests__row">
        <div class="channel-guests__who">
          <strong>{{ guest.name || guest.email }}</strong>
          <span class="channel-guests__meta">{{ [guest.organization, guest.email].filter(Boolean).join(' · ') }}</span>
          <span class="channel-guests__meta">{{ lastSeen(guest) }}</span>
        </div>
        <button v-if="canManage" class="ghost-button ghost-button--compact channel-guests__remove" type="button" @click="removal.guest = guest; removal.error = ''">
          Remove<span class="visually-hidden"> {{ guest.name }}</span>
        </button>
      </li>
    </ul>
    <p v-else class="rq-field__hint mb-0">No guests in this channel.</p>
    <p class="channel-guests__status mb-0" role="status">{{ status }}</p>

    <fieldset v-if="canInvite" class="channel-guests__invite">
      <legend class="channel-guests__legend">Invite a guest</legend>
      <div v-if="otherGuests.length" class="rq-field">
        <label :for="`${uid}-pick`">From another channel</label>
        <select :id="`${uid}-pick`" v-model="form.pick" class="form-select">
          <option value="">Someone new</option>
          <option v-for="guest in otherGuests" :key="guest.stakeholderId" :value="guest.stakeholderId">{{ guest.name }} ({{ guest.email }})</option>
        </select>
      </div>
      <template v-if="!picked">
        <div class="rq-field">
          <label :for="`${uid}-name`">Name</label>
          <input :id="`${uid}-name`" v-model="form.name" class="form-control" maxlength="120" autocomplete="off" />
        </div>
        <div class="rq-field">
          <label :for="`${uid}-email`">Email</label>
          <input :id="`${uid}-email`" v-model="form.email" class="form-control" type="email" inputmode="email" autocapitalize="off" maxlength="255" autocomplete="off" />
        </div>
        <div class="rq-field">
          <label :for="`${uid}-organization`">Organization (optional)</label>
          <input :id="`${uid}-organization`" v-model="form.organization" class="form-control" maxlength="120" autocomplete="off" />
        </div>
      </template>
      <p v-if="form.error" class="error-banner mb-0" role="alert">{{ form.error }}</p>
    </fieldset>
    <p v-else-if="!canManage && !loading" class="rq-field__hint mb-0">Only a project admin or manager can invite or remove guests.</p>
    <p v-else-if="archived" class="rq-field__hint mb-0">Restore the channel to invite guests.</p>

    <template #footer>
      <button class="ghost-button" type="button" :disabled="form.busy" @click="emit('close')">Close</button>
      <button v-if="canInvite" class="primary-button" type="submit" :disabled="form.busy">{{ form.busy ? 'Inviting…' : 'Invite' }}</button>
    </template>
  </RequirementsDialog>

  <RequirementsConfirmDialog
    :busy="removal.busy"
    confirm-label="Remove guest"
    :error="removal.error"
    :open="Boolean(removal.guest)"
    title="Remove this guest?"
    @close="removal.guest = null"
    @confirm="confirmRemoval"
  >
    <p class="mb-0"><strong>{{ removal.guest?.name }}</strong> loses access to #{{ channel?.name }} at once. What they posted stays.</p>
  </RequirementsConfirmDialog>
</template>

<style scoped>
.channel-guests { display: grid; gap: 0.35rem; margin: 0; padding: 0; list-style: none; }
.channel-guests__row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.45rem 0.6rem; border: 1px solid var(--line); border-radius: 0.4rem; }
.channel-guests__who { display: grid; min-width: 0; }
.channel-guests__meta { color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; }
.channel-guests__remove { min-height: 2.75rem; }
.channel-guests__status:empty { display: none; }
.channel-guests__invite { display: grid; gap: 0.5rem; margin: 0; padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; }
.channel-guests__legend { float: none; width: auto; margin: 0; padding: 0 0.25rem; font-size: 0.8rem; font-weight: 700; }
</style>
