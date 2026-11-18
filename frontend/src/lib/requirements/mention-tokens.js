// Matching people to tag in Requirements comments. The editor's @ list calls this with the
// people the server says the writer may tag; storage and rendering of tags live in
// lib/rich-content/comment-markdown.js.

/** People matching a query, names starting with it first, at most `limit`. */
export function filterMentionables(people = [], query = '', { limit = 8 } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  const scored = [];
  for (const person of people ?? []) {
    const name = String(person?.name ?? '').toLowerCase();
    if (!name) continue;
    if (!needle) {
      scored.push({ person, score: 1 });
      continue;
    }
    if (name.startsWith(needle)) scored.push({ person, score: 0 });
    else if (name.split(/\s+/).some((word) => word.startsWith(needle))) scored.push({ person, score: 1 });
    else if (name.includes(needle)) scored.push({ person, score: 2 });
  }
  return scored
    .sort((left, right) => left.score - right.score || String(left.person.name).localeCompare(String(right.person.name)))
    .slice(0, limit)
    .map((entry) => entry.person);
}
