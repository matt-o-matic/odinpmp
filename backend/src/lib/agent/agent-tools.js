import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { OdinApiError } from '../../mcp/api-client.js';
import { createOdinToolCatalog } from '../../mcp/catalog.js';
import { isTicketVisibleToAssistant } from '../../modules/assistant/assistant-ticket-visibility.js';
import { createIdRepair } from './agent-ids.js';
import { splitMedia } from './agent-media.js';
import { createOdinQuery, querySchemaText } from './odin-query.js';

// The assistant's tools, built like a coding agent's: a handful of strong first-class tools, plus
// one general way into everything else. The model finds catalog operations with
// odin_operations, reads one's inputs with odin_describe and runs it with odin_run, so it can
// reach every Odin operation (every MCP tool and more) without choosing among dozens each step.
// Every call goes through Odin's REST routes as the signed-in user.

export const CORE_TOOL_NAMES = Object.freeze([
  'odin_project_overview', 'odin_find_items', 'odin_get_item', 'odin_create_plan_items', 'odin_update_items',
  'odin_add_comment', 'odin_search', 'odin_get_my_work', 'odin_list_projects',
]);

// Catalog operations the first-class tools already cover (single-item versions of the bulk tools,
// the raw project read behind the overview). Still runnable, never promoted.
const COVERED_BY_CORE = new Set(['odin_list_items', 'odin_get_project', 'odin_create_item', 'odin_update_item']);

// Keyword groups, used to promote likely operations when the Decisions API is unavailable. This is
// the only list of tools kept outside the catalog: what a tool is for (purpose) and whether the
// assistant asks first (confirm) are on its catalog entry, and a test checks every name here.
export const KEYWORD_GROUPS = [
  // Specific intents come first: a turn is shown the first four operations in this order.
  { pattern: /\b(watch\w*|monitors?|keep an eye|tell me (?:if|when)|let me know (?:if|when)|notify me|alert me)\b/i, operations: ['odin_create_monitor', 'odin_list_monitors', 'odin_stop_monitor'] },
  { pattern: /\b(board|kanban|columns?|swimlanes?)\b/i, operations: ['odin_get_board', 'odin_get_board_config', 'odin_reorder_board_card'] },
  { pattern: /\bsprints?\b/i, operations: ['odin_list_sprints', 'odin_assign_items_to_sprint', 'odin_activate_sprint', 'odin_complete_sprint', 'odin_update_sprint', 'odin_get_sprint_capacity', 'odin_set_sprint_capacity'] },
  { pattern: /\b(workflows?|statuses|transitions?)\b/i, operations: ['odin_get_workflows'] },
  // Signatures before approvals: a client's sign-off is a signature request, not a workflow approval.
  { pattern: /\b(sign(?:s|ed|ing|ers?|atures?)?|e-?sign\w*|countersign\w*|sign[- ]?offs?|acceptance|(?:share|send)\b.{0,30}\b(?:client|customer|stakeholders?)|(?:mark|make|set)\b.{0,30}\b(?:internal|external))\b/i, operations: ['odin_request_signatures', 'odin_list_signing_requests', 'odin_set_file_audience', 'odin_list_project_files', 'odin_get_signing_request', 'odin_remind_signers', 'odin_cancel_signing_request'] },
  { pattern: /\b(approv\w*|sign[- ]?offs?)\b/i, operations: ['odin_list_approvals', 'odin_request_approval', 'odin_decide_approval'] },
  { pattern: /\bcustom fields?\b/i, operations: ['odin_get_custom_fields', 'odin_set_custom_field'] },
  // Billing before files and milestones: "SOW" and "milestone" mean invoice-gen's here.
  { pattern: /\b(billing|billed|unbilled|invoic\w*|sow milestones?|statements? of work|(?:bill|bills|billing) to)\b/i, operations: ['odin_get_project_billing', 'odin_set_story_milestones'] },
  { pattern: /\b(waiting on me|my (?:requirements|reviews?|clarifications?)|needs? my (?:answer|decision|input))\b/i, operations: ['odin_get_my_requirements_work'] },
  { pattern: /\b(requirements?|clarifications?|topics?|decisions?|tracks?)\b/i, operations: ['odin_get_requirements_context', 'odin_list_clarifications', 'odin_list_requirement_topic_summaries'] },
  { pattern: /\b(rounds?|feedback|reviewers?|packages?)\b/i, operations: ['odin_get_round_feedback', 'odin_get_package_status'] },
  // Someone from outside the team in a channel (chat) is a guest there, not a project member.
  { pattern: /\bguests?\b|\b(?:add|invite|bring)\b.{0,60}\b(?:channel|chat|chat ?room|conversation|in here)\b|\b(?:channel|chat|chat ?room)\b.{0,60}\b(?:add|invite|join|participate)\w*/i, operations: ['odin_invite_channel_guest', 'odin_list_channel_guests', 'odin_list_stakeholders'] },
  { pattern: /\b(stakeholders?|invit\w*)\b/i, operations: ['odin_list_stakeholders', 'odin_add_stakeholder'] },
  { pattern: /\b(task access|access links?|(?:their|a|the) link|e-?mails?|(?:see|update) (?:their|his|her) (?:own )?(?:tasks|work))\b/i, operations: ['odin_get_task_access', 'odin_set_task_access', 'odin_send_task_access_link', 'odin_update_project_resource'] },
  { pattern: /\b(members?|roles?|access|permissions?)\b/i, operations: ['odin_list_project_members'] },
  { pattern: /\b(timesheets?|time entr(?:y|ies)|billable|hours? (?:worked|spent|logged)|log(?:ged|ging)? (?:my |\d[\d.]* ?)?(?:h|hrs?|hours?|time))\b/i, operations: ['odin_log_time', 'odin_list_time_entries', 'odin_update_time_entry'] },
  { pattern: /\b(time off|leave|vacation|pto|days? off|out of office|ooo|sick)\b/i, operations: ['odin_list_time_off', 'odin_add_time_off'] },
  { pattern: /\b(staff\w*|allocat\w*|hours? (?:a|per) week|\d+ ?h(?:rs?|ours?)? ?(?:a|per|\/) ?(?:week|wk)|roll(?:ed|ing)? off)\b/i, operations: ['odin_get_project_team', 'odin_add_project_allocation', 'odin_update_project_allocation'] },
  { pattern: /\b(team|resources?|capacity|overload\w*|workload|rates?|who)\b/i, operations: ['odin_get_project_team'] },
  { pattern: /\b(contractors?|freelancers?|vendors?|consultants?|(?:no|without an?) (?:odin )?(?:login|account)|placeholders?|add (?:a |an )?(?:person|resource))\b/i, operations: ['odin_get_project_team', 'odin_add_project_resource', 'odin_update_project_resource', 'odin_set_task_access'] },
  { pattern: /\b(triage|validat\w*|externally submitted|intake|awaiting review|review queue)\b/i, operations: ['odin_list_tickets_awaiting_review', 'odin_review_ticket'] },
  { pattern: /\b(tickets?|defects?|bugs?|support|incidents?)\b/i, operations: ['odin_list_tickets', 'odin_create_ticket', 'odin_update_ticket', 'odin_get_ticket_options'] },
  { pattern: /\b(risks?|issues?|assumptions?|change requests?)\b/i, operations: ['odin_get_governance', 'odin_create_governance_item', 'odin_update_governance_item'] },
  { pattern: /\b(milestones?|launch|go-?live)\b/i, operations: ['odin_get_governance', 'odin_create_milestone', 'odin_update_milestone'] },
  { pattern: /\b(baselines?|re-?baselin\w*)\b/i, operations: ['odin_get_schedule_analysis', 'odin_create_schedule_baseline'] },
  { pattern: /\b(working (?:days?|hours|calendar)|holidays?|calendar)\b/i, operations: ['odin_get_governance', 'odin_update_working_calendar'] },
  { pattern: /\b(predecessors?|successors?|dependenc(?:y|ies))\b/i, operations: ['odin_get_governance', 'odin_create_dependency', 'odin_update_dependency', 'odin_delete_dependency'] },
  { pattern: /\b(schedule|critical path|late|slip\w*|depend\w*|block\w*|timeline|gantt|dates?)\b/i, operations: ['odin_get_timeline', 'odin_list_item_relations', 'odin_get_schedule_analysis'] },
  { pattern: /\b(insights?|health|trends?|throughput|budget|forecast)\b/i, operations: ['odin_get_insights'] },
  { pattern: /\b(mention\w*|tag|ping)\b|@\w+/i, operations: ['odin_list_mentionable_people'] },
  { pattern: /\b(edit|fix|reword|change|delete|remove)\b.*\bcomments?\b/i, operations: ['odin_update_comment', 'odin_delete_comment', 'odin_update_requirement_topic_comment', 'odin_delete_requirement_topic_comment'] },
  { pattern: /\b(comments?|discussion)\b/i, operations: ['odin_list_comments'] },
  { pattern: /\b(?:new|latest|older|earlier|previous|old) versions?\b|\bversions? (?:history|of (?:the|this|that|my) (?:file|doc\w*|sow|spec|pdf))\b/i, operations: ['odin_list_file_versions', 'odin_upload_file_version', 'odin_restore_file_version', 'odin_list_project_files'] },
  { pattern: /\b(?:link|unlink|attach|connect)\b.*\b(?:files?|documents?|docs?|attachments?|sow|spec|pdf)\b|\b(?:files?|documents?|docs?|attachments?|sow|spec|pdf)\b.*\b(?:link|unlink|attach|connect)\b/i, operations: ['odin_list_project_files', 'odin_link_project_file', 'odin_unlink_project_file', 'odin_upload_project_file'] },
  // Organizing files: the folder tree (project, channels, people's folders) and moving files in it.
  { pattern: /\b(?:sub)?folders?\b|\b(?:re-?)?organi[sz]\w*|\btidy\w*|\b(?:move|rename)\b.*\b(?:files?|documents?|docs?|pdfs?|sow|spreadsheets?|notes)\b|\b(?:files?|documents?|docs?|pdfs?)\b.*\b(?:move|rename)\b/i, operations: ['odin_list_file_folders', 'odin_create_folder', 'odin_rename_folder', 'odin_move_folder', 'odin_delete_folder', 'odin_move_file', 'odin_rename_file', 'odin_list_project_files'] },
  { pattern: /\bdownload\w*\b/i, operations: ['odin_list_project_files', 'odin_download_project_file'] },
  // Looking at a picture or scan: odin_view_project_file shows it to the model.
  { pattern: /\b(images?|pictures?|photos?|screenshots?|screen ?grabs?|diagrams?|mock-?ups?|wireframes?|scan(?:s|ned)?|png|jpe?g|look at)\b/i, operations: ['odin_list_project_files', 'odin_view_project_file'] },
  { pattern: /\b(files?|documents?|docs?|attachments?|attached|uploads?|pdfs?|sow|spreadsheets?|meeting notes|minutes)\b/i, operations: ['odin_list_project_files', 'odin_read_project_file', 'odin_upload_project_file', 'odin_download_project_file'] },
  { pattern: /\b(brief)\b/i, operations: ['odin_get_project_brief', 'odin_update_project_brief'] },
  { pattern: /\b(delete|remove)\b/i, operations: ['odin_delete_item', 'odin_delete_ticket'] },
  { pattern: /\b(restore|revert|roll ?back|undelete|earlier version)\b/i, operations: ['odin_list_item_revisions', 'odin_restore_item_revision'] },
  { pattern: /\b(history|revisions?|changed)\b/i, operations: ['odin_list_item_revisions'] },
  { pattern: /\bsplit\b/i, operations: ['odin_split_story'] },
  { pattern: /\b(quality|ready|readiness|acceptance criteria)\b/i, operations: ['odin_check_plan_quality'] },
  { pattern: /\b(new project|create a project|start a project|templates?)\b/i, operations: ['odin_list_project_templates', 'odin_create_project'] },
  { pattern: /\b(remember|memory|memories|recall|last time|previously|forget)\b/i, operations: ['odin_search_memory', 'odin_remember', 'odin_correct_memory', 'odin_forget_memory'] },
];

// Deletes, anything that emails people, and changes that are hard to take back wait for the user to
// confirm: the catalog marks them with confirm (true, or a test of the call's arguments). Every
// other write runs directly, exactly as if the user made the edit.
let declaredConfirm = null;
function declaredConfirmation(name) {
  declaredConfirm ??= new Map(createOdinToolCatalog({ api: null, extended: true }).filter((entry) => entry.confirm).map((entry) => [entry.name, entry.confirm]));
  return declaredConfirm.get(name);
}

export function toolNeedsConfirmation(name, args = {}) {
  if (args?.dryRun) return false;
  const declared = declaredConfirmation(name);
  return typeof declared === 'function' ? Boolean(declared(args)) : Boolean(declared);
}

// Whether a tool always asks first (one that asks only for some arguments is not listed as asking).
const alwaysConfirms = (name) => declaredConfirmation(name) === true;

const LEAN_DROP = new Set(['$schema', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'format']);

// What the model sees: types, enums, defaults, descriptions and required fields. Odin's zod
// schema still validates every call on the way in.
export function leanJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(leanJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => !LEAN_DROP.has(key))
    .map(([key, value]) => [key, key === 'properties'
      ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, leanJsonSchema(entry)]))
      : leanJsonSchema(value)]));
}

function jsonSchemaFor(schema) {
  return leanJsonSchema(zodToJsonSchema(schema, { $refStrategy: 'none', pipeStrategy: 'input', strictUnions: true }));
}

export function describeZodError(error) {
  return error.issues.slice(0, 6).map((issue) => {
    const path = issue.path.join('.') || 'input';
    if (issue.code === 'unrecognized_keys') return `${path}: unexpected field(s) ${issue.keys.join(', ')}`;
    if (issue.code === 'invalid_enum_value') return `${path}: must be one of ${issue.options.join(', ')}`;
    if (issue.code === 'invalid_type' && issue.received === 'undefined') return `${path}: required`;
    return `${path}: ${issue.message}`;
  }).join('; ');
}

const firstSentence = (text = '') => String(text).split(/(?<=\.)\s/)[0].slice(0, 220);
const humanize = (name) => name.replace(/^odin_/, '').replace(/_/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase());
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// A short line for the activity log, written for people rather than developers.
export function toolActivityLabel(name, args = {}, result = null) {
  const ok = result && result.ok !== false;
  switch (name) {
    case 'odin_project_overview': return 'Read the project overview';
    case 'odin_find_items': return ok && Number.isFinite(result.total) ? `Found ${plural(result.total, 'item')}${args.text ? ` matching "${args.text}"` : ''}` : 'Searched work items';
    case 'odin_list_items': return ok && Number.isFinite(result.total) ? `Listed ${plural(result.total, 'item')}` : 'Listed work items';
    case 'odin_get_item': return ok && result.item?.name ? `Read "${result.item.name}"` : 'Read a work item';
    case 'odin_create_plan_items': return result?.created ? `Created ${plural(result.created.length, 'item')}` : 'Create work items';
    case 'odin_update_items': return result?.results ? `Updated ${plural(result.results.filter((entry) => entry.ok).length, 'item')}` : `Update ${plural(args.updates?.length ?? 0, 'item')}`;
    case 'odin_create_item': return ok && result.item?.name ? `Created "${result.item.name}"` : 'Create a work item';
    case 'odin_update_item': return ok && result.item?.name ? `Updated "${result.item.name}"` : 'Update a work item';
    case 'odin_delete_item': return 'Delete a work item';
    case 'odin_add_comment': return ok ? 'Added a comment' : 'Add a comment';
    case 'odin_add_project_resource': return ok && result.resource?.name ? (result.added ? `Added ${result.resource.name} to the project team` : `${result.resource.name} was already on the project team`) :`Add ${args.input?.name ?? 'a person'} to the project team`;
    case 'odin_list_tickets': return ok ? `Found ${plural(result.tickets?.length ?? 0, 'ticket')}` : 'Searched tickets';
    case 'odin_search': return `Searched Odin for "${args.query ?? ''}"`;
    case 'odin_query': return ok && Number.isFinite(result?.rowCount) ? `Ran a query (${plural(result.rowCount, 'row')})` : ok ? 'Ran a query' : 'Run a query';
    case 'odin_undo_turn': return ok ? 'Undid earlier changes' : 'Undo earlier changes';
    case 'odin_operations': return args.query ? `Looked up tools for "${args.query}"` : 'Looked up available tools';
    case 'odin_describe': return `Read how to use ${humanize(String(args.operation ?? 'a tool')).toLowerCase()}`;
    case 'update_plan': return 'Updated the plan';
    case 'web_search': return args.query ? `Searched the web for "${args.query}"` : 'Searched the web';
    default: return humanize(name);
  }
}

const PROGRESS_VERBS = {
  activate: 'Activating', add: 'Adding', assign: 'Assigning', check: 'Checking', complete: 'Completing', create: 'Creating',
  delete: 'Deleting', describe: 'Reading', dismiss: 'Dismissing', extend: 'Extending', find: 'Finding', get: 'Reading',
  link: 'Linking', list: 'Listing', move: 'Moving', preview: 'Previewing', publish: 'Publishing', record: 'Recording',
  remember: 'Remembering', reopen: 'Reopening', reorder: 'Reordering', revoke: 'Revoking', search: 'Searching',
  send: 'Sending', unlink: 'Unlinking', update: 'Updating',
};

// What a tool is doing while it runs, for the working indicator ("Searching work items").
export function toolProgressLabel(name, args = {}) {
  switch (name) {
    case 'odin_project_overview': return 'Reading the project overview';
    case 'odin_find_items': return `Searching work items${args.text ? ` for "${args.text}"` : ''}`;
    case 'odin_get_item': return 'Reading a work item';
    case 'odin_create_plan_items': return 'Creating work items';
    case 'odin_update_items': return `Updating ${plural(args.updates?.length ?? 1, 'item')}`;
    case 'odin_search': return `Searching Odin for "${args.query ?? ''}"`;
    case 'odin_get_my_work': return 'Reading your work';
    case 'odin_operations': return 'Looking up tools';
    case 'odin_query': return 'Querying Odin data';
    case 'odin_undo_turn': return 'Undoing earlier changes';
    case 'odin_describe': return `Reading how to use ${humanize(String(args.operation ?? 'a tool')).toLowerCase()}`;
    case 'web_search': return 'Searching the web';
    default: {
      const [verb, ...rest] = name.replace(/^odin_/, '').split('_');
      return PROGRESS_VERBS[verb] ? `${PROGRESS_VERBS[verb]} ${rest.join(' ')}`.trim() : `Working on ${humanize(name).toLowerCase()}`;
    }
  }
}

// A bulk update told by what it changes ("targetEndDate on 52 items"), with an example patch.
// As raw JSON, its ids and the first few patches said little about the whole call.
function describeUpdates(updates = []) {
  const counts = new Map();
  const count = (field) => counts.set(field, (counts.get(field) ?? 0) + 1);
  for (const update of updates) {
    for (const field of Object.keys(update.patch ?? {})) count(field);
    if (update.parentId) count('parent');
    if (update.position !== undefined) count('position');
  }
  const example = JSON.stringify(updates[0]?.patch ?? {});
  return `sets ${[...counts].map(([field, items]) => `${field} on ${plural(items, 'item')}`).join(', ')}; for example ${example.length > 300 ? `${example.slice(0, 300)}…` : example}`;
}

// Long text shortened field by field, so every field a call sets stays in view: a project
// update's description filled the first 700 characters, and the dates after it went unseen.
function shortened(value) {
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 120)}… (${value.length} characters)` : value;
  if (Array.isArray(value)) return value.map(shortened);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shortened(entry)]));
  return value;
}

// The text a person (and the write check) sees for a proposed call.
export function describeCall(name, args = {}) {
  if (name === 'odin_update_items' && Array.isArray(args?.updates)) return `${toolActivityLabel(name, args)} (${name}: ${describeUpdates(args.updates)})`;
  const shown = JSON.stringify(shortened(args ?? {}));
  return `${toolActivityLabel(name, args)} (${name}${shown && shown !== '{}' ? ` ${shown.length > 700 ? `${shown.slice(0, 700)}…` : shown}` : ''})`;
}

export function truncateOutput(value, maxChars = 24000) {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return JSON.stringify({ truncated: true, note: 'The result was too large and was cut off. Narrow the query (filters, limit, a specific id) for complete data.', partial: text.slice(0, maxChars - 300) });
}

// Numbers outside a field's range (a limit of 60 where 50 is the most) are brought to the nearest
// allowed value rather than failing the call. Returns null when other problems remain.
export function clampOutOfRangeNumbers(args, error) {
  const issues = error?.issues ?? [];
  if (!issues.length || !issues.every((issue) => ['too_big', 'too_small'].includes(issue.code) && issue.type === 'number' && issue.path.length)) return null;
  const next = structuredClone(args);
  for (const issue of issues) {
    let target = next;
    for (const key of issue.path.slice(0, -1)) target = target?.[key];
    if (!target || typeof target !== 'object') return null;
    target[issue.path.at(-1)] = issue.code === 'too_big' ? issue.maximum : issue.minimum;
  }
  return next;
}

function flattenTree(project = {}) {
  return (project.epics ?? []).flatMap((epic) => [epic, ...(epic.stories ?? []).flatMap((story) => [story, ...(story.tasks ?? [])])]);
}

// Versions and other preconditions the model would otherwise have to read first.
const ARGUMENT_REPAIRS = {
  async odin_update_item(args, api) {
    if (args.input?.expectedVersion) return args;
    const { project } = await api.request('GET', `/api/projects/${encodeURIComponent(args.projectId)}`);
    const item = flattenTree(project).find((entry) => entry.id === args.itemId);
    return item ? { ...args, input: { ...args.input, expectedVersion: Number(item.version) } } : args;
  },
  async odin_delete_item(args, api) {
    if (args.expectedVersion) return args;
    const { project } = await api.request('GET', `/api/projects/${encodeURIComponent(args.projectId)}`);
    const item = flattenTree(project).find((entry) => entry.id === args.itemId);
    return item ? { ...args, expectedVersion: Number(item.version) } : args;
  },
  async odin_update_project(args, api) {
    if (args.input?.expectedUpdatedAt) return args;
    const { project } = await api.request('GET', `/api/projects/${encodeURIComponent(args.projectId)}`);
    return { ...args, input: { name: project.name, description: project.description ?? '', status: project.status, startDate: project.startDate ?? null, endDate: project.endDate ?? null, ...args.input, expectedUpdatedAt: project.updatedAt } };
  },
  async odin_update_project_brief(args, api) {
    if (args.input && 'expectedUpdatedAt' in args.input) return args;
    const { project } = await api.request('GET', `/api/projects/${encodeURIComponent(args.projectId)}`);
    return { ...args, input: { ...args.input, expectedUpdatedAt: project.assistantState?.updatedAt ?? null } };
  },
};

// Failures worth one automatic retry: nothing was written, or it was only a read.
function isTransient(error, write) {
  if (!(error instanceof OdinApiError) || error.outcomeUnknown) return false;
  if (error.status === 429) return true;
  return !write && (error.code === 'timeout' || error.code === 'network_error' || Number(error.status) >= 500);
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

const LOCAL_TOOLS = {
  update_plan: {
    description: 'Show the user your plan for a multi-step request as a short checklist, and keep it current as you work. Use it before starting work that needs several steps; skip it for simple requests. Each step is one task; a plan with more steps gives you a larger tool-call budget for this turn.',
    schema: z.object({
      steps: z.array(z.object({
        title: z.string().trim().min(1).max(200),
        status: z.preprocess((value) => (value === 'completed' ? 'done' : value), z.enum(['pending', 'in_progress', 'done', 'skipped']).default('pending')),
      }).strict()).min(1).max(12),
    }).strict(),
  },
  odin_query: {
    description: [
      'Run one read-only SQL query (SQLite) over Odin data: counts, totals, groupings, comparisons, joins, and items matching any combination of fields, exact and in one call.',
      'Use it instead of fetching many records and counting or comparing them yourself. Tables (dates are YYYY-MM-DD text, so date(\'now\') and julianday() work):',
      querySchemaText(),
      'It covers this chat\'s project by default (every project you can see, in a chat without one); set allProjects for all of them, or projectIds for some.',
      'Returns up to 200 rows. Link items from the results as [name](odin://item/<id>).',
    ].join('\n'),
    schema: z.object({
      sql: z.string().trim().min(1).max(8000),
      allProjects: z.boolean().optional(),
      projectIds: z.array(z.string().trim().min(1)).max(40).optional(),
    }).strict(),
  },
  odin_undo_turn: {
    description: 'Undo the changes you made in an earlier reply in this chat: by default the most recent reply that changed something, or the reply with replyId. Anything changed since by anyone is left as it is. Use it when the user asks to undo or revert what you did, then tell them what was and was not undone.',
    schema: z.object({ replyId: z.string().trim().min(1).max(80).optional() }).strict(),
  },
  odin_operations: {
    description: 'Find Odin operations beyond your first-class tools: boards, sprints, workflows, requirements and clarifications, review rounds, stakeholders and invitations, project members, channels and their guests, team and allocations, tickets, risks and issues, schedule analysis, insights, item history and more. Returns matching operation names with one-line descriptions. Then use odin_describe for an operation\'s inputs and odin_run to run it.',
    schema: z.object({ query: z.string().trim().max(200).optional(), limit: z.number().int().min(1).max(60).default(15) }).strict(),
  },
  odin_describe: {
    description: 'Read the full description and exact input schema of an Odin operation before running it with odin_run.',
    schema: z.object({ operation: z.string().trim().min(1).max(80) }).strict(),
  },
  odin_run: {
    description: 'Run an Odin operation found with odin_operations, passing its inputs as args. It runs as the user, exactly like their own edit; deletes and emails ask the user to confirm first.',
    schema: z.object({ operation: z.string().trim().min(1).max(80), args: z.record(z.any()).default({}) }).strict(),
  },
};

// recorder: the turn's change recorder (labels for writes it does not reverse); undoTurn: undoes an
// earlier reply's changes, supplied by the chat service.
// `allow`, when given, is the only tools (catalog operations and the assistant's own) a turn may
// see or run: a filtered view of the same catalog, such as the read-only set a guest's turn gets
// in a channel. Anything outside it is unknown to the model and refused if called.
export function createAgentToolbox({ allow = null, api, projectId = null, recorder = null, undoTurn = null }) {
  const allowed = allow ? new Set(allow) : null;
  const permitted = (name) => !allowed || allowed.has(name);
  const localTool = (name) => (Object.hasOwn(LOCAL_TOOLS, name) && permitted(name) ? LOCAL_TOOLS[name] : null);
  const catalog = createOdinToolCatalog({ api, extended: true }).filter((entry) => permitted(entry.name));
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  const definitions = new Map();
  const query = createOdinQuery({ api, projectId });
  const ids = createIdRepair({
    loadProjectIds: async (id) => flattenTree((await api.request('GET', `/api/projects/${encodeURIComponent(id)}`)).project).map((item) => item.id),
    projectId,
  });
  let relevance = new Map();

  const operationNames = () => catalog.map((entry) => entry.name).filter((name) => !CORE_TOOL_NAMES.includes(name));
  const summaryOf = (name) => byName.get(name).purpose ?? firstSentence(byName.get(name).description);

  function definition(name) {
    if (!definitions.has(name)) {
      const local = localTool(name);
      const entry = local ?? byName.get(name);
      if (!entry) throw new TypeError(`Unknown assistant tool ${name}.`);
      definitions.set(name, { description: entry.description, name, parameters: jsonSchemaFor(entry.schema), strict: false, type: 'function' });
    }
    return definitions.get(name);
  }

  function searchOperations({ limit = 15, query = '' } = {}) {
    const terms = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
    return operationNames()
      .map((name) => {
        const entry = byName.get(name);
        const haystack = `${name.replace(/_/g, ' ')} ${entry.purpose ?? ''} ${entry.description}`.toLowerCase();
        const keyword = terms.reduce((score, term) => score + (name.includes(term) ? 3 : 0) + (haystack.includes(term) ? 1 : 0), 0);
        return { entry, name, score: keyword + (relevance.get(name) ?? 0) * 5 };
      })
      .filter((row) => !terms.length || row.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, limit)
      .map(({ entry, name }) => ({ confirms: alwaysConfirms(name), name, summary: summaryOf(name), writes: entry.write }));
  }

  // Resolves a model call to the operation it really runs (odin_run names its operation).
  function resolve(name, rawArgs) {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    if (name === 'odin_run') {
      const operation = String(args.operation ?? '').trim();
      const inner = args.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args : {};
      return { args: inner, local: false, name: operation, viaRun: true, write: Boolean(byName.get(operation)?.write) };
    }
    if (localTool(name)) return { args, local: true, name, viaRun: false, write: name === 'odin_undo_turn' };
    return { args, local: false, name, viaRun: false, write: Boolean(byName.get(name)?.write) };
  }

  async function runLocal(name, args) {
    const parsed = localTool(name).schema.safeParse(args);
    if (!parsed.success) return { result: { ok: false, error: { code: 'validation_error', message: describeZodError(parsed.error) } } };
    if (name === 'odin_operations') return { result: { ok: true, operations: searchOperations(parsed.data), note: 'Use odin_describe for inputs, then odin_run.' } };
    if (name === 'odin_undo_turn') {
      if (!undoTurn) return { args: parsed.data, result: { ok: false, error: { code: 'unavailable', message: 'Undo is not available here.' } } };
      const result = await undoTurn(parsed.data);
      if (result?.ok) query.invalidate();
      return { args: parsed.data, result, write: true };
    }
    if (name === 'odin_query') {
      try {
        return { args: parsed.data, result: await query.run(parsed.data) };
      } catch (error) {
        return { args: parsed.data, result: { ok: false, error: { code: error.code ?? 'query_error', message: error instanceof OdinApiError ? error.message : 'The data for the query could not be loaded.' } } };
      }
    }
    if (name === 'odin_describe') {
      const entry = byName.get(parsed.data.operation);
      if (!entry) return { result: { ok: false, error: { code: 'unknown_operation', message: `No operation named ${parsed.data.operation}. Use odin_operations to find one.` } } };
      return { result: { ok: true, operation: entry.name, description: entry.description, writes: entry.write, confirms: alwaysConfirms(entry.name), inputSchema: jsonSchemaFor(entry.schema) } };
    }
    return { args: parsed.data, result: { ok: true } };
  }

  // Runs a resolved operation as the user: fills the project and versions, validates with
  // Odin's schema, and retries once on a transient failure.
  async function runOperation(name, rawArgs) {
    if (localTool(name)) return runLocal(name, rawArgs);
    const entry = byName.get(name);
    if (!entry) {
      const suggestions = searchOperations({ limit: 3, query: name.replace(/^odin_/, '').replace(/_/g, ' ') }).map((row) => row.name);
      return { result: { ok: false, error: { code: 'unknown_operation', message: `There is no operation named ${name || '(empty)'}.${suggestions.length ? ` Did you mean ${suggestions.join(', ')}?` : ' Use odin_operations to find one.'}` } } };
    }
    let args = { ...rawArgs };
    if (projectId && !args.projectId && entry.schema.shape?.projectId) args.projectId = projectId;
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (ARGUMENT_REPAIRS[name]) args = await ARGUMENT_REPAIRS[name](args, api);
        let parsed = entry.schema.safeParse(args);
        const clamped = parsed.success ? null : clampOutOfRangeNumbers(args, parsed.error);
        if (clamped) parsed = entry.schema.safeParse(clamped);
        if (!parsed.success) return { args, result: { ok: false, error: { code: 'validation_error', message: describeZodError(parsed.error) } }, write: entry.write };
        recorder?.setContext({ label: toolActivityLabel(name, parsed.data) });
        const result = await entry.handler(parsed.data);
        // Queries in the rest of the turn read fresh data after a change.
        if (entry.write && result?.ok !== false && !parsed.data.dryRun) query.invalidate();
        return { args: parsed.data, result, write: entry.write };
      } catch (error) {
        if (attempt === 0 && isTransient(error, entry.write)) { await wait(error.status === 429 ? 1500 : 600); continue; }
        const message = error instanceof OdinApiError ? error.message : 'The operation could not complete.';
        return {
          args,
          result: { ok: false, error: { code: error.code ?? 'tool_error', status: error.status ?? null, message, ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}), ...(error.details ? { details: error.details } : {}) } },
          write: entry.write,
        };
      }
    }
  }

  // Plain words for what an action touches: the item, milestone or people behind its ids. The
  // confirmation card shows it, and the write check reads it; given only ids, the check held
  // linking the launch milestone to its cutover story (0.02 against 0.82 with names).
  async function describeTarget(name, args = {}) {
    const parts = [];
    const projectPath = args.projectId ? `/api/projects/${encodeURIComponent(args.projectId)}` : null;
    try {
      const itemId = args.itemId ?? args.input?.itemId;
      const linkedIds = [args.fromItemId, args.toItemId, args.input?.workItemId, args.patch?.workItemId, args.input?.predecessorId, args.input?.successorId].filter(Boolean);
      const updatedIds = Array.isArray(args.updates) ? args.updates.map((update) => update.itemId) : [];
      if (projectPath && (itemId || linkedIds.length || updatedIds.length)) {
        const { project } = await api.request('GET', projectPath);
        const rows = new Map(flattenTree(project).map((item) => [item.id, item]));
        const typeOf = (item) => (item.stories ? 'epic' : item.tasks ? 'story' : 'task');
        // A ticket nobody has validated is named only by kind: this text also reaches the write check (D-027).
        const tickets = new Map((project.tickets ?? []).map((ticket) => [ticket.id, isTicketVisibleToAssistant(ticket) ? `ticket "${ticket.name}"` : 'an external ticket awaiting review']));
        const named = (id) => (rows.has(id) ? `${typeOf(rows.get(id))} "${rows.get(id).name}"` : tickets.get(id) ?? null);
        const item = rows.get(itemId);
        if (!item && tickets.has(itemId)) parts.push(tickets.get(itemId));
        if (item) {
          const itemType = typeOf(item);
          const children = itemType === 'epic' ? item.stories.length : itemType === 'story' ? item.tasks.length : 0;
          const childWord = itemType === 'epic' ? (children === 1 ? 'story' : 'stories') : (children === 1 ? 'task' : 'tasks');
          parts.push(`${itemType} "${item.name}"${children ? ` and its ${children} ${childWord}` : ''}`);
        }
        const linked = linkedIds.map(named).filter(Boolean);
        if (linked.length) parts.push(linked.join(' and '));
        const updated = updatedIds.map(named).filter(Boolean);
        if (updated.length) parts.push(`${updated.slice(0, 3).join(', ')}${updated.length > 3 ? ` and ${updated.length - 3} more` : ''}`);
      }
      // An access link goes to the person's email: the card says whose, and where.
      if (name === 'odin_send_task_access_link' && args.projectId && args.resourceId) {
        const { entries = [] } = await api.request('GET', `/api/resource-planning/projects/${encodeURIComponent(args.projectId)}/task-access`);
        const person = entries.find((entry) => entry.resourceId === args.resourceId);
        if (person) parts.push(`emails ${person.name}${person.email ? ` at ${person.email}` : ''}`);
      }
      if (projectPath && args.milestoneId) {
        const milestone = ((await api.request('GET', `${projectPath}/governance`)).milestones ?? []).find((entry) => entry.id === args.milestoneId);
        if (milestone) parts.push(`milestone "${milestone.title}" (target ${String(milestone.targetDate).slice(0, 10)})`);
      }
      // Moving a file: which file, where to, and how many guests from outside the team would see it.
      if (name === 'odin_move_file' && projectPath && args.fileId) {
        const [{ files = [] }, tree] = await Promise.all([
          api.request('GET', `${projectPath}/files`, { query: { agentView: 1, targetId: args.projectId, targetType: 'project' } }),
          api.request('GET', `${projectPath}/file-tree`),
        ]);
        const file = files.find((entry) => entry.id === args.fileId);
        const channel = (tree.channels ?? []).find((entry) => `/${entry.name}`.toLowerCase() === `/${String(args.toPath ?? '').split('/').filter(Boolean)[0] ?? ''}`.toLowerCase().replace(/^\/#/, '/'));
        parts.push(`${file ? `file "${file.fileName}"` : 'a file'} to ${args.toPath}${channel?.guestCount ? `, where ${plural(channel.guestCount, 'guest')} from outside the team will see it` : ''}`);
      }
      if (name === 'odin_delete_folder' && args.path) parts.push(`folder ${args.path}`);
      // Channel guests: who, which channel, and that an invitation is emailed.
      if ((name === 'odin_invite_channel_guest' || name === 'odin_remove_channel_guest') && projectPath && args.channelId) {
        const { channels = [] } = await api.request('GET', `${projectPath}/channels`);
        const channel = channels.find((entry) => entry.id === args.channelId);
        const where = channel ? `#${channel.name}` : 'a channel';
        if (name === 'odin_invite_channel_guest') {
          parts.push(`invites ${args.name ? `${args.name} (${args.email})` : args.email} to ${where} as a guest`, `emails ${args.email} an invitation`);
        } else {
          const { guests = [] } = await api.request('GET', `${projectPath}/channels/${encodeURIComponent(args.channelId)}/guests`);
          const guest = guests.find((entry) => entry.stakeholderId === args.stakeholderId);
          parts.push(`removes ${guest ? `${guest.name} (${guest.email})` : 'a guest'} from ${where}`);
        }
      }
    } catch {
      // The action is still shown, without names.
    }
    const recipients = args.expectedInvitationRecipients ?? args.input?.expectedInvitationRecipients ?? args.recipients ?? args.input?.recipients;
    if (Array.isArray(recipients) && recipients.length) {
      parts.push(`emails ${recipients.map((entry) => (typeof entry === 'string' ? entry : entry.email ?? entry.name ?? '')).filter(Boolean).join(', ')}`);
    }
    if (name === 'odin_update_project_members' && args.input?.remove?.length) parts.push(`removes ${args.input.remove.length} member${args.input.remove.length === 1 ? '' : 's'}`);
    return parts.join('; ');
  }

  return {
    catalog,
    definition,
    describeTarget,
    describe: (name) => byName.get(name) ?? null,
    // First-class tools: always the same set, so the tool list stays in the cached prompt prefix.
    // Operations that look relevant to a turn are described in the turn's notes instead (brief).
    toolNames: () => CORE_TOOL_NAMES.filter((name) => byName.has(name)),
    localToolNames: () => Object.keys(LOCAL_TOOLS).filter(permitted),
    // Candidates for triage to score: everything beyond the core tools and what they cover.
    operations: () => operationNames().filter((name) => !COVERED_BY_CORE.has(name)).map((name) => ({ name, summary: summaryOf(name), write: Boolean(byName.get(name).write) })),
    // Promoted operations with their inputs, so the model can call them with odin_run directly.
    brief: (names = []) => names.filter((name) => byName.has(name)).map((name) => ({ confirms: alwaysConfirms(name), inputs: jsonSchemaFor(byName.get(name).schema), name, purpose: summaryOf(name), writes: Boolean(byName.get(name).write) })),
    keywordPromotions(message = '') {
      const names = KEYWORD_GROUPS.filter((group) => group.pattern.test(message)).flatMap((group) => group.operations);
      return [...new Set(names)].filter((name) => byName.has(name)).slice(0, 4);
    },
    setRelevance(entries = []) { relevance = new Map(entries.map((entry) => [entry.name, Number(entry.probability) || 0])); },
    resolve,
    // Ids the model garbled, corrected before a call runs and in the reply (agent-ids.js).
    // Failed results are not learned from: they echo the garbled ids back.
    learnIds(input = []) {
      for (const item of input) if (item?.role === 'user' || item?.role === 'developer') ids.learn(item.content);
    },
    async repairIds(resolved) {
      const { corrected, value } = await ids.repair(resolved.args, { callProjectId: resolved.args?.projectId });
      return corrected.length ? { ...resolved, args: value, corrected } : resolved;
    },
    repairText: async (text) => (await ids.repair(text)).value,
    async run(name, args) {
      const outcome = await runOperation(name, args);
      if (outcome.result?.ok !== false) ids.learn(splitMedia(outcome.result).result);
      return outcome;
    },
  };
}
