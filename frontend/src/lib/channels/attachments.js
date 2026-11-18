// Files attached to a post or a direct message: what each one shows as in the conversation.
// Images and videos show inline and open in the lightbox. Every other file is a card that opens
// the preview dialog. The server decides what a preview really is (GET preview-url); this only
// picks the tile, by the same rules as lib/projects/file-preview.js.
import { previewKindOf } from '../projects/file-preview.js';

/** 'image' or 'video' for a file shown inline, 'file' for a card. */
export function attachmentKind(file) {
  const kind = previewKindOf(file);
  return kind === 'image' || kind === 'video' ? kind : 'file';
}

const OFFICE_ICONS = { doc: 'bi-file-earmark-word', docx: 'bi-file-earmark-word', odp: 'bi-file-earmark-ppt', ods: 'bi-file-earmark-excel', odt: 'bi-file-earmark-word', ppt: 'bi-file-earmark-ppt', pptx: 'bi-file-earmark-ppt', rtf: 'bi-file-earmark-word', xls: 'bi-file-earmark-excel', xlsx: 'bi-file-earmark-excel' };
const KIND_ICONS = { image: 'bi-file-earmark-image', markdown: 'bi-file-earmark-text', pdf: 'bi-file-earmark-pdf', text: 'bi-file-earmark-text', video: 'bi-file-earmark-play' };

/** The Bootstrap icon for a file's card. */
export function attachmentIcon(file) {
  const kind = previewKindOf(file);
  if (kind === 'office') {
    const extension = /\.([a-z0-9]{1,10})$/i.exec(String(file?.fileName ?? ''))?.[1].toLowerCase() ?? '';
    return OFFICE_ICONS[extension] ?? 'bi-file-earmark-richtext';
  }
  return KIND_ICONS[kind] ?? 'bi-file-earmark';
}

/** Whether a preview-url error means the virus scan has not finished yet, so a later try can work. */
export function isStillScanning(error) {
  return error?.status === 409 && (error?.data?.details?.code ?? error?.details?.code) === 'file_scanning';
}

/** Waits between tries while a file is still being scanned: a few, then the live refresh takes over. */
export const SCAN_RETRY_MS = Object.freeze([3_000, 8_000, 20_000, 45_000]);

/** Whether a signed preview URL is still good for a while (its expiresAt, an ISO string). */
export function previewStillValid(expiresAt, now = Date.now(), marginMs = 30_000) {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || at - marginMs > now;
}

// Images the browser shows from a local file before it is sent. Not SVG: it is never shown inline.
const LOCAL_IMAGE_TYPES = /^image\/(?:png|jpe?g|gif|webp|avif|bmp)$/i;

/** Whether a picked file (a File) can show as a thumbnail in the box before it is sent. */
export function showsLocalThumbnail(file) {
  return LOCAL_IMAGE_TYPES.test(String(file?.type ?? ''));
}

/**
 * The files a paste carries, or [] when it is text. Copying from Word or Excel puts a picture of
 * the selection on the clipboard beside its text: that paste is text, not an attachment.
 */
export function pastedFiles(clipboardData) {
  const files = [...(clipboardData?.files ?? [])];
  if (!files.length) return [];
  return String(clipboardData.getData?.('text/plain') ?? '').trim() ? [] : files;
}

/** Whether a drag carries files (and not text or a link). */
export function dragHasFiles(dataTransfer) {
  return [...(dataTransfer?.types ?? [])].includes('Files');
}

/**
 * What a conversation tells the files in its posts (provide/inject): { projectId, token,
 * libraryLink, liveVersion }, each a getter. libraryLink is false in a direct message, which has
 * no library to show a file in.
 */
export const POST_FILES_KEY = Symbol('post-files');
