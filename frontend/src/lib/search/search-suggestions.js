import { reactive } from 'vue';

import { searchResultLink, searchTypeLabel } from './enterprise-search.js';

// Results as you type in the top bar's search (Ctrl+K) and Odin Chat's jump box: after a
// pause, the best few matches by meaning or by words.

export const SUGGESTION_MIN_CHARS = 3;
export const SUGGESTION_DELAY_MS = 300;
export const SUGGESTION_LIMIT = 5;

/**
 * `search({ limit, query })` returns the search route's payload. update(text) is called on each
 * change; only the latest text's answer is kept, so a slow earlier reply never replaces it.
 */
export function createSearchSuggestions({
  delayMs = SUGGESTION_DELAY_MS,
  limit = SUGGESTION_LIMIT,
  minChars = SUGGESTION_MIN_CHARS,
  search,
  timers = { clear: (id) => clearTimeout(id), set: (callback, ms) => setTimeout(callback, ms) },
}) {
  const state = reactive({ error: false, loading: false, query: '', results: [] });
  let timer = null;
  let run = 0;

  function update(text) {
    const query = String(text ?? '').trim();
    timers.clear(timer);
    timer = null;
    run += 1;
    // Results belong to the text they answered: a new text shows none until its own arrive.
    if (query !== state.query) state.results = [];
    state.query = query;
    if (query.length < minChars) {
      state.results = [];
      state.loading = false;
      state.error = false;
      return;
    }
    const mine = run;
    state.loading = true;
    timer = timers.set(async () => {
      try {
        const result = await search({ limit, query });
        if (mine !== run) return;
        state.results = (result?.records ?? []).slice(0, limit);
        state.error = false;
      } catch {
        if (mine !== run) return;
        state.results = [];
        state.error = true;
      } finally {
        if (mine === run) state.loading = false;
      }
    }, delayMs);
  }

  return { clear: () => update(''), state, update };
}

/**
 * Who is signed in, and to which workspace: results shown to one person must not stay for the
 * next one in the same tab.
 */
export function signedInKey(currentUser) {
  if (!currentUser?.id) return '';
  return `${currentUser.id}:${currentUser.tenantId ?? currentUser.memberships?.[0]?.tenantId ?? ''}`;
}

/** A result as an option in a list: its title, its type and project, and where it opens. */
export function suggestionOption(record) {
  const project = String(record?.facets?.project ?? '').trim();
  return {
    detail: [searchTypeLabel(record?.documentType), project].filter(Boolean).join(' · '),
    documentType: record?.documentType ?? '',
    key: `result:${record?.id ?? record?.sourceId}`,
    kind: 'result',
    label: String(record?.title ?? ''),
    to: searchResultLink(record),
  };
}

const RESULT_ICONS = { comment: 'bi-chat-square-quote', epic: 'bi-collection', file: 'bi-file-earmark-text', post: 'bi-chat-left-text', project: 'bi-folder2-open', story: 'bi-bookmark', task: 'bi-check2-square' };

export function suggestionIcon(documentType) {
  return RESULT_ICONS[documentType] ?? 'bi-search';
}
