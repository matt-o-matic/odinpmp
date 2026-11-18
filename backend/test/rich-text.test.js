import assert from 'node:assert/strict';
import test from 'node:test';

import {
  looksLikeRichHtml,
  normalizeStoredRichTextMarkdown,
  renderStoredRichTextToHtml,
} from '../src/lib/content/rich-text.js';

test('normalizeStoredRichTextMarkdown converts legacy html into markdown storage', () => {
  const result = normalizeStoredRichTextMarkdown('<h2>Summary</h2><p>Hello <strong>world</strong>.</p><ul><li>One</li></ul>');

  assert.match(result, /^## Summary/m);
  assert.match(result, /Hello \*\*world\*\*\./);
  assert.match(result, /^-\s+One/m);
});

test('markdown with inline mention html is still treated as markdown content', () => {
  const source = '## Summary\n\nPing <span class="mention" data-user-id="user-1" data-mention-label="Grace Hopper">@Grace Hopper</span>.';
  const rendered = renderStoredRichTextToHtml(source);

  assert.equal(looksLikeRichHtml(source), false);
  assert.match(rendered, /<h2>Summary<\/h2>/);
  assert.match(rendered, /class="mention"/);
  assert.match(rendered, /@Grace Hopper/);
});
