// Builds the mention span Odin's comment editor writes (TipTap), with attributes in the order Odin's
// sanitizer stores them. The span is what makes Odin email the person (mention-notifications.js);
// text that only says "@Sam" notifies nobody.

import { renderStoredRichTextToHtml } from '../content/rich-text.js';
import { extractMentionSpans } from './mention-notifications.js';

const escapeText = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (value) => escapeText(value).replace(/"/g, '&quot;');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function mentionSpan({ id, name }) {
  return `<span class="mention" data-mention-label="${escapeAttribute(name)}" data-user-id="${escapeAttribute(id)}">@${escapeText(name)}</span>`;
}

/**
 * Puts each person's mention span where the HTML's text already names them ("@Sam Lee", or
 * "@Sam"), outside tags and existing mentions, and the rest at the start of the comment.
 */
export function placeMentions(html, people) {
  const parts = String(html ?? '').split(/(<[^>]*>)/);
  const spans = people.map(mentionSpan);
  const leading = [];
  people.forEach((person, number) => {
    const name = String(person.name ?? '').trim();
    for (const label of new Set([name, name.split(/\s+/)[0]].filter(Boolean))) {
      const pattern = new RegExp(`@${escapeRegExp(escapeText(label))}(?![\\p{L}\\p{N}_])`, 'iu');
      let inMention = false;
      for (let index = 0; index < parts.length; index += 1) {
        // split() with a capture group alternates text (even) and tags (odd).
        if (index % 2) {
          inMention = /^<span\b[^>]*\bmention\b/i.test(parts[index]) ? true : /^<\/span>/i.test(parts[index]) ? false : inMention;
        } else if (!inMention && pattern.test(parts[index])) {
          // A placeholder, so a later "@Sam" cannot match inside this span.
          parts[index] = parts[index].replace(pattern, `\u0000${number}\u0000`);
          return;
        }
      }
    }
    leading.push(spans[number]);
  });
  const placed = parts.join('').replace(/\u0000(\d+)\u0000/g, (_match, number) => spans[number]);
  if (!leading.length) return placed;
  return /^<p>/i.test(placed) ? placed.replace(/^<p>/i, `<p>${leading.join(' ')} `) : `<p>${leading.join(' ')}</p>${placed}`;
}

/**
 * Whether text, stored as Odin stores rich text, mentions someone Odin will email: the sanitizer
 * turns mention markup in any spelling it accepts into the span that emails them. Text naming a
 * mention at all counts too, so the assistant asks first rather than guess.
 */
export function textMentionsSomeone(text) {
  const value = String(text ?? '');
  return /mention|data-user-?id/i.test(value) || extractMentionSpans(renderStoredRichTextToHtml(value)).length > 0;
}
