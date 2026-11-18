import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { flushDueMentionDigests, MENTION_RELEASE_REASONS } from '../src/modules/requirements/mentions/mention-digest.service.js';
import {
  mentionedActors,
  mentionExcerpt,
  mentionsToPlainText,
  parseMentionTokens,
  portalMentionKey,
  resolveMentions,
  toPortalMentions,
} from '../src/modules/requirements/mentions/mention-tokens.js';
import { createRequirementsTestApp, PROJECT_ID, ROLE_USERS } from './helpers/requirements-test-app.js';
import { createRoundsTestApp, roundPackageFiles, ROLE_USERS as ROUND_USERS } from './helpers/requirements-rounds-app.js';

const tag = (name, ref) => `@[${name}](${ref})`;
const pin = (x, y) => ({ number: 1, schemaVersion: 1, style: { color: '#C2410C', stroke: 4 }, type: 'pin', x, y });

function outbox() {
  return { sent: [], async sendMail(message) { this.sent.push(message); return { messageId: `<mention-${this.sent.length}@fixture>` }; } };
}

/** Runs the mail job's mention digest step `afterMinutes` from now. */
function deliver(harness, { afterMinutes = 21, authRepository = harness.authRepository ?? null, mailRepository, transport }) {
  return flushDueMentionDigests({
    assistantRepository: harness.assistantRepository,
    authRepository,
    frontendAppUrl: 'http://localhost:5173/app',
    mailRepository,
    mentionsRepository: harness.app.locals.mentionsRepository,
    now: () => new Date(Date.now() + (harness.clock?.offsetMs ?? 0) + afterMinutes * 60_000),
    projectRepository: harness.projectRepository,
    roundsRepository: harness.app.locals.roundsRepository,
    transport,
  });
}

function mentionRows(harness) {
  return harness.app.locals.mentionsRepository.state.mentions;
}

test('tokens: parse, plain text, portal keys, resolution, and excerpts', () => {
  const body = `Hi ${tag('Uma User', 'user:u1')} and ${tag('Jamie', 'stakeholder:s1')}, ${tag('Uma User', 'user:u1')} again.`;
  assert.deepEqual(parseMentionTokens(body).map((token) => [token.kind, token.id]), [['user', 'u1'], ['stakeholder', 's1'], ['user', 'u1']]);
  assert.deepEqual(mentionedActors(body).map((entry) => entry.actorRef), ['user:u1', 'stakeholder:s1']);
  assert.equal(mentionsToPlainText(body), 'Hi @Uma User and @Jamie, @Uma User again.');

  const portal = toPortalMentions(body, 'p1');
  assert.equal(portal.includes('u1'), false, 'no actor id reaches the portal');
  assert.ok(portal.includes(`(person:${portalMentionKey('p1', 'user:u1')})`));

  const people = [{ actorId: 'u1', actorType: 'user', name: 'Uma User' }, { actorId: 's1', actorType: 'stakeholder', name: 'Jamie Ortiz' }];
  // Team: actor refs resolve, portal keys and unknown people become plain text, names refresh.
  const team = resolveMentions(`${tag('Old name', 'user:u1')} ${tag('Ghost', 'user:nobody')} ${tag('Jamie', `person:${portalMentionKey('p1', 'stakeholder:s1')}`)}`, { people, projectId: 'p1' });
  assert.equal(team.body, `${tag('Uma User', 'user:u1')} @Ghost @Jamie`);
  assert.deepEqual(team.mentioned.map((entry) => entry.actorRef), ['user:u1']);
  // Portal: only portal keys resolve, back to actor refs.
  const fromPortal = resolveMentions(`${tag('Jamie', `person:${portalMentionKey('p1', 'stakeholder:s1')}`)} ${tag('Uma', 'user:u1')}`, { audience: 'portal', people, projectId: 'p1' });
  assert.equal(fromPortal.body, `${tag('Jamie Ortiz', 'stakeholder:s1')} @Uma`);

  // Brackets and newlines in a name cannot break the token.
  assert.equal(resolveMentions(tag('x', 'user:u9'), { people: [{ actorId: 'u9', actorType: 'user', name: 'A ]b[\nc' }] }).body, tag('A b c', 'user:u9'));

  // Comments are Markdown; emails quote them as plain text.
  assert.equal(mentionExcerpt(`**Hi** ${tag('Uma User', 'user:u1')} & see *this*`, 'user:u1'), 'Hi @Uma User & see this');

  const long = `${'word '.repeat(80)}${tag('Uma User', 'user:u1')} ${'tail '.repeat(80)}`;
  const excerpt = mentionExcerpt(long, 'user:u1');
  assert.ok(excerpt.includes('@Uma User'));
  assert.ok(excerpt.startsWith('…') && excerpt.endsWith('…'));
});

test('team topic comments: tags resolve, hidden stakeholders join the topic, and edits notify only added people', async () => {
  const harness = await createRequirementsTestApp();
  const jamie = await harness.seedStakeholder();
  const casey = await harness.seedStakeholder({ email: 'casey@client.example', name: 'Casey Lin' });
  const topic = await harness.createTopic({ assignments: [{ actorId: casey.id, actorType: 'stakeholder' }], prompt: 'Where should the price first appear?' });

  const mentionables = await harness.as('member').get(`/topics/${topic.id}/mentionables`);
  assert.equal(mentionables.status, 200, JSON.stringify(mentionables.body));
  const refs = mentionables.body.people.map((person) => person.ref);
  assert.ok(refs.includes(`user:${ROLE_USERS.user.id}`));
  assert.ok(refs.includes(`stakeholder:${jamie.id}`));
  assert.equal(refs.includes(`user:${ROLE_USERS.member.id}`), false, 'the writer is not in their own list');
  assert.equal(refs.includes(`user:${ROLE_USERS.tenantAdmin.id}`), false, 'only project members');
  assert.equal((await harness.as('viewer').get(`/topics/${topic.id}/mentionables`)).status, 404, 'viewers cannot comment, so they get no list');

  const created = await harness.as('member').post(`/topics/${topic.id}/comments`, {
    body: `Thoughts ${tag('Uma', `user:${ROLE_USERS.user.id}`)} and ${tag('Jamie', `stakeholder:${jamie.id}`)}? cc ${tag('Otto', `user:${ROLE_USERS.outsider.id}`)}`,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const stored = created.body.topic.comments.at(-1);
  assert.equal(stored.body, `Thoughts ${tag('Uma User', `user:${ROLE_USERS.user.id}`)} and ${tag('Jamie Ortiz', `stakeholder:${jamie.id}`)}? cc @Otto`);

  // Jamie couldn't see the topic, so the tag added her as a collaborator (her invitation
  // digest covers it) and she gets no separate mention.
  const assignments = created.body.topic.assignments.map((assignment) => [assignment.actorId, assignment.role]);
  assert.deepEqual(assignments.sort(), [[casey.id, 'collaborator'], [jamie.id, 'collaborator']].sort());
  assert.ok(created.body.topic.assignments.find((assignment) => assignment.actorId === jamie.id).scheduledAt, 'her invitation waits in the digest');
  assert.deepEqual(mentionRows(harness).map((row) => [row.recipientType, row.recipientId, row.sourceType, row.topicId]), [['user', ROLE_USERS.user.id, 'topic', topic.id]]);

  // Casey already sees the topic, so tagging her records a mention.
  const caseyTag = await harness.as('member').post(`/topics/${topic.id}/comments`, { body: `${tag('Casey', `stakeholder:${casey.id}`)} can you confirm?` });
  assert.equal(caseyTag.status, 201);
  assert.equal(mentionRows(harness).filter((row) => row.recipientId === casey.id).length, 1);

  // An edit notifies only the people it adds.
  const commentId = stored.id;
  const edited = await harness.as('member').patch(`/topics/${topic.id}/comments/${commentId}`, {
    body: `${stored.body} and ${tag('Pia', `user:${ROLE_USERS.projectManager.id}`)}`,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const forComment = mentionRows(harness).filter((row) => row.commentId === commentId).map((row) => row.recipientId).sort();
  assert.deepEqual(forComment, [ROLE_USERS.projectManager.id, ROLE_USERS.user.id].sort());

  // Tagging yourself notifies nobody.
  await harness.as('member').post(`/topics/${topic.id}/comments`, { body: `Note to ${tag('me', `user:${ROLE_USERS.member.id}`)}` });
  assert.equal(mentionRows(harness).some((row) => row.recipientId === ROLE_USERS.member.id), false);
});

test('portal topic comments: no ids reach the portal, and stakeholders tag only people on the topic', async () => {
  const harness = await createRequirementsTestApp();
  const jamie = await harness.seedStakeholder();
  const casey = await harness.seedStakeholder({ email: 'casey@client.example', name: 'Casey Lin' });
  const topic = await harness.createTopic({ assignments: [{ actorId: jamie.id, actorType: 'stakeholder' }, { actorId: casey.id, actorType: 'stakeholder' }], prompt: 'Which reminder channels do clients want?' });
  await harness.as('member').post(`/topics/${topic.id}/comments`, { body: `${tag('Jamie', `stakeholder:${jamie.id}`)} what do clients ask for?` });
  const { token } = await harness.createLink(jamie.id);

  const detail = await harness.portal(token).get(`/topics/${topic.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  const serialized = JSON.stringify(detail.body);
  assert.equal(serialized.includes(jamie.id), false, 'no stakeholder id in the portal');
  assert.equal(serialized.includes(ROLE_USERS.member.id), false, 'no user id in the portal');
  assert.match(detail.body.topic.comments[0].body, /^@\[Jamie Ortiz\]\(person:[0-9a-f]{20}\) what do clients ask for\?$/);

  const mentionables = await harness.portal(token).get(`/topics/${topic.id}/mentionables`);
  assert.equal(mentionables.status, 200, JSON.stringify(mentionables.body));
  assert.deepEqual(mentionables.body.people.map((person) => [person.name, person.kind]), [['Casey Lin', 'stakeholder'], ['Mona Member', 'team']]);
  assert.equal(JSON.stringify(mentionables.body).includes(ROLE_USERS.member.id), false);

  const mona = mentionables.body.people.find((person) => person.name === 'Mona Member');
  const posted = await harness.portal(token).post(`/topics/${topic.id}/comments`, {
    body: `${tag('Mona', mona.ref)} email and text. ${tag('Uma', `user:${ROLE_USERS.user.id}`)}`,
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.equal(posted.body.comment.body, `${tag('Mona Member', mona.ref)} email and text. @Uma`, 'the portal gets its own tags back, and raw ids do not resolve');
  const stored = (await harness.as('member').get(`/topics/${topic.id}`)).body.topic.comments.at(-1);
  assert.equal(stored.body, `${tag('Mona Member', `user:${ROLE_USERS.member.id}`)} email and text. @Uma`);
  assert.deepEqual(
    mentionRows(harness).filter((row) => row.authorType === 'stakeholder').map((row) => [row.recipientType, row.recipientId, row.authorName]),
    [['user', ROLE_USERS.member.id, 'Jamie Ortiz']],
  );
});

test('mention digests: one email per person after the quiet period, re-checked before sending', async () => {
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository });
  const casey = await harness.seedStakeholder({ email: 'casey@client.example', name: 'Casey Lin' });
  const first = await harness.createTopic({ prompt: 'Where should the price first appear?' });
  const second = await harness.createTopic({ prompt: 'Which reminder channels do clients want?' });
  const uma = `user:${ROLE_USERS.user.id}`;

  await harness.as('member').post(`/topics/${first.id}/comments`, { body: `${tag('Uma', uma)} please check the pricing copy.` });
  await harness.as('editor').post(`/topics/${second.id}/comments`, { body: `${tag('Uma', uma)} and ${tag('Casey', `stakeholder:${casey.id}`)}: reminders?` });
  const doomed = await harness.as('member').post(`/topics/${second.id}/comments`, { body: `${tag('Pia', `user:${ROLE_USERS.projectManager.id}`)} ignore this` });
  await harness.as('member').del(`/topics/${second.id}/comments/${doomed.body.comment.id}`);
  await harness.as('member').post(`/topics/${second.id}/comments`, { body: `${tag('Cora', `user:${ROLE_USERS.contributor.id}`)} FYI` });
  const cora = harness.authRepository.state.users.find((user) => user.id === ROLE_USERS.contributor.id);
  cora.preferences = { ...cora.preferences, emailNotifMentions: false, notificationPrefsVersion: 1 };

  const transport = outbox();
  const early = await deliver(harness, { afterMinutes: 5, mailRepository, transport });
  assert.equal(early.due, 0);
  assert.equal(transport.sent.length, 0, 'nothing before the quiet period');

  const summary = await deliver(harness, { mailRepository, transport });
  // Uma and Casey for their tags, and Eddie, who commented on the second topic first, for
  // the reply after his comment. The reply that was removed is not sent.
  assert.equal(summary.sent, 3, JSON.stringify(summary));
  assert.equal(transport.sent.length, 3);
  const toEddie = transport.sent.find((message) => message.to === `${ROLE_USERS.editor.id}@acme.com`);
  assert.equal(toEddie.subject, 'Mona Member replied on a topic in Client booking');
  assert.equal(mentionRows(harness).find((row) => row.commentId === doomed.body.comment.id && row.recipientId === ROLE_USERS.editor.id).lastError, MENTION_RELEASE_REASONS.commentRemoved);
  assert.equal(mailRepository.state.queue.length, 0, 'digests never use the shared queue');

  const toUma = transport.sent.find((message) => message.to === `${ROLE_USERS.user.id}@acme.com`);
  assert.equal(toUma.subject, 'You were mentioned 2 times in Client booking');
  assert.ok(toUma.html.includes('Mona Member mentioned you'));
  assert.ok(toUma.html.includes('Eddie Editor mentioned you'));
  assert.match(toUma.html, /<div class="comment"><p><strong>@Uma User<\/strong> please check the pricing copy\.<\/p>\s*<\/div>/, 'short comments are quoted whole, formatted');
  assert.ok(toUma.html.includes(`http://localhost:5173/app/projects/${PROJECT_ID}/requirements/topics/${first.id}`));
  assert.equal(toUma.html.includes('user:'), false, 'excerpts are plain text');

  const toCasey = transport.sent.find((message) => message.to === 'casey@client.example');
  assert.equal(toCasey.subject, 'Eddie Editor mentioned you in Client booking');
  const portalUrl = /http:\/\/localhost:5173\/app\/requirements\/([A-Za-z0-9_-]{43})\/questions\/([0-9a-f-]{36})/.exec(toCasey.html);
  assert.ok(portalUrl, 'stakeholders get a portal link to the question');
  assert.equal(portalUrl[2], second.id);
  assert.equal((await harness.portal(portalUrl[1]).get(`/topics/${second.id}`)).status, 200, 'the emailed link opens it');

  const byRecipient = Object.fromEntries(mentionRows(harness).map((row) => [row.recipientId, [row.status, row.lastError]]));
  assert.deepEqual(byRecipient[ROLE_USERS.projectManager.id], ['released', MENTION_RELEASE_REASONS.commentRemoved]);
  assert.deepEqual(byRecipient[ROLE_USERS.contributor.id], ['released', MENTION_RELEASE_REASONS.mentionsOff]);
  assert.equal(byRecipient[ROLE_USERS.user.id][0], 'sent');
  assert.equal(byRecipient[casey.id][0], 'sent');

  // Sent mentions are not sent again.
  assert.equal((await deliver(harness, { afterMinutes: 60, mailRepository, transport })).due, 0);
});

test('topic replies: the owner and earlier commenters get new comments in the same digest', async () => {
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository });
  const pia = ROLE_USERS.projectManager.id;
  const topic = await harness.createTopic({ assignments: [{ actorId: pia, actorType: 'user', role: 'primary' }], prompt: 'Where should the price first appear?' });
  const other = await harness.createTopic({ prompt: 'Which reminder channels do clients want?' });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const post = async (role, topicId, body) => {
    const response = await harness.as(role).post(`/topics/${topicId}/comments`, { body });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    await tick();
    return response.body.comment;
  };

  await post('editor', topic.id, 'On the plan picker.');
  await post('contributor', topic.id, 'Agreed.');
  await post('user', topic.id, 'Maybe the cart too.');
  const reply = await post('member', topic.id, ['| Option | Price shown |', '| --- | --- |', '| Plan picker | Yes |'].join('\n'));
  const forReply = mentionRows(harness).filter((row) => row.commentId === reply.id);
  assert.deepEqual(forReply.map((row) => [row.recipientId, row.reason]).sort(), [
    [ROLE_USERS.contributor.id, 'reply'], [ROLE_USERS.editor.id, 'reply'], [pia, 'reply'], [ROLE_USERS.user.id, 'reply'],
  ].sort(), 'the owner and everyone who commented, not the writer');

  // Tagging someone in an edit turns their reply into a mention.
  const tagged = await harness.as('member').patch(`/topics/${topic.id}/comments/${reply.id}`, { body: `${reply.body}\n\n${tag('Uma', `user:${ROLE_USERS.user.id}`)} thoughts?` });
  assert.equal(tagged.status, 200, JSON.stringify(tagged.body));
  assert.equal(mentionRows(harness).find((row) => row.commentId === reply.id && row.recipientId === ROLE_USERS.user.id).reason, 'mention');

  // Cora has commented since, so she has seen it; Eddie also gets a tag on another topic.
  await post('contributor', topic.id, 'Plan picker it is.');
  await post('member', other.id, `${tag('Eddie', `user:${ROLE_USERS.editor.id}`)} SMS?`);
  const uma = harness.authRepository.state.users.find((user) => user.id === ROLE_USERS.user.id);
  uma.preferences = { ...uma.preferences, emailNotifTopicReplies: false, notificationPrefsVersion: 1 };

  const transport = outbox();
  const summary = await deliver(harness, { mailRepository, transport });
  assert.equal(summary.errors, 0, JSON.stringify(summary));
  const to = (role) => transport.sent.find((message) => message.to === `${ROLE_USERS[role].id}@acme.com`);

  const toPia = to('projectManager');
  assert.equal(toPia.subject, '5 new replies on your topics in Client booking', 'every comment on the topic she owns');
  assert.ok(toPia.html.includes('Eddie Editor replied on a topic you own'));
  assert.ok(toPia.html.includes('Mona Member replied on a topic you own'), toPia.html);
  assert.ok(toPia.html.includes('Cora Contributor replied on a topic you own'));
  assert.ok(toPia.html.includes('<table style="border-collapse:collapse;margin:0 0 8px">'), 'the reply is quoted with its table');
  assert.ok(toPia.html.includes(`/requirements/topics/${topic.id}`));

  const toEddie = to('editor');
  assert.equal(toEddie.subject, '5 new comments for you in Client booking');
  assert.ok(toEddie.html.includes('Mona Member mentioned you'));
  assert.ok(toEddie.html.includes('Mona Member replied on a topic you commented on'));
  assert.ok(toEddie.html.includes('You were mentioned once, and there are 4 new replies on topics you own or commented on'), toEddie.html);

  // Uma's tag still goes out though she turned reply emails off; her replies do not.
  const toUma = to('user');
  assert.equal(toUma.subject, 'Mona Member mentioned you in Client booking');
  const umaRows = mentionRows(harness).filter((row) => row.recipientId === ROLE_USERS.user.id);
  assert.ok(umaRows.filter((row) => row.reason === 'reply').every((row) => row.lastError === MENTION_RELEASE_REASONS.repliesOff));

  const coraOnReply = mentionRows(harness).find((row) => row.commentId === reply.id && row.recipientId === ROLE_USERS.contributor.id);
  assert.deepEqual([coraOnReply.status, coraOnReply.lastError], ['released', MENTION_RELEASE_REASONS.repliedSince]);
});

test('mention digests: each new mention pushes the digest back, edits that drop a tag release it, and failures retry', async () => {
  const mailRepository = createInMemoryMailRepository();
  const harness = await createRequirementsTestApp({ mailRepository });
  const topic = await harness.createTopic({ prompt: 'Where should the price first appear?' });
  const uma = `user:${ROLE_USERS.user.id}`;
  const pia = `user:${ROLE_USERS.projectManager.id}`;

  await harness.as('member').post(`/topics/${topic.id}/comments`, { body: `${tag('Uma', uma)} one` });
  harness.clock.offsetMs = 15 * 60_000;
  await harness.as('member').post(`/topics/${topic.id}/comments`, { body: `${tag('Uma', uma)} two` });
  const transport = outbox();
  // 21 minutes after the first mention is only 6 after the second.
  await deliver(harness, { afterMinutes: 6, mailRepository, transport });
  assert.equal(transport.sent.length, 0);

  const dropped = await harness.as('member').post(`/topics/${topic.id}/comments`, { body: `${tag('Pia', pia)} draft` });
  await harness.as('member').patch(`/topics/${topic.id}/comments/${dropped.body.comment.id}`, { body: 'draft, never mind' });

  const failing = { attempts: 0, async sendMail() { this.attempts += 1; throw new Error('421 temporary failure'); } };
  const failed = await deliver(harness, { afterMinutes: 21, mailRepository, transport: failing });
  assert.equal(failed.retried, 1, JSON.stringify(failed));
  const recipient = { projectId: PROJECT_ID, recipientId: ROLE_USERS.user.id, recipientType: 'user', tenantId: 'tenant-acme' };
  assert.equal((await harness.app.locals.mentionsRepository.getMentionDigest(recipient)).attempts, 1);

  // The retry waits five minutes, then sends both mentions in one email.
  await deliver(harness, { afterMinutes: 23, mailRepository, transport });
  assert.equal(transport.sent.length, 0);
  await deliver(harness, { afterMinutes: 27, mailRepository, transport });
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].subject, 'You were mentioned 2 times in Client booking');
  const pias = mentionRows(harness).find((row) => row.recipientId === ROLE_USERS.projectManager.id);
  assert.deepEqual([pias.status, pias.lastError], ['released', MENTION_RELEASE_REASONS.untagged]);
});

test('annotation threads: the team tags members and round reviewers; the portal tags the thread, author, and publisher', async () => {
  const harness = await createRoundsTestApp();
  const priceTopic = await harness.createTopic('Where should the price first appear?');
  const pkg = await harness.uploadPackage(roundPackageFiles({ priceTopicId: priceTopic.id }));
  const jamie = await harness.seedStakeholder({ email: 'jamie@client.example', name: 'Jamie Ortiz' });
  const casey = await harness.seedStakeholder({ email: 'casey@client.example', name: 'Casey Lin' });
  const outside = await harness.seedStakeholder({ email: 'sam@client.example', name: 'Sam Outside' });
  const { round } = await harness.publish({
    packageId: pkg.id,
    reviewers: [
      { actorId: ROUND_USERS.reviewer.id, actorType: 'user', required: true },
      { actorId: jamie.id, actorType: 'stakeholder', required: true },
      { actorId: casey.id, actorType: 'stakeholder' },
    ],
  });
  const links = harness.portalLinksInMail();
  const tokenFor = (stakeholder) => links.find((link) => link.recipient === stakeholder.email).token;

  const jamieReview = harness.portal(tokenFor(jamie), round.id);
  const annotationId = randomUUID();
  assert.equal((await jamieReview.put(`/annotations/${annotationId}`, { screenId: 'home', shapes: [pin(10, 10)] })).status, 201);

  const mona = harness.team('member', round.id);
  const teamPeople = (await mona.get(`/annotations/${annotationId}/mentionables`)).body.people.map((person) => person.ref);
  assert.ok(teamPeople.includes(`stakeholder:${jamie.id}`));
  assert.ok(teamPeople.includes(`user:${ROUND_USERS.reviewer.id}`));
  assert.equal(teamPeople.includes(`stakeholder:${outside.id}`), false, 'stakeholders who are not reviewers on the round');

  const posted = await mona.post(`/annotations/${annotationId}/comments`, {
    body: `${tag('Jamie', `stakeholder:${jamie.id}`)} ${tag('Sam', `stakeholder:${outside.id}`)} is this the price?`,
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.equal(posted.body.comment.body, `${tag('Jamie Ortiz', `stakeholder:${jamie.id}`)} @Sam is this the price?`);

  // Casey sees the thread with portal keys, and can tag its author, its commenters and the publisher.
  const caseyReview = harness.portal(tokenFor(casey), round.id);
  const caseyState = await caseyReview.get();
  const thread = caseyState.body.annotations.find((annotation) => annotation.id === annotationId).thread;
  assert.match(thread[0].body, /^@\[Jamie Ortiz\]\(person:[0-9a-f]{20}\) @Sam is this the price\?$/);
  const caseyPeople = (await caseyReview.get(`/annotations/${annotationId}/mentionables`)).body.people;
  assert.deepEqual(caseyPeople.map((person) => person.name), ['Jamie Ortiz', 'Mona Member']);
  const jamieRef = caseyPeople.find((person) => person.name === 'Jamie Ortiz').ref;
  assert.equal((await caseyReview.post(`/annotations/${annotationId}/comments`, { body: `${tag('Jamie', jamieRef)} agreed` })).status, 201);

  const rows = mentionRows(harness).map((row) => [row.sourceType, row.recipientId, row.authorName, row.roundId, row.annotationId]);
  assert.deepEqual(rows, [
    ['annotation', jamie.id, 'Mona Member', round.id, annotationId],
    ['annotation', jamie.id, 'Casey Lin', round.id, annotationId],
  ]);

  // Jamie's digest links to the round in the portal.
  const mailRepository = createInMemoryMailRepository();
  const transport = outbox();
  await deliver(harness, { authRepository: null, mailRepository, transport });
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].to, 'jamie@client.example');
  assert.match(transport.sent[0].html, new RegExp(`/requirements/[A-Za-z0-9_-]{43}/rounds/${round.id}`));
  assert.ok(transport.sent[0].html.includes(`Review round ${round.number}`));
});
