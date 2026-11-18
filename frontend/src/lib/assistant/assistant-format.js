import { renderRichTextToHtml } from '../rich-content/html.js';

// Display helpers for the assistant: reply markdown with links into Odin, activity and plan
// summaries, attachments and the page context sent with a message.

const ODIN_LINK = /\(odin:\/\/(item|project)\/([A-Za-z0-9_-]+)\)/g;
// Citation markup the model sometimes writes as text (private-use characters around "cite" and
// source ids); the server drops it from saved replies, and this covers live text and older replies.
const CITATION_MARKUP = /[ \t]?[^\n]*|[-]/g;

// The model links items as odin://item/<id>; they become in-app anchors the workspace handles.
export function renderAssistantMarkdown(text = '', apiBaseUrl) {
  const prepared = String(text ?? '').replace(CITATION_MARKUP, '').replace(ODIN_LINK, (_, kind, id) => `(#odin-${kind}:${id})`);
  return renderRichTextToHtml(prepared, apiBaseUrl);
}

export function parseOdinHref(href = '') {
  const match = String(href ?? '').match(/#odin-(item|project):([A-Za-z0-9_-]+)$/);
  return match ? { id: match[2], kind: match[1] } : null;
}

export function activitySummary(activity = []) {
  const count = activity.length;
  if (!count) return '';
  const failed = activity.filter((entry) => entry.ok === false).length;
  return `Used ${count} tool${count === 1 ? '' : 's'}${failed ? ` · ${failed} didn't work` : ''}`;
}

export function planProgress(plan = []) {
  const steps = plan ?? [];
  return { done: steps.filter((step) => step.status === 'done' || step.status === 'skipped').length, total: steps.length };
}

export function proposalCounts(proposal = {}) {
  const counts = { applied: 0, dismissed: 0, failed: 0, pending: 0 };
  for (const item of proposal.items ?? []) {
    const key = item.status === 'withdrawn' ? 'dismissed' : item.status;
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

// A moment in the chat list, in local time: "today, 2:14 PM", "yesterday, 4:05 PM",
// "Oct 26, 9:14 AM", or "Oct 26, 2025" from an earlier year.
export function chatListTime(iso, now = Date.now()) {
  const time = Date.parse(iso ?? '');
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const today = new Date(now);
  const clock = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const dayStart = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((dayStart(today) - dayStart(date)) / 86_400_000);
  if (days === 0) return `today, ${clock}`;
  if (days === 1) return `yesterday, ${clock}`;
  if (date.getFullYear() === today.getFullYear()) return `${date.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}, ${clock}`;
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

// What the user is looking at, so "this story" and "this sprint" mean something.
const VIEW_LABELS = {
  home: 'Home',
  'project-detail': 'the project plan',
  'project-governance': 'project Governance',
  'project-insights': 'project Insights',
  'project-kanban': 'the Kanban board',
  'project-requirements': 'project Requirements',
  'project-resources': 'project Resources',
  'project-sprints': 'project Sprints',
  'project-tickets': 'project Tickets',
  resources: 'Resources',
  finance: 'Finance',
  portfolio: 'Portfolio',
  tickets: 'Tickets',
};

export function pageContextFor(route = {}, { itemId = null } = {}) {
  const name = String(route.name ?? '');
  const view = VIEW_LABELS[name] ?? (name.startsWith('project-requirements') ? 'project Requirements' : name ? name.replace(/-/g, ' ') : '');
  const selected = itemId ?? route.query?.item ?? null;
  return view || selected ? { ...(view ? { view } : {}), ...(selected ? { itemId: String(selected) } : {}) } : null;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|x-ndjson))/i;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log|html?|sql|js|ts|py)$/i;
export const MAX_TEXT_ATTACHMENT_BYTES = 200 * 1024;
export const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export function attachmentKind(file) {
  if (/^image\/(png|jpe?g|gif|webp)$/i.test(file?.type ?? '')) return 'image';
  if (TEXT_TYPES.test(file?.type ?? '') || TEXT_EXTENSIONS.test(file?.name ?? '')) return 'text';
  return null;
}

async function downscaleImage(file, maxSide = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

// Reads a picked file into what the API accepts: text, or an image as a (scaled) data URL.
export async function readAttachment(file) {
  const kind = attachmentKind(file);
  if (!kind) throw new Error(`${file.name}: attach text files (such as .txt, .md, .csv, .json) or images.`);
  if (kind === 'text') {
    if (file.size > MAX_TEXT_ATTACHMENT_BYTES) throw new Error(`${file.name} is larger than 200 KB.`);
    return { mimeType: file.type || 'text/plain', name: file.name, size: file.size, text: await file.text() };
  }
  if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) throw new Error(`${file.name} is larger than 8 MB.`);
  return { dataUrl: await downscaleImage(file), mimeType: 'image/jpeg', name: file.name, size: file.size };
}

// Starter prompts for an empty chat, matched to where the user is.
export function suggestedPrompts({ projectName = '', view = '' } = {}) {
  if (!projectName) {
    return ['What needs my attention today?', 'Which projects are behind schedule?', 'Start a new project plan with me'];
  }
  const common = [`Summarize ${projectName}`, "What's left in the active sprint?", 'Who is over-allocated on this project?'];
  if (/kanban|sprint/i.test(view)) return ["What's blocked on the board?", "What's left in the active sprint?", 'Rebalance the sprint across the team'];
  if (/requirement/i.test(view)) return ['Which clarifications are still open?', 'Summarize the latest review round feedback', 'Draft topics for the open questions'];
  return [...common, 'Find stories without acceptance criteria'];
}

const WRITING_SETTLES_MS = 1500;

function formatElapsed(seconds) {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// What the working indicator says while a turn runs: the tool in use, "Writing" while text
// streams, otherwise "Thinking" (the model reasons between steps), plus the time so far.
export function liveStatus(live, now = Date.now()) {
  if (!live) return null;
  const running = (live.activity ?? []).filter((entry) => entry.status === 'running');
  let label = 'Thinking';
  if (running.length) label = running.length > 1 ? `${running[0].label} and ${running.length - 1} more` : running[0].label;
  else if (live.phase === 'writing' && now - Number(live.phaseAt ?? 0) < WRITING_SETTLES_MS) label = 'Writing';
  const started = Date.parse(live.startedAt ?? '');
  return { elapsed: Number.isFinite(started) ? formatElapsed(Math.max(0, Math.floor((now - started) / 1000))) : '', label };
}
