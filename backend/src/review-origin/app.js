import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import express from 'express';

import { buildOperationLogContext, logBackendError } from '../lib/logging/backend-logger.js';
import { contentTypeForPath, fileExtension, normalizeServedPath } from '../modules/requirements/packages/package-files.js';
import { DEVELOPMENT_GRANT_SECRET, verifyPackageGrant } from '../modules/requirements/packages/package-grants.js';
import { packageLayout, screenScopeAllows } from '../modules/requirements/packages/package-scope.js';
import { isMissingObjectError } from '../modules/requirements/packages/package-storage.js';

// The review origin. A separate Express app on its own port and host. It answers exactly
// two kinds of request:
//
//   GET /p/<packageId>/<grant>/<path>   a package file, if the grant is valid
//   GET /__odin/bridge.js               the bridge injected into package HTML
//
// Everything else is 404. It sets no cookies and never reads them. Every response carries
// the sandbox CSP, so even a direct visit to a package document runs with an opaque origin.
//
// Package HTML and SVG run only inside the app's frame, whose page CSP (`frame-src`, set by
// the app's host) keeps the frame from navigating itself to another host. A top-level visit
// has no such parent policy, so documents are served only to requests the browser marks
// (Fetch Metadata, Sec-Fetch-Dest) as a frame, an image, or a fetch. Anything else, including
// a request without the header, is refused. Prototypes therefore need a browser that sends
// Fetch Metadata: Chrome and Edge 80+, Firefox 90+, Safari 16.4+.
//
// The review origin cannot keep prototype scripts off the network entirely: no browser lets
// a CSP block WebRTC (Chromium ignores the proposed `webrtc` directive), so a script can
// still reach another host that way. That is an accepted limitation.

const BRIDGE_PLACEHOLDER = '/*__ODIN_BRIDGE_CONFIG__*/{ "allowedParentOrigins": [] }';
export const BRIDGE_PATH = '/__odin/bridge.js';
export const BRIDGE_TAG = `<script src="${BRIDGE_PATH}"></script>`;
const BRIDGE_SOURCE = readFileSync(new URL('./bridge.js', import.meta.url), 'utf8');

// Inline scripts, inline styles, and style attributes are allowed: the sandbox, the opaque
// origin, connect-src 'self', frame-ancestors, and form-action 'none' already bound what a
// prototype can reach, so inline code adds nothing. eval stays blocked.
//
// The sandbox gives the document an opaque origin, and in Safari 'self' then matches nothing, so
// the bridge and a package's own files would not load: prototypes stop at "Not responding". The
// review origin is named as well. It is what 'self' means in every other browser.
export function reviewOriginContentSecurityPolicy(frameAncestors, selfOrigin = '') {
  const self = selfOrigin ? `'self' ${selfOrigin}` : "'self'";
  return [
    'sandbox allow-scripts allow-forms',
    `default-src ${self} data: blob:`,
    `script-src ${self} 'unsafe-inline' data: blob:`,
    `style-src ${self} 'unsafe-inline' data: blob:`,
    `connect-src ${self}`,
    `frame-ancestors ${frameAncestors.join(' ')}`,
    "form-action 'none'",
  ].join('; ');
}

// The origin a request came to, for a server not told its public one. Only a plain host and port
// goes into a header.
function requestOrigin(request) {
  const host = String(request.headers.host ?? '');
  return /^[A-Za-z0-9.-]+(?::\d+)?$/.test(host) ? `${request.protocol}://${host}` : '';
}

export function renderBridgeScript({ allowedParentOrigins }) {
  if (!BRIDGE_SOURCE.includes(BRIDGE_PLACEHOLDER)) throw new Error('bridge.js is missing its configuration placeholder.');
  return BRIDGE_SOURCE.replace(BRIDGE_PLACEHOLDER, JSON.stringify({ allowedParentOrigins }));
}

/**
 * Inserts the bridge script at the end of <head>, or at the start of <body> when there is
 * no head. Works on bytes (latin1 offsets) so the document's own encoding is untouched.
 */
export function injectBridge(bytes) {
  const text = bytes.toString('latin1');
  let index = text.search(/<\/head\s*>/i);
  if (index === -1) {
    const body = /<body\b[^>]*>/i.exec(text);
    if (body) {
      index = body.index + body[0].length;
    } else {
      const html = /<html\b[^>]*>/i.exec(text);
      const doctype = /^(?:\xEF\xBB\xBF)?\s*<!doctype[^>]*>/i.exec(text);
      index = html ? html.index + html[0].length : doctype ? doctype[0].length : (text.startsWith('\xEF\xBB\xBF') ? 3 : 0);
    }
  }
  return Buffer.concat([bytes.subarray(0, index), Buffer.from(BRIDGE_TAG, 'latin1'), bytes.subarray(index)]);
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (_error) {
    return null;
  }
}

const ACTIVE_DOCUMENT_TYPES = new Set(['html', 'svg']);
const DOCUMENT_DESTINATIONS = new Set(['empty', 'frame', 'iframe', 'image']);

/**
 * deps:
 * - packagesRepository: getPackageById(packageId), getPackageFile({ packageId, path })
 * - storage: read(storageKey) -> { bytes }
 * - mayViewGrant({ grant, pkg }) -> boolean: whether the grant's viewer may still see the
 *   package (package-grant-access.js). Checked on every file, since grants outlive access.
 * - grantSecret: REVIEW_GRANT_SECRET
 * - frontendAppUrl: the app URL; its origin is the only allowed frame ancestor and parent
 * - clock: () => Date
 */
export function createReviewOriginApp({
  clock = () => new Date(),
  frontendAppUrl = 'http://localhost:5173/app',
  grantSecret = DEVELOPMENT_GRANT_SECRET,
  mayViewGrant,
  packagesRepository,
  // The review origin as browsers reach it. Without it, the origin each request came to.
  publicOrigin = '',
  storage,
}) {
  const appOrigin = originOf(frontendAppUrl);
  if (!appOrigin || appOrigin === 'null') throw new Error('The review origin needs FRONTEND_APP_URL to name the app origin.');
  if (typeof mayViewGrant !== 'function') throw new Error('The review origin needs mayViewGrant to recheck access.');
  const allowedParentOrigins = [appOrigin];
  const cspFor = (request) => reviewOriginContentSecurityPolicy(allowedParentOrigins, publicOrigin || requestOrigin(request));
  const bridge = Buffer.from(renderBridgeScript({ allowedParentOrigins }), 'utf8');
  const bridgeTag = createHash('sha256').update(bridge).digest('hex').slice(0, 16);

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('query parser', false);

  app.use((request, response, next) => {
    response.setHeader('Content-Security-Policy', cspFor(request));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    // The frame has an opaque origin, so every request it makes for its own images,
    // styles, and scripts is cross-origin. `same-site` would block those subresources.
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });

  function notFound(response) {
    response.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end('Not found');
  }

  function refuseOutsideFrame(response) {
    response.status(403).setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end('Open this prototype from OdinPMP.');
  }

  async function servePackageFile(request, response, parts) {
    const [packageId, grant, ...segments] = parts;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(packageId)) return notFound(response);
    const requested = segments.length > 0 && segments[segments.length - 1] === '' ? [...segments.slice(0, -1), 'index.html'] : segments;
    const path = normalizeServedPath(requested);
    const contentType = path ? contentTypeForPath(path) : null;
    // Checked before the grant, so this answer says nothing about whether the grant is valid.
    if (path && ACTIVE_DOCUMENT_TYPES.has(fileExtension(path)) && !DOCUMENT_DESTINATIONS.has(request.headers['sec-fetch-dest'])) return refuseOutsideFrame(response);
    const verified = verifyPackageGrant({ grant, now: clock(), packageId, secret: grantSecret });
    if (!verified) return notFound(response);
    if (!path || !contentType) return notFound(response);

    const pkg = await packagesRepository.getPackageById(packageId);
    if (!pkg || pkg.status === 'withdrawn') return notFound(response);
    // A grant loads only what its screen may load, so a prototype's scripts cannot reach
    // files its content hash does not cover.
    const screen = (pkg.screens ?? []).find((item) => item.screenId === verified.screenId);
    if (!screen || !screenScopeAllows(screen, path, packageLayout(pkg.screens))) return notFound(response);
    if (!await mayViewGrant({ grant: verified, pkg })) return notFound(response);
    const file = await packagesRepository.getPackageFile({ packageId, path });
    if (!file) return notFound(response);

    // Browsers revalidate on every use (no-cache), so a revoked grant stops working at once
    // instead of being served from cache; the ETag keeps an unchanged file to a 304. The
    // bridge fetches package files to inline them in snapshots, and from an opaque origin
    // that fetch is cross-origin and needs CORS. The grant in the URL is the capability, so
    // `*` (without credentials) exposes nothing the URL holder could not already load.
    const html = fileExtension(path) === 'html';
    const etag = file.sha256 ? `"${file.sha256}${html ? `-${bridgeTag}` : ''}"` : null;
    const setFileHeaders = () => {
      response.setHeader('Cache-Control', 'private, no-cache');
      response.setHeader('Access-Control-Allow-Origin', '*');
      if (etag) response.setHeader('ETag', etag);
    };
    if (etag && request.headers['if-none-match'] === etag) {
      setFileHeaders();
      response.status(304).end();
      return undefined;
    }

    let asset;
    try {
      asset = await storage.read(file.storageKey);
    } catch (error) {
      if (isMissingObjectError(error)) return notFound(response);
      throw error;
    }
    const body = html ? injectBridge(Buffer.from(asset.bytes)) : Buffer.from(asset.bytes);

    response.status(200);
    setFileHeaders();
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Length', String(body.length));
    response.end(request.method === 'HEAD' ? undefined : body);
    return undefined;
  }

  app.use(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return notFound(response);
      const rawPath = String(request.originalUrl ?? '').split('?')[0].split('#')[0];
      if (rawPath === BRIDGE_PATH) {
        response.status(200);
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.setHeader('Content-Length', String(bridge.length));
        response.setHeader('Cache-Control', 'no-cache');
        response.end(request.method === 'HEAD' ? undefined : bridge);
        return undefined;
      }
      const parts = rawPath.split('/');
      if (parts[0] !== '' || parts[1] !== 'p' || parts.length < 5) return notFound(response);
      return await servePackageFile(request, response, parts.slice(2));
    } catch (error) {
      logBackendError({
        context: buildOperationLogContext('review-origin.serve', { method: request.method, path: '/p/...' }),
        error,
        message: 'The review origin failed to serve a request.',
      });
      if (!response.headersSent) {
        response.status(500).setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end('Server error');
      }
      return undefined;
    }
  });

  return app;
}
