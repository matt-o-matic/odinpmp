// Keeping the search index current (docs/semantic-search/plan.md).
//
// - updateSearchFileTexts extracts the text of files that are new or changed, at most `limit` per
//   run, and caches it (search_file_texts); later runs take the rest.
// - planSearchChanges compares the rows a refresh built with what is stored: rows whose text
//   changed are written; rows embedded with another model or size, or not at all, are embedded
//   again; rows whose source is gone are deleted.
// - refreshAllSearchIndexes runs a refresh for every workspace, one at a time; each takes its
//   workspace's lock (startSearchIndexScheduler runs it every minute).
import { buildOperationLogContext, logBackendError } from '../../lib/logging/backend-logger.js';
import { DOCUMENT_TEXT_LIMITS } from '../vault/vault-text.js';
import { FILE_TEXT_MAX_BYTES, documentKind, isTextFile, readableFileText } from '../vault/vault.service.js';

export const FILE_EXTRACTIONS_PER_RUN = 20;
export const EMBEDDINGS_PER_RUN = 2000;
// After an embedding call fails, a workspace's rows are not sent again for this long.
export const EMBEDDING_RETRY_MS = 10 * 60_000;

/** The provider that embeds search rows and queries: its own, or agent memory's. */
export function searchEmbeddingProviderOf(dependencies) {
  return dependencies?.searchEmbeddingProvider ?? dependencies?.memoryEmbeddingProvider ?? null;
}

const readable = (file) => Boolean(documentKind(file)) || isTextFile(file);
const clean = (file) => (file.scanStatus ?? 'clean') === 'clean';

/**
 * Brings the cached text of a workspace's files up to date and returns it by file id. A file is
 * read again when its version or sha256 changes. A file that can't be read is remembered with the
 * reason, and tried again only when it changes; one not yet scanned clean, or that failed for a
 * reason that may pass (Odin was busy), is tried on a later run.
 */
export async function updateSearchFileTexts({ files, limit = FILE_EXTRACTIONS_PER_RUN, projectRepository, repository, tenantId }) {
  if (!repository?.listSearchFileTexts) return new Map();
  const cached = new Map((await repository.listSearchFileTexts({ tenantId })).map((entry) => [entry.fileId, entry]));
  const present = new Set(files.map((file) => file.id));
  const gone = [...cached.keys()].filter((fileId) => !present.has(fileId));
  if (gone.length) await repository.deleteSearchFileTexts({ fileIds: gone, tenantId });
  const stale = (file) => {
    const entry = cached.get(file.id);
    return !entry || entry.version !== file.version || Boolean(file.sha256 && entry.sha256 && entry.sha256 !== file.sha256);
  };
  const due = files.filter((file) => readable(file) && clean(file) && stale(file)).slice(0, limit);
  for (const file of due) {
    const save = async (status, fields = {}) => {
      const entry = { fileId: file.id, reason: '', sha256: file.sha256 ?? null, status, tenantId, text: '', version: file.version, ...fields };
      await repository.saveSearchFileText(entry);
      cached.set(file.id, entry);
    };
    const maxBytes = documentKind(file) ? DOCUMENT_TEXT_LIMITS.bytes : FILE_TEXT_MAX_BYTES;
    if (file.fileSize > maxBytes) {
      await save('skipped', { reason: 'text_too_large' });
      continue;
    }
    try {
      const source = await projectRepository.getFileVersionSource({ fileId: file.id, includeBytes: true, tenantId });
      if (!source?.bytes) continue;
      const text = await readableFileText({ contentType: file.contentType, fileName: file.fileName }, source.bytes);
      await save('ok', { sha256: source.sha256 ?? file.sha256 ?? null, text });
    } catch (error) {
      const status = Number(error?.statusCode ?? 0);
      // 413, 415 and 422 are about the file itself; anything else may pass, so it is tried again.
      if ([413, 415, 422].includes(status)) await save('failed', { reason: String(error.details?.code ?? error.message ?? 'unreadable') });
    }
  }
  return cached;
}

/**
 * What a refresh writes, embeds and deletes. `manifests` are the stored rows' keys, hashes and
 * embedding spaces; `provider` is the search embedding provider, or null.
 */
export function planSearchChanges({ documents, manifests, provider }) {
  const stored = new Map(manifests.map((item) => [`${item.type}:${item.sourceId}`, item]));
  const keys = new Set();
  const changed = [];
  const reembed = [];
  for (const document of documents) {
    const key = `${document.documentType}:${document.sourceId}`;
    keys.add(key);
    const current = stored.get(key);
    if (!current || current.sourceHash !== document.sourceHash) changed.push(document);
    else if (provider && (current.embeddingModel !== provider.model || Number(current.embeddingDimensions) !== Number(provider.dimensions))) reembed.push(document);
  }
  const deletes = manifests.filter((item) => !keys.has(`${item.type}:${item.sourceId}`)).map((item) => ({ sourceId: item.sourceId, type: item.type }));
  return { changed, deletes, reembed };
}

const embeddingPauses = new WeakMap();

function pausedUntil(provider, tenantId) {
  return embeddingPauses.get(provider)?.get(tenantId) ?? 0;
}

function pause(provider, tenantId, now) {
  if (!embeddingPauses.has(provider)) embeddingPauses.set(provider, new Map());
  embeddingPauses.get(provider).set(tenantId, now + EMBEDDING_RETRY_MS);
}

/**
 * Embeds what it can of `changed` (first) and `reembed`, at most `budget` rows. Changed rows are
 * written whether or not they were embedded; a row only waiting for a new embedding is written
 * once it has one, so a failure leaves its stored row as it was.
 */
export async function embedSearchChanges({ budget = EMBEDDINGS_PER_RUN, changed, now = Date.now(), provider, reembed, tenantId }) {
  if (!provider || (!changed.length && !reembed.length)) return { semanticIndexed: 0, semanticStatus: provider ? 'indexed' : 'disabled', upserts: changed };
  if (pausedUntil(provider, tenantId) > now) return { semanticIndexed: 0, semanticStatus: 'paused', upserts: changed };
  const wanted = [...changed, ...reembed].slice(0, budget);
  try {
    const inputs = wanted.map((document) => ({ content: document.content, tenantId, title: document.title }));
    const embeddings = provider.embedMany ? await provider.embedMany(inputs) : await Promise.all(inputs.map((input) => provider.embed(input)));
    wanted.forEach((document, index) => { document.embedding = embeddings[index]; });
    const embedded = new Set(wanted);
    return { semanticIndexed: wanted.length, semanticStatus: 'indexed', upserts: [...changed, ...reembed.filter((document) => embedded.has(document))] };
  } catch (error) {
    pause(provider, tenantId, now);
    logBackendError({ context: buildOperationLogContext('search.embed', { rows: wanted.length, tenantId }), error, level: 'warn', message: 'Search rows could not be embedded; they stay keyword-only for now.' });
    return { semanticIndexed: 0, semanticStatus: 'unavailable', upserts: changed };
  }
}

/** Refreshes every workspace's index in turn; each refresh takes its workspace's lock. */
export async function refreshAllSearchIndexes({ refreshTenant, repository }) {
  const results = [];
  for (const tenantId of await repository.listSearchTenantIds()) {
    try {
      results.push({ tenantId, ...await refreshTenant(tenantId) });
    } catch (error) {
      logBackendError({ context: buildOperationLogContext('search.refresh', { tenantId }), error, level: 'warn', message: 'A workspace search index could not be refreshed; it keeps its previous rows.' });
      results.push({ ok: false, tenantId });
    }
  }
  return results;
}

/** Runs `run` every `intervalMs` (not overlapping itself). Returns stop(). */
export function startSearchIndexScheduler({ intervalMs = 60_000, run }) {
  if (!(intervalMs > 0)) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } catch (error) {
      logBackendError({ context: buildOperationLogContext('search.schedule', {}), error, level: 'warn', message: 'The scheduled search index refresh failed.' });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
