import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProjectBriefMarkdown,
  createEditableProjectBriefState,
  formatProjectBriefListMarkdown,
  parseProjectBriefListMarkdown,
  projectBriefHasAnyContent,
  serializeEditableProjectBrief,
} from '../src/lib/projects/project-brief.js';

test('buildProjectBriefMarkdown prefers structured brief sections over a legacy short narrative', () => {
  const markdown = buildProjectBriefMarkdown({
    narrative: 'Legacy short summary.',
    objective: 'Keep the short description separate from the rich brief.',
    requirements: ['Render the rich brief from structured fields.'],
    stakeholders: ['Executive Sponsor'],
  });

  assert.match(markdown, /## Objective/);
  assert.match(markdown, /## Project Requirements/);
  assert.doesNotMatch(markdown, /^Legacy short summary\.$/);
});

test('buildProjectBriefMarkdown falls back to narrative when structured fields are empty', () => {
  assert.equal(
    buildProjectBriefMarkdown({
      narrative: 'Legacy short summary.',
    }),
    'Legacy short summary.',
  );
});

test('serializeEditableProjectBrief keeps only editable structured brief fields', () => {
  const editable = serializeEditableProjectBrief(createEditableProjectBriefState({
    committedAt: '2026-05-27T12:46:09.789Z',
    name: 'Launch Readiness',
    narrative: 'Legacy short summary.',
    objective: 'Separate the rich brief from the short description.',
    requirements: ['Render the committed rich brief across reloads.'],
    sourceSessionId: 'session-123',
  }));

  assert.deepEqual(editable, {
    assumptions: [],
    benefits: '',
    constraints: [],
    currentState: '',
    dependencies: [],
    implementationEffort: '',
    name: 'Launch Readiness',
    objective: 'Separate the rich brief from the short description.',
    proposedSolution: '',
    requirements: ['Render the committed rich brief across reloads.'],
    stakeholders: [],
    successMetrics: [],
  });
});

test('formatProjectBriefListMarkdown renders list fields as markdown bullets for the rich editor', () => {
  assert.equal(
    formatProjectBriefListMarkdown([
      'Executive Sponsor',
      'Platform Lead',
    ]),
    '- Executive Sponsor\n- Platform Lead',
  );
});

test('parseProjectBriefListMarkdown reads bullet and paragraph markdown back into list values', () => {
  assert.deepEqual(
    parseProjectBriefListMarkdown('- Executive Sponsor\n- Platform Lead'),
    ['Executive Sponsor', 'Platform Lead'],
  );
  assert.deepEqual(
    parseProjectBriefListMarkdown('Executive Sponsor\n\nPlatform Lead'),
    ['Executive Sponsor', 'Platform Lead'],
  );
});

test('projectBriefHasAnyContent ignores the redundant brief name when no other rich brief content exists', () => {
  assert.equal(
    projectBriefHasAnyContent({
      name: 'Launch Readiness',
    }),
    false,
  );
});
