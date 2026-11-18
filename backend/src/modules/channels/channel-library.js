// Rules the vault and the channel routes share for files in a channel's library
// (docs/engagements/plan.md, Files): where an upload lands, the folder path shown with a file,
// and that an archived channel's library is read-only.
import { HttpError } from '../../lib/errors/http-error.js';

export function channelArchivedError() {
  return new HttpError(409, 'This channel is archived, so it is read-only. Restore it to make changes.', { details: { code: 'channel_archived' } });
}

/**
 * The folder an upload to a target goes into: a folder of that channel, or the library's top
 * level (null). Folders exist only in channel libraries.
 */
export async function resolveUploadFolder(repository, { folderId = null, projectId, targetId, targetType, tenantId }) {
  if (!folderId) return null;
  const folder = targetType === 'channel' ? await repository.getFolder?.({ folderId, projectId, tenantId }) : null;
  if (!folder || folder.channelId !== targetId) throw new HttpError(400, 'That folder is not in this library.', { details: { code: 'invalid_folder' } });
  return folder.id;
}

/** Each folder's path from its library's top level, by id: "Proposals / Drafts". */
export function folderPaths(folders = []) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map();
  const pathOf = (folder, seen = new Set()) => {
    if (paths.has(folder.id)) return paths.get(folder.id);
    const parent = folder.parentId && !seen.has(folder.parentId) ? byId.get(folder.parentId) : null;
    seen.add(folder.id);
    const path = parent ? `${pathOf(parent, seen)} / ${folder.name}` : folder.name;
    paths.set(folder.id, path);
    return path;
  };
  for (const folder of folders) pathOf(folder);
  return paths;
}

/** Files with the path of the folder each is in (folderPath), for lists that show it. */
export async function withFolderPaths(repository, files, { projectId, tenantId }) {
  if (!files.some((file) => file.folderId) || typeof repository.listFolders !== 'function') return files;
  const paths = folderPaths(await repository.listFolders({ projectId, tenantId }));
  return files.map((file) => (file.folderId ? { ...file, folderPath: paths.get(file.folderId) ?? null } : file));
}

/**
 * Someone else's editing marker on a file asks the uploader to confirm (AC-09). The upload still
 * checks its base version, so this only adds the question.
 */
export function assertEditingConfirmed(file, user, confirmed = false) {
  const marker = file?.editing ?? null;
  if (!marker || marker.userId === user?.id || confirmed) return;
  throw new HttpError(409, `${marker.name ?? 'Someone'} is editing this file. Upload anyway?`, { details: { code: 'file_being_edited', editing: marker } });
}

/** Refuses a change to a file in an archived channel, or to an archived channel's library. */
export async function assertChannelTargetWritable(repository, { projectId, targetId, targetType, tenantId }) {
  if (targetType !== 'channel' || typeof repository.getChannel !== 'function') return null;
  const channel = await repository.getChannel({ channelId: targetId, projectId, tenantId });
  if (channel?.archivedAt) throw channelArchivedError();
  return channel;
}
