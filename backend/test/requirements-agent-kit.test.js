import assert from 'node:assert/strict';
import test from 'node:test';

import JSZip from 'jszip';

import { renderAgentBrief } from '../src/modules/requirements/requirements-agent-brief.js';
import { validateReviewPackage } from '../src/modules/requirements/packages/package-validator.js';
import { createRequirementsTestApp, PROJECT_ID } from './helpers/requirements-test-app.js';

function binary(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

test('the agent brief names this project and version, and lists topics from both tracks: review is project-wide', async () => {
  const harness = await createRequirementsTestApp();
  const experience = await harness.createTopic({ prompt: 'Where should the price first appear?' });
  const architecture = await harness.createTopic({ prompt: 'Which queue carries reminders?' }, { track: 'architecture' });

  const response = await harness.as('viewer').get('/review/agent-brief');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { markdown } = response.body;
  assert.match(markdown, /^# Review package task: Client booking$/m);
  assert.ok(markdown.includes(`Project id: \`${PROJECT_ID}\``));
  assert.ok(markdown.includes('"track": "experience"'));
  assert.ok(markdown.includes('No review rounds yet: leave `basedOnRoundId` out.'));
  assert.ok(markdown.includes('This upload becomes version 1'));
  assert.ok(markdown.includes(`\`${experience.id}\`: Where should the price first appear? (Experience, open)`));
  assert.ok(markdown.includes(`\`${architecture.id}\`: Which queue carries reminders? (Functional, open)`), 'questions may settle topics on either track');
  assert.ok(markdown.includes('node validate.mjs <package.zip or folder> --track experience'));
  // The older per-track address returns the same project brief.
  assert.equal((await harness.as('viewer').get('/tracks/architecture/agent-brief')).body.markdown, markdown);

  assert.equal((await harness.as('outsider').get('/tracks/experience/agent-brief')).status, 404);
  assert.equal((await harness.as('viewer').get('/tracks/elsewhere/agent-brief')).status, 404);
});

test('the agent brief points at the latest round and caps a long topic list', () => {
  const topics = Array.from({ length: 65 }, (_, index) => ({ id: `t-${index}`, prompt: `Question ${index}`, state: 'open' }));
  topics[0].decision = { statement: 'Show a range.' };
  const markdown = renderAgentBrief({
    latestRound: { id: 'round-7', number: 3, status: 'closed' },
    nextVersion: 4,
    project: { id: 'p1', name: 'Booking' },
    topics,
  });
  assert.ok(markdown.includes('set `"basedOnRoundId": "round-7"`'));
  assert.ok(markdown.includes('version 4'));
  assert.ok(markdown.includes('`t-0`: Question 0 (decided: Show a range.)'));
  assert.ok(markdown.includes('`t-59`'));
  assert.equal(markdown.includes('`t-60`'), false);
  assert.ok(markdown.includes('…and 5 more.'));
});

test('the package kit downloads with the guide, spec, validator, and examples that validate', async () => {
  const harness = await createRequirementsTestApp();
  const response = await harness.as('viewer').get('/packages/kit').buffer(true).parse(binary);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/zip');
  assert.match(response.headers['content-disposition'], /odin-review-package-kit\.zip/);

  const zip = await JSZip.loadAsync(response.body);
  for (const name of ['README.md', 'package-spec.md', 'review-package.schema.json', 'validate.mjs', 'package.json', 'validator/package-validator.js', 'examples/fieldwork-round-2/manifest.json']) {
    assert.ok(zip.file(name), `${name} is in the kit`);
  }
  assert.equal(zip.file('examples/scheduling-options/manifest.json'), null, 'the kit carries only the example with screens');
  assert.equal(Object.keys(zip.files).some((name) => name.includes('screens-src')), false);
  const pkg = JSON.parse(await zip.file('package.json').async('string'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['ajv', 'htmlparser2', 'jszip']);

  // The kit's example passes the same checks as the kit's validator; topic ids need a project.
  const entries = [];
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir || !name.startsWith('examples/fieldwork-round-2/')) continue;
    entries.push({ bytes: await file.async('nodebuffer'), isDirectory: false, isSymlink: false, path: name.slice('examples/fieldwork-round-2/'.length) });
  }
  const result = await validateReviewPackage({ entries }, { mermaid: null, track: 'experience' });
  assert.equal(result.status, 'accepted', JSON.stringify(result.errors));

  assert.equal((await harness.as('outsider').get('/packages/kit')).status, 404);
});
