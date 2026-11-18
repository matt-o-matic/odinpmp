// A stateful channel guest API for browser specs (docs/engagements/plan.md, Guests). It answers
// /api/guest/* as backend/src/modules/guests/guests.routes.js does: the sign-in code steps, the
// guest's one engagement with only #Deal room, posts, uploads in parts, files, versions, comments
// and the editing marker. #Internal exists but is not the guest's, so it answers 404. Install
// after installSyntheticApi: Playwright tries the latest route first, and this one passes on what
// it does not own. All people and text are synthetic.
const API_ORIGIN = 'http://localhost:3001';
export const GUEST = Object.freeze({ code: '246810', email: 'gina@northwind.example', fileActorId: 'owner-gina', name: 'Gina Guest', stakeholderId: 'stakeholder-gina' });
export const WORKSPACE_ID = 'tenant-synthetic';

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, status });
}

// `tasks`: the pursuit tasks the guest's source shows (guest-tasks.js); the guest's own carry
// `assignedToMe`. Off by default, as the guests module answers without a task source.
// `notifications`: the guest's bell (/api/guest/me), as notifications.routes.js presents them.
export function createGuestWorld({ notifications = [], signedIn = false, tasks = null, wholeBoard = false } = {}) {
  const at = (minutes) => new Date(Date.UTC(2026, 10, 14, 9, minutes)).toISOString();
  return {
    attempts: 0,
    calls: [],
    channels: [
      { archivedAt: null, createdAt: at(0), description: 'Pricing and the statement of work', id: 'channel-deal', isGeneral: false, name: 'Deal room', projectId: 'project-pursuit' },
      { archivedAt: null, createdAt: at(0), description: 'Team only', id: 'channel-internal', isGeneral: false, name: 'Internal', projectId: 'project-pursuit', notMine: true },
    ],
    codeAsked: false,
    comments: [],
    files: [],
    posts: [
      { authorId: 'user-pat', authorName: 'Pat Seller', authorType: 'user', body: 'Welcome, Gina. The draft SOW goes here this week.', createdAt: at(5), id: 'post-welcome', parentId: null, targetId: 'channel-deal' },
      { authorId: 'user-pat', authorName: 'Pat Seller', authorType: 'user', body: 'Margin notes', createdAt: at(6), id: 'post-internal', parentId: null, targetId: 'channel-internal' },
    ],
    project: { customer: 'Northwind', id: 'project-pursuit', kind: 'engagement', name: 'Northwind pursuit', readOnly: false },
    read: '',
    sequence: 0,
    notifications,
    signedIn,
    taskComments: [],
    tasks,
    uploads: new Map(),
    wholeBoard,
  };
}

export async function installGuestApi(page, world = createGuestWorld()) {
  const now = () => new Date(Date.UTC(2026, 10, 14, 12, 0, world.sequence++)).toISOString();
  const nextId = (prefix) => `${prefix}-${++world.sequence}`;
  const mine = (channelId) => world.channels.some((channel) => channel.id === channelId && !channel.notMine);
  const presentChannel = (channel) => ({
    archivedAt: channel.archivedAt, canArchive: false, canEdit: false, canPost: true, canRename: false, canRestore: false, canUpload: true,
    createdAt: channel.createdAt, description: channel.description, id: channel.id, isGeneral: channel.isGeneral, name: channel.name,
    unreadCount: world.posts.filter((post) => post.targetId === channel.id && post.authorType === 'user' && post.createdAt > world.read).length,
  });
  const presentPost = (post) => {
    const isMine = post.authorType === 'stakeholder';
    return {
      attachments: [], author: { id: post.authorId, name: post.authorName, type: post.authorType }, body: post.deletedAt ? '' : post.body,
      canDelete: isMine && !post.deletedAt, canEdit: isMine && !post.deletedAt, canReply: !post.parentId && !post.deletedAt, createdAt: post.createdAt,
      deleted: Boolean(post.deletedAt), editedAt: post.editedAt ?? null, fileVersion: post.fileVersion ?? null, id: post.id, isMine, parentId: post.parentId,
      replies: [...world.posts, ...world.comments].filter((reply) => reply.parentId === post.id).map(presentPost), targetId: post.targetId, targetType: post.targetType ?? 'channel',
    };
  };
  const presentFile = (file) => ({
    contentType: file.contentType, createdAt: file.createdAt, description: '', editing: file.editing ?? null, fileName: file.fileName, fileSize: file.fileSize, folderId: null,
    id: file.id, projectId: world.project.id, scanStatus: 'clean', targetId: file.targetId, targetType: file.targetType ?? 'channel', updatedAt: file.updatedAt,
    uploadedBy: { id: GUEST.fileActorId, name: GUEST.name }, version: file.version, versionNote: '', versionUploadedAt: file.updatedAt,
  });
  const presentTask = (task) => ({
    assignedToMe: Boolean(task.assignedToMe), assigneeName: task.assignedToMe ? '' : task.assigneeName ?? '', canAttach: Boolean(task.assignedToMe), canComment: Boolean(task.assignedToMe),
    canUpdate: Boolean(task.assignedToMe), dueDate: task.dueDate ?? null, id: task.id, name: task.name, priority: 4, status: task.status, version: 1,
  });
  const notFound = (route) => json(route, { error: 'Not found.', ok: false }, 404);
  const signedOut = (route) => json(route, { details: { code: 'guest_sign_in_required' }, error: 'Sign in to continue.', ok: false }, 401);

  await page.route(`${API_ORIGIN}/api/guest/**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const sub = url.pathname.slice('/api/guest'.length);
    const body = () => request.postDataJSON() ?? {};
    world.calls.push({ body: method === 'GET' ? null : body(), method, path: sub, query: url.search });
    let match;

    if (sub === '/sign-in/code') {
      world.codeAsked = true;
      return json(route, { expiresInSeconds: 900, ok: true, resendAfterSeconds: 60, sentTo: 'g***@northwind.example' });
    }
    if (sub === '/sign-in') {
      const input = body();
      if (input.code !== GUEST.code || input.email !== GUEST.email) {
        world.attempts += 1;
        return json(route, { details: { code: 'code_invalid', remaining: 5 - world.attempts }, error: 'That code is not right.', ok: false }, 400);
      }
      world.signedIn = true;
      return json(route, { expiresAt: '2026-12-14T12:00:00.000Z', guest: { email: GUEST.email, name: GUEST.name }, ok: true, token: 'odin_guest_synthetic' });
    }
    if (sub === '/sign-out') {
      world.signedIn = false;
      return json(route, { ok: true });
    }
    if (!world.signedIn) return signedOut(route);

    if (sub === '/session') return json(route, { guest: { email: GUEST.email, fileActorId: GUEST.fileActorId, name: GUEST.name }, ok: true, session: { expiresAt: '2026-12-14T12:00:00.000Z' }, workspace: { id: WORKSPACE_ID, name: 'Synthetic Workspace' } });
    if (sub === '/engagements') {
      return json(route, { ok: true, projects: [{ ...world.project, channels: world.channels.filter((channel) => !channel.notMine).map(presentChannel), unreadCount: 0 }] });
    }
    // The guest's bell: the members' notification routes, for the guest.
    if (sub === '/me/notifications') return json(route, { notifications: world.notifications, ok: true, unreadCount: world.notifications.filter((entry) => !entry.readAt).length });
    if (sub === '/me/notifications/read') {
      const input = body();
      for (const entry of world.notifications) if (input.all || input.ids?.includes(entry.id)) entry.readAt ??= now();
      return json(route, { marked: input.ids ?? [], ok: true, unreadCount: world.notifications.filter((entry) => !entry.readAt).length });
    }
    if (sub === '/me/focus') return json(route, { focusedForMs: 60_000, ok: true });
    if (sub === '/me/push') return json(route, { available: false, ok: true, publicKey: '' });
    if (sub === '/events') return route.fulfill({ body: 'event: connected\ndata: {"ok":true}\n\n', contentType: 'text/event-stream', status: 200 });
    if (sub === '/file-storage') return json(route, { canDeleteVersions: false, maxUploadBytes: 1_073_741_824, ok: true, storage: null, uploadsByParts: true });
    if ((match = /^\/projects\/([^/]+)\/tasks$/.exec(sub))) {
      if (match[1] !== world.project.id) return notFound(route);
      if (!world.tasks) return json(route, { available: false, ok: true, tasks: [], wholeBoard: false });
      return json(route, { available: true, ok: true, readOnly: false, statuses: ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed'], tasks: world.tasks.map(presentTask), wholeBoard: world.wholeBoard });
    }
    if ((match = /^\/projects\/([^/]+)\/tasks\/([^/]+)(?:\/(comments|files))?$/.exec(sub))) {
      const task = match[1] === world.project.id ? world.tasks?.find((entry) => entry.id === match[2]) : null;
      if (!task) return notFound(route);
      const notYours = () => json(route, { details: { code: 'not_your_task' }, error: 'Only tasks assigned to you can be changed here.', ok: false }, 403);
      if (!match[3] && method === 'PATCH') {
        if (!task.assignedToMe) return notYours();
        task.status = body().status;
        return json(route, { ok: true, task: presentTask(task) });
      }
      if (match[3] === 'comments' && method === 'POST') {
        if (!task.assignedToMe) return notYours();
        const comment = { authorName: GUEST.name, createdAt: now(), html: `<p>${body().text}</p>`, id: nextId('task-comment'), mine: true, taskId: task.id };
        world.taskComments.push(comment);
        return json(route, { comment, ok: true }, 201);
      }
      if (match[3] === 'comments') return json(route, { canComment: Boolean(task.assignedToMe), comments: world.taskComments.filter((entry) => entry.taskId === task.id), ok: true });
      if (match[3] === 'files') return json(route, { canWrite: Boolean(task.assignedToMe), files: world.files.filter((file) => file.targetId === task.id).map(presentFile), ok: true });
      return notFound(route);
    }

    if ((match = /^\/channels\/([^/]+)(?:\/(.*))?$/.exec(sub))) {
      const channel = world.channels.find((entry) => entry.id === match[1]);
      if (!channel || !mine(channel.id)) return notFound(route);
      const action = match[2] ?? '';
      if (action === '') return json(route, { channel: presentChannel(channel), ok: true, project: world.project });
      if (action === 'read') { world.read = now(); return json(route, { lastReadAt: world.read, ok: true, unreadCount: 0 }); }
      if (action === 'typing' && method === 'POST') return json(route, { ok: true });
      if (action === 'mentionables') return json(route, { ok: true, people: [{ detail: 'Team', kind: 'team', name: 'Pat Seller', ref: 'user:user-pat' }] });
      if (action === 'folders') return json(route, { canManage: false, folders: [], ok: true });
      if (action === 'files') return json(route, { canWrite: true, files: world.files.filter((file) => file.targetId === channel.id).map(presentFile), ok: true });
      if (action === 'posts' && method === 'POST') {
        const input = body();
        const post = { authorId: GUEST.stakeholderId, authorName: GUEST.name, authorType: 'stakeholder', body: input.body ?? '', createdAt: now(), id: nextId('post'), parentId: input.parentId ?? null, targetId: channel.id };
        world.posts.push(post);
        return json(route, { mentioned: [], ok: true, post: presentPost(post) }, 201);
      }
      if (action === 'posts') {
        const roots = world.posts.filter((post) => post.targetId === channel.id && !post.parentId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        return json(route, { canPost: true, channel: presentChannel(channel), nextCursor: null, ok: true, posts: roots.map(presentPost) });
      }
      return notFound(route);
    }
    if ((match = /^\/posts\/([^/]+)$/.exec(sub))) {
      const post = [...world.posts, ...world.comments].find((entry) => entry.id === match[1]);
      if (!post || (post.targetType !== 'file' && !mine(post.targetId))) return notFound(route);
      if (post.authorType !== 'stakeholder') return json(route, { details: { code: 'not_author' }, error: 'Only the author can edit a message.', ok: false }, 403);
      if (method === 'PATCH') Object.assign(post, { body: body().body, editedAt: now() });
      if (method === 'DELETE') Object.assign(post, { body: '', deletedAt: now() });
      return json(route, { ok: true, post: presentPost(post) });
    }

    // Uploads in parts: start, sign, send each part to the transfer URL, complete.
    if (sub === '/uploads' && method === 'POST') {
      const input = body();
      const ownTask = input.targetType === 'task' && world.tasks?.some((task) => task.id === input.targetId && task.assignedToMe);
      if (!ownTask && (input.targetType !== 'channel' || !mine(input.targetId))) {
        if (!input.fileId) return notFound(route);
      }
      const upload = { baseVersion: input.expectedVersion ?? null, contentType: input.contentType, expiresAt: '2099-01-01T00:00:00.000Z', fileId: input.fileId ?? null, fileName: input.fileName, id: nextId('upload'), partCount: 1, partSize: 8 * 1024 * 1024, size: input.fileSize, status: 'uploading', targetId: input.targetId ?? null, targetType: ownTask ? 'task' : 'channel' };
      world.uploads.set(upload.id, upload);
      return json(route, { ok: true, upload: { ...upload, parts: [], receivedBytes: 0 } }, 201);
    }
    if ((match = /^\/uploads\/([^/]+)(?:\/(parts|complete))?$/.exec(sub))) {
      const upload = world.uploads.get(match[1]);
      if (!upload) return notFound(route);
      if (match[2] === 'parts') return json(route, { expiresAt: '2099-01-01T00:00:00.000Z', ok: true, parts: [{ method: 'PUT', partNumber: 1, size: upload.size, url: `/api/file-transfers/parts/guest-${upload.id}` }] });
      if (match[2] === 'complete') {
        const existing = upload.fileId ? world.files.find((file) => file.id === upload.fileId) : world.files.find((file) => file.targetId === upload.targetId && file.fileName === upload.fileName);
        if (existing) Object.assign(existing, { updatedAt: now(), version: existing.version + 1 });
        const file = existing ?? { contentType: upload.contentType, createdAt: now(), fileName: upload.fileName, fileSize: upload.size, id: nextId('file'), targetId: upload.targetId, targetType: upload.targetType, updatedAt: now(), version: 1 };
        if (!existing) world.files.push(file);
        upload.status = 'completed';
        return json(route, { channelId: upload.targetType === 'task' ? null : file.targetId, file: presentFile(file), ok: true, taskId: upload.targetType === 'task' ? file.targetId : null }, 201);
      }
      if (method === 'DELETE') return json(route, { cancelled: true, ok: true, status: 'aborted' });
      return json(route, { ok: true, upload: { ...upload, parts: [], receivedBytes: 0 } });
    }
    if ((match = /^\/files\/([^/]+)\/(versions|comments|mentionables|editing|download-url|preview-url)$/.exec(sub))) {
      const file = world.files.find((entry) => entry.id === match[1]);
      const onTask = file?.targetType === 'task' && world.tasks?.some((task) => task.id === file.targetId);
      if (!file || !(mine(file.targetId) || onTask)) return notFound(route);
      const action = match[2];
      // Task files only download (guests.service.js requireGuestReadableFile).
      if (onTask && !['download-url', 'preview-url'].includes(action)) return notFound(route);
      if (action === 'versions') return json(route, { file: presentFile(file), ok: true, versions: Array.from({ length: file.version }, (_, index) => ({ contentType: file.contentType, current: index === 0, deletedAt: null, fileName: file.fileName, fileSize: file.fileSize, note: '', scanStatus: 'clean', uploadedAt: file.updatedAt, uploadedBy: { id: GUEST.fileActorId, name: GUEST.name }, version: file.version - index })) });
      if (action === 'mentionables') return json(route, { ok: true, people: [{ detail: 'Team', kind: 'team', name: 'Pat Seller', ref: 'user:user-pat' }] });
      if (action === 'download-url') return json(route, { contentType: file.contentType, fileName: file.fileName, ok: true, url: `/api/file-transfers/files/guest-${file.id}`, version: file.version });
      if (action === 'preview-url') return json(route, { expiresAt: '2099-01-01T00:00:00.000Z', fileName: file.fileName, kind: 'text', ok: true, reason: null, url: `/api/file-transfers/files/guest-${file.id}`, version: file.version });
      if (action === 'editing') {
        file.editing = method === 'PUT' ? { name: GUEST.name, since: now(), userId: GUEST.fileActorId } : null;
        return json(route, { channelId: file.targetId, editing: file.editing, fileId: file.id, ok: true });
      }
      if (method === 'POST') {
        const input = body();
        const comment = { authorId: GUEST.stakeholderId, authorName: GUEST.name, authorType: 'stakeholder', body: input.body, createdAt: now(), fileVersion: file.version, id: nextId('comment'), parentId: input.parentId ?? null, targetId: file.id, targetType: 'file' };
        world.comments.push(comment);
        return json(route, { channelId: file.targetId, comment: presentPost(comment), mentioned: [], ok: true }, 201);
      }
      const roots = world.comments.filter((comment) => comment.targetId === file.id && !comment.parentId);
      return json(route, { canComment: true, channelId: file.targetId, comments: roots.map(presentPost), currentVersion: file.version, fileId: file.id, more: false, ok: true });
    }
    return notFound(route);
  });
  // The parts and the signed downloads, as local storage serves them.
  await page.route(`${API_ORIGIN}/api/file-transfers/**`, (route) => {
    world.calls.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
    if (route.request().method() === 'PUT') return route.fulfill({ body: '', headers: { ETag: '"part-1"' }, status: 200 });
    return route.fulfill({ body: 'Network diagram v1', contentType: 'text/plain', status: 200 });
  });
  return world;
}

/** The member routes for a channel's guests, for the Guests dialog on the Channels tab. */
export async function installChannelGuestsApi(page, { projectId = 'project-synthetic' } = {}) {
  const state = { calls: [], guests: [{ email: 'otto@contoso.example', invitedAt: '2026-11-14T09:00:00.000Z', lastSeenAt: null, name: 'Otto Outside', organization: 'Contoso', stakeholderId: 'stakeholder-otto' }] };
  await page.route(new RegExp(`^${API_ORIGIN}/api/projects/${projectId}/channels/[^/]+/guests(?:/[^/]+)?$`), (route) => {
    const request = route.request();
    const method = request.method();
    const parts = new URL(request.url()).pathname.split('/');
    state.calls.push({ body: method === 'POST' ? request.postDataJSON() : null, method, path: parts.slice(4).join('/') });
    if (method === 'POST') {
      const input = request.postDataJSON();
      state.guests.push({ email: input.email, invitedAt: '2026-11-14T12:00:00.000Z', lastSeenAt: null, name: input.name, organization: input.organization ?? '', stakeholderId: `stakeholder-${state.guests.length + 1}` });
      return json(route, { added: true, guest: state.guests.at(-1), invitationQueued: true, ok: true }, 201);
    }
    if (method === 'DELETE') {
      state.guests = state.guests.filter((guest) => guest.stakeholderId !== parts.at(-1));
      return json(route, { accessEnded: true, ok: true, removed: true });
    }
    return json(route, { canManage: true, guests: state.guests, ok: true, otherGuests: [] });
  });
  return state;
}
