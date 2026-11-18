import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { fileErrorMessage } from '../src/lib/projects/project-files.js';
import {
  DEFAULT_SIGNING_STATEMENTS,
  browserEvidence,
  fileUnderSignature,
  requestsForFile,
  signerMailProblem,
  signingErrorMessage,
  signingEventLine,
  signingProgressLabel,
  signingStatus,
} from '../src/lib/projects/project-signing.js';

const backendService = readFileSync(new URL('../../backend/src/modules/signing/signing.service.js', import.meta.url), 'utf8');
const router = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/components/projects/ProjectFilesPanel.vue', import.meta.url), 'utf8');

const requests = [
  { createdAt: '2026-11-01T00:00:00Z', documents: [{ fileId: 'f1' }], id: 'old', status: 'declined' },
  { createdAt: '2026-11-03T00:00:00Z', documents: [{ fileId: 'f1' }, { fileId: 'f2' }], id: 'new', status: 'pending' },
  { createdAt: '2026-11-02T00:00:00Z', documents: [], id: 'signoff', status: 'completed', subject: { id: 'project-1', type: 'project' } },
];

test('a file lists its requests newest first, and only waiting or completed ones keep it shared', () => {
  assert.deepEqual(requestsForFile(requests, 'f1').map((request) => request.id), ['new', 'old']);
  assert.deepEqual(requestsForFile(requests, 'f3'), []);
  assert.equal(fileUnderSignature(requests, 'f2'), true);
  assert.equal(fileUnderSignature([requests[0]], 'f1'), false, 'a declined request does not hold the file');
});

test('statuses, progress and events read in plain words', () => {
  assert.equal(signingStatus('pending').label, 'Waiting for signatures');
  assert.equal(signingStatus('completed').label, 'Signed by everyone');
  assert.equal(signingProgressLabel({ signed: 1, total: 2 }), '1 of 2 signed');
  assert.equal(signingEventLine({ action: 'signed', actor: { id: 'stakeholder:s1', name: 'Jamie' } }), 'Jamie signed');
  assert.equal(signingEventLine({ action: 'code_sent', actor: { id: 'stakeholder:s1', name: null } }), 'A stakeholder asked for a signing code');
  assert.equal(signingEventLine({ action: 'completed', actor: { id: 'system' } }), 'Everyone has signed');
  assert.equal(signerMailProblem({ mail: { reason: 'link-revoked', status: 'not-sent' } }), 'Email not sent: their portal link is turned off.');
  assert.equal(signerMailProblem({ mail: { status: 'queued' } }), '');
});

test('errors become something a person can act on', () => {
  assert.equal(signingErrorMessage({ status: 404 }, 'x'), 'Only project admins and managers can do this.');
  assert.equal(signingErrorMessage({ data: { details: { code: 'signing_not_configured' } }, status: 503 }, 'x'), 'Signing is not set up on this server yet. Ask an administrator to add the seal key.');
  assert.equal(signingErrorMessage({ data: { details: [{ message: 'Enter the 6-digit code from the email.', path: 'code' }] }, message: 'Invalid request payload.', status: 400 }, 'x'), 'Enter the 6-digit code from the email.');
  assert.equal(signingErrorMessage({ data: { details: { code: 'code_invalid' } }, message: 'That code is not right.', status: 400 }, 'x'), 'That code is not right.');
  assert.match(fileErrorMessage({ data: { details: { code: 'file_under_signature' } }, status: 409 }, 'x'), /signature request/);
});

test('browser evidence names language, time zone and platform', () => {
  const evidence = browserEvidence({ navigator: { language: 'en-US', platform: 'iPad' } });
  assert.equal(evidence.language, 'en-US');
  assert.equal(evidence.platform, 'iPad');
  assert.equal(typeof evidence.timeZone, 'string');
});

test('the default statements match the server', () => {
  for (const statement of Object.values(DEFAULT_SIGNING_STATEMENTS)) assert.ok(backendService.includes(statement), statement);
});

test('the portal routes and the vault link to a request are wired', () => {
  assert.match(router, /path: 'documents', name: 'requirements-portal-documents'/);
  assert.match(router, /path: 'signing\/:requestId', name: 'requirements-portal-signing'/);
  assert.match(panel, /focusSigningId/);
});
