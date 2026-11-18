import { dirname } from './package-files.js';

// What each screen may load from the review origin (package-spec.md section 6). A prototype
// loads its own directory and the package's shared files: everything outside every prototype
// directory except image screen files and the manifest. An image screen loads its own file.
// Grants name their screen and the review origin enforces this, so a prototype's content
// hash, which covers exactly its scope, also covers everything its scripts can load.

export const MANIFEST_PATH = 'manifest.json';

/** True when `path` sits under `directory`; the package root holds everything but the manifest. */
export function isUnder(path, directory) {
  return directory ? path.startsWith(`${directory}/`) : path !== MANIFEST_PATH;
}

/** The layout scopes depend on, from manifest screen items or stored screen records. */
export function packageLayout(screens = []) {
  return {
    imageSources: new Set(screens.filter((screen) => screen.kind === 'image').map((screen) => screen.src)),
    prototypeDirectories: screens.filter((screen) => screen.kind === 'prototype').map((screen) => dirname(screen.src)),
  };
}

export function isSharedPath(path, layout) {
  return path !== MANIFEST_PATH
    && !layout.imageSources.has(path)
    && !layout.prototypeDirectories.some((directory) => isUnder(path, directory));
}

/** Whether a grant for `screen` may load the package file at `path`. */
export function screenScopeAllows(screen, path, layout) {
  if (screen.kind === 'image') return path === screen.src;
  return isUnder(path, dirname(screen.src)) || isSharedPath(path, layout);
}
