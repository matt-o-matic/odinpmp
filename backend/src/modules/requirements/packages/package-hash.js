import { createHash } from 'node:crypto';

import { dirname } from './package-files.js';
import { isSharedPath, isUnder, packageLayout } from './package-scope.js';

// Content hashes per screen (package-spec.md section 6). A screen whose id and hash match
// the previous version is unchanged, so its open annotations carry forward.

// Opens the second part of a prototype's hash input: its shared files, by full path. Every
// file record starts with a non-empty path, and package paths contain no control characters,
// so no record reads as this marker, and a shared file can never stand in for a same-named
// file inside the prototype's directory.
const SHARED_SECTION_MARKER = Buffer.from('\0shared\0', 'utf8');

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function updateWithFile(hash, name, bytes) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(Buffer.from(name, 'utf8'));
  hash.update(Buffer.from([0]));
  hash.update(length);
  hash.update(bytes);
}

/**
 * Prototype hash over everything the prototype may load (package-scope.js), in two parts:
 * 1. Every file under the directory that contains `src`, ordered by path. Each file
 *    contributes its path relative to that directory, its length, and its bytes, so moving
 *    the whole prototype directory keeps the hash. The root manifest is excluded: it changes
 *    with every version even when a root-level prototype does not.
 * 2. After a marker, every shared file by full path, in path order.
 *
 * `layout` comes from packageLayout. Without it, every file outside the prototype's
 * directory counts as shared.
 */
export function prototypeHash(src, filesByPath, layout = packageLayout([{ kind: 'prototype', src }])) {
  const directory = dirname(src);
  const prefix = directory ? `${directory}/` : '';
  const paths = [...filesByPath.keys()];
  const own = paths.filter((path) => isUnder(path, directory)).sort(compareUtf8);
  const shared = paths.filter((path) => !isUnder(path, directory) && isSharedPath(path, layout)).sort(compareUtf8);

  const hash = createHash('sha256');
  for (const path of own) updateWithFile(hash, path.slice(prefix.length), filesByPath.get(path));
  hash.update(SHARED_SECTION_MARKER);
  for (const path of shared) updateWithFile(hash, path, filesByPath.get(path));
  return hash.digest('hex');
}

export function screenContentHash(screen, filesByPath, layout) {
  if (screen.kind === 'prototype') return prototypeHash(screen.src, filesByPath, layout);
  return sha256Hex(filesByPath.get(screen.src) ?? Buffer.alloc(0));
}

export function screensSection(manifest) {
  return (manifest?.sections ?? []).find((section) => section?.type === 'screens') ?? null;
}

/** `[{ screenId, kind, src, contentHash, directionId, title }]` in manifest order. */
export function computeScreenRecords(manifest, filesByPath) {
  const screens = screensSection(manifest)?.items ?? [];
  const layout = packageLayout(screens);
  return screens.map((screen) => ({
    contentHash: screenContentHash(screen, filesByPath, layout),
    directionId: screen.directionId ?? null,
    kind: screen.kind,
    screenId: screen.id,
    src: screen.src,
    title: screen.title,
  }));
}
