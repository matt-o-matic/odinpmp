// The files panel's viewer (docs/engagements/plan.md, Download and preview). The server decides
// what a file shows as (GET preview-url); this guesses it only to decide whether to offer Open,
// by the same rules as backend/src/lib/files/file-preview.js.

const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
const OFFICE_TYPES = /^application\/(?:msword|rtf|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|vnd\.oasis\.opendocument\.(?:text|spreadsheet|presentation))$|^text\/rtf$/;
const BY_TYPE = [
  [/^application\/pdf$/, 'pdf'],
  [/^image\/(?:png|jpe?g|gif|webp|avif|bmp)$/, 'image'],
  [/^video\/(?:mp4|webm)$/, 'video'],
  [/^text\/(?:markdown|x-markdown)$/, 'markdown'],
  [/^text\/(?:plain|csv)$/, 'text'],
];
const BY_EXTENSION = { avif: 'image', bmp: 'image', csv: 'text', gif: 'image', jpeg: 'image', jpg: 'image', log: 'text', markdown: 'markdown', md: 'markdown', mp4: 'video', pdf: 'pdf', png: 'image', txt: 'text', webm: 'video', webp: 'image' };
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/x-download']);

const extensionOf = (fileName) => /\.([a-z0-9]{1,10})$/i.exec(String(fileName ?? '').trim())?.[1].toLowerCase() ?? '';

/** office, pdf, image, video, markdown, text, or null for a file the viewer cannot show. */
export function previewKindOf(file) {
  const type = String(file?.contentType ?? '').split(';')[0].trim().toLowerCase();
  const extension = extensionOf(file?.fileName);
  if (/^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)$/.test(type)) return null;
  if (OFFICE_TYPES.test(type) || OFFICE_EXTENSIONS.has(extension)) return 'office';
  const kind = GENERIC_TYPES.has(type) ? BY_EXTENSION[extension] ?? null : BY_TYPE.find(([pattern]) => pattern.test(type))?.[1] ?? null;
  if (kind === 'text' && (extension === 'md' || extension === 'markdown')) return 'markdown';
  return kind;
}

const NO_PREVIEW_DETAIL = {
  failed: 'This file could not be converted for a preview.',
  too_large: 'This file is too large to preview.',
  unavailable: 'This server does not make previews of Office files.',
  unsupported: 'This type of file cannot be shown here.',
};

/** What the viewer says when it has nothing to show: preparing, or no preview and why. */
export function previewNotice(preview) {
  if (preview?.kind === 'preparing') {
    return { detail: 'Office files are converted after their virus scan. This updates when the preview is ready.', preparing: true, title: 'Preparing preview' };
  }
  return { detail: NO_PREVIEW_DETAIL[preview?.reason] ?? NO_PREVIEW_DETAIL.unsupported, preparing: false, title: 'No preview' };
}

/** A text or Markdown file's contents from its signed URL. The URL carries its own authorization. */
export async function loadPreviewText(url, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(url, { credentials: 'omit' });
  if (!response.ok) throw Object.assign(new Error(`The preview could not be loaded (${response.status}).`), { status: response.status });
  return (await response.text()).replace(/^﻿/, '');
}
