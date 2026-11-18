import { itemTypeMeta, relatedItemRoute } from './work-item-relations.js';

// What the file panels show and how they hand files to the browser. The server sends a file as a
// download unless its type is safe to show, so Open is offered only for those same types.

const PREVIEWABLE = /^(?:image\/(?:png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain|text\/csv|text\/markdown)(?:;|$)/i;
const SHOWN_AS_TEXT = /^text\//i;

// The API takes a file as up to 20,000,000 characters of base64, which holds 15 MB of bytes.
// Servers that take uploads in parts allow more (file-storage's maxUploadBytes, 1 GB).
export const MAX_FILE_BYTES = 15_000_000;

export function fileSizeLabel(bytes) {
  const size = Number(bytes ?? 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// A file or version that has not passed its virus scan cannot be downloaded or opened.
const SCAN_STATES = {
  failed: { icon: 'bi-exclamation-octagon', label: 'Scan failed' },
  infected: { icon: 'bi-shield-x', label: 'Virus found' },
  pending: { icon: 'bi-hourglass-split', label: 'Scanning' },
};

/** The scan state to show, or null for a clean file. */
export const fileScanState = (file) => SCAN_STATES[file?.scanStatus] ?? null;

export const isFileReady = (file) => !file?.scanStatus || file.scanStatus === 'clean';

export function fileDateLabel(value) {
  const date = new Date(value ?? '');
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const canPreviewFile = (file) => PREVIEWABLE.test(String(file?.contentType ?? ''));

/** Whether a file was uploaded to this target, rather than linked to it. */
export const isHomeFile = (file, { targetId, targetType }) => file?.targetId === targetId && file?.targetType === targetType;

const TARGET_LABELS = { channel: 'Channel', clarification: 'Topic', project: 'Project' };
const TARGET_ICONS = { channel: 'bi-hash', clarification: 'bi-chat-left-text', project: 'bi-folder2' };

function targetRoute(projectId, targetType, targetId, fileId = null) {
  if (targetType === 'clarification') return { name: 'project-requirements-topic', params: { projectId, topicId: targetId } };
  // A channel's library, with the file open (an engagement's address leads to its own page).
  if (targetType === 'channel') return { name: 'project-channels', params: { projectId }, query: { channel: targetId, tab: 'files', ...(fileId ? { file: fileId } : {}) } };
  if (targetType === 'project') return null;
  return relatedItemRoute(projectId, { id: targetId, itemType: targetType });
}

/** Where a file sits: the target it was uploaded to, then every work item linked to it. */
export function fileAttachments(file, projectId) {
  const place = ({ folderPath = '', linkId = '', targetId, targetName, targetType }) => ({
    icon: TARGET_ICONS[targetType] ?? itemTypeMeta(targetType).icon,
    key: linkId || `home-${targetId}`,
    label: TARGET_LABELS[targetType] ?? itemTypeMeta(targetType).label,
    linkId,
    // A channel file names its channel and the folder it is in.
    name: targetType === 'channel'
      ? [`#${targetName || 'channel'}`, folderPath].filter(Boolean).join(' / ')
      : targetName || (targetType === 'project' ? 'Project files' : 'Untitled item'),
    route: targetRoute(projectId, targetType, targetId, linkId ? null : file.id),
    targetId,
    targetType,
  });
  return [
    place({ folderPath: file.folderPath ?? '', targetId: file.targetId, targetName: file.targetName, targetType: file.targetType }),
    ...(file.links ?? []).map((link) => place({ linkId: link.id, targetId: link.targetId, targetName: link.targetName, targetType: link.targetType })),
  ];
}

const matches = (query, ...fields) => {
  const needle = String(query ?? '').trim().toLowerCase();
  return !needle || fields.join(' ').toLowerCase().includes(needle);
};

export function filterFiles(files = [], query = '') {
  return files.filter((file) => matches(query, file.fileName ?? '', file.description ?? '', file.targetName ?? '', ...(file.links ?? []).map((link) => link.targetName ?? '')));
}

/** Project files that could be linked here: everything not already on this target. */
export function linkableFiles(files = [], target, query = '') {
  return filterFiles(files, query).filter((file) => !isHomeFile(file, target) && !(file.links ?? []).some((link) => link.targetId === target.targetId && link.targetType === target.targetType));
}

/** Work items a file could be linked to: those it is not already on. */
export function linkableItems(items = [], file, query = '') {
  const taken = new Set([file?.targetId, ...(file?.links ?? []).map((link) => link.targetId)]);
  return items.filter((item) => !taken.has(item.id) && matches(query, item.name ?? '', itemTypeMeta(item.itemType).label));
}

/** A file already on this target under the name being uploaded, which the upload will version. */
export function sameNamedFile(files = [], target, fileName, folderId = null) {
  const name = String(fileName ?? '').trim().toLowerCase();
  // In a channel library a name is taken within its folder.
  return name ? files.find((file) => isHomeFile(file, target) && (file.folderId ?? null) === (folderId ?? null) && String(file.fileName ?? '').trim().toLowerCase() === name) ?? null : null;
}

/** The error a person can act on, for what the API said went wrong with a file. */
export function fileErrorMessage(error, fallback) {
  if (error?.message === 'Invalid file target.') return 'Save this item before adding files to it.';
  const code = error?.data?.details?.code;
  if (code === 'file_under_signature') return 'This file is in a signature request, so it stays shared and cannot be deleted.';
  if (code === 'version_under_signature') return 'This version is in a signature request, so it stays.';
  if (code === 'file_scanning' || code === 'file_infected' || code === 'file_scan_failed' || code === 'file_too_large' || code === 'current_version') return error.message;
  if (code === 'channel_archived' || code === 'file_being_edited' || code === 'editing_by_other' || code === 'invalid_folder') return error.message;
  if (error?.status === 423) return 'A legal hold keeps this file as it is.';
  if (error?.status === 409) return error.message === 'A file with this name is already there.' ? 'Another file here already has that name.' : 'This file changed since you opened it. Check the latest version and try again.';
  return error?.message || fallback;
}

export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // In chunks: String.fromCharCode takes a limited number of arguments.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Saves a file from a signed link: storage sends it as an attachment under its own name. */
export function saveUrl(href, fileName, { document: page = globalThis.document } = {}) {
  const link = page.createElement('a');
  link.href = href;
  link.download = fileName || 'download';
  link.rel = 'noopener';
  link.style.display = 'none';
  page.body.append(link);
  link.click();
  link.remove();
}

/**
 * Shows a file from a signed link in a new tab, opened within the click as openFile does. When
 * loadUrl gives no link, fallback opens it the older way instead.
 */
export async function openUrl(loadUrl, fallback, { window: host = globalThis.window } = {}) {
  const tab = host.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const href = await loadUrl();
    if (!href) {
      tab?.close();
      await fallback();
      return;
    }
    if (tab) tab.location.href = href;
    else host.location.assign(href);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** Hands the browser a file to save under its own name. */
export function saveBlob(blob, fileName, { document: page = globalThis.document, url = globalThis.URL } = {}) {
  const href = url.createObjectURL(blob);
  const link = page.createElement('a');
  link.href = href;
  link.download = fileName || 'download';
  link.style.display = 'none';
  page.body.append(link);
  link.click();
  link.remove();
  globalThis.setTimeout(() => url.revokeObjectURL(href), 60_000);
}

/** The blob to show in a tab: its stored type, and any text as plain text so the browser renders it. */
export function previewBlob(blob, contentType) {
  const type = SHOWN_AS_TEXT.test(contentType) ? 'text/plain;charset=utf-8' : contentType;
  return new Blob([blob], { type: type || 'application/octet-stream' });
}

/**
 * Shows a file in a new tab. The tab has to open within the click, or Safari blocks it, so it opens
 * empty and takes the file once loaded. When the browser refuses a tab, the file is saved instead.
 */
export async function openFile(load, file, { document: page = globalThis.document, url = globalThis.URL, window: host = globalThis.window } = {}) {
  const tab = host.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const { blob } = await load();
    const shown = previewBlob(blob, file.contentType);
    if (!tab) {
      saveBlob(shown, file.fileName, { document: page, url });
      return;
    }
    const href = url.createObjectURL(shown);
    tab.location.href = href;
    host.setTimeout(() => url.revokeObjectURL(href), 60_000);
  } catch (error) {
    tab?.close();
    throw error;
  }
}
