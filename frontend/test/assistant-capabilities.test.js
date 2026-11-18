import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_PROJECT_HELPER_CAPABILITY_DEFINITIONS,
  AI_WORKSPACE_CAPABILITY_DEFINITIONS,
  DEFAULT_AI_MODEL,
  createDefaultAiConfig,
  normalizeAiCapabilityConfig,
} from '../src/lib/assistant/assistant-capabilities.js';

test('normalizeAiCapabilityConfig reads legacy model mappings into capability settings', () => {
  const normalized = normalizeAiCapabilityConfig({
    available_models: ['gpt-4o-mini', 'gpt-5-mini'],
    default_model: 'gpt-6.1-sol',
    model_to_function: {
      aiAnalyze: 'gpt-5-mini',
      aiEnhance: 'gpt-4o-mini',
      aiGenerate: 'gpt-5-mini',
      aiGenerateTasks: 'gpt-4o-mini',
    },
    openai_key: 'sk-test',
    valid_config: true,
  });

  assert.equal(normalized.capabilities.intakeDialogue.model, 'gpt-4o-mini');
  assert.equal(normalized.capabilities.structureGeneration.model, 'gpt-5-mini');
  assert.equal(normalized.capabilities.taskGeneration.model, 'gpt-4o-mini');
  assert.equal(normalized.default_model, 'gpt-6.1-sol');
  assert.equal(normalized.capabilities.projectAnalysis.reasoningEffort, 'max');
});

test('createDefaultAiConfig produces capability entries with tool defaults and max reasoning', () => {
  const config = createDefaultAiConfig();

  assert.deepEqual(config.available_models, []);
  assert.equal(DEFAULT_AI_MODEL, 'gpt-6-luna');
  assert.equal(config.default_model, 'gpt-6-luna');
  assert.equal(config.capabilities.intakeDialogue.model, 'gpt-6-luna');
  assert.equal(config.model_to_function.aiEnhance, 'gpt-6-luna');
  assert.equal(config.capabilities.briefEnhancement.reasoningEffort, 'max');
  assert.equal(config.capabilities.intakeDialogue.enabledTools.includes('web_search'), true);
  assert.equal(config.capabilities.clarificationDiscussion.reasoningEffort, 'max');
});

test('assistant capability definitions expose compact workspace settings and separate project helpers', () => {
  assert.deepEqual(
    AI_WORKSPACE_CAPABILITY_DEFINITIONS.map((definition) => definition.id),
    ['intakeDialogue'],
  );
  assert.deepEqual(
    AI_PROJECT_HELPER_CAPABILITY_DEFINITIONS.map((definition) => definition.id),
    ['briefEnhancement', 'projectAnalysis', 'structureGeneration', 'storyGeneration', 'taskGeneration', 'requirementsDraftQuestions', 'requirementsSummary', 'requirementsPlan'],
  );
});

test('requirements plan has its own model setting with project context only, defaulting from the generate model', () => {
  const config = createDefaultAiConfig('gpt-test');
  assert.equal(config.capabilities.requirementsPlan.model, 'gpt-test');
  assert.deepEqual(config.capabilities.requirementsPlan.enabledTools, ['project_context']);

  const normalized = normalizeAiCapabilityConfig({
    capabilities: { requirementsPlan: { model: 'gpt-plans', reasoningEffort: 'high' } },
    default_model: 'gpt-test',
  });
  assert.equal(normalized.capabilities.requirementsPlan.model, 'gpt-plans');
  assert.equal(normalized.capabilities.requirementsPlan.reasoningEffort, 'high');
});

test('requirements draft questions has its own model setting with project context only', () => {
  const config = createDefaultAiConfig('gpt-test');

  assert.equal(config.capabilities.requirementsDraftQuestions.model, 'gpt-test');
  assert.deepEqual(config.capabilities.requirementsDraftQuestions.enabledTools, ['project_context']);

  const normalized = normalizeAiCapabilityConfig({
    capabilities: { requirementsDraftQuestions: { model: 'gpt-drafts', reasoningEffort: 'low' } },
    default_model: 'gpt-test',
  });
  assert.equal(normalized.capabilities.requirementsDraftQuestions.model, 'gpt-drafts');
  assert.equal(normalized.capabilities.requirementsDraftQuestions.reasoningEffort, 'low');
});
