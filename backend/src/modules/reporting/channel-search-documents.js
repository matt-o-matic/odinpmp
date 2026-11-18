// Workspace search over channels: channel names and posts (their text,
// author, channel and project). Files, in channels or elsewhere, get their rows from
// search-documents.js, with their text. Rows carry their project id, so searchForUser shows each person only the
// channels of projects they can open; an engagement's rows show only while the Consulting
// module is on. Deleted posts are left out, as are channels of deleted projects.
import { isEngagementProject } from '../../lib/projects/project-kind.js';
import { channelPath } from '../channels/channel-links.js';
import { mentionExcerpt } from '../requirements/mentions/mention-tokens.js';

// Long posts are cut for the index; search still finds their opening.
const POST_TEXT_LIMIT = 4000;

/**
 * Everything the index needs, read as the index principal. Repositories without channels
 * (some tests) give nothing.
 */
export async function loadChannelSearchSources({ projectRepository, tenantId, user }) {
  if (typeof projectRepository?.listChannelSearchSources !== 'function') return null;
  const [projects, sources] = await Promise.all([
    projectRepository.listProjectsForTenant({ includeEngagements: true, tenantId, user }),
    projectRepository.listChannelSearchSources({ tenantId }),
  ]);
  return { ...sources, projects };
}

function postText(body) {
  return mentionExcerpt(body, '', { radius: POST_TEXT_LIMIT / 2 });
}

export function buildChannelSearchDocuments({ channels = [], posts = [], projects = [] }) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const channelById = new Map();
  const documents = [];
  for (const channel of channels) {
    const project = projectById.get(channel.projectId);
    if (!project) continue;
    channelById.set(channel.id, { ...channel, project });
    documents.push({
      content: `${channel.description ?? ''} ${project.name}`.trim(),
      documentType: 'channel',
      facets: { project: project.name, ...(channel.archivedAt ? { status: 'Archived' } : {}) },
      projectId: project.id,
      sourceId: channel.id,
      title: `#${channel.name}`,
      updatedAt: channel.updatedAt,
      url: channelPath({ channelId: channel.id, kind: isEngagementProject(project) ? 'engagement' : 'delivery', projectId: project.id }),
    });
  }
  for (const post of posts) {
    const channel = channelById.get(post.channelId);
    if (!channel) continue;
    const author = post.authorName || 'Someone';
    documents.push({
      content: `${postText(post.body)} · ${channel.project.name}`,
      documentType: 'post',
      facets: { author, channel: `#${channel.name}`, project: channel.project.name },
      projectId: channel.project.id,
      sourceId: post.id,
      title: `${author} in #${channel.name}`,
      updatedAt: post.editedAt ?? post.createdAt,
      // A reply opens its thread.
      url: channelPath({ channelId: channel.id, kind: isEngagementProject(channel.project) ? 'engagement' : 'delivery', postId: post.parentId ?? post.id, projectId: channel.project.id }),
    });
  }
  return documents;
}
