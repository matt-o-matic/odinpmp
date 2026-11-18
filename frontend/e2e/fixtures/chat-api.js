// Odin Chat for browser specs: the sidebar, its totals, Mentions, Threads, people and direct
// messages under /api/chat. Install after installSyntheticApi and installChannelsApi: the
// sidebar's channels and their unread counts come from the channels world, so opening one shows
// the same channel the Channels tab does.
const API_ORIGIN = 'http://localhost:3001';

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

const PEOPLE = [
  { email: 'pat@example.com', id: 'user-pat', name: 'Pat Seller' },
  { email: 'quinn@example.com', id: 'user-quinn', name: 'Quinn Analyst' },
];
const NAMES = { 'user-pat': 'Pat Seller', 'user-quinn': 'Quinn Analyst', 'user-synthetic': 'Synthetic Demo' };

export function createChatWorld({ channelsWorld, projectKind = 'delivery', projectName = 'Synthetic Delivery Plan' }) {
  const at = (minutes) => new Date(Date.UTC(2026, 10, 14, 10, minutes)).toISOString();
  return {
    calls: [],
    channelsWorld,
    projectKind,
    conversations: [
      { createdAt: at(0), id: 'dm-pat', members: ['user-synthetic', 'user-pat'], reads: { 'user-synthetic': null } },
    ],
    posts: [
      { authorId: 'user-pat', body: 'Can you look at the rate card before Friday?', createdAt: at(2), id: 'dm-post-1', parentId: null, targetId: 'dm-pat' },
    ],
    projectName,
    sequence: 0,
  };
}

export async function installChatApi(page, { userId = 'user-synthetic', world }) {
  const channels = world.channelsWorld;
  const now = () => new Date(Date.UTC(2026, 10, 14, 12, 30, world.sequence++)).toISOString();
  const nextId = (prefix) => `${prefix}-${++world.sequence}`;
  const channelUnread = (channel) => channels.posts.filter((post) => post.targetId === channel.id && !post.deletedAt && post.authorId !== userId && post.createdAt > (channels.reads[userId]?.[channel.id] ?? '')).length;
  const mentionMarker = `](user:${userId})`;
  const presentConversation = (conversation) => {
    const others = conversation.members.filter((id) => id !== userId);
    const lastReadAt = conversation.reads[userId] ?? null;
    const posts = world.posts.filter((post) => post.targetId === conversation.id && !post.deletedAt);
    const unread = posts.filter((post) => post.authorId !== userId && (!lastReadAt || post.createdAt > lastReadAt));
    const title = others.map((id) => NAMES[id]).join(', ');
    return {
      archivedAt: null, canPost: true, createdAt: conversation.createdAt, id: conversation.id, isGroup: conversation.members.length > 2,
      lastPostAt: posts.at(-1)?.createdAt ?? null, lastReadAt, members: conversation.members.map((id) => ({ id, name: NAMES[id] })),
      mentionCount: unread.filter((post) => post.body.includes(mentionMarker)).length, name: title, title, unreadCount: unread.length,
    };
  };
  const presentPost = (post) => ({
    attachments: [], author: { id: post.authorId, name: NAMES[post.authorId], type: 'user' }, body: post.deletedAt ? '' : post.body,
    canDelete: post.authorId === userId && !post.deletedAt, canEdit: post.authorId === userId && !post.deletedAt, canReply: !post.parentId && !post.deletedAt,
    createdAt: post.createdAt, deleted: Boolean(post.deletedAt), editedAt: null, fileVersion: null, id: post.id, isMine: post.authorId === userId, parentId: post.parentId,
    replies: world.posts.filter((reply) => reply.parentId === post.id).map(presentPost), targetId: post.targetId, targetType: 'dm',
  });
  const sidebar = () => {
    const open = channels.channels.filter((channel) => !channel.archivedAt).sort((left, right) => Number(right.isGeneral) - Number(left.isGeneral) || left.name.localeCompare(right.name));
    const groupChannels = open.map((channel) => ({ id: channel.id, isGeneral: channel.isGeneral, mentionCount: channels.posts.filter((post) => post.targetId === channel.id && post.body.includes(mentionMarker) && post.createdAt > (channels.reads[userId]?.[channel.id] ?? '')).length, name: channel.name, unreadCount: channelUnread(channel) }));
    const group = { channels: groupChannels, customer: '', id: channels.projectId, kind: world.projectKind ?? 'delivery', mentionCount: groupChannels.reduce((sum, entry) => sum + entry.mentionCount, 0), name: world.projectName, readOnly: false, status: null, unreadCount: groupChannels.reduce((sum, entry) => sum + entry.unreadCount, 0) };
    const directMessages = world.conversations.filter((conversation) => conversation.members.includes(userId)).map(presentConversation);
    const dmUnread = directMessages.reduce((sum, entry) => sum + entry.unreadCount, 0);
    return {
      directMessages,
      groups: [group],
      ok: true,
      totals: { channels: group.unreadCount, directMessages: dmUnread, mentions: group.mentionCount + directMessages.reduce((sum, entry) => sum + entry.mentionCount, 0), unread: group.unreadCount + dmUnread },
    };
  };

  await page.route(`${API_ORIGIN}/api/chat/**`, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.slice('/api/chat'.length);
    const body = () => request.postDataJSON() ?? {};
    world.calls.push({ body: method === 'GET' ? null : body(), method, path, userId });
    let match;
    if (path === '/sidebar') return json(route, sidebar());
    if (path === '/unread') return json(route, { ok: true, ...sidebar().totals });
    if (path === '/people') return json(route, { ok: true, people: PEOPLE });
    if (path === '/mentions') {
      const mentions = channels.posts.filter((post) => post.body.includes(mentionMarker)).map((post) => ({
        place: { channelId: post.targetId, channelName: channels.channels.find((channel) => channel.id === post.targetId)?.name, kind: 'delivery', projectId: channels.projectId, projectName: world.projectName, type: 'channel' },
        post: { author: { id: post.authorId, name: NAMES[post.authorId] ?? 'Pat Seller', type: 'user' }, createdAt: post.createdAt, excerpt: post.body.replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1'), id: post.id, parentId: post.parentId ?? null },
      }));
      return json(route, { mentions, nextCursor: null, ok: true });
    }
    if (path === '/threads') return json(route, { ok: true, threads: [] });
    if (path === '/conversations' && method === 'POST') {
      const members = [userId, ...body().memberIds];
      const key = [...members].sort().join(',');
      let conversation = world.conversations.find((entry) => [...entry.members].sort().join(',') === key);
      const created = !conversation;
      if (!conversation) {
        conversation = { createdAt: now(), id: nextId('dm'), members, reads: { [userId]: now() } };
        world.conversations.push(conversation);
      }
      return json(route, { conversation: presentConversation(conversation), created, ok: true }, 201);
    }
    if ((match = /^\/conversations\/([^/]+)(?:\/(.*))?$/.exec(path))) {
      const conversation = world.conversations.find((entry) => entry.id === match[1] && entry.members.includes(userId));
      if (!conversation) return json(route, { error: 'Conversation not found.', ok: false }, 404);
      const action = match[2] ?? '';
      if (action === '') return json(route, { conversation: presentConversation(conversation), ok: true });
      if (action === 'events') return route.fulfill({ body: '', contentType: 'text/event-stream', status: 200 });
      if (action === 'read') {
        conversation.reads[userId] = now();
        return json(route, { lastReadAt: conversation.reads[userId], ok: true, unreadCount: 0 });
      }
      if (action === 'mentionables') return json(route, { ok: true, people: conversation.members.filter((id) => id !== userId).map((id) => ({ detail: 'Team', kind: 'team', name: NAMES[id], ref: `user:${id}` })) });
      if (action === 'file-storage') return json(route, { canDeleteVersions: false, maxUploadBytes: 1_073_741_824, ok: true, storage: null, uploadsByParts: true });
      if (action === 'posts' && method === 'POST') {
        const input = body();
        const post = { authorId: userId, body: input.body ?? '', createdAt: now(), id: nextId('dm-post'), parentId: input.parentId ?? null, targetId: conversation.id };
        world.posts.push(post);
        conversation.reads[userId] = post.createdAt;
        return json(route, { conversationId: conversation.id, mentioned: [], ok: true, post: presentPost(post) }, 201);
      }
      if (action === 'posts') {
        const roots = world.posts.filter((post) => post.targetId === conversation.id && !post.parentId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        return json(route, { canPost: true, channel: presentConversation(conversation), nextCursor: null, ok: true, posts: roots.map(presentPost) });
      }
    }
    return json(route, { error: `Unexpected chat request ${method} ${path}`, ok: false }, 501);
  });
  return world;
}
