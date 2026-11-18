import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { HttpError } from '../../lib/errors/http-error.js';
import { extractReferencedFileIds } from '../../lib/content/html-content.js';

function getPrimaryTenantId(user) {
  return user.memberships?.[0]?.tenantId ?? null;
}

async function requireProjectContext({
  inputProject,
  projectId,
  repository,
  tenantId,
  user,
}) {
  await requireProjectCapability({
    capability: PROJECT_CAPABILITIES.READ,
    projectId,
    repository,
    tenantId,
    user,
  });
  const storedProject = await repository.getProjectDetail({
    projectId,
    tenantId,
  });

  if (!storedProject) {
    throw new HttpError(404, 'Project not found.');
  }

  return inputProject ?? storedProject;
}

function requireProjectAiService(projectAiService) {
  if (!projectAiService) {
    throw new HttpError(503, 'Project AI is not configured.');
  }

  return projectAiService;
}

function findEpic(project, epicId) {
  return (project?.epics ?? []).find((epic) => epic.id === epicId) ?? null;
}

function findStory(project, storyId) {
  for (const epic of project?.epics ?? []) {
    const story = (epic.stories ?? []).find((item) => item.id === storyId);
    if (story) {
      return story;
    }
  }

  return null;
}

async function loadInlineImageDataUrls({
  html,
  projectRepository,
  tenantId,
  user,
} = {}) {
  const fileIds = extractReferencedFileIds(html ?? '');
  const urls = [];

  for (const fileId of fileIds.slice(0, 4)) {
    const asset = await projectRepository.getFileAsset({
      fileId,
      tenantId,
      user,
    });

    if (!asset?.bytes || asset.size == null) {
      continue;
    }

    // Keep payload sizes bounded.
    if (asset.size > 900_000) {
      continue;
    }

    const base64 = Buffer.from(asset.bytes).toString('base64');
    const contentType = asset.contentType || 'application/octet-stream';
    urls.push(`data:${contentType};base64,${base64}`);

    if (urls.length >= 2) {
      break;
    }
  }

  return urls;
}

export async function enhanceProjectDescriptionForUser({
  input,
  projectAiService,
  projectId,
  projectRepository,
  user,
}) {
  const tenantId = getPrimaryTenantId(user);

  if (!tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  const provider = requireProjectAiService(projectAiService);
  const project = await requireProjectContext({
    inputProject: input.project,
    projectId,
    repository: projectRepository,
    tenantId,
    user,
  });
  const result = await provider.enhanceDescription({
    description: input.description || project.description || '',
    project,
    tenantId,
    user,
  });

  return {
    ok: true,
    model: result.model ?? '',
    projectId,
    provider: result.provider,
    suggestions: result.suggestions,
  };
}

export async function analyzeProjectForUser({
  input,
  projectAiService,
  projectId,
  projectRepository,
  user,
}) {
  const tenantId = getPrimaryTenantId(user);

  if (!tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  const provider = requireProjectAiService(projectAiService);
  const project = await requireProjectContext({
    inputProject: input.project,
    projectId,
    repository: projectRepository,
    tenantId,
    user,
  });
  const result = await provider.analyzeProject({
    project,
    tenantId,
    user,
  });

  return {
    analysis: result.analysis,
    model: result.model ?? '',
    ok: true,
    projectId,
    provider: result.provider,
  };
}

export async function generateProjectStructureForUser({
  input,
  projectAiService,
  projectId,
  projectRepository,
  user,
}) {
  const tenantId = getPrimaryTenantId(user);

  if (!tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  const provider = requireProjectAiService(projectAiService);
  const project = await requireProjectContext({
    inputProject: input.project,
    projectId,
    repository: projectRepository,
    tenantId,
    user,
  });
  const result = await provider.generateStructure({
    project,
    tenantId,
    user,
  });

  return {
    epics: result.epics,
    model: result.model ?? '',
    ok: true,
    projectId,
    provider: result.provider,
  };
}

export async function generateProjectStoriesForUser({
  input,
  projectAiService,
  projectId,
  projectRepository,
  user,
}) {
  const tenantId = getPrimaryTenantId(user);

  if (!tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  const provider = requireProjectAiService(projectAiService);
  const project = await requireProjectContext({
    inputProject: input.project,
    projectId,
    repository: projectRepository,
    tenantId,
    user,
  });

  const epic = findEpic(project, input.epicId);

  if (!epic) {
    throw new HttpError(404, 'Epic not found.');
  }

  const projectJson = JSON.stringify({
    project: {
      epics: (project.epics ?? []).map((item) => ({
        ...item,
        genStories: item.id === epic.id,
      })),
    },
  });
  const result = await provider.generateStories({
    project,
    projectJson,
    tenantId,
    user,
  });

  return {
    epicId: epic.id,
    model: result.model ?? '',
    ok: true,
    projectId,
    provider: result.provider,
    stories: result.stories,
  };
}

export async function generateProjectTasksForUser({
  input,
  projectAiService,
  projectId,
  projectRepository,
  user,
}) {
  const tenantId = getPrimaryTenantId(user);

  if (!tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  const provider = requireProjectAiService(projectAiService);
  const project = await requireProjectContext({
    inputProject: input.project,
    projectId,
    repository: projectRepository,
    tenantId,
    user,
  });
  const story = findStory(project, input.storyId);

  if (!story) {
    throw new HttpError(404, 'Story not found.');
  }

  const result = await provider.generateTasks({
    project,
    storyDescription: story.description ?? '',
    tenantId,
    user,
  });

  return {
    model: result.model ?? '',
    ok: true,
    projectId,
    provider: result.provider,
    storyId: story.id,
    tasks: result.tasks,
  };
}

export async function enhanceRichTextForUser({
  input,
  projectAiService,
  projectId,
  projectRepository,
  user,
}) {
  const tenantId = getPrimaryTenantId(user);

  if (!tenantId) {
    throw new HttpError(403, 'This account is not assigned to a tenant.');
  }

  const provider = requireProjectAiService(projectAiService);
  const imageDataUrls = await loadInlineImageDataUrls({
    html: input.fullHtml,
    projectRepository,
    tenantId,
    user,
  });
  const element = input.element || (input.targetType === 'story' ? 'storyDescription' : 'projectDescription');

  const result = await provider.enhanceRichText({
    element,
    fullText: input.fullText,
    imageDataUrls,
    mode: input.mode,
    selectedText: input.selectedText,
    tenantId,
    title: input.title,
    user,
  });

  return {
    model: result.model ?? '',
    ok: true,
    projectId,
    provider: result.provider,
    suggestions: result.suggestions,
  };
}
