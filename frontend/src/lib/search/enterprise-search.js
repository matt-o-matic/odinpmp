// Shapes the /search page state and the enterprise search results (GET /api/reporting/search).

export const SEARCH_PAGE_SIZE = 20;

export const SEARCH_CATEGORIES = Object.freeze([
  { icon: 'bi-folder2-open', key: 'projects', label: 'Projects', types: ['project'] },
  { icon: 'bi-list-check', key: 'work', label: 'Work items', types: ['epic', 'story', 'task'] },
  { icon: 'bi-chat-square-quote', key: 'comments', label: 'Comments', types: ['comment'] },
  { icon: 'bi-shield-exclamation', key: 'governance', label: 'Risks, issues & milestones', types: ['risk', 'assumption', 'issue', 'decision', 'change_request', 'milestone'] },
  { icon: 'bi-diagram-3', key: 'portfolio', label: 'Portfolio & strategy', types: ['portfolio', 'program', 'objective', 'key_result'] },
  { icon: 'bi-bullseye', key: 'goals', label: 'Agent goals', types: ['agent_goal'] },
  { icon: 'bi-chat-left-text', key: 'channels', label: 'Channels & posts', types: ['channel', 'post'] },
  { icon: 'bi-paperclip', key: 'files', label: 'Files', types: ['file'] },
]);

const TYPE_LABELS = Object.freeze({
  agent_goal: 'Agent goal',
  assumption: 'Assumption',
  change_request: 'Change request',
  channel: 'Channel',
  comment: 'Comment',
  decision: 'Decision',
  epic: 'Epic',
  file: 'File',
  issue: 'Issue',
  key_result: 'Key result',
  milestone: 'Milestone',
  objective: 'Objective',
  portfolio: 'Portfolio',
  post: 'Post',
  program: 'Program',
  project: 'Project',
  risk: 'Risk',
  story: 'Story',
  task: 'Task',
});

const OTHER_CATEGORY = Object.freeze({ icon: 'bi-file-earmark-text', key: 'other', label: 'Other results', types: [] });

export function searchTypeLabel(type) {
  const value = String(type ?? '');
  return TYPE_LABELS[value] ?? value.replaceAll('_', ' ');
}

export function searchCategoryFor(type) {
  return SEARCH_CATEGORIES.find((category) => category.types.includes(type)) ?? OTHER_CATEGORY;
}

function single(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : '';
}

export function parseSearchRouteQuery(query = {}) {
  const page = Number.parseInt(single(query.page), 10);
  const category = single(query.type);
  return {
    category: SEARCH_CATEGORIES.some((item) => item.key === category) ? category : '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    projectId: single(query.project).trim(),
    q: single(query.q).trim().slice(0, 500),
  };
}

export function buildSearchRouteQuery({ category = '', page = 1, projectId = '', q = '' } = {}) {
  const query = {};
  if (q.trim()) query.q = q.trim();
  if (category) query.type = category;
  if (projectId) query.project = projectId;
  if (page > 1) query.page = String(page);
  return query;
}

export function buildSearchRequest({ category, page, projectId, q }, pageSize = SEARCH_PAGE_SIZE) {
  const types = SEARCH_CATEGORIES.find((item) => item.key === category)?.types ?? [];
  return {
    limit: pageSize,
    offset: (Math.max(1, page) - 1) * pageSize,
    projectId,
    query: q,
    types: types.join(','),
  };
}

// Governance records live on the project's Governance tab. Rows indexed before that route
// existed carry `?tab=governance`, which the project page ignores, so map them as well. Work
// items, and comments on them, open the item (`?item=`); a file opens where it is kept.
export function searchResultLink(record) {
  const url = String(record?.url ?? '');
  const legacy = url.match(/^\/projects\/([^/?#]+)\?tab=governance$/);
  if (legacy) return `/projects/${legacy[1]}/governance`;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (record?.projectId) return `/projects/${encodeURIComponent(record.projectId)}`;
  return '/';
}

// Groups one page of ranked results by category, keeping rank order inside each group and
// ordering the groups by their best-ranked result.
export function groupSearchResults(records = []) {
  const groups = new Map();
  for (const record of records) {
    const category = searchCategoryFor(record.documentType);
    if (!groups.has(category.key)) groups.set(category.key, { ...category, records: [] });
    groups.get(category.key).records.push(record);
  }
  return [...groups.values()];
}

export function searchPageCount(total, pageSize = SEARCH_PAGE_SIZE) {
  return Math.max(1, Math.ceil(Number(total ?? 0) / pageSize));
}

export function searchSnippet(content, limit = 200) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}
