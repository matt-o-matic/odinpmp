import sanitizeHtml from 'sanitize-html';

const mentionClassPattern = /\bmention\b/i;
const mentionUserIdPattern = /data-user-id="([^"]+)"/i;
const legacyMentionUserIdPattern = /data-userid="([^"]+)"/i;
const fileIdPattern = /data-file-id="([^"]+)"/i;
const odinFilePattern = /src="odin-file:\/\/([^"]+)"/i;

const sanitizeOptions = {
  allowedTags: [
    'a',
    'blockquote',
    'br',
    'code',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'hr',
    'img',
    'li',
    'ol',
    'p',
    'pre',
    's',
    'span',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target'],
    img: ['alt', 'data-file-id', 'src', 'title'],
    span: ['class', 'data-file-id', 'data-mention-label', 'data-user-id'],
    '*': ['style'],
  },
  allowedSchemes: ['data', 'http', 'https', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', {
      rel: 'noopener noreferrer',
      target: '_blank',
    }, true),
    span(tagName, attribs) {
      const classNames = String(attribs.class ?? '')
        .split(/\s+/)
        .filter(Boolean);
      const isMention = classNames.some((className) => className === 'mention');

      if (!isMention) {
        return {
          attribs: {
            class: classNames.join(' '),
          },
          tagName,
        };
      }

      return {
        attribs: {
          class: 'mention',
          'data-mention-label': attribs['data-mention-label'] ?? '',
          'data-user-id': attribs['data-user-id'] ?? attribs.dataUserid ?? attribs['data-userid'] ?? '',
        },
        tagName,
      };
    },
  },
};

export function sanitizeRichHtml(html = '') {
  const normalizedInput = String(html ?? '')
    .replace(/data-userid=/gi, 'data-user-id=')
    .replace(/<img([^>]*?)data-file-id="([^"]+)"([^>]*?)src="blob:[^"]*"([^>]*)>/gi, '<img$1data-file-id="$2"$3src="odin-file://$2"$4>')
    .replace(/<img([^>]*?)src="blob:[^"]*"([^>]*)data-file-id="([^"]+)"([^>]*)>/gi, '<img$1src="odin-file://$3"$2data-file-id="$3"$4>');

  const sanitized = sanitizeHtml(normalizedInput, sanitizeOptions);

  return sanitized.replace(/<img([^>]*?)data-file-id="([^"]+)"([^>]*?)>/gi, (match, before, fileId, after) => {
    const srcMatch = match.match(/src="([^"]+)"/i);
    const src = srcMatch?.[1] ?? `odin-file://${fileId}`;
    const normalizedSrc = src.startsWith('odin-file://') ? src : `odin-file://${fileId}`;
    const attributes = `${before}data-file-id="${fileId}"${after}`.replace(/\s+/g, ' ').trim();
    return `<img ${attributes} src="${normalizedSrc}">`;
  });
}

export function extractMentionedUserIds(html = '') {
  const ids = new Set();
  const matches = String(html ?? '').match(/<span\b[^>]*?>.*?<\/span>/gi) ?? [];

  for (const match of matches) {
    if (!mentionClassPattern.test(match)) {
      continue;
    }

    const userId = match.match(mentionUserIdPattern)?.[1] ?? match.match(legacyMentionUserIdPattern)?.[1] ?? '';

    if (userId) {
      ids.add(userId);
    }
  }

  return [...ids];
}

export function extractReferencedFileIds(html = '') {
  const ids = new Set();
  const imageMatches = String(html ?? '').match(/<img\b[^>]*?>/gi) ?? [];

  for (const match of imageMatches) {
    const fileId = match.match(fileIdPattern)?.[1] ?? match.match(odinFilePattern)?.[1] ?? '';

    if (fileId) {
      ids.add(fileId);
    }
  }

  return [...ids];
}
