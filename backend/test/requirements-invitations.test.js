import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { DIGEST_RELEASE_REASONS, flushDueClarificationInvitationDigests } from '../src/modules/assistant/clarification-invitation-digest.service.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import {
  createRequirementsTestApp,
  INBOUND_MAIL_SECRET,
  MAIL_REPLY_DOMAIN,
  PROJECT_ID,
  TENANT_ID,
} from './helpers/requirements-test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PORTAL_URL = /http:\/\/localhost:5173\/app\/requirements\/([A-Za-z0-9_-]{43})/;

function invitationsFor(harness, clarificationId) {
  return harness.assistantRepository.state.projectClarificationInvitations
    .filter((invitation) => invitation.clarificationId === clarificationId);
}

// Invitations go out in the stakeholder's digest, sent through the mail job's transport
// (a fake here). A digest shows each invitation's reply address.
function mailFor(harness, invitation) {
  return (harness.digestOutbox?.sent ?? []).find((message) => message.html.includes(`clarification+${invitation.replyToken}@`)) ?? null;
}

/** Runs the mail job's digest step as if the quiet period had passed. */
function deliverDigests(harness, mailRepository, { afterMinutes = 21 } = {}) {
  harness.digestOutbox ??= { sent: [], async sendMail(message) { this.sent.push(message); return { messageId: `<digest-${this.sent.length}@fixture>` }; } };
  return flushDueClarificationInvitationDigests({
    assistantRepository: harness.assistantRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    mailReplyDomain: MAIL_REPLY_DOMAIN,
    mailRepository,
    now: () => new Date(Date.now() + harness.clock.offsetMs + afterMinutes * 60_000),
    projectRepository: harness.projectRepository,
    transport: harness.digestOutbox,
  });
}

async function seedAssistantClarification(harness, { assignments = [], id = 'assistant-clarification', prompt = 'Assistant clarification' } = {}) {
  await harness.assistantRepository.syncProjectClarifications({
    clarifications: [{ assignments, blockingArea: 'Assistant', id, linkedSection: 'brief', prompt, proposedDraftImpact: '', rationale: '' }],
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
  });
  return id;
}

function inboundReply(harness, { body = 'Replying by email.', fromEmail, htmlBody = '', messageId, replyToken }) {
  return request(harness.app)
    .post('/api/public/clarification-mail/inbound')
    .set('x-inbound-mail-secret', INBOUND_MAIL_SECRET)
    .send({
      fromEmail,
      htmlBody,
      messageId,
      provider: 'ses',
      subject: 'Re: question',
      textBody: body,
      toEmail: `clarification+${replyToken}@${MAIL_REPLY_DOMAIN}`,
    });
}

test('assigning a stakeholder to a tracked topic emails a fresh requirements link token', async () => {
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository });
  const jamie = await harness.seedStakeholder();
  const first = await harness.createTopic({ prompt: 'Which reminder channels do clients want?' });
  const second = await harness.createTopic({ prompt: 'When does the price first appear?' });

  await harness.as('member').patch(`/topics/${first.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }] });
  assert.equal(mailRepository.state.queue.length, 0, 'the invitation waits in the digest');
  await deliverDigests(harness, mailRepository);
  const [firstInvitation] = invitationsFor(harness, first.id);
  const firstMail = mailFor(harness, firstInvitation);
  assert.ok(firstMail, 'an invitation digest was sent');
  assert.equal(firstMail.to, 'jamie@client.example');
  assert.equal(firstMail.replyTo, `clarification+${firstInvitation.replyToken}@${MAIL_REPLY_DOMAIN}`, 'reply-by-email keeps the existing reply token');
  assert.equal(firstMail.html.includes(`/clarifications/${firstInvitation.invitationToken}`), false, 'no link to the older portal');
  const firstToken = PORTAL_URL.exec(firstMail.html)?.[1];
  assert.ok(firstToken, 'the email links to the client portal');

  // The link was created on demand, and the emailed token opens the portal.
  const { links, tokens } = harness.requirementsRepository.state;
  assert.equal(links.length, 1);
  assert.equal(links[0].createdBy, 'system:invitation');
  assert.deepEqual(tokens.map((token) => token.purpose), ['invitation']);
  const portal = await harness.portal(firstToken).get();
  assert.equal(portal.status, 200);
  assert.deepEqual(portal.body.topics.assigned.map((topic) => topic.id), [first.id]);

  // A later digest sends its own token on the same link; both work.
  await harness.as('member').patch(`/topics/${second.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder', role: 'primary' }] });
  await deliverDigests(harness, mailRepository);
  const secondToken = PORTAL_URL.exec(mailFor(harness, invitationsFor(harness, second.id)[0]).html)?.[1];
  assert.ok(secondToken);
  assert.notEqual(secondToken, firstToken);
  assert.equal(harness.requirementsRepository.state.links.length, 1);
  assert.equal(harness.requirementsRepository.state.tokens.length, 2);
  assert.equal((await harness.portal(firstToken).get()).status, 200);
  assert.equal((await harness.portal(secondToken).get()).status, 200);
});

test('a revoked link is not reopened by assigning the stakeholder to a topic', async () => {
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository });
  const jamie = await harness.seedStakeholder();
  const link = await harness.createLink(jamie.id);
  await harness.as('projectManager').post(`/links/${link.link.id}/revoke`);

  const topic = await harness.createTopic({ prompt: 'Who signs off on accessibility?' });
  const assigned = await harness.as('member').patch(`/topics/${topic.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }] });
  assert.equal(assigned.status, 200);
  await deliverDigests(harness, mailRepository);
  const [invitation] = invitationsFor(harness, topic.id);
  assert.equal(mailFor(harness, invitation), null, 'no email goes out');
  assert.equal(mailRepository.state.queue.length, 0);
  assert.deepEqual([invitation.queuedAt, invitation.scheduledAt], [null, null], 'the digest released the invitation instead of sending it');
  assert.equal(harness.requirementsRepository.state.links[0].revokedAt !== null, true, 'the link stays revoked');
  assert.equal(harness.requirementsRepository.state.tokens.length, 1, 'no new token was issued');
});

test('email replies on a tracked topic are stored without a status change while the link is live, and rejected after', async () => {
  const mailRepository = createInMemoryMailRepository();
  const reviews = [];
  const harness = await createRequirementsTestApp({
    assistantAiService: { async reviewClarificationDiscussion(input) { reviews.push(input); return { comment: 'AI', currentAnswer: 'AI answer' }; } },
    mailRepository,
  });
  const jamie = await harness.seedStakeholder();
  const tracked = await harness.createTopic({ prompt: 'Which reminder channels?' });
  await harness.as('member').patch(`/topics/${tracked.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }] });
  await deliverDigests(harness, mailRepository);
  const { replyToken } = invitationsFor(harness, tracked.id)[0];
  const events = harness.recordEvents(`project:${PROJECT_ID}`);

  const stored = await inboundReply(harness, { body: 'Text messages, please.', fromEmail: 'jamie@client.example', messageId: 'm-1', replyToken });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.equal(stored.body.ignored, undefined);
  let topic = (await harness.as('viewer').get(`/topics/${tracked.id}`)).body.topic;
  assert.equal(topic.status, 'open', 'the reply does not change status');
  assert.deepEqual(topic.comments.map((comment) => [comment.body, comment.source]), [['Text messages, please.', 'email-reply']]);

  assert.equal(reviews.length, 0, 'the older automatic review does not run');
  assert.equal(topic.comments.some((comment) => comment.actorType === 'assistant'), false);
  assert.ok(events.events.some((event) => event.type === 'requirements.topics.invalidated' && event.reason === 'topic-email-replied'));

  // Replies on a decided topic still count (people can disagree by email).
  await harness.as('projectManager').post('/decisions', { outcome: 'decided', statement: 'Text messages.', topicId: tracked.id });
  assert.equal((await inboundReply(harness, { body: 'Thanks.', fromEmail: 'jamie@client.example', messageId: 'm-2', replyToken })).body.ignored, undefined);

  // Once the link is revoked, replies are acknowledged but not stored.
  const link = harness.requirementsRepository.state.links[0];
  await harness.as('projectManager').post(`/links/${link.id}/revoke`);
  const rejected = await inboundReply(harness, { body: 'One more thing.', fromEmail: 'jamie@client.example', messageId: 'm-3', replyToken });
  assert.equal(rejected.status, 201);
  assert.deepEqual(rejected.body, { ignored: true, ok: true, reason: 'requirements_link_inactive' });
  topic = (await harness.as('viewer').get(`/topics/${tracked.id}`)).body.topic;
  assert.equal(topic.comments.length, 2);
  assert.equal(harness.assistantRepository.state.projectClarificationEmailMessages.some((message) => message.providerMessageId === 'm-3'), false);
});

test('email replies are rejected once the stakeholder link has expired or the topic no longer takes comments', async () => {
  const reviews = [];
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({
    assistantAiService: { async reviewClarificationDiscussion(input) { reviews.push(input); return { comment: '', currentAnswer: '' }; } },
    mailRepository,
  });
  const jamie = await harness.seedStakeholder();
  const tracked = await harness.createTopic({ prompt: 'Which reminder channels?' });
  await harness.as('member').patch(`/topics/${tracked.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }] });
  await deliverDigests(harness, mailRepository);
  await harness.as('projectManager').post('/decisions', { outcome: 'decided', statement: 'Email.', topicId: tracked.id });
  const { replyToken } = invitationsFor(harness, tracked.id)[0];

  harness.clock.offsetMs = 15 * DAY_MS;
  const expired = await inboundReply(harness, { fromEmail: 'jamie@client.example', messageId: 'm-late', replyToken });
  assert.deepEqual(expired.body, { ignored: true, ok: true, reason: 'requirements_link_inactive' });

  // A clarification the assistant saved is a topic too: its replies take the same path.
  harness.clock.offsetMs = 0;
  const assistantTopicId = await seedAssistantClarification(harness, {
    assignments: [{ actorId: jamie.id, actorType: 'stakeholder', label: 'Jamie Ortiz', role: 'primary' }],
  });
  const assistantReplyToken = invitationsFor(harness, assistantTopicId)[0].replyToken;
  const stored = await inboundReply(harness, { fromEmail: 'jamie@client.example', messageId: 'm-assistant', replyToken: assistantReplyToken });
  assert.equal(stored.status, 201);
  assert.equal(stored.body.ignored, undefined);
  assert.equal(reviews.length, 0, 'the older automatic review does not run');

  // Once the topic is dismissed, comments are closed and replies are not stored.
  assert.equal((await harness.as('projectManager').patch(`/topics/${assistantTopicId}`, { status: 'dismissed' })).status, 200);
  const closed = await inboundReply(harness, { fromEmail: 'jamie@client.example', messageId: 'm-closed', replyToken: assistantReplyToken });
  assert.equal(closed.status, 201);
  assert.deepEqual(closed.body, { ignored: true, ok: true, reason: 'comments_closed' });
  const topic = (await harness.as('viewer').get(`/topics/${assistantTopicId}`)).body.topic;
  assert.deepEqual(topic.comments.map((comment) => comment.source), ['email-reply']);
});

test('a new stakeholder link can be emailed straight to the stakeholder, and still works when copied', async () => {
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository });
  const stakeholder = await harness.seedStakeholder();

  const sent = await harness.as('projectManager').post('/links', { send: true, stakeholderId: stakeholder.id });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.deepEqual(sent.body.email, { recipient: 'jamie@client.example', sent: true });
  const mail = mailRepository.state.queue.at(-1);
  assert.equal(mail.recipientEmail, 'jamie@client.example');
  assert.equal(mail.templateId, 'requirements-link-v1');
  assert.equal(PORTAL_URL.exec(mail.body)?.[1], sent.body.token, 'the email carries the link that was issued');

  const copied = await harness.as('projectManager').post('/links', { stakeholderId: stakeholder.id });
  assert.equal(copied.body.email, null, 'without send, nothing is emailed');
  assert.equal(mailRepository.state.queue.length, 1);

  const silent = await harness.seedStakeholder({ email: '', name: 'No Email' });
  const unsent = await harness.as('projectManager').post('/links', { send: true, stakeholderId: silent.id });
  assert.equal(unsent.status, 201);
  assert.deepEqual(unsent.body.email, { reason: 'no-email', sent: false });
});

test('sending a stakeholder link emails at once and leaves a pending digest to go out on its own schedule, once', async () => {
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository });
  const jamie = await harness.seedStakeholder();
  const topic = await harness.createTopic({ prompt: 'Which reminder channels?' });
  await harness.as('member').patch(`/topics/${topic.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }] });
  const [invitation] = invitationsFor(harness, topic.id);
  assert.ok(invitation.scheduledAt);

  const sent = await harness.as('projectManager').post('/links', { send: true, stakeholderId: jamie.id });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.deepEqual(mailRepository.state.queue.map((row) => row.templateId), ['requirements-link-v1'], 'the deliberate send goes out immediately');
  const [after] = invitationsFor(harness, topic.id);
  assert.deepEqual([after.scheduledAt, after.queuedAt], [invitation.scheduledAt, null], 'the digest is neither sent, cancelled nor pushed back');

  assert.equal((await deliverDigests(harness, mailRepository, { afterMinutes: 10 })).sent, 0);
  assert.equal((await deliverDigests(harness, mailRepository)).sent, 1);
  assert.equal((await deliverDigests(harness, mailRepository, { afterMinutes: 40 })).sent, 0, 'and only once');
  assert.deepEqual(mailRepository.state.queue.map((row) => row.templateId), ['requirements-link-v1'], 'the digest goes out directly, not through the queue');
  assert.equal(harness.digestOutbox.sent.length, 1);
});

test('recheck finding 1: a link revoked or an address changed while the digest renders stops it before SMTP; the next run uses current access and address', async () => {
  // The stakeholder link is revoked through the native route while the email template is looked up.
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository });
  const jamie = await harness.seedStakeholder();
  const topic = await harness.createTopic({ prompt: 'Which private pricing tiers are planned?' });
  await harness.as('member').patch(`/topics/${topic.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }] });
  const getTemplate = mailRepository.getTemplate;
  mailRepository.getTemplate = async (input) => {
    mailRepository.getTemplate = getTemplate;
    const [link] = harness.requirementsRepository.state.links;
    assert.equal((await harness.as('projectManager').post(`/links/${link.id}/revoke`)).status, 200);
    return getTemplate.call(mailRepository, input);
  };
  assert.equal((await deliverDigests(harness, mailRepository)).deferred, 1);
  assert.equal(harness.digestOutbox.sent.length, 0, 'the private topic was not sent');
  assert.equal((await deliverDigests(harness, mailRepository, { afterMinutes: 22 })).skipped, 1);
  assert.equal(harness.digestOutbox.sent.length, 0);
  const [invitation] = invitationsFor(harness, topic.id);
  assert.deepEqual([invitation.scheduledAt, invitation.queuedAt, invitation.lastError], [null, null, DIGEST_RELEASE_REASONS.linkRevoked]);

  // The stakeholder's address changes while the template is looked up: nothing goes to the old one.
  const otherMail = createInMemoryMailRepository();
  const other = await createRequirementsTestApp({ mailRepository: otherMail });
  const sam = await other.seedStakeholder({ email: 'sam.old@client.example', name: 'Sam Lee' });
  const otherTopic = await other.createTopic({ prompt: 'Which reminder channels?' });
  await other.as('member').patch(`/topics/${otherTopic.id}`, { assignments: [{ actorId: sam.id, actorType: 'stakeholder' }] });
  const otherTemplate = otherMail.getTemplate;
  otherMail.getTemplate = async (input) => {
    otherMail.getTemplate = otherTemplate;
    await other.assistantRepository.createProjectStakeholder({ projectId: PROJECT_ID, tenantId: TENANT_ID, value: { email: 'sam.new@client.example', id: sam.id, name: 'Sam Lee' } });
    return otherTemplate.call(otherMail, input);
  };
  assert.equal((await deliverDigests(other, otherMail)).deferred, 1);
  assert.equal(other.digestOutbox.sent.length, 0, 'nothing went to the old address');
  assert.equal((await deliverDigests(other, otherMail, { afterMinutes: 22 })).sent, 1);
  assert.deepEqual(other.digestOutbox.sent.map((message) => message.to), ['sam.new@client.example']);
  const token = PORTAL_URL.exec(other.digestOutbox.sent[0].html)?.[1];
  assert.equal((await other.portal(token).get()).status, 200, 'the link in the digest that was sent works');
});

test('recheck ordering: a native assignment saved while the portal link is being verified postpones the digest, which then sends every topic', async () => {
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository });
  const jamie = await harness.seedStakeholder();
  const first = await harness.createTopic({ prompt: 'Which reminder channels do clients want?' });
  const second = await harness.createTopic({ prompt: 'When does the price first appear?' });
  const assignJamie = (topic) => harness.as('member').patch(`/topics/${topic.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }] });
  assert.equal((await assignJamie(first)).status, 200);

  // 21 minutes later on the app's clock, so the save and the digest run share one timeline.
  harness.clock.offsetMs += 21 * 60_000;
  const bridge = harness.assistantRepository.requirementsBridge;
  const verify = bridge.invitationUrlUsable;
  let savedAt = null;
  bridge.invitationUrlUsable = async (input) => {
    bridge.invitationUrlUsable = verify;
    assert.equal((await assignJamie(second)).status, 200, 'the second topic is assigned while the link is being verified');
    savedAt = Date.now();
    return verify.call(bridge, input);
  };
  assert.equal((await deliverDigests(harness, mailRepository, { afterMinutes: 0 })).deferred, 1);
  assert.ok(savedAt, 'the save ran during verification');
  assert.equal((harness.digestOutbox?.sent ?? []).length, 0, 'nothing is sent right after the new assignment');
  assert.equal((await harness.assistantRepository.getClarificationInvitationDigest({ projectId: PROJECT_ID, stakeholderId: jamie.id, tenantId: TENANT_ID })).claimToken, null, 'the attempt gave up its claim');

  assert.equal((await deliverDigests(harness, mailRepository, { afterMinutes: 19 })).sent, 0, 'the new assignment restarted the quiet period');
  assert.equal((await deliverDigests(harness, mailRepository, { afterMinutes: 21 })).sent, 1);
  const [digest] = harness.digestOutbox.sent;
  assert.ok(digest.html.includes('Which reminder channels do clients want?') && digest.html.includes('When does the price first appear?'), 'one digest with both topics');
  assert.ok([first, second].every((topic) => invitationsFor(harness, topic.id)[0].mailStatus === 'sent'));
});

test('finding 3: a topic save schedules its invitations in the same write, and a failure there fails the save instead of being swallowed', async () => {
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository });
  const jamie = await harness.seedStakeholder();
  const topic = await harness.createTopic({ prompt: 'Which reminder channels?' });
  // No separate scheduling step exists to fail after the save commits.
  harness.assistantRepository.scheduleClarificationInvitations = async () => { throw new Error('a topic save must not schedule in a separate step'); };
  const saved = await harness.as('member').patch(`/topics/${topic.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(saved.body.topic.assignments.find((entry) => entry.actorId === jamie.id).scheduledAt, 'the response already shows the invitation scheduled');
  assert.ok(invitationsFor(harness, topic.id)[0].scheduledAt);

  // A failure inside the save's write reaches the caller, and nothing is saved.
  const other = await harness.createTopic({ prompt: 'When does the price first appear?' });
  const update = harness.assistantRepository.updateProjectClarification;
  harness.assistantRepository.updateProjectClarification = async (input) => {
    if (input.patch?.scheduleInvitationsAt) throw new Error('scheduling failed inside the write');
    return update(input);
  };
  const failed = await harness.as('member').patch(`/topics/${other.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }] });
  assert.equal(failed.status, 500);
  harness.assistantRepository.updateProjectClarification = update;
  assert.deepEqual(invitationsFor(harness, other.id), [], 'no assignment or invitation was saved');
  assert.deepEqual((await harness.as('viewer').get(`/topics/${other.id}`)).body.topic.assignments, []);
});

test('an email reply formatted in the mail client is stored as Markdown, without its quoted history', async () => {
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository });
  const jamie = await harness.seedStakeholder();
  const tracked = await harness.createTopic({ prompt: 'Which reminder channels?' });
  await harness.as('member').patch(`/topics/${tracked.id}`, { assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }] });
  await deliverDigests(harness, mailRepository);
  const { replyToken } = invitationsFor(harness, tracked.id)[0];

  const formatted = await inboundReply(harness, {
    body: 'Email *first*, then text.',
    fromEmail: 'jamie@client.example',
    htmlBody: '<div>Email <b>first</b>, then:<ol><li>text</li><li>a call</li></ol></div><div class="gmail_quote">On Mon, Odin wrote:<blockquote>Which reminder channels?</blockquote></div>',
    messageId: 'm-formatted',
    replyToken,
  });
  assert.equal(formatted.status, 201, JSON.stringify(formatted.body));
  const topic = (await harness.as('viewer').get(`/topics/${tracked.id}`)).body.topic;
  assert.deepEqual(topic.comments.map((comment) => [comment.body, comment.source]), [[['Email **first**, then:', '', '1. text', '2. a call'].join(String.fromCharCode(10)), 'email-reply']]);
});
