import { Parser } from 'htmlparser2';

import { fileExtension } from './package-files.js';

// Static scan for absolute URLs in prototype HTML, SVG, and CSS (package-spec.md section 5).
// The review origin's CSP blocks whatever this misses at runtime; the scan exists so an
// author learns at upload time that a CDN script or web font will not load. The same scan,
// keeping every reference instead of only external ones, tells the content hash which
// package files a prototype loads (section 6).

const NETWORK_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp']);

// Attributes whose values the browser fetches or navigates to.
const URL_ATTRIBUTES = new Set(['action', 'background', 'formaction', 'href', 'poster', 'src', 'xlink:href']);

/** True for an absolute network URL: http(s), ws(s), ftp, or protocol-relative. */
export function isExternalUrl(value) {
  // Browsers drop ASCII tab and newline anywhere in a URL and trim surrounding whitespace.
  const cleaned = String(value ?? '').replace(/[\t\n\r]/g, '').trim();
  if (/^[/\\]{2}/.test(cleaned)) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned)?.[1]?.toLowerCase();
  return Boolean(scheme && NETWORK_SCHEMES.has(scheme));
}

/**
 * Resolves a reference found in the package file `fromPath` to the package path the review
 * origin would serve for it, or null when it names no package file: a URL with a scheme
 * (including `data:`), a fragment or query alone, a root-relative or protocol-relative path,
 * or a path that climbs out of the package.
 */
export function resolvePackageReference(fromPath, value) {
  // Browsers drop tabs and newlines, trim spaces, and read "\" as "/" in http(s) URLs.
  const cleaned = String(value ?? '').replace(/[\t\n\r]/g, '').trim().replaceAll('\\', '/');
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned) || cleaned.startsWith('/')) return null;
  const relative = cleaned.split(/[?#]/)[0];
  if (!relative) return null;

  const segments = String(fromPath).split('/').slice(0, -1);
  const parts = relative.split('/');
  let directory = false;
  for (const [index, raw] of parts.entries()) {
    let segment;
    try {
      segment = decodeURIComponent(raw);
    } catch (_error) {
      return null;
    }
    // The review origin serves no empty segment and no encoded "/" (normalizeServedPath).
    if ((segment === '' && index < parts.length - 1) || segment.includes('/')) return null;
    directory = segment === '' || segment === '.' || segment === '..';
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else if (!directory) {
      segments.push(segment);
    }
  }
  // A directory URL is served as its index.html.
  if (directory) segments.push('index.html');
  return segments.join('/');
}

function lineIndex(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

function decodeCssEscapes(value) {
  return String(value)
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_match, hex) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/\\(.)/g, '$1');
}

function unquote(value) {
  const trimmed = String(value).trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Returns `[{ url, line, context }]` for absolute URLs in CSS text. `accept(url)` replaces
 * the absolute-URL test, for example to list every reference.
 */
export function scanCss(text, { accept = isExternalUrl, lineOffset = 0 } = {}) {
  // Blank comments out but keep their length and newlines, so offsets still map to lines.
  const source = String(text ?? '').replace(/\/\*[\s\S]*?(\*\/|$)/g, (comment) => comment.replace(/[^\n]/g, ' '));
  const lineOf = lineIndex(source);
  const findings = [];
  const report = (raw, offset, context) => {
    const url = decodeCssEscapes(unquote(raw));
    if (accept(url)) findings.push({ context, line: lineOf(offset) + lineOffset, url });
  };

  for (const match of source.matchAll(/url\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*)\s*\)/gi)) {
    // @namespace URLs are identifiers, never fetched.
    const before = source.slice(Math.max(0, source.lastIndexOf(';', match.index) + 1), match.index);
    if (/@namespace\b/i.test(before)) continue;
    report(match[1], match.index, 'url()');
  }
  for (const match of source.matchAll(/@import\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi)) {
    report(match[1], match.index, '@import');
  }
  for (const match of source.matchAll(/(?:-webkit-)?image-set\(([^)]*)\)/gi)) {
    for (const literal of match[1].matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g)) {
      report(literal[0], match.index, 'image-set()');
    }
  }
  return findings;
}

function srcsetUrls(value) {
  return String(value ?? '')
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * Returns `[{ url, line, context }]` for absolute URLs in HTML or SVG markup. `accept(url)`
 * replaces the absolute-URL test, as in scanCss.
 */
export function scanMarkup(text, { accept = isExternalUrl, xml = false } = {}) {
  const source = String(text ?? '');
  const lineOf = lineIndex(source);
  const findings = [];
  let styleBuffer = null;
  let styleStart = 0;
  let parser = null;

  const report = (url, context) => {
    if (accept(url)) findings.push({ context, line: lineOf(parser.startIndex), url });
  };

  parser = new Parser({
    onclosetag(name) {
      if (name.toLowerCase() === 'style' && styleBuffer !== null) {
        findings.push(...scanCss(styleBuffer, { accept, lineOffset: lineOf(styleStart) - 1 }));
        styleBuffer = null;
      }
    },
    onopentag(name, attributes) {
      const tag = name.toLowerCase();
      for (const [rawName, value] of Object.entries(attributes)) {
        const attribute = rawName.toLowerCase();
        if (URL_ATTRIBUTES.has(attribute)) report(value, `${tag} ${attribute}`);
        else if (attribute === 'srcset') srcsetUrls(value).forEach((url) => report(url, `${tag} srcset`));
        else if (attribute === 'data' && tag === 'object') report(value, 'object data');
        else if (attribute === 'style') {
          for (const finding of scanCss(value, { accept })) {
            findings.push({ ...finding, context: `${tag} style ${finding.context}`, line: lineOf(parser.startIndex) });
          }
        }
      }
      if (tag === 'meta' && String(attributes['http-equiv'] ?? '').toLowerCase() === 'refresh') {
        const target = /url\s*=\s*(.+)$/i.exec(String(attributes.content ?? ''))?.[1];
        if (target) report(unquote(target), 'meta refresh');
      }
      if (tag === 'style') {
        styleBuffer = '';
        styleStart = parser.endIndex + 1;
      }
    },
    ontext(data) {
      if (styleBuffer !== null) styleBuffer += data;
    },
  }, { decodeEntities: true, lowerCaseAttributeNames: !xml, recognizeSelfClosing: xml, xmlMode: xml });
  parser.write(source);
  parser.end();
  return findings;
}

/**
 * Scans one package file by its extension: HTML and SVG as markup, CSS as CSS. Other files,
 * JavaScript included, are not scanned and return `[]`. `accept` is as in scanCss.
 */
export function scanPackageFile(path, bytes, { accept = isExternalUrl } = {}) {
  const extension = fileExtension(path);
  if (extension !== 'html' && extension !== 'svg' && extension !== 'css') return [];
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes ?? '');
  return extension === 'css' ? scanCss(text, { accept }) : scanMarkup(text, { accept, xml: extension === 'svg' });
}
