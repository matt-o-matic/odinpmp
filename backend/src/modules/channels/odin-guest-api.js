// The API a guest's @odin turn calls. A guest has no Odin account, so their turn can't call
// Odin's routes as a person does. Instead the same assistant turn (agent-chat.service.js) gets
// this client in place of a session: the same catalog tools call it with the same routes, and it
// answers only the reads a guest may make, from that guest's channels. Anything else, and any
// write, is refused here, below the model, whatever tool the model calls.
//
// - GET /api/projects/:projectId: the project's name and only the tasks the guest sees (guestTasks;
//   the app passes the pursuit board's guest task source, pursuit/pursuit-guest-tasks.js).
// - GET .../channels and .../channels/:channelId/posts: the guest's channels and their posts.
//   Guests' posts come back screened (odin-screen.js) as in a member's agent view.
// - GET .../files and .../files/:fileId/text: the files in the libraries of those channels.
import { HttpError } from '../../lib/errors/http-error.js';
import { OdinApiError } from '../../mcp/api-client.js';
import { fileTextWindow, readableFileText } from '../vault/vault.service.js';
import { decodePostCursor, encodePostCursor } from './channels.service.js';
import { SCREENED_POST_NOTE } from './odin-screen.js';

/**
 * Which tasks a guest sees on the engagement's pursuit board: listTasks returns tasks in
 * the shape the project read gives them. The app passes the pursuit board's guest task source;
 * this stands in where none is given, and shows no tasks.
 */
export const noGuestTasks = Object.freeze({
  available: false,
  async listTasks() {
    return [];
  },
});

/** The channels of a project that a guest is in, not removed. */
export async function guestChannels(projectRepository, { projectId, stakeholderId, tenantId }) {
  const channels = await projectRepository.listChannels({ projectId, tenantId });
  const mine = [];
  for (const channel of channels) {
    const guests = await projectRepository.listChannelGuests?.({ channelId: channel.id, tenantId }) ?? [];
    if (guests.some((guest) => guest.stakeholderId === stakeholderId)) mine.push(channel);
  }
  return mine;
}

const refuse = () => new OdinApiError(403, 'guest_scope', 'Not available here: this turn answers a guest from outside the team, and reads only what they can see. Say so, and suggest they ask a team member.');
const notFound = (what) => new OdinApiError(404, 'http_404', `${what} not found.`);

function fromHttpError(error) {
  if (error instanceof HttpError) return new OdinApiError(error.statusCode, error.details?.code ?? `http_${error.statusCode}`, error.message);
  return error;
}

/**
 * `screenPost(post)` says whether a guest's post may be shown; one that may not comes back as a
 * note. Only GET requests to the routes above are answered.
 */
export function createGuestAgentApi({ guestTasks = noGuestTasks, projectId, projectRepository, screenPost, stakeholderId, tenantId }) {
  let channelsLoad = null;
  const channels = () => {
    channelsLoad ??= guestChannels(projectRepository, { projectId, stakeholderId, tenantId });
    return channelsLoad;
  };
  const channelIn = async (channelId) => (await channels()).find((channel) => channel.id === channelId) ?? null;

  async function channelFiles(channel) {
    const files = await projectRepository.listFiles({ projectId, targetId: channel.id, targetType: 'channel', tenantId, user: null });
    return files.map((file) => ({ ...file, audience: 'external', links: [], targetName: channel.name }));
  }

  async function presentPosts(channel, page) {
    const all = [...page.posts, ...page.replies];
    const links = await projectRepository.listPostFileIds({ postIds: all.map((post) => post.id) });
    const files = links.length ? new Map((await channelFiles(channel)).map((file) => [file.id, file])) : new Map();
    const present = async (post) => ({
      attachments: post.deletedAt ? [] : links.filter((link) => link.postId === post.id).map((link) => files.get(link.fileId)).filter(Boolean).map((file) => ({ fileName: file.fileName, id: file.id })),
      author: post.authorType === 'odin' ? { id: null, name: 'Odin', type: 'odin' } : { id: post.authorId, name: post.authorName || (post.authorType === 'stakeholder' ? 'Guest' : 'Team member'), type: post.authorType },
      body: post.deletedAt ? '' : post.authorType === 'stakeholder' && !(await screenPost(post)) ? SCREENED_POST_NOTE : post.body,
      createdAt: post.createdAt,
      deleted: Boolean(post.deletedAt),
      id: post.id,
      parentId: post.parentId ?? null,
    });
    return Promise.all(page.posts.map(async (post) => ({ ...(await present(post)), replies: await Promise.all(page.replies.filter((reply) => reply.parentId === post.id).map(present)) })));
  }

  const routes = [
    [/^\/api\/projects\/([^/]+)$/, async () => {
      const [detail, tasks] = await Promise.all([
        projectRepository.getProjectDetail?.({ projectId, tenantId }).catch(() => null),
        guestTasks.listTasks({ projectId, stakeholderId, tenantId }),
      ]);
      const epics = tasks.length ? [{ id: `guest-tasks-${projectId}`, name: 'Your tasks', status: 'In Progress', stories: [{ id: `guest-tasks-story-${projectId}`, name: 'Your tasks', status: 'In Progress', tasks }] }] : [];
      return {
        permissions: { canEditPlan: false, canManage: false, canManageMembers: false, projectRole: 'guest', workspaceRole: null },
        project: { epics, id: projectId, name: detail?.name ?? 'Project', status: detail?.status ?? null, tickets: [] },
      };
    }],
    [/^\/api\/projects\/[^/]+\/channels$/, async () => ({
      channels: (await channels()).map((channel) => ({ archivedAt: channel.archivedAt ?? null, description: channel.description ?? '', id: channel.id, isGeneral: Boolean(channel.isGeneral), name: channel.name })),
      ok: true,
    })],
    [/^\/api\/projects\/[^/]+\/channels\/([^/]+)\/posts$/, async ([channelId], query) => {
      const channel = await channelIn(decodeURIComponent(channelId));
      if (!channel) throw notFound('Channel');
      const page = await projectRepository.listPosts({ before: decodePostCursor(query.before), limit: Math.min(50, Number(query.limit) || 20), targetId: channel.id, targetType: 'channel', tenantId });
      return { channel: { id: channel.id, name: channel.name }, nextCursor: page.hasMore && page.posts.length ? encodePostCursor(page.posts.at(-1)) : null, ok: true, posts: await presentPosts(channel, page) };
    }],
    // The file tree: the guest's channels and their folders, never the project's own files.
    [/^\/api\/projects\/[^/]+\/file-tree$/, async () => {
      const mine = await channels();
      const [files, folders, detail] = await Promise.all([
        Promise.all(mine.map(channelFiles)).then((lists) => lists.flat()),
        projectRepository.listFolders({ projectId, tenantId }),
        projectRepository.getProjectHeader?.({ projectId, tenantId }).catch(() => null),
      ]);
      const direct = (channelId, folderId) => files.filter((file) => file.targetId === channelId && (file.folderId ?? null) === folderId).length;
      return {
        canManage: false,
        channels: mine.map((channel) => ({
          archived: Boolean(channel.archivedAt),
          fileCount: direct(channel.id, null),
          folders: folders.filter((folder) => folder.channelId === channel.id).map((folder) => ({ fileCount: direct(channel.id, folder.id), id: folder.id, name: folder.name, parentId: folder.parentId ?? null })),
          guestCount: 0,
          id: channel.id,
          isGeneral: Boolean(channel.isGeneral),
          name: channel.name,
          totalFileCount: files.filter((file) => file.targetId === channel.id).length,
        })),
        ok: true,
        project: { id: projectId, name: detail?.name ?? '' },
        rootFileCount: 0,
      };
    }],
    [/^\/api\/projects\/[^/]+\/files$/, async (_params, query) => {
      // A guest has files only in their channels' libraries: none on the project or its items.
      if (query.targetType && !['project', 'channel'].includes(String(query.targetType))) return { files: [], ok: true };
      const targets = query.targetType === 'channel' ? [await channelIn(String(query.targetId ?? ''))].filter(Boolean) : await channels();
      return { files: (await Promise.all(targets.map(channelFiles))).flat(), ok: true };
    }],
    [/^\/api\/projects\/[^/]+\/files\/([^/]+)\/text$/, async ([fileId], query) => {
      const file = await projectRepository.getFileRecord({ fileId: decodeURIComponent(fileId), tenantId });
      const channel = file?.projectId === projectId && file.targetType === 'channel' ? await channelIn(file.targetId) : null;
      if (!channel || query.version) throw notFound('File');
      if ((file.scanStatus ?? 'clean') !== 'clean') throw new OdinApiError(409, 'not_scanned', 'This file has not passed its virus scan yet, so it can\'t be read.');
      const asset = await projectRepository.getFileAsset({ fileId: file.id, tenantId });
      if (!asset?.bytes) throw notFound('File');
      const text = fileTextWindow(await readableFileText(file, asset.bytes), { maxChars: Number(query.maxChars) || 20_000, offset: Number(query.offset) || 0 });
      return { file: { ...file, audience: 'external', targetName: channel.name }, ok: true, text };
    }],
  ];

  return {
    async request(method, pathname, { query = {} } = {}) {
      if (String(method).toUpperCase() !== 'GET') throw refuse();
      if (!pathname.startsWith(`/api/projects/${encodeURIComponent(projectId)}`)) throw refuse();
      for (const [pattern, handle] of routes) {
        const match = pattern.exec(pathname);
        if (!match) continue;
        try {
          return await handle(match.slice(1), query);
        } catch (error) {
          throw fromHttpError(error);
        }
      }
      throw refuse();
    },
  };
}
