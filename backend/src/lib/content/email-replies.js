import { emailHtmlHasFormatting, emailHtmlToMarkdown } from './email-markdown.js';

// Reply emails as comment text: quoted history removed, and formatting kept as Markdown.
// Used for replies to clarification, Bug Reporter and ticket emails.

function stripQuotedReplyHistory(text = '') {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];

  for (const line of lines) {
    if (/^\s*>/.test(line)) {
      break;
    }

    if (/^\s*(on|from|sent|subject):/i.test(line)) {
      break;
    }

    if (/^\s*on .+wrote:\s*$/i.test(line) || /^\s*on .+:\s*$/i.test(line)) {
      break;
    }

    kept.push(line);
  }

  return stripTrailingInlineReplyHistory(kept.join('\n').trim());
}

function stripTrailingInlineReplyHistory(text = '') {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  const inlineQuotedReplyMatch = normalized.match(/^([\s\S]*?)\s+On .+wrote:\s*$/i);
  if (!inlineQuotedReplyMatch) {
    return normalized;
  }

  return String(inlineQuotedReplyMatch[1] ?? '').trim();
}

function stripQuotedReplyHistoryFromHtml(html = '') {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<div\b[^>]*class=(["'])[^"']*\bgmail_quote\b[^"']*\1[^>]*>[\s\S]*$/i, ' ')
    .replace(/<blockquote\b[\s\S]*$/i, ' ')
    .trim();
}

function decodeBasicHtmlEntities(text = '') {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)));
}

function plainTextFromHtml(html = '') {
  return decodeBasicHtmlEntities(stripQuotedReplyHistoryFromHtml(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|section|article)>/gi, '\n')
    .replace(/<(p|div|tr|h[1-6]|ul|ol|table|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n'))
    .trim();
}

// Reply history in Markdown converted from HTML: the HTML quote is already gone, so a line
// starting with > is the sender's own quote. Header lines may be bold ("**From:**").
function stripReplyHistoryMarkers(markdown = '') {
  const kept = [];
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const plain = line.replace(/[*_~`\\]/g, '');
    if (/^\s*(on|from|sent|subject):/i.test(plain) || /^\s*on .+wrote:\s*$/i.test(plain) || /^\s*-{2,}\s*original message\s*-{2,}/i.test(plain)) break;
    kept.push(line);
  }
  return kept.join(String.fromCharCode(10)).trim();
}

/**
 * A reply email's body as comment Markdown, without quoted history. HTML with formatting is
 * converted to Markdown (lib/content/email-markdown.js); otherwise the reply is read as text,
 * which keeps any Markdown the sender typed.
 */
export function normalizeInboundReplyBody({ htmlBody = '', textBody = '' } = {}) {
  const html = stripQuotedReplyHistoryFromHtml(htmlBody);
  if (emailHtmlHasFormatting(html)) {
    const markdown = stripReplyHistoryMarkers(emailHtmlToMarkdown(html));
    if (markdown) return markdown;
  }

  const strippedHtml = stripQuotedReplyHistory(plainTextFromHtml(htmlBody));
  if (strippedHtml) {
    return strippedHtml;
  }

  const strippedText = stripQuotedReplyHistory(textBody);
  if (strippedText) {
    return strippedText;
  }

  return '';
}
