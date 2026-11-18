/**
 * Runs `run` over `items` with at most `limit` calls in flight, and returns the results in
 * the order of `items`. Screens that read many projects at once use it to bound the load.
 */
export async function mapWithConcurrency(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
