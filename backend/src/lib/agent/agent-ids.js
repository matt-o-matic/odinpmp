// The model sometimes copies an id with the end of another id glued on. In one chat it wrote
// 97042a21-9906-4f5a-bc9b-6bbb81a9cec2 for the story 97042a21-9906-4f14-bb17-4bfe6b213021, the
// tail taken from the story d03dedbb-a62a-4f5a-bc9b-6bbb81a9cec2: calls with it failed, and links
// to it led nowhere. The start always stayed right, so an id that matches nothing known is read
// as the one known id that starts with the same 8 characters, when exactly one does.
//
// Known ids: those in the user's messages and the turn notes, those Odin returned this turn, and
// the items of the projects in play, read once when an id first matches nothing.

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PREFIX = 8;

const textOf = (value) => (typeof value === 'string' ? value : JSON.stringify(value) ?? '');
const idsIn = (value) => textOf(value).match(UUID) ?? [];

// loadProjectIds(projectId): the ids of a project's items.
export function createIdRepair({ loadProjectIds, projectId = null }) {
  const known = new Set();
  const byPrefix = new Map();
  const loads = new Map();

  function add(id) {
    const key = String(id).toLowerCase();
    if (known.has(key)) return;
    known.add(key);
    const prefix = key.slice(0, PREFIX);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), key]);
  }
  if (projectId) add(projectId);

  function load(id) {
    if (!id) return Promise.resolve();
    if (!loads.has(id)) {
      loads.set(id, Promise.resolve()
        .then(() => loadProjectIds(id))
        .then((ids) => { add(id); for (const itemId of ids) add(itemId); }, () => {}));
    }
    return loads.get(id);
  }

  function correction(id) {
    if (known.has(id.toLowerCase())) return null;
    const matches = byPrefix.get(id.slice(0, PREFIX).toLowerCase()) ?? [];
    return matches.length === 1 ? matches[0] : null;
  }

  function rewrite(value, corrected) {
    if (typeof value === 'string') {
      return value.replace(UUID, (id) => {
        const used = correction(id);
        if (!used) return id;
        if (!corrected.some((entry) => entry.given === id)) corrected.push({ given: id, used });
        return used;
      });
    }
    if (Array.isArray(value)) return value.map((entry) => rewrite(entry, corrected));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry, corrected)]));
    return value;
  }

  return {
    learn(value) {
      for (const id of idsIn(value)) add(id);
    },
    // A call's arguments or a reply, with each id that matches nothing corrected where it can be.
    // callProjectId: the project a call names, whose items are read too.
    async repair(value, { callProjectId = null } = {}) {
      if (!idsIn(value).some((id) => !known.has(id.toLowerCase()))) return { corrected: [], value };
      await load(projectId);
      if (typeof callProjectId === 'string') await load(correction(callProjectId) ?? callProjectId);
      const corrected = [];
      const next = rewrite(value, corrected);
      return corrected.length ? { corrected, value: next } : { corrected, value };
    },
  };
}
