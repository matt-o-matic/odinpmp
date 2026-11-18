import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { computeScreenRecords, prototypeHash } from '../src/modules/requirements/packages/package-hash.js';
import { resolvePackageReference } from '../src/modules/requirements/packages/package-url-scan.js';
import { validateReviewPackage } from '../src/modules/requirements/packages/package-validator.js';
import { createRoundsTestApp, roundPackageFiles, ROLE_USERS } from './helpers/requirements-rounds-app.js';
import {
  buildZip,
  imageScreen,
  makePng,
  manifestWith,
  PROTOTYPE_HTML,
  prototypeScreen,
  standardFiles,
} from './helpers/review-packages.js';

// A prototype's content hash covers everything it may load: its own directory and the
// package's shared files (package-spec.md section 6; audit finding 7 and R4, 2026-10-07).
// The review origin refuses anything else, so a file a script could load outside that
// scope cannot change what the prototype shows.

const SHARED_IMPORT_CSS = '@import "../../assets/shared.css";\nh1 { margin: 0; }';

async function validate(files) {
  const result = await validateReviewPackage({ zip: await buildZip(files) }, { mermaid: null, track: 'experience' });
  assert.equal(result.status, 'accepted', JSON.stringify(result.errors));
  return Object.fromEntries(result.screens.map((screen) => [screen.screenId, screen.contentHash]));
}

/** Hashes per screen id for a files object; an `undefined` value leaves that file out. */
function hashes(files) {
  const filesByPath = new Map(Object.entries(files)
    .filter(([, value]) => value !== undefined)
    .map(([path, value]) => [path, Buffer.from(value)]));
  const manifest = JSON.parse(filesByPath.get('manifest.json').toString('utf8'));
  return Object.fromEntries(computeScreenRecords(manifest, filesByPath).map((screen) => [screen.screenId, screen.contentHash]));
}

/**
 * An image screen ("home"), a prototype ("booking") that loads a shared stylesheet, font, and
 * image from assets/, a second prototype ("other") with only its own files, and one shared
 * file nothing uses.
 */
function packageFiles(overrides = {}) {
  return {
    'assets/brand.woff2': Buffer.from('wOF2 brand v1'),
    'assets/hero.png': makePng(10, 10),
    'assets/shared.css': 'h1 { color: red; padding: 2px; }',
    'assets/unused.png': makePng(4, 4),
    'manifest.json': JSON.stringify(manifestWith({ sections: [
      { id: 'screens', items: [imageScreen('home'), prototypeScreen('booking'), prototypeScreen('other')], type: 'screens' },
    ] })),
    'prototypes/booking/app.js': 'window.OdinReview && window.OdinReview.setState("start");',
    'prototypes/booking/index.html': PROTOTYPE_HTML,
    'prototypes/booking/styles.css': [
      '@import "../../assets/shared.css";',
      '@font-face { font-family: Brand; src: url("../../assets/brand.woff2") format("woff2"); }',
      '.hero { background: url(../../assets/hero.png); }',
    ].join('\n'),
    'prototypes/other/index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><img src="logo.png" alt=""></body></html>',
    'prototypes/other/logo.png': makePng(8, 8),
    'prototypes/other/styles.css': 'body { background: url(texture.png); }',
    'prototypes/other/texture.png': makePng(6, 6),
    'screens/home.png': makePng(320, 200),
    ...overrides,
  };
}

/** packageFiles with booking's index.html given extra body markup. */
function bookingWith(markup, overrides = {}) {
  return packageFiles({ 'prototypes/booking/index.html': PROTOTYPE_HTML.replace('</h1>', `</h1>${markup}`), ...overrides });
}

test('the fixture is a valid package, and the validator stores the hashes computeScreenRecords gives', async () => {
  assert.deepEqual(await validate(packageFiles()), hashes(packageFiles()));
});

test('audit case: two packages identical except assets/shared.css, which the prototype @imports, hash the prototype differently', async () => {
  const files = (shared) => ({ ...standardFiles({ css: SHARED_IMPORT_CSS }), 'assets/shared.css': shared });
  const red = await validate(files('h1 { color: red; padding: 2px; }'));
  const blue = await validate(files('h1 { color: blue; padding: 200px; }'));
  assert.notEqual(blue.booking, red.booking);
  assert.equal(blue.home, red.home, 'an image screen covers only its own bytes');
});

test('a shared image and a shared font loaded from CSS url() are covered', () => {
  const base = hashes(packageFiles());
  const font = hashes(packageFiles({ 'assets/brand.woff2': Buffer.from('wOF2 brand v2') }));
  const image = hashes(packageFiles({ 'assets/hero.png': makePng(10, 10, [255, 0, 0]) }));
  assert.notEqual(font.booking, base.booking);
  assert.notEqual(image.booking, base.booking);
  assert.equal(font.home, base.home);
  assert.equal(image.home, base.home);
});

test('any change to a shared file changes every prototype, whether or not it uses the file', () => {
  const base = hashes(packageFiles());
  const changed = hashes(packageFiles({ 'assets/unused.png': makePng(4, 4, [0, 0, 255]) }));
  const removed = hashes(packageFiles({ 'assets/unused.png': undefined }));
  const added = hashes(packageFiles({ 'assets/extra.css': 'p {}' }));
  for (const variant of [changed, removed, added]) {
    assert.notEqual(variant.booking, base.booking);
    assert.notEqual(variant.other, base.other, 'a prototype that loads nothing from assets/ changes too');
    assert.equal(variant.home, base.home);
  }
});

test('another prototype\'s directory and image screen files are outside a prototype\'s scope, so they never change its hash', () => {
  const base = hashes(packageFiles());
  const otherChanged = hashes(packageFiles({
    'prototypes/other/logo.png': makePng(8, 8, [1, 2, 3]),
    'prototypes/other/styles.css': 'body { background: url(texture.png); color: purple; }',
  }));
  assert.equal(otherChanged.booking, base.booking, 'another prototype\'s private directory is not shared');
  assert.notEqual(otherChanged.other, base.other);

  const homeChanged = hashes(packageFiles({ 'screens/home.png': makePng(320, 200, [9, 9, 9]) }));
  assert.equal(homeChanged.booking, base.booking);
  assert.equal(homeChanged.other, base.other);
  assert.notEqual(homeChanged.home, base.home);
});

test('R4 a script-only reference to an image screen file: the package is accepted, the hash ignores the file, and the review origin will not serve it to the prototype', async () => {
  // Scripts are not scanned, so this is accepted (static references are rejected; see the
  // validator tests). review-origin.test.js shows the booking grant gets 404 for it.
  const scripted = (home) => packageFiles({
    'prototypes/booking/app.js': 'const img = new Image(); img.src = "../../screens/home.png"; document.body.append(img);',
    'screens/home.png': home,
  });
  const first = await validate(scripted(makePng(320, 200)));
  const second = await validate(scripted(makePng(320, 200, [9, 9, 9])));
  assert.equal(second.booking, first.booking);
  assert.notEqual(second.home, first.home);
});

test('moving a whole prototype directory keeps its hash while shared files stay the same', () => {
  const base = packageFiles();
  const moved = {};
  for (const [path, value] of Object.entries(base)) moved[path.replace(/^prototypes\/booking\//, 'designs/booking/')] = value;
  moved['manifest.json'] = JSON.stringify(manifestWith({ sections: [
    { id: 'screens', items: [imageScreen('home'), prototypeScreen('booking', { src: 'designs/booking/index.html' }), prototypeScreen('other')], type: 'screens' },
  ] }));
  assert.deepEqual(hashes(moved), hashes(base));
  assert.notEqual(hashes({ ...moved, 'assets/shared.css': 'h1 { color: blue; }' }).booking, hashes(base).booking);
});

test('shared files are hashed apart from the prototype\'s own files, so a same-named file cannot stand in for one', () => {
  const manifest = JSON.stringify(manifestWith({ sections: [
    { id: 'screens', items: [prototypeScreen('p', { src: 'p/index.html' })], type: 'screens' },
  ] }));
  const own = hashes({ 'manifest.json': manifest, 'p/index.html': '<p>hi</p>', 'p/z.css': 'p {}' });
  const shared = hashes({ 'manifest.json': manifest, 'p/index.html': '<p>hi</p>', 'z.css': 'p {}' });
  assert.notEqual(own.p, shared.p);
});

test('without a package context, prototypeHash treats every file outside the prototype directory as shared', () => {
  const files = (color) => new Map([
    ['manifest.json', Buffer.from('{}')],
    ['prototypes/x/index.html', Buffer.from('<p>hi</p>')],
    ['screens/home.png', makePng(320, 200, color)],
  ]);
  assert.notEqual(prototypeHash('prototypes/x/index.html', files([1, 1, 1])), prototypeHash('prototypes/x/index.html', files([2, 2, 2])));
  const manifest = { sections: [{ items: [imageScreen('home'), prototypeScreen('x')], type: 'screens' }] };
  const hashOf = (color) => computeScreenRecords(manifest, files(color)).find((screen) => screen.screenId === 'x').contentHash;
  assert.equal(hashOf([1, 1, 1]), hashOf([2, 2, 2]), 'with the manifest, an image screen file is not shared');
});

test('resolvePackageReference maps a reference to the package path the review origin serves', () => {
  const from = 'prototypes/booking/index.html';
  assert.equal(resolvePackageReference(from, 'styles.css'), 'prototypes/booking/styles.css');
  assert.equal(resolvePackageReference(from, './img/a.png'), 'prototypes/booking/img/a.png');
  assert.equal(resolvePackageReference(from, '../../assets/shared.css'), 'assets/shared.css');
  assert.equal(resolvePackageReference(from, ' ..\\..\\assets\\shared.css '), 'assets/shared.css');
  assert.equal(resolvePackageReference(from, '../other/a.css?v=2#x'), 'prototypes/other/a.css');
  assert.equal(resolvePackageReference(from, '../../screens/booking%20home.png'), 'screens/booking home.png');
  assert.equal(resolvePackageReference(from, '%2e%2e/other/a.css'), 'prototypes/other/a.css');
  assert.equal(resolvePackageReference(from, '../other/'), 'prototypes/other/index.html');
  assert.equal(resolvePackageReference(from, '..'), 'prototypes/index.html');
  assert.equal(resolvePackageReference('assets/shared.css', 'fonts/a.woff2'), 'assets/fonts/a.woff2');
  assert.equal(resolvePackageReference('index.html', 'a.css'), 'a.css');
  for (const value of ['', '#confirm', '?v=1', 'data:image/png;base64,AAAA', 'https://x.test/a.css', '//x.test/a.css', '/logo.png', 'mailto:a@b.test', '../../../escape.css', 'a//b.css', 'a%2Fb.css', '%E0%A4%A.css']) {
    assert.equal(resolvePackageReference(from, value), null, JSON.stringify(value));
  }
});

test('AC-12 carry-forward: when only a shared stylesheet changes, an open annotation on the prototype goes outdated, not carried', async () => {
  const harness = await createRoundsTestApp();
  const files = (shared) => ({ ...roundPackageFiles({ css: SHARED_IMPORT_CSS }), 'assets/shared.css': shared });
  const reviewers = [{ actorId: ROLE_USERS.reviewer.id, actorType: 'user' }];
  const pin = { number: 1, schemaVersion: 1, style: { color: '#c2410c', stroke: 3 }, type: 'pin', x: 10, y: 10 };

  const v1 = await harness.uploadPackage(files('h1 { color: red; padding: 2px; }'));
  const { round } = await harness.publish({ packageId: v1.id, reviewers });
  const ravi = harness.team('reviewer', round.id);
  const marks = { home: randomUUID(), proto: randomUUID() };
  for (const [screenId, id] of [['booking', marks.proto], ['home', marks.home]]) {
    const anchor = screenId === 'booking' ? { snapshotUnavailable: true } : {};
    const created = await ravi.put(`/annotations/${id}`, { anchor, screenId, shapes: [pin] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
  const closed = await harness.as('projectManager').post(`/rounds/${round.id}/close`, { outcome: 'changes-requested' });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));

  const v2 = await harness.uploadPackage(files('h1 { color: blue; padding: 200px; }'));
  const change = (screenId) => v2.changes.screens.find((screen) => screen.screenId === screenId).change;
  assert.equal(change('booking'), 'changed');
  assert.equal(change('home'), 'unchanged');

  const published = await harness.publish({ packageId: v2.id, reviewers });
  assert.deepEqual(published.carryForward, { carried: 1, outdated: 1, superseded: 0 });
  const proto = await harness.roundsRepository.getAnnotation({ annotationId: marks.proto });
  assert.deepEqual([proto.status, proto.roundId], ['outdated', round.id]);
  const home = await harness.roundsRepository.getAnnotation({ annotationId: marks.home });
  assert.deepEqual([home.status, home.roundId], ['carried', published.round.id]);
});
