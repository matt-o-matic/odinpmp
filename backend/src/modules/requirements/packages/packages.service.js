import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../../lib/auth/project-capabilities.js';
import { HttpError } from '../../../lib/errors/http-error.js';
import { LIVE_EVENT_CHANNELS } from '../../../lib/events/live-event-bus.js';
import { buildOperationLogContext, logBackendError } from '../../../lib/logging/backend-logger.js';
import { userActorRef } from '../requirements-topics.js';
import { createPackageGrant, DEFAULT_GRANT_TTL_MS, DEVELOPMENT_GRANT_SECRET, MAX_GRANT_TTL_MS } from './package-grants.js';
import { eachLimited, packageStorageKey } from './package-storage.js';
import { validateReviewPackage } from './package-validator.js';

// Review packages: upload and validation, drafts and versions, replacement and withdrawal,
// MCP upload URLs, and grants for the review origin. Route middleware checks capabilities
// first, so viewers get 404 on writes before a body is read; the service checks again.

export const UPLOAD_URL_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_REVIEW_PACKAGE_MAX_BYTES = 50 * 1024 * 1024;
export const PACKAGES_EVENT = 'requirements.packages.invalidated';
const UPLOAD_TOKEN_PREFIX = 'odin_pkgup_';

function now(deps) {
  return deps.clock ? new Date(deps.clock()) : new Date();
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function hashUploadToken(token) {
  return sha256(token);
}

async function requireCapability(deps, { capability, projectId, user }) {
  const tenantId = user?.memberships?.[0]?.tenantId ?? null;
  await requireProjectCapability({ capability, projectId, repository: deps.projectRepository, tenantId, user });
  return tenantId;
}

function publishPackagesChange(deps, { packageId, projectId, reason, track }) {
  try {
    deps.liveEventBus?.publish(LIVE_EVENT_CHANNELS.project(projectId), {
      packageIds: [packageId],
      projectId,
      reason,
      track,
      type: PACKAGES_EVENT,
    });
  } catch (error) {
    logBackendError({
      context: buildOperationLogContext('requirements.packages.publish', { packageId, projectId, reason }),
      error,
      level: 'warn',
      message: 'Package invalidation event failed.',
    });
  }
}

// The project's latest round: review is project-wide, whatever track a package names.
async function latestRoundId(deps, { projectId, tenantId }) {
  const rounds = await deps.requirementsRepository?.listRounds?.({ projectId, tenantId, track: '' }) ?? [];
  const published = rounds.filter((round) => round.status !== 'draft');
  const latest = published.sort((left, right) => Number(right.number) - Number(left.number))[0] ?? null;
  return latest?.id ?? null;
}

function topicLookup(deps, { projectId, tenantId }) {
  return async (topicId) => {
    const track = await deps.requirementsRepository?.getTopicTrack?.({ clarificationId: topicId, projectId, tenantId }) ?? null;
    return track ? { track } : null;
  };
}

function maxBytes(deps) {
  return Number(deps.reviewPackageMaxBytes ?? DEFAULT_REVIEW_PACKAGE_MAX_BYTES);
}

function notDraft(pkg) {
  return new HttpError(409, `Version ${pkg.version} is no longer a draft: it was published, withdrawn, or replaced. Nothing was stored.`, {
    details: { code: 'package_not_draft', packageId: pkg.id, packageStatus: pkg.status },
  });
}

/**
 * The draft a new upload may replace: one in this project that is still a draft and that no
 * round uses. Published packages and their rounds are never replaced.
 */
async function loadReplaceableDraft(deps, { packageId, projectId, tenantId }) {
  const pkg = await deps.packagesRepository.getPackage({ packageId, projectId, tenantId });
  if (!pkg) throw new HttpError(404, 'Package not found.');
  if (pkg.status !== 'draft') throw notDraft(pkg);
  const rounds = await deps.requirementsRepository?.listRounds?.({ projectId, tenantId, track: pkg.track }) ?? [];
  if (rounds.some((round) => round.packageId === pkg.id)) {
    throw new HttpError(409, 'A round uses this package, so it cannot be replaced.', { details: { code: 'package_in_round', packageId: pkg.id } });
  }
  return pkg;
}

async function deleteStoredFiles(deps, { operation, packageId, projectId }) {
  const files = await deps.packagesRepository.listPackageFiles({ packageId });
  await eachLimited(files, 8, (file) => deps.packageStorage.delete(file.storageKey).catch((error) => {
    logBackendError({
      context: buildOperationLogContext(operation, { packageId, projectId, storageKey: file.storageKey }),
      error,
      level: 'warn',
      message: 'A withdrawn package file could not be deleted.',
    });
  }));
  await deps.packagesRepository.deletePackageFiles({ packageId });
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

async function resolveUploader(deps, actorRef, cache) {
  const ref = String(actorRef ?? '');
  if (cache.has(ref)) return cache.get(ref);
  const [type, id] = ref.includes(':') ? [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)] : ['', ref];
  let name = null;
  if (type === 'user' && id && deps.authRepository?.findUserById) {
    try {
      name = (await deps.authRepository.findUserById(id))?.name ?? null;
    } catch (_error) {
      name = null;
    }
  }
  const uploader = { actorRef: ref, id: id || null, name, type: type || null };
  cache.set(ref, uploader);
  return uploader;
}

function screenTitles(manifest) {
  const screens = (manifest?.sections ?? []).find((section) => section.type === 'screens')?.items ?? [];
  return new Map(screens.map((screen) => [screen.id, screen.title]));
}

async function computeChanges(deps, pkg) {
  const baseline = await deps.packagesRepository.findBaselinePackage({
    beforeVersion: pkg.version,
    projectId: pkg.projectId,
    tenantId: pkg.tenantId,
    track: pkg.track,
  });
  const titles = screenTitles(pkg.manifest);
  const counts = { changed: 0, new: 0, removed: 0, unchanged: 0 };
  const screens = [];
  const previous = new Map((baseline?.screens ?? []).map((screen) => [screen.screenId, screen]));
  for (const screen of pkg.screens) {
    const before = previous.get(screen.screenId);
    const change = !before ? 'new' : before.contentHash === screen.contentHash ? 'unchanged' : 'changed';
    counts[change] += 1;
    screens.push({ change, screenId: screen.screenId, title: titles.get(screen.screenId) ?? null });
  }
  if (baseline) {
    const baselineTitles = screenTitles(baseline.manifest);
    const current = new Set(pkg.screens.map((screen) => screen.screenId));
    for (const screen of baseline.screens) {
      if (current.has(screen.screenId)) continue;
      counts.removed += 1;
      screens.push({ change: 'removed', screenId: screen.screenId, title: baselineTitles.get(screen.screenId) ?? null });
    }
  }
  let round = null;
  if (baseline) {
    const rounds = await deps.requirementsRepository?.listRounds?.({ projectId: pkg.projectId, tenantId: pkg.tenantId, track: pkg.track }) ?? [];
    round = rounds.filter((item) => item.packageId === baseline.id).sort((left, right) => right.number - left.number)[0] ?? null;
  }
  return {
    baseline: baseline
      ? { packageId: baseline.id, roundId: round?.id ?? null, roundNumber: round?.number ?? null, title: baseline.title, version: baseline.version }
      : null,
    counts,
    screens,
  };
}

function summaryView(pkg, uploader) {
  return {
    createdAt: pkg.createdAt,
    fileCount: pkg.fileCount,
    id: pkg.id,
    projectId: pkg.projectId,
    sizeBytes: pkg.sizeBytes,
    source: pkg.source,
    status: pkg.status,
    title: pkg.title,
    track: pkg.track,
    updatedAt: pkg.updatedAt,
    uploadedBy: pkg.uploadedBy,
    uploader,
    version: pkg.version,
    warningCount: pkg.warningCount ?? (pkg.warnings?.length ?? 0),
  };
}

export async function describePackage(deps, pkg, { cache = new Map() } = {}) {
  const uploader = await resolveUploader(deps, pkg.uploadedBy, cache);
  const titles = screenTitles(pkg.manifest);
  return {
    ...summaryView(pkg, uploader),
    changes: await computeChanges(deps, pkg),
    manifest: pkg.manifest,
    screens: pkg.screens.map((screen) => ({ ...screen, title: titles.get(screen.screenId) ?? null })),
    warnings: pkg.warnings ?? [],
  };
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Validates and stores one package. Returns `{ status: 'accepted', package, warnings }` or
 * the spec's `{ status: 'rejected', errors, warnings }`. Nothing is written on rejection,
 * and objects already written are deleted if storing the records fails.
 *
 * With `replacesPackageId`, storing the new draft and withdrawing that draft are one
 * database step: if the draft was published, withdrawn, or replaced meanwhile, nothing is
 * stored and this throws 409 package_not_draft. The replaced draft's files are deleted
 * afterwards, and the result's `replaced` is its withdrawn record.
 */
export async function ingestPackage(deps, { bytes, projectId, replacesPackageId = null, source, tenantId, track, uploadedBy }) {
  const result = await validateReviewPackage({ zip: bytes }, {
    latestRoundId: await latestRoundId(deps, { projectId, tenantId, track }),
    limits: { zipBytes: maxBytes(deps) },
    lookupTopic: topicLookup(deps, { projectId, tenantId }),
    mermaid: deps.mermaidValidator,
    scanner: deps.fileScanner,
    track,
  });
  if (result.status !== 'accepted') {
    return { errors: result.errors, status: 'rejected', warnings: result.warnings };
  }

  const storage = deps.packageStorage;
  if (!storage?.write || !storage?.delete) throw new HttpError(503, 'Package storage is unavailable.');
  const packageId = randomUUID();
  const written = [];
  const files = result.files.map((file) => ({ ...file, storageKey: packageStorageKey(packageId, file.path) }));
  try {
    await eachLimited(files, 8, async (file) => {
      await storage.write(file.storageKey, file.bytes);
      written.push(file.storageKey);
    });
    const record = {
      files: files.map(({ bytes: _bytes, ...file }) => file),
      pkg: {
        fileCount: result.fileCount,
        id: packageId,
        manifest: result.manifest,
        projectId,
        sizeBytes: result.sizeBytes,
        source,
        tenantId,
        title: result.manifest.title,
        track,
        uploadedBy,
        warnings: result.warnings,
      },
      screens: result.screens,
    };
    if (!replacesPackageId) {
      const stored = await deps.packagesRepository.insertPackage(record);
      publishPackagesChange(deps, { packageId, projectId, reason: 'uploaded', track });
      return { package: stored, status: 'accepted', warnings: result.warnings };
    }

    const swapped = await deps.packagesRepository.replaceDraftPackage({ ...record, replacesPackageId });
    if (!swapped) {
      const current = await deps.packagesRepository.getPackage({ packageId: replacesPackageId, projectId, tenantId });
      throw current ? notDraft(current) : new HttpError(404, 'Package not found.');
    }
    // Committed: from here on nothing may fail the replacement or delete the new files.
    written.length = 0;
    await deleteStoredFiles(deps, { operation: 'requirements.packages.replace', packageId: replacesPackageId, projectId }).catch((error) => {
      logBackendError({
        context: buildOperationLogContext('requirements.packages.replace', { packageId: replacesPackageId, projectId }),
        error,
        level: 'warn',
        message: 'The replaced draft’s files could not be cleaned up.',
      });
    });
    publishPackagesChange(deps, { packageId, projectId, reason: 'uploaded', track });
    publishPackagesChange(deps, { packageId: replacesPackageId, projectId, reason: 'replaced', track });
    return { package: swapped.package, replaced: swapped.replaced, status: 'accepted', warnings: result.warnings };
  } catch (error) {
    await eachLimited(written, 8, (key) => storage.delete(key).catch(() => {}));
    throw error;
  }
}

export async function uploadPackageForUser(deps, { bytes, projectId, track, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const outcome = await ingestPackage(deps, { bytes, projectId, source: 'ui', tenantId, track, uploadedBy: userActorRef(user.id) });
  if (outcome.status !== 'accepted') return outcome;
  return { package: await describePackage(deps, outcome.package), status: 'accepted' };
}

/** Checked before the replacement zip is read, so a stale request is refused before its body. */
export async function checkReplaceableForUser(deps, { packageId, projectId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  return loadReplaceableDraft(deps, { packageId, projectId, tenantId });
}

/**
 * Replaces an unpublished draft with a new upload, which becomes the track's next draft
 * version while the old draft is withdrawn. A rejected zip leaves the draft as it was.
 */
export async function replacePackageForUser(deps, { bytes, packageId, projectId, user }) {
  const draft = await checkReplaceableForUser(deps, { packageId, projectId, user });
  const outcome = await ingestPackage(deps, {
    bytes,
    projectId,
    replacesPackageId: draft.id,
    source: 'ui',
    tenantId: draft.tenantId,
    track: draft.track,
    uploadedBy: userActorRef(user.id),
  });
  if (outcome.status !== 'accepted') return outcome;
  const cache = new Map();
  return {
    package: await describePackage(deps, outcome.package, { cache }),
    replaced: summaryView(outcome.replaced, await resolveUploader(deps, outcome.replaced.uploadedBy, cache)),
    status: 'accepted',
  };
}

// ---------------------------------------------------------------------------
// Reads and withdrawal
// ---------------------------------------------------------------------------

export async function listPackagesForUser(deps, { projectId, track = '', user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const packages = await deps.packagesRepository.listPackages({ projectId, tenantId, track });
  const cache = new Map();
  const views = [];
  for (const pkg of packages) {
    views.push(summaryView(pkg, await resolveUploader(deps, pkg.uploadedBy, cache)));
  }
  return { ok: true, packages: views };
}

async function loadPackage(deps, { packageId, projectId, tenantId }) {
  const pkg = await deps.packagesRepository.getPackage({ packageId, projectId, tenantId });
  if (!pkg) throw new HttpError(404, 'Package not found.');
  return pkg;
}

export async function getPackageForUser(deps, { packageId, projectId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const pkg = await loadPackage(deps, { packageId, projectId, tenantId });
  return { ok: true, package: await describePackage(deps, pkg) };
}

export async function withdrawPackageForUser(deps, { packageId, projectId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const pkg = await loadPackage(deps, { packageId, projectId, tenantId });
  if (pkg.status === 'published') throw new HttpError(409, 'A published package cannot be withdrawn.');
  if (pkg.status !== 'draft') throw new HttpError(409, 'This package was already withdrawn.');
  const rounds = await deps.requirementsRepository?.listRounds?.({ projectId, tenantId, track: pkg.track }) ?? [];
  if (rounds.some((round) => round.packageId === pkg.id)) throw new HttpError(409, 'A round uses this package, so it cannot be withdrawn.');

  const updated = await deps.packagesRepository.setPackageStatus({ from: 'draft', packageId, projectId, tenantId, to: 'withdrawn' });
  if (!updated) throw new HttpError(409, 'This package changed while it was being withdrawn. Reload it and try again.');

  await deleteStoredFiles(deps, { operation: 'requirements.packages.withdraw', packageId, projectId });
  publishPackagesChange(deps, { packageId, projectId, reason: 'withdrawn', track: pkg.track });
  return { ok: true, package: await describePackage(deps, updated) };
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

function encodePackagePath(path) {
  return String(path).split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * Issues a review-origin grant for one viewer. `viewerRef` is an actor ref such as
 * `user:<id>` or `stakeholder:<id>`; `ttl` is in milliseconds (default two hours). The
 * caller decides whether the viewer may see the package; pass projectId and tenantId to
 * also confirm the package belongs to that project. A stakeholder's grant needs the
 * `linkId` and `tokenId` of the portal token it is issued through: the review origin
 * serves it only while that token works (package-grant-access.js). Each screen gets its own
 * grant, which loads only what that screen may load (package-scope.js).
 *
 * Returns `{ packageId, entryUrls: { [screenId]: url }, expiresAt }`.
 */
export async function issuePackageGrant(deps, { linkId = null, packageId, projectId = null, tenantId = null, tokenId = null, ttl = DEFAULT_GRANT_TTL_MS, viewerRef }) {
  if (!deps.reviewPublicUrl) {
    throw new HttpError(503, 'The review origin is not configured.', { details: { code: 'review_origin_not_configured' } });
  }
  if (!viewerRef) throw new HttpError(400, 'A grant needs a viewer.');
  if (String(viewerRef).startsWith('stakeholder:') && !(linkId && tokenId)) {
    throw new Error('A stakeholder grant needs the portal link and token it is issued through.');
  }
  const pkg = projectId && tenantId
    ? await deps.packagesRepository.getPackage({ packageId, projectId, tenantId })
    : await deps.packagesRepository.getPackageById(packageId);
  if (!pkg || pkg.status === 'withdrawn') throw new HttpError(404, 'Package not found.');

  const ttlMs = Math.min(MAX_GRANT_TTL_MS, Math.max(60_000, Number(ttl) || DEFAULT_GRANT_TTL_MS));
  const expiresAt = new Date(now(deps).valueOf() + ttlMs);
  const origin = String(deps.reviewPublicUrl).replace(/\/+$/, '');
  const entryUrls = {};
  for (const screen of pkg.screens) {
    const grant = createPackageGrant({
      expiresAt,
      linkId,
      packageId: pkg.id,
      screenId: screen.screenId,
      secret: deps.reviewGrantSecret ?? DEVELOPMENT_GRANT_SECRET,
      tokenId,
      viewerRef,
    });
    entryUrls[screen.screenId] = `${origin}/p/${encodeURIComponent(pkg.id)}/${grant}/${encodePackagePath(screen.src)}`;
  }
  return { entryUrls, expiresAt: new Date(Math.floor(expiresAt.valueOf() / 1000) * 1000).toISOString(), packageId: pkg.id };
}

export async function getPackageGrantForUser(deps, { packageId, projectId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const grant = await issuePackageGrant(deps, { packageId, projectId, tenantId, viewerRef: userActorRef(user.id) });
  return { entryUrls: grant.entryUrls, expiresAt: grant.expiresAt, ok: true };
}

// ---------------------------------------------------------------------------
// Upload URLs (MCP)
// ---------------------------------------------------------------------------

/**
 * With `replacesPackageId`, the URL's package replaces that draft when it is accepted. The
 * draft is checked now, and again, atomically, when the zip arrives.
 */
export async function createUploadUrlForUser(deps, { projectId, replacesPackageId = null, track, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.COLLABORATE, projectId, user });
  const replaces = replacesPackageId ? await loadReplaceableDraft(deps, { packageId: replacesPackageId, projectId, tenantId }) : null;
  if (replaces && replaces.track !== track) {
    throw new HttpError(400, `Version ${replaces.version} belongs to the ${replaces.track} track. Request the upload URL for that track.`, {
      details: { code: 'package_track_mismatch', packageTrack: replaces.track },
    });
  }
  const token = `${UPLOAD_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(now(deps).valueOf() + UPLOAD_URL_TTL_MS);
  const upload = await deps.packagesRepository.createUpload({
    upload: {
      expiresAt,
      issuedTo: userActorRef(user.id),
      projectId,
      replacesPackageId: replaces?.id ?? null,
      tenantId,
      tokenHash: hashUploadToken(token),
      track,
    },
  });
  const base = String(deps.backendPublicUrl ?? 'http://localhost:3001').replace(/\/+$/, '');
  return {
    expiresAt: upload.expiresAt,
    ok: true,
    ...(replaces ? { replaces: { packageId: replaces.id, version: replaces.version } } : {}),
    track,
    uploadId: upload.id,
    url: `${base}/api/public/requirements-uploads/${token}`,
  };
}

function uploadState(deps, upload) {
  if (upload.state === 'accepted' || upload.state === 'rejected' || upload.state === 'expired') return upload.state;
  return Date.parse(upload.expiresAt) <= now(deps).valueOf() ? 'expired' : 'pending';
}

export async function getUploadStatusForUser(deps, { projectId, uploadId, user }) {
  const tenantId = await requireCapability(deps, { capability: PROJECT_CAPABILITIES.READ, projectId, user });
  const upload = await deps.packagesRepository.getUpload({ projectId, tenantId, uploadId });
  if (!upload) throw new HttpError(404, 'Upload not found.');
  const state = uploadState(deps, upload);
  const response = { expiresAt: upload.expiresAt, ok: true, state, track: upload.track, uploadId: upload.id };
  if (upload.replacesPackageId) response.replacesPackageId = upload.replacesPackageId;
  if (state === 'accepted' && upload.packageId) {
    const pkg = await deps.packagesRepository.getPackage({ packageId: upload.packageId, projectId, tenantId });
    if (pkg) response.package = await describePackage(deps, pkg);
    response.warnings = upload.result?.warnings ?? [];
  } else if (state === 'rejected') {
    response.errors = upload.result?.errors ?? [];
    response.warnings = upload.result?.warnings ?? [];
  }
  return response;
}

/** Cheap check before reading an upload body: is this token pending and unexpired? */
export async function findPendingUpload(deps, { token }) {
  if (typeof token !== 'string' || !token.startsWith(UPLOAD_TOKEN_PREFIX) || token.length > 200) return null;
  const upload = await deps.packagesRepository.findUploadByTokenHash({ tokenHash: hashUploadToken(token) });
  if (!upload || upload.state !== 'pending' || Date.parse(upload.expiresAt) <= now(deps).valueOf()) return null;
  return upload;
}

async function issuerCanStillUpload(deps, upload) {
  const userId = upload.issuedTo.startsWith('user:') ? upload.issuedTo.slice('user:'.length) : '';
  const user = userId ? await deps.authRepository?.findUserById?.(userId) : null;
  if (!user) return false;
  try {
    await requireProjectCapability({
      capability: PROJECT_CAPABILITIES.COLLABORATE,
      projectId: upload.projectId,
      repository: deps.projectRepository,
      tenantId: upload.tenantId,
      user,
    });
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * The public upload URL. The token is single-use: it is claimed before validation, so a
 * second PUT with the same URL gets 404 whatever the first one's outcome.
 */
export async function uploadPackageWithToken(deps, { bytes, token }) {
  const claimed = typeof token === 'string' && token.startsWith(UPLOAD_TOKEN_PREFIX)
    ? await deps.packagesRepository.claimUpload({ now: now(deps), tokenHash: hashUploadToken(token) })
    : null;
  if (!claimed) throw new HttpError(404, 'Upload URL not found.');

  if (!await issuerCanStillUpload(deps, claimed)) {
    await deps.packagesRepository.completeUpload({ now: now(deps), result: null, state: 'expired', uploadId: claimed.id });
    throw new HttpError(404, 'Upload URL not found.');
  }

  let outcome;
  try {
    if (claimed.replacesPackageId) {
      await loadReplaceableDraft(deps, { packageId: claimed.replacesPackageId, projectId: claimed.projectId, tenantId: claimed.tenantId });
    }
    outcome = await ingestPackage(deps, {
      bytes,
      projectId: claimed.projectId,
      replacesPackageId: claimed.replacesPackageId ?? null,
      source: 'mcp',
      tenantId: claimed.tenantId,
      track: claimed.track,
      uploadedBy: claimed.issuedTo,
    });
  } catch (error) {
    if (claimed.replacesPackageId && error instanceof HttpError && error.statusCode === 409) {
      // The draft to replace changed first. The URL is spent and nothing was stored; the
      // status keeps the reason in the validation result's shape.
      const code = error.details?.code ?? 'package_not_draft';
      await deps.packagesRepository.completeUpload({
        now: now(deps),
        result: { errors: [{ code, file: '', message: error.message, path: '' }], warnings: [] },
        state: 'rejected',
        uploadId: claimed.id,
      }).catch(() => {});
      error.details = { ...error.details, state: 'rejected', uploadId: claimed.id };
      throw error;
    }
    // Storage or database failure: the URL is spent; the agent requests a new one.
    await deps.packagesRepository.completeUpload({ now: now(deps), result: null, state: 'expired', uploadId: claimed.id }).catch(() => {});
    throw error;
  }

  if (outcome.status !== 'accepted') {
    await deps.packagesRepository.completeUpload({
      now: now(deps),
      result: { errors: outcome.errors, warnings: outcome.warnings },
      state: 'rejected',
      uploadId: claimed.id,
    });
    return { errors: outcome.errors, state: 'rejected', status: 'rejected', uploadId: claimed.id, warnings: outcome.warnings };
  }
  await deps.packagesRepository.completeUpload({
    now: now(deps),
    packageId: outcome.package.id,
    result: { errors: [], warnings: outcome.warnings },
    state: 'accepted',
    uploadId: claimed.id,
  });
  return { package: await describePackage(deps, outcome.package), state: 'accepted', status: 'accepted', uploadId: claimed.id };
}
