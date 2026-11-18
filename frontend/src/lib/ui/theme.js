import { inject, ref, watch } from 'vue';

export const DARK_MODE_KEY = 'odinpmp.theme.dark';

// App.vue provides its controller under this key so screens outside the app's navbar (the
// stakeholder portal) can show the same toggle.
export const DARK_MODE_CONTEXT = Symbol('odinpmp.darkMode');

/** The app's { darkMode, toggleDarkMode }, or null when nothing provides it. */
export function useDarkMode() {
  return inject(DARK_MODE_CONTEXT, null);
}

export function readStoredDarkMode(storage = null) {
  try {
    return storage?.getItem?.(DARK_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeStoredDarkMode(storage = null, enabled = false) {
  try {
    storage?.setItem?.(DARK_MODE_KEY, String(Boolean(enabled)));
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

function applyDarkModeClass(target = null, enabled = false) {
  target?.classList?.toggle?.('dark', Boolean(enabled));
}

export function createDarkModeController({
  currentUserRef = null,
  storage = null,
  target = null,
} = {}) {
  const darkMode = ref(false);

  watch(
    () => currentUserRef?.value?.preferences?.darkMode,
    (serverPreference) => {
      darkMode.value = typeof serverPreference === 'boolean'
        ? serverPreference
        : readStoredDarkMode(storage);
    },
    { immediate: true },
  );

  watch(darkMode, (enabled) => {
    applyDarkModeClass(target, enabled);
  }, { immediate: true });

  function toggleDarkMode() {
    const next = !darkMode.value;
    darkMode.value = next;

    if (currentUserRef?.value) {
      currentUserRef.value.preferences = {
        ...currentUserRef.value.preferences,
        darkMode: next,
      };
    }

    writeStoredDarkMode(storage, next);
    return next;
  }

  return {
    darkMode,
    toggleDarkMode,
  };
}
