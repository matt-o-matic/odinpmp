// The @odin tag in channel posts (docs/engagements/plan.md, Odin in channels). It is stored as
// `@[Odin](odin:odin)`, a token of its own beside the user and stakeholder tokens, so it never
// resolves to a person and never sends a mention email. The mention picker offers it while the
// project's "Let Odin answer when tagged" setting is on. A plain "@odin" typed without the picker
// counts too.
//
// With the setting off, every form is saved as the plain text "@Odin" and nothing runs.

export const ODIN_TOKEN = '@[Odin](odin:odin)';
export const ODIN_MENTIONABLE = Object.freeze({ detail: 'AI assistant', kind: 'odin', name: 'Odin', ref: 'odin:odin' });

const TOKEN_PATTERN = /@\[[^\]\n]{1,120}\]\(odin:odin\)/g;
// "@odin" as a word of its own: not part of an email address or a longer name.
const PLAIN_PATTERN = /(^|[\s([{>"'“‘])@odin(?![\w.@-]*\w)/gi;

/** Saves each @odin tag in a body as the token (setting on) or as plain "@Odin" (off). */
export function normalizeOdinTags(body = '', { enabled }) {
  const text = String(body ?? '').replace(TOKEN_PATTERN, '@odin');
  return text.replace(PLAIN_PATTERN, (_match, before) => `${before}${enabled ? ODIN_TOKEN : '@Odin'}`);
}

/** Whether a stored body tags Odin. */
export function tagsOdin(body = '') {
  return String(body ?? '').includes('](odin:odin)');
}

/** The body as Odin reads it: the tag becomes "@Odin". */
export function withoutOdinToken(body = '') {
  return String(body ?? '').replace(TOKEN_PATTERN, '@Odin');
}
