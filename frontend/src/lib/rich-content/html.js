import MarkdownIt from 'markdown-it';
import TurndownService from 'turndown';

import { resolveApiBaseUrl } from '../api/base-url.js';

const HTML_PATTERN = /<\/?[a-z][^>]*>/i;
const ALLOWED_TAGS = new Set([
  'A',
  'BLOCKQUOTE',
  'BR',
  'CODE',
  'EM',
  'H1',
  'H2',
  'H3',
  'H4',
  'HR',
  'IMG',
  'LI',
  'OL',
  'P',
  'PRE',
  'S',
  'SPAN',
  'STRONG',
  'TABLE',
  'TBODY',
  'TD',
  'TH',
  'THEAD',
  'TR',
  'U',
  'UL',
]);
const ALLOWED_ATTRIBUTES = {
  A: new Set(['href', 'rel', 'target']),
  IMG: new Set(['alt', 'data-file-id', 'src', 'title']),
  // data-mention-ref and data-mention-kind: tags in Requirements comments (comment-markdown.js).
  SPAN: new Set(['class', 'data-file-id', 'data-mention-kind', 'data-mention-label', 'data-mention-ref', 'data-user-id']),
};
const markdownParser = new MarkdownIt({
  breaks: false,
  html: true,
  linkify: true,
  typographer: false,
});

function normalizeApiBaseUrl(apiBaseUrl) {
  return apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
}

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

export function getFileContentUrl(fileId, apiBaseUrl) {
  return new URL(`api/files/${fileId}/content`, normalizeApiBaseUrl(apiBaseUrl)).toString();
}

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

export function normalizeCompactMarkdownBlocks(value = '') {
  const normalized = normalizeMarkdownWhitespace(value);
  if (!/(?:^|[.!?])\s+#{1,6}\s/.test(normalized)) {
    return normalized;
  }

  return normalized
    .replace(/([.!?])\s+(#{1,6}\s+)/g, '$1\n\n$2')
    .replace(/^(#{1,6}\s+[^\n]*?)\s+(?=-\s+|\d+\.\s+)/gm, '$1\n\n')
    .replace(/([.!?])\s+-\s+(?=(?:\*\*|[A-Z0-9]))/g, '$1\n- ')
    .replace(/([.!?])\s+(\d+\.)\s+(?=(?:\*\*|[A-Z]))/g, '$1\n$2 ');
}

function unwrapElement(element) {
  const parent = element.parentNode;

  if (!parent) {
    return;
  }

  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element);
  }

  parent.removeChild(element);
}

function sanitizeAnchorHref(href = '') {
  const normalized = String(href ?? '').trim();

  if (!normalized) {
    return '';
  }

  if (/^(https?:|mailto:|#)/i.test(normalized)) {
    return normalized;
  }

  return '';
}

function sanitizeClientRichHtmlFallback(html = '') {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\shref=(["'])javascript:[\s\S]*?\1/gi, '');
}

/**
 * Keeps only allowed tags and attributes. `allowedTags` narrows the tag list for a context
 * (comments allow no images).
 */
export function sanitizeClientRichHtml(html = '', { allowedTags = ALLOWED_TAGS } = {}) {
  const normalized = String(html ?? '').replace(/data-userid=/gi, 'data-user-id=');

  if (typeof DOMParser === 'undefined') {
    return sanitizeClientRichHtmlFallback(normalized);
  }

  const doc = new DOMParser().parseFromString(`<div>${normalized}</div>`, 'text/html');
  const root = doc.body.firstElementChild;

  if (!root) {
    return '';
  }

  const walk = (node) => {
    for (const child of Array.from(node.children)) {
      walk(child);
    }

    if (node === root) {
      return;
    }

    if (!allowedTags.has(node.tagName)) {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') {
        node.remove();
        return;
      }

      unwrapElement(node);
      return;
    }

    for (const attribute of Array.from(node.attributes)) {
      const allowed = ALLOWED_ATTRIBUTES[node.tagName]?.has(attribute.name) ?? false;
      if (!allowed) {
        node.removeAttribute(attribute.name);
      }
    }

    if (node.tagName === 'A') {
      const href = sanitizeAnchorHref(node.getAttribute('href') ?? '');
      if (!href) {
        node.removeAttribute('href');
      } else {
        node.setAttribute('href', href);
      }
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('target', '_blank');
    }

    if (node.tagName === 'SPAN') {
      if (!/\bmention\b/i.test(node.getAttribute('class') ?? '')) {
        unwrapElement(node);
        return;
      }

      node.setAttribute('class', 'mention');
      node.setAttribute('data-mention-label', node.getAttribute('data-mention-label') ?? '');
      if (!node.hasAttribute('data-mention-ref')) node.setAttribute('data-user-id', node.getAttribute('data-user-id') ?? '');
    }
  };

  walk(root);
  return root.innerHTML;
}

export function looksLikeRichHtml(value = '') {
  const normalized = String(value ?? '').trim();

  if (!normalized) {
    return false;
  }

  return normalized.startsWith('<') && HTML_PATTERN.test(normalized);
}

export function hydrateRichHtml(
  html = '',
  apiBaseUrl = resolveApiBaseUrl({
    browserOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    mode: typeof window !== 'undefined' ? 'production' : 'development',
  }),
) {
  return String(html ?? '')
    .replace(/data-userid=/gi, 'data-user-id=')
    .replace(/src="odin-file:\/\/([^"]+)"/gi, (_match, fileId) => `src="${getFileContentUrl(fileId, apiBaseUrl)}"`)
    .replace(/<img([^>]*?)src="([^"]*\/api\/files\/([^"/]+)\/content[^"]*)"([^>]*?)>/gi, (match, before, _src, fileId, after) => {
      if (/data-file-id=/i.test(match)) {
        return match;
      }

      return `<img${before}src="${getFileContentUrl(fileId, apiBaseUrl)}" data-file-id="${fileId}"${after}>`;
    });
}

export function serializeRichHtml(
  html = '',
  apiBaseUrl = resolveApiBaseUrl({
    browserOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    mode: typeof window !== 'undefined' ? 'production' : 'development',
  }),
) {
  const normalizedBaseUrl = normalizeApiBaseUrl(apiBaseUrl)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return String(html ?? '')
    .replace(/data-userid=/gi, 'data-user-id=')
    .replace(new RegExp(`src="${normalizedBaseUrl}api/files/([^"/]+)/content[^"]*"`, 'gi'), 'src="odin-file://$1"')
    .replace(/src="https?:\/\/[^"]+\/api\/files\/([^"/]+)\/content[^"]*"/gi, 'src="odin-file://$1"')
    .replace(/<img([^>]*?)data-file-id="([^"]+)"([^>]*?)src="blob:[^"]*"([^>]*?)>/gi, '<img$1data-file-id="$2"$3src="odin-file://$2"$4>')
    .replace(/<img([^>]*?)src="blob:[^"]*"([^>]*?)data-file-id="([^"]+)"([^>]*?)>/gi, '<img$1src="odin-file://$3"$2data-file-id="$3"$4>');
}

export function renderRichTextToHtml(
  value = '',
  apiBaseUrl = resolveApiBaseUrl({
    browserOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    mode: typeof window !== 'undefined' ? 'production' : 'development',
  }),
) {
  if (looksLikeRichHtml(value)) {
    return sanitizeClientRichHtml(hydrateRichHtml(value, apiBaseUrl));
  }

  const markdown = normalizeMarkdownWhitespace(value);

  if (!markdown) {
    return '';
  }

  return sanitizeClientRichHtml(hydrateRichHtml(markdownParser.render(markdown), apiBaseUrl));
}

export function richTextToEditorHtml(
  value = '',
  apiBaseUrl = resolveApiBaseUrl({
    browserOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    mode: typeof window !== 'undefined' ? 'production' : 'development',
  }),
  { storageFormat = 'html' } = {},
) {
  if (storageFormat === 'markdown') {
    return renderRichTextToHtml(value, apiBaseUrl);
  }

  return hydrateRichHtml(value, apiBaseUrl);
}

export function editorHtmlToStoredMarkdown(
  html = '',
  apiBaseUrl = resolveApiBaseUrl({
    browserOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    mode: typeof window !== 'undefined' ? 'production' : 'development',
  }),
) {
  const serialized = serializeRichHtml(sanitizeClientRichHtml(html), apiBaseUrl);
  return normalizeMarkdownWhitespace(turndownService.turndown(serialized));
}

export function htmlToPlainText(html = '') {
  const rendered = looksLikeRichHtml(html)
    ? hydrateRichHtml(html)
    : markdownParser.render(normalizeMarkdownWhitespace(html));

  return String(rendered ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
