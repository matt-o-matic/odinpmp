// The project's files as folders (docs/engagements/plan.md, Files): the project is the top folder,
// each channel is a folder in it, and people make their own folders inside a channel. These read
// the GET file-tree payload: { project, canManage, rootFileCount, channels: [{ id, name,
// isGeneral, archived, guestCount, fileCount, totalFileCount, folders: [{ id, parentId, name, fileCount, totalFileCount }] }] }.
// fileCount counts files directly in a channel or folder; totalFileCount includes those below.

import { childFolders, folderTrail } from '../channels/channels.js';

// The address keys for the folder shown. They differ from the channel screen's own ?channel= and
// ?folder=, so the files view never moves the channel open underneath it.
export const FILE_TREE_QUERY = Object.freeze({ channel: 'filesChannel', folder: 'filesFolder' });

const byName = (left, right) => String(left.name).localeCompare(String(right.name), undefined, { sensitivity: 'base' });

/** Channels as folders: General first, then by name, archived ones last. */
export function treeChannels(tree) {
  const channels = Array.isArray(tree?.channels) ? tree.channels : [];
  return [...channels].sort((left, right) => Number(Boolean(left.archived)) - Number(Boolean(right.archived))
    || Number(Boolean(right.isGeneral)) - Number(Boolean(left.isGeneral))
    || byName(left, right));
}

/** One channel of the tree, or null. */
export function treeChannel(tree, channelId) {
  return (tree?.channels ?? []).find((channel) => channel.id === channelId) ?? null;
}

/** The way down from the project to a folder: project, channel, then each folder. */
export function fileTreeTrail(tree, { channelId = '', folderId = '' } = {}) {
  const trail = [{ id: '', kind: 'project', label: tree?.project?.name || 'Project files' }];
  const channel = channelId ? treeChannel(tree, channelId) : null;
  if (!channel) return trail;
  trail.push({ id: channel.id, kind: 'channel', label: `#${channel.name}` });
  for (const folder of folderTrail(channel.folders ?? [], folderId || null)) trail.push({ id: folder.id, kind: 'folder', label: folder.name });
  return trail;
}

/** Where a file is, as a destination key: 'project', 'channel:<id>' or 'folder:<id>'. */
export function fileLocationKey(file) {
  if (file?.targetType === 'channel') return file.folderId ? `folder:${file.folderId}` : `channel:${file.targetId}`;
  return file?.targetType === 'project' ? 'project' : '';
}

/** Whether a file can move: only files kept at the project's top level or in a channel. */
export function canMoveFile(file) {
  return file?.targetType === 'project' || file?.targetType === 'channel';
}

/**
 * Everywhere a file can move, in tree order: the project's top level, then each open channel and
 * the folders in it, depth first. `current` marks where the file is now.
 */
export function moveDestinations(tree, file = null) {
  const here = fileLocationKey(file);
  const options = [{ current: here === 'project', depth: 0, destination: { kind: 'project' }, guestCount: 0, key: 'project', label: tree?.project?.name || 'Project files', path: tree?.project?.name || 'Project files' }];
  for (const channel of treeChannels(tree).filter((entry) => !entry.archived)) {
    const guestCount = Number(channel.guestCount ?? 0);
    const channelKey = `channel:${channel.id}`;
    options.push({ channelName: channel.name, current: here === channelKey, depth: 1, destination: { channelId: channel.id, folderId: null, kind: 'channel' }, guestCount, key: channelKey, label: `#${channel.name}`, path: `#${channel.name}` });
    const folders = channel.folders ?? [];
    const visit = (parentId, depth, prefix) => {
      for (const folder of childFolders(folders, parentId)) {
        const key = `folder:${folder.id}`;
        const path = `${prefix} / ${folder.name}`;
        options.push({ channelName: channel.name, current: here === key, depth, destination: { channelId: channel.id, folderId: folder.id, kind: 'channel' }, guestCount, key, label: folder.name, path });
        visit(folder.id, depth + 1, path);
      }
    };
    visit(null, 2, `#${channel.name}`);
  }
  return options;
}

/** A refused move that would show the file to guests: how many, or null for any other error. */
export function guestsWillSee(error) {
  const details = error?.data?.details ?? error?.details;
  return details?.code === 'guests_will_see' ? { guestCount: Number(details.guestCount ?? 0) } : null;
}

/** The file tree query for a location, with the rest of the query kept. */
export function fileTreeQuery(query = {}, { channelId = '', folderId = '' } = {}) {
  const next = { ...query };
  next[FILE_TREE_QUERY.channel] = channelId || undefined;
  next[FILE_TREE_QUERY.folder] = channelId && folderId ? folderId : undefined;
  return next;
}
