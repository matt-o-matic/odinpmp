// Channels, posts, folders, channel files, file comments and the editing marker for browser
// specs. Install after installSyntheticApi:
// Playwright tries the latest route first, and this one passes on what it does not own. Two
// pages given the same `world` share one set of channels, as two people in one project do.
// Odin in channels: `world.odin` ({ available }) is what the list returns, each channel's
// `odinEnabled` (on unless false) is its "Let Odin answer when tagged", `world.canSwitchOdin`
// (default true) says whether the viewer may change it, a post with authorType 'odin'
// is Odin's, a post's `odin` and `odinReply` pass through (a confirmation's buttons are for its
// `askerId`), and `world.onPost(post)` sees each new post before it is returned.
// A channel file's preview-url and download-url sign links this fixture serves: a 1-pixel PNG for
// images, a small PDF otherwise. `world.previews[fileId]` overrides the preview ({ kind, reason }),
// and `world.scanning[fileId] = n` answers its next n preview-url calls with "still scanning".
import { pollRoute, presentPoll, storedPoll } from './polls-fixture.js';

const API_ORIGIN = 'http://localhost:3001';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const previewKind = (file) => (/^image\/(png|jpe?g|gif|webp)$/.test(file.contentType ?? '') ? 'image' : /^video\//.test(file.contentType ?? '') ? 'video' : file.contentType === 'application/pdf' ? 'pdf' : 'none');

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

const PEOPLE = {
  'user-pat': { email: 'pat@example.com', name: 'Pat Seller' },
  'user-synthetic': { email: 'demo@example.com', name: 'Synthetic Demo' },
};

export function createChannelsWorld({ projectId = 'project-synthetic' } = {}) {
  const at = (minutes) => new Date(Date.UTC(2026, 10, 14, 9, minutes)).toISOString();
  return {
    calls: [],
    channels: [
      { archivedAt: null, createdAt: at(0), description: 'Everyone on the project', id: 'channel-general', isGeneral: true, name: 'General' },
      { archivedAt: null, createdAt: at(1), description: 'Pricing and the statement of work', id: 'channel-deal', isGeneral: false, name: 'Deal room' },
    ],
    comments: [],
    files: [],
    // Reactions: { postId, emoji, userId }, oldest first (backend post-reactions.js).
    reactions: [],
    folders: [],
    posts: [
      { authorId: 'user-pat', body: 'Kick-off notes are in the library.', createdAt: at(5), id: 'post-welcome', parentId: null, targetId: 'channel-general' },
      { authorId: 'user-pat', body: 'Draft pricing attached soon.', createdAt: at(6), id: 'post-deal-1', parentId: null, targetId: 'channel-deal' },
      { authorId: 'user-pat', body: 'Can we hold the rate?', createdAt: at(7), id: 'post-deal-2', parentId: null, targetId: 'channel-deal' },
    ],
    projectId,
    // Last read per person and channel.
    reads: { 'user-synthetic': { 'channel-general': at(30) } },
    sequence: 0,
  };
}

export async function installChannelsApi(page, { userId = 'user-synthetic', world = createChannelsWorld() } = {}) {
  const P = `/api/projects/${world.projectId}`;
  const now = () => new Date(Date.UTC(2026, 10, 14, 12, 0, world.sequence++)).toISOString();
  const nextId = (prefix) => `${prefix}-${++world.sequence}`;
  const unread = (channel) => world.posts.filter((post) => post.targetId === channel.id && !post.deletedAt && post.authorId !== userId && post.createdAt > (world.reads[userId]?.[channel.id] ?? '')).length;
  const presentChannel = (channel) => ({
    ...channel,
    canArchive: !channel.isGeneral && !channel.archivedAt,
    canEdit: !channel.archivedAt,
    canPost: !channel.archivedAt,
    canRename: !channel.isGeneral && !channel.archivedAt,
    canRestore: Boolean(channel.archivedAt),
    canSwitchOdin: world.canSwitchOdin !== false && !channel.archivedAt,
    canUpload: !channel.archivedAt,
    odinEnabled: channel.odinEnabled !== false,
    unreadCount: channel.archivedAt ? 0 : unread(channel),
  });
  const reactionsOf = (post) => {
    if (post.deletedAt) return [];
    const byEmoji = new Map();
    for (const reaction of (world.reactions ?? []).filter((entry) => entry.postId === post.id)) {
      const entry = byEmoji.get(reaction.emoji) ?? { count: 0, emoji: reaction.emoji, mine: false, people: [] };
      entry.count += 1;
      if (reaction.userId === userId) entry.mine = true;
      entry.people.push({ id: reaction.userId, name: PEOPLE[reaction.userId]?.name ?? 'Former member', type: 'user', ...(reaction.userId === userId ? { isViewer: true } : {}) });
      byEmoji.set(reaction.emoji, entry);
    }
    return [...byEmoji.values()];
  };
  const presentPost = (post) => {
    const mine = post.authorId === userId && post.authorType !== 'odin';
    const asked = post.odinReply?.confirmation;
    const odinReply = post.odinReply ? { ...post.odinReply, ...(asked ? { confirmation: { ...asked, canResolve: asked.status === 'pending' && post.odinReply.askerId === userId } } : {}) } : null;
    return {
      ...(post.odin ? { odin: post.odin } : {}),
      ...(odinReply ? { odinReply } : {}),
      ...(post.poll && !post.deletedAt ? { poll: presentPoll(world, post, userId, (id) => PEOPLE[id]?.name ?? 'Former member') } : {}),
      attachments: post.deletedAt ? [] : (post.fileIds ?? []).map((id) => world.files.find((file) => file.id === id)).filter(Boolean).map((file) => ({ contentType: file.contentType, fileName: file.fileName, fileSize: file.fileSize, folderId: file.folderId, id: file.id, scanStatus: 'clean', version: file.version })),
      author: post.authorType === 'odin' ? { id: null, name: 'Odin', type: 'odin' } : { id: post.authorId, name: PEOPLE[post.authorId]?.name ?? 'Former member', type: 'user' },
      body: post.deletedAt ? '' : post.body,
      canDelete: !post.deletedAt,
      canEdit: mine && !post.deletedAt,
      canReact: !post.deletedAt,
      canReply: !post.deletedAt,
      createdAt: post.createdAt,
      deleted: Boolean(post.deletedAt),
      editedAt: post.editedAt ?? null,
      fileVersion: post.fileVersion ?? null,
      id: post.id,
      isMine: mine,
      parentId: post.parentId,
      reactions: reactionsOf(post),
      replyToId: post.replyToId ?? null,
      replies: world.posts.filter((reply) => reply.parentId === post.id).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(presentPost),
      targetId: post.targetId,
      targetType: post.targetType ?? 'channel',
    };
  };
  const presentFile = (file) => ({
    audience: 'internal', contentType: file.contentType, createdAt: file.createdAt, description: '', editing: file.editing ?? null, fileName: file.fileName, fileSize: file.fileSize,
    folderId: file.folderId ?? null, id: file.id, links: [], projectId: world.projectId, scanStatus: 'clean', targetId: file.targetId, targetName: world.channels.find((channel) => channel.id === file.targetId)?.name ?? null,
    targetType: 'channel', updatedAt: file.updatedAt, uploadedBy: { id: userId, name: PEOPLE[userId].name }, version: file.version, versionNote: '', versionUploadedAt: file.updatedAt,
  });
  const people = Object.entries(PEOPLE).filter(([id]) => id !== userId).map(([id, person]) => ({ detail: 'Team', kind: 'team', name: person.name, ref: `user:${id}` }));

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith(P)) return route.fallback();
    const sub = path.slice(P.length);
    const body = () => request.postDataJSON() ?? {};
    const record = () => world.calls.push({ body: method === 'GET' ? null : body(), method, path: sub, userId });
    let match;

    if (sub === '/channels') {
      if (method === 'POST') {
        record();
        const input = body();
        if (world.channels.some((channel) => channel.name.toLowerCase() === input.name.toLowerCase())) return json(route, { details: { code: 'channel_name_taken' }, error: 'A channel with this name is already here.', ok: false }, 409);
        const channel = { archivedAt: null, createdAt: now(), description: input.description ?? '', id: nextId('channel'), isGeneral: false, name: input.name };
        world.channels.push(channel);
        return json(route, { channel: presentChannel(channel), ok: true }, 201);
      }
      const sorted = [...world.channels].sort((left, right) => Number(right.isGeneral) - Number(left.isGeneral) || left.name.localeCompare(right.name));
      return json(route, { channels: sorted.map(presentChannel), ...(world.odin ? { odin: world.odin } : {}), ok: true, permissions: { canCreate: true, canDecide: true, canUpload: true, readOnly: false } });
    }
    if ((match = /^\/channels\/([^/]+)(?:\/(.*))?$/.exec(sub))) {
      const channel = world.channels.find((entry) => entry.id === match[1]);
      if (!channel) return json(route, { error: 'Channel not found.', ok: false }, 404);
      const action = match[2] ?? '';
      if (action === '' && method === 'PATCH') { record(); Object.assign(channel, body()); return json(route, { channel: presentChannel(channel), ok: true }); }
      if (action === '' && method === 'DELETE') { record(); channel.archivedAt = now(); return json(route, { channel: presentChannel(channel), ok: true }); }
      if (action === 'restore') { record(); channel.archivedAt = null; return json(route, { channel: presentChannel(channel), ok: true }); }
      if (action === 'read') {
        record();
        world.reads[userId] = { ...(world.reads[userId] ?? {}), [channel.id]: now() };
        return json(route, { lastReadAt: world.reads[userId][channel.id], ok: true, unreadCount: 0 });
      }
      // Typing signals go to `world.typing`, not `calls`: specs count writes there.
      if (action === 'typing' && method === 'POST') {
        (world.typing ??= []).push({ ...body(), channelId: channel.id, userId });
        return json(route, { ok: true });
      }
      if (action === 'mentionables') return json(route, { ok: true, people: world.odin?.available && channel.odinEnabled !== false ? [{ detail: 'AI assistant', kind: 'odin', name: 'Odin', ref: 'odin:odin' }, ...people] : people });
      if (action === 'folders') {
        if (method === 'POST') {
          record();
          const input = body();
          if (world.folders.some((folder) => folder.channelId === channel.id && (folder.parentId ?? null) === (input.parentId ?? null) && folder.name.toLowerCase() === input.name.toLowerCase())) {
            return json(route, { details: { code: 'folder_name_taken' }, error: 'A folder with this name is already here.', ok: false }, 409);
          }
          const folder = { channelId: channel.id, createdAt: now(), id: nextId('folder'), name: input.name, parentId: input.parentId ?? null };
          world.folders.push(folder);
          return json(route, { folder, ok: true }, 201);
        }
        return json(route, { canManage: true, folders: world.folders.filter((folder) => folder.channelId === channel.id), ok: true });
      }
      if (action === 'posts') {
        if (method === 'POST') {
          record();
          const input = body();
          const poll = input.poll ? storedPoll(input.poll) : null;
          const post = { authorId: userId, body: (input.body ?? '').trim() || poll?.question || '', createdAt: now(), fileIds: input.fileIds ?? [], id: nextId('post'), parentId: input.parentId ?? null, replyToId: input.replyToId ?? null, targetId: channel.id, ...(poll ? { poll } : {}) };
          world.posts.push(post);
          world.onPost?.(post);
          world.reads[userId] = { ...(world.reads[userId] ?? {}), [channel.id]: post.createdAt };
          return json(route, { mentioned: [], ok: true, post: presentPost(post) }, 201);
        }
        const roots = world.posts.filter((post) => post.targetId === channel.id && !post.parentId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        // With world.paged, pages of `limit` threads before the `before` cursor (the last thread's id).
        if (world.paged) {
          const before = url.searchParams.get('before');
          const start = before ? roots.findIndex((post) => post.id === before) + 1 : 0;
          const page = roots.slice(start, start + (Number(url.searchParams.get('limit')) || 30));
          const more = start + page.length < roots.length;
          return json(route, { canPost: !channel.archivedAt, channel: presentChannel(channel), nextCursor: more ? page.at(-1).id : null, ok: true, posts: page.map(presentPost) });
        }
        return json(route, { canPost: !channel.archivedAt, channel: presentChannel(channel), nextCursor: null, ok: true, posts: roots.map(presentPost) });
      }
    }
    // Polls (polls-fixture.js): a vote, or closing early.
    if ((match = /^\/posts\/([^/]+)\/poll\/(vote|close)$/.exec(sub))) {
      record();
      const answered = pollRoute(world, { action: match[2], body: method === 'GET' ? {} : body(), method, nameOf: (id) => PEOPLE[id]?.name ?? 'Former member', postId: match[1], userId });
      if (answered) return json(route, answered.body, answered.status);
    }
    if ((match = /^\/posts\/([^/]+)\/reactions$/.exec(sub)) && method === 'PUT') {
      record();
      const post = [...world.posts, ...world.comments].find((entry) => entry.id === match[1]);
      if (!post) return json(route, { error: 'Message not found.', ok: false }, 404);
      const { emoji, reacted } = body();
      world.reactions = (world.reactions ?? []).filter((entry) => !(entry.postId === post.id && entry.userId === userId && entry.emoji === emoji));
      if (reacted) world.reactions.push({ emoji, postId: post.id, userId });
      return json(route, { ok: true, postId: post.id, reactions: reactionsOf(post) });
    }
    if ((match = /^\/posts\/([^/]+)$/.exec(sub))) {
      record();
      const post = [...world.posts, ...world.comments].find((entry) => entry.id === match[1]);
      if (!post) return json(route, { error: 'Message not found.', ok: false }, 404);
      if (method === 'PATCH') Object.assign(post, { body: body().body, editedAt: now() });
      if (method === 'DELETE') Object.assign(post, { body: '', deletedAt: now() });
      return json(route, { ok: true, post: presentPost(post) });
    }
    if ((match = /^\/folders\/([^/]+)$/.exec(sub))) {
      record();
      const folder = world.folders.find((entry) => entry.id === match[1]);
      if (method === 'DELETE') {
        world.folders = world.folders.filter((entry) => entry.id !== folder.id);
        return json(route, { deletedFolderId: folder.id, folder, ok: true });
      }
      Object.assign(folder, body());
      return json(route, { folder, ok: true });
    }

    // The channel library: files on a channel target, saved as base64 (no uploads in parts here).
    if (sub === '/file-storage') return json(route, { canDeleteVersions: true, maxUploadBytes: 15_000_000, ok: true, storage: { bytes: 0, files: world.files.length, versions: 0 }, uploadsByParts: false });
    if (sub === '/files' && method === 'GET' && url.searchParams.get('targetType') === 'channel') {
      const channelId = url.searchParams.get('targetId');
      return json(route, { canWrite: true, files: world.files.filter((file) => file.targetId === channelId).map(presentFile), ok: true });
    }
    if (sub === '/files' && method === 'POST' && body().targetType === 'channel') {
      record();
      const input = body();
      const existing = world.files.find((file) => file.targetId === input.targetId && (file.folderId ?? null) === (input.folderId ?? null) && file.fileName.toLowerCase() === input.fileName.toLowerCase());
      if (existing) {
        Object.assign(existing, { updatedAt: now(), version: existing.version + 1 });
        return json(route, { file: presentFile(existing), ok: true }, 201);
      }
      const file = { contentType: input.fileType, createdAt: now(), fileName: input.fileName, fileSize: Math.floor((input.fileContentsBase64.length * 3) / 4), folderId: input.folderId ?? null, id: nextId('file'), targetId: input.targetId, updatedAt: now(), version: 1 };
      world.files.push(file);
      return json(route, { file: presentFile(file), ok: true }, 201);
    }
    if ((match = /^\/files\/([^/]+)\/(preview-url|download-url)$/.exec(sub))) {
      const file = world.files.find((entry) => entry.id === match[1]);
      if (!file) return route.fallback();
      world.calls.push({ body: null, method, path: sub, userId });
      if (match[2] === 'download-url') return json(route, { fileName: file.fileName, ok: true, url: `/api/file-transfers/files/channel-download-${file.id}` });
      if (world.scanning?.[file.id] > 0) {
        world.scanning[file.id] -= 1;
        return json(route, { details: { code: 'file_scanning', scanStatus: 'pending' }, error: 'This file is still being scanned for viruses. Try again in a minute.', ok: false }, 409);
      }
      const preview = world.previews?.[file.id] ?? { kind: previewKind(file) };
      const signed = ['image', 'pdf', 'video'].includes(preview.kind);
      return json(route, { expiresAt: signed ? '2099-01-01T00:00:00.000Z' : null, fileName: file.fileName, ok: true, reason: preview.reason ?? (signed ? null : 'unsupported'), url: signed ? `/api/file-transfers/files/channel-preview-${file.id}` : null, version: file.version, ...preview });
    }
    if ((match = /^\/files\/([^/]+)\/(versions|comments|mentionables|editing)$/.exec(sub))) {
      const file = world.files.find((entry) => entry.id === match[1]);
      if (!file) return route.fallback();
      if (match[2] === 'versions' && method === 'GET') {
        return json(route, { ok: true, versions: Array.from({ length: file.version }, (_, index) => ({ contentType: file.contentType, current: index === 0, deletedAt: null, fileName: file.fileName, fileSize: file.fileSize, note: '', scanStatus: 'clean', uploadedAt: file.updatedAt, uploadedBy: { id: userId, name: PEOPLE[userId].name }, version: file.version - index })) });
      }
      if (match[2] === 'versions' && method === 'POST') {
        record();
        Object.assign(file, { updatedAt: now(), version: file.version + 1 });
        return json(route, { file: presentFile(file), ok: true, unchanged: false }, 201);
      }
      if (match[2] === 'mentionables') return json(route, { ok: true, people });
      if (match[2] === 'editing') {
        record();
        file.editing = method === 'PUT' ? { name: PEOPLE[userId].name, since: now(), userId } : null;
        return json(route, { channelId: file.targetId, editing: file.editing, fileId: file.id, ok: true });
      }
      if (method === 'POST') {
        record();
        const input = body();
        const comment = { authorId: userId, body: input.body, createdAt: now(), fileVersion: file.version, id: nextId('comment'), parentId: input.parentId ?? null, targetId: file.id, targetType: 'file' };
        world.comments.push(comment);
        return json(route, { channelId: file.targetId, comment: { ...presentPost(comment), replies: [] }, mentioned: [], ok: true }, 201);
      }
      const roots = world.comments.filter((comment) => comment.targetId === file.id && !comment.parentId);
      const present = (comment) => ({ ...presentPost(comment), replies: world.comments.filter((reply) => reply.parentId === comment.id).map(present) });
      return json(route, { canComment: true, channelId: file.targetId, comments: roots.map(present), currentVersion: file.version, fileId: file.id, more: false, ok: true });
    }
    return route.fallback();
  });

  await page.route(/\/api\/file-transfers\/files\/channel-(preview|download)-[^/]+$/, (route) => {
    const [, action, id] = /channel-(preview|download)-([^/]+)$/.exec(route.request().url());
    const file = world.files.find((entry) => entry.id === id);
    if (!file) return route.fulfill({ status: 404 });
    if (action === 'download') return route.fulfill({ body: 'contents', headers: { 'Content-Disposition': `attachment; filename="${file.fileName}"`, 'Content-Type': 'application/octet-stream' }, status: 200 });
    const [body, type] = previewKind(file) === 'image' ? [PNG, 'image/png'] : [PDF, 'application/pdf'];
    return route.fulfill({ body, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Disposition': 'inline', 'Content-Type': type }, status: 200 });
  });

  return world;
}

/**
 * Holds the project event stream until `release(frames)`, then sends those frames: what another
 * person's write publishes (channel.updated). Reconnects after that carry nothing new.
 */
export async function holdProjectStream(page, projectId = 'project-synthetic') {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let delivered = false;
  await page.route(`${API_ORIGIN}/api/projects/${projectId}/events`, async (route) => {
    if (delivered) return route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 });
    const frames = await released;
    try {
      await route.fulfill({ body: frames, contentType: 'text/event-stream', status: 200 });
      delivered = true;
    } catch {
      // That page closed while its stream was held.
    }
  });
  return (events) => release(['event: connected\ndata: {}\n\n', ...events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)].join(''));
}
