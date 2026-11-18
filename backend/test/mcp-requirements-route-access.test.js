import assert from 'node:assert/strict';
import test from 'node:test';
import { requireMcpRouteAccess } from '../src/mcp/route-access.js';

// The MCP route allowlist for requirements (Q-07): reads for the context and feedback tools,
// the upload-URL request, topic administration, topic decisions, publishing rounds and
// changing their reviewers, and nothing that closes a round, edits a decision, accepts,
// approves, proposes or reviews. The end-to-end
// proof through the MCP dispatcher is in mcp-requirements-e2e.test.js and
// mcp-requirements-topics-e2e.test.js. Topic saves and emailed stakeholder links are covered
// by mcp-collaboration-route-access.test.js.

const PROJECT = 'project-1';
const REQ = `/api/projects/${PROJECT}/requirements`;
const ROUND = '0b7f3c2e-4f7a-4a51-9c8e-1d2b3c4d5e6f';
const readWrite = { projectIds: [], scopes: ['projects.read', 'projects.write'] };
const readOnly = { projectIds: [], scopes: ['projects.read'] };

function check(method, originalUrl, grant = readWrite, body = undefined) {
  try {
    requireMcpRouteAccess({ body, method, originalUrl }, grant);
    return 'allowed';
  } catch (error) {
    return `${error.statusCode} ${error.message}`;
  }
}

const ALLOWED_READS = [
  REQ,
  `${REQ}/tracks/experience/topics?include=summaries`,
  `${REQ}/tracks/architecture/topics`,
  `${REQ}/tracks/experience/decisions`,
  `${REQ}/rounds?track=experience`,
  `${REQ}/rounds/${ROUND}/results`,
  `${REQ}/rounds/${ROUND}/feedback?limit=50&cursor=bzoyMDA`,
  `${REQ}/packages?track=architecture`,
  `${REQ}/packages/uploads/${ROUND}`,
  `${REQ}/plans?track=experience`,
];

test('requirements reads used by the MCP tools are allowed for read grants', () => {
  for (const url of ALLOWED_READS) {
    assert.equal(check('GET', url, readOnly), 'allowed', url);
    assert.equal(check('GET', url, readWrite), 'allowed', url);
  }
});

test('upload URLs, topic administration and topic decisions are the requirements writes, and they need projects.write', () => {
  const writes = [
    ['POST', `${REQ}/packages/upload-urls`, { track: 'experience' }],
    ['POST', `${REQ}/tracks/experience/topics`, { prompt: 'Which payment methods?' }],
    ['POST', `${REQ}/tracks/architecture/topics`, { assignments: [], prompt: 'Which queue?' }],
    ['DELETE', `${REQ}/topics/topic-1`, undefined],
    ['POST', `${REQ}/topics/topic-1/move`, { track: 'architecture' }],
    ['POST', `${REQ}/topics/topic-1/comments`, { body: 'Agreed, @[Ada Admin](user:user-admin) to confirm.' }],
    ['POST', `${REQ}/decisions`, { outcome: 'agreed', statement: 'Cards only.', topicId: 'topic-1' }],
    ['POST', `${REQ}/decisions`, { outcome: 'decided', statement: 'Cards only.', topicId: 'topic-1' }],
    ['POST', `${REQ}/decisions`, { outcome: 'deferred', statement: 'After launch.', topicId: 'topic-1' }],
  ];
  for (const [method, url, body] of writes) {
    assert.equal(check(method, url, readWrite, body), 'allowed', `${method} ${url}`);
    assert.equal(check(method, url, readOnly, body), '403 The MCP grant lacks the required scope.', `${method} ${url}`);
  }
  assert.equal(check('GET', `${REQ}/topics/topic-1/summary/history?limit=10`, readOnly), 'allowed');
});

test('a new topic carries no people, a comment tags no stakeholder, and a decision has a real outcome', () => {
  const denied = [
    ['POST', `${REQ}/tracks/experience/topics`, { assignments: [{ actorId: 's-1', actorType: 'stakeholder' }], prompt: 'Which payment methods?' }],
    ['POST', `${REQ}/tracks/experience/topics`, { assignments: 'all', prompt: 'Which payment methods?' }],
    ['POST', `${REQ}/topics/topic-1/comments`, { body: 'Over to @[Sam Stakeholder](stakeholder:s-1).' }],
    ['POST', `${REQ}/topics/topic-1/comments`, { body: 'Ask @[Ada](user:user-admin) and @[Sam](stakeholder:s-1).' }],
    ['POST', `${REQ}/topics/topic-1/comments`, { body: 'Ask @[Sam](person:abc123).' }],
    ['POST', `${REQ}/topics/topic-1/comments`, {}],
    ['POST', `${REQ}/decisions`, { outcome: 'superseded', statement: 'Gone.', topicId: 'topic-1' }],
    ['POST', `${REQ}/decisions`, { statement: 'No outcome.', topicId: 'topic-1' }],
  ];
  for (const [method, url, body] of denied) {
    assert.equal(check(method, url, readWrite, body), '403 This operation is outside the MCP grant.', JSON.stringify(body));
  }
});

test('a grant publishes a round and changes its reviewers, but never closes the open round while publishing', () => {
  const reviewers = [{ actorId: 'stakeholder-1', actorType: 'stakeholder', required: true }];
  for (const [method, url, body] of [
    ['POST', `${REQ}/rounds`, { packageId: 'package-1', reviewers }],
    ['PATCH', `${REQ}/rounds/${ROUND}`, { addReviewers: reviewers }],
    ['PATCH', `${REQ}/rounds/${ROUND}`, { removeReviewerIds: ['reviewer-1'], dueAt: null }],
  ]) {
    assert.equal(check(method, url, readWrite, body), 'allowed', `${method} ${url}`);
    assert.equal(check(method, url, readOnly, body), '403 The MCP grant lacks the required scope.', `${method} ${url}`);
  }
  assert.equal(check('GET', `${REQ}/rounds/${ROUND}`, readOnly), 'allowed');
  assert.equal(check('POST', `${REQ}/rounds`, readWrite, { closePrevious: { outcome: 'abandoned' }, packageId: 'package-1', reviewers }), '403 This operation is outside the MCP grant.');
});

test('closing, editing decisions, accepting, approving, proposing and reviewing routes are outside every MCP grant', () => {
  const denied = [
    // Rounds: close, resend, refresh, and every review write.
    ['POST', `${REQ}/rounds/${ROUND}/close`],
    ['POST', `${REQ}/rounds/${ROUND}/reviewers/reviewer-1/resend`],
    ['POST', `${REQ}/rounds/${ROUND}/summary/refresh`],
    ['PUT', `${REQ}/rounds/${ROUND}/review/screens/home/verdict`],
    ['PUT', `${REQ}/rounds/${ROUND}/review/directions/action-first`],
    ['PUT', `${REQ}/rounds/${ROUND}/review/questions/price/answer`],
    ['PUT', `${REQ}/rounds/${ROUND}/review/annotations/${ROUND}`],
    ['POST', `${REQ}/rounds/${ROUND}/review/annotations/${ROUND}/comments`],
    ['POST', `${REQ}/rounds/${ROUND}/review/snapshots?screenId=home`],
    ['POST', `${REQ}/rounds/${ROUND}/review/submit`],
    // Decision edits, preferences, plans and proposed work.
    ['PATCH', `${REQ}/decisions/decision-1`],
    ['POST', `${REQ}/preferences/accept`],
    ['POST', `${REQ}/plans/experience/draft`],
    ['PATCH', `${REQ}/plans/plan-1`],
    ['POST', `${REQ}/plans/plan-1/approve`],
    ['POST', `${REQ}/plans/plan-1/propose-work`],
    // AI drafting, summary refreshes and comment votes. Editing and deleting one's own
    // comment, and My items, are admitted by access/files.js (mcp-file-route-access.test.js).
    ['POST', `${REQ}/tracks/experience/draft-questions`],
    ['POST', `${REQ}/topics/topic-1/summary/refresh`],
    ['POST', `${REQ}/topics/topic-1/comments/comment-1/vote`],
    ['PUT', `${REQ}/topics/topic-1/comments/comment-1`],
    ['PATCH', `${REQ}/topics/topic-1/comments`],
    ['GET', `${REQ}/topics/topic-1/mentionables`],
    ['POST', `${REQ}/tracks/other/topics`],
    ['POST', `${REQ}/topics/topic-1/move/extra`],
    // Packages other than the upload URL: raw upload, withdrawal.
    ['POST', `${REQ}/packages/upload?track=experience`],
    ['DELETE', `${REQ}/packages/package-1`],
    // Reads the tools do not use stay closed too.
    ['POST', `${REQ}/my-items`],
    ['GET', `${REQ}/tracks/experience/preferences`],
    ['GET', `${REQ}/rounds/${ROUND}/review`],
    ['GET', `${REQ}/rounds/${ROUND}/snapshots/${ROUND}`],
    ['GET', `${REQ}/packages/package-1`],
    ['GET', `${REQ}/packages/package-1/grant`],
    ['GET', `${REQ}/plans/plan-1`],
    ['GET', `${REQ}/events`],
    // Shapes the patterns must not stretch to cover.
    ['GET', `${REQ}/tracks/other/topics`],
    ['GET', `${REQ}/`],
    ['GET', `${REQ}/rounds/${ROUND}/feedback/extra`],
    ['PUT', `${REQ}/packages/upload-urls`],
    ['GET', `${REQ}/packages/upload-urls`],
    ['HEAD', `${REQ}/rounds`],
    ['PUT', `/api/public/requirements-uploads/odin_pkgup_token`],
    ['GET', `/api/public/requirements/portal-token`],
  ];
  for (const [method, url] of denied) {
    assert.equal(check(method, url), '403 This operation is outside the MCP grant.', `${method} ${url}`);
  }
});

test('project-restricted grants reach requirements routes only for their projects', () => {
  const restricted = { projectIds: [PROJECT], scopes: ['projects.read', 'projects.write'] };
  assert.equal(check('GET', `${REQ}/rounds?track=experience`, restricted), 'allowed');
  assert.equal(check('POST', `${REQ}/packages/upload-urls`, restricted), 'allowed');
  for (const [method, url] of [['GET', '/api/projects/project-2/requirements'], ['POST', '/api/projects/project-2/requirements/packages/upload-urls'], ['GET', '/api/projects/project-2/requirements/rounds/r/feedback']]) {
    assert.equal(check(method, url, restricted), '404 Project not found.', `${method} ${url}`);
  }
});
