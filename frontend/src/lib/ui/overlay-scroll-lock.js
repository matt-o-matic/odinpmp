import { onBeforeUnmount, watch } from 'vue';

let activeLockCount = 0;
let previousBodyOverflow = '';
let previousBodyOverscrollBehavior = '';
let previousBodyPaddingRight = '';
let previousDocumentOverflow = '';
let previousDocumentOverscrollBehavior = '';
let scrollLockDocument = null;
let scrollLockWindow = null;

function getDocument(targetDocument) {
  if (targetDocument?.body && targetDocument?.documentElement) {
    return targetDocument;
  }

  if (typeof document !== 'undefined' && document?.body && document?.documentElement) {
    return document;
  }

  return null;
}

function getWindow(targetWindow) {
  if (targetWindow?.innerWidth != null) {
    return targetWindow;
  }

  if (typeof window !== 'undefined' && window?.innerWidth != null) {
    return window;
  }

  return null;
}

function readSourceValue(source) {
  if (typeof source === 'function') {
    return Boolean(source());
  }

  return Boolean(source?.value ?? source);
}

function scrollbarCompensation(documentRef, windowRef) {
  const viewportWidth = Number(windowRef?.innerWidth ?? 0);
  const clientWidth = Number(documentRef?.documentElement?.clientWidth ?? 0);
  if (!viewportWidth || !clientWidth) {
    return 0;
  }

  return Math.max(0, viewportWidth - clientWidth);
}

function applyScrollLock(documentRef, windowRef) {
  previousBodyOverflow = documentRef.body.style.overflow;
  previousBodyOverscrollBehavior = documentRef.body.style.overscrollBehavior;
  previousBodyPaddingRight = documentRef.body.style.paddingRight;
  previousDocumentOverflow = documentRef.documentElement.style.overflow;
  previousDocumentOverscrollBehavior = documentRef.documentElement.style.overscrollBehavior;

  const compensation = scrollbarCompensation(documentRef, windowRef);
  documentRef.documentElement.style.overflow = 'hidden';
  documentRef.documentElement.style.overscrollBehavior = 'none';
  documentRef.body.style.overflow = 'hidden';
  documentRef.body.style.overscrollBehavior = 'none';

  if (compensation > 0) {
    documentRef.body.style.paddingRight = `${compensation}px`;
  }
}

function restoreScrollLock(documentRef) {
  documentRef.documentElement.style.overflow = previousDocumentOverflow;
  documentRef.documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
  documentRef.body.style.overflow = previousBodyOverflow;
  documentRef.body.style.overscrollBehavior = previousBodyOverscrollBehavior;
  documentRef.body.style.paddingRight = previousBodyPaddingRight;
}

export function acquireOverlayScrollLock({
  document: targetDocument,
  window: targetWindow,
} = {}) {
  const documentRef = getDocument(targetDocument);
  if (!documentRef) {
    return () => {};
  }

  const windowRef = getWindow(targetWindow);
  if (activeLockCount === 0) {
    scrollLockDocument = documentRef;
    scrollLockWindow = windowRef;
    applyScrollLock(documentRef, windowRef);
  }

  activeLockCount += 1;

  let released = false;
  return () => {
    if (released) {
      return;
    }

    released = true;
    activeLockCount = Math.max(0, activeLockCount - 1);
    if (activeLockCount === 0 && scrollLockDocument) {
      restoreScrollLock(scrollLockDocument);
      scrollLockDocument = null;
      scrollLockWindow = null;
    }
  };
}

export function useOverlayScrollLock(source, options = {}) {
  let release = null;

  watch(
    () => readSourceValue(source),
    (locked) => {
      if (locked && !release) {
        release = acquireOverlayScrollLock(options);
        return;
      }

      if (!locked && release) {
        release();
        release = null;
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    if (release) {
      release();
      release = null;
    }
  });
}

export function resetOverlayScrollLockForTests() {
  if (activeLockCount === 0 || !scrollLockDocument) {
    activeLockCount = 0;
    scrollLockDocument = null;
    scrollLockWindow = null;
    previousBodyOverflow = '';
    previousBodyOverscrollBehavior = '';
    previousBodyPaddingRight = '';
    previousDocumentOverflow = '';
    previousDocumentOverscrollBehavior = '';
    return;
  }

  restoreScrollLock(scrollLockDocument);
  activeLockCount = 0;
  scrollLockDocument = null;
  scrollLockWindow = null;
  previousBodyOverflow = '';
  previousBodyOverscrollBehavior = '';
  previousBodyPaddingRight = '';
  previousDocumentOverflow = '';
  previousDocumentOverscrollBehavior = '';
}
