import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAiMemoryEmbeddingProvider } from '../src/modules/memory/memory-embedding-provider.js';

test('memory embedding provider uses the configured embedding model and validates dimensions', async () => {
  let request;
  const provider = createOpenAiMemoryEmbeddingProvider({ apiKey: 'test-key', dimensions: 3, openAiFactory: () => ({ embeddings: { async create(input) { request = input; return { data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 7 } }; } } }) });
  const result = await provider.embed({ content: 'A delivery decision.', title: 'Decision' });
  assert.deepEqual(request, { dimensions: 3, encoding_format: 'float', input: 'Decision\n\nA delivery decision.', model: 'text-embedding-3-small' });
  assert.equal(result.vector.length, 3);
  assert.equal(result.usage.inputTokens, 7);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
});

test('embedding provider batches semantic indexing inputs without changing their order', async () => {
  const requests = []; const provider = createOpenAiMemoryEmbeddingProvider({ apiKey: 'test-key', dimensions: 2, openAiFactory: () => ({ embeddings: { async create(input) { requests.push(input); return { data: input.input.map((_, index) => ({ embedding: [index + 1, index + 2] })) }; } } }) });
  const results = await provider.embedMany([{ content: 'Alpha', title: 'One' }, { content: 'Beta', title: 'Two' }]);
  assert.deepEqual(requests[0].input, ['One\n\nAlpha', 'Two\n\nBeta']); assert.deepEqual(results.map((item) => item.vector), [[1, 2], [2, 3]]);
});
