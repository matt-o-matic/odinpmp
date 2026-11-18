// Runs a data-seeding helper once per key (a pool, or the executor itself) for the life of the
// process. Project reads use it so the canonical task types are written at most once rather
// than checked on every read. A run that fails is forgotten, so the next call tries again.
// It is not for schema: only migrations create or change schema
// (src/jobs/bootstrap-schema.lib.js), and test/no-runtime-schema.test.js keeps it that way.

const runs = new WeakMap();

export function ensureOnce(key, ensure, executor = key) {
  let byHelper = runs.get(key);
  if (!byHelper) {
    byHelper = new Map();
    runs.set(key, byHelper);
  }
  if (!byHelper.has(ensure)) {
    const run = Promise.resolve().then(() => ensure(executor)).catch((error) => {
      byHelper.delete(ensure);
      throw error;
    });
    byHelper.set(ensure, run);
  }
  return byHelper.get(ensure);
}
