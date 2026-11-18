// A memory the AI records after applying changes describes the plan as it stood then. It stays
// fresh for 30 days; after that it is marked stale so the assistant checks the current plan
// before relying on it. Memories people add carry no freshness date and never go stale.
export const APPLIED_CHANGE_FRESH_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function appliedChangeFreshUntil(sourceAt) {
  return new Date(new Date(sourceAt).getTime() + APPLIED_CHANGE_FRESH_DAYS * DAY_MS).toISOString();
}
