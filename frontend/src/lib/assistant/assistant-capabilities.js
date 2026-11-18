export const AI_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_AI_MODEL = 'gpt-6-luna';
export const DEFAULT_AI_REASONING_EFFORT = 'max';

export const AI_TOOL_LABELS = {
  attachments: 'Uploads',
  project_context: 'Project context',
  web_search: 'Web research',
};

export const AI_CAPABILITY_DEFINITIONS = [
  {
    adminSection: 'workspace',
    description: 'Model for the AI Workspace assistant. It sets its own reasoning effort for each message (max by default) and works through Odin’s tools with each person’s permissions.',
    id: 'intakeDialogue',
    label: 'Assistant',
    // Reasoning effort and tools are chosen per message by the assistant, not here.
    modelOnly: true,
    legacyModelKey: 'aiEnhance',
    tools: ['project_context', 'attachments', 'web_search'],
  },
  {
    adminSection: 'project-helpers',
    description: 'Refines project briefs, turns raw notes into structured narrative, and keeps written output coherent.',
    id: 'briefEnhancement',
    label: 'Brief Enhancement',
    legacyModelKey: 'aiEnhance',
    tools: ['project_context', 'attachments'],
  },
  {
    adminSection: 'project-helpers',
    description: 'Runs higher-order analysis over the current plan to identify risks, gaps, and delivery concerns.',
    id: 'projectAnalysis',
    label: 'Project Analysis',
    legacyModelKey: 'aiAnalyze',
    tools: ['project_context', 'attachments', 'web_search'],
  },
  {
    adminSection: 'project-helpers',
    description: 'Generates epics and stories from the evolving project brief.',
    id: 'structureGeneration',
    label: 'Structure Generation',
    legacyModelKey: 'aiGenerate',
    tools: ['project_context', 'attachments'],
  },
  {
    adminSection: 'project-helpers',
    description: 'Expands epics into stronger, more specific stories when enough detail exists.',
    id: 'storyGeneration',
    label: 'Story Generation',
    legacyModelKey: 'aiGenerate',
    tools: ['project_context'],
  },
  {
    adminSection: 'project-helpers',
    description: 'Breaks ready stories into implementation tasks when clarifications are sufficiently resolved.',
    id: 'taskGeneration',
    label: 'Task Generation',
    legacyModelKey: 'aiGenerateTasks',
    tools: ['project_context'],
  },
  {
    adminSection: 'project-helpers',
    description: 'Drafts requirements questions from the committed project brief for the Experience and Functional registers.',
    id: 'requirementsDraftQuestions',
    label: 'Requirements Draft Questions',
    legacyModelKey: 'aiAnalyze',
    tools: ['project_context'],
  },
  {
    adminSection: 'project-helpers',
    description: 'Keeps the Odin summary of each requirements topic: where people agree, where they diverge, what nobody has explored, and what is still open.',
    id: 'requirementsSummary',
    label: 'Requirements Summary',
    legacyModelKey: 'aiAnalyze',
    tools: ['project_context'],
  },
  {
    adminSection: 'project-helpers',
    description: 'Drafts each track’s plan from its accepted decisions, with acceptance criteria that cite them, and proposes epics and stories from an approved plan for review.',
    id: 'requirementsPlan',
    label: 'Requirements Plan',
    legacyModelKey: 'aiGenerate',
    tools: ['project_context'],
  },
  {
    adminSection: 'hidden',
    description: 'No longer used. Kept so older saved workspace settings still load.',
    id: 'clarificationSynthesis',
    label: 'Clarification Synthesis',
    legacyModelKey: 'aiAnalyze',
    tools: ['project_context', 'attachments', 'web_search'],
  },
  {
    adminSection: 'hidden',
    description: 'No longer used. Kept so older saved workspace settings still load.',
    id: 'clarificationDiscussion',
    label: 'Clarification Review',
    legacyModelKey: 'aiAnalyze',
    tools: ['project_context', 'attachments', 'web_search'],
  },
];

export const AI_WORKSPACE_CAPABILITY_DEFINITIONS = AI_CAPABILITY_DEFINITIONS.filter(
  (definition) => definition.adminSection === 'workspace',
);

export const AI_PROJECT_HELPER_CAPABILITY_DEFINITIONS = AI_CAPABILITY_DEFINITIONS.filter(
  (definition) => definition.adminSection === 'project-helpers',
);

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
  const resolvedDefaultModel = resolveDefaultModel(defaultModel);
  const resolved = {
    aiAnalyze: '',
    aiEnhance: '',
    aiGenerate: '',
    aiGenerateTasks: '',
  };

  for (const definition of AI_CAPABILITY_DEFINITIONS) {
    const capability = capabilities?.[definition.id] ?? {};
    if (!resolved[definition.legacyModelKey]) {
      resolved[definition.legacyModelKey] = firstNonEmptyString(capability.model, resolvedDefaultModel);
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
    const legacyModel = String(legacyModelMap[definition.legacyModelKey] ?? '').trim();
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
  return normalizeAiCapabilityConfig({
    available_models: [],
    capabilities: createDefaultAiCapabilities(resolvedDefaultModel),
    openai_key: '',
    valid_config: false,
  }, { defaultModel: resolvedDefaultModel });
}
