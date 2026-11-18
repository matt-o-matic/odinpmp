import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryAssistantRepository, createMysqlAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import {
  DIGEST_LEASE_MS,
  DIGEST_RELEASE_REASONS,
  flushDueClarificationInvitationDigests,
  scheduleClarificationInvitationDigests,
} from '../src/modules/assistant/clarification-invitation-digest.service.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { renderClarificationDigestEmail } from '../src/modules/mail/mail.service.js';

// Clarification invitation digests with disposable in-memory stores, a controllable clock
// and a fake mail transport: the trailing quiet period per tenant, project and stakeholder
// with no maximum wait; isolation; deduplication; send-time revalidation; the deadline held
// until the actual send; claims, leases and fencing; recovery after a stopped run; retries
// and bounces. Nothing reaches a real mail server.

const T0 = new Date('2026-10-10T09:00:00.000Z');
const at = (minutes, seconds = 0, ms = 0) => new Date(T0.getTime() + minutes * 60_000 + seconds * 1000 + ms);
const REPLY_DOMAIN = 'reply.fixture.example';
const APP = 'https://app.fixture.example/app';
const PROJECT_NAMES = { 'p-a': 'Atlas', 'p-b': 'Borealis', 'p-c': 'Cygnus' };

/** A fake SMTP transport: records sent messages, fails on demand, runs a hook before a send. */
function fakeTransport() {
  const transport = {
    failures: [],
    hooks: [],
    sent: [],
    async sendMail(message) {
      const hook = transport.hooks.shift();
      if (hook) await hook(message);
      if (transport.failures.length) throw new Error(transport.failures.shift());
      transport.sent.push(message);
      return { messageId: `<digest-${transport.sent.length}@fixture>` };
    },
  };
  return transport;
}

async function setup({ stakeholders = [], clarifications = [] } = {}) {
  const repo = createInMemoryAssistantRepository();
  const mail = createInMemoryMailRepository();
  const projects = { getProjectDetail: async ({ projectId }) => ({ id: projectId, name: PROJECT_NAMES[projectId] ?? projectId }) };
  for (const { email, id, name = id, projectId = 'p-a', tenantId = 't-1' } of stakeholders) {
    await repo.createProjectStakeholder({ projectId, tenantId, value: { email, id, name } });
  }
  const byScope = new Map();
  for (const { id, prompt = `Question ${id}?`, projectId = 'p-a', tenantId = 't-1' } of clarifications) {
    const key = `${tenantId}|${projectId}`;
    byScope.set(key, [...(byScope.get(key) ?? []), { assignments: [], id, prompt, rationale: `Why ${id}`, status: 'open' }]);
  }
  for (const [key, list] of byScope) {
    const [tenantId, projectId] = key.split('|');
    await repo.syncProjectClarifications({ clarifications: list, projectId, tenantId });
  }
  return { mail, projects, repo, transport: fakeTransport() };
}

/** A native assignment save, scheduling the invited stakeholders in the same write. */
function assign(env, { clarificationId, now, projectId = 'p-a', stakeholderIds, tenantId = 't-1' }) {
  return env.repo.updateProjectClarification({
    clarificationId,
    patch: {
      assignments: stakeholderIds.map((actorId, index) => ({ actorId, actorType: 'stakeholder', label: actorId, role: index === 0 ? 'primary' : 'collaborator' })),
      scheduleInvitationsAt: now,
    },
    projectId,
    tenantId,
  });
}
const unassign = (env, clarificationId, projectId = 'p-a') => env.repo.updateProjectClarification({ clarificationId, patch: { assignments: [] }, projectId, tenantId: 't-1' });

const flush = (env, now, extra = {}) => flushDueClarificationInvitationDigests({
  assistantRepository: env.repo, env: { mailFromAddress: 'odin@fixture.example', mailFromName: 'Odin' }, frontendAppUrl: APP, mailReplyDomain: REPLY_DOMAIN,
  mailRepository: env.mail, now: () => now, projectRepository: env.projects, transport: env.transport, ...extra,
});
const sent = (env) => env.transport.sent;
const invitationsOf = (env, stakeholderId) => env.repo.state.projectClarificationInvitations.filter((invitation) => invitation.stakeholderId === stakeholderId);
const replyAddress = (invitation) => `clarification+${invitation.replyToken}@${REPLY_DOMAIN}`;
const recipient = { projectId: 'p-a', stakeholderId: 's-1', tenantId: 't-1' };

test('one assignment is emailed only after more than 20 quiet minutes, exactly once, and never through the shared queue', async () => {
  const env = await setup({ clarifications: [{ id: 'c-1' }], stakeholders: [{ email: 'sam@client.example', id: 's-1', name: 'Sam' }] });
  await assign(env, { clarificationId: 'c-1', now: T0, stakeholderIds: ['s-1'] });
  assert.ok(invitationsOf(env, 's-1')[0].scheduledAt, 'scheduled by the save itself');
  for (const now of [at(1), at(19, 59), at(20)]) {
    await flush(env, now);
    assert.equal(sent(env).length, 0, `not due at ${now.toISOString()}`);
  }
  assert.equal((await flush(env, at(20, 0, 1))).sent, 1);
  const [message] = sent(env);
  const [invitation] = invitationsOf(env, 's-1');
  assert.equal(message.to, 'sam@client.example');
  assert.equal(message.subject, 'Clarification needed for Atlas');
  assert.equal(message.replyTo, replyAddress(invitation));
  assert.match(message.html, /A single clarification in <strong>Atlas<\/strong> needs your input\./);
  assert.ok(message.html.includes(`${APP}/clarifications/${invitation.invitationToken}`));
  assert.deepEqual([invitation.mailStatus, Boolean(invitation.queuedAt), Boolean(invitation.sentAt), Boolean(invitation.deliveryId)], ['sent', true, true, true]);
  assert.equal(await env.repo.getClarificationInvitationDigest(recipient), null, 'the delivery row is gone');
  assert.equal(env.mail.state.queue.length, 0, 'digests never use the shared mail queue');
  await flush(env, at(45));
  assert.equal(sent(env).length, 1);
});

test('assignments that keep arriving for an hour produce one digest, sent more than 20 minutes after the last one', async () => {
  const ids = Array.from({ length: 13 }, (_, index) => `c-${index}`);
  const env = await setup({ clarifications: ids.map((id) => ({ id })), stakeholders: [{ email: 'sam@client.example', id: 's-1' }] });
  const sentAt = [];
  for (let minute = 0; minute <= 85; minute += 1) {
    if (minute % 5 === 0 && minute <= 60) await assign(env, { clarificationId: ids[minute / 5], now: at(minute), stakeholderIds: ['s-1'] });
    const before = sent(env).length;
    await flush(env, at(minute, 30));
    if (sent(env).length > before) sentAt.push(minute);
  }
  assert.deepEqual(sentAt, [80]);
  assert.equal(sent(env)[0].subject, '13 clarifications need your input in Atlas');
  for (const id of ids) assert.ok(sent(env)[0].html.includes(`Question ${id}?`), id);
  assert.equal(sent(env)[0].replyTo, undefined, 'several clarifications: no single Reply-To');
});

test('digests never mix tenants, projects or stakeholders, even for the same email address', async () => {
  const env = await setup({
    clarifications: [{ id: 'c-a1' }, { id: 'c-a2' }, { id: 'c-b1', projectId: 'p-b' }, { id: 'c-b2', projectId: 'p-b' }, { id: 'c-c1', projectId: 'p-c', tenantId: 't-2' }],
    stakeholders: [
      { email: 'sam@client.example', id: 's-a' }, { email: 'tia@client.example', id: 't-a' },
      { email: 'sam@client.example', id: 's-b', projectId: 'p-b' }, { email: 'sam@client.example', id: 's-c', projectId: 'p-c', tenantId: 't-2' },
    ],
  });
  await assign(env, { clarificationId: 'c-a1', now: at(0), stakeholderIds: ['s-a'] });
  await assign(env, { clarificationId: 'c-b1', now: at(1), projectId: 'p-b', stakeholderIds: ['s-b'] });
  await assign(env, { clarificationId: 'c-c1', now: at(2), projectId: 'p-c', stakeholderIds: ['s-c'], tenantId: 't-2' });
  await assign(env, { clarificationId: 'c-a2', now: at(3), stakeholderIds: ['t-a'] });
  await assign(env, { clarificationId: 'c-b2', now: at(15), projectId: 'p-b', stakeholderIds: ['s-b'] });

  await flush(env, at(22, 1));
  assert.deepEqual(sent(env).map((message) => message.subject).sort(), ['Clarification needed for Atlas', 'Clarification needed for Cygnus']);
  const atlas = sent(env).find((message) => message.subject.endsWith('Atlas'));
  for (const other of ['c-a2', 'c-b1', 'c-b2', 'c-c1']) assert.equal(atlas.html.includes(`Question ${other}?`), false, other);
  await flush(env, at(36));
  assert.equal(sent(env).length, 4);
  const borealis = sent(env).find((message) => message.subject.endsWith('Borealis'));
  assert.equal(borealis.subject, '2 clarifications need your input in Borealis');
  assert.equal(borealis.html.includes('Question c-a1?'), false);
});

test('each topic appears once; unchanged saves do not push the digest back, a new assignment does', async () => {
  const env = await setup({ clarifications: [{ id: 'c-1' }, { id: 'c-2' }], stakeholders: [{ email: 'sam@client.example', id: 's-1' }] });
  await assign(env, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  await assign(env, { clarificationId: 'c-1', now: at(10), stakeholderIds: ['s-1'] });
  await flush(env, at(20, 1));
  assert.equal(sent(env).length, 1, 'saving the same people again did not reset the quiet period');

  await assign(env, { clarificationId: 'c-2', now: at(30), stakeholderIds: ['s-1'] });
  await unassign(env, 'c-2');
  await assign(env, { clarificationId: 'c-2', now: at(40), stakeholderIds: ['s-1'] });
  const active = invitationsOf(env, 's-1').find((invitation) => invitation.clarificationId === 'c-2' && !invitation.deactivatedAt);
  env.repo.state.projectClarificationInvitations.push({ ...active, id: 'duplicate-invitation', invitationToken: 'dup-token', replyToken: 'dup-reply' });
  await flush(env, at(55));
  assert.equal(sent(env).length, 1);
  await flush(env, at(60, 1));
  assert.equal(sent(env).length, 2);
  assert.equal(sent(env)[1].html.split('Question c-2?').length - 1, 1, 'one entry for the topic');
  assert.ok(env.repo.state.projectClarificationInvitations.find((invitation) => invitation.id === 'duplicate-invitation').queuedAt);
});

test('removed assignments, closed topics, revoked links, missing emails and opted-out addresses never reach a digest', async () => {
  const env = await setup({
    clarifications: [{ id: 'c-removed' }, { id: 'c-closed' }, { id: 'c-open' }, { id: 'c-tracked' }, { id: 'c-noemail' }, { id: 'c-optout' }],
    stakeholders: [{ email: 'sam@client.example', id: 's-1' }, { email: '', id: 's-noemail' }, { email: 'gone@client.example', id: 's-optout' }],
  });
  env.repo.requirementsBridge = { issueInvitationUrl: async () => null, listTrackedTopicIds: async () => new Set(['c-tracked']), stakeholderLinkStatus: async () => 'revoked' };
  for (const id of ['c-removed', 'c-closed', 'c-open', 'c-tracked']) await assign(env, { clarificationId: id, now: at(0), stakeholderIds: ['s-1'] });
  await assign(env, { clarificationId: 'c-noemail', now: at(0), stakeholderIds: ['s-noemail'] });
  await assign(env, { clarificationId: 'c-optout', now: at(0), stakeholderIds: ['s-optout'] });
  await env.mail.optOutEmail({ email: 'gone@client.example' });
  await unassign(env, 'c-removed');
  await env.repo.updateProjectClarification({ clarificationId: 'c-closed', patch: { status: 'dismissed' }, projectId: 'p-a', tenantId: 't-1' });

  const summary = await flush(env, at(21));
  assert.deepEqual([summary.sent, summary.skipped], [1, 2]);
  assert.equal(sent(env)[0].subject, 'Clarification needed for Atlas');
  for (const id of ['c-removed', 'c-closed', 'c-tracked', 'c-noemail', 'c-optout']) assert.equal(sent(env)[0].html.includes(`Question ${id}?`), false, id);
  const byClarification = Object.fromEntries(env.repo.state.projectClarificationInvitations.filter((invitation) => !invitation.deactivatedAt).map((invitation) => [invitation.clarificationId, invitation]));
  assert.equal(byClarification['c-closed'].lastError, DIGEST_RELEASE_REASONS.topicClosed);
  assert.equal(byClarification['c-tracked'].lastError, DIGEST_RELEASE_REASONS.linkRevoked);
  assert.equal(byClarification['c-noemail'].lastError, DIGEST_RELEASE_REASONS.noEmail);
  assert.equal(byClarification['c-optout'].lastError, DIGEST_RELEASE_REASONS.optedOut);
  for (const id of ['c-closed', 'c-tracked', 'c-noemail', 'c-optout']) assert.deepEqual([byClarification[id].scheduledAt, byClarification[id].queuedAt], [null, null], id);
  await flush(env, at(50));
  assert.equal(sent(env).length, 1);

  // As before, a later save of that topic invites the stakeholder again.
  await env.repo.updateProjectClarification({ clarificationId: 'c-closed', patch: { status: 'open' }, projectId: 'p-a', tenantId: 't-1' });
  await assign(env, { clarificationId: 'c-closed', now: at(60), stakeholderIds: ['s-1'] });
  await flush(env, at(80, 1));
  assert.ok(sent(env)[1].html.includes('Question c-closed?'));
});

test('finding 1: every attempt re-checks and renders from current state, so a retry never sends removed, edited or revoked content', async () => {
  const env = await setup({ clarifications: [{ id: 'c-keep', prompt: 'Original wording?' }, { id: 'c-remove' }, { id: 'c-tracked' }], stakeholders: [{ email: 'sam@client.example', id: 's-1' }] });
  let linkRevoked = false;
  env.repo.requirementsBridge = {
    invitationUrlUsable: async () => !linkRevoked,
    issueInvitationUrl: async () => (linkRevoked ? null : { linkId: 'link-1', tokenId: 'token-1', url: `${APP}/requirements/fresh-token` }),
    listTrackedTopicIds: async () => new Set(['c-tracked']),
    stakeholderLinkStatus: async () => (linkRevoked ? 'revoked' : 'active'),
  };
  for (const id of ['c-keep', 'c-remove', 'c-tracked']) await assign(env, { clarificationId: id, now: at(0), stakeholderIds: ['s-1'] });
  env.transport.failures.push('421 try again later');
  assert.equal((await flush(env, at(21))).retried, 1);
  assert.equal(sent(env).length, 0);

  // After the failed attempt: one assignment removed, one prompt edited, the stakeholder link revoked.
  await unassign(env, 'c-remove');
  const keep = env.repo.state.projectClarifications.find((clarification) => clarification.id === 'c-keep');
  keep.prompt = 'Edited wording?';
  linkRevoked = true;
  assert.equal((await flush(env, at(25))).sent, 0, 'retry waits for its backoff');
  assert.equal((await flush(env, at(26, 1))).sent, 1);
  const [message] = sent(env);
  assert.ok(message.html.includes('Edited wording?') && !message.html.includes('Original wording?'));
  assert.equal(message.html.includes('Question c-remove?'), false);
  assert.equal(message.html.includes('Question c-tracked?'), false);
  assert.equal(message.html.includes('fresh-token'), false);

  // A removal between rendering and sending stops the send; the next run renders again.
  const second = await setup({ clarifications: [{ id: 'c-1' }, { id: 'c-2' }], stakeholders: [{ email: 'tia@client.example', id: 's-1' }] });
  await assign(second, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  await assign(second, { clarificationId: 'c-2', now: at(0), stakeholderIds: ['s-1'] });
  const begin = second.repo.beginClarificationDigestSend;
  second.repo.beginClarificationDigestSend = async (input) => {
    second.repo.beginClarificationDigestSend = begin;
    await unassign(second, 'c-2');
    return begin(input);
  };
  assert.equal((await flush(second, at(21))).deferred, 1);
  assert.equal(sent(second).length, 0);
  await flush(second, at(22));
  assert.equal(sent(second).length, 1);
  assert.equal(sent(second)[0].html.includes('Question c-2?'), false);
});

test('recheck finding 1: a new address or an edited topic while the email renders stops the send before SMTP; the next run renders again', async () => {
  const env = await setup({ clarifications: [{ id: 'c-1' }], stakeholders: [{ email: 'old@client.example', id: 's-1', name: 'Sam' }] });
  await assign(env, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  // The address changes while the email template is being looked up.
  const getTemplate = env.mail.getTemplate;
  env.mail.getTemplate = async (input) => {
    env.mail.getTemplate = getTemplate;
    await env.repo.createProjectStakeholder({ projectId: 'p-a', tenantId: 't-1', value: { email: 'new@client.example', id: 's-1', name: 'Sam' } });
    return getTemplate.call(env.mail, input);
  };
  assert.equal((await flush(env, at(21))).deferred, 1);
  assert.equal(sent(env).length, 0, 'nothing went to the old address');
  assert.equal((await env.repo.getClarificationInvitationDigest(recipient)).claimToken, null, 'the attempt gave up its claim');
  assert.equal((await flush(env, at(22))).sent, 1);
  assert.deepEqual(sent(env).map((message) => message.to), ['new@client.example']);

  // A topic edited while the template is looked up is rendered again, never sent with the old wording.
  const edited = await setup({ clarifications: [{ id: 'c-1', prompt: 'Original wording?' }], stakeholders: [{ email: 'tia@client.example', id: 's-1' }] });
  await assign(edited, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  const editedTemplate = edited.mail.getTemplate;
  edited.mail.getTemplate = async (input) => {
    edited.mail.getTemplate = editedTemplate;
    edited.repo.state.projectClarifications.find((clarification) => clarification.id === 'c-1').prompt = 'Edited wording?';
    return editedTemplate.call(edited.mail, input);
  };
  assert.equal((await flush(edited, at(21))).deferred, 1);
  assert.equal(sent(edited).length, 0);
  await flush(edited, at(22));
  assert.equal(sent(edited).length, 1);
  assert.ok(sent(edited)[0].html.includes('Edited wording?') && !sent(edited)[0].html.includes('Original wording?'));
});

test('recheck finding 2: an expired owner\'s late completion cannot release a topic the replacement owner must send', async () => {
  // The review's repro: the send is accepted at minute 21 with c-x left out (closed) and its
  // completion stalls; c-x reopens; a replacement owner claims at 42; the stalled completion
  // then lands. c-x must still go out.
  const env = await setup({ clarifications: [{ id: 'c-1' }, { id: 'c-x' }], stakeholders: [{ email: 'sam@client.example', id: 's-1' }] });
  await assign(env, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  await assign(env, { clarificationId: 'c-x', now: at(0), stakeholderIds: ['s-1'] });
  const setStatus = (status) => env.repo.updateProjectClarification({ clarificationId: 'c-x', patch: { status }, projectId: 'p-a', tenantId: 't-1' });
  const cx = () => invitationsOf(env, 's-1').find((invitation) => invitation.clarificationId === 'c-x');
  await setStatus('closed');

  const complete = env.repo.completeClarificationDigestSend;
  let reachedCompletion;
  const reached = new Promise((resolve) => { reachedCompletion = resolve; });
  let resumeCompletion;
  const gate = new Promise((resolve) => { resumeCompletion = resolve; });
  env.repo.completeClarificationDigestSend = async (input) => {
    env.repo.completeClarificationDigestSend = complete;
    reachedCompletion(input);
    await gate;
    return complete(input);
  };
  const stalledRun = flush(env, at(21));
  const stalled = await reached;
  assert.equal(sent(env).length, 1, 'SMTP accepted the email with c-1');
  assert.deepEqual(stalled.released.map((entry) => entry.id), [cx().id], 'the stalled owner decided to leave c-x out');

  await setStatus('open');
  const begin = env.repo.beginClarificationDigestSend;
  env.repo.beginClarificationDigestSend = async (input) => {
    env.repo.beginClarificationDigestSend = begin;
    resumeCompletion();
    await stalledRun;
    return begin(input);
  };
  assert.equal((await flush(env, at(42))).deferred, 1, 'the replacement claimed, then saw c-1 marked sent by the stalled completion');
  assert.equal(cx().scheduledAt, at(0).toISOString(), 'the obsolete owner did not release c-x');

  for (const now of [at(43), at(60), at(90)]) await flush(env, now);
  assert.equal(sent(env).length, 2);
  assert.ok(sent(env)[1].html.includes('Question c-x?') && !sent(env)[1].html.includes('Question c-1?'));
  assert.equal(cx().mailStatus, 'sent');

  // Store fences: an owner whose lease ran out releases and fails nothing, even with no
  // replacement yet, and a live owner's release only applies to the schedule it decided on.
  const fresh = await setup({ clarifications: [{ id: 'c-y' }], stakeholders: [{ email: 'uma@client.example', id: 's-1' }] });
  await assign(fresh, { clarificationId: 'c-y', now: at(0), stakeholderIds: ['s-1'] });
  const cy = { ...invitationsOf(fresh, 's-1')[0] };
  const expired = await fresh.repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(1), leaseUntil: at(41), now: at(21) });
  const release = { id: cy.id, reason: DIGEST_RELEASE_REASONS.topicClosed, scheduledAt: cy.scheduledAt };
  assert.deepEqual(await fresh.repo.failClarificationDigestAttempt({ ...recipient, claimToken: expired.claimToken, deliveryId: expired.deliveryId, error: 'late', invitationIds: [cy.id], maxAttempts: 1, now: at(42) }), { fenced: true });
  assert.deepEqual(await fresh.repo.releaseClarificationDigest({ ...recipient, claimToken: expired.claimToken, deliveryId: expired.deliveryId, now: at(42), released: [release] }), { fenced: true });
  assert.deepEqual([invitationsOf(fresh, 's-1')[0].scheduledAt, invitationsOf(fresh, 's-1')[0].mailStatus], [cy.scheduledAt, 'pending']);
  const owner = await fresh.repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(1), leaseUntil: at(70), now: at(50) });
  await fresh.repo.releaseClarificationDigest({ ...recipient, claimToken: owner.claimToken, deliveryId: owner.deliveryId, now: at(51), released: [{ ...release, scheduledAt: at(5).toISOString() }] });
  assert.equal(invitationsOf(fresh, 's-1')[0].scheduledAt, cy.scheduledAt, 'a release decided on another schedule changes nothing');
});

test('recheck finding 2: a topic that becomes eligible again before completion is not released by the stale decision', async () => {
  const env = await setup({ clarifications: [{ id: 'c-1' }, { id: 'c-x' }], stakeholders: [{ email: 'sam@client.example', id: 's-1' }] });
  await assign(env, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  await assign(env, { clarificationId: 'c-x', now: at(0), stakeholderIds: ['s-1'] });
  await env.repo.updateProjectClarification({ clarificationId: 'c-x', patch: { status: 'closed' }, projectId: 'p-a', tenantId: 't-1' });
  // c-x reopens while the email without it is being handed to SMTP.
  env.transport.hooks.push(() => env.repo.updateProjectClarification({ clarificationId: 'c-x', patch: { status: 'open' }, projectId: 'p-a', tenantId: 't-1' }));
  assert.equal((await flush(env, at(21))).sent, 1);
  assert.equal(sent(env)[0].html.includes('Question c-x?'), false);
  const cx = invitationsOf(env, 's-1').find((invitation) => invitation.clarificationId === 'c-x');
  assert.deepEqual([cx.scheduledAt, cx.queuedAt], [at(0).toISOString(), null], 'still scheduled');
  await flush(env, at(22));
  assert.equal(sent(env).length, 2);
  assert.ok(sent(env)[1].html.includes('Question c-x?'));
});

test('finding 2: the newest assignment\'s deadline holds until the actual send, across failures, recoveries and late claims', async () => {
  // The review's repro: assignment at 0, failed attempt at 21, new assignment at 30, recovery at 32.
  const env = await setup({ clarifications: [{ id: 'c-1' }, { id: 'c-2' }, { id: 'c-3' }], stakeholders: [{ email: 'sam@client.example', id: 's-1' }] });
  await assign(env, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  await assign(env, { clarificationId: 'c-2', now: at(0), stakeholderIds: ['s-1'] });
  env.transport.failures.push('451 temporary failure');
  await flush(env, at(21));
  await assign(env, { clarificationId: 'c-3', now: at(30), stakeholderIds: ['s-1'] });
  for (const now of [at(32), at(40), at(50)]) {
    await flush(env, now);
    assert.equal(sent(env).length, 0, `nothing before more than 20 minutes after the minute-30 assignment (${now.toISOString()})`);
  }
  await flush(env, at(50, 0, 1));
  assert.equal(sent(env).length, 1);
  assert.equal(sent(env)[0].subject, '3 clarifications need your input in Atlas', 'no topic lost, one batch');
  assert.ok(invitationsOf(env, 's-1').every((invitation) => invitation.mailStatus === 'sent'));

  // A new assignment after a successful claim, before the send, postpones the send.
  const late = await setup({ clarifications: [{ id: 'c-1' }, { id: 'c-2' }], stakeholders: [{ email: 'tia@client.example', id: 's-1' }] });
  await assign(late, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  const prepareState = late.repo.getProjectAssistantState;
  late.repo.getProjectAssistantState = async (input) => {
    late.repo.getProjectAssistantState = prepareState;
    await assign(late, { clarificationId: 'c-2', now: at(21), stakeholderIds: ['s-1'] });
    return prepareState(input);
  };
  assert.equal((await flush(late, at(21))).deferred, 1);
  assert.equal(sent(late).length, 0);
  assert.equal((await late.repo.getClarificationInvitationDigest(recipient)).claimToken, null, 'the postponed claim is released');
  await flush(late, at(41));
  assert.equal(sent(late).length, 0);
  await flush(late, at(41, 0, 1));
  assert.equal(sent(late)[0].subject, '2 clarifications need your input in Atlas');

  // A run that stopped after claiming is recovered only once the newest deadline has passed.
  const stopped = await setup({ clarifications: [{ id: 'c-1' }, { id: 'c-2' }], stakeholders: [{ email: 'uma@client.example', id: 's-1' }] });
  await assign(stopped, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  await stopped.repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(1), leaseUntil: new Date(at(21).getTime() + DIGEST_LEASE_MS), now: at(21) });
  await assign(stopped, { clarificationId: 'c-2', now: at(30), stakeholderIds: ['s-1'] });
  await flush(stopped, at(45));
  assert.equal(sent(stopped).length, 0, 'the stopped claim is still live');
  await flush(stopped, at(50));
  assert.equal(sent(stopped).length, 0, 'the claim has expired, but the minute-30 assignment is not 20 minutes old');
  await flush(stopped, at(50, 0, 1));
  assert.equal(sent(stopped)[0].subject, '2 clarifications need your input in Atlas');
});

test('finding 4: an owner whose lease expired is fenced out, and a slow owner\'s late completion changes nothing', async () => {
  const env = await setup({ clarifications: [{ id: 'c-1' }], stakeholders: [{ email: 'sam@client.example', id: 's-1' }] });
  await assign(env, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  const slow = await env.repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(1), leaseUntil: new Date(at(21).getTime() + DIGEST_LEASE_MS), now: at(21) });
  assert.ok(slow);
  assert.equal(await env.repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(2), leaseUntil: at(60), now: at(22) }), null, 'one live claim per recipient');

  // The slow owner's lease runs out; the replacement claims and sends.
  assert.equal((await flush(env, at(41, 1))).sent, 1);
  const delivered = { ...invitationsOf(env, 's-1')[0] };
  const begun = await env.repo.beginClarificationDigestSend({ ...recipient, claimToken: slow.claimToken, deliveryId: slow.deliveryId, dueBefore: at(30), leaseUntil: at(70), now: at(42), sendIds: [delivered.id] });
  assert.deepEqual(begun, { ok: false, reason: 'fenced' });
  assert.deepEqual(await env.repo.failClarificationDigestAttempt({ ...recipient, claimToken: slow.claimToken, deliveryId: slow.deliveryId, error: 'late', invitationIds: [delivered.id], maxAttempts: 3, now: at(43) }), { fenced: true });
  await env.repo.completeClarificationDigestSend({ ...recipient, claimToken: slow.claimToken, deliveryId: slow.deliveryId, now: at(44), sentIds: [delivered.id] });
  assert.deepEqual({ ...invitationsOf(env, 's-1')[0] }, delivered, 'already delivered: not re-marked');
  assert.equal(sent(env).length, 1);
});

test('finding 5: a stopped run is recovered after its lease, and an interrupted send is retried at least once (possible duplicate, logged)', async () => {
  // Stopped after claiming, before sending: recovered once the lease expires, with one email.
  const env = await setup({ clarifications: [{ id: 'c-1' }], stakeholders: [{ email: 'sam@client.example', id: 's-1' }] });
  await assign(env, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  const readState = env.repo.getProjectAssistantState;
  env.repo.getProjectAssistantState = async () => { throw new Error('process stopped'); };
  assert.equal((await flush(env, at(21))).errors, 1);
  env.repo.getProjectAssistantState = readState;
  assert.equal((await flush(env, at(30))).due, 0, 'the claim is live until its lease ends');
  await flush(env, at(41, 1));
  assert.equal(sent(env).length, 1);

  // Stopped after the send began: SMTP may have accepted it. The next owner sends again and logs why.
  const interrupted = await setup({ clarifications: [{ id: 'c-1' }], stakeholders: [{ email: 'tia@client.example', id: 's-1' }] });
  await assign(interrupted, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  interrupted.transport.hooks.push(async () => { throw new Error('process stopped after handing the message to SMTP'); });
  const events = [];
  const logger = { logError: () => {}, logEvent: (entry) => events.push(entry) };
  assert.equal((await flush(interrupted, at(21), { logger })).retried, 1, 'an error from the transport is treated as a retryable failure');
  // The truly ambiguous case: the process dies with the send begun and no failure recorded.
  const stuck = await setup({ clarifications: [{ id: 'c-1' }], stakeholders: [{ email: 'uma@client.example', id: 's-1' }] });
  await assign(stuck, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  const claim = await stuck.repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(1), leaseUntil: new Date(at(21).getTime() + DIGEST_LEASE_MS), now: at(21) });
  const invitationId = invitationsOf(stuck, 's-1')[0].id;
  assert.deepEqual(await stuck.repo.beginClarificationDigestSend({ ...recipient, claimToken: claim.claimToken, deliveryId: claim.deliveryId, dueBefore: at(1), leaseUntil: new Date(at(21).getTime() + DIGEST_LEASE_MS), now: at(21), sendIds: [invitationId] }), { ok: true });
  await flush(stuck, at(40));
  assert.equal(sent(stuck).length, 0, 'not while the in-flight send may still be running');
  await flush(stuck, at(41, 1), { logger });
  assert.equal(sent(stuck).length, 1);
  assert.ok(events.some((entry) => /may have been delivered/.test(entry.message)), 'the possible duplicate is logged');
});

test('retries: soft bounces retry with backoff up to three attempts; a hard bounce opts the address out at once', async () => {
  const env = await setup({ clarifications: [{ id: 'c-1' }, { id: 'c-2' }], stakeholders: [{ email: 'sam@client.example', id: 's-1' }] });
  await assign(env, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  env.transport.failures.push('421 busy', '421 busy');
  assert.equal((await flush(env, at(21))).retried, 1);
  assert.equal((await flush(env, at(26, 1))).retried, 1, 'second attempt after 5 minutes');
  assert.equal((await flush(env, at(30))).sent, 0, 'third attempt waits 10 minutes');
  assert.equal((await flush(env, at(36, 2))).sent, 1);
  assert.equal(invitationsOf(env, 's-1')[0].mailStatus, 'sent');

  await assign(env, { clarificationId: 'c-2', now: at(40), stakeholderIds: ['s-1'] });
  env.transport.failures.push('421 busy', '421 busy', '421 busy');
  await flush(env, at(61));
  await flush(env, at(66, 1));
  assert.equal((await flush(env, at(76, 2))).failed, 1, 'the third soft failure is final');
  const c2 = invitationsOf(env, 's-1').find((invitation) => invitation.clarificationId === 'c-2');
  assert.deepEqual([c2.mailStatus, Boolean(c2.queuedAt), c2.lastError], ['failed', true, '421 busy']);
  assert.equal(await env.repo.getClarificationInvitationDigest(recipient), null);

  const hard = await setup({ clarifications: [{ id: 'c-1' }], stakeholders: [{ email: 'nobody@client.example', id: 's-1' }] });
  await assign(hard, { clarificationId: 'c-1', now: at(0), stakeholderIds: ['s-1'] });
  hard.transport.failures.push('550 user unknown');
  assert.equal((await flush(hard, at(21))).failed, 1);
  assert.equal(await hard.mail.isOptedOut({ email: 'nobody@client.example' }), true);
  assert.equal(invitationsOf(hard, 's-1')[0].mailStatus, 'failed');
});

test('a save with expected recipients schedules exactly them in the same write; a scheduled invitation is not a new recipient', async () => {
  const env = await setup({ clarifications: [{ id: 'c-1' }], stakeholders: [{ email: 'sam@client.example', id: 's-1' }, { email: 'tia@client.example', id: 's-2' }] });
  const people = [{ actorId: 's-1', actorType: 'stakeholder', role: 'primary' }, { actorId: 's-2', actorType: 'stakeholder', role: 'collaborator' }];
  await assert.rejects(
    env.repo.updateProjectClarification({ clarificationId: 'c-1', patch: { assignments: people, expectedInvitationStakeholderIds: ['s-1'], scheduleInvitationsAt: at(0) }, projectId: 'p-a', tenantId: 't-1' }),
    (error) => error.statusCode === 409,
  );
  assert.equal(env.repo.state.projectClarificationInvitations.length, 0, 'nothing saved or scheduled');
  await env.repo.updateProjectClarification({ clarificationId: 'c-1', patch: { assignments: people, expectedInvitationStakeholderIds: ['s-1', 's-2'], scheduleInvitationsAt: at(0) }, projectId: 'p-a', tenantId: 't-1' });
  assert.ok(invitationsOf(env, 's-1')[0].scheduledAt && invitationsOf(env, 's-2')[0].scheduledAt);
  await assert.rejects(
    env.repo.updateProjectClarification({ clarificationId: 'c-1', patch: { assignments: people, expectedInvitationStakeholderIds: ['s-1'], scheduleInvitationsAt: at(5) }, projectId: 'p-a', tenantId: 't-1' }),
    (error) => error.statusCode === 409 && error.details.recipients.length === 0,
  );
  assert.equal(invitationsOf(env, 's-1')[0].scheduledAt, at(0).toISOString(), 'not reset');
});

test('a session commit that saved nothing schedules every never-sent invitation in its own project only', async () => {
  const env = await setup({ clarifications: [{ id: 'c-1' }, { id: 'c-2' }, { id: 'c-b', projectId: 'p-b' }], stakeholders: [{ email: 'sam@client.example', id: 's-1' }, { email: 'sam@client.example', id: 's-b', projectId: 'p-b' }] });
  for (const [id, projectId, stakeholder] of [['c-1', 'p-a', 's-1'], ['c-2', 'p-a', 's-1'], ['c-b', 'p-b', 's-b']]) {
    await env.repo.updateProjectClarification({ clarificationId: id, patch: { assignments: [{ actorId: stakeholder, actorType: 'stakeholder', role: 'primary' }] }, projectId, tenantId: 't-1' });
  }
  const scheduled = await scheduleClarificationInvitationDigests({ assistantRepository: env.repo, now: at(0), projectId: 'p-a', tenantId: 't-1' });
  assert.deepEqual(scheduled.map((invitation) => invitation.clarificationId).sort(), ['c-1', 'c-2']);
  assert.equal(invitationsOf(env, 's-b')[0].scheduledAt, null);
});

test('the digest email escapes names and links and sanitizes prompts', async () => {
  const message = await renderClarificationDigestEmail({
    digest: {
      projectName: 'Atlas <script>',
      stakeholderEmail: 'sam@client.example',
      stakeholderName: 'Sam <img src=x onerror=alert(1)>',
      topics: [
        { prompt: '<p>Pricing <script>alert(1)</script></p>', rationale: '', replyAddress: 'clarification+a@reply.example', url: 'https://app.example/clarifications/a?x=1&y="2"' },
        { prompt: 'Second', rationale: '<b>bold</b>', replyAddress: 'clarification+b@reply.example', url: 'https://app.example/clarifications/b' },
      ],
    },
    mailRepository: createInMemoryMailRepository(),
  });
  assert.equal(message.subject, '2 clarifications need your input in Atlas <script>');
  assert.equal(message.html.includes('<script>'), false);
  assert.equal(message.html.includes('<img src=x'), false);
  assert.ok(message.html.includes('href="https://app.example/clarifications/a?x=1&amp;y=&quot;2&quot;"'));
  assert.equal(message.replyTo, undefined);
});

/** SQL double for the MySQL store: records statements, scripts rows, can fail a statement. */
function sqlDouble({ invitationRows = [], digestRows = [], failOn = null } = {}) {
  const statements = [];
  const events = [];
  const connection = {
    async beginTransaction() { events.push('begin'); },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    release() {},
    async execute(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push({ params, text });
      if (failOn?.test(text)) throw Object.assign(new Error('injected failure'), failOn.code ? { code: failOn.code } : {});
      if (/information_schema\.(TABLES|COLUMNS)/.test(text)) return [[{ count: 1 }]];
      if (/information_schema\.KEY_COLUMN_USAGE/.test(text)) return [['tenant_id', 'project_id', 'id'].map((columnName) => ({ columnName }))];
      if (/^SELECT id FROM project_clarifications/.test(text)) return [[{ id: 'c-1' }]];
      if (/^SELECT .* FROM project_clarification_invitation_digests/.test(text)) return [digestRows];
      if (/^SELECT .* FROM project_clarification_invitations/.test(text)) return [invitationRows];
      return [{ affectedRows: 1 }];
    },
  };
  return { events, pool: { execute: (...args) => connection.execute(...args), getConnection: async () => connection }, statements };
}
const scheduledRow = { clarificationId: 'c-1', deactivatedAt: null, id: 'inv-1', mailStatus: 'pending', projectId: 'p-a', queuedAt: null, scheduledAt: at(0), stakeholderId: 's-1', tenantId: 't-1' };

test('MySQL: claims lock the recipient\'s rows, insert one delivery under a unique key, and every later step is fenced by the claim token', async () => {
  const double = sqlDouble({ invitationRows: [scheduledRow] });
  const repo = createMysqlAssistantRepository({ pool: double.pool });
  const claim = await repo.claimClarificationInvitationDigest({ ...recipient, dueBefore: at(20, 1), leaseUntil: at(41), now: at(21) });
  assert.ok(claim.claimToken);
  const texts = double.statements.map((statement) => statement.text);
  assert.match(texts.find((text) => /FROM project_clarification_invitations/.test(text)), /WHERE tenant_id = \? AND project_id = \? AND stakeholder_id = \? .*FOR UPDATE$/);
  assert.match(texts.find((text) => /FROM project_clarification_invitation_digests/.test(text)), /WHERE tenant_id = \? AND project_id = \? AND stakeholder_id = \? FOR UPDATE$/);
  assert.ok(texts.findIndex((text) => /FROM project_clarification_invitations/.test(text)) < texts.findIndex((text) => /FROM project_clarification_invitation_digests/.test(text)), 'invitation rows are locked first');
  assert.match(texts.find((text) => /^INSERT INTO project_clarification_invitation_digests/.test(text)), /claim_token, claimed_until/);
  assert.deepEqual(double.events, ['begin', 'commit']);

  // A concurrent creator wins the unique key: this claim backs off.
  const duplicate = sqlDouble({ failOn: Object.assign(/^INSERT INTO project_clarification_invitation_digests/, { code: 'ER_DUP_ENTRY' }), invitationRows: [scheduledRow] });
  assert.equal(await createMysqlAssistantRepository({ pool: duplicate.pool }).claimClarificationInvitationDigest({ ...recipient, dueBefore: at(20, 1), leaseUntil: at(41), now: at(21) }), null);

  // A live claim or a pending retry blocks; a stale one is taken over with a new token.
  const live = sqlDouble({ digestRows: [{ attempts: 0, claimToken: 'other', claimedUntil: at(30), id: 'd-1' }], invitationRows: [scheduledRow] });
  assert.equal(await createMysqlAssistantRepository({ pool: live.pool }).claimClarificationInvitationDigest({ ...recipient, dueBefore: at(20, 1), leaseUntil: at(41), now: at(21) }), null);
  const stale = sqlDouble({ digestRows: [{ attempts: 1, claimToken: 'other', claimedUntil: at(10), id: 'd-1', sendStartedAt: at(5) }], invitationRows: [scheduledRow] });
  const takeover = await createMysqlAssistantRepository({ pool: stale.pool }).claimClarificationInvitationDigest({ ...recipient, dueBefore: at(20, 1), leaseUntil: at(41), now: at(21) });
  assert.deepEqual([takeover.deliveryId, takeover.attempts, takeover.interruptedSend], ['d-1', 1, true]);

  // Begin, complete, fail and release are compare-and-set on the claim token.
  const owned = sqlDouble({ digestRows: [{ attempts: 0, claimToken: claim.claimToken, claimedUntil: at(41), id: claim.deliveryId }], invitationRows: [scheduledRow] });
  const ownedRepo = createMysqlAssistantRepository({ pool: owned.pool });
  assert.deepEqual(await ownedRepo.beginClarificationDigestSend({ ...recipient, claimToken: claim.claimToken, deliveryId: claim.deliveryId, dueBefore: at(20, 1), leaseUntil: at(42), now: at(22), sendIds: ['inv-1'] }), { ok: true });
  assert.deepEqual(await ownedRepo.beginClarificationDigestSend({ ...recipient, claimToken: 'stale-token', deliveryId: claim.deliveryId, dueBefore: at(20, 1), leaseUntil: at(42), now: at(22), sendIds: ['inv-1'] }), { ok: false, reason: 'fenced' });
  assert.deepEqual(await ownedRepo.beginClarificationDigestSend({ ...recipient, claimToken: claim.claimToken, deliveryId: claim.deliveryId, dueBefore: at(0), leaseUntil: at(42), now: at(22), sendIds: ['inv-1'] }), { ok: false, reason: 'not-due' });
  await ownedRepo.completeClarificationDigestSend({ ...recipient, claimToken: claim.claimToken, deliveryId: claim.deliveryId, now: at(23), sentIds: ['inv-1'] });
  const writes = owned.statements.map((statement) => statement.text);
  assert.ok(writes.some((text) => /^UPDATE project_clarification_invitation_digests SET claimed_until = \?, send_started_at = \?.*WHERE id = \? AND claim_token = \?$/.test(text)));
  assert.ok(writes.some((text) => /^UPDATE project_clarification_invitations SET mail_status = 'sent'.*WHERE tenant_id = \? AND project_id = \? AND queued_at IS NULL AND id IN/.test(text)));
  assert.ok(writes.some((text) => /^DELETE FROM project_clarification_invitation_digests WHERE id = \? AND claim_token = \?$/.test(text)));
});

test('finding 3 (MySQL): scheduling runs inside the save\'s transaction, and its failure rolls the whole save back', async () => {
  const people = [{ actorId: 's-1', actorType: 'stakeholder', role: 'primary' }];
  const failing = sqlDouble({ failOn: /^UPDATE project_clarification_invitations SET scheduled_at = \?/, invitationRows: [{ ...scheduledRow, scheduledAt: null }] });
  await assert.rejects(createMysqlAssistantRepository({ pool: failing.pool }).updateProjectClarification({ clarificationId: 'c-1', patch: { assignments: people, scheduleInvitationsAt: at(0) }, projectId: 'p-a', tenantId: 't-1' }), /injected failure/);
  assert.deepEqual(failing.events, ['begin', 'rollback'], 'the assignment rows are rolled back with it');
  const texts = failing.statements.map((statement) => statement.text);
  assert.ok(texts.findIndex((text) => /^INSERT INTO project_clarification_assignments/.test(text)) < texts.findIndex((text) => /scheduled_at IS NULL FOR UPDATE$/.test(text)), 'one transaction: assignments, then scheduling');

  const syncFailing = sqlDouble({ failOn: /^UPDATE project_clarification_invitations SET scheduled_at = \?/, invitationRows: [{ ...scheduledRow, scheduledAt: null }] });
  const repo = createMysqlAssistantRepository({ pool: syncFailing.pool });
  repo.getProjectAssistantState = async () => ({ clarifications: [], stakeholders: [] });
  await assert.rejects(repo.syncProjectClarifications({ clarifications: [], projectId: 'p-a', scheduleInvitations: { at: at(0), clarificationIds: null }, tenantId: 't-1' }), /injected failure/);
  assert.deepEqual(syncFailing.events, ['begin', 'rollback']);
});
