<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { focusOrigin } from '../../lib/ui/focus-origin.js';

// A modal built on <dialog>.showModal(): the page behind it is inert, focus stays inside,
// Escape closes it unless work is in flight, and focus returns to the opener on close.
// The default slot holds the fields; the footer slot holds Cancel and one submit button.

const props = defineProps({
  busy: { default: false, type: Boolean },
  // Start on the title instead of the first field. On an iPad, focusing a date field opens
  // Safari's picker over the dialog, and Safari can fill the empty field with the current time.
  focusTitle: { default: false, type: Boolean },
  open: { default: false, type: Boolean },
  title: { required: true, type: String },
});

const emit = defineEmits(['close', 'submit']);

const titleId = `rq-dialog-title-${Math.random().toString(36).slice(2, 10)}`;
const dialog = ref(null);
let opener = null;

function focusFirstField() {
  const element = dialog.value;
  if (!element) return;
  const target = element.querySelector('[data-autofocus]')
    ?? (props.focusTitle ? element.querySelector(`#${titleId}`) : null)
    ?? element.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])')
    ?? element.querySelector('button:not([disabled])');
  target?.focus?.();
}

function restoreFocus() {
  const target = opener;
  opener = null;
  if (target && typeof document !== 'undefined' && document.contains(target)) target.focus?.();
}

watch(
  () => props.open,
  async (open) => {
    await nextTick();
    const element = dialog.value;
    if (!element) return;
    if (open && !element.open) {
      opener = typeof document !== 'undefined' ? focusOrigin() : null;
      element.showModal?.();
      focusFirstField();
    } else if (!open && element.open) {
      element.close();
      restoreFocus();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (dialog.value?.open) dialog.value.close();
  restoreFocus();
});

function handleCancel(event) {
  event.preventDefault();
  if (!props.busy) emit('close');
}
</script>

<template>
  <dialog ref="dialog" class="rq-dialog" :aria-labelledby="titleId" @cancel="handleCancel">
    <form class="rq-dialog__form" novalidate @submit.prevent="emit('submit')">
      <header class="rq-dialog__head">
        <h2 :id="titleId" tabindex="-1">{{ title }}</h2>
        <button class="rq-dialog__close" type="button" aria-label="Close" :disabled="busy" @click="emit('close')">
          <i class="bi bi-x-lg" aria-hidden="true"></i>
        </button>
      </header>
      <slot />
      <footer class="rq-dialog__foot">
        <slot name="footer" />
      </footer>
    </form>
  </dialog>
</template>
