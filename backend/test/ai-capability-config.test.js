import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_AI_MODEL,
  createDefaultAiConfig,
  normalizeAiCapabilityConfig,
  resolveAiCapabilitySettings,
} from '../src/lib/ai/ai-capability-config.js';

test('AI capability config defaults to gpt-6-luna at max when no model is provided', () => {
  const config = createDefaultAiConfig();

  assert.equal(DEFAULT_AI_MODEL, 'gpt-6-luna');
  assert.equal(config.default_model, 'gpt-6-luna');
  assert.equal(config.capabilities.intakeDialogue.model, 'gpt-6-luna');
  assert.equal(config.capabilities.intakeDialogue.reasoningEffort, 'max');
  assert.equal(config.model_to_function.aiEnhance, 'gpt-6-luna');
});

test('AI capability settings fallback never resolves to an empty model', () => {
  const config = normalizeAiCapabilityConfig({
    capabilities: {},
    default_model: '',
    model_to_function: {},
  });
  const settings = resolveAiCapabilitySettings(config, 'intakeDialogue');

  assert.equal(config.default_model, 'gpt-6-luna');
  assert.equal(settings.model, 'gpt-6-luna');
});
