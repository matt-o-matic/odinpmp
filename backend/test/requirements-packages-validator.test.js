import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readImageSize } from '../src/modules/requirements/packages/image-size.js';
import { checkPackagePath, contentTypeForPath, normalizeServedPath } from '../src/modules/requirements/packages/package-files.js';
import { computeScreenRecords, prototypeHash } from '../src/modules/requirements/packages/package-hash.js';
import { isExternalUrl, scanCss, scanMarkup } from '../src/modules/requirements/packages/package-url-scan.js';
import { MANIFEST_SCHEMA, validateReviewPackage } from '../src/modules/requirements/packages/package-validator.js';
import {
  buildExampleZip,
  buildZip,
  imageScreen,
  makePng,
  manifestWith,
  prototypeScreen,
  REPO_ROOT,
  standardFiles,
} from './helpers/review-packages.js';

// Mermaid parsing is covered by its own tests below; most fixtures skip it for speed.
const NO_MERMAID = { mermaid: null };

async function validateFiles(files, options = {}) {
  return validateReviewPackage({ zip: await buildZip(files) }, { track: 'experience', ...NO_MERMAID, ...options });
}

function codes(result) {
  return result.errors.map((error) => error.code);
}

function assertRejectedWith(result, code, { file, path: pointer } = {}) {
  assert.equal(result.status, 'rejected', JSON.stringify(result.errors));
  const match = result.errors.find((error) => error.code === code
    && (file === undefined || error.file === file)
    && (pointer === undefined || error.path === pointer));
  assert.ok(match, `expected ${code}${file ? ` for ${file}` : ''}${pointer ? ` at ${pointer}` : ''}, got ${JSON.stringify(result.errors)}`);
  for (const error of result.errors) {
    assert.deepEqual(Object.keys(error).sort(), ['code', 'file', 'message', 'path']);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
  }
  return match;
}

// Overwrites every occurrence of one byte sequence in a buffer (used to forge zip headers).
function replaceAll(buffer, from, to) {
  assert.equal(from.length, to.length);
  const copy = Buffer.from(buffer);
  let offset = copy.indexOf(from);
  let replaced = 0;
  while (offset !== -1) {
    to.copy(copy, offset);
    replaced += 1;
    offset = copy.indexOf(from, offset + from.length);
  }
  assert.ok(replaced > 0, 'pattern not found');
  return copy;
}

// Rewrites the uncompressed size of one entry in both its local header and its central
// directory record, leaving the data and CRC alone.
function forgeUncompressedSize(zip, name, size) {
  const copy = Buffer.from(zip);
  const nameBytes = Buffer.from(name, 'utf8');
  let patched = 0;
  for (let offset = 0; offset + 46 <= copy.length; offset += 1) {
    const signature = copy.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      const nameLength = copy.readUInt16LE(offset + 26);
      if (copy.subarray(offset + 30, offset + 30 + nameLength).equals(nameBytes)) {
        copy.writeUInt32LE(size, offset + 22);
        patched += 1;
      }
    } else if (signature === 0x02014b50) {
      const nameLength = copy.readUInt16LE(offset + 28);
      if (copy.subarray(offset + 46, offset + 46 + nameLength).equals(nameBytes)) {
        copy.writeUInt32LE(size, offset + 24);
        patched += 1;
      }
    }
  }
  assert.equal(patched, 2, 'patched the local header and the central directory');
  return copy;
}

// ---------------------------------------------------------------------------
// Schema copy and examples (AC-21)
// ---------------------------------------------------------------------------

test('the backend schema copy matches docs/requirements-gathering/review-package.schema.json', async () => {
  const docs = await readFile(path.join(REPO_ROOT, 'docs/requirements-gathering/review-package.schema.json'), 'utf8');
  const copy = await readFile(new URL('../src/modules/requirements/packages/review-package.schema.json', import.meta.url), 'utf8');
  assert.deepEqual(JSON.parse(copy), JSON.parse(docs));
  assert.equal(copy.replace(/\r\n/g, '\n'), docs.replace(/\r\n/g, '\n'), 'the copy is byte-identical apart from line endings');
  assert.deepEqual(MANIFEST_SCHEMA, JSON.parse(docs));
});

test('AC-21 both example packages are accepted, with Mermaid checked for real', { timeout: 180_000 }, async () => {
  const fieldwork = await validateReviewPackage({ zip: await buildExampleZip('fieldwork-round-2') }, { track: 'experience' });
  assert.equal(fieldwork.status, 'accepted', JSON.stringify(fieldwork.errors));
  assert.deepEqual(fieldwork.errors, []);
  assert.deepEqual(fieldwork.warnings, [], 'the example screenshots match their declared sizes');
  assert.deepEqual(fieldwork.screens.map((screen) => [screen.screenId, screen.kind]), [
    ['booking-home', 'image'],
    ['booking-home-schedule', 'image'],
    ['booking-flow', 'prototype'],
  ]);
  for (const screen of fieldwork.screens) assert.match(screen.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(fieldwork.fileCount, 6);
  assert.deepEqual(fieldwork.files.map((file) => [file.path, file.contentType]).sort(), [
    ['manifest.json', 'application/json; charset=utf-8'],
    ['prototypes/booking/app.js', 'text/javascript; charset=utf-8'],
    ['prototypes/booking/index.html', 'text/html; charset=utf-8'],
    ['prototypes/booking/styles.css', 'text/css; charset=utf-8'],
    ['screens/booking-home-schedule.png', 'image/png'],
    ['screens/booking-home.png', 'image/png'],
  ]);

  const scheduling = await validateReviewPackage({ zip: await buildExampleZip('scheduling-options') }, { track: 'experience' });
  assert.equal(scheduling.status, 'accepted', JSON.stringify(scheduling.errors));
  assert.deepEqual(scheduling.screens, []);
});

// ---------------------------------------------------------------------------
// Zip checks (AC-04)
// ---------------------------------------------------------------------------

test('zip_invalid: not a zip, an empty upload, and a corrupt entry', async () => {
  assertRejectedWith(await validateReviewPackage({ zip: randomBytes(2048) }, NO_MERMAID), 'zip_invalid');
  assertRejectedWith(await validateReviewPackage({ zip: Buffer.alloc(0) }, NO_MERMAID), 'zip_invalid');

  const stored = await buildZip({ 'manifest.json': JSON.stringify(manifestWith()), 'screens/home.png': makePng(320, 200) }, { compression: 'STORE' });
  const corrupt = replaceAll(stored, Buffer.from('"title":"Client booking"'), Buffer.from('"title":"Client bookinX"'));
  assertRejectedWith(await validateReviewPackage({ zip: corrupt }, { track: 'experience', ...NO_MERMAID }), 'zip_invalid', { file: 'manifest.json' });
});

test('zip_limit: zip size, entry count, path length, compression ratio, total size, and a lying size header', async () => {
  const files = standardFiles();
  const zip = await buildZip(files);
  assertRejectedWith(await validateReviewPackage({ zip }, { ...NO_MERMAID, limits: { zipBytes: zip.length - 1 } }), 'zip_limit');
  assertRejectedWith(await validateReviewPackage({ zip }, { ...NO_MERMAID, limits: { entries: 3 } }), 'zip_limit');

  const longPath = `assets/${'a'.repeat(240)}.png`;
  assertRejectedWith(await validateFiles({ ...files, [longPath]: makePng(320, 200) }), 'zip_limit', { file: longPath });

  // 2 MB of zeros deflates far past 100:1.
  assertRejectedWith(await validateFiles({ ...files, 'assets/zeros.txt': Buffer.alloc(2 * 1024 * 1024) }), 'zip_limit', { file: 'assets/zeros.txt' });

  // Incompressible bytes over a (lowered) total limit: an oversize entry.
  const oversize = await validateReviewPackage(
    { zip: await buildZip({ ...files, 'assets/noise.txt': randomBytes(64 * 1024) }) },
    { ...NO_MERMAID, limits: { totalUncompressedBytes: 32 * 1024 }, track: 'experience' },
  );
  assertRejectedWith(oversize, 'zip_limit');

  // An entry whose headers claim 1,000 bytes but which inflates to 50,000. Neither the
  // declared ratio nor the declared total trips; the capped read must.
  const honest = await buildZip({ ...files, 'assets/notes.txt': 'x'.repeat(50_000) });
  const forged = forgeUncompressedSize(honest, 'assets/notes.txt', 1_000);
  const lying = await validateReviewPackage({ zip: forged }, { ...NO_MERMAID, track: 'experience' });
  assertRejectedWith(lying, 'zip_limit', { file: 'assets/notes.txt' });
});

test('path_invalid: traversal, absolute, drive letter, backslash, reserved names, symlinks, empty directories, collisions, duplicates', async () => {
  const files = standardFiles();
  for (const bad of ['../evil.png', 'assets/../../evil.png', '/abs.png', 'C:/drive.png', 'assets\\back.png', 'assets/CON.png', 'aux/logo.png', 'assets/./dot.png']) {
    const result = await validateFiles({ ...files, [bad]: makePng(320, 200) });
    assertRejectedWith(result, 'path_invalid', { file: bad });
  }

  const symlink = await validateFiles({ ...files, 'assets/link.png': { content: '../../etc/passwd', unixPermissions: 0o120777 } });
  assertRejectedWith(symlink, 'path_invalid', { file: 'assets/link.png' });

  const emptyDirectory = await validateFiles({ ...files, 'assets/empty/': { dir: true } });
  assertRejectedWith(emptyDirectory, 'path_invalid', { file: 'assets/empty/' });

  const collision = await validateFiles({ ...files, 'screens/HOME.png': makePng(320, 200) });
  assertRejectedWith(collision, 'path_invalid', { file: 'screens/HOME.png' });

  // Two central directory entries with the same name (forged from two distinct names).
  const twoNames = await buildZip({ ...files, 'assets/aaaa.css': 'a{}', 'assets/bbbb.css': 'b{}' });
  const duplicated = replaceAll(twoNames, Buffer.from('assets/bbbb.css'), Buffer.from('assets/aaaa.css'));
  assertRejectedWith(await validateReviewPackage({ zip: duplicated }, { ...NO_MERMAID, track: 'experience' }), 'path_invalid');
});

test('type_not_allowed: a disallowed extension, no extension, and HTML or JavaScript outside a prototype', async () => {
  const files = standardFiles();
  assertRejectedWith(await validateFiles({ ...files, 'tools/run.exe': randomBytes(16) }), 'type_not_allowed', { file: 'tools/run.exe' });
  assertRejectedWith(await validateFiles({ ...files, LICENSE: 'MIT' }), 'type_not_allowed', { file: 'LICENSE' });
  assertRejectedWith(await validateFiles({ ...files, 'assets/page.html': '<p>hi</p>' }), 'type_not_allowed', { file: 'assets/page.html' });
  assertRejectedWith(await validateFiles({ ...files, 'assets/lib.js': 'void 0;' }), 'type_not_allowed', { file: 'assets/lib.js' });
  // Every allowed extension passes.
  const allowed = await validateFiles({
    ...files,
    'assets/a.gif': Buffer.from('GIF89a'),
    'assets/a.jpeg': Buffer.from([0xff, 0xd8, 0xff]),
    'assets/a.jpg': Buffer.from([0xff, 0xd8, 0xff]),
    'assets/a.json': '{}',
    'assets/a.md': '# notes',
    'assets/a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/a.txt': 'notes',
    'assets/a.webp': Buffer.from('RIFF'),
    'assets/a.woff': Buffer.from('wOFF'),
    'assets/a.woff2': Buffer.from('wOF2'),
    'prototypes/booking/module.mjs': 'export {};',
  });
  assert.equal(allowed.status, 'accepted', JSON.stringify(allowed.errors));
});

test('scan_failed: a flagged file and a scanner that cannot run; a disabled scanner is skipped', async () => {
  const files = standardFiles();
  const flagging = { enabled: true, async scanBytes(bytes) { return { clean: !bytes.toString('latin1').includes('EICAR') }; } };
  const flagged = await validateFiles({ ...files, 'assets/eicar.txt': 'X5O!P%@AP EICAR test' }, { scanner: flagging });
  assertRejectedWith(flagged, 'scan_failed', { file: 'assets/eicar.txt' });
  assert.equal(flagged.errors.length, 1);

  const broken = { enabled: true, async scanBytes() { throw new Error('clamd unreachable'); } };
  const failed = await validateFiles(files, { scanner: broken });
  assertRejectedWith(failed, 'scan_failed');
  assert.equal(failed.errors.length, Object.keys(files).length, 'every file reports the failure');

  const disabled = { enabled: false, async scanBytes() { throw new Error('should not run'); } };
  assert.equal((await validateFiles(files, { scanner: disabled })).status, 'accepted');
});

// ---------------------------------------------------------------------------
// Manifest and schema
// ---------------------------------------------------------------------------

test('manifest_missing: none at all, and one inside a folder', async () => {
  const files = standardFiles();
  const { 'manifest.json': manifest, ...rest } = files;
  assertRejectedWith(await validateFiles(rest), 'manifest_missing');
  const nested = assertRejectedWith(await validateFiles({ ...rest, 'package/manifest.json': manifest }), 'manifest_missing');
  assert.match(nested.message, /root/);
});

test('manifest_invalid: not JSON, not an object, too large, schema failures with JSON Pointer paths', async () => {
  const files = standardFiles();
  assertRejectedWith(await validateFiles({ ...files, 'manifest.json': '{ "schema": ' }), 'manifest_invalid', { path: '' });
  assertRejectedWith(await validateFiles({ ...files, 'manifest.json': '[]' }), 'manifest_invalid', { path: '' });
  assertRejectedWith(await validateFiles(files, { limits: { manifestBytes: 100 } }), 'manifest_invalid', { path: '' });

  const wrongSchema = await validateFiles({ ...files, 'manifest.json': JSON.stringify(manifestWith({ schema: 'odin.review-package/v0' })) });
  assertRejectedWith(wrongSchema, 'manifest_invalid', { path: '/schema' });

  const misspelled = manifestWith({ sections: [{ id: 'screens', items: [{ ...imageScreen('home'), screenID: 'home' }], type: 'screens' }] });
  const unknown = assertRejectedWith(await validateFiles({ ...files, 'manifest.json': JSON.stringify(misspelled) }), 'manifest_invalid', { path: '/sections/0/items/0/screenID' });
  assert.match(unknown.message, /Unknown field "screenID"/);

  const missingAlt = manifestWith({ sections: [{ id: 'screens', items: [{ ...imageScreen('home'), alt: undefined }], type: 'screens' }] });
  assertRejectedWith(await validateFiles({ ...files, 'manifest.json': JSON.stringify(missingAlt) }), 'manifest_invalid', { path: '/sections/0/items/0/alt' });

  const badId = manifestWith({ sections: [{ id: 'screens', items: [imageScreen('Home_Screen')], type: 'screens' }] });
  assertRejectedWith(await validateFiles({ ...files, 'manifest.json': JSON.stringify(badId) }), 'manifest_invalid', { path: '/sections/0/items/0/id' });

  const viewportOnImage = manifestWith({ sections: [{ id: 'screens', items: [{ ...imageScreen('home'), viewport: { height: 800, width: 1280 } }], type: 'screens' }] });
  assertRejectedWith(await validateFiles({ ...files, 'manifest.json': JSON.stringify(viewportOnImage) }), 'manifest_invalid', { path: '/sections/0/items/0/viewport' });

  const onlyContext = manifestWith({ sections: [{ body: 'Context only.', id: 'context', type: 'context' }] });
  assertRejectedWith(await validateFiles({ ...files, 'manifest.json': JSON.stringify(onlyContext) }), 'manifest_invalid', { path: '/sections' });

  const twoScreenSections = manifestWith({ sections: [
    { id: 'screens', items: [imageScreen('home')], type: 'screens' },
    { id: 'more-screens', items: [imageScreen('other', { src: 'screens/home.png' })], type: 'screens' },
  ] });
  assertRejectedWith(await validateFiles({ ...files, 'manifest.json': JSON.stringify(twoScreenSections) }), 'manifest_invalid', { path: '/sections/1/type' });

  const scaleQuestion = (scale) => manifestWith({ sections: [
    { id: 'screens', items: [imageScreen('home')], type: 'screens' },
    { id: 'questions', items: [{ id: 'speed', kind: 'scale', prompt: 'How quick?', scale }], type: 'questions' },
  ] });
  assertRejectedWith(await validateFiles({ ...files, 'manifest.json': JSON.stringify(scaleQuestion({ max: 1, min: 5 })) }), 'manifest_invalid', { path: '/sections/1/items/0/scale' });
  assertRejectedWith(await validateFiles({ ...files, 'manifest.json': JSON.stringify(scaleQuestion({ max: 10, min: -10 })) }), 'manifest_invalid', { path: '/sections/1/items/0/scale' });
});

test('track_mismatch: the manifest names another track than the upload target', async () => {
  const result = await validateFiles(standardFiles(), { track: 'architecture' });
  assertRejectedWith(result, 'track_mismatch', { file: 'manifest.json', path: '/track' });
});

// ---------------------------------------------------------------------------
// Cross-references
// ---------------------------------------------------------------------------

test('missing_file: a screen src that is not in the package, including a case mismatch', async () => {
  const manifest = manifestWith({ sections: [{ id: 'screens', items: [imageScreen('home'), imageScreen('confirm')], type: 'screens' }] });
  const missing = assertRejectedWith(await validateFiles({ ...standardFiles(), 'manifest.json': JSON.stringify(manifest) }), 'missing_file', { path: '/sections/0/items/1/src' });
  assert.equal(missing.message, 'screens/confirm.png is not in the package.');

  const caseManifest = manifestWith({ sections: [{ id: 'screens', items: [imageScreen('home', { src: 'screens/Home.png' })], type: 'screens' }] });
  const caseMismatch = assertRejectedWith(await validateFiles({ ...standardFiles(), 'manifest.json': JSON.stringify(caseManifest) }), 'missing_file');
  assert.match(caseMismatch.message, /case-sensitive/);
});

test('reference_invalid: directionId, screenIds, and topicId that do not resolve; a topic on either track resolves', async () => {
  const manifest = manifestWith({ sections: [
    { id: 'directions', items: [
      { id: 'action-first', screenIds: ['home', 'ghost'], summary: 'Book first.', title: 'Action first' },
      { id: 'schedule-first', summary: 'Calendar first.', title: 'Schedule first' },
    ], type: 'directions' },
    { id: 'screens', items: [imageScreen('home', { directionId: 'nowhere' })], type: 'screens' },
    { id: 'questions', items: [
      { id: 'known', kind: 'text', prompt: 'Known topic?', topicId: 'topic-exp' },
      { id: 'unknown', kind: 'text', prompt: 'Unknown topic?', topicId: 'topic-missing' },
      { id: 'other-track', kind: 'text', prompt: 'Other track?', topicId: 'topic-arch' },
    ], type: 'questions' },
  ] });
  const topics = { 'topic-arch': { track: 'architecture' }, 'topic-exp': { track: 'experience' } };
  const result = await validateFiles({ ...standardFiles(), 'manifest.json': JSON.stringify(manifest) }, {
    lookupTopic: async (topicId) => topics[topicId] ?? null,
  });
  assertRejectedWith(result, 'reference_invalid', { path: '/sections/0/items/0/screenIds/1' });
  assertRejectedWith(result, 'reference_invalid', { path: '/sections/1/items/0/directionId' });
  assertRejectedWith(result, 'reference_invalid', { path: '/sections/2/items/1/topicId' });
  // Review is project-wide: a question may settle a topic on the other track.
  assert.equal(result.errors.filter((error) => error.code === 'reference_invalid').length, 3, 'the known topics resolve, on either track');
});

test('duplicate_id: ids repeat within their kind (screens, options, state keys, dimensions, sections)', async () => {
  const manifest = manifestWith({
    feedbackDimensions: ['type', 'type', { id: 'vendor-lock-in', label: 'Lock-in' }],
    sections: [
      { id: 'screens', items: [
        imageScreen('home'),
        imageScreen('home'),
        prototypeScreen('booking', { states: [{ key: 'start', label: 'Start' }, { key: 'start', label: 'Again' }] }),
      ], type: 'screens' },
      { id: 'screens', items: [{ id: 'q', kind: 'single', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'A again' }], prompt: 'Pick' }], type: 'questions' },
    ],
  });
  const result = await validateFiles({ ...standardFiles(), 'manifest.json': JSON.stringify(manifest) });
  assertRejectedWith(result, 'duplicate_id', { path: '/sections/0/items/1/id' });
  assertRejectedWith(result, 'duplicate_id', { path: '/sections/0/items/2/states/1/key' });
  assertRejectedWith(result, 'duplicate_id', { path: '/sections/1/items/0/options/1/id' });
  assertRejectedWith(result, 'duplicate_id', { path: '/feedbackDimensions/1' });
  assertRejectedWith(result, 'duplicate_id', { path: '/sections/1/id' });
});

// ---------------------------------------------------------------------------
// Static URL scan
// ---------------------------------------------------------------------------

test('reference_out_of_scope: static references from a prototype or a shared file to what a prototype cannot load', async () => {
  const base = {
    ...standardFiles(),
    'assets/shared.css': 'h1 { margin: 0; }',
    'prototypes/other/index.html': '<!doctype html><p>Other</p>',
    'prototypes/other/logo.png': makePng(8, 8),
  };
  base['manifest.json'] = JSON.stringify(manifestWith({ sections: [
    { id: 'screens', items: [imageScreen('home'), prototypeScreen('booking'), prototypeScreen('other')], type: 'screens' },
  ] }));
  const cases = [
    ['prototypes/booking/index.html', '<img src="../other/logo.png" alt="">', 'prototypes/other/logo.png'],
    ['prototypes/booking/index.html', '<a href="../other/">Other</a>', 'prototypes/other/index.html'],
    ['prototypes/booking/index.html', '<img srcset="../../screens/home.png 2x" alt="">', 'screens/home.png'],
    ['prototypes/booking/index.html', '<link rel="stylesheet" href="../../manifest.json">', 'manifest.json'],
    ['prototypes/booking/styles.css', '.x { background: url("../../screens/home.png"); }', 'screens/home.png'],
    ['assets/shared.css', 'h1 { background: url(../prototypes/other/logo.png); }', 'prototypes/other/logo.png'],
  ];
  for (const [file, content, target] of cases) {
    const result = await validateFiles({ ...base, [file]: content });
    const error = assertRejectedWith(result, 'reference_out_of_scope', { file, path: '' });
    assert.ok(error.message.includes(`references ${target}`), error.message);
  }

  const fine = await validateFiles({
    ...base,
    'assets/shared.css': '@font-face { font-family: B; src: url(brand.woff2); } h1 { background: url(hero.png); }',
    'assets/brand.woff2': Buffer.from('wOF2'),
    'assets/hero.png': makePng(4, 4),
    'prototypes/booking/styles.css': '@import "../../assets/shared.css"; body { background: url(missing-is-not-checked.png); }',
  });
  assert.equal(fine.status, 'accepted', JSON.stringify(fine.errors));
});

test('external_url: absolute script src, CSS url(), @import, srcset, protocol-relative, inline style, and SVG href', async () => {
  const base = standardFiles();
  const cases = [
    ['prototypes/booking/index.html', '<html><head><script src="https://cdn.example.com/react.js"></script></head><body></body></html>'],
    ['prototypes/booking/index.html', '<html><head><link rel="stylesheet" href="//fonts.example.com/a.css"></head></html>'],
    ['prototypes/booking/index.html', '<img srcset="small.png 1x, https://img.example.com/big.png 2x">'],
    ['prototypes/booking/index.html', '<div style="background: url(&quot;https://img.example.com/bg.png&quot;)"></div>'],
    ['prototypes/booking/index.html', '<form action="https://collect.example.com/x"></form>'],
    ['prototypes/booking/index.html', '<a href="ht\ntps://example.com">link</a>'],
    ['prototypes/booking/index.html', '<style>@import "https://fonts.example.com/inter.css";</style>'],
    ['prototypes/booking/styles.css', 'body { background: url( "https://img.example.com/bg.png" ); }'],
    ['prototypes/booking/styles.css', '@import url(http://fonts.example.com/a.css);'],
    ['prototypes/booking/styles.css', '@font-face { src: url(\\68 ttps://fonts.example.com/a.woff2); }'],
    ['assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://img.example.com/a.png"/></svg>'],
  ];
  for (const [file, content] of cases) {
    const result = await validateFiles({ ...base, [file]: content });
    const error = assertRejectedWith(result, 'external_url', { file, path: '' });
    assert.match(error.message, /line \d+/);
  }

  const fine = await validateFiles({
    ...base,
    'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>',
    'prototypes/booking/index.html': '<html><head><link rel="stylesheet" href="styles.css"></head><body><a href="#confirm">Next</a><a href="mailto:ana@example.com">Mail</a><img src="data:image/png;base64,iVBORw0KGgo="><script src="app.js"></script></body></html>',
    'prototypes/booking/styles.css': '@namespace svg url(http://www.w3.org/2000/svg);\n/* url(https://commented.example.com) */\nbody { background: url(bg.png); }',
  });
  assert.equal(fine.status, 'accepted', JSON.stringify(fine.errors));
});

test('URL scan helpers classify URLs and report line numbers', () => {
  assert.equal(isExternalUrl('https://x.test/a.js'), true);
  assert.equal(isExternalUrl(' //x.test/a.js'), true);
  assert.equal(isExternalUrl('\\\\x.test/a.js'), true);
  assert.equal(isExternalUrl('WSS://x.test/socket'), true);
  assert.equal(isExternalUrl('data:image/png;base64,AAAA'), false);
  assert.equal(isExternalUrl('../shared/a.png'), false);
  assert.equal(isExternalUrl('#confirm'), false);
  assert.equal(isExternalUrl('javascript:void(0)'), false);
  assert.deepEqual(scanCss('a{}\n\nb { background: url(https://x.test/a.png) }').map((finding) => finding.line), [3]);
  assert.deepEqual(scanMarkup('<p>\n</p>\n<img src="https://x.test/a.png">').map((finding) => [finding.line, finding.context]), [[3, 'img src']]);
});

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

test('mermaid_invalid: a flow Mermaid cannot parse rejects the package; valid flowchart, sequence, and state diagrams pass', { timeout: 180_000 }, async () => {
  const flows = (items) => manifestWith({ sections: [
    { id: 'screens', items: [imageScreen('home'), prototypeScreen('booking')], type: 'screens' },
    { id: 'flows', items, type: 'flows' },
  ] });
  const valid = await validateReviewPackage({ zip: await buildZip({ ...standardFiles(), 'manifest.json': JSON.stringify(flows([
    { id: 'flow', mermaid: 'flowchart TD\n  home["Home"] --> book["Book"]', title: 'Flow' },
    { id: 'sequence', mermaid: 'sequenceDiagram\n  participant A\n  A->>B: hello', title: 'Sequence' },
    { id: 'state', mermaid: 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Published', title: 'State' },
  ])) }) }, { track: 'experience' });
  assert.equal(valid.status, 'accepted', JSON.stringify(valid.errors));

  const broken = await validateReviewPackage({ zip: await buildZip({ ...standardFiles(), 'manifest.json': JSON.stringify(flows([
    { id: 'ok', mermaid: 'flowchart LR\n  A --> B', title: 'Fine' },
    { id: 'dangling', mermaid: 'flowchart TD\n  A --> ', title: 'Dangling edge' },
    { id: 'not-mermaid', mermaid: 'this is not a diagram', title: 'Prose' },
    { id: 'bad-sequence', mermaid: 'sequenceDiagram\n  A->>: oops', title: 'Bad sequence' },
  ])) }) }, { track: 'experience' });
  assertRejectedWith(broken, 'mermaid_invalid', { path: '/sections/1/items/1/mermaid' });
  assertRejectedWith(broken, 'mermaid_invalid', { path: '/sections/1/items/2/mermaid' });
  assertRejectedWith(broken, 'mermaid_invalid', { path: '/sections/1/items/3/mermaid' });
  assert.equal(broken.errors.length, 3);

  const unavailable = await validateReviewPackage({ zip: await buildZip({ ...standardFiles(), 'manifest.json': JSON.stringify(flows([
    { id: 'ok', mermaid: 'flowchart LR\n  A --> B', title: 'Fine' },
  ])) }) }, { mermaid: { validate: async () => { throw new Error('worker crashed'); } }, track: 'experience' });
  assertRejectedWith(unavailable, 'mermaid_invalid', { path: '/sections/1/items' });
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

test('warnings: unknown_field (stripped from the stored manifest), size_mismatch, and stale_base_round', async () => {
  const manifest = manifestWith({ basedOnRoundId: 'round-1', theme: 'dark', 'x/y': true });
  const files = { 'manifest.json': JSON.stringify(manifest), 'screens/home.png': makePng(400, 200) };

  const result = await validateFiles(files, { latestRoundId: 'round-2' });
  assert.equal(result.status, 'accepted', JSON.stringify(result.errors));
  assert.deepEqual(result.warnings.map((warning) => [warning.code, warning.path]), [
    ['unknown_field', '/theme'],
    ['unknown_field', '/x~1y'],
    ['size_mismatch', '/sections/0/items/0'],
    ['stale_base_round', '/basedOnRoundId'],
  ]);
  assert.equal(result.warnings[0].message, 'Unknown field "theme" was ignored.');
  assert.match(result.warnings[2].message, /400x200 pixels; the manifest says 320x200/);
  assert.equal(result.manifest.theme, undefined);
  assert.equal(result.manifest.basedOnRoundId, 'round-1');

  const noRounds = await validateFiles(files, { latestRoundId: null });
  assert.match(noRounds.warnings.find((warning) => warning.code === 'stale_base_round').message, /no rounds yet/);
  const current = await validateFiles(files, { latestRoundId: 'round-1' });
  assert.equal(current.warnings.some((warning) => warning.code === 'stale_base_round'), false);

  // Warnings travel with a rejection too.
  const rejected = await validateFiles({ ...files, 'bad.exe': 'x' }, { latestRoundId: 'round-2' });
  assert.equal(rejected.status, 'rejected');
  assert.ok(rejected.warnings.some((warning) => warning.code === 'unknown_field'));
});

test('image headers: PNG, GIF, JPEG, WebP, and SVG dimensions', () => {
  assert.deepEqual(readImageSize(makePng(321, 203), 'png'), { height: 203, width: 321 });
  const gif = Buffer.from('474946383961' + '4001' + 'f000', 'hex');
  assert.deepEqual(readImageSize(Buffer.concat([gif, Buffer.alloc(8)]), 'gif'), { height: 240, width: 320 });
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108012c019003012200021101031101', 'hex');
  assert.deepEqual(readImageSize(jpeg, 'jpg'), { height: 300, width: 400 });
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8X', 8, 'latin1');
  webp.writeUIntLE(1279, 24, 3);
  webp.writeUIntLE(799, 27, 3);
  assert.deepEqual(readImageSize(webp, 'webp'), { height: 800, width: 1280 });
  assert.deepEqual(readImageSize(Buffer.from('<svg width="640" height="480px" xmlns="http://www.w3.org/2000/svg"/>'), 'svg'), { height: 480, width: 640 });
  assert.equal(readImageSize(Buffer.from('<svg width="50%" height="10em"/>'), 'svg'), null);
  assert.equal(readImageSize(Buffer.from('not an image'), 'png'), null);
});

// ---------------------------------------------------------------------------
// Content hashing (package-spec.md section 6)
// ---------------------------------------------------------------------------

test('content hashes: identical prototype directories match, any change to a file in the directory does not', async () => {
  const first = await validateFiles(standardFiles());
  const same = await validateFiles(standardFiles({ manifest: manifestWith({
    sections: [{ id: 'screens', items: [imageScreen('home'), prototypeScreen('booking', { title: 'Renamed in the manifest only' })], type: 'screens' }],
    title: 'A new title',
  }) }));
  const changedCss = await validateFiles(standardFiles({ css: 'body { color: #000; }' }));
  const changedImage = await validateFiles(standardFiles({ png: makePng(320, 200, [255, 0, 0]) }));
  const hashOf = (result, screenId) => result.screens.find((screen) => screen.screenId === screenId).contentHash;

  for (const result of [first, same, changedCss, changedImage]) assert.equal(result.status, 'accepted', JSON.stringify(result.errors));
  assert.equal(hashOf(same, 'booking'), hashOf(first, 'booking'), 'manifest edits do not change a prototype hash');
  assert.equal(hashOf(same, 'home'), hashOf(first, 'home'));
  assert.notEqual(hashOf(changedCss, 'booking'), hashOf(first, 'booking'));
  assert.equal(hashOf(changedCss, 'home'), hashOf(first, 'home'));
  assert.notEqual(hashOf(changedImage, 'home'), hashOf(first, 'home'));
  assert.equal(hashOf(changedImage, 'booking'), hashOf(first, 'booking'));

  // Adding a file under the prototype directory changes it. A shared file changes every
  // prototype, used or not (requirements-packages-hash.test.js covers the rules in full).
  const extraInside = await validateFiles({ ...standardFiles(), 'prototypes/booking/img/logo.png': makePng(10, 10) });
  const extraShared = await validateFiles({ ...standardFiles(), 'assets/logo.png': makePng(10, 10) });
  assert.notEqual(hashOf(extraInside, 'booking'), hashOf(first, 'booking'));
  assert.notEqual(hashOf(extraShared, 'booking'), hashOf(first, 'booking'));
  assert.equal(hashOf(extraShared, 'home'), hashOf(first, 'home'));
});

test('content hashes: the hash covers paths relative to the prototype directory, in path order', () => {
  const files = (prefix) => new Map([
    [`${prefix}index.html`, Buffer.from('<p>hi</p>')],
    [`${prefix}b.css`, Buffer.from('b{}')],
    [`${prefix}a.css`, Buffer.from('a{}')],
  ]);
  const moved = prototypeHash('elsewhere/index.html', files('elsewhere/'));
  assert.equal(prototypeHash('prototypes/x/index.html', files('prototypes/x/')), moved, 'moving the whole directory keeps the hash');
  const renamed = new Map([...files('prototypes/x/')].map(([key, value]) => [key.replace('a.css', 'c.css'), value]));
  assert.notEqual(prototypeHash('prototypes/x/index.html', renamed), moved, 'renaming a file changes the hash');
  const root = new Map([['index.html', Buffer.from('<p>hi</p>')], ['manifest.json', Buffer.from('{"v":1}')]]);
  const rootChangedManifest = new Map([['index.html', Buffer.from('<p>hi</p>')], ['manifest.json', Buffer.from('{"v":2}')]]);
  assert.equal(prototypeHash('index.html', root), prototypeHash('index.html', rootChangedManifest), 'a root prototype ignores the manifest');
  const records = computeScreenRecords({ sections: [{ items: [{ id: 'p', kind: 'prototype', src: 'index.html', title: 'P' }], type: 'screens' }] }, root);
  assert.deepEqual(records.map((record) => [record.screenId, record.kind, record.src, record.directionId]), [['p', 'prototype', 'index.html', null]]);
});

// ---------------------------------------------------------------------------
// Path rules used by the review origin
// ---------------------------------------------------------------------------

test('path helpers: content types come from extensions only, and served paths are normalized strictly', () => {
  assert.equal(contentTypeForPath('a/b/INDEX.HTML'), 'text/html; charset=utf-8');
  assert.equal(contentTypeForPath('a/b/app.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeForPath('a/b/font.woff2'), 'font/woff2');
  assert.equal(contentTypeForPath('a/b/run.exe'), null);
  assert.equal(contentTypeForPath('a/b/.htaccess'), null);
  assert.equal(checkPackagePath('a/b/c.png'), null);
  assert.equal(checkPackagePath('LPT1.txt').code, 'path_invalid');
  assert.equal(normalizeServedPath(['prototypes', 'booking', 'index.html']), 'prototypes/booking/index.html');
  assert.equal(normalizeServedPath(['screens', 'booking%20home.png']), 'screens/booking home.png');
  assert.equal(normalizeServedPath(['..', 'manifest.json']), null);
  assert.equal(normalizeServedPath(['%2e%2e', 'manifest.json']), null);
  assert.equal(normalizeServedPath(['a%2Fb.png']), null);
  assert.equal(normalizeServedPath(['a%5Cb.png']), null);
  assert.equal(normalizeServedPath(['%E0%A4%A']), null);
  assert.equal(normalizeServedPath(['']), null);
});
