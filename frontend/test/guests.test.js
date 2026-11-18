import assert from 'node:assert/strict';
import test from 'node:test';

import { createGuestApi, parseSseChunk } from '../src/lib/guests/guest-api.js';
import { guestStatusOptions, guestTaskErrorMessage, guestTaskMeta, sortGuestTasks } from '../src/lib/guests/guest-tasks.js';
import { guestNotice, needsSignIn, resendCountdown, safeGuestNext, signInErrorMessage, signInNoticeFor, signInRouteFor } from '../src/lib/guests/guest-view.js';

// The guest view's API client and helpers.

function recordingFetch(responses = []) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ init, url });
    const next = responses.shift() ?? { body: { ok: true }, status: 200 };
    return { json: async () => next.body, ok: next.status >= 200 && next.status < 300, status: next.status };
  };
  return { calls, fetchImpl };
}

test('the guest API offers the channel screens’ methods and calls only /api/guest, with the CSRF value on writes', async () => {
  const { calls, fetchImpl } = recordingFetch();
  globalThis.document = { cookie: 'odin_csrf=member-value; odin_guest_csrf=guest%2Dcsrf' };
  try {
    const api = createGuestApi({ baseUrl: 'https://odin.example', fetchImpl });
    assert.equal(api.passive, api, 'quiet calls are the same calls');
    await api.listChannelPosts('project-ignored', 'channel-1', { before: 'cursor', limit: 30 }, 'token-ignored');
    await api.createChannelPost('project-ignored', 'channel-1', { body: 'Hi' });
    await api.updatePost('p', 'post-1', { body: 'Edited' });
    await api.deletePost('p', 'post-1');
    await api.getFiles('p', { targetId: 'channel-1', targetType: 'channel' });
    await api.getFileDownloadUrl('p', 'file-1', { version: 2 });
    await api.getFilePreviewUrl('p', 'file-1', { version: 2 });
    await api.startFileUpload('p', { fileName: 'a.txt' });
    await api.signFileUploadParts('p', 'upload-1', [1, 2]);
    await api.completeFileUpload('p', 'upload-1', {});
    await api.setFileEditing('p', 'file-1');
    await api.createFileComment('p', 'file-1', { body: 'Note' });
    const paths = calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}${new URL(call.url).search}`);
    assert.deepEqual(paths, [
      'GET /api/guest/channels/channel-1/posts?before=cursor&limit=30',
      'POST /api/guest/channels/channel-1/posts',
      'PATCH /api/guest/posts/post-1',
      'DELETE /api/guest/posts/post-1',
      'GET /api/guest/channels/channel-1/files',
      'GET /api/guest/files/file-1/download-url?version=2',
      'GET /api/guest/files/file-1/preview-url?version=2',
      'POST /api/guest/uploads',
      'POST /api/guest/uploads/upload-1/parts',
      'POST /api/guest/uploads/upload-1/complete',
      'PUT /api/guest/files/file-1/editing',
      'POST /api/guest/files/file-1/comments',
    ]);
    assert.ok(calls.every((call) => call.init.credentials === 'include'));
    assert.ok(calls.every((call) => !call.init.headers.Authorization), 'never a member token');
    assert.equal(calls[0].init.headers['X-CSRF-Token'], undefined, 'reads send no CSRF value');
    assert.equal(calls[1].init.headers['X-CSRF-Token'], 'guest-csrf', 'writes send the guest one, not the member one');
    // Member-only paths are absent; base64 uploads and file content are refused.
    assert.equal(api.listChannels, undefined);
    assert.equal(api.restoreFileVersion, undefined);
    assert.throws(() => api.uploadProjectFile(), /in parts only/);
  } finally {
    delete globalThis.document;
  }
});

test('the guest API turns refusals into errors with their status and code', async () => {
  const { fetchImpl } = recordingFetch([{ body: { details: { code: 'guest_session_ended' }, error: 'Your session has ended.' }, status: 401 }]);
  const api = createGuestApi({ baseUrl: 'https://odin.example', fetchImpl });
  await assert.rejects(api.listEngagements(), (error) => error.status === 401 && error.data.details.code === 'guest_session_ended' && needsSignIn(error));
});

test('server-sent events parse across chunks', () => {
  const events = [];
  let rest = parseSseChunk('event: connected\ndata: {"ok":true}\n\nevent: channel.up', (event) => events.push(event));
  rest = parseSseChunk(`${rest}dated\ndata: {"channelId":"c1","area":"posts"}\n\n`, (event) => events.push(event));
  assert.equal(rest, '');
  assert.deepEqual(events, [{ data: { ok: true }, type: 'connected' }, { data: { area: 'posts', channelId: 'c1' }, type: 'channel.updated' }]);
});

test('sign-in goes back only to guest pages, and its messages explain each refusal', () => {
  assert.equal(safeGuestNext('/guest/channels/c1?tab=files&file=f1'), '/guest/channels/c1?tab=files&file=f1');
  assert.equal(safeGuestNext('/projects/p1'), '/guest');
  assert.equal(safeGuestNext('//evil.example/guest'), '/guest');
  assert.equal(safeGuestNext('https://evil.example'), '/guest');
  assert.equal(safeGuestNext('/guest/sign-in?next=/guest'), '/guest');
  assert.deepEqual(signInRouteFor('/guest/channels/c1', { notice: 'ended', workspace: 'tenant-1' }), { name: 'guest-sign-in', query: { next: '/guest/channels/c1', notice: 'ended', workspace: 'tenant-1' } });
  const error = (code, extra = {}) => ({ data: { details: { code, ...extra } }, status: 400 });
  assert.equal(signInErrorMessage(error('code_invalid', { remaining: 3 })), 'That code is not right. 3 tries are left.');
  assert.equal(signInErrorMessage(error('code_invalid', { remaining: 1 })), 'That code is not right. One try is left.');
  assert.match(signInErrorMessage(error('code_locked')), /Too many wrong codes/);
  assert.match(signInErrorMessage(error('code_expired')), /expired/);
  assert.match(signInErrorMessage({ data: { details: { code: 'rate_limited' } }, status: 429 }), /Wait a few minutes/);
  assert.match(signInErrorMessage(new TypeError('Failed to fetch')), /could not be reached/);
  assert.equal(resendCountdown(65_000, 0), '1:05');
  assert.equal(resendCountdown(0, 1000), '');
  assert.match(guestNotice('ended'), /no longer have access/);
  assert.equal(guestNotice('other'), '');
  const refused = (code) => ({ data: { details: { code } }, status: 401 });
  assert.equal(signInNoticeFor(refused('guest_sign_in_required')), '', 'an invitation link shows no notice');
  assert.equal(signInNoticeFor(refused('guest_session_ended')), 'expired');
  assert.equal(signInNoticeFor(refused('guest_access_ended')), 'ended');
});

test('a guest’s task calls go to their own task routes under /api/guest', async () => {
  const { calls, fetchImpl } = recordingFetch();
  globalThis.document = { cookie: 'odin_guest_csrf=guest-csrf' };
  try {
    const api = createGuestApi({ baseUrl: 'https://odin.example', fetchImpl });
    await api.listTasks('eng-1');
    await api.updateTask('eng-1', 'task-1', { status: 'In Progress' });
    await api.listTaskComments('eng-1', 'task-1');
    await api.addTaskComment('eng-1', 'task-1', 'Sent');
    await api.listTaskFiles('eng-1', 'task-1');
    assert.deepEqual(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
      'GET /api/guest/projects/eng-1/tasks',
      'PATCH /api/guest/projects/eng-1/tasks/task-1',
      'GET /api/guest/projects/eng-1/tasks/task-1/comments',
      'POST /api/guest/projects/eng-1/tasks/task-1/comments',
      'GET /api/guest/projects/eng-1/tasks/task-1/files',
    ]);
    assert.deepEqual(JSON.parse(calls[1].init.body), { status: 'In Progress' });
    assert.deepEqual(JSON.parse(calls[3].init.body), { text: 'Sent' });
    assert.equal(calls[1].init.headers['X-CSRF-Token'], 'guest-csrf');
  } finally {
    delete globalThis.document;
  }
});

test('guest tasks: their own first, then by due date; each line says status, due date and, for others, who has it', () => {
  const tasks = [
    { assignedToMe: false, assigneeName: 'Otto Outside', dueDate: '2026-11-18', id: 'b', name: 'Confirm licences', status: 'Not Started' },
    { assignedToMe: true, dueDate: null, id: 'c', name: 'Send diagrams', status: 'In Progress' },
    { assignedToMe: false, assigneeName: '', dueDate: '2026-11-16', id: 'a', name: 'Draft', status: 'Review' },
  ];
  assert.deepEqual(sortGuestTasks(tasks).map((task) => task.id), ['c', 'a', 'b']);
  assert.equal(guestTaskMeta(tasks[1]), 'In Progress');
  assert.equal(guestTaskMeta(tasks[0], { locale: 'en-GB' }), 'Not Started · due 18 Nov · Otto Outside');
  assert.equal(guestTaskMeta(tasks[2], { locale: 'en-GB' }), 'Review · due 16 Nov · Unassigned');
  assert.deepEqual(guestStatusOptions(['Not Started', 'Completed'], 'Blocked'), ['Not Started', 'Completed', 'Blocked']);
  assert.equal(guestTaskErrorMessage({ data: { details: { code: 'not_your_task' } }, status: 403 }, 'x'), 'Only tasks assigned to you can be changed.');
  assert.equal(guestTaskErrorMessage({ status: 404 }, 'x'), 'This task is no longer shared with you.');
  assert.equal(guestTaskErrorMessage({ status: 500 }, 'fallback'), 'fallback');
});

test('the guest bell calls /api/guest/me, and the bell and the channel screens share one guest stream', async () => {
  const opened = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/guest/events') {
      opened.push(path);
      // A stream that sends `connected` and then stays open until aborted.
      const encoder = new TextEncoder();
      let release;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: connected\ndata: {"ok":true}\n\nevent: notification.created\ndata: {"id":"n-1"}\n\n'));
          release = () => controller.close();
          init.signal?.addEventListener('abort', () => { try { release(); } catch { /* closed */ } });
        },
      });
      return { body, ok: true, status: 200 };
    }
    return { json: async () => ({ ok: true, path, body: init.body ? JSON.parse(init.body) : null }), ok: true, status: 200 };
  };
  globalThis.document = { cookie: 'odin_guest_csrf=guest-csrf' };
  try {
    const api = createGuestApi({ baseUrl: 'https://odin.example', fetchImpl });
    assert.equal((await api.listNotifications('ignored')).path, '/api/guest/me/notifications');
    assert.deepEqual((await api.markNotificationsRead({ ids: ['n-1'] })).body, { ids: ['n-1'] });
    assert.equal((await api.markNotificationsRead({ all: true })).path, '/api/guest/me/notifications/read');
    assert.equal((await api.sendNotificationFocus(true)).body.focused, true);
    assert.equal((await api.getPushConfig()).path, '/api/guest/me/push');

    const seen = { bell: [], channels: [] };
    const stopChannels = api.subscribeToEvents({ onEvent: (event) => seen.channels.push(event.type) });
    const stopBell = api.subscribeToMyEvents('ignored', { onEvent: (event) => seen.bell.push(event.type) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(opened, ['/api/guest/events'], 'one stream for the tab');
    assert.ok(seen.channels.includes('notification.created'));
    assert.ok(seen.bell.includes('connected'), 'a late listener still hears the stream is connected');
    stopChannels();
    stopBell();
  } finally {
    delete globalThis.document;
  }
});
