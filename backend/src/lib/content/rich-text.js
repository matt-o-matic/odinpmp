import { marked } from 'marked';
import TurndownService from 'turndown';

import { sanitizeRichHtml } from './html-content.js';

const HTML_PATTERN = /<\/?[a-z][^>]*>/i;

const turndownService = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
  hr: '---',
});

turndownService.keep(['table', 'thead', 'tbody', 'tr', 'th', 'td', 'u']);

turndownService.addRule('assistantMentionSpan', {
  filter(node) {
    if (node.nodeName !== 'SPAN') {
      return false;
    }

    return /\bmention\b/i.test(node.getAttribute('class') ?? '');
  },
  replacement(_content, node) {
    const label = node.getAttribute('data-mention-label') ?? node.textContent?.replace(/^@/, '') ?? '';
    const userId = node.getAttribute('data-user-id') ?? node.getAttribute('data-userid') ?? '';
    return `<span class="mention" data-mention-label="${escapeHtmlAttribute(label)}" data-user-id="${escapeHtmlAttribute(userId)}">@${escapeHtmlText(label || userId)}</span>`;
  },
});

turndownService.addRule('assistantImage', {
  filter(node) {
    return node.nodeName === 'IMG';
  },
  replacement(_content, node) {
    const alt = escapeMarkdownText(node.getAttribute('alt') ?? '');
    const title = escapeMarkdownText(node.getAttribute('title') ?? '');
    const fileId = node.getAttribute('data-file-id') ?? '';
    const src = fileId
      ? `odin-file://${fileId}`
      : node.getAttribute('src') ?? '';

    if (!src) {
      return '';
    }

    return title
      ? `![${alt}](${src} "${title}")`
      : `![${alt}](${src})`;
  },
});

function escapeHtmlAttribute(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlText(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeMarkdownText(value = '') {
  return String(value ?? '').replace(/[\[\]\\"]/g, '\\$&');
}

function normalizeMarkdownWhitespace(value = '') {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function looksLikeRichHtml(value = '') {
  const normalized = String(value ?? '').trim();

  if (!normalized) {
    return false;
  }

  return normalized.startsWith('<') && HTML_PATTERN.test(normalized);
}

export function renderStoredRichTextToHtml(value = '') {
  if (looksLikeRichHtml(value)) {
    return sanitizeRichHtml(value);
  }

  const markdown = normalizeMarkdownWhitespace(value);

  if (!markdown) {
    return '';
  }

  return sanitizeRichHtml(marked.parse(markdown, {
    breaks: false,
    gfm: true,
  }));
}

export function normalizeStoredRichTextMarkdown(value = '') {
  const normalized = String(value ?? '').trim();

  if (!normalized) {
    return '';
  }

  if (!looksLikeRichHtml(normalized)) {
    return normalizeMarkdownWhitespace(normalized);
  }

  return normalizeMarkdownWhitespace(turndownService.turndown(sanitizeRichHtml(normalized)));
}

export function richTextToPlainText(value = '') {
  return renderStoredRichTextToHtml(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
