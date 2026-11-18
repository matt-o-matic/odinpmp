// Text for the search index: rich text reduced to plain words, and
// long text split into passages that each get their own embedding.

const ENTITIES = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };

/**
 * Plain text from stored rich text, HTML or Markdown: tags and Markdown marks dropped, block ends
 * kept as line breaks, entities decoded, and mention tokens reduced to @Name.
 */
export function htmlToText(value) {
  return String(value ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === '#') {
        const number = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(number) && number > 0 && number < 0x110000 ? String.fromCodePoint(number) : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/@\[([^\]\n]{1,120})\]\((?:user|stakeholder|person|odin):[A-Za-z0-9_-]{1,64}\)/g, '@$1')
    // Markdown: links keep their text; emphasis, code, heading and quote marks go.
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`+)/g, '')
    .replace(/(^|[\s(])[*_]([^\s*_][^*_\n]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/^ {0,3}(#{1,6}|>)\s+/gm, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const PASSAGE_CHARS = 4000;
export const PASSAGE_OVERLAP = 400;

/**
 * Splits text into passages of about `size` characters that overlap by `overlap`, ending each at
 * a paragraph, line or sentence break, or a space, when one falls in its last quarter. Text that
 * fits in one passage comes back whole.
 */
export function splitPassages(text, { overlap = PASSAGE_OVERLAP, size = PASSAGE_CHARS } = {}) {
  const value = String(text ?? '').trim();
  if (value.length <= size) return value ? [value] : [];
  const passages = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + size);
    if (end < value.length) {
      const window = value.slice(start + Math.floor(size * 0.75), end);
      const breakAt = ['\n\n', '\n', '. ', ' '].map((mark) => window.lastIndexOf(mark)).find((index) => index >= 0);
      if (breakAt !== undefined) end = start + Math.floor(size * 0.75) + breakAt + 1;
    }
    const passage = value.slice(start, end).trim();
    if (passage) passages.push(passage);
    if (end >= value.length) break;
    // The next passage starts `overlap` back, at the start of a word.
    let next = Math.max(end - overlap, start + 1);
    const space = value.slice(next, end).search(/\s/);
    if (space >= 0) next += space + 1;
    start = next;
  }
  return passages;
}
