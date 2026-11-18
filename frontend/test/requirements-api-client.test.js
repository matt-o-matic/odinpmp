import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createApiClient, requirementsPath } from '../src/lib/api/client.js';

async function capture(run) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ body: options.body ? JSON.parse(options.body) : undefined, method: options.method, url: String(url) });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
  try {
    await run(createApiClient({ baseUrl: 'http://localhost:3001' }));
  } finally {
    globalThis.fetch = previousFetch;
  }
  return calls.map((call) => ({ ...call, url: call.url.replace('http://localhost:3001', '') }));
}

test('requirements API methods follow the API routes', async () => {
  const calls = await capture(async (client) => {
    await client.getRequirementsOverview('p1', 'token');
    await client.getRequirementsMyItems('p1', 'token');
    await client.listRequirementsTopics('p1', 'experience', { include: 'summaries', q: 'price', view: 'open' }, 'token');
    await client.createRequirementsTopic('p1', 'architecture', { prompt: 'Q?' }, 'token');
    await client.draftRequirementsQuestions('p1', 'experience', 'token');
    await client.getRequirementsTopic('p1', 't/1', 'token');
    await client.updateRequirementsTopic('p1', 't1', { status: 'dismissed' }, 'token');
    await client.deleteRequirementsTopic('p1', 't1', 'token');
    await client.moveRequirementsTopic('p1', 't1', 'architecture', 'token');
    await client.commentRequirementsTopic('p1', 't1', { body: 'Hi', parentCommentId: 'c1' }, 'token');
    await client.updateRequirementsTopicComment('p1', 't1', 'c1', { body: 'Edit' }, 'token');
    await client.deleteRequirementsTopicComment('p1', 't1', 'c1', 'token');
    await client.voteRequirementsTopicComment('p1', 't1', 'c1', { vote: 'up' }, 'token');
    await client.recordRequirementsDecision('p1', { topicId: 't1' }, 'token');
    await client.updateRequirementsDecision('p1', 'd1', { version: 2 }, 'token');
    await client.listRequirementsDecisions('p1', 'experience', { kind: 'preference' }, 'token');
    await client.listRequirementsPreferences('p1', 'experience', 'token');
    await client.acceptRequirementsPreference('p1', { key: 'k' }, 'token');
    await client.listRequirementsLinks('p1', 'token');
    await client.createRequirementsLink('p1', { stakeholderId: 's1' }, 'token');
    await client.revokeRequirementsLink('p1', 'l1', 'token');
    await client.extendRequirementsLink('p1', 'l1', { until: '2026-12-01T00:00:00.000Z' }, 'token');
    await client.refreshRequirementsTopicSummary('p1', 't1', 'token');
    await client.getRequirementsTopicSummaryHistory('p1', 't1', 'token');
    await client.listRequirementsPackages('p1', 'experience', 'token');
    await client.getRequirementsPackage('p1', 'pkg/1', 'token');
    await client.getRequirementsPackageGrant('p1', 'pkg1', 'token');
    await client.withdrawRequirementsPackage('p1', 'pkg1', 'token');
    await client.createRequirementsPackageUploadUrl('p1', 'architecture', 'token');
  });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET /api/projects/p1/requirements',
    'GET /api/projects/p1/requirements/my-items',
    'GET /api/projects/p1/requirements/tracks/experience/topics?view=open&q=price&include=summaries',
    'POST /api/projects/p1/requirements/tracks/architecture/topics',
    'POST /api/projects/p1/requirements/tracks/experience/draft-questions',
    'GET /api/projects/p1/requirements/topics/t%2F1',
    'PATCH /api/projects/p1/requirements/topics/t1',
    'DELETE /api/projects/p1/requirements/topics/t1',
    'POST /api/projects/p1/requirements/topics/t1/move',
    'POST /api/projects/p1/requirements/topics/t1/comments',
    'PATCH /api/projects/p1/requirements/topics/t1/comments/c1',
    'DELETE /api/projects/p1/requirements/topics/t1/comments/c1',
    'POST /api/projects/p1/requirements/topics/t1/comments/c1/vote',
    'POST /api/projects/p1/requirements/decisions',
    'PATCH /api/projects/p1/requirements/decisions/d1',
    'GET /api/projects/p1/requirements/tracks/experience/decisions?kind=preference',
    'GET /api/projects/p1/requirements/tracks/experience/preferences',
    'POST /api/projects/p1/requirements/preferences/accept',
    'GET /api/projects/p1/requirements/links',
    'POST /api/projects/p1/requirements/links',
    'POST /api/projects/p1/requirements/links/l1/revoke',
    'POST /api/projects/p1/requirements/links/l1/extend',
    'POST /api/projects/p1/requirements/topics/t1/summary/refresh',
    'GET /api/projects/p1/requirements/topics/t1/summary/history',
    'GET /api/projects/p1/requirements/packages?track=experience',
    'GET /api/projects/p1/requirements/packages/pkg%2F1',
    'GET /api/projects/p1/requirements/packages/pkg1/grant',
    'DELETE /api/projects/p1/requirements/packages/pkg1',
    'POST /api/projects/p1/requirements/packages/upload-urls',
  ]);
  assert.deepEqual(calls.at(-1).body, { track: 'architecture' });
  assert.deepEqual(calls[8].body, { track: 'architecture' });
  assert.deepEqual(calls[9].body, { body: 'Hi', parentCommentId: 'c1' });
  assert.equal(requirementsPath('a b', '/x'), '/api/projects/a%20b/requirements/x');
});

test('a package upload sends the zip as the raw body with the zip content type', async () => {
  const previousFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ body: options.body, contentType: options.headers['Content-Type'], method: options.method, url: String(url) });
    if (seen.length === 1) return { ok: true, status: 201, async json() { return { ok: true, package: { id: 'pkg-3', version: 3 } }; } };
    return { ok: false, status: 422, async json() { return { errors: [{ code: 'zip_invalid', file: '', message: 'Not a zip.', path: '' }], ok: false, status: 'rejected', warnings: [] }; } };
  };
  try {
    const client = createApiClient({ baseUrl: 'http://localhost:3001' });
    const file = new Blob(['PK'], { type: 'application/zip' });
    const accepted = await client.uploadRequirementsPackage('p1', 'experience', file, 'token');
    assert.deepEqual(accepted, { ok: true, package: { id: 'pkg-3', version: 3 } });
    assert.equal(seen[0].url, 'http://localhost:3001/api/projects/p1/requirements/packages/upload?track=experience');
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].contentType, 'application/zip');
    assert.equal(seen[0].body, file);
    await assert.rejects(client.uploadRequirementsPackage('p1', 'experience', file, 'token'), (error) => {
      assert.equal(error.status, 422);
      assert.equal(error.data.errors[0].code, 'zip_invalid');
      return true;
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('the Requirements tab and its child routes are wired into the project page', () => {
  const router = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8');
  for (const name of ['project-requirements', 'project-requirements-links', 'project-requirements-topic', 'project-requirements-track', 'project-requirements-package']) {
    assert.match(router, new RegExp(`name: '${name}'`));
  }
  assert.match(router, /path: '\/projects\/:projectId\/requirements',\s*component: ProjectDetailView/);
  assert.match(router, /':track\(experience\|architecture\)\/:stage\(brief\|discuss\|decide\|plan\)\?'/);
  // Review is project-wide: its own tab and pages, with the old per-track paths redirected.
  assert.match(router, /path: 'review', name: 'project-requirements-review'/);
  assert.match(router, /path: 'review\/packages\/:packageId'/);
  assert.match(router, /path: ':track\(experience\|architecture\)\/review\/:rest\(\.\*\)\*'/);

  const detail = readFileSync(new URL('../src/views/ProjectDetailView.vue', import.meta.url), 'utf8');
  assert.match(detail, /startsWith\('project-requirements'\)/);
  assert.match(detail, /:to="\{ name: 'project-requirements', params: \{ projectId: project\.id \} \}"/);
  assert.match(detail, /<RequirementsWorkspace/);
});

test('requirements views never label work as AI-drafted, and the summary is "Odin summary"', () => {
  const files = [
    '../src/components/requirements/RequirementsSummaryPanel.vue',
    '../src/components/requirements/RequirementsRegister.vue',
    '../src/components/requirements/RequirementsDecisionBox.vue',
    '../src/components/requirements/RequirementsDecideStage.vue',
    '../src/views/requirements/ProjectRequirementsTopicView.vue',
    '../src/views/requirements/ProjectRequirementsMyItemsView.vue',
    '../src/views/requirements/ProjectRequirementsPackageView.vue',
    '../src/components/requirements/RequirementsReviewStage.vue',
    '../src/components/requirements/RequirementsPackageScreens.vue',
  ].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'));
  for (const source of files) {
    assert.doesNotMatch(source, /AI proposal|drafted by AI|AI-drafted|AI-generated|not a decision/i);
  }
  assert.match(files[0], />Odin summary</);
});
