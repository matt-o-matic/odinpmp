import assert from 'node:assert/strict';
import test from 'node:test';

import {
  editorHtmlToStoredMarkdown,
  getFileContentUrl,
  htmlToPlainText,
  hydrateRichHtml,
  looksLikeRichHtml,
  normalizeCompactMarkdownBlocks,
  renderRichTextToHtml,
  richTextToEditorHtml,
  serializeRichHtml,
} from '../src/lib/rich-content/html.js';

test('hydrateRichHtml converts odin file links to API content URLs', () => {
  const html = '<p><img src="odin-file://file-123" data-file-id="file-123"></p>';
  const result = hydrateRichHtml(html, 'http://localhost:3001');

  assert.match(result, /http:\/\/localhost:3001\/api\/files\/file-123\/content/);
});

test('serializeRichHtml converts hydrated API URLs back to odin file references', () => {
  const html = `<p><img src="${getFileContentUrl('file-123', 'http://localhost:3001')}" data-file-id="file-123"></p>`;
  const result = serializeRichHtml(html, 'http://localhost:3001');

  assert.match(result, /src="odin-file:\/\/file-123"/);
});

test('htmlToPlainText strips markup for list previews', () => {
  const result = htmlToPlainText('<p>Hello <strong>world</strong></p><ul><li>One</li></ul>');

  assert.equal(result, 'Hello world One');
});

test('richTextToEditorHtml renders stored markdown as editor-ready rich content', () => {
  const result = richTextToEditorHtml('## Summary\n\n- First item\n- Second item', 'http://localhost:3001', {
    storageFormat: 'markdown',
  });

  assert.match(result, /<h2[^>]*>Summary<\/h2>/);
  assert.match(result, /<li>First item<\/li>/);
  assert.match(result, /<li>Second item<\/li>/);
});

test('editorHtmlToStoredMarkdown converts editor html into markdown storage', () => {
  const html = [
    '<h2>Summary</h2>',
    '<p>Hello <strong>world</strong>.</p>',
    `<p><img src="${getFileContentUrl('file-123', 'http://localhost:3001')}" data-file-id="file-123" alt="Mock Screenshot"></p>`,
  ].join('');

  const result = editorHtmlToStoredMarkdown(html, 'http://localhost:3001');

  assert.match(result, /^## Summary/m);
  assert.match(result, /Hello \*\*world\*\*\./);
  assert.match(result, /!\[Mock Screenshot\]\(odin-file:\/\/file-123\)/);
});

test('renderRichTextToHtml renders markdown for assistant and project previews', () => {
  const result = renderRichTextToHtml('## Summary\n\nLine one.\n\n- Alpha\n- Beta');

  assert.match(result, /<h2[^>]*>Summary<\/h2>/);
  assert.match(result, /<p>Line one\.<\/p>/);
  assert.match(result, /<li>Alpha<\/li>/);
  assert.match(result, /<li>Beta<\/li>/);
});

test('renderRichTextToHtml renders assistant headings, emphasis, numbered lists, tables, and links with markdown-it', () => {
  const result = renderRichTextToHtml([
    '### Short assessment',
    '',
    'The plan is **broad** but *incomplete*.',
    '',
    '1. Confirm scope',
    '2. Assign owners',
    '',
    '| Area | State |',
    '| --- | --- |',
    '| Scope | Open |',
    '',
    '[Review](https://example.com/project)',
  ].join('\n'));

  assert.match(result, /<h3>Short assessment<\/h3>/);
  assert.match(result, /<strong>broad<\/strong>/);
  assert.match(result, /<em>incomplete<\/em>/);
  assert.match(result, /<ol>/);
  assert.match(result, /<table>/);
  assert.match(result, /href="https:\/\/example\.com\/project"/);
});

test('renderRichTextToHtml sanitizes untrusted assistant markdown html and links', () => {
  const result = renderRichTextToHtml('Safe <script>alert(1)</script> <a href="javascript:alert(2)" onclick="alert(3)">link</a>.');

  assert.doesNotMatch(result, /<script|onclick|javascript:/i);
  assert.match(result, /Safe/);
  assert.match(result, />link<\/a>/);
});

test('normalizeCompactMarkdownBlocks restores block boundaries in flattened assistant markdown', () => {
  const compact = 'Overall, the project is **not ready**. ### Short assessment - The draft has **broad coverage**. - But key decisions remain unresolved. ### What is missing 1. **Scope** - Define launch boundaries. 2. **Ownership** - Assign approvers.';
  const result = renderRichTextToHtml(normalizeCompactMarkdownBlocks(compact));

  assert.match(result, /<p>Overall, the project is <strong>not ready<\/strong>\.<\/p>/);
  assert.match(result, /<h3>Short assessment<\/h3>/);
  assert.match(result, /<ul>/);
  assert.match(result, /<li>The draft has <strong>broad coverage<\/strong>\.<\/li>/);
  assert.match(result, /<h3>What is missing<\/h3>/);
  assert.match(result, /<ol>/);
  assert.match(result, /<strong>Scope<\/strong>/);
  assert.match(result, /<strong>Ownership<\/strong>/);
});

test('renderRichTextToHtml still treats markdown with inline mention html as markdown', () => {
  const source = '## Summary\n\nPing <span class="mention" data-user-id="user-1" data-mention-label="Grace Hopper">@Grace Hopper</span>.';
  const result = renderRichTextToHtml(source);

  assert.equal(looksLikeRichHtml(source), false);
  assert.match(result, /<h2[^>]*>Summary<\/h2>/);
  assert.match(result, /class="mention"/);
  assert.match(result, /@Grace Hopper/);
});

test('htmlToPlainText also strips markdown formatting for list previews', () => {
  const result = htmlToPlainText('## Summary\n\n- One\n- Two');

  assert.equal(result, 'Summary One Two');
});
