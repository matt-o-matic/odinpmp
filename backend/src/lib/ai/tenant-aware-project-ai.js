import { createFallbackProjectAiService } from './fallback-project-ai.js';
import { createOpenAiProjectAiService } from './openai-project-ai.js';
import { normalizeAiCapabilityConfig, resolveAiCapabilitySettings } from './ai-capability-config.js';

function emptyTenantConfig() {
  return normalizeAiCapabilityConfig({
    valid_config: false,
    openai_key: '',
    available_models: [],
    capabilities: {},
  });
}

export function createTenantAwareProjectAiService({
  defaultApiKey = '',
  defaultModel = 'gpt-6-luna',
  openAiFactory = null,
  tenantsRepository,
} = {}) {
  const fallback = createFallbackProjectAiService();
  const openAiClients = new Map();

  function getOpenAiClient(apiKey) {
    if (!apiKey) {
      return null;
    }

    if (!openAiClients.has(apiKey)) {
      openAiClients.set(apiKey, createOpenAiProjectAiService({
        apiKey,
        client: openAiFactory ? openAiFactory(apiKey) : null,
        model: defaultModel,
      }));
    }

    return openAiClients.get(apiKey);
  }

  async function resolveConfig(tenantId) {
    if (!tenantId || !tenantsRepository?.getOpenAiConfig) {
      return {
        apiKey: defaultApiKey,
        config: emptyTenantConfig(),
      };
    }

    const config = normalizeAiCapabilityConfig(await tenantsRepository.getOpenAiConfig({
      defaults: emptyTenantConfig(),
      tenantId,
    }), { defaultModel });

    const apiKey = (config?.valid_config && config?.openai_key) ? config.openai_key : defaultApiKey;

    return { apiKey, config };
  }

  async function resolveAllowedWorkItemStatuses(tenantId) {
    if (!tenantId || !tenantsRepository?.listStatusDefinitions) {
      return [];
    }

    const definitions = await tenantsRepository.listStatusDefinitions({ tenantId });
    return [...new Set(
      (definitions ?? [])
        .map((row) => String(row?.name ?? '').trim())
        .filter(Boolean),
    )];
  }

  return {
    async enhanceDescription({ description, project, tenantId, user }) {
      const { apiKey, config } = await resolveConfig(tenantId);
      const settings = resolveAiCapabilitySettings(config, 'briefEnhancement', { defaultModel });
      const client = getOpenAiClient(apiKey);
      if (!client) {
        return fallback.enhanceDescription({ description, project, tenantId, user });
      }

      return client.enhanceDescription({
        description,
        model: settings.model,
        project,
        reasoningEffort: settings.reasoningEffort,
        tenantId,
        user,
      });
    },
    async analyzeProject({ project, tenantId, user }) {
      const { apiKey, config } = await resolveConfig(tenantId);
      const settings = resolveAiCapabilitySettings(config, 'projectAnalysis', { defaultModel });
      const client = getOpenAiClient(apiKey);
      if (!client) {
        return fallback.analyzeProject({ project, tenantId, user });
      }

      return client.analyzeProject({
        model: settings.model,
        project,
        reasoningEffort: settings.reasoningEffort,
        tenantId,
        user,
      });
    },
    async generateStructure({ project, tenantId, user }) {
      const { apiKey, config } = await resolveConfig(tenantId);
      const settings = resolveAiCapabilitySettings(config, 'structureGeneration', { defaultModel });
      const client = getOpenAiClient(apiKey);
      const allowedWorkItemStatuses = await resolveAllowedWorkItemStatuses(tenantId);
      if (!client) {
        return fallback.generateStructure({ project, tenantId, user });
      }

      return client.generateStructure({
        allowedWorkItemStatuses,
        model: settings.model,
        project,
        reasoningEffort: settings.reasoningEffort,
        tenantId,
        user,
      });
    },
    async generateStories({ project, projectJson, tenantId, user }) {
      const { apiKey, config } = await resolveConfig(tenantId);
      const settings = resolveAiCapabilitySettings(config, 'storyGeneration', { defaultModel });
      const client = getOpenAiClient(apiKey);
      const allowedWorkItemStatuses = await resolveAllowedWorkItemStatuses(tenantId);
      if (!client) {
        return fallback.generateStories({ project, projectJson, tenantId, user });
      }

      return client.generateStories({
        allowedWorkItemStatuses,
        model: settings.model,
        project,
        projectJson,
        reasoningEffort: settings.reasoningEffort,
        tenantId,
        user,
      });
    },
    async generateTasks({ project, storyDescription, tenantId, user }) {
      const { apiKey, config } = await resolveConfig(tenantId);
      const settings = resolveAiCapabilitySettings(config, 'taskGeneration', { defaultModel });
      const client = getOpenAiClient(apiKey);
      const allowedWorkItemStatuses = await resolveAllowedWorkItemStatuses(tenantId);
      if (!client) {
        return fallback.generateTasks({ project, storyDescription, tenantId, user });
      }

      return client.generateTasks({
        allowedWorkItemStatuses,
        model: settings.model,
        project,
        reasoningEffort: settings.reasoningEffort,
        storyDescription,
        tenantId,
        user,
      });
    },
    async enhanceRichText({ element, fullText, imageDataUrls, mode, selectedText, tenantId, title, user }) {
      const { apiKey, config } = await resolveConfig(tenantId);
      const settings = resolveAiCapabilitySettings(config, 'briefEnhancement', { defaultModel });
      const client = getOpenAiClient(apiKey);
      if (!client) {
        return fallback.enhanceRichText({ element, fullText, imageDataUrls, mode, selectedText, tenantId, title, user });
      }

      return client.enhanceRichText({
        element,
        fullText,
        imageDataUrls,
        mode,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        selectedText,
        tenantId,
        title,
        user,
      });
    },
  };
}
