import { z } from 'zod';
import { OdinApiError } from './api-client.js';

// Review rounds and their reviewers through Odin's own routes: publish a draft package as a
// round with its reviewers, and add, remove or re-mark reviewers on an open round. A
// reviewer is a project member or a project stakeholder, as `{ actorType, actorId }`, the
// same person shape the clarification tools use.
//
// Odin emails each new reviewer an invitation as it saves, and a stakeholder's carries their
// portal link. Odin invites exactly the reviewers a request names (minus anyone already an
// active reviewer of the round), so these tools work out the recipients from the request and
// the round, and save only when the caller confirms exactly that set. Closing a round stays
// in Odin: a publish that would close the open round is outside every MCP grant.

const plain = (value) => JSON.parse(JSON.stringify(value));
const ref = (person) => `${person.actorType}:${person.actorId}`;
const DUE_REMINDER = 'reminderDaysBefore needs a due date.';

function remap(error, mapping) {
  if (error instanceof OdinApiError && mapping[error.status]) {
    const [code, message] = mapping[error.status];
    throw new OdinApiError(error.status, code, message, { outcomeUnknown: error.outcomeUnknown });
  }
  throw error;
}

function presentReviewer(reviewer) {
  return {
    reviewerId: reviewer.id,
    actorType: reviewer.actorType,
    actorId: reviewer.actorId,
    name: reviewer.name ?? '',
    email: reviewer.email ?? '',
    required: Boolean(reviewer.required),
    invitedAt: reviewer.invitedAt ?? null,
    invitationStatus: reviewer.mail?.status ?? null,
    lastSeenAt: reviewer.lastSeenAt ?? null,
    submittedAt: reviewer.submittedAt ?? null,
  };
}

/** A round detail from GET /rounds/:roundId or a publish/update result, with active reviewers only. */
export function presentRound(round) {
  if (!round) return null;
  return {
    id: round.id,
    number: round.number ?? null,
    track: round.track ?? null,
    status: round.status ?? null,
    title: round.title || round.package?.title || null,
    package: round.package ? { id: round.package.id, version: round.package.version, status: round.package.status } : null,
    dueAt: round.dueAt ?? null,
    reminderDaysBefore: round.reminder?.daysBefore ?? null,
    note: round.note ?? '',
    publishedAt: round.publishedAt ?? null,
    counts: round.counts ?? null,
    reviewers: (round.reviewers ?? []).filter((reviewer) => !reviewer.removedAt).map(presentReviewer),
  };
}

/** Registers the round reviewer tools on createOdinMcpServer's `tool` helper. */
export function registerRequirementsRoundTools({ api, dryRun, id, tool: register }) {
  const tool = (name, description, schema, handler, options) => register(name, description, schema, async (args) => plain(await handler(args)), options);
  const requirementsPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/requirements`;
  const roundsPath = (projectId) => `${requirementsPath(projectId)}/rounds`;
  const schemaOnly = (request) => ({ ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request });

  /** Names and emails for users and stakeholders, from the reads the member and stakeholder tools use. */
  async function readPeople(projectId) {
    const [state, valid] = await Promise.all([
      api.request('GET', `/api/assistant/projects/${encodeURIComponent(projectId)}/clarifications`),
      // Reading the workspace users needs plan-edit permission; without it, user names are left blank and Odin still checks access.
      api.request('GET', `/api/projects/${encodeURIComponent(projectId)}/valid-users`).catch((error) => {
        if (error instanceof OdinApiError && error.status === 404) return null;
        throw error;
      }),
    ]);
    const people = new Map();
    for (const stakeholder of state.stakeholders ?? state.stakeholderContacts ?? []) {
      people.set(`stakeholder:${stakeholder.id}`, { name: stakeholder.name ?? '', email: stakeholder.email ?? '' });
    }
    for (const user of [...(valid?.tenant_users ?? []), ...(valid?.project_users ?? [])]) {
      if (!people.has(`user:${user.id}`)) people.set(`user:${user.id}`, { name: user.name ?? '', email: user.email ?? '' });
    }
    return { people, usersKnown: Boolean(valid) };
  }

  async function readRound(projectId, roundId) {
    try {
      return (await api.request('GET', `${roundsPath(projectId)}/${encodeURIComponent(roundId)}`)).round;
    } catch (error) {
      return remap(error, { 404: ['round_not_found', 'Round not found in this project, or not accessible. Round ids come from odin_get_requirements_context (latestRound.id).'] });
    }
  }

  function recipient(person, people) {
    const known = people.get(ref(person));
    return { actorType: person.actorType, actorId: person.actorId, name: known?.name ?? '', email: known?.email ?? '' };
  }

  function unknownPeople(list, { people, usersKnown }) {
    return list
      .filter((person) => (person.actorType === 'stakeholder' || usersKnown) && !people.has(ref(person)))
      .map((person) => ({
        code: person.actorType === 'stakeholder' ? 'unknown_stakeholder' : 'unknown_user',
        actorType: person.actorType,
        actorId: person.actorId,
        message: person.actorType === 'stakeholder'
          ? 'Not one of this project\'s stakeholder contacts. Add them with odin_add_stakeholder first.'
          : 'Not a workspace user. Reviewers need member access or above on the project (odin_list_project_members).',
      }));
  }

  function duplicates(list) {
    const seen = new Set();
    return list.filter((person) => {
      if (seen.has(ref(person))) return true;
      seen.add(ref(person));
      return false;
    }).map((person) => ({ code: 'duplicate_reviewer', actorType: person.actorType, actorId: person.actorId, message: 'Each reviewer can be listed once.' }));
  }

  function requireConfirmed(expected, confirm) {
    const wanted = expected.map(ref);
    const given = new Set(confirm);
    if (wanted.length !== given.size || wanted.some((value) => !given.has(value))) {
      throw new OdinApiError(409, 'invitation_confirmation_required', wanted.length
        ? 'Saving this emails review invitations to the reviewers in details.invitationEmails. Nothing was saved. Pass exactly their refs as confirmInvitationEmails.'
        : 'Saving this emails nobody. Nothing was saved. Pass an empty confirmInvitationEmails list.', { details: { confirmInvitationEmails: wanted, invitationEmails: expected } });
    }
  }

  const person = z.object({
    actorType: z.enum(['user', 'stakeholder']).describe('user: an Odin workspace user (userId from odin_list_project_members) with member access or above. stakeholder: a project stakeholder contact (id from odin_list_stakeholders).'),
    actorId: id,
  }).strict();
  const reviewer = person.extend({ required: z.boolean().default(false).describe('Required reviewers are the ones the round waits for.') }).strict();
  const dueAt = z.string().trim().datetime({ offset: true }).describe('ISO 8601 with offset, in the future.');
  const reminderDaysBefore = z.number().int().min(1).max(30).describe('Email unsubmitted reviewers this many days before dueAt.');
  const confirmInvitationEmails = z.array(z.string().trim().regex(/^(?:user|stakeholder):[A-Za-z0-9_-]{1,120}$/, 'Use refs such as stakeholder:<id>.')).max(100).default([])
    .describe('Reviewer refs (stakeholder:<id> or user:<id>) this save may email, exactly as returned by the preview.');

  // --- Publishing ---------------------------------------------------------------------------

  const publishShape = {
    projectId: id,
    packageId: id.describe('A draft package: packages.latest.id from odin_get_requirements_context when its status is draft, or package.id from odin_get_package_status.'),
    reviewers: z.array(reviewer).min(1).max(100),
    dueAt: dueAt.optional(),
    reminderDaysBefore: reminderDaysBefore.optional(),
    note: z.string().trim().max(4000).optional().describe('Shown to reviewers with the round.'),
  };

  async function planPublish(args) {
    const path = requirementsPath(args.projectId);
    const [{ packages }, people] = await Promise.all([api.request('GET', `${path}/packages`), readPeople(args.projectId)]);
    const pkg = (packages ?? []).find((entry) => entry.id === args.packageId) ?? null;
    const problems = [...duplicates(args.reviewers), ...unknownPeople(args.reviewers, people)];
    let openRound = null;
    if (!pkg) problems.push({ code: 'package_not_found', message: 'No package with this id in this project. Read odin_get_requirements_context for the latest package.' });
    else if (pkg.status !== 'draft') problems.push({ code: 'package_not_draft', message: `Version ${pkg.version} is ${pkg.status}, not a draft. Only a draft can be published.` });
    if (pkg) {
      // Review is project-wide: one round open at a time across the project.
      const { rounds } = await api.request('GET', `${path}/rounds`);
      openRound = (rounds ?? []).find((round) => round.status === 'open') ?? null;
      if (openRound) problems.push({ code: 'round_open', roundId: openRound.id, message: `Round ${openRound.number} is still open. A person with decision rights closes it in Odin first; MCP cannot close rounds.` });
    }
    if (args.reminderDaysBefore && !args.dueAt) problems.push({ code: 'invalid_round', message: DUE_REMINDER });
    return {
      invitationEmails: args.reviewers.map((entry) => ({ ...recipient(entry, people.people), required: entry.required })),
      pkg,
      problems,
    };
  }

  tool('odin_preview_round_publish', [
    'Preview publishing a draft review package as a round, with its reviewers, without saving or emailing. Returns the package, problems',
    '(unknown stakeholder or user, a package that is not a draft, a round still open: review is one round at a time per project) and invitationEmails: every reviewer, each of whom Odin emails',
    'an invitation when the round is published (stakeholders get their Requirements portal link). Pass those refs as confirmInvitationEmails to odin_publish_round.',
    'Write permission is not checked here.',
  ].join(' '), z.object(publishShape).strict(), async (args) => {
    const plan = await planPublish(args);
    return {
      ok: true,
      preview: true,
      writePermissionChecked: false,
      package: plan.pkg ? { id: plan.pkg.id, version: plan.pkg.version, status: plan.pkg.status, track: plan.pkg.track, title: plan.pkg.title ?? null } : null,
      invitationEmails: plan.invitationEmails,
      confirmInvitationEmails: plan.invitationEmails.map(ref),
      problems: plan.problems,
      nextStep: plan.problems.length ? 'Fix the problems before publishing.' : 'To publish and email these reviewers, call odin_publish_round with the same arguments and confirmInvitationEmails set to these refs.',
    };
  });

  tool('odin_publish_round', [
    'Publish a draft review package as the project\'s next review round with its reviewers, as Publish does in Odin. Odin emails every reviewer an invitation at once',
    '(stakeholders get their Requirements portal link), creates topics for package questions without one, and carries open annotations forward.',
    'confirmInvitationEmails must list exactly the reviewer refs from odin_preview_round_publish; otherwise nothing is published. No other round may be open in the project:',
    'closing one records a round decision, which stays in Odin. Needs member access. Not idempotent: after outcomeUnknown, read odin_get_requirements_context before trying again.',
  ].join(' '), z.object({ ...publishShape, confirmInvitationEmails, dryRun }).strict(), async (args) => {
    const path = roundsPath(args.projectId);
    const body = {
      packageId: args.packageId,
      reviewers: args.reviewers,
      ...(args.dueAt ? { dueAt: args.dueAt } : {}),
      ...(args.reminderDaysBefore ? { reminder: { daysBefore: args.reminderDaysBefore } } : {}),
      ...(args.note ? { note: args.note } : {}),
    };
    if (args.dryRun) return schemaOnly({ method: 'POST', path, body, confirmInvitationEmails: args.confirmInvitationEmails });
    const plan = await planPublish(args);
    if (plan.problems.length) throw new OdinApiError(400, 'invalid_round', 'This round cannot be published. Nothing was saved or emailed.', { details: { problems: plan.problems } });
    requireConfirmed(plan.invitationEmails, args.confirmInvitationEmails);
    try {
      const result = await api.request('POST', path, { body });
      return {
        ok: true,
        round: presentRound(result.round),
        invitationEmails: plan.invitationEmails,
        createdTopicIds: result.createdTopicIds ?? [],
        carryForward: result.carryForward ?? null,
      };
    } catch (error) {
      return remap(error, {
        400: ['invalid_round', 'Odin rejected the round: each reviewer must be a project stakeholder or have member access, and dueAt must be in the future.'],
        404: ['http_404', 'Project or package not found, or the user lacks the member access needed to publish rounds.'],
        409: ['round_conflict', 'The package is no longer a draft, another round opened first, or a package question links to a missing topic. Nothing was published. Read odin_get_requirements_context again.'],
      });
    }
  }, { write: true, destructive: true, confirm: true });

  // --- Reviewers on an open round -----------------------------------------------------------

  const changeShape = {
    projectId: id,
    roundId: id.describe('An open round: latestRound.id from odin_get_requirements_context.'),
    addReviewers: z.array(reviewer).max(100).optional().describe('People to add. Anyone already reviewing is left as is; a removed reviewer is added back and invited again.'),
    removeReviewers: z.array(person).max(100).optional().describe('Reviewers to remove. Their feedback so far is kept.'),
    setRequired: z.array(person.extend({ required: z.boolean() }).strict()).max(100).optional().describe('Change whether current reviewers are required.'),
    dueAt: dueAt.nullable().optional().describe('New due date (ISO 8601 with offset, in the future), or null to clear it.'),
    reminderDaysBefore: reminderDaysBefore.nullable().optional(),
    note: z.string().trim().max(4000).optional(),
  };

  async function planChange(args) {
    const fields = ['addReviewers', 'removeReviewers', 'setRequired', 'dueAt', 'reminderDaysBefore', 'note'];
    if (fields.every((field) => args[field] === undefined)) throw new OdinApiError(400, 'invalid_round', `Provide at least one of ${fields.join(', ')}.`);
    const [round, people] = await Promise.all([readRound(args.projectId, args.roundId), readPeople(args.projectId)]);
    const active = new Map((round.reviewers ?? []).filter((entry) => !entry.removedAt).map((entry) => [ref(entry), entry]));
    const additions = args.addReviewers ?? [];
    const problems = [...duplicates(additions), ...unknownPeople(additions, people)];
    if (round.status !== 'open') problems.push({ code: 'round_closed', message: 'This round is closed. Its reviewers can no longer change.' });
    const reviewerIdOf = (entry, action) => {
      const current = active.get(ref(entry));
      if (!current) problems.push({ code: 'not_a_reviewer', actorType: entry.actorType, actorId: entry.actorId, message: `Not a current reviewer of this round, so it cannot be ${action}.` });
      return current?.id ?? null;
    };
    const removeReviewerIds = (args.removeReviewers ?? []).map((entry) => reviewerIdOf(entry, 'removed')).filter(Boolean);
    const updateReviewers = (args.setRequired ?? []).map((entry) => ({ id: reviewerIdOf(entry, 'changed'), required: entry.required })).filter((entry) => entry.id);
    const dueAfter = args.dueAt !== undefined ? args.dueAt : round.dueAt;
    const reminderAfter = args.reminderDaysBefore !== undefined ? args.reminderDaysBefore : round.reminder?.daysBefore ?? null;
    if (reminderAfter && !dueAfter) problems.push({ code: 'invalid_round', message: DUE_REMINDER });
    const invited = additions.filter((entry) => !active.has(ref(entry)));
    const body = {
      ...(additions.length ? { addReviewers: additions } : {}),
      ...(removeReviewerIds.length ? { removeReviewerIds } : {}),
      ...(updateReviewers.length ? { updateReviewers } : {}),
      ...(args.dueAt !== undefined ? { dueAt: args.dueAt } : {}),
      ...(args.reminderDaysBefore !== undefined ? { reminder: args.reminderDaysBefore === null ? null : { daysBefore: args.reminderDaysBefore } } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
    };
    return {
      body,
      invitationEmails: invited.map((entry) => ({ ...recipient(entry, people.people), required: entry.required })),
      problems,
      round,
      unchanged: additions.filter((entry) => active.has(ref(entry))).map((entry) => recipient(entry, people.people)),
    };
  }

  tool('odin_preview_round_reviewers', [
    'Preview a change to an open round\'s reviewers (add, remove, set required) or its due date, reminder or note, without saving or emailing.',
    'Returns the current reviewers, problems, and invitationEmails: the added people Odin will email an invitation (stakeholders get their portal link).',
    'People already reviewing are listed in alreadyReviewing and not emailed. Pass the refs as confirmInvitationEmails to odin_update_round_reviewers. Write permission is not checked here.',
  ].join(' '), z.object(changeShape).strict(), async (args) => {
    const plan = await planChange(args);
    return {
      ok: true,
      preview: true,
      writePermissionChecked: false,
      round: presentRound(plan.round),
      invitationEmails: plan.invitationEmails,
      confirmInvitationEmails: plan.invitationEmails.map(ref),
      alreadyReviewing: plan.unchanged,
      problems: plan.problems,
      nextStep: plan.problems.length ? 'Fix the problems before saving.' : 'To save, call odin_update_round_reviewers with the same arguments and confirmInvitationEmails set to these refs (empty when nobody is emailed).',
    };
  });

  tool('odin_update_round_reviewers', [
    'Change an open round\'s reviewers (add, remove, set required) or its due date, reminder or note, as Edit round does in Odin.',
    'Odin emails each newly added reviewer an invitation at once; a removed reviewer keeps the feedback they gave. confirmInvitationEmails must list exactly the refs from',
    'odin_preview_round_reviewers (empty when nobody new is added); otherwise nothing is saved. Needs member access. No version precondition.',
  ].join(' '), z.object({ ...changeShape, confirmInvitationEmails, dryRun }).strict(), async (args) => {
    const path = `${roundsPath(args.projectId)}/${encodeURIComponent(args.roundId)}`;
    if (args.dryRun) return schemaOnly({ method: 'PATCH', path, change: { addReviewers: args.addReviewers, removeReviewers: args.removeReviewers, setRequired: args.setRequired, dueAt: args.dueAt, reminderDaysBefore: args.reminderDaysBefore, note: args.note }, confirmInvitationEmails: args.confirmInvitationEmails, note: 'Reviewer ids are resolved from the round when applied.' });
    const plan = await planChange(args);
    if (plan.problems.length) throw new OdinApiError(400, 'invalid_round', 'This change cannot be saved. Nothing was saved or emailed.', { details: { problems: plan.problems } });
    requireConfirmed(plan.invitationEmails, args.confirmInvitationEmails);
    try {
      const result = await api.request('PATCH', path, { body: plan.body });
      return { ok: true, round: presentRound(result.round), invitationEmails: plan.invitationEmails };
    } catch (error) {
      return remap(error, {
        400: ['invalid_round', 'Odin rejected the change: each new reviewer must be a project stakeholder or have member access, and dueAt must be in the future.'],
        404: ['round_not_found', 'Round not found, or the user lacks the member access needed to change it.'],
        409: ['round_closed', 'This round was closed before the change was saved. Nothing was saved.'],
      });
    }
  }, { write: true, destructive: true, confirm: true });
}
