// Rows for the search index beyond projects, governance and channel posts
// (docs/semantic-search/plan.md): work items with their own links, comments, and the files of a
// project with the passages of their text. Long text is split into passages; each passage is a
// row of its own, `<sourceId>#<n>` from the second on, so each gets its own embedding and the
// search collapses them back to one result.
import { isEngagementProject } from '../../lib/projects/project-kind.js';
import { folderPaths } from '../channels/channel-library.js';
import { channelPath } from '../channels/channel-links.js';
import { htmlToText, splitPassages } from './search-text.js';

// Text a single search row holds before it is split into passages.
export const ROW_TEXT_CHARS = 4400;
// The most text of one file that is indexed: about 100 passages.
export const FILE_TEXT_INDEX_CHARS = 400_000;
const COMMENT_TEXT_CHARS = 20_000;

const TYPE_NAMES = { epic: 'Epic', story: 'Story', task: 'Task' };

export function itemUrl(projectId, itemId) {
  return `/projects/${encodeURIComponent(projectId)}?item=${encodeURIComponent(itemId)}`;
}

function projectPath(project) {
  return isEngagementProject(project) ? `/engagements/${encodeURIComponent(project.id)}/channels` : `/projects/${encodeURIComponent(project.id)}`;
}

/** Each work item of a project tree as { item, itemType, parents }: epics, their stories, and the stories' tasks. */
export function projectWorkItems(project) {
  const records = [];
  for (const epic of project?.epics ?? []) {
    records.push({ item: epic, itemType: 'epic', parents: [] });
    for (const story of epic.stories ?? []) {
      records.push({ item: story, itemType: 'story', parents: [epic.name] });
      for (const task of story.tasks ?? []) records.push({ item: task, itemType: 'task', parents: [epic.name, story.name] });
    }
  }
  return records;
}

/** A work item's row: its type, place in the plan, description, status and assignee. */
export function workItemDocument(project, { item, itemType, parents }) {
  const lines = [
    `${TYPE_NAMES[itemType] ?? itemType} in ${project.name}${parents.filter(Boolean).length ? `, under ${parents.filter(Boolean).join(' › ')}` : ''}`,
    htmlToText(item.description),
    htmlToText(item.acceptanceCriteria),
    [item.status ? `Status: ${item.status}` : '', item.assigneeName ? `Assignee: ${item.assigneeName}` : ''].filter(Boolean).join(' · '),
  ];
  return {
    content: lines.filter(Boolean).join('\n'),
    documentType: itemType,
    facets: { project: project.name, ...(item.status ? { status: item.status } : {}) },
    projectId: project.id,
    sourceId: item.id,
    title: item.name,
    updatedAt: item.updatedAt ?? project.updatedAt,
    url: itemUrl(project.id, item.id),
  };
}

/**
 * Comment rows. `projects` are every project of the workspace (engagements too), each with its
 * work-item tree where it has one, so a comment can name the item it is on.
 */
export function buildCommentDocuments({ comments = [], projects = [] }) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const itemNames = new Map();
  for (const project of projects) for (const { item, itemType } of projectWorkItems(project)) itemNames.set(item.id, { itemType, name: item.name });
  const documents = [];
  for (const comment of comments) {
    const project = projectById.get(comment.projectId);
    if (!project) continue;
    const text = htmlToText(comment.body).slice(0, COMMENT_TEXT_CHARS);
    if (!text) continue;
    const author = comment.authorName || 'Someone';
    const onProject = comment.targetType === 'project';
    const item = itemNames.get(comment.targetId);
    const place = onProject ? project.name : item?.name ?? `a ${comment.targetType}`;
    documents.push({
      content: `${text}\n${onProject ? `Comment on the project ${project.name}` : `Comment on the ${comment.targetType} ${place} in ${project.name}`}`,
      documentType: 'comment',
      facets: { author, on: onProject ? 'project' : comment.targetType, project: project.name },
      projectId: project.id,
      sourceId: comment.id,
      title: `${author} on ${place}`,
      updatedAt: comment.updatedAt,
      url: onProject ? projectPath(project) : itemUrl(project.id, comment.targetId),
    });
  }
  return documents;
}

/**
 * File rows: the file's name and where it is, then the start of its text; later passages follow
 * as rows of their own. `texts` maps a file id to its cached text entry (search_file_texts).
 * `channels` and `folders` come from the channel search sources, for a channel file's place and link.
 */
export function buildFileDocuments({ channels = [], files = [], folders = [], projects = [], texts = new Map() }) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const itemNames = new Map();
  for (const project of projects) for (const { item, itemType } of projectWorkItems(project)) itemNames.set(item.id, `${TYPE_NAMES[itemType] ?? itemType} ${item.name}`);
  const paths = folderPaths(folders);
  const documents = [];
  for (const file of files) {
    const project = projectById.get(file.projectId);
    if (!project) continue;
    const channel = file.targetType === 'channel' ? channelById.get(file.targetId) : null;
    if (file.targetType === 'channel' && !channel) continue;
    const folder = file.folderId ? paths.get(file.folderId) : null;
    const place = channel
      ? [`#${channel.name}`, folder, project.name]
      : file.targetType === 'project' ? [folder, project.name]
        : file.targetType === 'clarification' ? ['Requirements', project.name]
          : [itemNames.get(file.targetId), project.name];
    const url = channel
      ? channelPath({ channelId: channel.id, fileId: file.id, kind: isEngagementProject(project) ? 'engagement' : 'delivery', projectId: project.id })
      : ['project', 'clarification'].includes(file.targetType) ? projectPath(project) : itemUrl(project.id, file.targetId);
    const entry = texts.get(file.id);
    const text = entry?.status === 'ok' && entry.version === file.version ? String(entry.text ?? '').slice(0, FILE_TEXT_INDEX_CHARS) : '';
    documents.push({
      content: [place.filter(Boolean).join(' · '), text].filter(Boolean).join('\n\n'),
      documentType: 'file',
      facets: { fileId: file.id, project: project.name, ...(channel ? { channel: `#${channel.name}` } : {}) },
      projectId: project.id,
      sourceId: file.id,
      title: file.fileName,
      updatedAt: file.updatedAt,
      url,
    });
  }
  return documents;
}

/** Splits rows whose text is longer than one passage into passage rows (`<sourceId>#2`, `#3`, …). */
export function splitLongDocuments(documents) {
  const out = [];
  for (const document of documents) {
    const content = String(document.content ?? '');
    if (content.length <= ROW_TEXT_CHARS) {
      out.push(document);
      continue;
    }
    splitPassages(content).forEach((passage, index) => {
      out.push({ ...document, content: passage, facets: { ...document.facets, passage: String(index + 1) }, sourceId: index ? `${document.sourceId}#${index + 1}` : document.sourceId });
    });
  }
  return out;
}
