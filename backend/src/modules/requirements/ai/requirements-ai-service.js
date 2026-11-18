import OpenAI from 'openai';

import {
  AI_CAPABILITY_DEFINITIONS,
  createDefaultAiConfig,
  normalizeAiCapabilityConfig,
  resolveAiCapabilitySettings,
} from '../../../lib/ai/ai-capability-config.js';
import { emptyTenantConfig, parseStructuredResponse } from '../../../lib/ai/assistant-openai-runtime.js';
import { HttpError } from '../../../lib/errors/http-error.js';
import { DEFAULT_PLAN_TIMEOUT_MS, draftPlanWithOpenAi, proposeWorkWithOpenAi } from '../plans/plan-ai.js';
import { createLocalFixturePlanAi } from '../plans/plan-fixture.js';
import { draftQuestionsOutputSchema } from '../requirements.schema.js';
import { DEFAULT_SUMMARY_TIMEOUT_MS, summarizeWithOpenAi } from '../summary/summary-ai.js';
import { createLocalFixtureSummaryAi } from '../summary/summary-fixture.js';
import { createLocalFixtureRequirementsAiProvider } from './local-fixture-provider.js';
import {
  buildDraftQuestionsInput,
  REQUIREMENTS_DRAFT_QUESTIONS_OPERATION,
  REQUIREMENTS_DRAFT_QUESTIONS_SCHEMA_NAME,
  requirementsDraftQuestionsInstructions,
} from './requirements-draft-questions.js';

export const REQUIREMENTS_AI_PROVIDERS = Object.freeze(['openai', 'local-fixture']);

export function aiNotConfiguredError() {
  return new HttpError(503, 'ai_not_configured', {
    details: {
      code: 'ai_not_configured',
      message: 'Requirements AI is not configured. Save a tenant OpenAI key or set OPENAI_API_KEY.',
    },
  });
}

/**
 * Resolves the OpenAI client and settings for one requirements capability: the tenant's
 * saved key when valid, otherwise OPENAI_API_KEY, and the model configured for the
 * capability. Every requirements AI call (draft questions, Odin summary, track plans) goes
 * through it. `capabilityDefaults` ({ [capabilityId]: { model, reasoningEffort } }) replace
 * the general defaults for one capability; a model or reasoning effort the tenant saved for
 * that capability still wins.
 */
export function createRequirementsOpenAiRuntime({
  capabilityDefaults = {},
  defaultApiKey = '',
  defaultModel = '',
  openAiFactory = null,
  tenantsRepository = null,
} = {}) {
  const clients = new Map();

  function getClient(apiKey) {
    if (!clients.has(apiKey)) {
      clients.set(apiKey, openAiFactory ? openAiFactory(apiKey) : new OpenAI({ apiKey }));
    }
    return clients.get(apiKey);
  }

  return async function resolveRuntime(tenantId, capabilityId) {
    const saved = tenantsRepository?.getOpenAiConfig
      ? await tenantsRepository.getOpenAiConfig({ defaults: createDefaultAiConfig(defaultModel), tenantId })
      : null;
    const config = saved ? normalizeAiCapabilityConfig(saved, { defaultModel }) : emptyTenantConfig(defaultModel);
    const apiKey = (config?.valid_config && config?.openai_key) ? config.openai_key : defaultApiKey;
    const settings = withCapabilityDefaults(
      resolveAiCapabilitySettings(config, capabilityId, { defaultModel }),
      { override: capabilityDefaults[capabilityId], saved: saved?.valid_config ? saved : null },
      capabilityId,
    );
    if (!apiKey || !String(settings?.model ?? '').trim()) {
      throw aiNotConfiguredError();
    }
    return { client: getClient(apiKey), settings };
  };
}

function savedString(value) {
  return String(value ?? '').trim();
}

/** Applies a capability's own defaults where the tenant saved nothing for it. */
function withCapabilityDefaults(settings, { override, saved }, capabilityId) {
  if (!override) return settings;
  const savedCapability = saved?.capabilities?.[capabilityId] ?? {};
  const legacyKey = AI_CAPABILITY_DEFINITIONS.find((definition) => definition.id === capabilityId)?.legacyModelKey;
  const savedModel = savedString(savedCapability.model) || savedString(legacyKey ? saved?.model_to_function?.[legacyKey] : '');
  const savedEffort = savedString(savedCapability.reasoningEffort);
  return {
    ...settings,
    model: savedModel ? settings.model : (savedString(override.model) || settings.model),
    reasoningEffort: savedEffort ? settings.reasoningEffort : (savedString(override.reasoningEffort) || settings.reasoningEffort),
  };
}

/** OpenAI provider for every requirements AI call. */
export function createOpenAiRequirementsAiProvider({
  capabilityDefaults = {},
  defaultApiKey = '',
  defaultModel = '',
  openAiFactory = null,
  planTimeoutMs = DEFAULT_PLAN_TIMEOUT_MS,
  summaryTimeoutMs = DEFAULT_SUMMARY_TIMEOUT_MS,
  tenantsRepository = null,
} = {}) {
  const resolveRuntime = createRequirementsOpenAiRuntime({ capabilityDefaults, defaultApiKey, defaultModel, openAiFactory, tenantsRepository });

  return {
    provider: 'openai',
    async summarize({ modelInput, tenantId }) {
      return summarizeWithOpenAi({ modelInput, resolveRuntime, tenantId, timeoutMs: summaryTimeoutMs });
    },
    async draftPlan({ modelInput, tenantId }) {
      return draftPlanWithOpenAi({ modelInput, resolveRuntime, tenantId, timeoutMs: planTimeoutMs });
    },
    async proposeWork({ modelInput, tenantId }) {
      return proposeWorkWithOpenAi({ modelInput, resolveRuntime, tenantId, timeoutMs: planTimeoutMs });
    },
    async draftQuestions({ briefLines, decisions = [], existingTopics, projectName, tenantId, track }) {
      const runtime = await resolveRuntime(tenantId, 'requirementsDraftQuestions');
      const output = await parseStructuredResponse({
        client: runtime.client,
        input: [{
          content: [{ text: buildDraftQuestionsInput({ briefLines, decisions, existingTopics, projectName, track }), type: 'input_text' }],
          role: 'user',
          type: 'message',
        }],
        instructions: requirementsDraftQuestionsInstructions,
        maxOutputTokens: 4000,
        model: runtime.settings.model,
        operationName: REQUIREMENTS_DRAFT_QUESTIONS_OPERATION,
        reasoningEffort: runtime.settings.reasoningEffort,
        schema: draftQuestionsOutputSchema,
        schemaName: REQUIREMENTS_DRAFT_QUESTIONS_SCHEMA_NAME,
      });
      return { ...output, model: runtime.settings.model };
    },
  };
}

/**
 * The one place that validates REQUIREMENTS_AI_PROVIDER. local-fixture is refused in
 * production even if configuration validation was bypassed.
 */
export function selectRequirementsAiProvider({ nodeEnv = 'development', provider = 'openai' } = {}) {
  const selected = String(provider ?? 'openai').trim() || 'openai';
  if (!REQUIREMENTS_AI_PROVIDERS.includes(selected)) {
    throw new Error(`Unknown REQUIREMENTS_AI_PROVIDER: ${selected}.`);
  }
  if (selected === 'local-fixture' && nodeEnv === 'production') {
    throw new Error('REQUIREMENTS_AI_PROVIDER=local-fixture is not allowed in production.');
  }
  return selected;
}

/**
 * The requirements AI service: draftQuestions (Q-13), summarize (the Odin summary, E-04),
 * and draftPlan and proposeWork (track plans, AC-13), from OpenAI or, outside production,
 * the deterministic local fixture.
 */
export function createRequirementsAiService({
  capabilityDefaults = {},
  defaultApiKey = '',
  defaultModel = '',
  nodeEnv = 'development',
  openAiFactory = null,
  planTimeoutMs = DEFAULT_PLAN_TIMEOUT_MS,
  provider = 'openai',
  summaryTimeoutMs = DEFAULT_SUMMARY_TIMEOUT_MS,
  tenantsRepository = null,
} = {}) {
  if (selectRequirementsAiProvider({ nodeEnv, provider }) === 'local-fixture') {
    return {
      ...createLocalFixtureRequirementsAiProvider(),
      ...createLocalFixturePlanAi(),
      summarize: createLocalFixtureSummaryAi().summarize,
    };
  }
  return createOpenAiRequirementsAiProvider({ capabilityDefaults, defaultApiKey, defaultModel, openAiFactory, planTimeoutMs, summaryTimeoutMs, tenantsRepository });
}
