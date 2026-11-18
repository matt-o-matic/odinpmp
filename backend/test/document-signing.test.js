import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import request from 'supertest';

import { computeLinkStatus } from '../src/modules/requirements/requirements-access-links.js';
import { canonicalJson, createSigningSealer, sha256Hex } from '../src/modules/signing/signing-seal.js';
import { createRequirementsTestApp, PROJECT_ID } from './helpers/requirements-test-app.js';

// Document signing: file audience, signature requests, the emailed code, sealed evidence,
// completion, decline, cancel, and what stakeholders see.

const FILES = `/api/projects/${PROJECT_ID}/files`;
const SIGNING = `/api/projects/${PROJECT_ID}/signing-requests`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function fakeMail() {
  const sent = [];
  return {
    sent,
    async getTemplate() { return null; },
    async queueMail(row) { sent.push(row); return true; },
  };
}

async function setup() {
  const mail = fakeMail();
  const harness = await createRequirementsTestApp({ mailRepository: mail });
  const call = (role, method, path, body) => {
    const pending = request(harness.app)[method](path).set('Authorization', `Bearer ${harness.tokens[role]}`);
    return body === undefined ? pending : pending.send(body);
  };
  const upload = async (contents, fileName = 'contract.pdf', role = 'projectManager') => {
    const response = await call(role, 'post', FILES, { fileContentsBase64: Buffer.from(contents).toString('base64'), fileName, fileType: 'application/pdf', targetId: PROJECT_ID, targetType: 'project' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.file;
  };
  const jamie = await harness.seedStakeholder();
  const riley = await harness.seedStakeholder({ email: 'riley@client.example', name: 'Riley Chen', roleTitle: 'Sponsor' });
  const portalTokenFor = (email) => {
    const row = [...mail.sent].reverse().find((entry) => entry.recipientEmail === email && /\/requirements\/[A-Za-z0-9_-]+\/signing\//.test(entry.body));
    return row?.body.match(/\/requirements\/([A-Za-z0-9_-]+)\/signing\//)?.[1] ?? null;
  };
  const codeFor = (email) => [...mail.sent].reverse().find((entry) => entry.recipientEmail === email && /Your signing code/.test(entry.subject))?.subject.match(/(\d{6})/)?.[1] ?? null;
  return { call, codeFor, harness, jamie, mail, portalTokenFor, riley, upload };
}

// Response bytes whatever their type (supertest buffers only text types).
const bytes = (pending) => pending.buffer(true).parse((response, done) => {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => done(null, Buffer.concat(chunks)));
});
const textOf = async (pending) => (await bytes(pending)).body.toString('utf8');

const SIGN = (code) => ({ browser: { language: 'en-US', platform: 'MacIntel', timeZone: 'America/New_York' }, code, consent: true, fullName: 'Jamie Q. Ortiz', organization: 'Client Co', title: 'Operations lead' });

test('files are internal until shared, and only file writers can change that', async () => {
  const { call, upload } = await setup();
  const file = await upload('draft');
  assert.equal(file.audience, 'internal');

  // Odin answers viewers' writes as if the file were not there.
  assert.equal((await call('viewer', 'patch', `${FILES}/${file.id}/audience`, { audience: 'external' })).status, 404);
  const shared = await call('member', 'patch', `${FILES}/${file.id}/audience`, { audience: 'external' });
  assert.equal(shared.status, 200);
  assert.equal(shared.body.file.audience, 'external');
  assert.equal(shared.body.changed, true);
  const again = await call('member', 'patch', `${FILES}/${file.id}/audience`, { audience: 'external' });
  assert.equal(again.body.changed, false);
  const listed = await call('member', 'get', `${FILES}?targetType=project&targetId=${PROJECT_ID}`);
  assert.equal(listed.body.files.find((entry) => entry.id === file.id).audience, 'external');
  assert.equal((await call('member', 'patch', `${FILES}/${file.id}/audience`, { audience: 'public' })).status, 400);
});

test('an acceptance request freezes the file version, signs with an emailed code, and completes with a sealed record', async () => {
  const { call, codeFor, harness, jamie, mail, portalTokenFor, riley, upload } = await setup();
  const file = await upload('contract v1');
  const internal = await upload('internal notes', 'notes.pdf');

  // Only admins and managers send for signature.
  const body = { documents: [{ fileId: file.id }], kind: 'acceptance', message: 'Please review by Friday.', signerStakeholderIds: [jamie.id, riley.id], title: 'Statement of work' };
  assert.equal((await call('member', 'post', SIGNING, body)).status, 404);
  const created = await call('projectManager', 'post', SIGNING, body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const requestId = created.body.request.id;
  assert.equal(created.body.request.status, 'pending');
  assert.equal(created.body.request.documents[0].sha256, sha256('contract v1'));
  assert.equal(created.body.request.packageValid, true);
  assert.deepEqual(created.body.request.signers.map((signer) => [signer.name, signer.status, signer.mail?.status]), [['Jamie Ortiz', 'pending', 'queued'], ['Riley Chen', 'pending', 'queued']]);
  assert.equal(mail.sent.filter((row) => /Please sign: Statement of work/.test(row.subject)).length, 2);
  assert.ok(mail.sent.some((row) => row.body.includes('Please review by Friday.')));

  // The document became external; the other file stays internal.
  const files = (await call('member', 'get', `${FILES}?targetType=project&targetId=${PROJECT_ID}`)).body.files;
  assert.equal(files.find((entry) => entry.id === file.id).audience, 'external');
  assert.equal(files.find((entry) => entry.id === internal.id).audience, 'internal');

  // A signed file stays shared and cannot be deleted; a new version does not change the request.
  const deleted = await call('projectManager', 'delete', `${FILES}/${file.id}`);
  assert.equal(deleted.status, 409);
  assert.equal(deleted.body.details.code, 'file_under_signature');
  assert.equal((await call('member', 'patch', `${FILES}/${file.id}/audience`, { audience: 'internal' })).body.details.code, 'file_under_signature');
  const versioned = await call('member', 'post', `${FILES}/${file.id}/versions`, { expectedVersion: 1, fileContentsBase64: Buffer.from('contract v2').toString('base64') });
  assert.equal(versioned.status, 201);

  // What Jamie sees in the portal.
  const jamieToken = portalTokenFor('jamie@client.example');
  assert.ok(jamieToken);
  const portal = harness.portal(jamieToken);
  const documents = await portal.get('/documents');
  assert.equal(documents.status, 200);
  assert.deepEqual(documents.body.documents.map((entry) => entry.fileName), ['contract.pdf']);
  assert.deepEqual(documents.body.awaitingMe, [requestId]);
  assert.equal(JSON.stringify(documents.body).includes('riley@client.example'), false, 'no other signer emails');
  assert.equal((await portal.get(`/documents/${internal.id}/content`)).status, 404);
  assert.equal(await textOf(portal.get(`/documents/${file.id}/content`)), 'contract v2');
  assert.equal(await textOf(portal.get(`/signing/${requestId}/documents/0/content`)), 'contract v1');

  const view = await portal.get(`/signing/${requestId}`);
  assert.equal(view.body.request.me.status, 'pending');
  assert.equal(view.body.signer.email, 'j****@client.example');

  // Signing needs a code; a wrong one is counted.
  assert.equal((await portal.post(`/signing/${requestId}/sign`, SIGN('000000'))).body.details.code, 'code_required');
  const sent = await portal.post(`/signing/${requestId}/code`);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.sentTo, 'j****@client.example');
  assert.equal((await portal.post(`/signing/${requestId}/code`)).status, 429, 'resend waits a minute');
  const code = codeFor('jamie@client.example');
  const wrong = code === '123456' ? '654321' : '123456';
  const failed = await portal.post(`/signing/${requestId}/sign`, SIGN(wrong));
  assert.equal(failed.status, 400);
  assert.equal(failed.body.details.code, 'code_invalid');
  assert.equal(failed.body.details.remaining, 4);
  assert.equal((await portal.post(`/signing/${requestId}/sign`, { ...SIGN(code), consent: false })).status, 400);
  const signed = await portal.post(`/signing/${requestId}/sign`, SIGN(code));
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.request.me.status, 'signed');
  assert.deepEqual(signed.body.request.progress, { signed: 1, total: 2 });
  assert.equal((await portal.post(`/signing/${requestId}/sign`, SIGN(code))).body.details.code, 'signer_not_pending');

  // The team sees the evidence, sealed.
  const detail = await call('viewer', 'get', `${SIGNING}/${requestId}`);
  assert.equal(detail.status, 200);
  const jamieSigner = detail.body.request.signers.find((signer) => signer.stakeholderId === jamie.id);
  assert.equal(jamieSigner.sealValid, true);
  assert.equal(jamieSigner.evidence.typedName, 'Jamie Q. Ortiz');
  assert.equal(jamieSigner.evidence.verification.method, 'email_code');
  assert.equal(jamieSigner.evidence.packageHash, created.body.request.packageHash);
  assert.equal(jamieSigner.evidence.documents[0].sha256, sha256('contract v1'));
  assert.equal(jamieSigner.evidence.browser.timeZone, 'America/New_York');
  assert.ok(detail.body.request.events.some((event) => event.action === 'code_failed'));

  // Removing the last unsigned signer completes the request.
  const rileySigner = detail.body.request.signers.find((signer) => signer.stakeholderId === riley.id);
  assert.equal((await call('member', 'post', `${SIGNING}/${requestId}/signers/${rileySigner.id}/remove`, {})).status, 404);
  const removed = await call('projectManager', 'post', `${SIGNING}/${requestId}/signers/${rileySigner.id}/remove`, { reason: 'Left the company' });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.request.status, 'completed');
  assert.equal(removed.body.request.manifestValid, true);
  assert.ok(mail.sent.some((row) => row.recipientEmail === 'jamie@client.example' && /Signed by everyone/.test(row.subject)));
  assert.ok(mail.sent.some((row) => row.recipientEmail === 'user-pmanager@acme.com' && /Signed by everyone/.test(row.subject)));

  const certificate = await bytes(call('viewer', 'get', `${SIGNING}/${requestId}/certificate`));
  assert.equal(certificate.status, 200);
  assert.equal(certificate.headers['content-type'], 'application/pdf');
  const pdf = certificate.body.toString('latin1');
  assert.match(pdf, /^%PDF-1\.4/);
  assert.ok(pdf.includes('Jamie Q. Ortiz'));
  assert.ok(pdf.includes(sha256('contract v1')));
  assert.ok(pdf.includes('Left the company'));
  assert.equal((await portal.get(`/signing/${requestId}/certificate`)).status, 200);

  // Completed: still protected from deletion.
  assert.equal((await call('projectManager', 'delete', `${FILES}/${file.id}`)).status, 409);
});

test('a signer can decline without a reason, which stops the request', async () => {
  const { call, harness, jamie, mail, portalTokenFor, riley, upload } = await setup();
  const file = await upload('proposal');
  const created = await call('projectManager', 'post', SIGNING, { documents: [{ fileId: file.id }], kind: 'acceptance', signerStakeholderIds: [jamie.id, riley.id], title: 'Proposal' });
  const requestId = created.body.request.id;
  const riley_ = harness.portal(portalTokenFor('riley@client.example'));
  const declined = await riley_.post(`/signing/${requestId}/decline`, {});
  assert.equal(declined.status, 200);
  assert.equal(declined.body.request.status, 'declined');
  const jamie_ = harness.portal(portalTokenFor('jamie@client.example'));
  assert.equal((await jamie_.post(`/signing/${requestId}/code`)).body.details.code, 'signing_request_not_pending');
  assert.ok(mail.sent.some((row) => row.recipientEmail === 'jamie@client.example' && /Signature declined/.test(row.subject)));
  // A declined request no longer protects its file.
  assert.equal((await call('member', 'patch', `${FILES}/${file.id}/audience`, { audience: 'internal' })).status, 200);
});

test('a manager cancels a request, and a sign-off can be on the project with no documents', async () => {
  const { call, harness, jamie, mail, portalTokenFor } = await setup();
  const created = await call('tenantManager', 'post', SIGNING, { kind: 'signoff', signerStakeholderIds: [jamie.id], title: 'Phase 1 complete' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.request.subject.type, 'project');
  assert.equal(created.body.request.subject.name, 'Client booking');
  assert.match(created.body.request.statement, /sign it off/);
  const requestId = created.body.request.id;
  const portal = harness.portal(portalTokenFor('jamie@client.example'));
  assert.equal((await portal.get(`/signing/${requestId}`)).body.request.subject.type, 'project');

  const reminded = await call('projectManager', 'post', `${SIGNING}/${requestId}/remind`, {});
  assert.equal(reminded.status, 200);
  assert.equal(reminded.body.reminded, 1);
  assert.ok(mail.sent.some((row) => /Reminder: please sign Phase 1 complete/.test(row.subject)));

  const cancelled = await call('projectManager', 'post', `${SIGNING}/${requestId}/cancel`, { reason: 'Scope changed' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.request.status, 'cancelled');
  assert.ok(mail.sent.some((row) => row.recipientEmail === 'jamie@client.example' && /withdrawn/.test(row.subject)));
  assert.equal((await call('projectManager', 'post', `${SIGNING}/${requestId}/cancel`, {})).status, 409);

  const listed = await call('viewer', 'get', SIGNING);
  assert.deepEqual(listed.body.requests.map((entry) => entry.status), ['cancelled']);
  assert.equal(listed.body.canManage, false, 'a viewer is not offered request actions');
  assert.equal((await call('projectManager', 'get', SIGNING)).body.canManage, true);
  assert.equal((await call('member', 'get', `${SIGNING}/${requestId}`)).body.canManage, false);
  assert.equal('events' in listed.body.requests[0], false, 'lists leave out the audit trail');

  // Acceptance needs documents; signers must be stakeholders with an email.
  assert.equal((await call('projectManager', 'post', SIGNING, { kind: 'acceptance', signerStakeholderIds: [jamie.id], title: 'x' })).body.details.code, 'documents_required');
  assert.equal((await call('projectManager', 'post', SIGNING, { kind: 'signoff', signerStakeholderIds: ['nobody'], title: 'x' })).body.details.code, 'invalid_signer');
  assert.equal((await call('projectManager', 'post', SIGNING, { kind: 'signoff', signerStakeholderIds: [jamie.id], subjectId: 'nope', subjectType: 'milestone', title: 'x' })).body.details.code, 'invalid_subject');
});

test('an open signature request keeps a signer\'s portal link alive', () => {
  const issuedAt = '2026-10-01T00:00:00.000Z';
  const link = { extendedUntil: null, issuedAt, revokedAt: null };
  const day = (count) => new Date(Date.parse(issuedAt) + count * 86_400_000);
  assert.equal(computeLinkStatus({ involvement: { signings: [{ endedAt: null }] }, link, now: day(60) }).status, 'active');
  assert.equal(computeLinkStatus({ involvement: { signings: [{ endedAt: day(30).toISOString() }] }, link, now: day(43) }).status, 'active');
  assert.equal(computeLinkStatus({ involvement: { signings: [{ endedAt: day(30).toISOString() }] }, link, now: day(45) }).status, 'expired');
});

test('seals verify only with the key that made them, and production refuses without a key', () => {
  const sealer = createSigningSealer({ key: 'k'.repeat(40), keyId: 'seal-7' });
  const text = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  assert.equal(text, '{"a":{"c":3,"d":2},"b":1}');
  const { seal, sealKeyId } = sealer.seal(text);
  assert.equal(sealKeyId, 'seal-7');
  assert.equal(sealer.verify(text, seal, 'seal-7'), true);
  assert.equal(sealer.verify(`${text} `, seal, 'seal-7'), false);
  const rotated = createSigningSealer({ key: 'n'.repeat(40), keyId: 'seal-8', previousKeys: `seal-7:${'k'.repeat(40)}` });
  assert.equal(rotated.verify(text, seal, 'seal-7'), true);
  assert.equal(createSigningSealer({ production: true }).configured, false);
  assert.equal(createSigningSealer({ key: 'short', production: true }).configured, false);
  assert.equal(createSigningSealer({ key: 'k'.repeat(40), production: true }).configured, true);
  assert.equal(sha256Hex('abc'), sha256('abc'));
});

test('production never accepts a seal made with the public development key, under any key id', () => {
  const text = canonicalJson({ record: 1 });
  const development = createSigningSealer();
  const forged = development.seal(text);
  assert.equal(forged.sealKeyId, 'dev-1');
  assert.equal(development.verify(text, forged.seal, 'dev-1'), true, 'development still checks its own seals');
  const production = createSigningSealer({ key: 'k'.repeat(40), keyId: 'seal-1', previousKeys: 'old-dev:odin-local-signing-seal-key-do-not-use-in-production', production: true });
  assert.equal(production.verify(text, forged.seal, 'dev-1'), false);
  assert.equal(production.verify(text, forged.seal, 'old-dev'), false);
  assert.equal(createSigningSealer({ production: true }).verify(text, forged.seal, 'dev-1'), false, 'not even with no key configured');
  const real = production.seal(text);
  assert.equal(production.verify(text, real.seal, 'seal-1'), true);
});

test('a request freezes a file by the SHA-256 stored at its scan, and refuses a version still being scanned', async () => {
  const { call, harness, jamie, upload } = await setup();
  const file = await upload('contract v1');
  assert.equal(file.sha256, sha256('contract v1'), 'the base64 path stores the SHA-256 it scanned');

  // A large upload lands as version 2 and waits for its scan.
  const repository = harness.projectRepository;
  const user = { id: 'user-pmanager', name: 'Pia Manager' };
  const now = new Date();
  const pending = { baseVersion: 1, contentType: 'application/pdf', createdAt: now.toISOString(), createdBy: user.id, expiresAt: new Date(now.getTime() + 3600_000).toISOString(), fileId: file.id, fileName: 'contract.pdf', id: 'upload-1', partSize: 8 * 1024 * 1024, projectId: PROJECT_ID, size: 11, status: 'assembled', storageKey: 'large-object-1', storageUploadId: 'storage-upload-1', targetId: PROJECT_ID, targetType: 'project', tenantId: 'tenant-acme' };
  await repository.createFileUpload(pending);
  const saved = await repository.saveUploadedFile({ size: 11, upload: pending, user });
  assert.deepEqual([saved.file.version, saved.file.scanStatus], [2, 'pending']);

  const refused = await call('projectManager', 'post', SIGNING, { documents: [{ fileId: file.id }], kind: 'acceptance', signerStakeholderIds: [jamie.id], title: 'Pending version' });
  assert.deepEqual([refused.status, refused.body.details.code], [409, 'file_scanning']);
  const earlier = await call('projectManager', 'post', SIGNING, { documents: [{ fileId: file.id, version: 1 }], kind: 'acceptance', signerStakeholderIds: [jamie.id], title: 'Version 1' });
  assert.equal(earlier.status, 201, JSON.stringify(earlier.body));
  assert.deepEqual([earlier.body.request.documents[0].sha256, earlier.body.request.documents[0].version], [sha256('contract v1'), 1]);
});
