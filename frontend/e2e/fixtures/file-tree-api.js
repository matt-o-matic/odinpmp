// The project's files as folders for browser specs: GET file-tree, the file list for the
// project and each channel, PATCH a file (rename or move, with the guests check), and channel
// folders. Install after installSyntheticApi; these routes win.

import { syntheticProject } from './synthetic-api.js';

const AT = '2026-11-10T10:00:00.000Z';
const uploader = { id: 'user-synthetic', name: 'Synthetic Demo' };

const fileRecord = (overrides) => ({
  audience: 'internal', contentType: 'application/pdf', createdAt: AT, description: '', fileName: 'file.pdf', fileSize: 2048, folderId: null, id: 'file', links: [],
  projectId: syntheticProject.id, scanStatus: 'clean', signature: 'sig', targetId: syntheticProject.id, targetName: null, targetType: 'project', updatedAt: AT,
  uploadedBy: uploader, version: 1, versionNote: '', versionUploadedAt: AT, ...overrides,
});

export function createFileTreeWorld() {
  return {
    calls: [],
    canManage: true,
    canWrite: true,
    channels: [
      { archived: false, guestCount: 0, id: 'ch-general', isGeneral: true, name: 'General' },
      { archived: false, guestCount: 2, id: 'ch-client', isGeneral: false, name: 'Client review' },
      { archived: true, guestCount: 0, id: 'ch-old', isGeneral: false, name: 'Kickoff' },
    ],
    files: [
      fileRecord({ contentType: 'application/vnd.ms-excel', fileName: 'Budget.xlsx', id: 'file-budget' }),
      fileRecord({ fileName: 'MSA.pdf', folderId: 'f-contracts', id: 'file-msa', targetId: 'ch-general', targetName: 'General', targetType: 'channel' }),
      fileRecord({ fileName: 'Agenda.pdf', id: 'file-agenda', targetId: 'ch-general', targetName: 'General', targetType: 'channel' }),
    ],
    folders: [
      { channelId: 'ch-general', id: 'f-contracts', name: 'Contracts', parentId: null },
      { channelId: 'ch-general', id: 'f-signed', name: 'Signed', parentId: 'f-contracts' },
      { channelId: 'ch-client', id: 'f-deliverables', name: 'Deliverables', parentId: null },
    ],
  };
}

const json = (route, body, status = 200) => route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });

export function fileTreeOf(world) {
  return {
    canManage: world.canManage,
    channels: world.channels.map((channel) => ({
      ...channel,
      fileCount: world.files.filter((file) => file.targetType === 'channel' && file.targetId === channel.id && !file.folderId).length,
      totalFileCount: world.files.filter((file) => file.targetType === 'channel' && file.targetId === channel.id).length,
      folders: world.folders.filter((folder) => folder.channelId === channel.id).map(({ id, name, parentId }) => ({
        fileCount: world.files.filter((file) => file.folderId === id).length, id, name, parentId,
      })),
    })),
    ok: true,
    project: { id: syntheticProject.id, name: syntheticProject.name },
    rootFileCount: world.files.filter((file) => file.targetType !== 'channel').length,
  };
}

export async function installFileTreeApi(page, { world = createFileTreeWorld() } = {}) {
  const base = `/api/projects/${syntheticProject.id}`;
  await page.route((url) => url.pathname.startsWith(`${base}/`), async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const sub = url.pathname.slice(base.length);
    const body = () => request.postDataJSON() ?? {};
    let match;

    if (sub === '/file-tree' && method === 'GET') return json(route, fileTreeOf(world));
    if (sub === '/signing-requests' && method === 'GET') return json(route, { canManage: false, ok: true, requests: [] });
    if (sub === '/files' && method === 'GET') {
      const targetType = url.searchParams.get('targetType');
      const targetId = url.searchParams.get('targetId');
      const listed = targetType === 'project' ? world.files : world.files.filter((file) => file.targetType === targetType && file.targetId === targetId);
      return json(route, { canWrite: world.canWrite, files: structuredClone(listed), ok: true });
    }
    if ((match = /^\/files\/([^/]+)$/.exec(sub)) && method === 'PATCH') {
      const input = body();
      world.calls.push({ body: input, fileId: match[1], method, path: url.pathname });
      const file = world.files.find((entry) => entry.id === match[1]);
      if (!file) return json(route, { error: 'File not found.', ok: false }, 404);
      const destination = input.destination;
      if (destination?.kind === 'channel') {
        const channel = world.channels.find((entry) => entry.id === destination.channelId);
        const fromChannel = file.targetType === 'channel' ? file.targetId : null;
        if (channel.guestCount > 0 && fromChannel !== channel.id && !input.confirmGuests) {
          return json(route, { details: { code: 'guests_will_see', guestCount: channel.guestCount }, error: 'Guests in that channel will see this file.', ok: false }, 409);
        }
        Object.assign(file, { folderId: destination.folderId ?? null, targetId: channel.id, targetName: channel.name, targetType: 'channel' });
      } else if (destination?.kind === 'project') {
        Object.assign(file, { folderId: null, targetId: syntheticProject.id, targetName: null, targetType: 'project' });
      }
      if (input.fileName) file.fileName = input.fileName;
      return json(route, { file: structuredClone(file), ok: true });
    }
    if ((match = /^\/files\/([^/]+)\/versions$/.exec(sub)) && method === 'GET') {
      const file = world.files.find((entry) => entry.id === match[1]);
      return json(route, { ok: true, versions: [{ contentType: file.contentType, current: true, fileName: file.fileName, fileSize: file.fileSize, note: '', scanStatus: 'clean', uploadedAt: AT, uploadedBy: uploader, version: file.version }] });
    }
    if ((match = /^\/channels\/([^/]+)\/folders$/.exec(sub))) {
      if (method === 'POST') {
        const input = body();
        const folder = { channelId: match[1], id: `f-${world.folders.length + 1}`, name: input.name, parentId: input.parentId ?? null };
        world.folders.push(folder);
        world.calls.push({ body: input, method, path: url.pathname });
        return json(route, { folder, ok: true }, 201);
      }
      return json(route, { canManage: world.canManage, folders: world.folders.filter((folder) => folder.channelId === match[1]), ok: true });
    }
    return route.fallback();
  });
  return world;
}
