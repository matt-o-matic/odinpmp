export const AI_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_AI_MODEL = 'gpt-6-luna';
export const DEFAULT_AI_REASONING_EFFORT = 'max';

export const AI_CAPABILITY_DEFINITIONS = [
  {
    id: 'intakeDialogue',
    label: 'Intake Dialogue',
    legacyModelKey: 'aiEnhance',
    tools: ['project_context', 'attachments', 'web_search'],
  },
  {
    id: 'briefEnhancement',
    label: 'Brief Enhancement',
    legacyModelKey: 'aiEnhance',
    tools: ['project_context', 'attachments'],
  },
  {
    id: 'projectAnalysis',
    label: 'Project Analysis',
    legacyModelKey: 'aiAnalyze',
    tools: ['project_context', 'attachments', 'web_search'],
  },
  {
    id: 'structureGeneration',
    label: 'Structure Generation',
    legacyModelKey: 'aiGenerate',
    tools: ['project_context', 'attachments'],
  },
  {
    id: 'storyGeneration',
    label: 'Story Generation',
    legacyModelKey: 'aiGenerate',
    tools: ['project_context'],
  },
  {
    id: 'taskGeneration',
    label: 'Task Generation',
    legacyModelKey: 'aiGenerateTasks',
    tools: ['project_context'],
  },
  {
    id: 'clarificationSynthesis',
    label: 'Clarification Synthesis',
    legacyModelKey: 'aiAnalyze',
    tools: ['project_context', 'attachments', 'web_search'],
  },
  {
    id: 'clarificationDiscussion',
    label: 'Clarification Discussion',
    legacyModelKey: 'aiAnalyze',
    tools: ['project_context', 'attachments', 'web_search'],
  },
  {
    id: 'requirementsDraftQuestions',
    label: 'Requirements Draft Questions',
    legacyModelKey: 'aiAnalyze',
    tools: ['project_context'],
  },
  {
    id: 'requirementsSummary',
    label: 'Requirements Summary',
    legacyModelKey: 'aiAnalyze',
    tools: ['project_context'],
  },
  {
    id: 'requirementsPlan',
    label: 'Requirements Plan',
    legacyModelKey: 'aiGenerate',
    tools: ['project_context'],
  },
];

function uniqueStrings(values = []) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function normalizeReasoningEffort(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return AI_REASONING_EFFORTS.includes(normalized) ? normalized : DEFAULT_AI_REASONING_EFFORT;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function resolveDefaultModel(defaultModel = '') {
  return firstNonEmptyString(defaultModel, DEFAULT_AI_MODEL);
}

function createCapabilityEntry(definition, defaults = {}, defaultModel = '') {
  const resolvedDefaultModel = resolveDefaultModel(defaultModel);
  return {
    enabledTools: uniqueStrings(defaults.enabledTools?.length ? defaults.enabledTools : definition.tools),
    model: firstNonEmptyString(defaults.model, resolvedDefaultModel),
    reasoningEffort: normalizeReasoningEffort(defaults.reasoningEffort),
  };
}

export function createDefaultAiCapabilities(defaultModel = '') {
  return Object.fromEntries(
    AI_CAPABILITY_DEFINITIONS.map((definition) => [
      definition.id,
      createCapabilityEntry(definition, {}, defaultModel),
    ]),
  );
}

export function capabilitiesToLegacyModelMap(capabilities = {}, defaultModel = '') {
  const resolved = {
    aiAnalyze: '',
    aiEnhance: '',
    aiGenerate: '',
    aiGenerateTasks: '',
  };

  for (const definition of AI_CAPABILITY_DEFINITIONS) {
    const capability = capabilities?.[definition.id] ?? {};
    if (!resolved[definition.legacyModelKey]) {
      resolved[definition.legacyModelKey] = String(capability.model ?? defaultModel ?? '').trim();
    }
  }

  return resolved;
}

export function normalizeAiCapabilityConfig(config = {}, { defaultModel = '' } = {}) {
  const resolvedDefaultModel = resolveDefaultModel(defaultModel);
  const availableModels = uniqueStrings(config.available_models ?? config.availableModels ?? []);
  const legacyModelMap = {
    ...(config.model_to_function ?? {}),
  };
  const defaults = createDefaultAiCapabilities(resolvedDefaultModel);
  const capabilities = {};

  for (const definition of AI_CAPABILITY_DEFINITIONS) {
    const provided = config.capabilities?.[definition.id] ?? {};
    const legacyModel = firstNonEmptyString(legacyModelMap[definition.legacyModelKey]);
    capabilities[definition.id] = createCapabilityEntry(
      definition,
      {
        ...defaults[definition.id],
        ...provided,
        model: firstNonEmptyString(provided.model, legacyModel, defaults[definition.id].model),
      },
      resolvedDefaultModel,
    );
  }

  return {
    available_models: availableModels,
    capabilities,
    default_model: firstNonEmptyString(config.default_model, config.defaultModel, resolvedDefaultModel),
    model_to_function: capabilitiesToLegacyModelMap(capabilities, resolvedDefaultModel),
    model_catalog_mode: String(config.model_catalog_mode ?? config.modelCatalogMode ?? '').trim(),
    openai_key: String(config.openai_key ?? '').trim(),
    uses_tenant_openai_key: Boolean(config.uses_tenant_openai_key ?? config.usesTenantOpenAiKey),
    valid_config: Boolean(config.valid_config),
  };
}

export function createDefaultAiConfig(defaultModel = '') {
  const resolvedDefaultModel = resolveDefaultModel(defaultModel);
  return normalizeAiCapabilityConfig(
    {
      available_models: [],
      capabilities: createDefaultAiCapabilities(resolvedDefaultModel),
      openai_key: '',
      valid_config: false,
    },
    { defaultModel: resolvedDefaultModel },
  );
}

export function resolveAiCapabilitySettings(config = {}, capabilityId, { defaultModel = '' } = {}) {
  const resolvedDefaultModel = resolveDefaultModel(defaultModel);
  const normalized = normalizeAiCapabilityConfig(config, { defaultModel: resolvedDefaultModel });
  return normalized.capabilities?.[capabilityId] ?? createDefaultAiCapabilities(resolvedDefaultModel)[capabilityId];
}
