// The parent side of the review bridge (package-spec.md section 5). A prototype runs in a
// sandboxed frame on the review origin; its bridge script posts state, snapshots, and
// element hints to the app. The frame has an opaque origin, so `event.origin` is the
// string 'null'. A message counts only when it comes from our frame's window and names
// the bridge as its source, and even then every field is untrusted: prototype code runs in
// the same frame and can post the same messages. Nothing here ever renders HTML from it.

export const BRIDGE_SOURCE = 'odin-review-bridge';
export const BRIDGE_VERSION = 1;
export const FRAME_SANDBOX = 'allow-scripts allow-forms';

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_ID = 64;
const MAX_KEY = 600;
const MAX_PATH = 400;
const MAX_HASH = 300;
const MAX_REASON = 300;
const MAX_REQUEST_ID = 80;
const MAX_TAG = 40;
const MAX_TEXT = 80;
const MAX_DIMENSION = 100_000;
// A 3840 x 3840 PNG at scale 2 could approach this; anything bigger is not a snapshot.
export const MAX_SNAPSHOT_DATA_URL = 48 * 1024 * 1024;
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

const INBOUND_TYPES = new Set(['ready', 'state', 'scroll', 'viewport', 'capture', 'capture-failed', 'hint']);

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, max) {
  if (typeof value !== 'string') return null;
  return value.length > max ? null : value;
}

function boundedText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function finite(value, { max = MAX_DIMENSION, min = -MAX_DIMENSION } = {}) {
  const number = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number;
}

function requestId(value) {
  if (value === undefined) return null;
  return text(value, MAX_REQUEST_ID);
}

export function isStateKey(value) {
  return typeof value === 'string' && value.length <= MAX_ID && ID_PATTERN.test(value);
}

function parseState(source) {
  if (!isPlainObject(source)) return null;
  const key = text(source.key, MAX_KEY);
  const path = text(source.path ?? '', MAX_PATH);
  const hash = text(source.hash ?? '', MAX_HASH);
  if (!key || path === null || hash === null) return null;
  return { declared: source.declared === true, hash, key, path };
}

function parseViewport(source) {
  if (!isPlainObject(source)) return null;
  const width = finite(source.width, { min: 0 });
  const height = finite(source.height, { min: 0 });
  const devicePixelRatio = finite(source.devicePixelRatio ?? 1, { max: 16, min: 0 });
  if (width === null || height === null || devicePixelRatio === null) return null;
  return { devicePixelRatio, height, width };
}

function parseScroll(source) {
  if (!isPlainObject(source)) return null;
  const values = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = finite(source[key] ?? 0);
    if (value === null) return null;
    values[key] = value;
  }
  return values;
}

function parseBox(source) {
  if (!isPlainObject(source)) return null;
  const box = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = finite(source[key]);
    if (value === null) return null;
    box[key] = value;
  }
  if (box.width < 0 || box.height < 0) return null;
  return box;
}

function parseHint(source) {
  if (source === null) return null;
  if (!isPlainObject(source)) return undefined;
  const box = parseBox(source.box);
  if (!box) return undefined;
  const odinId = source.odinId == null ? null : boundedText(source.odinId, MAX_ID);
  const tag = boundedText(source.tag, MAX_TAG).toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return undefined;
  return { box, odinId: odinId || null, tag, text: boundedText(source.text, MAX_TEXT) };
}

/**
 * Validates one message event against the frame that should have sent it. Returns a
 * normalized message, or null for anything that is not a well-formed bridge message from
 * that frame. Shapes are rebuilt field by field, so nothing extra passes through.
 */
export function parseBridgeMessage(event, frameWindow) {
  if (!event || !frameWindow || event.source !== frameWindow) return null;
  if (event.origin !== 'null') return null;
  const data = event.data;
  if (!isPlainObject(data)) return null;
  if (data.source !== BRIDGE_SOURCE || data.version !== BRIDGE_VERSION) return null;
  if (typeof data.type !== 'string' || !INBOUND_TYPES.has(data.type)) return null;

  switch (data.type) {
    case 'ready': {
      const state = parseState(data.state);
      const viewport = parseViewport(data.viewport);
      const scroll = parseScroll(data.scroll ?? {});
      if (!state || !viewport || !scroll) return null;
      return { scroll, state, type: 'ready', viewport };
    }
    case 'state': {
      const state = parseState(data);
      return state ? { state, type: 'state' } : null;
    }
    case 'scroll': {
      const scroll = parseScroll(data.scroll);
      return scroll ? { scroll, type: 'scroll' } : null;
    }
    case 'viewport': {
      const viewport = parseViewport(data.viewport);
      const scroll = parseScroll(data.scroll ?? {});
      return viewport && scroll ? { scroll, type: 'viewport', viewport } : null;
    }
    case 'capture': {
      const id = requestId(data.requestId);
      const dataUrl = typeof data.dataUrl === 'string' && data.dataUrl.length <= MAX_SNAPSHOT_DATA_URL && PNG_DATA_URL.test(data.dataUrl) ? data.dataUrl : null;
      const width = finite(data.width, { min: 1 });
      const height = finite(data.height, { min: 1 });
      const stateKey = text(data.stateKey ?? '', MAX_KEY);
      const scroll = parseScroll(data.scroll ?? {});
      if (id === null || !dataUrl || width === null || height === null || stateKey === null || !scroll) return null;
      return { dataUrl, height, requestId: id, scroll, stateKey, type: 'capture', width };
    }
    case 'capture-failed': {
      const id = requestId(data.requestId);
      if (id === null) return null;
      return { reason: boundedText(data.reason, MAX_REASON) || 'The snapshot failed.', requestId: id, type: 'capture-failed' };
    }
    case 'hint': {
      const id = requestId(data.requestId);
      const hint = parseHint(data.hint);
      const x = finite(data.x);
      const y = finite(data.y);
      if (id === null || hint === undefined || x === null || y === null) return null;
      return { hint, requestId: id, type: 'hint', x, y };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Commands to the bridge
// ---------------------------------------------------------------------------

export function captureCommand({ requestId: id, scale = 1 } = {}) {
  const value = Math.min(2, Math.max(0.25, Number(scale) || 1));
  return { requestId: String(id), scale: value, type: 'capture' };
}

export function hintCommand({ requestId: id, x, y }) {
  return { requestId: String(id), type: 'hint', x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) };
}

/** Returns null for a key the bridge would ignore. */
export function gotoStateCommand(key) {
  return isStateKey(key) ? { key, type: 'goto-state' } : null;
}

export function pingCommand() {
  return { type: 'ping' };
}

// ---------------------------------------------------------------------------
// Frame address and layout
// ---------------------------------------------------------------------------

/**
 * The frame's address: the screen's entry URL plus `?odin-parent=<app origin>`. Only http:
 * and https: entry URLs are used; anything else returns ''. The hash belongs to the
 * prototype, so the parent origin goes in the query string.
 */
export function frameSrc(entryUrl, appOrigin) {
  let url;
  try {
    url = new URL(String(entryUrl ?? ''));
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (appOrigin) url.searchParams.set('odin-parent', String(appOrigin));
  return url.href;
}

/** Scale that fits a viewport into the available width, never above 1. */
export function fitScale(viewportWidth, availableWidth) {
  const width = Number(viewportWidth);
  const available = Number(availableWidth);
  if (!(width > 0) || !(available > 0)) return 1;
  return Math.min(1, available / width);
}

/** Which declared state a reported state matches, or ''. */
export function matchDeclaredState(state, states = []) {
  if (!state) return '';
  const keys = (Array.isArray(states) ? states : []).map((entry) => entry?.key).filter(isStateKey);
  if (keys.includes(state.key)) return state.key;
  const fromHash = typeof state.hash === 'string' && state.hash.startsWith('#') ? state.hash.slice(1) : '';
  return keys.includes(fromHash) ? fromHash : '';
}

// ---------------------------------------------------------------------------
// Request tracking
// ---------------------------------------------------------------------------

let requestCounter = 0;

export function nextRequestId(prefix = 'odin') {
  requestCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${requestCounter.toString(36)}-${random}`;
}

/**
 * Pending capture and hint requests. `start` returns a promise that settles with the
 * matching reply, or with `onTimeout()` after `timeoutMs`; it never rejects. `settle`
 * returns true when a reply matched a pending request.
 */
export function createRequestTracker({ timers = { clear: (id) => clearTimeout(id), set: (callback, delay) => setTimeout(callback, delay) } } = {}) {
  const pending = new Map();
  return {
    cancelAll(value) {
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        timers.clear(entry.timer);
        entry.resolve(typeof value === 'function' ? value(entry.kind) : value);
      }
    },
    get size() {
      return pending.size;
    },
    settle(id, value) {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      timers.clear(entry.timer);
      entry.resolve(value);
      return true;
    },
    start(id, { kind = '', onTimeout = () => null, timeoutMs }) {
      return new Promise((resolve) => {
        const timer = timers.set(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          resolve(onTimeout());
        }, timeoutMs);
        pending.set(id, { kind, resolve, timer });
      });
    },
  };
}
