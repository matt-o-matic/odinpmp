import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../src/lib/api/client.js';
import { describeRequirementsError, QUESTION_REMOVED_MESSAGE, requirementsErrorCode } from '../src/lib/requirements/requirements-errors.js';
import { canCollaborateOnProject, requirementsAbilities, showDecisionForm, workspaceMembers } from '../src/lib/requirements/requirements-permissions.js';

function apiError(status, data) {
  return new ApiError(data.error ?? 'Request failed.', { data, status });
}

test('draft-question failures map to actionable messages and retry hints', () => {
  const notConfigured = describeRequirementsError(apiError(503, { details: { code: 'ai_not_configured', message: 'Requirements AI is not configured.' }, error: 'ai_not_configured', ok: false }));
  assert.equal(notConfigured.code, 'ai_not_configured');
  assert.equal(notConfigured.retryable, false);
  assert.match(notConfigured.message, /no AI provider is set up/);

  const invalid = describeRequirementsError(apiError(502, { details: { code: 'ai_output_invalid', retryable: true }, error: 'ai_output_invalid', ok: false }));
  assert.equal(invalid.retryable, true);
  assert.match(invalid.message, /nothing was added/);

  const failed = describeRequirementsError(apiError(502, { details: { code: 'ai_request_failed', retryable: true }, error: 'ai_request_failed', ok: false }));
  assert.equal(failed.retryable, true);

  const empty = describeRequirementsError(apiError(409, { details: { code: 'brief_empty', message: 'Add a project brief first.' }, error: 'brief_empty', ok: false }));
  assert.equal(empty.code, 'brief_empty');
  assert.match(empty.message, /brief is empty/);
});

test('conflicts read the code from details or from error', () => {
  const activity = apiError(409, { details: { activity: { comments: 2 }, code: 'topic_has_activity', message: 'Ask a manager.' }, error: 'topic_has_activity' });
  assert.equal(requirementsErrorCode(activity), 'topic_has_activity');
  assert.match(describeRequirementsError(activity).message, /can’t be deleted/);

  // Round answers can exist without a topic comment; the refusal names them.
  const answered = describeRequirementsError(apiError(409, { details: { activity: { answers: 1 }, code: 'topic_has_activity' }, error: 'topic_has_activity' }));
  assert.match(answered.message, /^Reviewers already answered this topic’s question in a review round, so it can’t be deleted/);
  assert.equal(answered.retryable, false);

  const removed = describeRequirementsError(apiError(409, { details: { code: 'question_removed', message: 'Gone.' }, error: 'This question has been removed and no longer needs an answer.' }));
  assert.deepEqual([removed.code, removed.message], ['question_removed', QUESTION_REMOVED_MESSAGE]);
  assert.equal(QUESTION_REMOVED_MESSAGE, 'This question has been removed and no longer needs an answer.');

  const decision = apiError(409, { details: { activeDecisionId: 'd1', code: 'decision_exists' }, error: 'This topic already has a decision. Supersede it to record a new one.' });
  assert.equal(requirementsErrorCode(decision), 'decision_exists');
  assert.match(describeRequirementsError(decision).message, /already has a decision/);
});

test('validation, not-found, server, and unknown errors', () => {
  assert.equal(describeRequirementsError(apiError(400, { details: [{ message: 'Required', path: 'prompt' }], error: 'Invalid request payload.' })).message, 'Check prompt: Required');
  assert.equal(describeRequirementsError(apiError(404, { error: 'Project not found.' })).code, 'not_found');
  assert.equal(describeRequirementsError(apiError(400, { error: 'Choose a date in the future.' })).message, 'Choose a date in the future.');
  const server = describeRequirementsError(apiError(500, {}), 'Fallback.');
  assert.deepEqual([server.message, server.retryable], ['Fallback.', true]);
  assert.equal(describeRequirementsError(new TypeError('Failed to fetch'), 'Offline.').message, 'Offline.');
});

test('members and up collaborate; viewers only read', () => {
  assert.equal(canCollaborateOnProject({ projectRole: 'member' }), true);
  assert.equal(canCollaborateOnProject({ projectRole: 'viewer' }), false);
  assert.equal(canCollaborateOnProject({ projectRole: 'viewer', tenantRole: 'manager' }), true);
  assert.equal(canCollaborateOnProject({ canDecide: true, projectRole: 'viewer' }), true);
  assert.equal(canCollaborateOnProject({}), true);
});

test('decision-only controls follow canDecide', () => {
  const member = requirementsAbilities({ canDecide: false, projectRole: 'member' });
  assert.deepEqual(
    [member.comment, member.draftQuestions, member.deleteTopics, member.recordDecisions, member.acceptPreferences, member.manageLinks, member.changeStatus],
    [true, true, true, false, false, false, false],
  );
  const viewer = requirementsAbilities({ canDecide: false, projectRole: 'viewer' });
  assert.equal(Object.values(viewer).some(Boolean), false);
  const manager = requirementsAbilities({ canDecide: true, projectRole: 'manager' });
  assert.equal(Object.values(manager).every(Boolean), true);
});

test('server-reported abilities win over the role guess (the project detail has no caller role)', () => {
  // A viewer whose project role is unknown to the page: the role guess says member.
  const guessed = requirementsAbilities({ canDecide: false, projectRole: '' });
  assert.equal(guessed.comment, true);
  const viewer = requirementsAbilities({ canCollaborate: false, canDecide: false, canEditPlans: false, projectRole: '' });
  assert.equal(Object.values(viewer).some(Boolean), false);
  const member = requirementsAbilities({ canCollaborate: true, canDecide: false, canEditPlans: false });
  assert.deepEqual([member.comment, member.uploadPackages, member.editPlans, member.proposeWork, member.recordDecisions], [true, true, false, false, false]);
  const planner = requirementsAbilities({ canCollaborate: true, canDecide: false, canEditPlans: true, projectRole: 'member' });
  assert.deepEqual([planner.editPlans, planner.proposeWork, planner.approvePlans], [true, true, false]);
});

test('the decision form shows for deciders on undecided topics or while replacing', () => {
  const manager = requirementsAbilities({ canDecide: true });
  const member = requirementsAbilities({ canDecide: false, projectRole: 'member' });
  const topic = { state: 'ready' };
  assert.equal(showDecisionForm({ abilities: manager, topic }), true);
  assert.equal(showDecisionForm({ abilities: member, topic }), false);
  assert.equal(showDecisionForm({ abilities: manager, activeDecision: { id: 'd1' }, topic }), false);
  assert.equal(showDecisionForm({ abilities: manager, activeDecision: { id: 'd1' }, replacing: true, topic }), true);
  assert.equal(showDecisionForm({ abilities: manager, topic: { state: 'dismissed' } }), false);
  assert.equal(showDecisionForm({ abilities: manager, topic: null }), false);
});

test('pickers fall back to the overview member list when valid-users is not readable', () => {
  const overview = { members: [{ email: 'mia@example.com', id: 'user-mia', name: 'Mia Manager', role: 'manager' }] };
  assert.deepEqual(workspaceMembers({ overview, validUsers: [] }), overview.members);
  const valid = [{ id: 'user-ada', name: 'Ada Admin', role: 'admin' }];
  assert.deepEqual(workspaceMembers({ overview, validUsers: valid }), valid);
  assert.deepEqual(workspaceMembers({ overview: null, validUsers: undefined }), []);
});
