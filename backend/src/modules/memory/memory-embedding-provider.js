import { createHash } from 'node:crypto';

import OpenAI from 'openai';

function normalizedText({ content, title }) { return `${String(title).trim()}\n\n${String(content).trim()}`.slice(0, 80_000); }

export function createOpenAiMemoryEmbeddingProvider({ apiKey, dimensions = 256, model = 'text-embedding-3-small', openAiFactory = null, resolveApiKey = null, timeoutMs = 15_000 } = {}) {
  if (!String(apiKey ?? '').trim() && !resolveApiKey) return null;
  const clients = new Map();
  return {
    dimensions,
    model,
    async embed(input) {
      const resolvedApiKey = String(await resolveApiKey?.(input.tenantId) || apiKey || '').trim();
      if (!resolvedApiKey) throw new Error('Semantic memory indexing is not configured for this tenant.');
      if (!clients.has(resolvedApiKey)) clients.set(resolvedApiKey, openAiFactory ? openAiFactory(resolvedApiKey) : new OpenAI({ apiKey: resolvedApiKey }));
      const text = normalizedText(input); const contentHash = createHash('sha256').update(text).digest('hex');
      const response = await clients.get(resolvedApiKey).embeddings.create({ dimensions, encoding_format: 'float', input: text, model }, { signal: AbortSignal.timeout(timeoutMs) });
      const vector = response.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) throw new Error('Embedding response did not contain the configured finite vector.');
      return { contentHash, dimensions, embeddedAt: new Date().toISOString(), model, usage: { inputTokens: Number(response.usage?.prompt_tokens ?? response.usage?.total_tokens ?? 0) }, vector };
    },
    async embedMany(inputs) {
      const results = [];
      for (let offset = 0; offset < inputs.length; offset += 64) {
        const batch = inputs.slice(offset, offset + 64); const resolvedApiKey = String(await resolveApiKey?.(batch[0]?.tenantId) || apiKey || '').trim();
        if (!resolvedApiKey) throw new Error('Semantic indexing is not configured for this tenant.');
        if (!clients.has(resolvedApiKey)) clients.set(resolvedApiKey, openAiFactory ? openAiFactory(resolvedApiKey) : new OpenAI({ apiKey: resolvedApiKey }));
        const texts = batch.map(normalizedText); const response = await clients.get(resolvedApiKey).embeddings.create({ dimensions, encoding_format: 'float', input: texts, model }, { signal: AbortSignal.timeout(timeoutMs) });
        if (response.data?.length !== batch.length) throw new Error('Embedding response did not contain every requested vector.');
        for (let index = 0; index < batch.length; index += 1) { const vector = response.data[index]?.embedding; if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) throw new Error('Embedding response did not contain the configured finite vector.'); results.push({ contentHash: createHash('sha256').update(texts[index]).digest('hex'), dimensions, embeddedAt: new Date().toISOString(), model, vector }); }
      }
      return results;
    },
  };
}
