import { randomUUID } from 'node:crypto';

// A project archive keeps its records' ids, so importing it back restores the same project.
// Ids are unique across the whole server, not per workspace, so an archive whose records
// already exist in another workspace (an export from one workspace imported into another on
// the same server) is imported as a copy: every record gets a new id.

function collectTaskIds(project) {
  const ids = [];
  const walk = (task) => {
    if (task?.id) ids.push(task.id);
    for (const child of task?.stories ?? []) walk(child);
    for (const child of task?.tasks ?? []) walk(child);
  };
  for (const epic of project?.epics ?? []) walk(epic);
  return ids;
}

const idsOf = (rows) => (Array.isArray(rows) ? rows : []).map((row) => row?.id);

/** The ids of the records an archive creates, by record type. */
export function archiveRecordIds(archiveData = {}) {
  const entries = [
    ['project', [archiveData?.project?.id]],
    ['project_user', idsOf(archiveData?.projectUsers)],
    ['task', collectTaskIds(archiveData?.project)],
    ['task_log', idsOf(archiveData?.taskLogs)],
    ['sprint', idsOf(archiveData?.sprints)],
    ['sprint_staffing', idsOf(archiveData?.sprintStaffing)],
    ['comment', idsOf(archiveData?.comments)],
    ['comment_vote', idsOf(archiveData?.commentVotes)],
    ['file', idsOf(archiveData?.files)],
    ['preference', idsOf(archiveData?.preferences)],
    ['stakeholder', [...idsOf(archiveData?.stakeholders), ...idsOf(archiveData?.assistantProjectState?.stakeholders)]],
    ['clarification', idsOf(archiveData?.clarifications)],
    ['clarification_assignment', idsOf(archiveData?.clarificationAssignments)],
    ['clarification_comment', idsOf(archiveData?.clarificationComments)],
    ['clarification_reaction', idsOf(archiveData?.clarificationCommentReactions)],
    ['clarification_invitation', idsOf(archiveData?.clarificationInvitations)],
    ['clarification_email_message', idsOf(archiveData?.clarificationEmailMessages)],
    ['summary', idsOf(archiveData?.summaryDocuments)],
  ];
  return new Map(entries.map(([type, ids]) => [type, [...new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean))]]));
}

// Tokens that open a stakeholder's portal or route an emailed reply. They are unique across the
// server, and a copy must not share them with the original.
function archiveTokens(archiveData = {}) {
  const tokens = [];
  for (const stakeholder of [...(archiveData?.stakeholders ?? []), ...(archiveData?.assistantProjectState?.stakeholders ?? [])]) {
    tokens.push(stakeholder?.access_token, stakeholder?.accessToken);
  }
  for (const invitation of archiveData?.clarificationInvitations ?? []) {
    tokens.push(invitation?.invitation_token, invitation?.invitationToken, invitation?.reply_token, invitation?.replyToken);
  }
  return [...new Set(tokens.map((token) => String(token ?? '').trim()).filter(Boolean))];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Ids and tokens this long can't turn up by chance inside other text, so they are also replaced
// where text mentions them, such as a link to a work item in a description. Shorter ones are
// replaced only where a value is exactly the id.
const MIN_EMBEDDED_LENGTH = 16;

/**
 * Gives every record in the archive a new id, and every stakeholder and invitation a new token.
 * References anywhere in the archive follow, including ids inside text and object keys. Users
 * are left alone: they are mapped separately. Returns the rewritten archive and the vault file
 * contents keyed by the new file ids.
 */
export function copyArchiveWithNewIds({ archiveData, vaultFiles = new Map() }) {
  const replacements = new Map();
  for (const ids of archiveRecordIds(archiveData).values()) {
    for (const id of ids) replacements.set(id, randomUUID());
  }
  for (const token of archiveTokens(archiveData)) replacements.set(token, randomUUID().replace(/-/g, ''));

  const embedded = [...replacements.keys()].filter((value) => value.length >= MIN_EMBEDDED_LENGTH);
  // Longest first, so an id that contains another is replaced whole.
  embedded.sort((left, right) => right.length - left.length);
  const pattern = embedded.length ? new RegExp(embedded.map(escapeRegex).join('|'), 'g') : null;
  const rewriteString = (value) => {
    if (replacements.has(value)) return replacements.get(value);
    return pattern ? value.replace(pattern, (match) => replacements.get(match)) : value;
  };
  const rewrite = (value) => {
    if (typeof value === 'string') return rewriteString(value);
    if (Array.isArray(value)) return value.map(rewrite);
    const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [rewriteString(key), rewrite(entry)]));
    }
    return value;
  };

  return {
    archiveData: rewrite(archiveData),
    vaultFiles: new Map([...vaultFiles].map(([id, bytes]) => [replacements.get(id) ?? id, bytes])),
  };
}
