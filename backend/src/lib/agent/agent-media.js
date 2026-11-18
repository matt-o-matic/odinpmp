// Images and PDFs the model looks at. A tool that shows the model a file returns it under
// `media` beside its JSON result; the agent loop sends the JSON as text and each media entry
// as an input_image or input_file part of the same function_call_output. MCP clients get the
// media as image or embedded-resource content.
//
// The bytes are for one request only. Anything kept (the transcript, a turn paused for
// confirmation, decision evidence, logs) holds "[image]" or "[file: name]" in their place.

export const MEDIA_KEY = 'media';

// One image or PDF the model is shown, and the caps on what one turn sends.
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const TURN_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_CONTENT_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const IMAGE_EXTENSIONS = Object.freeze({ gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/x-download']);

const baseType = (contentType) => String(contentType ?? '').split(';')[0].trim().toLowerCase();
const extensionOf = (fileName) => /\.([a-z0-9]{1,10})$/i.exec(String(fileName ?? '').trim())?.[1].toLowerCase() ?? '';

/** The kind of media a file can be shown to the model as ('image' or 'pdf') and its type, or null. */
export function mediaKindOf({ contentType, fileName } = {}) {
  const declared = baseType(contentType);
  const type = GENERIC_TYPES.has(declared) ? IMAGE_EXTENSIONS[extensionOf(fileName)] ?? (extensionOf(fileName) === 'pdf' ? 'application/pdf' : declared) : declared === 'image/jpg' ? 'image/jpeg' : declared;
  if (IMAGE_CONTENT_TYPES.includes(type)) return { contentType: type, kind: 'image', maxBytes: IMAGE_MAX_BYTES };
  if (type === 'application/pdf') return { contentType: type, kind: 'pdf', maxBytes: PDF_MAX_BYTES };
  return null;
}

const placeholder = (part) => {
  if (part?.type === 'input_image') return '[image]';
  if (part?.type === 'input_file') return `[file${part.filename ? `: ${part.filename}` : ''}]`;
  return null;
};

/** The model's input part for one media entry ({ kind, contentType, data, name }). */
export function mediaInputPart({ contentType, data, kind, name = '' }) {
  if (kind === 'pdf') return { file_data: `data:application/pdf;base64,${data}`, filename: name || 'document.pdf', type: 'input_file' };
  return { detail: 'auto', image_url: `data:${contentType};base64,${data}`, type: 'input_image' };
}

/** A tool result without its media, and the media. */
export function splitMedia(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result[MEDIA_KEY])) return { media: [], result };
  const { [MEDIA_KEY]: media, ...rest } = result;
  return { media, result: rest };
}

/**
 * What a function_call_output carries for a tool result: its JSON (through `toText`, which
 * shortens it), and when the result has media, an array of that text and the media parts.
 */
export function toolOutputFor(result, toText) {
  const { media, result: rest } = splitMedia(result);
  if (!media.length) return toText(result);
  return [{ text: toText(rest), type: 'input_text' }, ...media.map(mediaInputPart)];
}

/** A message's content or a tool output as text, with media shown as placeholders. */
export function mediaFreeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return String(value);
  return value.map((part) => placeholder(part) ?? part?.text ?? part?.refusal ?? '').filter(Boolean).join('\n');
}

const hasMedia = (value) => Array.isArray(value) && value.some((part) => part?.type === 'input_image' || part?.type === 'input_file');

/**
 * Input items with every image and PDF replaced by a text placeholder, for anything kept beyond
 * one request (a turn paused for confirmation keeps its input).
 */
export function withoutMedia(items = []) {
  return items.map((item) => {
    if (item?.type === 'function_call_output' && hasMedia(item.output)) return { ...item, output: mediaFreeText(item.output) };
    if (hasMedia(item?.content)) return { ...item, content: item.content.map((part) => (placeholder(part) ? { text: placeholder(part), type: 'input_text' } : part)) };
    return item;
  });
}
