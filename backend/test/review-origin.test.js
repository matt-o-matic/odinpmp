import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import request from 'supertest';

import { createPackageGrant } from '../src/modules/requirements/packages/package-grants.js';
import { createInMemoryObjectStorage } from '../src/modules/requirements/packages/package-storage.js';
import { createInMemoryPackagesRepository } from '../src/modules/requirements/packages/packages.repository.js';
import { ingestPackage } from '../src/modules/requirements/packages/packages.service.js';
import { BRIDGE_TAG, createReviewOriginApp, injectBridge, renderBridgeScript, reviewOriginContentSecurityPolicy } from '../src/review-origin/app.js';
import { buildZip, makePng, manifestWith, imageScreen, prototypeScreen, PROTOTYPE_HTML } from './helpers/review-packages.js';

const SECRET = 'review-origin-test-secret-0123456789abcd';
const APP_URL = 'https://app.example.test/app';
const REVIEW_ORIGIN = 'https://review.example';
const EXPECTED_CSP = "sandbox allow-scripts allow-forms; default-src 'self' https://review.example data: blob:; script-src 'self' https://review.example 'unsafe-inline' data: blob:; style-src 'self' https://review.example 'unsafe-inline' data: blob:; connect-src 'self' https://review.example; frame-ancestors https://app.example.test; form-action 'none'";

async function setup() {
  const packagesRepository = createInMemoryPackagesRepository();
  const storage = createInMemoryObjectStorage();
  const deps = { mermaidValidator: null, packageStorage: storage, packagesRepository, requirementsRepository: null };
  const manifest = manifestWith({ sections: [
    { id: 'screens', items: [imageScreen('home'), prototypeScreen('booking'), imageScreen('logo', { src: 'assets/logo.svg' })], type: 'screens' },
  ] });
  const files = {
    'assets/font.woff2': Buffer.from('wOF2fake'),
    'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200"/></svg>',
    'manifest.json': JSON.stringify(manifest),
    'prototypes/booking/app.js': 'window.OdinReview && window.OdinReview.setState("start");',
    'prototypes/booking/data.json': '{"slots":[]}',
    'prototypes/booking/index.html': PROTOTYPE_HTML,
    'prototypes/booking/no-head.html': '<!doctype html><body class="x"><p>Body only</p></body>',
    'prototypes/booking/notes.md': '# Notes',
    'prototypes/booking/styles.css': 'body { color: #1d2a24; }',
    'screens/home.png': makePng(320, 200),
  };
  const outcome = await ingestPackage(deps, {
    bytes: await buildZip(files),
    projectId: 'project-1',
    source: 'ui',
    tenantId: 'tenant-1',
    track: 'experience',
    uploadedBy: 'user:u-1',
  });
  assert.equal(outcome.status, 'accepted', JSON.stringify(outcome.errors));
  const other = await ingestPackage(deps, {
    bytes: await buildZip({ 'manifest.json': JSON.stringify(manifestWith()), 'screens/home.png': makePng(320, 200) }),
    projectId: 'project-1',
    source: 'ui',
    tenantId: 'tenant-1',
    track: 'experience',
    uploadedBy: 'user:u-1',
  });
  const clock = { now: new Date() };
  // Stands in for package-grant-access.js, which has its own tests.
  const access = { allowed: true, checks: [] };
  const mayViewGrant = async ({ grant, pkg: viewed }) => {
    access.checks.push({ packageId: viewed.id, viewerRef: grant.viewerRef });
    return access.allowed;
  };
  const app = createReviewOriginApp({ clock: () => clock.now, frontendAppUrl: APP_URL, publicOrigin: REVIEW_ORIGIN, grantSecret: SECRET, mayViewGrant, packagesRepository, storage });
  const pkg = outcome.package;
  const grantFor = (packageId = pkg.id, expiresAt = new Date(Date.now() + 60 * 60 * 1000), screenId = 'booking') => createPackageGrant({ expiresAt, packageId, screenId, secret: SECRET, viewerRef: 'user:u-1' });
  // Each path with a grant for a screen that may load it: the image screens' own files, and
  // the prototype for everything else.
  const screenFor = (path) => ({ 'assets/logo.svg': 'logo', 'screens/home.png': 'home' })[path] ?? 'booking';
  const url = (path, grant = grantFor(pkg.id, undefined, screenFor(path))) => `/p/${pkg.id}/${grant}/${path}`;
  return { access, app, clock, files, grantFor, other: other.package, packagesRepository, pkg, storage, url };
}

// Sends a path exactly as given. supertest and browsers resolve dot segments before sending.
function rawGet(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const req = http.request({ host: '127.0.0.1', method: 'GET', path, port: server.address().port }, (res) => {
        res.resume();
        res.on('end', () => {
          server.close();
          resolve({ headers: res.headers, status: res.statusCode });
        });
      });
      req.on('error', (error) => {
        server.close();
        reject(error);
      });
      req.end();
    });
  });
}

function assertReviewHeaders(response) {
  assert.equal(response.headers['content-security-policy'], EXPECTED_CSP);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['x-powered-by'], undefined);
}

test('without a configured origin, the policy names the one each request came to, and only a plain host', async () => {
  const app = createReviewOriginApp({ frontendAppUrl: APP_URL, grantSecret: SECRET, mayViewGrant: async () => true, packagesRepository: {}, storage: {} });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${origin}/nothing-here`);
    assert.ok(response.headers.get('content-security-policy').includes(`script-src 'self' ${origin} `));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a sandboxed document names the review origin, as Safari matches nothing against self there', () => {
  const policy = reviewOriginContentSecurityPolicy(['https://app.example'], 'https://review.example');
  for (const directive of ['default-src', 'script-src', 'style-src', 'connect-src']) {
    assert.ok(policy.includes(`${directive} 'self' https://review.example`), directive);
  }
  assert.ok(policy.startsWith('sandbox allow-scripts allow-forms; '), 'the sandbox stays');
  assert.equal(reviewOriginContentSecurityPolicy(['https://app.example']).includes('undefined'), false);
});

test('package files are served with exact headers, extension content types, and CORS for snapshots', async () => {
  const { app, url } = await setup();
  const expected = {
    'assets/font.woff2': 'font/woff2',
    'assets/logo.svg': 'image/svg+xml',
    'prototypes/booking/app.js': 'text/javascript; charset=utf-8',
    'prototypes/booking/data.json': 'application/json; charset=utf-8',
    'prototypes/booking/index.html': 'text/html; charset=utf-8',
    'prototypes/booking/notes.md': 'text/plain; charset=utf-8',
    'prototypes/booking/styles.css': 'text/css; charset=utf-8',
    'screens/home.png': 'image/png',
  };
  for (const [path, contentType] of Object.entries(expected)) {
    const response = await request(app).get(url(path)).set('Cookie', 'odin_session=secret').set('Sec-Fetch-Dest', 'iframe');
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-type'], contentType, path);
    assert.equal(response.headers['access-control-allow-origin'], '*', path);
    assert.equal(response.headers['cache-control'], 'private, no-cache', path);
    assert.match(response.headers.etag, /^"[0-9a-f]{64}(-[0-9a-f]{16})?"$/, path);
    assertReviewHeaders(response);
  }
  const png = await request(app).get(url('screens/home.png')).buffer(true).parse((res, done) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });
  assert.ok(png.body.equals(makePng(320, 200)), 'bytes are served unchanged');

  const head = await request(app).head(url('prototypes/booking/styles.css'));
  assert.equal(head.status, 200);
  assertReviewHeaders(head);
});

test('a grant loads only what its screen may: a prototype its own directory and shared files, an image screen its file', async () => {
  const { app, grantFor, pkg } = await setup();
  const as = (screenId) => (path) => request(app).get(`/p/${pkg.id}/${grantFor(pkg.id, undefined, screenId)}/${path}`).set('Sec-Fetch-Dest', 'iframe');
  const booking = as('booking');
  for (const path of ['prototypes/booking/index.html', 'prototypes/booking/app.js', 'assets/font.woff2']) assert.equal((await booking(path)).status, 200, `booking loads ${path}`);
  for (const path of ['screens/home.png', 'assets/logo.svg', 'manifest.json']) {
    const response = await booking(path);
    assert.equal(response.status, 404, `booking cannot load ${path}`);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const home = as('home');
  assert.equal((await home('screens/home.png')).status, 200);
  for (const path of ['prototypes/booking/index.html', 'assets/font.woff2', 'assets/logo.svg']) assert.equal((await home(path)).status, 404, `home cannot load ${path}`);
  assert.equal((await as('logo')('assets/logo.svg')).status, 200);
  assert.equal((await as('no-such-screen')('prototypes/booking/index.html')).status, 404);
});

test('every HTML document gets the bridge: end of <head>, or start of <body> when there is no head', async () => {
  const { app, url } = await setup();
  const html = await request(app).get(url('prototypes/booking/index.html')).set('Sec-Fetch-Dest', 'iframe');
  assert.equal(html.status, 200);
  assert.ok(html.text.includes(`<link rel="stylesheet" href="styles.css">${BRIDGE_TAG}</head>`), html.text);
  assert.equal(html.text.split(BRIDGE_TAG).length, 2, 'injected once');

  const noHead = await request(app).get(url('prototypes/booking/no-head.html')).set('Sec-Fetch-Dest', 'iframe');
  assert.ok(noHead.text.includes(`<body class="x">${BRIDGE_TAG}<p>Body only</p>`), noHead.text);

  // Trailing slash serves the directory's index.html.
  const directory = await request(app).get(url('prototypes/booking/')).set('Sec-Fetch-Dest', 'iframe');
  assert.equal(directory.status, 200);
  assert.ok(directory.text.includes(BRIDGE_TAG));

  assert.equal(injectBridge(Buffer.from('<!DOCTYPE html><p>x</p>')).toString(), `<!DOCTYPE html>${BRIDGE_TAG}<p>x</p>`);
  assert.equal(injectBridge(Buffer.from('<html lang="en"><p>x</p></html>')).toString(), `<html lang="en">${BRIDGE_TAG}<p>x</p></html>`);
  assert.equal(injectBridge(Buffer.from('<p>fragment</p>')).toString(), `${BRIDGE_TAG}<p>fragment</p>`);
  assert.equal(injectBridge(Buffer.from('<HEAD><TITLE>t</TITLE></HEAD >')).toString(), `<HEAD><TITLE>t</TITLE>${BRIDGE_TAG}</HEAD >`);
  const latin1 = Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]);
  assert.ok(injectBridge(latin1).subarray(BRIDGE_TAG.length).equals(latin1), 'non-UTF-8 bytes are untouched');
});

test('the bridge script is served with the same headers and names only the app origin as parent', async () => {
  const { app } = await setup();
  const response = await request(app).get('/__odin/bridge.js');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-cache');
  assertReviewHeaders(response);
  assert.ok(response.text.includes('})({"allowedParentOrigins":["https://app.example.test"]});'));
  assert.equal(response.text.includes('__ODIN_BRIDGE_CONFIG__'), false);
  assert.throws(() => createReviewOriginApp({ frontendAppUrl: 'not a url', packagesRepository: null, storage: null }), /FRONTEND_APP_URL/);
  assert.throws(() => createReviewOriginApp({ frontendAppUrl: APP_URL, packagesRepository: null, storage: null }), /mayViewGrant/);
  assert.ok(renderBridgeScript({ allowedParentOrigins: ['http://a.test'] }).includes('"http://a.test"'));
});

test('missing, tampered, expired, and other-package grants get 404 with the same headers', async () => {
  const { app, clock, grantFor, other, pkg, url } = await setup();
  const valid = grantFor();
  const [payload, signature] = valid.split('.');
  const cases = {
    expired: url('screens/home.png', grantFor(pkg.id, new Date(Date.now() - 1000))),
    garbage: url('screens/home.png', 'not-a-grant'),
    missingGrant: `/p/${pkg.id}/screens/home.png`,
    otherPackageGrant: url('screens/home.png', grantFor(other.id)),
    tamperedPayload: url('screens/home.png', `${Buffer.from(JSON.stringify({ e: 4102444800, p: pkg.id, v: 'user:evil' })).toString('base64url')}.${signature}`),
    tamperedSignature: url('screens/home.png', `${payload}.${signature.slice(1)}A`),
    wrongPackageInPath: `/p/${other.id}/${valid}/screens/home.png`,
  };
  for (const [label, path] of Object.entries(cases)) {
    const response = await request(app).get(path);
    assert.equal(response.status, 404, label);
    assertReviewHeaders(response);
    assert.equal(response.headers['access-control-allow-origin'], undefined, label);
  }

  // A grant that was valid stops working when it expires.
  const ok = url('screens/home.png');
  assert.equal((await request(app).get(ok)).status, 200);
  clock.now = new Date(Date.now() + 2 * 60 * 60 * 1000);
  assert.equal((await request(app).get(ok)).status, 404);
});

test('only package files and the bridge exist: app-like paths, traversal, unknown files, and non-GET methods are 404', async () => {
  const { app, packagesRepository, pkg, storage, url } = await setup();
  const paths = [
    '/', '/app/', '/app/index.html', '/api/projects', '/api/auth/login', '/api/public/requirements/x', '/mcp',
    '/.well-known/oauth-authorization-server', '/images/users/a.png', '/__odin/', '/__odin/other.js', '/p/', `/p/${pkg.id}`,
    url('screens/missing.png'), url('../manifest.json'), url('%2e%2e/manifest.json'), url('prototypes%2Fbooking%2Findex.html'),
    url('SCREENS/home.png'), url('screens/home.png%00.html'),
  ];
  for (const path of paths) {
    const response = await request(app).get(path);
    assert.equal(response.status, 404, path);
    assertReviewHeaders(response);
  }
  for (const method of ['post', 'put', 'delete', 'patch']) {
    const response = await request(app)[method](url('screens/home.png'));
    assert.equal(response.status, 404, method);
    assertReviewHeaders(response);
  }
  for (const path of [url('prototypes/booking/../../manifest.json'), url('prototypes/../screens/home.png'), url('./screens/home.png'), url('screens//home.png')]) {
    const response = await rawGet(app, path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers['content-security-policy'], EXPECTED_CSP);
  }
  const options = await request(app).options(url('screens/home.png'));
  assert.equal(options.status, 404);

  // A withdrawn package stops serving even with a valid grant.
  await packagesRepository.setPackageStatus({ from: 'draft', packageId: pkg.id, projectId: 'project-1', tenantId: 'tenant-1', to: 'withdrawn' });
  assert.equal((await request(app).get(url('screens/home.png'))).status, 404);
  assert.ok(storage.objects.size > 0);
});

test('a grant serves files only while its viewer may still see the package, and nothing is cached past that', async () => {
  const { access, app, pkg, url } = await setup();
  const path = url('prototypes/booking/styles.css');
  const first = await request(app).get(path);
  assert.equal(first.status, 200);
  assert.deepEqual(access.checks.at(-1), { packageId: pkg.id, viewerRef: 'user:u-1' });

  // Revalidation returns 304 for an unchanged file, and still asks whether access holds.
  const etag = first.headers.etag;
  const revalidated = await request(app).get(path).set('If-None-Match', etag);
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.etag, etag);
  assert.equal(revalidated.headers['cache-control'], 'private, no-cache');
  assert.equal(revalidated.headers['access-control-allow-origin'], '*');
  assert.equal(access.checks.length, 2);

  // HTML is served with the bridge, so its tag is not the stored file's hash alone.
  const html = await request(app).get(url('prototypes/booking/index.html')).set('Sec-Fetch-Dest', 'iframe');
  assert.match(html.headers.etag, /^"[0-9a-f]{64}-[0-9a-f]{16}"$/);

  access.allowed = false;
  for (const response of [await request(app).get(path), await request(app).get(path).set('If-None-Match', etag)]) {
    assert.equal(response.status, 404);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers.etag, undefined);
    assertReviewHeaders(response);
  }
});

test('package HTML and SVG are served only to frames, images, and fetches, checked before the grant is read', async () => {
  const { app, url } = await setup();
  const refused = [];
  for (const path of [url('prototypes/booking/index.html'), url('prototypes/booking/'), url('assets/logo.svg'), url('prototypes/booking/index.html', 'not-a-grant')]) {
    for (const destination of ['document', 'object', 'embed', null]) {
      const pending = request(app).get(path);
      refused.push([`${path} as ${destination ?? 'no Fetch Metadata'}`, await (destination ? pending.set('Sec-Fetch-Dest', destination) : pending)]);
    }
  }
  for (const [label, response] of refused) {
    assert.equal(response.status, 403, label);
    assert.equal(response.text, 'Open this prototype from OdinPMP.');
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    assertReviewHeaders(response);
  }
  assert.equal((await request(app).get(url('screens/home.png'))).status, 200, 'other files need no Fetch Metadata');
  const allowed = [
    ['prototypes/booking/index.html', 'iframe'],
    ['prototypes/booking/index.html', 'empty'],
    ['assets/logo.svg', 'image'],
    ['screens/home.png', 'document'],
    ['prototypes/booking/styles.css', 'document'],
  ];
  for (const [path, destination] of allowed) {
    assert.equal((await request(app).get(url(path)).set('Sec-Fetch-Dest', destination)).status, 200, `${path} as ${destination}`);
  }
});

test('a file missing from storage is a 404; a storage failure is a 500 that leaks nothing', async () => {
  const { app, storage, url } = await setup();
  const key = [...storage.objects.keys()][0];
  storage.objects.clear();
  assert.equal((await request(app).get(url('screens/home.png'))).status, 404);
  storage.read = async () => { throw new Error(`disk on fire at ${key}`); };
  const response = await request(app).get(url('screens/home.png'));
  assert.equal(response.status, 500);
  assert.equal(response.text, 'Server error');
  assertReviewHeaders(response);
});
