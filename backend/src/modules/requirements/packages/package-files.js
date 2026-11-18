// File rules shared by the package validator, the review origin, and the developer CLI.
// package-spec.md section 1 is the source for every value here.

export const PACKAGE_LIMITS = Object.freeze({
  compressionRatio: 100,
  entries: 1000,
  manifestBytes: 512 * 1024,
  pathLength: 240,
  totalUncompressedBytes: 200 * 1024 * 1024,
  zipBytes: 50 * 1024 * 1024,
});

// Odin decides every content type from the extension. Nothing a package says about its
// own files changes this.
export const CONTENT_TYPES = Object.freeze({
  css: 'text/css; charset=utf-8',
  gif: 'image/gif',
  html: 'text/html; charset=utf-8',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
});

// "Prototypes only" in the spec: documents and scripts must live inside a prototype's
// directory, where the content hash covers them.
export const PROTOTYPE_ONLY_EXTENSIONS = Object.freeze(new Set(['html', 'js', 'mjs']));

const RESERVED_NAMES = new Set([
  'con', 'nul', 'aux', 'prn',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function fileExtension(path) {
  const name = String(path ?? '').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function contentTypeForPath(path) {
  return CONTENT_TYPES[fileExtension(path)] ?? null;
}

export function dirname(path) {
  const index = String(path).lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/**
 * Checks one entry name against the path rules. Returns null when the path is fine, or
 * `{ code, message }` with `path_invalid` or `zip_limit`.
 */
export function checkPackagePath(rawPath, { isDirectory = false, limits = PACKAGE_LIMITS } = {}) {
  const path = String(rawPath ?? '');
  const shown = JSON.stringify(path.length > 120 ? `${path.slice(0, 117)}...` : path);
  const trimmed = isDirectory ? path.replace(/\/+$/, '') : path;

  if (!trimmed) return { code: 'path_invalid', message: `${shown} is not a valid path.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return { code: 'path_invalid', message: `${shown} contains control characters.` };
  if (path.includes('\\')) return { code: 'path_invalid', message: `${shown} uses "\\". Paths must use "/".` };
  if (path.startsWith('/')) return { code: 'path_invalid', message: `${shown} is absolute. Paths must be relative to the package root.` };
  if (/^[A-Za-z]:/.test(path)) return { code: 'path_invalid', message: `${shown} starts with a drive letter.` };

  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (segment === '..') return { code: 'path_invalid', message: `${shown} leaves the package with "..".` };
    if (segment === '.' || segment === '') return { code: 'path_invalid', message: `${shown} has an empty or "." segment.` };
    const base = segment.split('.')[0].toLowerCase();
    if (RESERVED_NAMES.has(base)) return { code: 'path_invalid', message: `${shown} uses the reserved name "${segment}".` };
  }

  if (path.length > limits.pathLength) {
    return { code: 'zip_limit', message: `${shown} is ${path.length} characters long; the limit is ${limits.pathLength}.` };
  }
  return null;
}

/**
 * Normalizes a request path inside a package (review origin). Returns the path or null.
 * Stricter than the upload rules only in that it accepts nothing it would not store.
 */
export function normalizeServedPath(segments) {
  const parts = [];
  for (const raw of segments) {
    let segment;
    try {
      segment = decodeURIComponent(raw);
    } catch (_error) {
      return null;
    }
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(segment)) return null;
    parts.push(segment);
  }
  const path = parts.join('/');
  return path && !checkPackagePath(path) ? path : null;
}
