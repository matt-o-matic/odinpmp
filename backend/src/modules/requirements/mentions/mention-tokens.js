import { richTextToPlainText } from '../../../lib/content/rich-text.js';
import { portalPersonKey } from '../rounds/round-views.js';

// Mentions inside Requirements comment bodies (topic discussions and annotation threads).
//
// A mention is stored inline as `@[Name](user:<id>)` or `@[Name](stakeholder:<id>)`. The
// client portal never sees actor ids, so bodies sent to it carry
// `@[Name](person:<key>)` instead, with the same opaque key the portal already uses for
// authors (portalPersonKey), and the portal writes mentions back in that form. Anything
// that does not resolve to a person the writer may tag is saved as plain `@Name`.

const TOKEN_PATTERN = /@\[([^\]\n]{1,120})\]\((user|stakeholder|person):([A-Za-z0-9_-]{1,64})\)/g;
const ACTOR_KINDS = new Set(['user', 'stakeholder']);

function cleanLabel(value) {
  return String(value ?? '').replace(/[\]\n\r[]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Every token in a body, in order: `{ id, kind, label, raw }`. */
export function parseMentionTokens(body = '') {
  return [...String(body ?? '').matchAll(TOKEN_PATTERN)].map((match) => ({ id: match[3], kind: match[2], label: match[1], raw: match[0] }));
}

export function formatMentionToken({ id, kind, label }) {
  return `@[${cleanLabel(label) || 'someone'}](${kind}:${id})`;
}

/** The people a stored body mentions, once each: `[{ actorRef, actorType, actorId, label }]`. */
export function mentionedActors(body = '') {
  const seen = new Map();
  for (const token of parseMentionTokens(body)) {
    if (!ACTOR_KINDS.has(token.kind)) continue;
    const actorRef = `${token.kind}:${token.id}`;
    if (!seen.has(actorRef)) seen.set(actorRef, { actorId: token.id, actorRef, actorType: token.kind, label: token.label });
  }
  return [...seen.values()];
}

/** The body as people read it outside the app: every token becomes `@Name`. */
export function mentionsToPlainText(body = '') {
  return String(body ?? '').replace(TOKEN_PATTERN, (_raw, label) => `@${label}`);
}

/** The portal key for a person, without its `person:` prefix. */
export function portalMentionKey(projectId, actorRef) {
  return portalPersonKey(projectId, actorRef).slice('person:'.length);
}

/** A stored body as the portal sees it: actor ids replaced by portal keys. */
export function toPortalMentions(body = '', projectId = '') {
  return String(body ?? '').replace(TOKEN_PATTERN, (raw, label, kind, id) => (
    ACTOR_KINDS.has(kind) ? formatMentionToken({ id: portalMentionKey(projectId, `${kind}:${id}`), kind: 'person', label }) : `@${label}`
  ));
}

/**
 * Resolves the tokens in a body someone is saving against the people they may tag, and
 * returns the body to store plus the people it mentions. `people` is
 * `[{ actorType, actorId, name }]`. With `audience: 'portal'` only `person:` tokens resolve
 * (by portal key); for the team only `user:` and `stakeholder:` tokens do. Unresolved tokens
 * become `@Name`. A resolved token takes the person's current name.
 */
export function resolveMentions(body = '', { audience = 'team', people = [], projectId = '' } = {}) {
  const byRef = new Map();
  const byKey = new Map();
  for (const person of people) {
    const actorRef = `${person.actorType}:${person.actorId}`;
    byRef.set(actorRef, person);
    if (audience === 'portal') byKey.set(portalMentionKey(projectId, actorRef), person);
  }
  const mentioned = new Map();
  const text = String(body ?? '').replace(TOKEN_PATTERN, (raw, label, kind, id) => {
    const person = audience === 'portal'
      ? (kind === 'person' ? byKey.get(id) : null)
      : (ACTOR_KINDS.has(kind) ? byRef.get(`${kind}:${id}`) : null);
    if (!person) return `@${cleanLabel(label)}`;
    const actorRef = `${person.actorType}:${person.actorId}`;
    if (!mentioned.has(actorRef)) mentioned.set(actorRef, { actorId: person.actorId, actorRef, actorType: person.actorType, label: person.name || label });
    return formatMentionToken({ id: person.actorId, kind: person.actorType, label: person.name || label });
  });
  return { body: text, mentioned: [...mentioned.values()] };
}

const ENTITIES = { '&#39;': "'", '&amp;': '&', '&gt;': '>', '&lt;': '<', '&quot;': '"' };
const EXCERPT_MARK = 'zzodinmentionmarkzz';

/** A stored comment (Markdown with tags) as one line of plain text. */
export function commentPlainText(body = '') {
  return richTextToPlainText(mentionsToPlainText(body)).replace(/&(?:#39|amp|gt|lt|quot);/g, (entity) => ENTITIES[entity]);
}

/**
 * A short plain-text excerpt around the first mention of `actorRef`, for emails. Falls back
 * to the start of the comment.
 */
export function mentionExcerpt(body = '', actorRef = '', { radius = 140 } = {}) {
  let marked = false;
  const withMark = String(body ?? '').replace(TOKEN_PATTERN, (_raw, label, kind, id) => {
    if (!marked && `${kind}:${id}` === actorRef) {
      marked = true;
      return `${EXCERPT_MARK}@${label}`;
    }
    return `@${label}`;
  });
  let plain = commentPlainText(withMark);
  const offset = plain.indexOf(EXCERPT_MARK);
  plain = plain.replace(EXCERPT_MARK, '');
  if (plain.length <= radius * 2) return plain;
  const start = Math.max(0, (offset < 0 ? 0 : offset) - radius);
  const end = Math.min(plain.length, start + radius * 2);
  return `${start > 0 ? '…' : ''}${plain.slice(start, end).trim()}${end < plain.length ? '…' : ''}`;
}
