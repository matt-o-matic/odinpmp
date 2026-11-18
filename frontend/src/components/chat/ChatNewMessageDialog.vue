<script setup>
import { computed, ref, useId, watch } from 'vue';

import { MAX_DIRECT_OTHERS, pickablePeople } from '../../lib/chat/chat.js';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';

// "New message" (docs/odin-chat/plan.md, Odin Chat; qna.md Q-02): choose 1 to 7 people from the
// workspace and open the conversation with them. The same people always reach the same
// conversation; who is in it can't change later, so a new person means a new conversation.
const props = defineProps({
  busy: { default: false, type: Boolean },
  error: { default: '', type: String },
  loading: { default: false, type: Boolean },
  open: { default: false, type: Boolean },
  people: { default: () => [], type: Array },
});

const emit = defineEmits(['close', 'submit']);

const uid = useId();
const query = ref('');
const chosen = ref([]);
const localError = ref('');

const shown = computed(() => pickablePeople(props.people, { chosen: chosen.value, query: query.value }).slice(0, 50));
const full = computed(() => chosen.value.length >= MAX_DIRECT_OTHERS);

watch(() => props.open, (open) => {
  if (!open) return;
  query.value = '';
  chosen.value = [];
  localError.value = '';
});

function add(person) {
  if (full.value) return;
  chosen.value = [...chosen.value, person];
  query.value = '';
  localError.value = '';
}

function remove(person) {
  chosen.value = chosen.value.filter((entry) => entry.id !== person.id);
}

function submit() {
  if (!chosen.value.length) {
    localError.value = 'Choose at least one person.';
    return;
  }
  emit('submit', chosen.value.map((person) => person.id));
}
</script>

<template>
  <RequirementsDialog :busy="busy" :open="open" title="New message" @close="emit('close')" @submit="submit">
    <div class="rq-field">
      <span :id="`${uid}-chosen-label`" class="chat-new__label">To</span>
      <ul v-if="chosen.length" class="chat-new__chosen" :aria-labelledby="`${uid}-chosen-label`">
        <li v-for="person in chosen" :key="person.id" class="chat-new__chip">
          <span>{{ person.name }}</span>
          <button class="chat-new__remove" type="button" :aria-label="`Remove ${person.name}`" :disabled="busy" @click="remove(person)">
            <i class="bi bi-x-lg" aria-hidden="true"></i>
          </button>
        </li>
      </ul>
      <p v-else class="chat-new__hint mb-0">Nobody yet.</p>
    </div>
    <div class="rq-field">
      <label :for="`${uid}-find`">Find people</label>
      <input :id="`${uid}-find`" v-model="query" class="form-control" type="search" autocomplete="off" maxlength="120" :disabled="full || busy" data-autofocus />
      <p v-if="full" class="rq-field__hint mb-0">A conversation can have up to 8 people, you included.</p>
    </div>
    <p v-if="loading" class="chat-new__hint mb-0" role="status">Loading people…</p>
    <ul v-else-if="!full" class="chat-new__people" aria-label="People in this workspace">
      <li v-for="person in shown" :key="person.id">
        <button class="chat-new__person" type="button" :disabled="busy" @click="add(person)">
          <i class="bi bi-person-plus" aria-hidden="true"></i>
          <span class="chat-new__name">{{ person.name }}</span>
          <span class="chat-new__email">{{ person.email }}</span>
        </button>
      </li>
      <li v-if="!shown.length" class="chat-new__hint">No one matches.</li>
    </ul>
    <p v-if="localError || error" class="error-banner mb-0" role="alert">{{ localError || error }}</p>
    <template #footer>
      <button class="ghost-button" type="button" :disabled="busy" @click="emit('close')">Cancel</button>
      <button class="primary-button" type="submit" :disabled="busy">{{ busy ? 'Opening…' : 'Open conversation' }}</button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.chat-new__label { font-weight: 600; }
.chat-new__hint { margin: 0; color: var(--muted); }
.chat-new__chosen { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0; padding: 0; list-style: none; }
.chat-new__chip { display: inline-flex; align-items: center; gap: 0.25rem; padding-left: 0.6rem; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-soft); }
.chat-new__remove { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border: 0; border-radius: 999px; background: transparent; color: var(--muted); }
.chat-new__remove:hover { color: var(--ink); }
.chat-new__people { display: grid; gap: 0.1rem; max-height: 16rem; margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.chat-new__person { display: flex; align-items: center; gap: 0.5rem; width: 100%; min-height: 2.75rem; padding: 0.25rem 0.5rem; border: 0; border-radius: 0.35rem; background: transparent; color: var(--ink); text-align: left; }
.chat-new__person:hover { background: var(--surface-soft); }
.chat-new__name { font-weight: 600; }
.chat-new__email { min-width: 0; overflow: hidden; color: var(--muted); font-size: 0.8rem; text-overflow: ellipsis; white-space: nowrap; }
.chat-new__remove:focus-visible,
.chat-new__person:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.05rem; }
</style>
