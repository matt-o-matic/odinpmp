import { randomUUID } from 'node:crypto';

import OpenAI from 'openai';
import { marked } from 'marked';
import { z } from 'zod';

import { sanitizeRichHtml } from '../content/html-content.js';
import { normalizeStoredRichTextMarkdown } from '../content/rich-text.js';
import { legacyPrompts } from './legacy-prompts.js';
import { summarizeProjectSnapshot } from './project-ai-helpers.js';
import { generateValidatedStructuredOutput } from './responses-structured-output.js';

const DEFAULT_WORK_ITEM_STATUSES = ['Not Started', 'In Progress', 'At Risk', 'Review', 'Completed'];

function createProjectContext(project) {
  const summary = summarizeProjectSnapshot(project);

  return JSON.stringify({
    description: project.description ?? '',
    endDate: summary.endDate,
    epicCount: summary.epicCount,
    epics: project.epics ?? [],
    inProgressCount: summary.inProgressCount,
    name: summary.name,
    startDate: summary.startDate,
    status: summary.status,
    storyCount: summary.storyCount,
    taskCount: summary.taskCount,
  }, null, 2);
}

function buildTextInput(text = '') {
  return [{
    content: [{
      text,
      type: 'input_text',
    }],
    role: 'user',
    type: 'message',
  }];
}

function buildTextAndImageInput({ imageDataUrls = [], text = '' } = {}) {
  return [{
    content: [
      {
        text,
        type: 'input_text',
      },
      ...(imageDataUrls ?? []).slice(0, 4).map((dataUrl) => ({
        detail: 'auto',
        image_url: dataUrl,
        type: 'input_image',
      })),
    ],
    role: 'user',
    type: 'message',
  }];
}

function markdownToSafeHtml(markdown = '') {
  const rendered = marked.parse(String(markdown ?? ''));
  return sanitizeRichHtml(rendered);
}

function numberOrNull(value) {
  if (value === '' || value == null) {
    return null;
  }

  return Number(value);
}

function semanticIssue(path, message, extras = {}) {
  return {
    ...extras,
    message,
    path,
  };
}

function resolveAllowedWorkItemStatuses(allowedStatuses = []) {
  const unique = [...new Set((allowedStatuses ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
  return unique.length > 0 ? unique : [...DEFAULT_WORK_ITEM_STATUSES];
}

function validateWorkItemStatuses(items = [], allowedStatuses = [], pathPrefix = []) {
  const issues = [];
  const allowed = resolveAllowedWorkItemStatuses(allowedStatuses);
  const allowedSet = new Set(allowed);

  for (const [index, item] of (items ?? []).entries()) {
    if (!allowedSet.has(item.status)) {
      issues.push(semanticIssue(
        [...pathPrefix, index, 'status'],
        'Status must match an allowed work-item status.',
        {
          allowedValues: allowed,
          received: item.status,
        },
      ));
    }
  }

  return issues;
}

function validateGeneratedStructureOutput(output = {}, allowedStatuses = []) {
  const issues = [];
  const allowed = resolveAllowedWorkItemStatuses(allowedStatuses);

  issues.push(...validateWorkItemStatuses(output.epics ?? [], allowed, ['epics']));

  for (const [epicIndex, epic] of (output.epics ?? []).entries()) {
    issues.push(...validateWorkItemStatuses(epic.stories ?? [], allowed, ['epics', epicIndex, 'stories']));
    for (const [storyIndex, story] of (epic.stories ?? []).entries()) {
      issues.push(...validateWorkItemStatuses(
        story.tasks ?? [],
        allowed,
        ['epics', epicIndex, 'stories', storyIndex, 'tasks'],
      ));
    }
  }

  return issues;
}

function validateGeneratedStoriesOutput(output = {}, allowedStatuses = []) {
  const issues = [];
  const allowed = resolveAllowedWorkItemStatuses(allowedStatuses);

  issues.push(...validateWorkItemStatuses(output.stories ?? [], allowed, ['stories']));
  for (const [storyIndex, story] of (output.stories ?? []).entries()) {
    issues.push(...validateWorkItemStatuses(
      story.tasks ?? [],
      allowed,
      ['stories', storyIndex, 'tasks'],
    ));
  }

  return issues;
}

function validateGeneratedTasksOutput(output = {}, allowedStatuses = []) {
  return validateWorkItemStatuses(output.tasks ?? [], resolveAllowedWorkItemStatuses(allowedStatuses), ['tasks']);
}

function normalizeGeneratedTask(task, { aiGenerated = false } = {}) {
  return {
    aiGenerated,
    assigneeId: null,
    assigneeName: '',
    description: task.description ? normalizeStoredRichTextMarkdown(task.description) : '',
    id: randomUUID(),
    name: String(task.name ?? 'Generated task').trim() || 'Generated task',
    points: task.points ?? null,
    priority: Number(task.priority ?? 4),
    status: task.status ?? 'Not Started',
    targetEndDate: null,
    targetStartDate: null,
  };
}

function normalizeGeneratedStory(story, { aiGenerated = false } = {}) {
  return {
    aiGenerated,
    assigneeId: null,
    assigneeName: '',
    description: story.description ? normalizeStoredRichTextMarkdown(story.description) : '',
    id: randomUUID(),
    name: String(story.name ?? 'Generated story').trim() || 'Generated story',
    points: story.points ?? null,
    priority: Number(story.priority ?? 4),
    status: story.status ?? 'Not Started',
    targetEndDate: null,
    targetStartDate: null,
    tasks: (story.tasks ?? []).map((task) => normalizeGeneratedTask(task, { aiGenerated })),
  };
}

function normalizeGeneratedEpic(epic, { aiGenerated = false } = {}) {
  return {
    aiGenerated,
    assigneeId: null,
    assigneeName: '',
    description: epic.description ? normalizeStoredRichTextMarkdown(epic.description) : '',
    id: randomUUID(),
    name: String(epic.name ?? 'Generated epic').trim() || 'Generated epic',
    points: epic.points ?? null,
    priority: Number(epic.priority ?? 4),
    status: epic.status ?? 'Not Started',
    stories: (epic.stories ?? []).map((story) => normalizeGeneratedStory(story, { aiGenerated })),
    targetEndDate: null,
    targetStartDate: null,
  };
}

const generatedTaskSchema = z.object({
  description: z.string().trim().max(8000).default(''),
  name: z.string().trim().min(1).max(255),
  points: z.preprocess(numberOrNull, z.number().int().nullable()).optional().default(null),
  priority: z.preprocess(numberOrNull, z.number().int().min(1).max(7).nullable()).optional().default(null),
  status: z.string().trim().min(1).max(80).default('Not Started'),
});

const generatedStorySchema = z.object({
  description: z.string().trim().max(8000).default(''),
  name: z.string().trim().min(1).max(255),
  points: z.preprocess(numberOrNull, z.number().int().nullable()).optional().default(null),
  priority: z.preprocess(numberOrNull, z.number().int().min(1).max(7).nullable()).optional().default(null),
  status: z.string().trim().min(1).max(80).default('Not Started'),
  tasks: z.array(generatedTaskSchema).max(32).default([]),
});

const generatedEpicSchema = z.object({
  description: z.string().trim().max(8000).default(''),
  name: z.string().trim().min(1).max(255),
  points: z.preprocess(numberOrNull, z.number().int().nullable()).optional().default(null),
  priority: z.preprocess(numberOrNull, z.number().int().min(1).max(7).nullable()).optional().default(null),
  status: z.string().trim().min(1).max(80).default('Not Started'),
  stories: z.array(generatedStorySchema).max(32).default([]),
});

const generatedStructureResponseSchema = z.object({
  epics: z.array(generatedEpicSchema).max(32).default([]),
});

const generatedStoriesResponseSchema = z.object({
  stories: z.array(generatedStorySchema).max(40).default([]),
});

const generatedTasksResponseSchema = z.object({
  tasks: z.array(generatedTaskSchema).max(64).default([]),
});

const suggestionsResponseSchema = z.object({
  suggestions: z.array(z.string().trim().min(1).max(16000)).length(3),
});

const analysisResponseSchema = z.object({
  analysis: z.string().trim().min(1).max(16000),
});

function buildStructuredInstructions(baseInstructions = '', suffix = '') {
  return [
    String(baseInstructions ?? '').trim(),
    suffix,
  ].filter(Boolean).join('\n\n');
}

export function createOpenAiProjectAiService({
  apiKey,
  client: providedClient = null,
  model: defaultModel = 'gpt-6-luna',
} = {}) {
  const client = providedClient ?? new OpenAI({ apiKey });

  return {
    async enhanceDescription({ description, model, project, reasoningEffort = 'max' }) {
      const modelToUse = model || defaultModel;
      const payload = JSON.stringify({
        description: description || project.description || '',
        selected_section: '',
        title: project.name ?? '',
      }, null, 2);
      const response = await generateValidatedStructuredOutput({
        client,
        input: buildTextInput(payload),
        instructions: buildStructuredInstructions(
          legacyPrompts.projectDescriptionRewrite,
          'Return exactly three alternative suggestions in the suggestions array. Each suggestion must be markdown text only.',
        ),
        model: modelToUse,
        operationName: 'projectAi.enhanceDescription',
        reasoningEffort,
        schema: suggestionsResponseSchema,
        schemaName: 'project_ai_enhance_description',
        temperature: 0.3,
      });

      return {
        model: modelToUse,
        provider: 'openai',
        suggestions: response.suggestions.map(markdownToSafeHtml),
      };
    },
    async analyzeProject({ model, project, reasoningEffort = 'max' }) {
      const modelToUse = model || defaultModel;
      const response = await generateValidatedStructuredOutput({
        client,
        input: buildTextInput(createProjectContext(project)),
        instructions: buildStructuredInstructions(
          legacyPrompts.analysis,
          'Return the analysis field only. Keep it concise, actionable, and in markdown.',
        ),
        model: modelToUse,
        operationName: 'projectAi.analyzeProject',
        reasoningEffort,
        schema: analysisResponseSchema,
        schemaName: 'project_ai_analysis',
        temperature: 0.2,
      });

      return {
        analysis: markdownToSafeHtml(response.analysis),
        model: modelToUse,
        provider: 'openai',
      };
    },
    async generateStructure({ allowedWorkItemStatuses = [], model, project, reasoningEffort = 'max' }) {
      const modelToUse = model || defaultModel;
      const prompt = `${legacyPrompts.epicsGenerate ?? legacyPrompts.epics ?? ''}`.trim();

      if (!prompt) {
        throw new Error('Legacy epic generation prompt is missing.');
      }

      const response = await generateValidatedStructuredOutput({
        client,
        input: buildTextInput(createProjectContext(project)),
        instructions: buildStructuredInstructions(
          prompt,
          'Ignore any raw-JSON-only formatting instructions from the legacy prompt. Populate the provided schema directly.',
        ),
        model: modelToUse,
        operationName: 'projectAi.generateStructure',
        reasoningEffort,
        schema: generatedStructureResponseSchema,
        schemaName: 'project_ai_generate_structure',
        temperature: 0.2,
        validator(output) {
          return validateGeneratedStructureOutput(output, allowedWorkItemStatuses);
        },
      });

      return {
        epics: response.epics.map((epic) => normalizeGeneratedEpic(epic, { aiGenerated: true })),
        model: modelToUse,
        provider: 'openai',
      };
    },
    async generateStories({ allowedWorkItemStatuses = [], model, projectJson, reasoningEffort = 'max' }) {
      const modelToUse = model || defaultModel;
      const prompt = legacyPrompts.storiesGenerate?.trim();

      if (!prompt) {
        throw new Error('Legacy story generation prompt is missing.');
      }

      const response = await generateValidatedStructuredOutput({
        client,
        input: buildTextInput(projectJson),
        instructions: buildStructuredInstructions(
          prompt,
          'Ignore any raw-JSON-only formatting instructions from the legacy prompt. Populate the provided schema directly.',
        ),
        model: modelToUse,
        operationName: 'projectAi.generateStories',
        reasoningEffort,
        schema: generatedStoriesResponseSchema,
        schemaName: 'project_ai_generate_stories',
        temperature: 0.2,
        validator(output) {
          return validateGeneratedStoriesOutput(output, allowedWorkItemStatuses);
        },
      });

      return {
        model: modelToUse,
        provider: 'openai',
        stories: response.stories.map((story) => normalizeGeneratedStory(story, { aiGenerated: true })),
      };
    },
    async generateTasks({ allowedWorkItemStatuses = [], model, reasoningEffort = 'max', storyDescription }) {
      const modelToUse = model || defaultModel;
      const prompt = legacyPrompts.tasksGenerate?.trim();

      if (!prompt) {
        throw new Error('Legacy task generation prompt is missing.');
      }

      const response = await generateValidatedStructuredOutput({
        client,
        input: buildTextInput(storyDescription ?? ''),
        instructions: buildStructuredInstructions(
          prompt,
          'Ignore any raw-JSON-only formatting instructions from the legacy prompt. Populate the provided schema directly.',
        ),
        model: modelToUse,
        operationName: 'projectAi.generateTasks',
        reasoningEffort,
        schema: generatedTasksResponseSchema,
        schemaName: 'project_ai_generate_tasks',
        temperature: 0.2,
        validator(output) {
          return validateGeneratedTasksOutput(output, allowedWorkItemStatuses);
        },
      });

      return {
        model: modelToUse,
        provider: 'openai',
        tasks: response.tasks.map((task) => normalizeGeneratedTask(task, { aiGenerated: true })),
      };
    },
    async enhanceRichText({
      element,
      fullText,
      imageDataUrls = [],
      mode,
      model,
      reasoningEffort = 'max',
      selectedText,
      title = '',
    }) {
      const modelToUse = model || defaultModel;
      const systemMessage = element === 'storyDescription'
        ? legacyPrompts.storyDescriptionRewrite
        : legacyPrompts.projectDescriptionRewrite;

      const payload = JSON.stringify({
        description: fullText ?? '',
        selected_section: selectedText ?? '',
        title: title ?? '',
      }, null, 2);

      const response = await generateValidatedStructuredOutput({
        client,
        input: buildTextAndImageInput({ imageDataUrls, text: payload }),
        instructions: buildStructuredInstructions(
          systemMessage || '',
          'Return exactly three alternative suggestions in the suggestions array. Each suggestion must be markdown text only.',
        ),
        model: modelToUse,
        operationName: 'projectAi.enhanceRichText',
        reasoningEffort,
        schema: suggestionsResponseSchema,
        schemaName: 'project_ai_enhance_rich_text',
        temperature: selectedText ? 0.6 : 0.3,
      });

      return {
        model: modelToUse,
        provider: 'openai',
        suggestions: response.suggestions.map(markdownToSafeHtml),
      };
    },
  };
}
