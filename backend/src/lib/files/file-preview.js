// File previews (docs/engagements/plan.md, Download and preview; AC-08). Which preview a file
// version gets, and where a converted PDF is stored.
//
// - Word, Excel, PowerPoint and OpenDocument files up to PREVIEW_MAX_BYTES are converted to PDF by
//   the preview worker (modules/vault/file-preview-worker.js) after their scan passes.
// - PDFs, images and MP4 or WebM video are shown as they are.
// - Plain text and Markdown are fetched and shown as text, Markdown through the app's sanitized
//   renderer.
// - HTML, SVG and everything else get no preview: they can only be downloaded.
//
// preview_storage_key, on file_vault for the current version and on file_versions for each earlier
// one, holds the state of an Office file's preview:
//
// - NULL: not converted yet.
// - previewStorageKeyFor(storage_key): the PDF, in the same storage as the file.
// - NO_PREVIEW: the conversion failed or timed out. It is not tried again: a new version gets a
//   new row, and a new try.
//
// One PDF is made per stored object. Rows that share an object (a restored version shares the
// object of the version it restores) share its PDF, as they share its scan.

export const DEFAULT_PREVIEW_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_PREVIEW_TIMEOUT_MS = 120_000;
/** Text and Markdown larger than this are not shown in the viewer. */
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** The value of preview_storage_key after a conversion failed. Never a storage key. */
export const NO_PREVIEW = 'none';

export const OFFICE_EXTENSIONS = Object.freeze(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
export const OFFICE_CONTENT_TYPES = Object.freeze([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'text/rtf',
]);

// Types shown as they are. SVG is not an image here: it can carry script.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const TEXT_TYPES = new Set(['text/plain', 'text/csv']);
const MARKDOWN_TYPES = new Set(['text/markdown', 'text/x-markdown']);
// By extension, for files a browser uploaded without a type.
const BY_EXTENSION = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  csv: 'text/csv',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  log: 'text/plain',
  markdown: 'text/markdown',
  md: 'text/markdown',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  txt: 'text/plain',
  webm: 'video/webm',
  webp: 'image/webp',
};
// Types that say nothing about the contents, so the name decides.
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/x-download']);

const baseType = (contentType) => String(contentType ?? '').split(';')[0].trim().toLowerCase();
export const extensionOf = (fileName) => {
  const match = /\.([a-z0-9]{1,10})$/i.exec(String(fileName ?? '').trim());
  return match ? match[1].toLowerCase() : '';
};

/** Whether a file is one the preview worker converts to PDF, by its type or its name. */
export function isOfficeFile({ contentType, fileName } = {}) {
  return OFFICE_CONTENT_TYPES.includes(baseType(contentType)) || OFFICE_EXTENSIONS.includes(extensionOf(fileName));
}

/**
 * The preview a file gets, with the type to serve it as: office (converted to PDF), pdf, image,
 * video, text, markdown, or none. HTML and SVG are none, whatever their name.
 */
export function previewFormatOf({ contentType, fileName } = {}) {
  const declared = baseType(contentType);
  if (/^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)$/.test(declared)) return { kind: 'none' };
  if (isOfficeFile({ contentType, fileName })) return { kind: 'office' };
  const type = GENERIC_TYPES.has(declared) ? (BY_EXTENSION[extensionOf(fileName)] ?? declared) : declared;
  if (type === 'application/pdf') return { contentType: 'application/pdf', kind: 'pdf' };
  if (IMAGE_TYPES.has(type)) return { contentType: type === 'image/jpg' ? 'image/jpeg' : type, kind: 'image' };
  if (VIDEO_TYPES.has(type)) return { contentType: type, kind: 'video' };
  // A file named .md but sent as text/plain is still Markdown.
  if (MARKDOWN_TYPES.has(type) || (TEXT_TYPES.has(type) && ['md', 'markdown'].includes(extensionOf(fileName)))) return { contentType: 'text/plain; charset=utf-8', kind: 'markdown' };
  if (TEXT_TYPES.has(type)) return { contentType: 'text/plain; charset=utf-8', kind: 'text' };
  return { kind: 'none' };
}

/** Where the PDF preview of a stored object goes: beside it, under a name derived from its key. */
export function previewStorageKeyFor(storageKey) {
  return `${String(storageKey)}.preview.pdf`;
}

/** Whether a preview_storage_key value names a stored PDF. */
export const isStoredPreview = (value) => Boolean(value) && value !== NO_PREVIEW;
