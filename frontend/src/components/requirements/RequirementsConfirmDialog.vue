<script setup>
import RequirementsDialog from './RequirementsDialog.vue';

// Application-styled confirmation for destructive actions (no window.confirm).
defineProps({
  busy: { default: false, type: Boolean },
  confirmDisabled: { default: false, type: Boolean },
  confirmLabel: { required: true, type: String },
  error: { default: '', type: String },
  open: { default: false, type: Boolean },
  title: { required: true, type: String },
});

const emit = defineEmits(['close', 'confirm']);
</script>

<template>
  <RequirementsDialog :busy="busy" :open="open" :title="title" @close="emit('close')" @submit="!confirmDisabled && emit('confirm')">
    <div class="rq-small"><slot /></div>
    <p v-if="error" class="error-banner mb-0" role="alert">{{ error }}</p>
    <template #footer>
      <button class="ghost-button" type="button" data-autofocus :disabled="busy" @click="emit('close')">{{ error ? 'Close' : 'Cancel' }}</button>
      <button v-if="!error" class="primary-button rq-danger-button" type="submit" :disabled="busy || confirmDisabled">{{ busy ? 'Working…' : confirmLabel }}</button>
    </template>
  </RequirementsDialog>
</template>

<style scoped>
.rq-danger-button {
  border-color: #8f1b13;
  background: #b42318;
}
</style>
