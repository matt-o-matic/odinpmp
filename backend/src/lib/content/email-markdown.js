import { marked, Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import TurndownService from 'turndown';

// Comments travel by email in both directions.
//
// Out: a comment Odin emails (Bug Reporter report updates, mention digests) is rendered from
// Markdown to formatted, sanitized HTML when parsing it as Markdown finds formatting, and is
// otherwise sent as plain text with its line breaks, as before.
//
// In: a reply whose HTML carries formatting (bold, lists, links...) is converted to Markdown,
// so a reply formatted in Gmail or Outlook is stored formatted. A reply without formatting is
// read as text, which keeps Markdown the sender typed (**bold**, - lists).
//
// Comments are Markdown with inline tags (@[Name](user:<id>)) and <u>…</u> for underline,
// the only HTML they carry; other raw HTML in a comment is shown as text.

const MENTION = /^@\[([^\]\n]{1,120})\]\((user|stakeholder|person):([A-Za-z0-9_-]{1,64})\)/;
const PLAIN_BLOCKS = new Set(['paragraph', 'space', 'text']);
const PLAIN_INLINES = new Set(['br', 'escape', 'text']);
const FORMATTING_TAG = /<(strong|b|em|i|u|s|strike|del|ul|ol|li|a|h[1-6]|blockquote|pre|code)\b/i;

function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '"': '&quot;', '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;' }[character]));
}

function normalize(value = '') {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Whether parsing the text as Markdown gives anything beyond plain paragraphs. */
export function hasMarkdownFormatting(text = '') {
  const source = normalize(text);
  if (!source) return false;
  const formatted = (tokens, inline) => (tokens ?? []).some((token) => (
    !(inline ? PLAIN_INLINES : PLAIN_BLOCKS).has(token.type) || formatted(token.tokens, true)
  ));
  return formatted(marked.lexer(source, { breaks: true, gfm: true }), false);
}

const emailMarked = new Marked({ breaks: true, gfm: true });
emailMarked.use({
  extensions: [{
    level: 'inline',
    name: 'odinMention',
    renderer: (token) => `<strong>@${escapeHtml(token.label)}</strong>`,
    start: (source) => {
      const index = source.indexOf('@[');
      return index < 0 ? undefined : index;
    },
    tokenizer(source) {
      const match = MENTION.exec(source);
      return match ? { label: match[1], raw: match[0], type: 'odinMention' } : undefined;
    },
  }],
  renderer: {
    // Raw HTML is shown as text, except the underline tags comments use.
    html: (token) => (/^<\/?u>$/i.test(String(token.text ?? '').trim()) ? token.text : escapeHtml(token.text)),
  },
});

// Tables carry their borders inline: mail clients drop or ignore most stylesheets.
const CELL_STYLE = 'border:1px solid #cbd5e1; padding:4px 8px; text-align:left; vertical-align:top;';
const EMAIL_HTML = {
  allowedAttributes: { a: ['href', 'rel', 'target'], table: ['style'], td: ['style'], th: ['style'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedTags: ['a', 'blockquote', 'br', 'code', 'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'li', 'ol', 'p', 'pre', 's', 'strong', 'u', 'ul', 'del', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }, true),
    table: sanitizeHtml.simpleTransform('table', { style: 'border-collapse:collapse; margin:0 0 8px;' }, false),
    td: sanitizeHtml.simpleTransform('td', { style: CELL_STYLE }, false),
    th: sanitizeHtml.simpleTransform('th', { style: `${CELL_STYLE} background:#eef2f7; font-weight:600;` }, false),
  },
};

/** Markdown to sanitized HTML, for emails and HTML-stored comments. */
export function markdownToSafeHtml(markdown = '') {
  const source = normalize(markdown);
  if (!source) return '';
  return sanitizeHtml(emailMarked.parse(source), EMAIL_HTML);
}

/**
 * A comment for an email body: formatted when it is Markdown, otherwise plain text with its
 * line breaks.
 */
export function commentToEmailHtml(text = '') {
  const source = normalize(text);
  if (!source) return '';
  if (hasMarkdownFormatting(source)) return markdownToSafeHtml(source);
  return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
}

// --- inbound ----------------------------------------------------------------

const turndown = new TurndownService({ bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', headingStyle: 'atx', hr: '---', strongDelimiter: '**' });
turndown.addRule('odinUnderline', { filter: ['u'], replacement: (content) => (content ? `<u>${content}</u>` : '') });
turndown.addRule('odinStrike', { filter: ['s', 'del', 'strike'], replacement: (content) => (content ? `~~${content}~~` : '') });
turndown.addRule('odinListItem', {
  filter: 'li',
  replacement(content, node, options) {
    const parent = node.parentNode;
    let prefix = `${options.bulletListMarker} `;
    if (parent?.nodeName === 'OL') {
      const start = parent.getAttribute('start');
      const index = Array.prototype.indexOf.call(parent.children, node);
      prefix = `${start ? Number(start) + index : index + 1}. `;
    }
    const isParagraph = /\n$/.test(content);
    const body = content.replace(/^\n+/, '').replace(/\n+$/, '') + (isParagraph ? '\n' : '');
    return prefix + body.replace(/\n/g, `\n${' '.repeat(prefix.length)}`) + (node.nextSibling ? '\n' : '');
  },
});

const INBOUND_HTML = {
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedTags: ['a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'i', 'li', 'ol', 'p', 'pre', 's', 'strike', 'strong', 'u', 'ul'],
  // Mail clients put whole headings in signatures and forwarded headers; comments keep three
  // levels. Table cells (signatures, layout tables) become paragraphs so their text stays apart.
  transformTags: { b: 'strong', h4: 'h3', h5: 'h3', h6: 'h3', i: 'em', strike: 's', td: 'p', th: 'p' },
};

/** Whether an email's HTML (with quoted history already removed) uses formatting. */
export function emailHtmlHasFormatting(html = '') {
  return FORMATTING_TAG.test(String(html ?? ''));
}

/** An email's HTML as comment Markdown. Images, tables and styling are dropped. */
export function emailHtmlToMarkdown(html = '') {
  const clean = sanitizeHtml(String(html ?? ''), INBOUND_HTML);
  // Empty <div><br></div> lines from mail clients leave whitespace-only lines behind.
  return normalize(turndown.turndown(clean).replace(/ /g, ' ').replace(/^[ \t]+$/gm, ''));
}
