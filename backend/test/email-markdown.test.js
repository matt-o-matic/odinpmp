import assert from 'node:assert/strict';
import test from 'node:test';

import { commentToEmailHtml, emailHtmlHasFormatting, emailHtmlToMarkdown, hasMarkdownFormatting, markdownToSafeHtml } from '../src/lib/content/email-markdown.js';
import { normalizeInboundReplyBody } from '../src/lib/content/email-replies.js';

const NL = String.fromCharCode(10);
const lines = (...parts) => parts.join(NL);

test('a Markdown parser decides whether a comment is formatted', () => {
  assert.equal(hasMarkdownFormatting(lines('Just a plain reply.', 'Second line.')), false);
  assert.equal(hasMarkdownFormatting(''), false);
  for (const formatted of ['Hi **team**', lines('- one', '- two'), '## Heading', '> quoted', 'see https://odin.test', '`code`', 'a <u>b</u>', '@[Uma User](user:u1) look']) {
    assert.equal(hasMarkdownFormatting(formatted), true, formatted);
  }
});

test('outbound comments: Markdown is sent formatted and safe, plain text keeps its line breaks', () => {
  assert.equal(commentToEmailHtml(lines('Fixed & ready', 'Thanks')), '<p>Fixed &amp; ready<br>Thanks</p>');
  assert.equal(commentToEmailHtml('   '), '');
  const html = commentToEmailHtml(lines('**Fixed** in *build 42*:', '', '- import', '- <u>export</u>', '', '[notes](https://odin.test/notes) @[Uma User](user:u1)'));
  for (const fragment of ['<strong>Fixed</strong>', '<em>build 42</em>', '<li>import</li>', '<u>export</u>', '<a href="https://odin.test/notes" rel="noopener noreferrer" target="_blank">notes</a>', '<strong>@Uma User</strong>']) {
    assert.ok(html.includes(fragment), `${fragment} in ${html}`);
  }
  assert.equal(html.includes('user:u1'), false, 'tag ids never reach an email');

  const hostile = markdownToSafeHtml('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) <b>raw</b>');
  assert.equal(hostile.includes('<script'), false);
  assert.equal(hostile.includes('<img'), false);
  assert.equal(hostile.includes('<b>'), false);
  assert.equal(hostile.includes('href="javascript'), false);
  assert.ok(hostile.includes('&lt;script&gt;'), 'raw HTML is shown as text');
});

test('inbound HTML: formatting from a mail client becomes Markdown; images, tables and styling are dropped', () => {
  const gmail = '<div dir="ltr">Hi <b>team</b>,<div><br></div><ul><li>first</li><li><i>second</i></li></ul><div>See <a href="https://odin.test">this</a> and <a href="javascript:x">that</a></div><img src="cid:logo"><table><tr><td>Signature</td></tr></table><span style="color:red">red</span></div>';
  assert.equal(emailHtmlHasFormatting(gmail), true);
  assert.equal(emailHtmlHasFormatting('<div>Plain <span>text</span></div>'), false);
  assert.equal(emailHtmlToMarkdown(gmail), lines('Hi **team**,', '', '- first', '- *second*', '', 'See [this](https://odin.test) and that', '', 'Signature', '', 'red'));
});

test('inbound replies: formatted HTML is kept, typed Markdown passes through, and quoted history is removed', () => {
  // Gmail: the quoted history is in a gmail_quote block.
  assert.equal(
    normalizeInboundReplyBody({ htmlBody: '<div dir="ltr">We need <b>email</b> first:<ul><li>email</li><li>text later</li></ul></div><br><div class="gmail_quote"><div>On Mon, Oct 12 Odin wrote:</div><blockquote>old</blockquote></div>', textBody: 'ignored' }),
    lines('We need **email** first:', '', '- email', '- text later'),
  );
  // Outlook: the history starts at a bold From: header.
  assert.equal(normalizeInboundReplyBody({ htmlBody: '<div>Thanks <b>all</b></div><div><b>From:</b> Odin &lt;noreply@odin.test&gt;</div><div>old</div>' }), 'Thanks **all**');
  // No formatting in the HTML: read as text, so Markdown the sender typed is kept.
  assert.equal(normalizeInboundReplyBody({ htmlBody: '<p>Plain <span>reply</span> with **typed** markdown</p><p>On Mon someone wrote:</p><p>&gt; old</p>' }), 'Plain reply with **typed** markdown');
  // Text only: quoted lines are history.
  assert.equal(normalizeInboundReplyBody({ textBody: lines('Text **only** reply', '', '> quoted history', 'more') }), 'Text **only** reply');
  assert.equal(normalizeInboundReplyBody({}), '');
});

test('outbound comments: Markdown tables are sent as tables with their borders inline', () => {
  const html = commentToEmailHtml(lines('| Option | Owner |', '| --- | --- |', '| **Annual** | @[Uma User](user:u1) |', '| <td onclick=x> | a |'));
  assert.ok(html.includes('<table style="border-collapse:collapse;margin:0 0 8px">'), html);
  assert.ok(/<th style="[^"]*border:1px solid #cbd5e1[^"]*">Option<\/th>/.test(html), html);
  assert.ok(/<td style="[^"]*"><strong>Annual<\/strong><\/td>/.test(html), html);
  assert.ok(html.includes('&lt;td onclick=x&gt;'), 'raw HTML in a cell is text');
  assert.equal(html.includes('user:u1'), false);
});
