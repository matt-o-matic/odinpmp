import assert from 'node:assert/strict';
import test from 'node:test';

import { nextTick, ref } from 'vue';

import {
  createDarkModeController,
  DARK_MODE_KEY,
} from '../src/lib/ui/theme.js';

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

function createClassListProbe() {
  const values = new Map();
  return {
    classList: {
      contains(name) {
        return values.get(name) === true;
      },
      toggle(name, enabled) {
        values.set(name, Boolean(enabled));
      },
    },
  };
}

test('createDarkModeController toggles dark mode even when preference is storage-backed only', async () => {
  const storage = createMemoryStorage();
  const target = createClassListProbe();
  const currentUser = ref({
    preferences: {},
  });

  const controller = createDarkModeController({
    currentUserRef: currentUser,
    storage,
    target,
  });

  await nextTick();
  assert.equal(controller.darkMode.value, false);
  assert.equal(target.classList.contains('dark'), false);

  controller.toggleDarkMode();
  await nextTick();

  assert.equal(controller.darkMode.value, true);
  assert.equal(target.classList.contains('dark'), true);
  assert.equal(storage.getItem(DARK_MODE_KEY), 'true');
  assert.equal(currentUser.value.preferences.darkMode, true);
});
