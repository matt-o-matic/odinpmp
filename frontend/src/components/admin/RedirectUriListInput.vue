<script setup>
import { ref } from 'vue';

import { MAX_REDIRECT_URIS, addRedirectUri } from '../../lib/integrations/redirect-uris.js';

// Multi-value redirect URI field. Enter or Add appends the typed URI; the parent's Save calls
// commitPending() so a URI typed but not yet added is still saved (or blocks the save).

const uris = defineModel({ default: () => [], type: Array });
const pending = ref('');
const error = ref('');
const inputId = `redirect-uri-${Math.random().toString(36).slice(2, 10)}`;

function add() {
  const result = addRedirectUri(uris.value, pending.value);
  error.value = result.error;
  if (!result.error) {
    uris.value = result.uris;
    pending.value = '';
  }
  return !result.error;
}

function remove(uri) {
  uris.value = uris.value.filter((item) => item !== uri);
  error.value = '';
}

function commitPending() {
  if (!pending.value.trim()) {
    error.value = '';
    return true;
  }
  return add();
}

defineExpose({ commitPending });
</script>

<template>
  <fieldset class="redirect-uris">
    <legend>Redirect URIs</legend>
    <p class="redirect-uris__hint">Where users return after approving access. HTTPS, or HTTP for localhost only. Up to {{ MAX_REDIRECT_URIS }}.</p>
    <ul v-if="uris.length" class="redirect-uris__list">
      <li v-for="uri in uris" :key="uri">
        <code>{{ uri }}</code>
        <button class="icon-button" type="button" :aria-label="`Remove ${uri}`" @click="remove(uri)"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
      </li>
    </ul>
    <p v-else class="redirect-uris__hint">No redirect URIs. The application can’t use the authorization code flow until one is added.</p>
    <div class="redirect-uris__add">
      <label class="visually-hidden" :for="inputId">New redirect URI</label>
      <input
        :id="inputId"
        v-model="pending"
        type="url"
        inputmode="url"
        placeholder="https://app.example.com/oauth/callback"
        :aria-invalid="error ? 'true' : 'false'"
        :aria-describedby="error ? `${inputId}-error` : undefined"
        @input="error = ''"
        @keydown.enter.prevent="add"
      />
      <button class="btn btn-sm btn-outline-secondary" type="button" :disabled="uris.length >= MAX_REDIRECT_URIS" @click="add">Add</button>
    </div>
    <p v-if="error" :id="`${inputId}-error`" class="redirect-uris__error" role="alert">{{ error }}</p>
  </fieldset>
</template>

<style scoped>
.redirect-uris { display: grid; gap: 0.5rem; margin: 0; padding: 0.5rem 0.75rem; border: 1px solid var(--bs-border-color); border-radius: 0.375rem; }
.redirect-uris legend { float: none; width: auto; margin: 0; padding: 0 0.25rem; font-size: 0.875rem; font-weight: 600; }
.redirect-uris__hint { margin: 0; color: var(--bs-secondary-color); font-size: 0.75rem; }
.redirect-uris__list { display: grid; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
.redirect-uris__list li { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding-left: 0.5rem; border: 1px solid var(--bs-border-color); border-radius: 0.375rem; }
.redirect-uris__list code { overflow-wrap: anywhere; font-size: 0.75rem; color: var(--bs-body-color); }
.redirect-uris__add { display: flex; gap: 0.5rem; }
.redirect-uris__add input { flex: 1; min-width: 0; min-height: 2.75rem; padding: 0.5rem; border: 1px solid var(--bs-border-color); border-radius: 0.375rem; background: var(--bs-body-bg); color: var(--bs-body-color); }
.redirect-uris__add .btn { min-height: 2.75rem; }
.redirect-uris__error { margin: 0; color: var(--danger); font-size: 0.75rem; font-weight: 600; }
.icon-button { width: 2.75rem; height: 2.75rem; flex-shrink: 0; border: 0; background: transparent; color: inherit; }
</style>
