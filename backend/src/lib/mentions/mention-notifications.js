// Match TipTap mention spans regardless of attribute order.
// Example output:
//   <span class="mention" data-user-id="..." data-mention-label="...">@Name</span>
const mentionSpanPattern = /<span\b(?=[^>]*\bclass="[^"]*\bmention\b[^"]*")(?=[^>]*\b(?:data-user-id|data-userid)="([^"]+)")[^>]*>.*?<\/span>/gis;

function stripTags(html) {
  return String(html ?? '').replace(/<[^>]*?>/g, '');
}

function normalizeBaseUrl(url) {
  const trimmed = String(url ?? '').trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function buildFocusUrl({ frontendAppUrl, projectId, targetType, targetId }) {
  const base = normalizeBaseUrl(frontendAppUrl);
  const root = base ? `${base}/projects/${projectId}` : `/app/projects/${projectId}`;

  if (!targetType || targetType === 'project') {
    return `${root}#comments`;
  }

  const focus = `${targetType}:${targetId}`;
  return `${root}?focus=${encodeURIComponent(focus)}#comments`;
}

export function extractMentionSpans(html = '') {
  const spans = [];
  const source = String(html ?? '');
  const matches = [...source.matchAll(mentionSpanPattern)];

  for (const match of matches) {
    spans.push({
      fullSpan: match[0],
      userId: match[1],
    });
  }

  return spans;
}

export function buildMentionExcerpt({ html, fullSpan }) {
  const placeholder = '%%MENTION_SPAN%%';
  let temp = String(html ?? '');
  temp = temp.replace(fullSpan, placeholder);
  temp = stripTags(temp);
  temp = temp.replace(placeholder, fullSpan);

  const pos = temp.indexOf(fullSpan);
  if (pos < 0) {
    return temp.slice(0, 400);
  }

  const radius = 50;
  const start = Math.max(0, pos - radius);
  const spanLen = fullSpan.length;
  let excerptLen = (2 * radius) + spanLen;

  if (start + excerptLen > temp.length) {
    excerptLen = temp.length - start;
  }

  const prefix = start > 0 ? '[...]' : '';
  const suffix = start + excerptLen < temp.length ? '[...]' : '';

  return `${prefix}${temp.slice(start, start + excerptLen)}${suffix}`;
}

export function buildMentionNotification({
  commenter,
  frontendAppUrl,
  html,
  mentionedUser,
  project,
  target,
} = {}) {
  const url = buildFocusUrl({
    frontendAppUrl,
    projectId: project.id,
    targetId: target.id,
    targetType: target.type,
  });

  const extendedParts = [];
  if (target.type === 'epic' && target.epicName) {
    extendedParts.push(target.epicName);
  }
  if (target.type === 'story') {
    if (target.epicName) extendedParts.push(target.epicName);
    if (target.storyName) extendedParts.push(target.storyName);
  }
  if (target.type === 'task') {
    if (target.epicName) extendedParts.push(target.epicName);
    if (target.storyName) extendedParts.push(target.storyName);
    if (target.taskName) extendedParts.push(target.taskName);
  }

  const extendedName = extendedParts.length ? `: ${extendedParts.join(': ')}` : '';

  const excerpt = buildMentionExcerpt({ html, fullSpan: target.fullSpan ?? '' }) || '';

  return {
    odinLogo: '<img src="https://odinpmp.com/app/brand/odin-mark-email.png" alt="OdinPMP" width="72" style="display:block; width:72px; max-width:72px; height:auto; border:0; margin-left:auto;" />',
    url,
    projectName: project.name,
    extendedName,
    userName: mentionedUser.name,
    userId: mentionedUser.id,
    userEmail: mentionedUser.email,
    commenterName: commenter.name,
    commenterId: commenter.id,
    commentExcerpt: excerpt,
    commentDateEpoch: Math.floor(Date.now() / 1000),
    commentDate: new Date().toISOString().replace('T', ' ').slice(0, 16),
    userTimeZone: commenter.timezone ?? 'UTC',
  };
}
