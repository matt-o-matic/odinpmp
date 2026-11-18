import assert from 'node:assert/strict';
import test from 'node:test';

import { extractMentionSpans } from '../src/lib/mentions/mention-notifications.js';

test('extractMentionSpans matches mention spans regardless of attribute order', () => {
  const html = `
    <p>
      <span class="mention" data-user-id="user-1" data-mention-label="Alice">@Alice</span>
      <span data-user-id="user-2" class="mention" data-mention-label="Bob">@Bob</span>
      <span class="mention other" data-userid="user-3">@Charlie</span>
    </p>
  `.trim();

  const spans = extractMentionSpans(html);

  assert.equal(spans.length, 3);
  assert.equal(spans[0].userId, 'user-1');
  assert.equal(spans[1].userId, 'user-2');
  assert.equal(spans[2].userId, 'user-3');
  assert.match(spans[0].fullSpan, /<span/i);
});

