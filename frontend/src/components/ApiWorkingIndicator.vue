<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { apiActivity } from '../lib/api/activity-tracker.js';
import { focusOrigin } from '../lib/ui/focus-origin.js';
import { acquireOverlayScrollLock } from '../lib/ui/overlay-scroll-lock.js';

const props = defineProps({
  tracker: {
    default: () => apiActivity,
    type: Object,
  },
});

const state = ref(props.tracker.getState());
const rootRef = ref(null);
const dialogRef = ref(null);
const bannerRef = ref(null);
const cancelRef = ref(null);
let releaseScrollLock = null;
let inertElements = [];
let returnFocusTo = null;

function activeElement() {
  const origin = focusOrigin();
  return origin instanceof HTMLElement ? origin : null;
}

const unsubscribe = props.tracker.subscribe((next) => {
  // Note where focus is the moment the dialog is due, before the page re-renders and
  // possibly disables the control the user just pressed.
  if (next.blocking && !state.value.blocking && !returnFocusTo) {
    returnFocusTo = activeElement();
  }
  state.value = next;
});

// Everything outside the indicator becomes unusable while the dialog is up, including
// content other components teleport to <body>. showModal() already does this for the
// page, and the explicit inert also covers overlays that trap focus themselves.
function makeBackgroundInert() {
  const root = rootRef.value;
  inertElements = [...document.body.children].filter((element) => element !== root && !element.inert);
  for (const element of inertElements) {
    element.inert = true;
  }
}

function restoreBackground() {
  for (const element of inertElements) {
    element.inert = false;
  }
  inertElements = [];
}

function keepFocusOnCancel(event) {
  if (cancelRef.value && event.target !== cancelRef.value) {
    cancelRef.value.focus();
  }
}

function trapTab(event) {
  if (event.key === 'Tab') {
    // Cancel is the only control; keep Tab from moving focus out to the browser.
    event.preventDefault();
    cancelRef.value?.focus();
  }
}

function handleDialogCancel(event) {
  // Escape: keep the dialog under the tracker's control and cancel the calls instead.
  event.preventDefault();
  props.tracker.cancel();
}

function openDialog() {
  const dialog = dialogRef.value;
  if (!dialog || dialog.open) return;

  returnFocusTo ??= activeElement();
  releaseScrollLock = acquireOverlayScrollLock();
  // A native modal dialog joins the top layer, so it stays above any dialog already open.
  dialog.showModal();
  makeBackgroundInert();
  document.addEventListener('focusin', keepFocusOnCancel);
  document.addEventListener('keydown', trapTab, true);
  cancelRef.value?.focus();
}

function closeDialog() {
  const dialog = dialogRef.value;
  if (!dialog?.open) return;

  document.removeEventListener('focusin', keepFocusOnCancel);
  document.removeEventListener('keydown', trapTab, true);
  dialog.close();
  restoreBackground();
  releaseScrollLock?.();
  releaseScrollLock = null;

  const target = returnFocusTo;
  returnFocusTo = null;
  // The page usually re-enables the control it disabled for the call only after the call
  // settles, so wait for that render before handing focus back.
  setTimeout(() => {
    if (target?.isConnected && !state.value.blocking) {
      target.focus();
    }
  }, 0);
}

function setBannerVisible(visible) {
  const banner = bannerRef.value;
  if (!banner) return;

  if (typeof banner.showPopover !== 'function') {
    banner.hidden = !visible;
    return;
  }

  // A popover also joins the top layer, so the banner shows above open dialogs.
  const open = banner.matches(':popover-open');
  if (visible && !open) {
    banner.showPopover();
  } else if (!visible && open) {
    banner.hidePopover();
  }
}

function render() {
  const { blocking, visible } = state.value;
  if (blocking) {
    setBannerVisible(false);
    openDialog();
  } else {
    closeDialog();
    setBannerVisible(visible);
  }
}

watch(() => [state.value.blocking, state.value.visible], render, { flush: 'post' });

onMounted(render);

onBeforeUnmount(() => {
  unsubscribe();
  closeDialog();
});
</script>

<template>
  <Teleport to="body">
    <div ref="rootRef" class="api-working">
      <dialog
        ref="dialogRef"
        class="api-working__dialog"
        role="alertdialog"
        aria-labelledby="api-working-title"
        @cancel="handleDialogCancel"
      >
        <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
        <p id="api-working-title" class="api-working__title">Working...</p>
        <button ref="cancelRef" class="secondary-button secondary-button--compact" type="button" @click="tracker.cancel()">
          Cancel
        </button>
      </dialog>
      <div ref="bannerRef" class="api-working__banner" popover="manual" role="status" aria-live="polite">
        <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
        <span>Working...</span>
      </div>
    </div>
  </Teleport>
</template>
