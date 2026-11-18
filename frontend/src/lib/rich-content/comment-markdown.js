import MarkdownIt from 'markdown-it';
import TurndownService from 'turndown';

import { sanitizeClientRichHtml } from './html.js';

// Requirements comments (topic discussions and annotation threads) are stored as Markdown.
// Tags are stored inline as @[Name](user:<id>), @[Name](stakeholder:<id>), or, in the
// portal, @[Name](person:<key>) (backend/src/modules/requirements/mentions). A channel post can
// tag Odin as @[Odin](odin:odin) (backend/src/modules/channels/odin-tag.js). Underline has no
// Markdown form, so it is kept as <u>…</u>, the only HTML a comment may contain; any other
// HTML in the source is shown as text. Single line breaks are kept, so comments written as
// plain text before rich text read the same. Tables are GFM pipe tables.

const COMMENT_TAGS = new Set(['A', 'BLOCKQUOTE', 'BR', 'CODE', 'EM', 'H1', 'H2', 'H3', 'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL']);
const MENTION_TOKEN = /^@\[([^\]\n]{1,120})\]\((user|stakeholder|person|odin):([A-Za-z0-9_-]{1,64})\)/;
const MENTION_REF = /^(user|stakeholder|person|odin):[A-Za-z0-9_-]{1,64}$/;
const UNDERLINE_TAG = /^<\/?u>/;

function escapeHtml(value = '') {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cleanLabel(value) {
  return String(value ?? '').replace(/^@/, '').replace(/[\]\n\r[]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function mentionKind(kind) {
  if (kind === 'stakeholder' || kind === 'odin') return kind;
  return kind === 'user' ? 'team' : 'person';
}

const parser = new MarkdownIt({ breaks: true, html: false, linkify: true, typographer: false });

parser.inline.ruler.before('link', 'odin_mention', (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x40 /* @ */) return false;
  const match = MENTION_TOKEN.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) state.push('odin_mention', '', 0).meta = { id: match[3], kind: match[2], label: match[1] };
  state.pos += match[0].length;
  return true;
});

parser.inline.ruler.before('html_inline', 'odin_underline', (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x3c /* < */) return false;
  const match = UNDERLINE_TAG.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) state.push('html_inline', '', 0).content = match[0];
  state.pos += match[0].length;
  return true;
});

parser.renderer.rules.odin_mention = (tokens, index) => {
  const { id, kind, label } = tokens[index].meta;
  return `<span class="mention" data-mention-kind="${mentionKind(kind)}" data-mention-label="${escapeHtml(label)}" data-mention-ref="${escapeHtml(`${kind}:${id}`)}">@${escapeHtml(label)}</span>`;
};

const turndown = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
  hr: '---',
  strongDelimiter: '**',
});

// Turndown's own rule pads markers ("-   one"); comments read "- one" and "1. one".
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

turndown.addRule('odinUnderline', {
  filter: ['u'],
  replacement: (content) => (content ? `<u>${content}</u>` : ''),
});

turndown.addRule('odinMention', {
  filter: (node) => node.nodeName === 'SPAN' && /\bmention\b/.test(node.getAttribute('class') ?? ''),
  replacement(_content, node) {
    const label = cleanLabel(node.getAttribute('data-mention-label') || node.textContent);
    const ref = node.getAttribute('data-mention-ref') ?? '';
    if (!label) return '';
    return MENTION_REF.test(ref) ? `@[${label}](${ref})` : `@${label}`;
  },
});

// A table is stored as a GFM pipe table. Its first row is the header row, as GFM requires,
// whether or not it was marked as one. A cell holds one line, so its paragraphs and line
// breaks are joined with spaces, and a pipe in it is escaped. Short rows are padded.
function tableRows(table) {
  const rows = [];
  const visit = (node) => {
    for (const child of Array.from(node.childNodes ?? [])) {
      if (child.nodeName === 'TR') rows.push(Array.from(child.childNodes).filter((cell) => cell.nodeName === 'TH' || cell.nodeName === 'TD'));
      else if (['THEAD', 'TBODY', 'TFOOT'].includes(child.nodeName)) visit(child);
    }
  };
  visit(table);
  return rows.filter((row) => row.length);
}

function cellMarkdown(cell) {
  return turndown.turndown(cell.innerHTML ?? '').replace(/\s*\n+\s*/g, ' ').replace(/(?<!\\)\|/g, '\\|').trim();
}

turndown.addRule('odinTable', {
  filter: 'table',
  replacement(_content, node) {
    const rows = tableRows(node).map((row) => row.map(cellMarkdown));
    if (!rows.length) return '';
    const width = Math.max(...rows.map((row) => row.length));
    const line = (cells) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`;
    return `\n\n${[line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')}\n\n`;
  },
});

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Whether plain text holds a Markdown table: a row of cells, then a delimiter row. */
export function hasMarkdownTable(text = '') {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  return lines.some((line, index) => index > 0 && line.includes('|') && line.includes('-') && DELIMITER_ROW.test(line) && lines[index - 1].includes('|'));
}

/**
 * The cells of a line typed as a table's header row, `| Name | Role |`, or null. It needs
 * at least two cells, so a line that only starts and ends with a pipe is left alone.
 */
export function tableHeaderCells(line = '') {
  const text = String(line ?? '').trim();
  if (!/^\|.*\|$/.test(text) || text.length < 3) return null;
  const cells = text.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
  return cells.length >= 2 ? cells : null;
}

function normalize(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Safe HTML for a stored comment, for display and for loading into the editor. */
export function renderCommentHtml(markdown = '') {
  const source = normalize(markdown);
  if (!source) return '';
  return sanitizeClientRichHtml(parser.render(source), { allowedTags: COMMENT_TAGS });
}

/** The Markdown to store for the editor's HTML. */
export function commentHtmlToMarkdown(html = '') {
  const safe = sanitizeClientRichHtml(String(html ?? ''), { allowedTags: COMMENT_TAGS });
  return normalize(turndown.turndown(safe)).replace(/\n+$/g, '');
}

/** The comment as one line of plain text, for short previews. */
export function commentPlainText(markdown = '') {
  return renderCommentHtml(markdown)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|li|h[1-3]|blockquote|pre|th|td)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
