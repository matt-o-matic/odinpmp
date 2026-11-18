// The profile form edits a user's own `user_preferences` JSON, but some keys in it belong to the
// server: `twoFactorEnabled` turns on the sign-in code prompt and only changes through the
// two-factor endpoints, which need a code. A profile save keeps those keys' stored values, and
// keys the form leaves out keep theirs too, so a form loaded earlier can't undo later changes.
export const SERVER_OWNED_PREFERENCE_KEYS = Object.freeze(['twoFactorEnabled']);

export function mergeProfilePreferences(stored, submitted) {
  const current = stored && typeof stored === 'object' ? stored : {};
  const merged = { ...current, ...(submitted ?? {}) };
  for (const key of SERVER_OWNED_PREFERENCE_KEYS) {
    if (Object.hasOwn(current, key)) merged[key] = current[key];
    else delete merged[key];
  }
  return merged;
}
