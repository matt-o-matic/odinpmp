// Markdown fields in a review package (package-spec.md section 2, "Markdown"): CommonMark
// with raw HTML shown as text, links rendered only for https:, and images not rendered.
// The output then goes through the app's rich-content sanitizer as a second line of defense.

import MarkdownIt from 'markdown-it';

import { renderRichTextToHtml } from '../rich-content/html.js';

const parser = new MarkdownIt({ breaks: false, html: false, linkify: true, typographer: false });

parser.validateLink = (url) => /^https:\/\//i.test(String(url ?? '').trim());

// Images become their alt text.
parser.renderer.rules.image = (tokens, index, options, env, self) => parser.utils.escapeHtml(self.renderInlineAsText(tokens[index].children ?? [], options, env));

const defaultLinkOpen = parser.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
parser.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, index, options, env, self);
};

/** Safe HTML for one package markdown field. Empty input gives ''. */
export function renderPackageMarkdown(value) {
  const source = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!source) return '';
  const html = parser.render(source);
  // markdown-it already escaped every raw tag. The app's sanitizer then drops anything
  // outside its allow-list and forces rel/target on links. It treats input that does not
  // start with a tag as markdown with HTML allowed, so only tagged output goes to it.
  return html.trimStart().startsWith('<') ? renderRichTextToHtml(html) : html;
}

/** Only https: links leave the app from a package. */
export function safeExternalUrl(value) {
  const text = String(value ?? '').trim();
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
