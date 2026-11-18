import assert from 'node:assert/strict';
import test from 'node:test';

import domino from '@mixmark-io/domino';

// The browser sanitizer path needs DOMParser; domino (turndown's DOM) provides it here.
globalThis.DOMParser = class {
  parseFromString(html) {
    return domino.createDocument(html);
  }
};

const { commentHtmlToMarkdown, commentPlainText, hasMarkdownTable, renderCommentHtml, tableHeaderCells } = await import('../src/lib/rich-content/comment-markdown.js');

const NL = String.fromCharCode(10);
const lines = (...parts) => parts.join(NL);

test('comment Markdown renders every tool and keeps line breaks', () => {
  const html = renderCommentHtml(lines(
    '## Pricing',
    '**Bold** *italic* <u>underlined</u> `code`',
    'second line',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '',
    '> quoted',
    '',
    '```',
    'x < y',
    '```',
  ));
  for (const fragment of ['<h2>Pricing</h2>', '<strong>Bold</strong>', '<em>italic</em>', '<u>underlined</u>', '<code>code</code>', '<br>', '<ul>', '<li>one</li>', '<ol>', '<blockquote>', '<pre><code>x &lt; y']) {
    assert.ok(html.includes(fragment), `${fragment} in ${html}`);
  }
  assert.equal(renderCommentHtml('   '), '');
});

test('tags render as mentions with their kind, and the editor HTML comes back as the same Markdown', () => {
  const source = 'Thoughts @[Uma User](user:u1) and @[Jamie Ortiz](stakeholder:s1)? cc @[Casey](person:abc123)';
  const html = renderCommentHtml(source);
  assert.ok(html.includes('<span class="mention" data-mention-kind="team" data-mention-label="Uma User" data-mention-ref="user:u1">@Uma User</span>'));
  assert.ok(html.includes('data-mention-kind="stakeholder"'));
  assert.ok(html.includes('data-mention-kind="person"'));
  assert.equal(commentHtmlToMarkdown(html), source);

  const rich = lines('## Plan', '', '**Bold** *it* <u>u</u> `c` @[Uma User](user:u1)', '', '- one', '- two', '', '1. a', '2. b', '', '> quote');
  assert.equal(commentHtmlToMarkdown(renderCommentHtml(rich)), rich);
});

test('raw HTML is text, links are limited to web and mail, and nothing else survives', () => {
  const html = renderCommentHtml('<script>alert(1)</script> <b>bold?</b> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://odin.test)');
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<b>'), false);
  assert.ok(html.includes('&lt;script&gt;'), 'shown as text');
  assert.equal(html.includes('href="javascript'), false, 'a javascript: link is not a link');
  assert.ok(html.includes('[x](javascript:alert(1))'), 'it stays as text');
  assert.ok(html.includes('<a href="https://odin.test" rel="noopener noreferrer" target="_blank">ok</a>'));
  // Pasted HTML is narrowed to the comment tags before it is stored.
  assert.equal(commentHtmlToMarkdown('<p>a<img src="x"> <iframe>b</iframe></p>'), 'a b');
  // A tag the editor did not make is plain text, not a tag.
  assert.equal(commentHtmlToMarkdown('<p>@[x](user:1)</p>'), '@\\[x\\](user:1)');
});

test('plain text for previews', () => {
  assert.equal(commentPlainText(lines('## Title', '**Bold** & @[Uma User](user:u1)', '- item')), 'Title Bold & @Uma User item');
});

test('Markdown tables render as tables and come back as the same Markdown', () => {
  const source = lines(
    'Options:',
    '',
    '| Option | Owner |',
    '| --- | --- |',
    '| **Annual** plan | @[Uma User](user:u1) |',
    '| Pipe a \\| b | `code` |',
    '|  | empty first |',
    '',
    'After the table',
  );
  const html = renderCommentHtml(source);
  for (const fragment of ['<table>', '<thead>', '<th>Option</th>', '<td><strong>Annual</strong> plan</td>', 'data-mention-ref="user:u1"', '<td>Pipe a | b</td>', '<td><code>code</code></td>', '<p>After the table</p>']) {
    assert.ok(html.includes(fragment), `${fragment} in ${html}`);
  }
  assert.equal(commentHtmlToMarkdown(html), source);
  assert.equal(commentPlainText(source), 'Options: Option Owner Annual plan @Uma User Pipe a | b code empty first After the table');
});

test('editor tables are stored as GFM tables: first row as header, one line per cell, short rows padded', () => {
  const editorHtml = '<table style="min-width: 75px"><colgroup><col style="min-width: 25px"><col></colgroup><tbody>'
    + '<tr><th colspan="1" rowspan="1"><p>Name</p></th><th><p>Notes</p></th></tr>'
    + '<tr><td><p>one</p><p>two</p></td><td><p>a|b</p></td><td><p>extra</p></td></tr>'
    + '<tr><td><p></p></td></tr>'
    + '</tbody></table>';
  const markdown = commentHtmlToMarkdown(editorHtml);
  assert.equal(markdown, lines('| Name | Notes |  |', '| --- | --- | --- |', '| one two | a\\|b | extra |', '|  |  |  |'));
  assert.ok(renderCommentHtml(markdown).includes('<td>a|b</td>'));
  // Pasted tables without a header row get their first row as the header.
  assert.equal(commentHtmlToMarkdown('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>'), lines('| a | b |', '| --- | --- |', '| 1 | 2 |'));
});

test('spotting a Markdown table in pasted text, and a typed header row', () => {
  assert.equal(hasMarkdownTable(lines('| a | b |', '|---|:-:|', '| 1 | 2 |')), true);
  assert.equal(hasMarkdownTable(lines('a | b', '-- | --')), true);
  assert.equal(hasMarkdownTable(lines('Title', '---')), false);
  assert.equal(hasMarkdownTable('| a | b |'), false);
  assert.deepEqual(tableHeaderCells('| Name | Role \\| title |'), ['Name', 'Role | title']);
  assert.deepEqual(tableHeaderCells(' |a|| '), ['a', '']);
  assert.equal(tableHeaderCells('| one |'), null);
  assert.equal(tableHeaderCells('a | b'), null);
});

test('the @Odin tag in a channel post renders as its own kind of mention and saves back as its token', () => {
  const source = '@[Odin](odin:odin) what changed since Monday?';
  const html = renderCommentHtml(source);
  assert.ok(html.includes('data-mention-kind="odin"'));
  assert.ok(html.includes('data-mention-ref="odin:odin"'));
  assert.equal(commentHtmlToMarkdown(html), source);
});
