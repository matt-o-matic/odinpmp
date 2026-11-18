import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PACKAGE_MAX_BYTES,
  checkPackageFile,
  describePackageChanges,
  describePackageProblem,
  describeUploadRejection,
  feedbackDimensionLabels,
  formatBytes,
  manifestSections,
  packageChecklist,
  packageMetaLine,
  packageSourceText,
  packageStatusChip,
  problemCodeMeaning,
  questionKindLabel,
  screenChangeChip,
  sortPackages,
  uploadPercent,
  uploadUrlCommand,
} from '../src/lib/requirements/requirements-packages.js';

const MB = 1024 * 1024;

test('the upload size check allows up to 50 MB and explains anything larger', () => {
  assert.equal(PACKAGE_MAX_BYTES, 50 * MB);
  assert.deepEqual(checkPackageFile({ name: 'round-3.zip', size: 50 * MB, type: 'application/zip' }), { ok: true });
  const over = checkPackageFile({ name: 'round-3.zip', size: 50 * MB + 1, type: 'application/zip' });
  assert.equal(over.ok, false);
  assert.equal(over.message, 'round-3.zip is 50 MB. Packages can be up to 50 MB.');
  assert.equal(checkPackageFile({ name: 'big.zip', size: 63.2 * MB, type: '' }).message, 'big.zip is 63 MB. Packages can be up to 50 MB.');
  assert.equal(checkPackageFile({ name: 'small.zip', size: 2 * MB }, { maxBytes: MB }).ok, false);
});

test('the upload check wants a non-empty zip', () => {
  assert.equal(checkPackageFile(null).message, 'Choose a package zip to upload.');
  assert.equal(checkPackageFile({ name: 'empty.zip', size: 0, type: 'application/zip' }).message, 'empty.zip is empty.');
  assert.match(checkPackageFile({ name: 'notes.txt', size: 10, type: 'text/plain' }).message, /^notes\.txt is not a zip\./);
  // A browser may report a zip as octet-stream; the name decides then.
  assert.equal(checkPackageFile({ name: 'pkg.ZIP', size: 10, type: 'application/octet-stream' }).ok, true);
  assert.equal(checkPackageFile({ name: 'pkg.bin', size: 10, type: 'application/octet-stream' }).ok, false);
  assert.equal(checkPackageFile({ name: 'pkg', size: 10, type: 'application/x-zip-compressed' }).ok, true);
});

test('sizes and progress read as people expect', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(4.2 * MB), '4.2 MB');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(-1), '');
  assert.equal(uploadPercent(25, 100), 25);
  assert.equal(uploadPercent(150, 100), 100);
  assert.equal(uploadPercent(10, 0), null);
});

test('every validation code from the spec has a plain-words meaning', () => {
  const codes = [
    'zip_invalid', 'zip_limit', 'path_invalid', 'type_not_allowed', 'scan_failed', 'manifest_missing', 'manifest_invalid',
    'track_mismatch', 'missing_file', 'reference_invalid', 'duplicate_id', 'external_url', 'mermaid_invalid',
    'unknown_field', 'size_mismatch', 'stale_base_round',
  ];
  const fallback = problemCodeMeaning('something_new');
  for (const code of codes) {
    const meaning = problemCodeMeaning(code);
    assert.notEqual(meaning, fallback, code);
    assert.doesNotMatch(meaning, /_/, `${code} reads as words, not a code`);
  }
  assert.equal(problemCodeMeaning('missing_file'), 'The manifest names a file that is not in the zip. Paths are case-sensitive.');
  assert.equal(fallback, 'Odin could not accept this part of the package.');
});

test('a problem names its file and JSON Pointer, or the zip as a whole', () => {
  const missing = describePackageProblem({ code: 'missing_file', file: 'manifest.json', message: 'screens/confirm.png is not in the package.', path: '/sections/3/items/1/src' });
  assert.deepEqual(missing.location, { file: 'manifest.json', path: '/sections/3/items/1/src', text: 'manifest.json at /sections/3/items/1/src' });
  assert.equal(missing.message, 'screens/confirm.png is not in the package.');
  assert.equal(describePackageProblem({ code: 'zip_limit', file: '', path: '' }).location.text, 'The zip as a whole');
  assert.equal(describePackageProblem({ code: 'external_url', file: 'prototypes/a/index.html', path: '' }).location.text, 'prototypes/a/index.html');
});

test('a rejected upload lists every error and warning with a summary', () => {
  const rejection = describeUploadRejection({
    errors: [
      { code: 'missing_file', file: 'manifest.json', message: 'screens/confirm.png is not in the package.', path: '/sections/3/items/1/src' },
      { code: 'external_url', file: 'prototypes/booking/index.html', message: 'https://cdn.example.com/x.js', path: '' },
    ],
    ok: false,
    status: 'rejected',
    warnings: [{ code: 'unknown_field', file: 'manifest.json', message: 'Unknown field "theme" was ignored.', path: '/theme' }],
  }, { fileName: 'round-3.zip' });
  assert.equal(rejection.errors.length, 2);
  assert.equal(rejection.warnings.length, 1);
  assert.equal(rejection.summary, 'round-3.zip was not uploaded. Odin found 2 problems, and nothing was stored. Fix them and upload the zip again.');
  assert.equal(describeUploadRejection({ errors: [{ code: 'zip_limit' }] }).summary, 'The package was not uploaded. Odin found 1 problem, and nothing was stored. Fix it and upload the zip again.');
});

test('package rows show status, source, the uploader by name, and drafts first', () => {
  assert.deepEqual(packageStatusChip('draft'), { label: 'Draft', tone: 'exp' });
  assert.deepEqual(packageStatusChip('withdrawn'), { label: 'Withdrawn', tone: 'neutral' });
  assert.equal(packageSourceText('mcp'), 'uploaded through MCP');
  assert.equal(packageSourceText('ui'), 'uploaded in Odin');
  assert.equal(packageMetaLine({ fileCount: 38, sizeBytes: 4.2 * MB, source: 'mcp', uploader: { name: 'Dana Cho' } }), 'Dana Cho · uploaded through MCP · 4.2 MB · 38 files');
  assert.equal(packageMetaLine({ source: 'ui', uploader: { name: null } }), 'a team member · uploaded in Odin');
  const sorted = sortPackages([
    { id: 'a', status: 'published', version: 2 },
    { id: 'b', status: 'withdrawn', version: 4 },
    { id: 'c', status: 'draft', version: 3 },
    { id: 'd', status: 'draft', version: 5 },
    { id: 'e', status: 'published', version: 1 },
  ]);
  assert.deepEqual(sorted.map((pkg) => pkg.id), ['d', 'c', 'a', 'e', 'b']);
});

test('the changes list leads with what needs attention and names the baseline round', () => {
  const described = describePackageChanges({
    baseline: { packageId: 'p2', roundId: 'r2', roundNumber: 2, title: 'Round 2', version: 2 },
    counts: { changed: 1, new: 1, removed: 1, unchanged: 1 },
    screens: [
      { change: 'unchanged', screenId: 'pick-time', title: 'Pick a time' },
      { change: 'changed', screenId: 'home', title: 'Booking home' },
      { change: 'new', screenId: 'reschedule', title: 'Reschedule' },
      { change: 'removed', screenId: 'price', title: null },
      { change: 'bogus', screenId: 'x', title: 'X' },
    ],
  });
  assert.equal(described.heading, 'What changed since round 2');
  assert.deepEqual(described.rows.map((row) => [row.screenId, row.chip.label]), [
    ['home', 'changed'],
    ['reschedule', 'new'],
    ['price', 'removed'],
    ['pick-time', 'carried'],
  ]);
  assert.equal(described.rows[2].title, 'price', 'a removed screen without a title falls back to its id');
  assert.match(described.rows[0].detail, /Outdated/);
  assert.match(described.rows[2].detail, /Superseded/);
  assert.equal(described.summary, '1 changed · 1 new · 1 removed · 1 carried, compared with version 2.');
});

test('without a round, the changes list compares with the previous version; the first package has nothing to compare', () => {
  assert.equal(describePackageChanges({ baseline: { roundNumber: null, version: 3 }, counts: {}, screens: [] }).heading, 'What changed since version 3');
  const first = describePackageChanges({ baseline: null, counts: { new: 2 }, screens: [{ change: 'new', screenId: 'a' }] });
  assert.equal(first.rows.length, 0);
  assert.match(first.summary, /first package in this track/);
  assert.deepEqual(screenChangeChip('unchanged'), { label: 'carried', tone: 'ok' });
  assert.equal(screenChangeChip('nope'), null);
});

const MANIFEST = {
  feedbackDimensions: ['type', { id: 'tone', label: 'Tone of voice' }],
  schema: 'odin.review-package/v1',
  sections: [
    { body: 'Why', id: 'ctx', type: 'context' },
    { id: 'dirs', items: [{ id: 'a', summary: 'A', title: 'Action first' }, { id: 'b', summary: 'B', title: 'Schedule first' }], type: 'directions' },
    { id: 'screens', items: [{ id: 'home', kind: 'image' }, { id: 'home-2', kind: 'image' }, { id: 'flow', kind: 'prototype' }], type: 'screens' },
    { id: 'flows', items: [{ id: 'f', mermaid: 'flowchart TD\n a --> b', title: 'F' }], type: 'flows' },
    { id: 'qs', items: [{ id: 'q1', kind: 'single', topicId: 't1' }, { id: 'q2', kind: 'text' }, { id: 'q3', kind: 'scale', scale: { max: 5, min: 1 }, topicId: 't2' }], title: 'Ask', type: 'questions' },
    { id: 'odd', type: 'theme' },
  ],
  summary: 'Round 3',
  title: 'Booking',
  track: 'experience',
};

test('the checklist reports what passed and every stored warning', () => {
  const items = packageChecklist({
    manifest: MANIFEST,
    track: 'experience',
    warnings: [{ code: 'unknown_field', file: 'manifest.json', message: 'Unknown field "theme" was ignored.', path: '/theme' }],
  });
  assert.deepEqual(items.map((item) => item.text), [
    'Manifest odin.review-package/v1, track Experience',
    '3 screens (2 images, 1 prototype) · 2 directions · 1 flow',
    '3 questions: 2 linked to topics, 1 will create a new topic',
    'Every file passed the checks · no outside web addresses',
    'Unknown field "theme" was ignored.',
  ]);
  assert.equal(items.at(-1).tone, 'warn');
  assert.equal(items.at(-1).location.path, '/theme');
});

test('manifest sections keep their order and headings; unknown types are dropped', () => {
  const sections = manifestSections(MANIFEST);
  assert.deepEqual(sections.map((section) => [section.type, section.heading]), [
    ['context', 'Context'],
    ['directions', 'Directions'],
    ['screens', 'Screens'],
    ['flows', 'Flows'],
    ['questions', 'Ask'],
  ]);
  assert.equal(sections[0].anchor, 'rq-pkg-context');
  assert.deepEqual(manifestSections(null), []);
});

test('question kinds, feedback aspects, and the agent command read plainly', () => {
  assert.equal(questionKindLabel({ kind: 'single' }), 'Choose one');
  assert.equal(questionKindLabel({ kind: 'multi' }), 'Choose any');
  assert.equal(questionKindLabel({ kind: 'scale', scale: { max: 5, min: 1 } }), 'Scale 1 to 5');
  assert.deepEqual(feedbackDimensionLabels(MANIFEST, 'experience'), ['Type & size', 'Tone of voice']);
  assert.deepEqual(feedbackDimensionLabels({}, 'architecture'), ['Feasibility', 'Risk', 'Cost', 'Operability', 'Security']);
  assert.equal(uploadUrlCommand('https://odin.example/api/public/requirements-uploads/odin_pkgup_x'), 'curl -X PUT -H "Content-Type: application/zip" --data-binary @package.zip "https://odin.example/api/public/requirements-uploads/odin_pkgup_x"');
});

test('agent instructions gain the upload URL, its expiry, and the curl command', async () => {
  const { agentBriefWithUploadUrl } = await import('../src/lib/requirements/requirements-packages.js');
  const text = agentBriefWithUploadUrl('# Brief\n', { expiresAt: '2026-10-08T12:10:00.000Z', url: 'https://api.example/u/abc' });
  assert.ok(text.startsWith('# Brief\n\n## Your upload URL'));
  assert.ok(text.includes('It expires at 2026-10-08T12:10:00.000Z.'));
  assert.ok(text.includes('curl -X PUT -H "Content-Type: application/zip" --data-binary @package.zip "https://api.example/u/abc"'));
});
