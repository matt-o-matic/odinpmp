// Shared plumbing for the marketing screenshots: the Playwright entry point, demo sign-in,
// theme, the text rewrite that turns fixture names into the Harbor & Pine story, and the
// screenshot helper.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The frontend's own copy, by path, so this file and the e2e fixtures share one instance.
import { expect, test } from '../../../../frontend/node_modules/@playwright/test/index.mjs';

export { expect, test };

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCREENS_DIR = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SCREENS_DIR, '..', '..', '..');
// Full-size PNGs stay out of the site (output/ is git-ignored). run.mjs publishes WebPs from them.
export const OUTPUT_DIR = path.join(REPO_ROOT, 'output', 'marketing-screens');
const DEBUG_DIR = path.join(REPO_ROOT, 'output', 'playwright', 'marketing-screens', 'debug');
export const API_ORIGIN = 'http://localhost:3001';
export const THEMES = ['light', 'dark'];

// People and names in the shared fixtures, mapped onto the demo story. Full names go first so
// the bare first-name rules only catch what is left. Ids are lower-case and never match.
const NAME_RULES = [
  [/Synthetic Delivery Plan/g, 'Customer Portal Relaunch'],
  [/Synthetic Workspace/g, 'Harbor & Pine Outfitters'],
  [/Synthetic Demo/g, 'Priya Natarajan'],
  [/Synthetic browser acceptance fixture\.?/g, 'Relaunch of the Harbor & Pine customer portal: accounts, orders, returns and service bookings.'],
  [/demo@example\.com/g, 'priya.natarajan@example.com'],
  [/jamie\.ortiz@client\.example/g, 'ava.lindqvist@example.com'],
  [/([a-z]+\.[a-z]+)@client\.example/g, '$1@example.com'],
  [/alex\.kim@example\.com/g, 'lee.park@example.com'],
  [/morgan\.lee@example\.com/g, 'marcus.chen@example.com'],
  [/olive@example\.com/g, 'marcus.chen@example.com'],
  [/Jamie Ortiz/g, 'Ava Lindqvist'],
  [/Morgan Lee/g, 'Marcus Chen'],
  [/Alex Kim/g, 'Lee Park'],
  [/Dana Cho/g, 'Dana Reyes'],
  [/Olive Admin/g, 'Marcus Chen'],
  [/Ada Lovelace/g, 'Lee Park'],
  [/Alan Turing/g, 'Sam Ortiz'],
  [/Sam Patel/g, 'Marcus Chen'],
  [/Casey Member/g, 'Casey Nguyen'],
  [/Drew Member/g, 'Drew Callahan'],
  [/Evan Member/g, 'Evan Brooks'],
  [/Alex Engineer/g, 'Lee Park'],
  [/Target User/g, 'Casey Nguyen'],
  [/\bJamie\b/g, 'Ava'],
  [/\bMorgan\b/g, 'Marcus'],
  [/\bAlex\b/g, 'Lee'],
  [/\bOlive\b/g, 'Marcus'],
  [/\bAna Ruiz\b/g, 'Jordan Ellis'],
];

// The requirements fixtures describe a home-services booking product. These rules move that
// story into the Harbor & Pine portal: customers booking a bike or ski service at a shop.
const STORY_RULES = [
  [/Fieldwork/g, 'Harbor & Pine'],
  [/Client booking/g, 'Service booking'],
  [/Client services/g, 'Customer care'],
  [/\bhome visit\b/g, 'service appointment'],
  [/\bBook a visit\b/g, 'Book a service'],
  [/\bbook a visit\b/g, 'book a service'],
  [/\bstandard visit\b/g, 'standard tune-up'],
  [/\bpick a visit\b/g, 'pick a service'],
  [/\bvisit history\b/g, 'service history'],
  [/(?<![-\w])visits(?![-\w])/g, 'appointments'],
  [/(?<![-\w])visit(?![-\w])/g, 'appointment'],
  [/(?<![-\w.@])Clients(?![-\w.@])/g, 'Customers'],
  [/(?<![-\w.@])clients(?![-\w.@])/g, 'customers'],
  [/(?<![-\w.@])Client(?![-\w.@])/g, 'Customer'],
  [/(?<![-\w.@])client(?![-\w.@])/g, 'customer'],
  [/\bjob type\b/g, 'service type'],
  [/FaultLine Ingestion/g, 'Store Inventory Sync'],
  [/Retired Pilot/g, 'Gift Card Platform Retirement'],
  [/the retired pilot/g, 'the retired gift card platform'],
  [/Synthetic/g, 'Harbor & Pine'],
];

export function rewriteNames(text) {
  return NAME_RULES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

export function rewriteStory(text) {
  return STORY_RULES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), rewriteNames(text));
}

function rewriteBody(body) {
  if (typeof body === 'string') return rewriteStory(body);
  return body;
}

function bindAll(target, prop) {
  const value = Reflect.get(target, prop, target);
  return typeof value === 'function' ? value.bind(target) : value;
}

function rewritingRoute(route) {
  return new Proxy(route, {
    get(target, prop) {
      if (prop === 'fulfill') {
        return (options = {}) => target.fulfill(options.body === undefined ? options : { ...options, body: rewriteBody(options.body) });
      }
      return bindAll(target, prop);
    },
  });
}

/**
 * A view of `page` whose route handlers rewrite every string response body with the story
 * rules. Hand it to the shared fixtures so their payloads come out as Harbor & Pine data
 * without copying or editing them. Use the real page for everything else.
 */
export function storyPage(page) {
  return new Proxy(page, {
    get(target, prop) {
      if (prop === 'route') {
        return (url, handler, options) => target.route(url, (route, request) => handler(rewritingRoute(route), request), options);
      }
      return bindAll(target, prop);
    },
  });
}

// --- Network ------------------------------------------------------------------------------

// The app's index.html loads its fonts from Google Fonts. The captures must not reach any
// server but the local dev server, so those URLs are answered from local files: Space Grotesk
// from the marketing site's @fontsource package, and Archivo Black and JetBrains Mono from
// fonts installed on this machine (local()). Anything else off this machine is aborted.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', 'review.odin.test']);
const FONT_HOST = 'https://fonts.gstatic.com/odin-local';
// Where each font file may be found, first match wins. Drop copies into
// marketing/scripts/screens/fonts/ on a machine without them installed.
const SYSTEM_FONT_DIRS = [
  path.join(SCREENS_DIR, 'fonts'),
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts') : null,
  process.env.WINDIR ? path.join(process.env.WINDIR, 'Fonts') : null,
  path.join(os.homedir(), 'Library', 'Fonts'),
  '/Library/Fonts',
  path.join(os.homedir(), '.local', 'share', 'fonts'),
  '/usr/share/fonts/truetype',
].filter(Boolean);
const FONT_FILES = {
  'ArchivoBlack-Regular.ttf': SYSTEM_FONT_DIRS,
  'JetBrainsMono-Bold.ttf': SYSTEM_FONT_DIRS,
  'JetBrainsMono-Regular.ttf': SYSTEM_FONT_DIRS,
  'space-grotesk-latin-ext-wght-normal.woff2': [path.join(REPO_ROOT, 'marketing', 'node_modules', '@fontsource-variable', 'space-grotesk', 'files')],
  'space-grotesk-latin-wght-normal.woff2': [path.join(REPO_ROOT, 'marketing', 'node_modules', '@fontsource-variable', 'space-grotesk', 'files')],
};
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const LOCAL_FONT_CSS = `
@font-face { font-family: 'Space Grotesk'; font-style: normal; font-weight: 300 700; font-display: block; src: url(${FONT_HOST}/space-grotesk-latin-ext-wght-normal.woff2) format('woff2'); unicode-range: ${LATIN_EXT}; }
@font-face { font-family: 'Space Grotesk'; font-style: normal; font-weight: 300 700; font-display: block; src: url(${FONT_HOST}/space-grotesk-latin-wght-normal.woff2) format('woff2'); unicode-range: ${LATIN}; }
@font-face { font-family: 'Archivo Black'; font-style: normal; font-weight: 400; font-display: block; src: url(${FONT_HOST}/ArchivoBlack-Regular.ttf) format('truetype'); }
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 400; font-display: block; src: url(${FONT_HOST}/JetBrainsMono-Regular.ttf) format('truetype'); }
@font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 700; font-display: block; src: url(${FONT_HOST}/JetBrainsMono-Bold.ttf) format('truetype'); }
`;

const fontCache = new Map();
function readFont(name) {
  if (!fontCache.has(name)) {
    const found = (FONT_FILES[name] ?? []).map((dir) => path.join(dir, name)).find((file) => existsSync(file));
    if (!found) console.warn(`[screens] ${name} not found; the app falls back to another font. Looked in: ${(FONT_FILES[name] ?? []).join(', ')}`);
    fontCache.set(name, found ? readFileSync(found) : null);
  }
  return fontCache.get(name);
}

/** Keeps the page on this machine: local fonts for Google Fonts, everything else aborted. */
export async function guardNetwork(page) {
  // Registered first, so every later route (fixtures, fonts) takes precedence.
  await page.route((url) => !LOCAL_HOSTS.has(url.hostname), (route) => {
    if (process.env.ODIN_SCREENS_DEBUG) console.log(`[screens] blocked ${route.request().url()}`);
    return route.abort('blockedbyclient');
  });
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({
    body: LOCAL_FONT_CSS, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/css; charset=utf-8' }, status: 200,
  }));
  await page.route(`${FONT_HOST}/**`, (route) => {
    const name = path.basename(new URL(route.request().url()).pathname);
    const body = readFont(name);
    if (!body) return route.fulfill({ body: '', status: 404 });
    return route.fulfill({ body, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': name.endsWith('.ttf') ? 'font/ttf' : 'font/woff2' }, status: 200 });
  });
}

export function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

export const DEMO_USER = {
  email: 'priya.natarajan@example.com',
  id: 'user-synthetic',
  name: 'Priya Natarajan',
  role: 'member',
  scopes: [],
  tenantId: 'tenant-synthetic',
  tenantName: 'Harbor & Pine Outfitters',
};

function demoToken(user) {
  const claims = { email: user.email, exp: 4_102_444_800, name: user.name, role: user.role, sub: user.id, tenantId: user.tenantId };
  return `demo.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

/**
 * Signs the demo user in without the login form: the app restores its session from
 * /api/auth/refresh. Register after installSyntheticApi so these routes win. The user's
 * server-side dark-mode preference and localStorage both carry the theme.
 */
export async function signInDemoUser(page, { admin = false, capabilities = [], theme = 'light' } = {}) {
  const dark = theme === 'dark';
  const user = {
    ...DEMO_USER,
    capabilities: [...capabilities],
    preferences: { darkMode: dark, twoFactorEnabled: true },
    ...(admin ? { role: 'admin' } : {}),
  };
  const token = demoToken(user);
  await page.addInitScript((value) => {
    try {
      window.localStorage.setItem('odinpmp.theme.dark', String(value));
    } catch {
      // Storage can be unavailable on opaque origins; the server preference still applies.
    }
  }, dark);
  await page.route(`${API_ORIGIN}/api/auth/**`, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/auth/refresh' || pathname === '/api/auth/login') return json(route, { session: { refreshToken: '', token, user } });
    if (pathname === '/api/auth/me') return json(route, { user });
    return route.fallback();
  });
  return user;
}

/** Theme for pages that are not signed in (the stakeholder portal). */
export async function applyStoredTheme(page, theme) {
  await page.addInitScript((value) => {
    try {
      window.localStorage.setItem('odinpmp.theme.dark', String(value));
    } catch {
      // Ignore.
    }
  }, theme === 'dark');
}

// The dark navbar is 97% opaque, so text scrolled under it shows through faintly. At rest the
// difference is invisible; in a scrolled shot it reads as a smudge, so it is made solid.
const NO_MOTION = `
  *, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }
  html.dark .navbar-light, html.dark .bg-light { background-color: rgb(18, 22, 36) !important; }
`;

async function rewriteVisibleNames(page) {
  await page.evaluate((rules) => {
    const compiled = rules.map(([source, flags, replacement]) => [new RegExp(source, flags), replacement]);
    const apply = (text) => compiled.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const next = apply(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    }
    for (const element of document.querySelectorAll('input, textarea')) {
      const next = apply(element.value);
      if (next !== element.value) element.value = next;
    }
  }, NAME_RULES.map(([pattern, replacement]) => [pattern.source, pattern.flags, replacement]));
}

async function settle(page) {
  await page.addStyleTag({ content: NO_MOTION });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  // Blur whatever has focus so no focus ring or caret lands in the shot.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
}

/** Problems that would make a marketing screenshot look broken. */
async function visibleProblems(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        && box.bottom > 0 && box.top < window.innerHeight;
    };
    const problems = [];
    const text = document.body.innerText;
    if (/synthetic/i.test(text)) problems.push(`visible text mentions "synthetic": ${text.match(/.{0,40}synthetic.{0,40}/i)?.[0]}`);
    if (/Unexpected synthetic API request|Request failed|Something went wrong/i.test(text)) problems.push('an API error message is visible');
    if ([...document.querySelectorAll('.spinner-border, .spinner-grow')].some(visible)) problems.push('a spinner is visible');
    for (const element of document.querySelectorAll('.alert-danger, .toast, [role="alert"]')) {
      if (visible(element) && element.innerText.trim()) problems.push(`alert or toast is visible: ${element.innerText.trim().slice(0, 80)}`);
    }
    return problems;
  });
}

/**
 * Settles the page and writes output/marketing-screens/<name>-<theme>.png from the
 * 1440x900 viewport at 2x.
 */
export async function capture(page, name, theme, { allowSpinner = false } = {}) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  await rewriteVisibleNames(page);
  await settle(page);
  const problems = (await visibleProblems(page)).filter((problem) => !(allowSpinner && problem.includes('spinner')));
  expect(problems, `${name}-${theme}`).toEqual([]);
  const appFontLoaded = await page.evaluate(() => [...document.fonts].some((face) => face.family.replace(/["']/g, '') === 'Space Grotesk' && face.status === 'loaded'));
  expect(appFontLoaded, 'Space Grotesk should load from marketing/node_modules/@fontsource-variable/space-grotesk').toBe(true);
  await page.screenshot({ animations: 'disabled', caret: 'hide', path: path.join(OUTPUT_DIR, `${name}-${theme}.png`), scale: 'device' });
  // ODIN_SCREENS_DEBUG=1 also writes a full-page, 1x copy for checking what lies below the fold.
  if (process.env.ODIN_SCREENS_DEBUG) {
    mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ animations: 'disabled', caret: 'hide', fullPage: true, path: path.join(DEBUG_DIR, `${name}-${theme}-full.png`), scale: 'css' });
  }
}

export function readScreensFile(...parts) {
  return readFileSync(path.join(SCREENS_DIR, ...parts), 'utf8');
}
