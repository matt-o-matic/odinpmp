import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryPlatformRepository } from '../src/modules/platform/platform.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { processMailQueueBatch } from '../src/jobs/process-mail-queue.lib.js';
import { acceptedFiles } from '../src/modules/bug-reporter/bug-reporter.replies.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const secret = 'synthetic-inbound-secret';
const domain = 'reply.odinpmp.com';
const pass = { spam: 'pass', virus: 'pass', spf: 'pass', dkim: 'pass', dmarc: 'pass' };
const redirectUri = 'http://127.0.0.1:4320/api/auth/odin/callback';

async function fixture({ emailReplies = true, mailReplyDomain = domain } = {}) {
  const users = [
    { id: 'admin', name: 'Tenant admin', email: 'admin@example.test', password: 'Fixture-pass-123!', authMethod: 'basic', memberships: [{ tenantId, role: 'admin' }] },
    { id: 'viewer', name: 'Project viewer', email: 'viewer@example.test', password: 'Fixture-pass-123!', authMethod: 'basic', memberships: [{ tenantId, role: 'user' }] },
  ];
  const authRepository = await createInMemoryAuthRepository({ disableDemoUser: true, tenants: [{ id: tenantId, name: 'Fixture tenant' }], users });
  const projectRepository = createInMemoryProjectsRepository({ authRepository, seed: { projects: [{ id: 'project-a', tenantId, name: 'Project A', epics: [] }, { id: 'project-b', tenantId, name: 'Project B', epics: [] }] } });
  projectRepository.state.projectMemberships.set('project-a', [{ id: 'viewer', role: 'viewer' }]);
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'bugreporter-fixture', secret: 'only-a-local-fixture-signing-key-12345' });
  const token = tokenService.signSessionToken({ ...users[0], tenantId });
  await sessionsRepository.createSession({ expiryDate: new Date(tokenService.verifySessionToken(token).exp * 1000), token, userId: 'admin' });
  const platformRepository = createInMemoryPlatformRepository();
  const assistantRepository = createInMemoryAssistantRepository();
  const mailRepository = createInMemoryMailRepository();
  const warnings = [];
  const app = createApp({
    authRepository, projectRepository, platformRepository, sessionsRepository, tokenService, assistantRepository, mailRepository,
    webhookSweepIntervalMs: 0, bugReporterReplySweepIntervalMs: 0, inboundMailWebhookSecret: secret, mailReplyDomain, bugReporterEmailReplies: emailReplies,
    logger: { warn: message => warnings.push(message), info() {}, error() {} },
  });
  const stakeholder = await assistantRepository.createProjectStakeholder({ projectId: 'project-a', tenantId, value: { name: 'External tester', email: 'Tester@Example.test' } });
  const created = await request(app).post('/api/integrations/oauth-applications').set('Authorization', `Bearer ${token}`).send({ name: 'Bug Reporter fixture', projectIds: ['project-a'], redirectUris: [redirectUri], scopes: ['projects.read'] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const basic = `Basic ${Buffer.from(created.body.value.clientId + ':' + created.body.clientSecret).toString('base64')}`;
  const issued = await request(app).post('/api/v1/oauth/token').set('Authorization', basic).type('form').send({ grant_type: 'client_credentials', scope: 'projects.read' });
  const service = `Bearer ${issued.body.access_token}`;
  // A delegated token for the same application, which the replies API must refuse.
  const verifier = 'a'.repeat(64);
  const consent = await request(app).post('/api/v1/oauth/authorize').set('Authorization', `Bearer ${token}`).send({ approved: true, clientId: created.body.value.clientId, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256', redirectUri, scope: 'projects.read', state: 'fixture-state-12345' });
  const code = consent.body.redirectTo ? new URL(consent.body.redirectTo).searchParams.get('code') : null;
  const delegatedResult = code ? await request(app).post('/api/v1/oauth/token').set('Authorization', basic).type('form').send({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }) : null;
  const delegated = delegatedResult?.body?.access_token ? `Bearer ${delegatedResult.body.access_token}` : null;
  const delivered = [];
  const send = () => processMailQueueBatch({ mailRepository, assistantRepository, env: { mailFromAddress: 'noreply@odinpmp.com', mailFromName: 'Odin' }, transport: { async sendMail(message) { delivered.push(message); return { messageId: 'synthetic' }; } } });
  const updateBody = (overrides = {}) => ({ reporterKind: 'collaborator', reporterId: stakeholder.id, reportId: 'report-1', reportUrl: 'http://127.0.0.1:4320/?projectId=project-a&reportId=report-1', title: 'Import fails', status: 'Resolved', retryVersion: 0, ...overrides });
  const notify = (id, body = updateBody()) => request(app).post(`/api/v1/bug-reporter/projects/project-a/report-updates/${id}`).set('Authorization', service).send(body);
  const inbound = body => request(app).post('/api/public/inbound-mail').set('x-inbound-mail-secret', secret).send(body);
  let sequence = 0;
  const reply = (toEmail, overrides = {}) => inbound({ provider: 'aws-ses', messageId: `<reply-${++sequence}@example.test>`, fromEmail: 'tester@example.test', toEmail, subject: 'Re: Import fails', textBody: 'It still fails on Safari.', htmlBody: '', verdicts: pass, autoReplyHeaders: {}, attachments: [], ...overrides });
  return { app, mailRepository, assistantRepository, projectRepository, stakeholder, service, delegated, delivered, send, notify, updateBody, inbound, reply, warnings };
}

async function replyAddress(context, id = 'status-1', body) {
  assert.equal((await context.notify(id, body)).status, 202);
  await context.send();
  return context.delivered.at(-1).replyTo;
}

test('report updates carry a per-notification reply address and the reply line when replies are on', async () => {
  const context = await fixture();
  const concurrent = await Promise.all([1, 2].map(() => context.notify('status-1')));
  assert.deepEqual(concurrent.map(value => value.status), [202, 202]);
  assert.equal(context.mailRepository.state.replyTokens.size, 1);
  const [stored] = context.mailRepository.state.replyTokens.values();
  assert.match(stored.token, /^[0-9a-f]{40}$/);
  assert.deepEqual({ ...stored, token: undefined, targetId: undefined }, { token: undefined, targetId: undefined, applicationId: stored.applicationId, tenantId, projectId: 'project-a', reportId: 'report-1', reporterKind: 'collaborator', reporterId: context.stakeholder.id, recipientEmail: 'tester@example.test', reportTitle: 'Import fails' });
  assert.ok(stored.applicationId);
  await context.send();
  const mail = context.delivered.at(-1);
  assert.equal(mail.replyTo, `bugreport+${stored.token}@${domain}`);
  assert.match(mail.html, /Reply to this email to add information to your report\./);
  // A retry of the same notification keeps its token.
  assert.equal((await context.notify('status-1')).status, 200);
  assert.equal(context.mailRepository.state.replyTokens.size, 1);
  // Each notification gets its own token, and the newer update template also gets the line.
  const manual = await replyAddress(context, 'manual-1', context.updateBody({ updateType: 'manual', status: 'In progress', priority: 'High', comment: 'Looking into it.' }));
  assert.match(manual, /^bugreport\+[0-9a-f]{40}@reply\.odinpmp\.com$/);
  assert.notEqual(manual, mail.replyTo);
  assert.match(context.delivered.at(-1).html, /Reply to this email/);
  assert.equal(context.mailRepository.state.queue.find(row => row.replyTo === manual).templateId, 'bug-reporter-update-reply-v1');
  assert.equal(context.mailRepository.state.queue.find(row => row.replyTo === mail.replyTo).templateId, 'bug-reporter-status-reply-v1');
});

test('report updates have no reply address unless both the flag and the reply domain are set', async () => {
  for (const options of [{ emailReplies: false }, { mailReplyDomain: '' }]) {
    const context = await fixture(options);
    assert.equal(await replyAddress(context), undefined);
    assert.doesNotMatch(context.delivered.at(-1).html, /Reply to this email/);
    assert.equal(context.mailRepository.state.replyTokens?.size ?? 0, 0);
  }
});

test('an addition or reopening emails the assignee in their own words, with no reply address', async () => {
  const context = await fixture();
  const notice = (overrides = {}) => context.updateBody({ reporterKind: 'internal', reporterId: 'viewer', updateType: 'addition', status: 'Triaged', priority: 'High', comment: 'It also fails on **page two**.', authorName: 'Casey <Lee>', fileCount: 2, ...overrides });
  for (const body of [
    notice({ reporterKind: 'collaborator', reporterId: context.stakeholder.id }),
    notice({ authorName: undefined }), notice({ authorName: 'x'.repeat(201) }), notice({ authorName: 7 }),
    notice({ fileCount: undefined }), notice({ fileCount: -1 }), notice({ fileCount: 1.5 }), notice({ fileCount: '2' }),
    notice({ priority: undefined }), notice({ status: 'Reopened' }), notice({ updateType: 'receipt' }),
    // The two fields belong to notices only.
    context.updateBody({ authorName: 'Casey', fileCount: 0 }),
    context.updateBody({ updateType: 'manual', status: 'In progress', priority: 'High', comment: 'Looking into it.', fileCount: 1 }),
  ]) assert.equal((await context.notify('notice-invalid', body)).status, 400, JSON.stringify(body));
  const missing = await context.notify('notice-missing', notice({ reporterId: 'missing' }));
  assert.equal(missing.status, 404);
  assert.match(JSON.stringify(missing.body), /The assignee is no longer assigned to this project\./);

  assert.deepEqual((await Promise.all([1, 2].map(() => context.notify('addition-1', notice())))).map(value => value.status), [202, 202]);
  assert.equal((await context.notify('addition-1', notice({ fileCount: 3 }))).status, 409);
  assert.equal((await context.notify('addition-1', notice({ authorName: 'Someone else' }))).status, 409);
  await context.send();
  const mail = context.delivered.at(-1);
  assert.equal(mail.to, 'viewer@example.test');
  assert.equal(mail.subject, 'New information on a bug assigned to you: Import fails');
  assert.equal(mail.replyTo, undefined);
  assert.match(mail.html, /Hello Project viewer/);
  assert.match(mail.html, /Casey &lt;Lee&gt; added information to a bug assigned to you\./);
  assert.match(mail.html, /<strong>page two<\/strong>/);
  assert.match(mail.html, /2 files added\./);
  assert.match(mail.html, /reportId=report-1/);
  assert.doesNotMatch(mail.html, /Reply to this email/);
  assert.equal(context.mailRepository.state.queue.at(-1).templateId, 'bug-reporter-assignee-v1');
  assert.equal(context.mailRepository.state.replyTokens?.size ?? 0, 0);
  const status = await request(context.app).get('/api/v1/bug-reporter/projects/project-a/report-updates/addition-1').set('Authorization', context.service);
  assert.equal(status.body.delivery.status, 'sent');

  assert.equal((await context.notify('reopening-1', notice({ updateType: 'reopening', status: 'In progress', comment: 'Still broken in Edge.', fileCount: 0 }))).status, 202);
  await context.send();
  const reopened = context.delivered.at(-1);
  assert.equal(reopened.subject, 'A bug assigned to you was reopened: Import fails');
  assert.match(reopened.html, /Casey &lt;Lee&gt; reopened a bug assigned to you\./);
  assert.match(reopened.html, /Still broken in Edge\./);
  assert.doesNotMatch(reopened.html, /added\./);
  assert.equal(reopened.replyTo, undefined);

  // Files with no text, from a reporter with no display name.
  assert.equal((await context.notify('addition-2', notice({ comment: '', authorName: ' ', fileCount: 1 }))).status, 202);
  await context.send();
  assert.match(context.delivered.at(-1).html, /The reporter added information to a bug assigned to you\./);
  assert.match(context.delivered.at(-1).html, /1 file added\./);
  assert.doesNotMatch(context.delivered.at(-1).html, /class="comment"/);
  assert.equal(context.mailRepository.state.replyTokens?.size ?? 0, 0);
});

test('the inbound webhook routes by address prefix and keeps the clarification and ticket handlers', async () => {
  const context = await fixture();
  assert.equal((await request(context.app).post('/api/public/inbound-mail').send({ toEmail: 'clarification+abc@reply.odinpmp.com' })).status, 401);
  assert.equal((await request(context.app).post('/api/public/inbound-mail').set('x-inbound-mail-secret', 'wrong').send({})).status, 401);
  const clarification = await context.reply('clarification+unknowntoken@reply.odinpmp.com');
  assert.equal(clarification.status, 404);
  assert.match(clarification.body.error?.message ?? clarification.body.message ?? JSON.stringify(clarification.body), /Clarification invitation not found/);
  const ticket = await context.reply('ticket+unknowntoken@reply.odinpmp.com');
  assert.equal(ticket.status, 201);
  assert.deepEqual(ticket.body, { matched: false, ok: true });
  const other = await context.reply('someone@reply.odinpmp.com');
  assert.equal(other.status, 202);
  assert.equal(other.body.matched, false);
});

test('a bugreport+ reply is accepted only when every check passes', async () => {
  const context = await fixture();
  const address = await replyAddress(context);
  const accepted = async (overrides, expected) => {
    const response = await context.reply(address, overrides);
    assert.equal(response.status, 202, JSON.stringify(response.body));
    assert.equal(response.body.matched, expected, JSON.stringify(overrides));
  };
  const before = () => context.mailRepository.state.replies.size;
  await accepted({ toEmail: address.replace(/[0-9a-f]{40}/, '0'.repeat(40)) }, false);
  await accepted({ fromEmail: 'someone-else@example.test' }, false);
  await accepted({ verdicts: { ...pass, spam: 'fail' } }, false);
  await accepted({ verdicts: { ...pass, virus: 'fail' } }, false);
  await accepted({ verdicts: { ...pass, spf: 'fail', dkim: 'fail' } }, false);
  await accepted({ verdicts: { ...pass, dmarc: 'fail' } }, false);
  await accepted({ verdicts: {} }, false);
  await accepted({ autoReplyHeaders: { autoSubmitted: 'auto-replied' } }, false);
  await accepted({ autoReplyHeaders: { precedence: 'bulk' } }, false);
  await accepted({ autoReplyHeaders: { xAutoreply: 'yes' } }, false);
  await accepted({ textBody: '> quoted only', attachments: [{ fileName: 'archive.zip', contentType: 'application/zip', contentBase64: Buffer.from('zip').toString('base64') }] }, false);
  assert.equal(before(), 0);
  assert.equal(context.delivered.length, 1, 'dropped replies send no email');
  // SPF may fail when DKIM passes; DMARC "none" is not a failure; Auto-Submitted: no is a person.
  await accepted({ fromEmail: 'TESTER@example.test', verdicts: { ...pass, spf: 'softfail', dmarc: 'none' }, autoReplyHeaders: { autoSubmitted: 'no' } }, true);
  assert.equal(before(), 1);
  const duplicate = { messageId: '<same-message@example.test>' };
  await accepted(duplicate, true);
  await accepted(duplicate, false);
  assert.equal(before(), 2);
  // The reporter's Odin email changed after the notification went out.
  context.assistantRepository.state.projectStakeholders.find(value => value.id === context.stakeholder.id).email = 'new-address@example.test';
  await accepted({}, false);
  assert.ok(context.warnings.some(message => /reporter email changed/.test(message)));
  assert.ok(context.warnings.every(message => !message.includes(address.slice(10, 50))), 'logs never contain the reply token');
});

test('an internal reporter can reply while the address is still their Odin email', async () => {
  const context = await fixture();
  const address = await replyAddress(context, 'internal-1', context.updateBody({ reporterKind: 'internal', reporterId: 'viewer' }));
  assert.equal((await context.reply(address, { fromEmail: 'viewer@example.test' })).body.matched, true);
  assert.equal((await context.reply(address)).body.matched, false);
});

test('replies are dropped while the flag is off, even for an existing token', async () => {
  const context = await fixture();
  const address = await replyAddress(context);
  const off = await fixture({ emailReplies: false });
  const [token] = context.mailRepository.state.replyTokens.values();
  off.mailRepository.state.replyTokens.set(token.token, { ...token, reporterId: off.stakeholder.id });
  assert.equal((await off.reply(address)).body.matched, false);
});

test('accepted replies lose quoted history, are capped at 10,000 characters and keep only accepted files', async () => {
  const context = await fixture();
  const address = await replyAddress(context);
  const file = (fileName, bytes = 10) => ({ fileName, contentType: 'application/octet-stream', contentBase64: Buffer.alloc(bytes, 1).toString('base64') });
  const accepted = ['a.pdf', 'b.doc', 'c.docx', 'd.png', 'e.jpg', 'f.JPEG', 'g.jfif', 'h.gif', 'i.webp', 'j.bmp', 'k.tif', 'l.tiff', 'm.avif', 'n.heic', 'o.heif'];
  await context.reply(address, { textBody: 'Still broken.\n\nOn Mon, Odin wrote:\n> Your bug report has been resolved.', attachments: [...accepted.map(name => file(name)), file('evil.exe'), file('notes.txt'), file('noextension')] });
  const replies = (await request(context.app).get('/api/v1/bug-reporter/projects/project-a/replies').set('Authorization', context.service)).body.replies;
  assert.equal(replies[0].text, 'Still broken.');
  assert.deepEqual(replies[0].attachments.map(value => value.name), accepted);
  await context.reply(address, { textBody: 'x'.repeat(12000), attachments: Array.from({ length: 25 }, (_, index) => file(`shot-${index}.png`)) });
  await context.reply(address, { textBody: '', htmlBody: '<p>See files</p><blockquote>old</blockquote>', attachments: [file('one.png')] });
  const [, capped, html] = (await request(context.app).get('/api/v1/bug-reporter/projects/project-a/replies').set('Authorization', context.service)).body.replies;
  assert.equal(capped.text.length, 10000);
  assert.equal(capped.attachments.length, 20);
  assert.equal(html.text, 'See files');
  // The Lambda never forwards more than 10 MiB, so the combined cap is checked directly.
  const sized = acceptedFiles([file('one.png', 6 * 1024 * 1024), file('two.png', 6 * 1024 * 1024), file('three.png', 1024)]);
  assert.deepEqual(sized.map(value => value.name), ['one.png', 'three.png']);
});

test('Bug Reporter lists pending replies and settles each one once', async t => {
  const context = await fixture();
  const address = await replyAddress(context);
  const base = '/api/v1/bug-reporter/projects/project-a/replies';
  const get = (query = '') => request(context.app).get(base + query).set('Authorization', context.service);
  const outcome = (id, body) => request(context.app).post(`${base}/${id}/outcome`).set('Authorization', context.service).send(body);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (let index = 0; index < 12; index++) { now += 1000; await context.reply(address, { textBody: `Reply ${index}` }); }
  assert.equal((await request(context.app).get(base)).status, 401);
  if (context.delegated) assert.equal((await request(context.app).get(base).set('Authorization', context.delegated)).status, 403);
  assert.equal((await request(context.app).get(base.replace('project-a', 'project-b')).set('Authorization', context.service)).status, 404);
  for (const query of ['?limit=0', '?limit=abc', '?limit=-1', '?limit=1&limit=2']) assert.equal((await get(query)).status, 400, query);
  const page = await get();
  assert.equal(page.status, 200);
  assert.equal(page.body.replies.length, 10);
  assert.deepEqual(page.body.replies.map(value => value.text), Array.from({ length: 10 }, (_, index) => `Reply ${index}`));
  const first = page.body.replies[0];
  assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(first).sort(), ['attachments', 'id', 'receivedAt', 'reportId', 'reporterId', 'reporterKind', 'text']);
  assert.equal(first.reportId, 'report-1');
  assert.equal(first.reporterKind, 'collaborator');
  assert.equal(first.reporterId, context.stakeholder.id);
  assert.equal(new Date(first.receivedAt).toISOString(), first.receivedAt);
  assert.equal((await get('?limit=3')).body.replies.length, 3);
  assert.equal((await get('?limit=50')).body.replies.length, 10);

  for (const body of [{}, { outcome: 'added', reason: 'invalid' }, { outcome: 'rejected' }, { outcome: 'rejected', reason: 'other' }, { outcome: 'skipped' }]) assert.equal((await outcome(first.id, body)).status, 400, JSON.stringify(body));
  assert.equal((await outcome('00000000-0000-4000-8000-000000000000', { outcome: 'added' })).status, 404);
  assert.equal((await outcome('not-a-uuid', { outcome: 'added' })).status, 404);
  assert.equal((await request(context.app).post(`${base.replace('project-a', 'project-b')}/${first.id}/outcome`).set('Authorization', context.service).send({ outcome: 'added' })).status, 404);
  assert.equal((await outcome(first.id, { outcome: 'added' })).status, 200);
  assert.equal((await outcome(first.id, { outcome: 'added' })).status, 200);
  assert.equal((await outcome(first.id, { outcome: 'rejected', reason: 'invalid' })).status, 409);
  assert.ok(!(await get()).body.replies.some(value => value.id === first.id));

  const [deleted, limited, mismatch, invalid] = page.body.replies.slice(1, 5);
  const sentBefore = context.delivered.length;
  assert.equal((await outcome(deleted.id, { outcome: 'rejected', reason: 'report_deleted' })).status, 200);
  assert.equal((await outcome(deleted.id, { outcome: 'rejected', reason: 'report_deleted' })).status, 200);
  assert.equal((await outcome(deleted.id, { outcome: 'rejected', reason: 'addition_limit' })).status, 409);
  assert.equal((await outcome(limited.id, { outcome: 'rejected', reason: 'addition_limit' })).status, 200);
  assert.equal((await outcome(mismatch.id, { outcome: 'rejected', reason: 'reporter_mismatch' })).status, 200);
  assert.equal((await outcome(invalid.id, { outcome: 'rejected', reason: 'invalid' })).status, 200);
  await context.send();
  const notices = context.delivered.slice(sentBefore);
  assert.equal(notices.length, 2, 'only report_deleted and addition_limit notify the reporter');
  assert.ok(notices.every(mail => mail.to === 'tester@example.test' && !mail.replyTo && /could not be added/.test(mail.subject) && /Import fails/.test(mail.html)));
  assert.match(notices[0].html, /has been deleted/);
  assert.match(notices[1].html, /cannot take any more additions/);
  assert.equal((await get()).body.replies.length, 7);
});

test('a page stops at 20 MB of attachments but always holds one reply', async t => {
  const context = await fixture();
  const address = await replyAddress(context);
  let now = Date.now();
  t.mock.method(Date, 'now', () => (now += 1000));
  const token = address.slice('bugreport+'.length, address.indexOf('@'));
  const megabytes = count => [{ name: 'large.png', data: Buffer.alloc(count * 1024 * 1024) }];
  for (const [index, size] of [25, 9, 9, 9].entries()) await context.mailRepository.saveReply({ token, messageId: `<large-${index}@example.test>`, text: '', files: megabytes(size) });
  const get = () => request(context.app).get('/api/v1/bug-reporter/projects/project-a/replies').set('Authorization', context.service);
  const oversized = (await get()).body.replies;
  assert.equal(oversized.length, 1);
  assert.equal((await request(context.app).post(`/api/v1/bug-reporter/projects/project-a/replies/${oversized[0].id}/outcome`).set('Authorization', context.service).send({ outcome: 'added' })).status, 200);
  assert.equal((await get()).body.replies.length, 2);
});

test('reply contents are deleted 30 days after settling, and unsettled replies expire after 30 days', async t => {
  const context = await fixture();
  const address = await replyAddress(context);
  const start = Date.now();
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const png = { fileName: 'shot.png', contentType: 'image/png', contentBase64: Buffer.from('png').toString('base64') };
  await context.reply(address, { textBody: 'settled', attachments: [png] });
  now += 1;
  await context.reply(address, { textBody: 'unsettled' });
  const [settled, unsettled] = (await request(context.app).get('/api/v1/bug-reporter/projects/project-a/replies').set('Authorization', context.service)).body.replies;
  assert.equal(settled.text, 'settled');
  // Later steps call the store directly: the application's access token lasts an hour.
  const scope = { ...context.mailRepository.state.replies.get(settled.id), replyId: settled.id };
  const settle = (replyId, outcome = 'added') => context.mailRepository.settleReply({ applicationId: scope.applicationId, tenantId, projectId: 'project-a', replyId, outcome, reason: null });
  const day = 86400000;
  now = start + day;
  assert.equal((await settle(settled.id)).settled, true);
  const stored = id => context.mailRepository.state.replies.get(id);
  now = start + 29.5 * day;
  await context.mailRepository.purgeReplies();
  assert.equal(stored(settled.id).text, 'settled');
  assert.equal(stored(settled.id).files.length, 1);
  assert.equal(stored(unsettled.id).status, 'pending');
  now = start + 31.5 * day;
  await context.mailRepository.purgeReplies();
  assert.equal(stored(settled.id).text, null);
  assert.deepEqual(stored(settled.id).files, []);
  assert.equal(stored(settled.id).status, 'added');
  assert.equal(stored(unsettled.id).status, 'expired');
  assert.equal(stored(unsettled.id).text, null);
  assert.deepEqual(await context.mailRepository.listPendingReplies({ applicationId: scope.applicationId, tenantId, projectId: 'project-a', limit: 10 }), []);
  assert.equal((await settle(settled.id)).conflict, false);
  assert.equal((await settle(unsettled.id)).missing, true);
});

test('Markdown both ways: an update comment in Markdown is emailed formatted, and a formatted reply is stored as Markdown', async () => {
  const context = await fixture();
  const comment = ['**Fixed** in build 42:', '', '- import', '- export'].join(String.fromCharCode(10));
  const address = await replyAddress(context, 'manual-markdown', context.updateBody({ updateType: 'manual', status: 'In progress', priority: 'High', comment }));
  const mail = context.delivered.at(-1);
  assert.ok(mail.html.includes('<h3>Message from the team</h3><p><strong>Fixed</strong> in build 42:</p>'), mail.html);
  assert.ok(mail.html.includes('<li>import</li>'));

  const response = await context.reply(address, {
    htmlBody: '<div>Still <b>broken</b> on Safari:<ul><li>open the import</li></ul></div><div class="gmail_quote"><div>On Mon, Odin wrote:</div><blockquote>Fixed in build 42</blockquote></div>',
    textBody: 'Still *broken* on Safari',
  });
  assert.equal(response.body.matched, true, JSON.stringify(response.body));
  const [saved] = [...context.mailRepository.state.replies.values()];
  assert.equal(saved.text, ['Still **broken** on Safari:', '', '- open the import'].join(String.fromCharCode(10)));
});
