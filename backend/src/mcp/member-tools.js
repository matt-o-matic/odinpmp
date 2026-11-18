import { z } from 'zod';
import { OdinApiError } from './api-client.js';
import { hasDecisionRights } from '../lib/auth/decision-rights.js';
import { PROJECT_CAPABILITIES, hasProjectCapability } from '../lib/auth/project-capabilities.js';
import { projectPermissionUserSchema } from '../modules/projects/projects.schema.js';

// Project membership through the routes behind Odin's Permissions dialog. The native save
// replaces the whole member list, so the update tool reads the current list, applies the
// requested additions, role changes and removals, and sends every other member back
// unchanged, including allocation and bill rate, which these tools never return.

export const PROJECT_MEMBER_ROLES = projectPermissionUserSchema.shape.role.removeDefault().unwrap().options;

const ROLE_SUMMARIES = Object.freeze({
  admin: 'Everything a manager can do, plus managing project members and roles.',
  manager: 'Edits the plan and work items, collaborates, and has Requirements decision rights.',
  user: 'Collaborates on work items, comments, clarifications and files; cannot edit the plan.',
});

export const PROJECT_ROLES = Object.freeze(PROJECT_MEMBER_ROLES.map((role) => ({
  role,
  summary: ROLE_SUMMARIES[role] ?? '',
  capabilities: Object.values(PROJECT_CAPABILITIES).filter((capability) => hasProjectCapability({ capability, projectRole: role })),
  decisionRights: hasDecisionRights({ projectRole: role }),
})));

const byName = (left, right) => left.name.localeCompare(right.name) || left.userId.localeCompare(right.userId);

function remap(error, mapping) {
  if (error instanceof OdinApiError && mapping[error.status]) {
    const [code, message] = mapping[error.status];
    throw new OdinApiError(error.status, code, message, { outcomeUnknown: error.outcomeUnknown });
  }
  throw error;
}

/** Registers the project member tools on createOdinMcpServer's `tool` helper. */
export function registerMemberTools({ api, dryRun, id, page, pageShape, tool: register }) {
  const tool = (name, description, schema, handler, options) => register(name, description, schema, async (args) => JSON.parse(JSON.stringify(await handler(args))), options);
  const projectPath = (projectId) => `/api/projects/${encodeURIComponent(projectId)}`;

  async function readMembership(projectId) {
    try {
      const valid = await api.request('GET', `${projectPath(projectId)}/valid-users`);
      return { members: valid.project_users ?? [], tenantUsers: valid.tenant_users ?? [] };
    } catch (error) {
      return remap(error, { 404: ['http_404', 'Project not found, or the user lacks the plan-edit permission needed to see project membership.'] });
    }
  }

  function presentMembers(members, tenantUsers) {
    const tenantRoles = new Map(tenantUsers.map((user) => [user.id, user.role ?? 'user']));
    return members
      .map((member) => ({ userId: member.id, name: member.name ?? '', email: member.email ?? '', role: member.role ?? 'user', tenantRole: tenantRoles.get(member.id) ?? null }))
      .sort(byName);
  }

  tool('odin_list_project_members', [
    'List a project\'s members (userId, name, email, project role, workspace role), the workspace users who could be added (candidates),',
    'and the assignable project roles with their Odin capabilities and whether they carry Requirements decision rights.',
    'Some older memberships hold other roles (such as viewer); they are shown as stored. tenantRole null means the member is no longer a workspace user.',
    'Workspace admins and managers reach every project without membership, and a workspace admin also has project admin rights.',
    'search matches name or email in both lists; limit and cursor page the candidates. Allocation and bill rates are not returned.',
    'Needs plan-edit permission. Use userId with odin_update_project_members or as a clarification owner.',
  ].join(' '), z.object({ projectId: id, search: z.string().trim().max(200).optional(), ...pageShape }).strict(), async (args) => {
    const { members, tenantUsers } = await readMembership(args.projectId);
    const term = args.search?.toLowerCase();
    const matches = (user) => !term || [user.name, user.email].some((value) => String(value ?? '').toLowerCase().includes(term));
    const memberIds = new Set(members.map((member) => member.id));
    const candidates = tenantUsers
      .filter((user) => !memberIds.has(user.id))
      .map((user) => ({ userId: user.id, name: user.name ?? '', email: user.email ?? '', tenantRole: user.role ?? 'user' }))
      .filter(matches)
      .sort(byName);
    const candidatePage = page(candidates, args, { tool: 'project_member_candidates', projectId: args.projectId, search: args.search });
    return {
      ok: true,
      projectId: args.projectId,
      members: presentMembers(members, tenantUsers).filter(matches),
      candidates: candidatePage.items,
      candidatesTotal: candidatePage.total,
      nextCursor: candidatePage.nextCursor,
      roles: PROJECT_ROLES,
    };
  }, { purpose: 'List the project\'s members and their access roles.' });

  const memberChange = z.object({ userId: id, role: z.enum(PROJECT_MEMBER_ROLES) }).strict();
  tool('odin_update_project_members', [
    'Add workspace users to a project, change members\' project roles, or remove members. upsert adds a user with the role or changes an existing member\'s role;',
    'remove takes members off the project. Every other member, and each kept member\'s allocation and bill rate, is sent back unchanged. Nothing is saved if a user',
    'is not in the workspace, a removed user is not a member, or the save would also change an unmentioned member (a role Odin\'s save cannot keep, such as',
    'viewer, or a member who left the workspace); details list them.',
    'Needs project admin rights. No version precondition: the list is read and',
    'replaced, so concurrent membership edits are last-writer-wins. Removing yourself or your own admin role can end your access. Unchanged lists are not saved again.',
  ].join(' '), z.object({
    projectId: id,
    input: z.object({
      upsert: z.array(memberChange).max(100).default([]).describe('Users to add with a role, or members whose role changes.'),
      remove: z.array(id).max(100).default([]).describe('userIds of members to remove from the project.'),
    }).strict(),
    dryRun,
  }).strict(), async (args) => {
    const { remove, upsert } = args.input;
    const userIds = [...upsert.map((change) => change.userId), ...remove];
    if (!userIds.length) throw new OdinApiError(400, 'invalid_member_change', 'Provide upsert, remove, or both.');
    if (new Set(userIds).size !== userIds.length) throw new OdinApiError(400, 'invalid_member_change', 'Each user can appear once across upsert and remove.');
    const path = `${projectPath(args.projectId)}/permissions`;
    if (args.dryRun) {
      return { ok: true, dryRun: true, validation: 'schema_only', authorizationChecked: false, request: { method: 'PUT', path, change: { upsert, remove }, note: 'The saved member list is built from the current members when applied.' } };
    }

    const { members, tenantUsers } = await readMembership(args.projectId);
    const workspaceUserIds = new Set(tenantUsers.map((user) => user.id));
    const current = new Map(members.map((member) => [member.id, member]));
    const notInWorkspace = upsert.filter((change) => !workspaceUserIds.has(change.userId)).map((change) => change.userId);
    const notMembers = remove.filter((userId) => !current.has(userId));
    if (notInWorkspace.length || notMembers.length) {
      throw new OdinApiError(400, 'invalid_member_change', 'Nothing was saved: some users are not in the workspace or are not project members.', { details: { notInWorkspace, notMembers } });
    }

    const roleOf = (member) => member.role ?? 'user';
    const changes = {
      added: upsert.filter((change) => !current.has(change.userId)).map(({ role, userId }) => ({ userId, role })),
      roleChanged: upsert.filter((change) => current.has(change.userId) && roleOf(current.get(change.userId)) !== change.role)
        .map(({ role, userId }) => ({ userId, from: roleOf(current.get(userId)), to: role })),
      removed: remove.map((userId) => ({ userId, role: roleOf(current.get(userId)) })),
    };
    if (!changes.added.length && !changes.roleChanged.length && !changes.removed.length) {
      return { ok: true, changed: false, members: presentMembers(members, tenantUsers) };
    }
    // The native save rejects roles outside its list (older memberships can hold viewer, for
    // example) and, on MySQL, drops members who are no longer workspace users. Never change
    // a member the caller did not mention: they must be named in upsert or remove.
    const unmentioned = members.filter((member) => !userIds.includes(member.id));
    const unsupportedRoles = unmentioned.filter((member) => !PROJECT_MEMBER_ROLES.includes(roleOf(member))).map((member) => ({ userId: member.id, role: roleOf(member) }));
    const outsideWorkspace = unmentioned.filter((member) => !workspaceUserIds.has(member.id)).map((member) => ({ userId: member.id, role: roleOf(member) }));
    if (unsupportedRoles.length || outsideWorkspace.length) {
      throw new OdinApiError(409, 'members_need_explicit_change', `Nothing was saved: Odin's member save would also change members you did not mention. details.unsupportedRoles hold roles it cannot keep: give them ${PROJECT_MEMBER_ROLES.join(', ')} in upsert, or remove them. details.outsideWorkspace are no longer workspace users and would be dropped: add them to remove.`, { details: { outsideWorkspace, unsupportedRoles } });
    }

    const nextRole = new Map(upsert.map((change) => [change.userId, change.role]));
    const removing = new Set(remove);
    const validUsers = [
      ...members.filter((member) => !removing.has(member.id)).map((member) => ({
        id: member.id,
        project_allocation: member.project_allocation ?? null,
        project_bill_rate: member.project_bill_rate ?? null,
        role: nextRole.get(member.id) ?? roleOf(member),
      })),
      ...changes.added.map(({ role, userId }) => ({ id: userId, project_allocation: null, project_bill_rate: null, role })),
    ];
    try {
      const result = await api.request('PUT', path, { body: { validUsers } });
      return { ok: true, changed: true, changes, members: presentMembers(result.project_users ?? [], tenantUsers) };
    } catch (error) {
      return remap(error, {
        400: ['http_400', 'Odin rejected the member list. A kept member\'s saved allocation or bill rate may be outside Odin\'s limits; fix it in Odin\'s Permissions dialog.'],
        404: ['http_404', 'Project not found, or the user lacks the project admin rights needed to change membership.'],
      });
    }
  }, { write: true, destructive: true, purpose: 'Add people to the project, change their roles or remove them.', confirm: (args) => (args?.input?.remove ?? []).length > 0 });
}
