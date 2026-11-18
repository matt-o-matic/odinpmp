import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { mediaFreeText, mediaKindOf, toolOutputFor, withoutMedia } from '../src/lib/agent/agent-media.js';
import { truncateOutput } from '../src/lib/agent/agent-tools.js';
import { keptItems } from '../src/lib/agent/agent-transcript.js';
import { createTokenService } from '../src/lib/auth/token-service.js';
import { createLiveEventBus } from '../src/lib/events/live-event-bus.js';
import { createLocalFileStorage } from '../src/lib/files/file-storage.js';
import { mcpMediaContent } from '../src/mcp/server.js';
import { createInMemoryAgentChatsRepository } from '../src/modules/assistant/agent-chats.repository.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectChangeLog } from '../src/modules/changes/project-change-log.js';
import { imageNoteLines, pickTurnImages, TURN_IMAGE_LIMIT } from '../src/modules/channels/odin-images.js';
import { normalizeOdinTags, ODIN_TOKEN } from '../src/modules/channels/odin-tag.js';
import { createInMemoryComplianceRepository } from '../src/modules/compliance/compliance.repository.js';
import { createInMemoryMailRepository } from '../src/modules/mail/mail.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createInMemorySessionsRepository } from '../src/modules/sessions/sessions.repository.js';
import { agentAppDeps, listen, scriptedOpenAi } from './helpers/agent-test-utils.js';

// Odin's vision: a tag sees the images on its post and its thread, guests' images are screened
// first, odin_view_project_file shows the model a file, and no image bytes are kept in the chat,
// the transcript or a paused turn.

const TENANT_ID = 'tenant-acme';
const PROJECT = 'project-vision';
const P = `/api/projects/${PROJECT}`;
const LEAD = { id: 'user-lead', name: 'Lena Lead' };
const GUEST = { email: 'gus@client.example', name: 'Gus Guest', stakeholderId: 'stakeholder-gus' };
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const tag = (text) => `${ODIN_TOKEN} ${text}`;

async function fixture(t, { decisionsAvailable = true, steps = [] } = {}) {
  const scripted = scriptedOpenAi({ decisionsAvailable, steps });
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: [{ authMethod: 'basic', email: 'lead@acme.example', id: LEAD.id, memberships: [{ role: 'user', tenantId: TENANT_ID }], name: LEAD.name, password: 'Fixture-password-123!', role: 'user' }],
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'odin-vision-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const storage = createLocalFileStorage({ rootDir: root });
  const mailRepository = createInMemoryMailRepository();
  const projectRepository = createInMemoryProjectsRepository({
    authRepository, changeLog: createInMemoryProjectChangeLog(), fileStorage: storage, mailRepository,
    seed: {
      projectMemberships: { [PROJECT]: [{ email: 'lead@acme.example', id: LEAD.id, name: LEAD.name, role: 'admin' }] },
      projects: [{ epics: [], id: PROJECT, name: 'Vision pursuit', status: 'In Progress', tenantId: TENANT_ID }],
    },
  });
  const agentChatsRepository = createInMemoryAgentChatsRepository();
  const sessionsRepository = createInMemorySessionsRepository();
  const tokenService = createTokenService({ issuer: 'odin-vision-fixture', secret: 'disposable-odin-vision-secret' });
  const app = createApp({
    ...agentAppDeps(scripted),
    accessReviewCampaignSweepIntervalMs: 0, agentMonitorSweepIntervalMs: 0, assistantStaleRunSweepIntervalMs: 0, domainEventSweepIntervalMs: 0,
    changeSettleMs: 0, frontendAppUrl: 'https://app.example/app', reportSubscriptionSweepIntervalMs: 0, reportingWarehouseSweepIntervalMs: 0, webhookSweepIntervalMs: 0, workflowAutomationSweepIntervalMs: 0,
    agentChatsRepository, authRepository, complianceRepository: createInMemoryComplianceRepository(), fileStorage: storage, liveEventBus: createLiveEventBus(), mailRepository, projectRepository, sessionsRepository, tokenService,
  });
  const server = await listen(app);
  t.after(async () => {
    await app.locals.beginDrain?.({ timeoutMs: 1000 });
    await server.close();
  });
  const origin = app.locals.agentApiOrigin;
  const token = tokenService.signSessionToken({ email: 'lead@acme.example', id: LEAD.id, name: LEAD.name, preferences: {}, role: 'user', tenantId: TENANT_ID });
  await sessionsRepository.createSession({ expiryDate: new Date(Date.now() + 3600_000), ipAddr: '127.0.0.1', locationName: 'Loopback', token, userAgent: 'fixture', userId: LEAD.id });
  async function ok(method, route, body, status = 200) {
    const response = await fetch(`${origin}${route}`, { body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, method });
    const json = await response.json().catch(() => null);
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(json)}`);
    return json;
  }
  const general = async () => (await ok('GET', `${P}/channels`)).channels.find((channel) => channel.isGeneral);
  async function upload(channelId, fileName, { base64 = PNG, type = 'image/png' } = {}) {
    return (await ok('POST', `${P}/files`, { fileContentsBase64: base64, fileDescription: '', fileName, fileType: type, inlineImage: false, targetId: channelId, targetType: 'channel' }, 201)).file;
  }
  async function waitForReply(postId, { timeoutMs = 8000 } = {}) {
    const started = Date.now();
    for (;;) {
      const [reply] = await projectRepository.listOdinReplies({ postIds: [postId], tenantId: TENANT_ID });
      if (reply && !['queued', 'running'].includes(reply.status) && !app.locals.assistantTurnQueue.has(reply.chatId ?? `odin-guest-${reply.id}`)) return reply;
      if (Date.now() - started > timeoutMs) throw new Error(`Odin did not answer: ${JSON.stringify(reply)}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  function addGuest(channelId) {
    projectRepository.state.channelGuests.push({ channelId, email: GUEST.email, invitedAt: new Date().toISOString(), invitedBy: LEAD.id, name: GUEST.name, removedAt: null, stakeholderId: GUEST.stakeholderId, tenantId: TENANT_ID });
  }
  async function guestPost(channelId, body, { fileIds = [], parentId = null } = {}) {
    return projectRepository.createPost({ fileIds, post: { authorId: GUEST.stakeholderId, authorName: GUEST.name, authorType: 'stakeholder', body: normalizeOdinTags(body, { enabled: true }), parentId, projectId: PROJECT, targetId: channelId, targetType: 'channel', tenantId: TENANT_ID } });
  }
  return { addGuest, agentChatsRepository, app, general, guestPost, ok, projectRepository, scripted, upload, waitForReply };
}

const userMessage = (request) => request.input.filter((item) => item.role === 'user').at(-1);
const imagesIn = (item) => (Array.isArray(item?.content) ? item.content.filter((part) => part.type === 'input_image') : []);
const notesOf = (request) => request.input.filter((item) => item.role === 'developer').at(-1).content;

test('media helpers: what can be shown, how a tool result carries it, and placeholders wherever it is kept', () => {
  assert.equal(mediaKindOf({ contentType: 'image/png', fileName: 'a.png' }).kind, 'image');
  assert.equal(mediaKindOf({ contentType: 'application/octet-stream', fileName: 'shot.JPG' }).contentType, 'image/jpeg');
  assert.equal(mediaKindOf({ contentType: 'application/pdf', fileName: 'scan.pdf' }).kind, 'pdf');
  assert.equal(mediaKindOf({ contentType: 'image/svg+xml', fileName: 'logo.svg' }), null, 'SVG is never shown');
  assert.equal(mediaKindOf({ contentType: 'text/plain', fileName: 'notes.txt' }), null);

  assert.equal(toolOutputFor({ ok: true }, truncateOutput), '{"ok":true}');
  const output = toolOutputFor({ media: [{ contentType: 'image/png', data: PNG, kind: 'image', name: 'a.png' }, { contentType: 'application/pdf', data: 'JVBERi0=', kind: 'pdf', name: 'scan.pdf' }], ok: true }, truncateOutput);
  assert.deepEqual(output.map((part) => part.type), ['input_text', 'input_image', 'input_file']);
  assert.equal(output[0].text, '{"ok":true}', 'the JSON goes without the bytes');
  assert.equal(output[1].image_url, `data:image/png;base64,${PNG}`);
  assert.deepEqual(output[2], { file_data: 'data:application/pdf;base64,JVBERi0=', filename: 'scan.pdf', type: 'input_file' });

  const input = [{ content: [{ text: 'Look', type: 'input_text' }, { detail: 'auto', image_url: 'data:image/png;base64,xx', type: 'input_image' }], role: 'user' }, { call_id: 'c1', output, type: 'function_call_output' }];
  assert.doesNotMatch(JSON.stringify(withoutMedia(input)), /base64/);
  assert.equal(mediaFreeText(output), '{"ok":true}\n[image]\n[file: scan.pdf]');
  const kept = keptItems([{ arguments: '{}', call_id: 'c1', name: 'odin_view_project_file', type: 'function_call' }, ...input]);
  assert.doesNotMatch(JSON.stringify(kept), /base64/, 'the transcript keeps placeholders');
  assert.deepEqual(mcpMediaContent({ contentType: 'image/png', data: PNG, kind: 'image', name: 'a.png' }), { data: PNG, mimeType: 'image/png', type: 'image' });
  assert.equal(mcpMediaContent({ data: 'JVBERi0=', kind: 'pdf', name: 'scan.pdf' }).resource.mimeType, 'application/pdf');
});

test('a turn picks the tagging post\'s images first, then the thread\'s newest first, up to the limit', () => {
  const file = (id, extra = {}) => ({ contentType: 'image/png', fileName: `${id}.png`, fileSize: 1000, id, scanStatus: 'clean', version: 1, ...extra });
  const files = [file('a'), file('b'), file('c'), file('d'), file('e'), file('big', { fileSize: 9 * 1024 * 1024 }), file('scanning', { scanStatus: 'pending' }), file('notes', { contentType: 'text/plain', fileName: 'notes.txt' })];
  const post = { authorType: 'user', createdAt: '2026-11-15T10:05:00Z', id: 'p-tag' };
  const thread = [
    { authorType: 'user', createdAt: '2026-11-15T10:00:00Z', id: 'p-root' },
    { authorType: 'stakeholder', createdAt: '2026-11-15T10:02:00Z', id: 'p-guest' },
    post,
  ];
  const links = [
    { fileId: 'a', postId: 'p-root' }, { fileId: 'b', postId: 'p-root' },
    { fileId: 'c', postId: 'p-guest' }, { fileId: 'scanning', postId: 'p-guest' },
    { fileId: 'd', postId: 'p-tag' }, { fileId: 'notes', postId: 'p-tag' }, { fileId: 'big', postId: 'p-tag' },
    { fileId: 'e', postId: 'p-root' },
  ];
  const { chosen, leftOut } = pickTurnImages({ files, links, post, thread });
  assert.deepEqual(chosen.map((image) => image.fileId), ['d', 'c', 'a', 'b']);
  assert.equal(chosen.length, TURN_IMAGE_LIMIT);
  assert.deepEqual(leftOut.map((image) => [image.fileId, image.reason]), [['big', 'too_large'], ['scanning', 'not_scanned'], ['e', 'limit']]);
  assert.equal(chosen[1].authorType, 'stakeholder');
  const lines = imageNoteLines({ included: chosen, leftOut }).join('\n');
  assert.match(lines, /These 4 images are attached to the message below/);
  assert.match(lines, /"c\.png" \(fileId c\), earlier in this thread, posted by a guest/);
  assert.match(lines, /Not shown to you: "big\.png" \(over 8 MB\)/);
  assert.deepEqual(imageNoteLines({}), []);
});

test('a member tags @odin on a post with a screenshot: the model sees it and the thread\'s images, and no bytes are kept', async (t) => {
  const harness = await fixture(t, { steps: [{ text: 'The screenshot shows the login error.' }] });
  const channel = await harness.general();
  const earlier = await harness.upload(channel.id, 'earlier.png');
  const root = await harness.ok('POST', `${P}/channels/${channel.id}/posts`, { body: 'Login is failing for the client.', fileIds: [earlier.id] }, 201);
  const shot = await harness.upload(channel.id, 'error.png');
  const notes = await harness.upload(channel.id, 'notes.txt', { base64: Buffer.from('steps').toString('base64'), type: 'text/plain' });
  const created = await harness.ok('POST', `${P}/channels/${channel.id}/posts`, { body: tag('what does this error say?'), fileIds: [shot.id, notes.id], parentId: root.post.id }, 201);
  const reply = await harness.waitForReply(created.post.id);
  assert.equal(reply.status, 'replied');

  const request = harness.scripted.calls.responses[0];
  const images = imagesIn(userMessage(request));
  assert.equal(images.length, 2, 'the tagging post\'s image and the thread\'s');
  assert.equal(images[0].image_url, `data:image/png;base64,${PNG}`);
  assert.match(notesOf(request), /These 2 images are attached to the message below/);
  assert.match(notesOf(request), /"error\.png" \(fileId [^)]+\), on the post that tagged you/);

  // Nothing kept holds the bytes: the chat (its origin keeps file ids) and the transcript.
  const chat = await harness.agentChatsRepository.get({ chatId: reply.chatId, tenantId: TENANT_ID, userId: LEAD.id });
  assert.deepEqual(chat.origin.images.map((image) => image.fileName), ['error.png', 'earlier.png']);
  assert.doesNotMatch(JSON.stringify(chat), /base64/);
  const transcript = await harness.agentChatsRepository.getTranscript({ chatId: reply.chatId, tenantId: TENANT_ID, userId: LEAD.id });
  assert.doesNotMatch(JSON.stringify(transcript), /base64/);
  assert.match(JSON.stringify(transcript), /\[image\]/);
});

test('a guest\'s image reaches a member\'s turn only when the check can read it', async (t) => {
  for (const [decisionsAvailable, expected] of [[true, 1], [false, 0]]) {
    await t.test(decisionsAvailable ? 'checked and clear' : 'not checked', async (t2) => {
      const harness = await fixture(t2, { decisionsAvailable, steps: [{ text: 'Seen.' }] });
      const channel = await harness.general();
      harness.addGuest(channel.id);
      const file = await harness.upload(channel.id, 'client.png');
      const posted = await harness.guestPost(channel.id, 'Here is what we see.', { fileIds: [file.id] });
      const created = await harness.ok('POST', `${P}/channels/${channel.id}/posts`, { body: tag('what is in the client\'s image?'), parentId: posted.id }, 201);
      await harness.waitForReply(created.post.id);
      const request = harness.scripted.calls.responses[0];
      assert.equal(imagesIn(userMessage(request)).length, expected);
      if (!expected) assert.match(notesOf(request), /Not shown to you: "client\.png" \(a guest posted it and it could not be checked/);
      else assert.ok(harness.scripted.calls.decisions.some((call) => JSON.stringify(call.input).includes('input_image')), 'the image was screened');
    });
  }
});

test('a durable retry reads the images again from the reply', async (t) => {
  const harness = await fixture(t, { steps: [{ text: 'Picked up, with the picture.' }] });
  const channel = await harness.general();
  const shot = await harness.upload(channel.id, 'board.png');
  const repository = harness.projectRepository;
  const post = await repository.createPost({ fileIds: [shot.id], post: { authorId: LEAD.id, authorType: 'user', body: tag('what is on this board?'), projectId: PROJECT, targetId: channel.id, targetType: 'channel', tenantId: TENANT_ID } });
  const { reply } = await repository.createOdinReply({ reply: { channelId: channel.id, postId: post.id, projectId: PROJECT, requesterId: LEAD.id, requesterType: 'user', status: 'queued', tenantId: TENANT_ID, threadId: post.id } });
  assert.deepEqual(await harness.app.locals.odinChannelService.runDurable({ executionRun: { tenantId: TENANT_ID }, payload: { replyId: reply.id } }), { ran: true });
  await harness.waitForReply(post.id);
  assert.equal(imagesIn(userMessage(harness.scripted.calls.responses[0])).length, 1);
});

test('odin_view_project_file shows the model an image; other files are refused, and the transcript keeps a placeholder', async (t) => {
  const call = { args: { projectId: PROJECT }, name: 'odin_view_project_file' };
  const textCall = { args: { projectId: PROJECT }, name: 'odin_view_project_file' };
  const harness = await fixture(t, { steps: [{ calls: [call, textCall] }, { text: 'It is a one-pixel diagram.' }] });
  const channel = await harness.general();
  const diagram = await harness.upload(channel.id, 'diagram.png');
  const notes = await harness.upload(channel.id, 'notes.txt', { base64: Buffer.from('steps').toString('base64'), type: 'text/plain' });
  call.args.fileId = diagram.id;
  textCall.args.fileId = notes.id;
  const created = await harness.ok('POST', `${P}/channels/${channel.id}/posts`, { body: tag('what is in the diagram in the library?') }, 201);
  const reply = await harness.waitForReply(created.post.id);
  assert.equal(reply.status, 'replied');

  const outputs = harness.scripted.calls.responses[1].input.filter((item) => item.type === 'function_call_output');
  const image = outputs.find((item) => Array.isArray(item.output));
  assert.ok(image, 'the image result goes back as parts');
  assert.deepEqual(image.output.map((part) => part.type), ['input_text', 'input_image']);
  assert.equal(image.output[1].image_url, `data:image/png;base64,${PNG}`);
  assert.match(image.output[0].text, /"fileName":"diagram\.png"/);
  assert.doesNotMatch(image.output[0].text, /base64|iVBOR/);
  const refused = outputs.find((item) => typeof item.output === 'string');
  assert.match(refused.output, /not_viewable/);

  const transcript = await harness.agentChatsRepository.getTranscript({ chatId: reply.chatId, tenantId: TENANT_ID, userId: LEAD.id });
  assert.doesNotMatch(JSON.stringify(transcript), /iVBOR/);
  assert.match(JSON.stringify(transcript), /\[image\]/);

  // The route answers only the agent view.
  await harness.ok('GET', `${P}/files/${diagram.id}/view`, undefined, 404);
  const viewed = await harness.ok('GET', `${P}/files/${diagram.id}/view?agentView=1`);
  assert.deepEqual([viewed.kind, viewed.contentType, viewed.contentBase64], ['image', 'image/png', PNG]);
});

test('a guest who tags @odin on a post with an image gets a turn that sees it, once it is checked', async (t) => {
  const harness = await fixture(t, { steps: [{ text: 'That is the export screen.' }] });
  const channel = await harness.general();
  harness.addGuest(channel.id);
  const file = await harness.upload(channel.id, 'export.png');
  const posted = await harness.guestPost(channel.id, '@odin which screen is this?', { fileIds: [file.id] });
  const { reply } = await harness.projectRepository.createOdinReply({ reply: { channelId: channel.id, postId: posted.id, projectId: PROJECT, requesterId: GUEST.stakeholderId, requesterType: 'stakeholder', status: 'queued', tenantId: TENANT_ID, threadId: posted.id } });
  await harness.app.locals.odinChannelService.runDurable({ executionRun: { tenantId: TENANT_ID }, payload: { replyId: reply.id } });
  const answered = await harness.waitForReply(posted.id);
  assert.equal(answered.status, 'replied');
  const request = harness.scripted.calls.responses[0];
  assert.equal(imagesIn(userMessage(request)).length, 1);
  assert.match(notesOf(request), /"export\.png" \(fileId [^)]+\), on the post that tagged you, posted by a guest/);
});

test('a turn that waits for a confirmation keeps placeholders, not the image, to resume from', async (t) => {
  const call = { args: { projectId: PROJECT }, name: 'odin_delete_project_file' };
  const harness = await fixture(t, { steps: [{ calls: [call] }, { text: 'Deleted.' }] });
  const channel = await harness.general();
  const shot = await harness.upload(channel.id, 'old-draft.png');
  call.args.fileId = shot.id;
  const created = await harness.ok('POST', `${P}/channels/${channel.id}/posts`, { body: tag('delete this old draft'), fileIds: [shot.id] }, 201);
  const reply = await harness.waitForReply(created.post.id);
  assert.equal(reply.status, 'awaiting_confirmation');
  assert.equal(imagesIn(userMessage(harness.scripted.calls.responses[0])).length, 1, 'the model saw the image');
  const chat = await harness.agentChatsRepository.get({ chatId: reply.chatId, tenantId: TENANT_ID, userId: LEAD.id });
  assert.ok(chat.pending?.state?.input?.length, 'the paused turn kept its input');
  assert.doesNotMatch(JSON.stringify(chat), /base64|iVBOR/);
  assert.match(JSON.stringify(chat.pending.state.input), /\[image\]/);
});
