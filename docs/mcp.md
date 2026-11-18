# Odin MCP server

Odin exposes 151 tools through a hosted Streamable HTTP endpoint at `/mcp`. Clients connect to the server over HTTPS and authorize through Odin's existing login, MFA/SSO and tenant selection. Tool operations reuse Odin's HTTP routes, current project permissions, workflow rules, revisions, legal holds and notifications.

An optional stdio bridge remains available for existing clients. The hosted endpoint is the intended remote integration; the repository does not need to be present on the client's machine.

## Hosted setup

Use the existing Odin backend process and database. No separate MCP process or port is needed. Configure these variables on that backend before starting it through its normal entrypoint:

```dotenv
BACKEND_PUBLIC_URL=https://odin.example.com
MCP_PUBLIC_URL=https://odin.example.com/mcp
FRONTEND_APP_URL=https://odin.example.com/app
# Optional: exact browser client origins, comma separated. No wildcard.
MCP_ALLOWED_ORIGINS=https://client.example.com
```

These are example URLs; replace them with the intended server and client origins. `MCP_PUBLIC_URL` is opt-in, must use the `BACKEND_PUBLIC_URL` origin and the exact `/mcp` path, and requires HTTPS in production. HTTP loopback is accepted for local fixtures. Omitting it leaves the endpoint disabled. Keep the backend's existing database, signing secret and other runtime settings. Backend startup uses the persistent MySQL OAuth repository; its four `mcp_oauth_*` tables are created lazily through the repository's schema initialization. The database user needs that schema permission, or an administrator must provision the tables first using `ensureMysqlMcpOAuthSchema`.

The reverse proxy must forward `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` and `/api/mcp/` to the existing backend, preserving `Host` and `Authorization`. Serve the frontend's `/app/mcp/authorize` route through its existing SPA fallback. Use your configured frontend base path when it differs from `/app`. The transport is stateless and uses JSON HTTP responses; it does not require sticky sessions, a separate SSE listener or a long-lived server-side MCP session.

Set `MCP_PUBLIC_URL` (and `BACKEND_PUBLIC_URL` and `MCP_ALLOWED_ORIGINS` where they differ from the defaults) in the backend's environment.

### Connect ChatGPT or Codex

For a ChatGPT dot (a custom agent), create a personal cloud plugin:

1. In the ChatGPT account and workspace where the dot lives, open Settings → Security and login and enable Developer mode if needed.
2. Open Plugins and select the plus button to create an MCP connection.
3. Name it, for example `Odin`, and use your server's endpoint, such as `https://odin.example.com/mcp`.
4. Complete the OAuth connection through Odin's Google or usual sign-in and approve access.
5. Open the resulting personal plugin and install/enable it. Ask the dot to list Odin projects.

The desktop Settings → MCP servers form configures the local Codex host. That entry alone does not install a cloud plugin for a dot. For desktop Codex use, add the Streamable HTTP URL there, leave bearer-token and custom-header fields empty, save, restart and select Authenticate.

Odin's public HTTPS endpoint needs no local bridge or Secure MCP Tunnel. A tunnel supplies network access to a private server; it does not replace ChatGPT plugin installation or Odin OAuth consent. API Playground setup is also a separate testing surface. See the [ChatGPT plugin quickstart](https://developers.openai.com/plugins/quickstart), [dot connections](https://learn.chatgpt.com/docs/dots/computers-and-apps) and [MCP host configuration](https://learn.chatgpt.com/docs/extend/mcp).

### Connect Claude or Claude Code

In claude.ai, Claude Desktop or Claude mobile, open Customize → Connectors, select Add custom connector, and enter `https://odinpmp.com/mcp`. Leave the OAuth client ID and secret empty. Claude opens Odin's sign-in, then the consent page, and returns to `https://claude.ai/api/mcp/auth_callback`.

In Claude Code, run `claude mcp add --transport http odin https://odinpmp.com/mcp`, then `/mcp` in a session and choose Authenticate. Claude Code opens the browser and receives the code on a free local port; the consent page shows it as an application on this computer.

### How clients identify themselves

Odin accepts Client ID Metadata Documents (CIMD) hosted by OpenAI and Anthropic. Current ChatGPT, Codex, Claude and Claude Code clients discover this support from the authorization server metadata and connect without a manually issued client ID. Sign in through Odin's existing Google, password, MFA or enterprise SSO flow, select the intended workspace, and approve access. The default discovery challenge requests read and write scopes; writes still require the user's current Odin permissions.

Odin retrieves only exact HTTPS metadata document paths: `client.json` documents under `https://chatgpt.com/oauth/`, and Claude's `https://claude.ai/oauth/mcp-oauth-client-metadata` (hosted apps) and `https://claude.ai/oauth/claude-code-client-metadata` (Claude Code). Fetches have redirects disabled, a five-second timeout and a 16 KiB response limit. The document must declare its own URL as the client ID and permit public-client token exchange. Its registered callback must match; native loopback callbacks may choose a different port while retaining the same host, path and query. No supplied callback URL is fetched.

Consent previews create no application records. Approval creates or reuses a separate integration application for that client and selected tenant. Every grant remains tied to the approving user, current permissions, approved scopes and resource. Administrators can restrict, disable or revoke the connection through existing integration administration. OAuth client identification does not itself authenticate a user or grant project access.

### Register other clients

An Odin tenant administrator or user with `integrations.manage` registers each public MCP client once through `POST /api/mcp/clients`, authenticated with their ordinary Odin session and the existing cookie/CSRF or bearer flow:

```json
{
  "name": "My MCP client",
  "redirectUris": ["http://127.0.0.1:54321/callback"],
  "scopes": ["projects.read", "projects.write"],
  "projectIds": []
}
```

Use the exact callback URL supplied by your client. HTTPS callbacks and HTTP loopback callbacks are supported. The response contains `client_id`, `applicationId`, and `token_endpoint_auth_method: "none"`; there is no client secret to distribute. Configure that pre-registered client ID in the MCP client's OAuth settings. OpenAI and Claude metadata clients use the automatic path above. Other metadata providers and unauthenticated Dynamic Client Registration (DCR) are not supported.

`projects.read` is required. Add `projects.write` only when mutations are needed. An empty `projectIds` list covers projects the signed-in user can access in the selected tenant, including future projects. A nonempty list restricts access to those projects and blocks project creation. Scopes and project IDs never override current Odin permissions. Existing non-MCP OAuth clients and client-credentials grants cannot authenticate this endpoint.

### Connect and renew

1. In the client, add the remote Streamable HTTP server URL `https://odin.example.com/mcp`. ChatGPT, Codex, Claude and Claude Code identify themselves automatically through their metadata documents; other clients need their pre-registered client ID. Choose `projects.read` or `projects.read projects.write` as the requested scope.
2. Follow the client's login prompt. It discovers protected-resource and authorization-server metadata, then opens Odin's existing login and the `/app/mcp/authorize` consent screen. Select the tenant where the client is registered. MFA and SSO continue through their existing flows; impersonation and emergency sessions cannot approve a grant.
3. Approve the displayed permissions. The client receives a single-use authorization code and exchanges it using S256 PKCE. Authorization, exchange and refresh requests must identify the exact `/mcp` URL in the OAuth `resource` parameter.
4. Initialize and discover tools. Expect 151 tools. Start with `odin_list_projects` to check the intended identity and tenant.

The initial authentication challenge asks for `projects.read projects.write`. A client can explicitly request `projects.read` for read-only consent. With the JavaScript MCP SDK, initiate the desired consent using `auth(provider, { serverUrl, scope: 'projects.read projects.write' })`, complete the browser callback, and call the transport's `finishAuth(code)` before reconnecting. The provider must store the returned client information and tokens, including their issuer, and verify callback state. A read-only grant returns `insufficient_scope` for write tools, including their dry runs; it does not automatically widen itself.

Access tokens expire after one hour. The client stores the rotating refresh token and automatically obtains replacement access tokens; users do not copy access tokens into MCP configuration. The grant has a fixed 30-day maximum lifetime from its initial code exchange. Refreshing does not extend that deadline. After expiry, revocation, removal from the tenant or a failed refresh, sign in again through the client. Save each replacement refresh token and serialize refresh requests: reuse of an already-consumed refresh token revokes the entire grant, including its access tokens. Lost refresh responses require a fresh login; do not blindly retry the old token.

**Limits.** Each grant gets a burst of 120 requests to `/mcp`, then 4 a second. Past that, Odin answers 429 with a `Retry-After` header and a JSON-RPC error, and runs nothing. Across all grants, at most 6 requests run at once and up to 60 more wait up to 10 seconds; beyond that Odin answers 503 with `Retry-After: 5`. Tool definitions and their JSON Schemas are built once per process and shared; each request still gets its own server, credentials and change scope (`backend/src/mcp/server.js`). Until 2026-10-30 every request rebuilt them, about 5 MB of allocation each, and bursts of a few hundred requests pushed the backend past its memory limit. Odin logs one line per request (`MCP request.`): its JSON-RPC methods, the tool a `tools/call` names, the client an `initialize` names, the outcome, status and time, but never arguments or results.

Only hashes of authorization codes and access/refresh tokens are stored on the server. Every HTTP request and internal REST operation rechecks the client, user membership, current scopes, project restrictions and Odin permissions. Public MCP tokens cannot be used as general REST tokens. Internal calls stay on the backend's loopback listener and require a short-lived, request-bound proof; credentials are never forwarded to an external API. Browser origins are explicitly allowed; clients without an Origin header still authenticate normally.

### Revoke access

The client can call `POST /api/mcp/oauth/revoke` with `client_id` and its `token` to revoke that grant. An integration administrator can call `POST /api/mcp/clients/:clientId/revoke` with their ordinary Odin session to revoke all grants and pending codes for the client. MCP clients appear in the existing integration administration list. Disabling an application or rotating its credential also revokes its MCP grants and pending codes; re-enabling it does not restore them. Scope and project restrictions remain intersections of the original grant and the current application configuration.

Discovery follows the [MCP HTTP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). This implementation supports CIMD hosted by OpenAI and Anthropic, pre-registered public clients, authorization code with PKCE, refresh and revocation. Hosted tool discovery declares OAuth scopes on each tool, including the compatibility metadata. It does not provide unattended service-account grants or dynamic client registration.

## Optional stdio bridge: install and start

Use a Node release that supports the repository's scripts; validation used Node 24.18.0. From this checkout:

```powershell
Set-Location <path-to-checkout>
npm run install:backend
$env:ODIN_MCP_BASE_URL = 'http://127.0.0.1:3001'
$env:ODIN_MCP_ACCESS_TOKEN = '<current Odin session access token>'
npm run mcp
```

Replace the origin with the intended Odin API origin. The local API must already be running with its intended configuration. The MCP command starts only the adapter; it does not start Odin, provision a database or load `backend/.env`. Run `node backend/src/mcp/stdio.js` directly when a client launches the process, so npm's script banner cannot enter the MCP protocol stream. Backend-only startup is also available as `npm --prefix backend run mcp`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `ODIN_MCP_BASE_URL` | Yes | Absolute HTTP(S) origin, without credentials, path, query or fragment. HTTP is accepted only for `localhost`, `127.0.0.1` and `::1`; other hosts require HTTPS. Redirects are rejected. |
| `ODIN_MCP_ACCESS_TOKEN` | Yes | Current Odin **access/session** token. A refresh token, API password, JWT signing secret or arbitrary signed JWT is insufficient. |

Requests have a 15-second timeout, a 1 MiB request limit and an 8 MiB response limit. Credentials are sent only in the Bearer header. The server reserves stdout for MCP and reports startup failures on stderr without printing environment values.

## Stdio authentication

Sign in through Odin's supported authentication flow. Password login at `POST /api/auth/login` with `X-Auth-Response: bearer` returns the access token as `session.token` when login completes. Accounts requiring MFA must finish the existing two-factor flow. Enterprise accounts must use their existing SSO flow; MCP adds no bypass.

For an account with several tenants, select the intended tenant through Odin's existing `POST /api/auth/switch-tenant` flow with the same bearer-response header, and use the returned session token. MCP tools cannot choose a tenant through arguments. The API verifies the session store, expiry, revocation, current membership and current permissions on every request. Missing permissions may produce 404 to hide a resource; comment author checks can produce 403.

Standard access tokens expire after one hour unless the application config changes that lifetime. Refresh through Odin's existing flow and restart the MCP process with the replacement token. Keep tokens out of Git, chat transcripts and shared client configuration. A client with this server configured can act with the supplied session's permissions, so configure it only in a trusted local client.

## Connect a stdio client

Configure any MCP client supporting stdio to launch Node with the absolute entrypoint path. This common JSON configuration shape is accepted by clients that use `mcpServers`; other clients may use a different wrapper:

```json
{
  "mcpServers": {
    "odin": {
      "command": "node",
      "args": ["<path-to-checkout>/backend/src/mcp/stdio.js"],
      "env": {
        "ODIN_MCP_BASE_URL": "http://127.0.0.1:3001",
        "ODIN_MCP_ACCESS_TOKEN": "<current Odin session access token>"
      }
    }
  }
}
```

Use the client's secret/environment facility when available. Shell environment inheritance and variable interpolation differ by client. The entrypoint has no working-directory dependency. If Node is absent from the client's PATH, set `command` to its absolute executable path.

Connect, initialize, and discover tools. Discovery should return 151 tools with strict input schemas and read/write annotations. Begin with `odin_list_projects`, then read the chosen project's metadata and hierarchy. Test credentials and intended tenant before issuing writes.

## Tool catalog

All arguments use strict object schemas. Project/item IDs are strings. Paginated reads (`limit` and `cursor`) default to 50 results, with a maximum of 100, unless a tool states its own limits. Every write except `odin_apply_item_changes` accepts `dryRun`, defaulting to `false`.

The table below covers projects, items, relations, comments, the board, sprints and workflow discovery (`catalog.js`, `relation-tools.js`). Later sections cover [bulk planning](#bulk-planning), [tickets and mentions](#tickets-and-mentions), [project files](#project-files), [resources, time and sprint capacity](#resources-time-and-sprint-capacity), [approvals, custom fields and item history](#approvals-custom-fields-and-item-history), [governance and schedule](#governance-and-schedule), [workspace-wide reads](#workspace-wide-reads), [Requirements](#requirements-tools) and [clarifications, stakeholders and members](#clarifications-stakeholders-and-project-members).

| Tool | Arguments and behavior |
| --- | --- |
| `odin_list_projects` | Optional `search`, `limit`, `cursor`, `includeEngagements`; accessible project summaries with `updatedAt` and `kind` (`delivery` or `engagement`). Engagements (with the Consulting module on) are left out unless `includeEngagements` is true. |
| `odin_get_project` | `projectId`; metadata, role, capabilities, `updatedAt`, complete `brief` and `briefUpdatedAt`, and what the caller may change (`permissions`). Hierarchy is read separately. |
| `odin_get_project_brief` | `projectId`; complete `brief` and `briefUpdatedAt`, without assistant artifacts or contact credentials. |
| `odin_update_project_brief` | `projectId`, `input`: required `expectedUpdatedAt` and nonempty `patch`. Only supplied Brief fields change. |
| `odin_create_project` | `input`: required `name`, `status`; optional description, dates and `templateId`. Creates in the session's active tenant. A project template from `odin_list_project_templates` seeds workflows, custom fields and a starter outline; `status` must then be a state of the template's project workflow. Template refusals return 404 `template_not_found` or 409 `template_conflict`. |
| `odin_update_project` | `projectId`, complete metadata `input`, required `expectedUpdatedAt`. Omitted description/dates reset to defaults. |
| `odin_list_items` | `projectId`; optional `itemType`, `parentId`, `search`, `status`, `limit`, `cursor`. Returns flattened epics, stories and tasks with parent IDs and versions. `parentId: null` selects epics. |
| `odin_get_item` | `projectId`, `itemId`; one item with its version and parent ID, without child collections. |
| `odin_create_item` | `projectId`, `input`: `itemType` (`epic`, `story` or `task`), `item`, optional `parentId`, `position`, `templateId` (a work-item template, whose custom-field defaults are recorded on the new item). Epics have no parent; stories require an epic; tasks require a story. Log tickets with `odin_create_ticket`. |
| `odin_update_item` | `projectId`, `itemId`, `input`: required `expectedVersion`, `patch`; optional `parentId`, `position`. At least one field, parent or order change is required. A 409 means the item changed since it was read, or the status change needs an approval first (`odin_request_approval`). |
| `odin_delete_item` | `projectId`, `itemId`, `expectedVersion`. Delete children first (409 `children_exist`); workflow terminal-state rules and legal holds still apply. A ticket id returns `item_not_found` pointing to `odin_delete_ticket`. |
| `odin_list_item_relations` | `projectId`, `itemId` (epic, story, task or ticket). Typed relations (`blocks`, `caused_by`, `affects`, `duplicate_of`) touching the item in both directions, with `direction` and the related item's type, name and status. Relations to a ticket from outside the team that nobody has validated are left out. |
| `odin_link_work_items` | `projectId`, `fromItemId`, `relationType`, `toItemId`; each an epic, story, task or ticket in the project, but not a ticket from outside the team that nobody has validated. Reads as "from `<type>` to". Requires plan-edit permission. Idempotent; no self-links. |
| `odin_unlink_work_items` | `projectId`, `itemId`, `relationId`. Verifies the relation is listed on that item, then removes it. Requires plan-edit permission. No version precondition. |
| `odin_list_comments` | `projectId`, `targetType` (`project`, `epic`, `story`, `task` or `ticket`), `targetId`; optional `limit`, `cursor`. Each result is a whole top-level thread with nested `children`. A ticket from outside the team that nobody has validated returns 404 `ticket_not_found`. |
| `odin_add_comment` | `projectId`, `input`: `targetType`, `targetId`, `comment` (Markdown or HTML); optional `parentId` for a reply on that target, and `mentions` (user ids, see [mentions](#tickets-and-mentions)). |
| `odin_update_comment` | `projectId`, `targetType`, `targetId`, `commentId`, `comment`; optional `mentions`. Verifies target membership before Odin's author checks. Odin emails everyone the edited comment mentions, again. No version precondition. |
| `odin_delete_comment` | `projectId`, `targetType`, `targetId`, `commentId`. Verifies target membership; deletion may remove replies. No version precondition. |
| `odin_get_board_config` | `projectId`; current user's saved Kanban configuration. Preset filters are normalized for read/edit/save round trips. |
| `odin_update_board_config` | `projectId`, complete `config`: columns, status mappings, filters, presets and swimlane. Omitted fields reset to defaults. No version precondition. |
| `odin_get_board` | `projectId`; optional `filters`, `limit`, `cursor`. Returns columns, members, sprints and paginated story/task cards in Kanban priority order. Tickets are excluded. |
| `odin_reorder_board_card` | `projectId`, `itemId`, and `afterItemId` or `beforeItemId`. Sets the card's place in the project-wide Kanban priority order, which all users share and which is separate from sprint order. Returns 409 when neither neighbor exists. No version precondition. |
| `odin_list_sprints` | `projectId`; optional `limit`, `cursor`. Paginated sprint metadata. |
| `odin_create_sprint` | `projectId`, `input`: required `name`; optional goal, dates, status. |
| `odin_update_sprint` | `projectId`, `sprintId`, complete metadata `input`. Omitted goal/dates/status reset to defaults. No version precondition. |
| `odin_activate_sprint` | `projectId`, `sprintId`; existing Odin activation route, no version precondition. |
| `odin_complete_sprint` | `projectId`, `sprintId`; existing Odin completion route, no version precondition. |
| `odin_get_workflows` | `projectId`; optional `limit`, `offset`. Tenant definitions, project bindings for supported item types, status/transition/role/required-field rules, canonical project statuses and version policy. Native offset pagination returns `nextOffset`. |

Item create/update fields include name, description, status, priority, assignee ID/name, points, progress, percent complete, actual hours, board column, sprint ID/order, target dates, hour estimate, estimate override and source clarification IDs. Patch only fields you intend to change. Dates follow Odin's `YYYY-MM-DD` schema. Priorities range from 1 through 7, defaulting to 4; 1 is highest. Odin validates workflow statuses and transitions at write time. When bound to a workflow, use its state **key**, not merely its display label. Unbound status behavior follows the existing API.

Board filters include `search`, `assigneeIds`, `selectedSprintIds`, `statusValues`, `issueTypes` (`story`/`task`), `hideDone` and `includeBacklog`. Columns use `name`, `statuses`, and `defaultStatus`; swimlanes support `none`, `assignee`, `epic`, `sprint`, and `issueType`. Move a card by updating its status to a column's default status with its current version. Assign an item to a sprint through versioned `odin_update_item` using `sprintId` and optionally `sprintSortOrder`; clear the sprint with `null`. `odin_assign_items_to_sprint` moves many stories and tasks at once, without versions (see [bulk planning](#bulk-planning)).

Saved configuration can preserve Odin's ticket filter preference, but MCP board reads always request story/task cards. Workspace administration and invitations, project deletion/tree replacement, workflow and template administration, and the in-app assistant's memory and monitor tools are outside this catalog. Project deletion (`DELETE /api/projects/:projectId`, a soft delete) and the tenant admin's deleted-project list and restore are not allowed for MCP credentials. A deleted project disappears from `odin_list_projects` and every project read until a tenant admin restores it. With the Consulting module off, an engagement's project reads return 404, and a lost engagement refuses writes with 403 `engagement_closed` until it is reopened.

**Project-wide changes** belong to a project's admins and managers, by project or workspace role (`change-scope.js`). Without those rights, a client cannot change the project's settings, dates or brief, its sprints (including sprint assignment and capacity), board setup, milestones, dependencies, working calendar or schedule baselines, or more than 10 work items in one tool call. Creating, updating and deleting items and tickets, each item a batch of checked changes saves, reordering board cards, restoring revisions, triaging tickets and splitting stories (the new story and each moved task) count toward that limit. `odin_set_custom_field` also keeps the project's own fields to admins and managers. Those writes return 403 `needs_project_manager`. Bulk tools check before their first write, so they are refused whole. `odin_get_project` returns what the caller may change as `permissions`: `canEditPlan`, `canManage` (project-wide changes), `canManageMembers`, `projectRole` and `workspaceRole`.

### Structured project and Brief fields

The project schema, `ProjectDetailView.vue` and `frontend/src/lib/projects/project-brief.js` define this coverage. The short project description and structured Brief remain separate.

| Fields | MCP read | MCP write and semantics |
|---|---|---|
| Project `name`, `description`, `status`, `startDate`, `endDate` | `odin_get_project`, project list | Existing create/update tools. Updates replace metadata, with project `updatedAt` as `expectedUpdatedAt`. Existing status, date and text validation applies. |
| Project `id`, `tenantId`, `createdAt`, `updatedAt`, `rank`, `role`, `capabilities` | Project reads when returned by the API | Read-only metadata, stored ordering and access context; these are not fields in the project write schema. |
| Brief `name` | Both project and Brief reads | Patch text, maximum 160 characters. This is the Brief title, not the project name. |
| Brief `objective`, `currentState`, `proposedSolution`, `benefits`, `implementationEffort` | Both project and Brief reads | Patch text, maximum 5,000 characters per field. |
| Brief `stakeholders`, `dependencies`, `constraints`, `successMetrics`, `assumptions` | Both project and Brief reads | Replace supplied string lists, maximum 20 entries each, maximum 5,000 characters per entry. |
| Brief `requirements` | Both project and Brief reads | Replace supplied string list, maximum 40 entries, maximum 5,000 characters per entry. |
| Brief `narrative`, `committedAt`, `sourceSessionId` | Both project and Brief reads | Read-only assistant narrative/provenance; preserved during patches. |

`odin_update_project_brief` calls `PATCH /api/projects/:projectId/assistant-brief`. Supply the last `briefUpdatedAt` as `input.expectedUpdatedAt`; use `null` only when the read returned `null`. It is separate from project `updatedAt`. Omitted fields stay unchanged. Empty text and empty lists clear fields; existing API normalization also accepts null as empty text/list. Text is trimmed and duplicate list entries are removed, matching the Brief editor. Unknown fields, provenance writes, empty patches and invalid types or limits fail validation. List strings retain their Markdown content. No new business fields are introduced.

Brief reads require project read access. Writes require `projects.write` for hosted grants, the existing `PLAN_EDIT` project capability and, as a project-wide change, a project admin or manager role; grants remain tenant- and project-scoped. Dry runs validate only the schema and never call the API or check project permissions or versions. The mutation is annotated as destructive because supplied lists can replace existing content.

The repository checks and merges the patch atomically. MySQL locks the tenant-scoped project row before reading or creating the shared assistant-state preference; all normal assistant-state saves use the same lock. In-memory saves check and merge synchronously. Saves advance the state timestamp even when the clock has not advanced. An intervening browser, assistant or artifact save causes a stale Brief patch to return 409. Read again and resolve the changed values before retrying. Legacy browser `PUT /assistant-brief` keeps its full-replacement behavior and does not gain a required version parameter; MCP grants cannot call that unversioned route. Privileged archive restore retains its existing archived-state behavior and can restore old timestamps; versions are not an epoch across archive restores.

Brief `stakeholders` are descriptive strings. `ProjectStakeholdersPanel.vue` manages separate contacts (`name`, `email`, `roleTitle`); the [stakeholder tools](#clarifications-stakeholders-and-project-members) read, add and edit them and send their invitations. Brief `requirements` are strings, distinct from the Requirements review workflow below. The Brief tools do not change contacts, members, tickets, artifacts or provenance. Existing item, board, sprint and Requirements tools retain their separate schemas and permissions.

### Bulk planning

Six tools plan a project in fewer calls (`workspace-tools.js`). They read the project themselves and do the bookkeeping: versions, parent types and name lookups. An `assignee` may be a user id, `resource:<id>`, or a name or email; project members, allocated resources and current owners match before other workspace users. An ambiguous name is refused with `assignee_ambiguous` and an unknown one with `assignee_not_found`; the bulk tools report that item as failed and carry on.

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_project_overview` | read | `projectId` | Status counts, points and hours, each owner's open work, overdue and unassigned work, the active sprint with its open items, every sprint, and per-epic progress, in one call. |
| `odin_find_items` | read | `projectId`; optional `text` (in the name or description), `status` (a list), `assignee` (name, email, id or `unassigned`), `sprint` (id, name, `active` or `backlog`), `itemType`, `parentId`, `state` (`open`, `done` or `any`, the default), `overdue`, `includeDescriptions` (default false), `limit` (1-200, default 60) | Compact rows with ids and versions, and `total`. `note` says when more matched than `limit`. An unknown sprint returns 404 `sprint_not_found` with the project's sprint names. |
| `odin_create_plan_items` | write | `projectId`, `items` (1-40); optional `parentId`, `dryRun` | Creates whole branches. Without `parentId` the top level is epics; under an epic, stories; under a story, tasks. Each node takes `name` and optional `description`, `status`, `priority`, `points`, `targetHourEstimate`, `targetStartDate`, `targetEndDate`, `assignee`, `sprintId` and up to 40 `children` one level down. Items are created one at a time and not rolled back: `created` lists every new id, `failed` each refusal and how many children it skipped, and `descriptionGaps` the epics and stories missing parts of the planning rubric (stories need acceptance criteria). `ok` is false when anything failed. A task as `parentId` returns 400 `invalid_parent`. |
| `odin_update_items` | write | `projectId`, `updates` (1-100, each `itemId`, `patch`, optional `parentId`, `position`); optional `childAssignees` (`follow`, the default, or `keep`), `dryRun` | Patches each item with the version it reads, so no `expectedVersion` is needed. `patch` takes the node fields above, all optional, plus `boardColumn`, `percentComplete` and `actualHours`. Giving a story or epic an assignee also gives it to the open work under it that had the parent's old assignee or none (a story's tasks; an epic's stories and their tasks), unless `childAssignees` is `keep`. Work listed in the call, finished work and anyone else's keep their own, as does the work under a child that doesn't follow; unassigning a parent changes only the parent. Those results carry `followed` (the parent's id) and `itemType`, and count toward the item limit. An item that changed while the call ran (a 409) is read again and updated only if nobody changed the fields its update sets; otherwise it is left as it is, with `changed: true` and its `current` values. A 409 that leaves the version unchanged, such as a status change that needs an approval, is reported as it came. `results` reports each item; `ok` is false when any failed. |
| `odin_assign_items_to_sprint` | write | `projectId`, `sprintId` (`null` for the backlog), `itemIds` (1-200); optional `dryRun` | Moves stories and tasks in one request, with no version precondition. Epics and unknown ids come back in `skipped`; when nothing can move, 400 `nothing_to_assign`. A sprint change, so it needs a project admin or manager. |
| `odin_check_plan_quality` | read | `projectId`; optional `itemIds` (up to 200) | What each epic and story description lacks against Odin's planning rubric (acceptance criteria, scope, outcome and so on): `itemsWithGaps` and up to 60 `findings`. Advisory only. |

### Tickets and mentions

Tickets are defects, support requests, questions and change requests (`ticket-tools.js`, with `odin_list_tickets` and `odin_update_ticket` in `workspace-tools.js`). `category` is `defect`, `support`, `question` or `change_request`; `severity` runs from `S1` (critical) to `S4` (minor). The comment and relation tools above reach tickets too.

A ticket submitted from outside the team, through a ticket intake link or Bug Reporter, stays hidden until someone validates it. Ticket lists, comments, relations, revisions, files, Home, Insights and governance links leave it out, and a tool that names it answers as if it did not exist. Odin checks each such ticket automatically. Triage never shows its content: an agent can reject any of them but validate only one the check found safe, and the rest wait for a person in Odin's review queue.

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_get_ticket_options` | read | `projectId` | `categories`, `severities`, the ticket workflow's `statuses` (`closes` marks closing states; `null` without a workflow), `initialStatus`, and the active `environments` and `releases` with their ids. |
| `odin_list_tickets` | read | optional `projectId`, `search`, `statusValues`, `severities`, `categories`, `assigneeIds`, `reopened`, `limit` (1-100, default 40) | Tickets in one project, or in every project the user can see when `projectId` is omitted, which needs a grant for every project. Each has its id, project, name, status, severity, category, priority, assignee, reporter, version, and description cut to 600 characters. |
| `odin_create_ticket` | write | `projectId`, `input`: `name`; optional `description`, `category` (default `defect`), `severity` (default `S3`), `priority`, `assigneeId`, `reproSteps`, `expectedResult`, `actualResult`, `buildVersion`, `environmentId`, `foundInReleaseId`, `targetEndDate`, `linkedItemId`; optional `dryRun` | Logs the ticket in the first state of the project's ticket workflow (`new` without one), outside any sprint. `linkedItemId` ties it to the epic, story or task it concerns. Needs plan-edit access. |
| `odin_update_ticket` | write | `projectId`, `itemId`, `patch`: any of `name`, `description`, `status`, `priority`, `assignee`, `severity`, `category`, `reproSteps`, `expectedResult`, `actualResult`; optional `dryRun` | Reads the ticket's version itself. `assignee` may be a name. A status change emails the reporter when the ticket came in through a reporting link. |
| `odin_delete_ticket` | write | `projectId`, `itemId`; optional `expectedVersion` (read when omitted), `dryRun` | Deletes a ticket that is in a closing state of its workflow (such as Closed, Rejected or Deferred) and unchanged since it was read; otherwise 409. Odin keeps the revision. A legal hold returns 423 `legal_hold`. Needs plan-edit access. |
| `odin_list_tickets_awaiting_review` | read | `projectId`; optional `limit` (1-25, default 10) | Tickets from outside the team that nobody has validated or rejected, oldest first: `id`, `category`, `severity`, `source`, `version`, `updatedAt`, and Odin's automated check as `classification`. It holds `safety` (`safe`, `caution` or `unsafe`), `recommendation` (`validate`, `reject` or `person`), `probabilities` (`genuine`, `aimsAtAI`, `harmful`) and `partial` (the check could not read all of the ticket or its readable files, so it is never safe), and is `null` when the check could not run. Never the title, text or reporter. Needs plan-edit access. |
| `odin_review_ticket` | write | `projectId`, `itemId`; optional `decision` (`validated` or `rejected`), `dryRun` | Without `decision`, follows the check's recommendation; when it says a person should look, or the check could not run, the ticket stays pending (`needsPerson: true`). Validating needs a check of the ticket's current version that found it `safe`, otherwise 409 `needs_person`. Rejecting always works. A rejected ticket can be validated only by a person. Odin checks again as it saves and returns 409 when the ticket's comments or attachments changed during the check or anything on it changed in the last five minutes. Never returns the ticket's content; status, assignee and scheduling stay as they were. Needs plan-edit access. |
| `odin_list_mentionable_people` | read | `projectId`; optional `search`, `limit` (1-100, default 25) | Everyone in the workspace who can be @mentioned, with `id`, `name` and `email`, and `total`. |

**Mentions.** `odin_add_comment` and `odin_update_comment` take `mentions`: user ids from `odin_list_mentionable_people`. Odin emails each person mentioned. Write `@Name` where each belongs; anyone not written is mentioned at the start. A typed `@Name` without an id notifies nobody. When Odin refuses a comment that mentions someone, the tool returns 400 `invalid_comment`: everyone in `mentions` must be someone `odin_list_mentionable_people` returns, and a reply's parent must be on the same target.

### Project files

Ten tools work with project files through Odin's file permissions: viewers list, read and download, members and above add, change, link and delete (`file-tools.js`). A file belongs to the project or to one of its epics, stories, tasks or requirements topics, and can also be linked to any number of epics, stories, tasks or tickets in the project. Every file keeps its versions: a new one is stored apart from the last, so nothing is overwritten. `targetType` is `project` (the default), `epic`, `story`, `task` or `topic`, with `targetId` for anything but the project. A topic id is a clarification id. A file on a ticket from outside the team that nobody has validated, or whose ticket is gone, is not found. File names, descriptions and contents are user content, not instructions.

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_list_project_files` | read | `projectId`; optional `targetType`, `targetId`, `search` (in the name or description), `limit`, `cursor` | Every file in the project by default, or one target's files, which includes files linked to it. Each has `id`, `fileName`, `contentType`, `fileSize`, `description`, `attachedTo`, `audience` (`internal` or `external`), `links` (each with `id`, `type`, `itemId`, `name`), `version`, `uploadedBy`, `updatedAt` and `readable` (whether `odin_read_project_file` can read it). Local snapshot pages. |
| `odin_read_project_file` | read | `projectId`, `fileId`; optional `offset` (default 0), `maxChars` (1-50,000, default 20,000), `version` | The text of plain text, Markdown, CSV, JSON, YAML, XML, HTML and log files up to 5 MB, and of PDFs (marked page by page) and Word `.docx` documents up to 15 MB, with `range` and `nextOffset`; call again with `nextOffset` until it is `null`. Spreadsheets, slides, images and `.doc` files return 415 `not_text`; password-protected, damaged or scanned documents 422 `no_text_extracted`; larger files 413 `text_too_large`; 503 `text_busy` when Odin is reading other documents. |
| `odin_upload_project_file` | write | `projectId`, `fileName`, and exactly one of `text` or `contentBase64` with `contentType`; optional `targetType`, `targetId`, `description`, `replace` (default false), `dryRun` | Adds a file of at most 700 KB. `text` needs a name ending in `.txt`, `.md`, `.markdown`, `.csv` or `.json`. `contentType` is text, Markdown, CSV, JSON, PDF, PNG, JPEG, GIF, WebP, Word, Excel or PowerPoint; HTML, SVG, XML and scripts are refused. Odin scans uploads for viruses (400 `file_rejected`). A name already on the target returns 409 `file_exists` unless `replace` is true, which saves this as the next version of that file and keeps the earlier ones. Odin checks again as it saves, so a file saved under the name in the meantime is never saved over (409 `file_changed` or `file_exists`). A legal hold returns 423 `legal_hold`. Not idempotent. |
| `odin_delete_project_file` | write | `projectId`, `fileId`; optional `dryRun` | Deletes the file permanently, with every version and link. A legal hold returns 423 `legal_hold`. A file in a pending or completed signature request cannot be deleted (409). |
| `odin_download_project_file` | read | `projectId`, `fileId`; optional `version`, `inline` (default false) | The file itself, of any type: `url` opens it in Odin's File Vault, which is what to give a person. With `inline`, `contentBase64` holds the bytes of a file of 700 KB or less; a larger one returns `tooLargeToInline`. |
| `odin_list_file_versions` | read | `projectId`, `fileId`; optional `limit`, `cursor` | Every version, newest first: `version`, `current`, `fileName`, `contentType`, `fileSize`, `note`, `uploadedBy`, `uploadedAt`. Local snapshot pages. |
| `odin_upload_file_version` | write | `projectId`, `fileId`, `expectedVersion`, and exactly one of `text` or `contentBase64` with `contentType`; optional `fileName`, `note`, `dryRun` | New contents for a file, under the rules of `odin_upload_project_file`. The name stays unless `fileName` changes it. Identical contents save nothing and return `unchanged: true`. 409 `file_changed` when someone added a version since `expectedVersion`, `file_conflict` when `fileName` is also given and that or a taken name is why. A legal hold returns 423 `legal_hold`. Undo brings back the version before. |
| `odin_restore_file_version` | write | `projectId`, `fileId`, `version`, `expectedVersion`; optional `dryRun` | Makes an earlier version current by saving it as a new one, so nothing is lost. The note says which version it came from. 409 `file_changed` when the file moved on, or the name that version had now belongs to another file there. A legal hold returns 423 `legal_hold`. |
| `odin_link_project_file` | write | `projectId`, `fileId`, `targetType` (`epic`, `story`, `task`, `ticket`), `targetId`; optional `dryRun` | Shows the file on that item as well. The file stays where it was uploaded. Linking again, or to the item it was uploaded to, returns `linked: false`. 400 `target_not_found` for an item outside the project or of another type. A ticket from outside the team that nobody has validated counts as outside. |
| `odin_unlink_project_file` | write | `projectId`, `fileId`, `linkId`; optional `dryRun` | Removes a link. The file and the item stay. A file on the item it was uploaded to has no link to remove. 404 `link_not_found`. |

### Resources, time and sprint capacity

Nineteen tools read the project team, staff projects, give people without a login task access, log time, record time off and set sprint capacity (`resource-tools.js`, with `odin_get_project_team` in `workspace-tools.js`). Odin checks its usual rules: a workspace admin or manager role for resources, allocations, time off and other people's time, plan-edit access to the project, open timesheet periods and each person's minimum bill rate. Allocation, time entry and time off ids and versions come from the read tools; a stale version returns 409 `version_conflict`.

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_get_project_team` | read | `projectId` | `allocations` (ids, versions, hours per week, and project rates when the user may see rates), the `people` on the project with the `assigneeId` each owns work under, and, for people who manage resources, the `directory` of resources and the workspace `users` to add from. Needs only project read access. |
| `odin_add_project_resource` | write | `projectId`, `input`: `name`; optional `email` and profile fields (`roles`, `skills`, `location`, `capacityHoursPerWeek`, `billRate`, `costRate`, `currency`) and `allocation` (`hoursPerWeek`, `startDate`, `endDate`, `role`, `status`, `billRate`); optional `dryRun` | Adds someone without an Odin login (a contractor, a vendor's engineer, an unfilled role) as a resource and allocates them. `email` is where their task access link goes. Adding them sends no email and gives no access; `odin_set_task_access` and `odin_send_task_access_link` do that. An active profile without a login with the same email, or else the same name, is reused (`created` says which); a reused profile with no email takes the one given, and one under the name with another email is someone else. `added` is false when they were already on the project. Returns `assigneeId` (`resource:<id>`) for owning work items. Allocation dates default to the project's, hours to 0 and status to `active`. 409 `has_login` when someone with a login has the name and no email is given, or when the email belongs to a login or another profile; 403 `outside_connection` when a matching profile is in projects the grant cannot see. |
| `odin_update_project_resource` | write | `projectId`, `resourceId`, `input`: `expectedVersion` and at least one of `name`, `email` (`null` removes it), `roles`, `location`, `capacityHoursPerWeek`; optional `dryRun` | Changes the profile of someone without a login on the project, with the Resources tab's email checks. The id and version come from `odin_get_project_team` (`people`). A new email is used for the next link sent; a link already sent keeps working until turned off. 404 when they aren't on the project; 409 for a stale version, an email in use, or someone with a login. |
| `odin_get_task_access` | read | `projectId` | Each person without a login on the project: `resourceId`, `name`, `email`, `scope` (`off`, `own` or `all`) and their access link's state (`null` when none was sent). Links themselves are never returned. |
| `odin_set_task_access` | write | `projectId`, `resourceId`, `scope` (`off`, `own`, `all`); optional `dryRun` | Turns task access on or off. `own` lets them see the epics, stories and tasks assigned to them and update those from a link; `all` also shows everyone else's work. Needs an active profile with an email, allocated to the project. Sends no email, but a link they already hold opens the project at once. |
| `odin_send_task_access_link` | write, asks first | `projectId`, `resourceId`; optional `dryRun` | Emails them their access link, which opens every project where their task access is on. Task access must be on first. Every call issues another link and sends another email, and links sent earlier keep working. Returns `emailed`. The assistant asks before sending. |
| `odin_add_project_allocation` | write | `projectId`, `input`: exactly one of `resourceId` or `userId`; optional `hoursPerWeek`, `allocationPercent`, `startDate`, `endDate`, `role`, `status`, `billRate`; optional `dryRun` | Allocates someone already in Odin. A user without a resource profile gets one linked to their login (`created`); `added` is false, and nothing changes, when they are already on the project. Dates default to the project's, hours to 0 and status to `active`; `allocationPercent` follows from the hours and weekly capacity unless given. `billRate` (`null` uses their profile rate) cannot go below their minimum. Adds no project access. |
| `odin_update_project_allocation` | write | `projectId`, `allocationId`, `input`: `expectedVersion` and at least one of `hoursPerWeek`, `allocationPercent`, `startDate`, `endDate`, `role`, `status` (which adds `completed`), `billRate`; optional `dryRun` | Changes the allocation. New hours without a new percent keep the percent in step with capacity. To end one, set `endDate` to its last day and, once it is over, `status: completed`. |
| `odin_remove_project_allocation` | write | `projectId`, `allocationId`, `expectedVersion`; optional `dryRun` | Deletes the allocation. Work items, logged time and project access stay, and someone who still owns work may be allocated again when the plan is next saved. |
| `odin_move_allocation_hours` | write | `projectId`, `allocationId`, `expectedVersion`, `hours` (up to 168), `targetResourceId`; optional `dryRun` | Moves weekly hours to another active resource for the same dates and role. Moving every hour hands the allocation over; fewer splits it. Returns `movedHours`, `from` and `to`. |
| `odin_log_time` | write | `projectId`, `hours` (over 0, at most 24); optional `workItem`, `workDate` (default today in UTC), `note`, `billable` (default false), `resourceId`, `dryRun` | Logs the time as submitted in the open timesheet period holding the date. `workItem` is an epic, story or task id, or words from its name; several matches return 400 `work_item_ambiguous`. `resourceId` logs for someone else, which needs a workspace admin or manager role. 422 `no_resource_profile` when the user has no resource profile; 423 `period_locked` for a locked or closed period. |
| `odin_list_time_entries` | read | optional `projectId`, `from`, `to`, `resourceId`, `mine` (default false), `limit` (1-500, default 100) | Entries newest first with ids and versions, `total`, `totals` by status and `myResourceId`. Without `projectId`, every project the user can see. Without a workspace admin or manager role, only the user's own. An entry with `invoiced: true` is on an invoice: `invoice` gives its number (or `draft`), and nobody can change or delete it. |
| `odin_update_time_entry` | write | `projectId`, `timeEntryId`, `input`: `expectedVersion` and at least one of `hours`, `workDate`, `note`, `billable`, `status` (`submitted`, `approved`, `rejected`), `workItem` (`null` clears it); optional `dryRun` | Changes the entry; a new date moves it to that date's period. Without a workspace admin or manager role, people change only their own time while it is submitted, and cannot approve or reject. Time in a locked or closed period cannot change. Time on an invoice cannot change (409 `time_entry_invoiced`). |
| `odin_delete_time_entry` | write | `projectId`, `timeEntryId`, `expectedVersion`; optional `dryRun` | Deletes the entry. People delete their own time while it is submitted and its period is open; anyone else's, or approved or rejected time, needs a workspace admin or manager role. Time on an invoice stays (409 `time_entry_invoiced`). |
| `odin_list_time_off` | read | optional `from`, `to`, `resourceId`, `mine`, `limit` (1-500, default 100) | Leave, holidays and `working_override` entries (different hours on some days) overlapping the dates, soonest first, with `myResourceId`. Approved entries reduce capacity by `hoursPerDay` on each listed weekday. Without a workspace admin or manager role, only the user's own. |
| `odin_add_time_off` | write | `input`: `resourceId`, `entryType` (`leave`, `holiday` or `working_override`), `startDate`, `endDate`; optional `hoursPerDay` (default 8; required for `working_override`, where it is the hours worked), `weekdays` (default Monday to Friday, 0 is Sunday), `status` (`requested`, `approved` by default, `rejected`), `timezone`, `note`; optional `dryRun` | Records the entry for one person. Approved entries change their capacity on every project. Needs a workspace admin or manager role. |
| `odin_delete_time_off` | write | `calendarEntryId`, `expectedVersion`; optional `dryRun` | Deletes the entry. Needs a workspace admin or manager role. |
| `odin_get_sprint_capacity` | read | `projectId`; optional `sprintId` | Each member's capacity hours for the sprint (with any allocation percent override and note), the sprint's total, and the hours, points and items planned in it. Without `sprintId`, the active and planned sprints. `members` lists who can be given capacity. |
| `odin_set_sprint_capacity` | write | `projectId`, `sprintId`, `set` (each `userId`, `capacityHours`, optional `allocationPctOverride`, `notes`) and/or `remove` (user ids); optional `dryRun` | Changes only the members named and saves the sprint's whole list. Only project members can have capacity (400 `not_project_member`). Odin keeps no version for capacity, so the last save wins. A sprint change, so it needs a project admin or manager. |

A grant limited to some projects sees only the people on its projects in the directory and logins, and can add or move hours to only them. It must pass a `projectId` to `odin_list_time_entries`, and it cannot reach time off, which belongs to a person rather than a project.

### Billing

With the Consulting module on, a project linked to invoice-gen has billing: its SOW, invoices and the SOW milestone each story bills to. Only project admins and managers and workspace admins and managers can read it or change the mapping (403 `billing_not_allowed` for other members; 403 `module_disabled` with the module off). There are no claim or release tools: invoice-gen claims time as it drafts invoices.

| Tool | Kind | Input | Result |
| --- | --- | --- | --- |
| `odin_get_project_billing` | read | `projectId` | `link` (client, line of business, SOW with milestones, or null), `milestones` (budget, billed, on-draft and ready-to-bill hours, story count), `noSow` hours, `invoices` (number, status, overdue, dates, hours, total, link), `heardAt` (when invoice-gen last sent anything) and `stories` with their `milestoneId`. |
| `odin_set_story_milestones` | write | `projectId`, `assignments` (1-100, each `storyId` and `milestoneId`, `null` to clear); optional `dryRun` | Sets each story's milestone; a story holds one at most. Time on the story and the tasks under it bills to that milestone. Returns `changed` (`storyId`, `from`, `to`). 409 `billing_not_linked` without a SOW; 400 `invalid_assignments` for a story not on the project, a milestone the SOW lacks, or a story named twice. |

### Approvals, custom fields and item history

Nine tools cover workflow approvals, custom fields, revisions, story splits and templates (`workflow-tools.js`, with `odin_list_item_revisions` in `workspace-tools.js`). Approvals and custom fields apply to the project, epics, stories and tasks; where they take an item id, the project id itself names the project. Odin checks plan-edit access on every write, the roles a transition names, and that nobody approves their own request.

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_list_approvals` | read | `projectId`; optional `status` (`pending` by default, `approved`, `rejected`, `consumed` or `all`), `itemId`, `limit`, `cursor` | Approvals oldest first: the item, the move (`fromState` to `toState`, with labels), who asked and why, the decision once made, `approverRoles` (empty means anyone who can edit the plan) and, while pending, `yourRoleMayDecide`. |
| `odin_request_approval` | write | `projectId`, `itemId`, `toState` (key or label); optional `note`, `expiresAt` (ISO date-time, after which an unused approval lapses), `dryRun` | Reads the item's status, workflow and transition, then records a pending approval. Approvers see it on their Home; no email is sent. 409 `no_workflow`, `transition_not_allowed` (with the moves allowed), `approval_not_required` or `already_requested`. Once approved, make the move with `odin_update_item` (`odin_update_project` for the project); the move uses the approval up. Needs one of the transition's `allowedRoles` when it names any (403 `role_denied`). |
| `odin_decide_approval` | write | `projectId`, `approvalId`, `decision` (`approved` or `rejected`); optional `note`, `expectedVersion` (read when omitted), `dryRun` | Approving lets the move through once; rejecting closes the request, and anyone may ask again. Neither changes the item or sends email, and a decision cannot be undone. The person who asked, or someone without one of the transition's `approverRoles`, gets 403 `not_an_approver`. 409 `already_decided`. |
| `odin_get_custom_fields` | read | `projectId`; optional `itemId`, `itemType` (`project`, `epic`, `story` or `task`), `limit`, `cursor` | The active workspace fields for each item type (`appliesTo`), with type, options and `required`, and the values set on the project's items, paged, each with its `version`. Workflow states and transitions can require a field (`requiredFields` in `odin_get_workflows`). |
| `odin_set_custom_field` | write | `projectId`, `itemId`, `field` (id or name), `value` (text, a number, a boolean, a `YYYY-MM-DD` date or one of an option field's options; `null` clears it); optional `expectedVersion`, `dryRun` | Checks the value against the field's type (400 `invalid_value`), then sets or clears it. The current value's version is read unless given. A field on the project itself is a project setting, kept to project admins and managers (403 `needs_project_manager`). |
| `odin_list_item_revisions` | read | `projectId`, `itemId`; optional `limit` (1-50, default 15) | An epic, story, task or ticket's revisions, newest first: action, time, the user id that made it, versions, and each changed field from and to. A ticket from outside the team that nobody has validated, live or deleted, is not found. |
| `odin_restore_item_revision` | write | `projectId`, `itemId`, `revisionId` (among the item's latest 100); optional `state` (`after` by default, or `before`), `expectedVersion`, `dryRun` | Puts an epic, story or task back as that revision left it, or as it was just before. Restoring a delete revision brings the item back (`undeleted`); restore a parent before its children. The version is read unless given. Workflow rules apply to the status it brings back. The restore is recorded as a new revision. |
| `odin_split_story` | write | `projectId`, `storyId`, `input`: `name`, `taskIds` (at least one); optional `description`, `assigneeId`, `points`, `priority`, `sprintId`, `targetStartDate`, `targetEndDate`, `targetHourEstimate`, `sourceClarificationIds`, `status`; optional `dryRun` | Moves the tasks into a new story placed right after the original in the same epic. Points and hours default to the moved tasks' totals, and the original's drop by the same amounts. The new story keeps the original's assignee and dates unless set; moved tasks keep their sprints unless `sprintId` is set. With a story workflow, its status is the workflow's starting status (409 `workflow_initial_state_required` for any other); without one it defaults to Not Started. No version precondition. |
| `odin_list_project_templates` | read | optional `kind` (`project` by default, or `work_item`), `includeInactive` (default false) | Templates with name, description, `usable` (false when one needs an update in Odin first) and contents: a project template's workflows, custom fields and outline counts; a work-item template's type, priority, points and number of custom-field defaults. Pass an id as `templateId` to `odin_create_project` or in `odin_create_item`'s input. Templates are created and edited in Odin. |

### Governance and schedule

Fifteen tools keep a project's RAID log (risks, issues, assumptions, decisions and change requests), milestones, scheduled dependencies, working calendar and schedule baselines, and read its schedule analysis, timeline and Insights (`workspace-tools.js`). Writes need plan-edit access, and everything but the RAID log is a project-wide change kept to admins and managers. Update and delete tools read the record's version themselves and change only the fields sent; a change made since that read returns 409 (`dependency_conflict` for a dependency update, `version_conflict` otherwise). Answers leave out links to a ticket from outside the team that nobody has validated.

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_get_governance` | read | `projectId` | RAID items, milestones with their linked work item named, dependencies with predecessor and successor named, the working calendar (`isDefault` when never set), and baselines with what each covers, with the ids the other tools take. |
| `odin_get_schedule_analysis` | read | `projectId` | Critical path, float, late and at-risk items, milestone forecasts and movement from the newest baseline, from dates, estimates, dependencies and the working calendar. |
| `odin_create_governance_item` | write | `projectId`, `input`: `kind` (`risk`, `issue`, `assumption`, `decision` or `change_request`), `title`; optional `description`, `dueDate`, `impact` (`low`, `medium` by default, `high`, `critical`), `probability` (`low`, `medium`, `high`), `ownerId`, `responsePlan`, `status` (`open` by default, `monitoring`, `approved`, `rejected`, `resolved`, `closed`); optional `dryRun` | Logs the record. |
| `odin_update_governance_item` | write | `projectId`, `itemId`, `patch` (any create field); optional `dryRun` | Changes the record. Close one with status `closed` or `resolved`. |
| `odin_delete_governance_item` | write | `projectId`, `itemId`; optional `dryRun` | Deletes the record for good. |
| `odin_create_milestone` | write | `projectId`, `input`: `title`, `targetDate`; optional `status` (`planned` by default, `at_risk`, `achieved`, `missed`), `workItemId`; optional `dryRun` | Adds the milestone. `workItemId` must be an epic, story or task in the project (400 `work_item_not_found`); schedule analysis and Insights then forecast the milestone from it. |
| `odin_update_milestone` | write | `projectId`, `milestoneId`, `patch`; optional `dryRun` | Changes the title, target date, status or linked work item. |
| `odin_delete_milestone` | write | `projectId`, `milestoneId`; optional `dryRun` | Deletes the milestone for good. To keep the record, set its status to `achieved` or `missed`. |
| `odin_create_dependency` | write | `projectId`, `input`: `predecessorId`, `successorId`; optional `dependencyType` (`FS` by default, `SS`, `FF`, `SF`), `lagDays` (-365 to 365 working days); optional `dryRun` | Makes the successor wait on the predecessor. Both must be epics, stories or tasks in the project, and not the same one. A link that already exists returns 409 `dependency_exists`. Schedule analysis builds its critical path from these; the timeline also follows `blocks` relations. |
| `odin_update_dependency` | write | `projectId`, `dependencyId`, `patch`; optional `dryRun` | Changes which items it links, its type or its lag. |
| `odin_delete_dependency` | write | `projectId`, `dependencyId`; optional `dryRun` | Removes the dependency. |
| `odin_update_working_calendar` | write | `projectId`, `patch`: any of `workingDays` (0 for Sunday to 6), `hoursPerDay` (0.5-24), `timezone` (IANA), `holidays` (replaces the list), `addHolidays`, `removeHolidays`; optional `dryRun` | Changes the calendar that schedule analysis, the timeline and dependency lag count working days in. An invalid result returns 400 `invalid_calendar`. |
| `odin_create_schedule_baseline` | write | `projectId`, `input`: `name`; optional `note`; optional `dryRun` | Saves every work item's dates, the milestones, dependencies and working calendar. Baselines cannot be edited or deleted; schedule analysis measures movement from the newest one. |
| `odin_get_timeline` | read | `projectId` | The Insights timeline (Gantt): each epic and story's planned start and finish, what holds each story there (its target dates, its sprint, a blocker, or its person busy with another story), critical and late rows, `planStart`, `planFinish`, and `advice` when stories wait on a busy person. Each person works one open story at a time. |
| `odin_get_insights` | read | `projectId`; optional `days` (30, 90 or 180, default 30; other values from 7 to 365 round up, to at most 180) | Delivery health, throughput and trends, schedule, budget and team signals, and report results. |

### Workspace-wide reads

Two tools read across projects (`workspace-tools.js`), as does `odin_list_tickets` without a `projectId`. Home and tickets across projects need a grant for every project.

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_get_my_work` | read | none | The signed-in user's Home: focus items, assignments, tickets, approvals and alerts across their projects, with counts and sprint status. A grant limited to some projects gets 404 `needs_every_project`. |
| `odin_search` | read | `query`; optional `projectId`, `limit` (1-50, default 20) | Text search across projects, epics, stories and tasks, governance records, milestones, portfolio items and objectives: each match's type, id, title, project, snippet, URL and update time. A grant limited to some projects must pass one of them, and then gets no workspace-wide records. |

### Project changes

Three tools let an agent keep a project in step with the world outside Odin (`change-tools.js`): what changed since it last looked, the detail of the cards it picks, and a batch of checked changes. Changes come from the project change log, which every write to items, comments, item links, schedule dependencies, sprint assignments, story splits and project details adds to, in the same transaction. A link or dependency is logged under one item and names the other as `related_item_id`, so either end finds it.

All three give a card's raw `status` and `boardColumn` together, as Odin stores them: two columns can take the same status (Needs Human and Review) and one column can take several (On Hold and Blocked), so neither alone says where the card is. `column` is the column it shows in on the caller's board, or null.

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_get_project_changes` | read | `projectId`; optional `cursor`, `limit` (1-500, default 200), `offset` | Without `cursor`: `mode: 'baseline'`, every epic, story, task and validated ticket in compact form (type, name, `status`, `boardColumn`, `column`, parent, assignee, sprint, priority, version, last update, comment count and time of the latest comment), the board's columns, the workflow per item type with its version, and a `cursor`. Past 1000 items it is paged with `nextOffset`; keep the first page's cursor. With `cursor`: `mode: 'changes'`, each change after it, oldest first, with its `seq`, time, entity (`item`, `comment`, `relation`, `dependency`, `project`), action, actor, `via` (`app`, `assistant`, `mcp:<client>`, `api:<application>`, `link`, `intake` or `system`) and, for items, the fields changed with old and new values; the current state of each item touched (deleted ones as `deleted: true`); each new or edited comment as plain text, cut at 2000 characters and marked `truncated`; and deleted comment ids. `unchanged: true` when nothing changed; `complete: false` when more changes wait. The same cursor returns the same changes, so keep a new one only once its result is used. With nothing more waiting, the new cursor is the newest settled change in the whole log, so a quiet project's cursor doesn't fall behind the 90 days the log keeps. Changes from the last 5 seconds are held back until the next call. 400 `invalid_cursor` for a cursor from another project or one Odin didn't issue; 409 `cursor_expired` past the 90 days the log keeps. A change to a file has `entity: file`, an `action` of `create`, `version`, `restore`, `link`, `unlink` or `delete`, and `file` with `targetType`, `targetId`, `version`, and, unless the file came with a ticket, `fileName`, `contentType` and `versionNote`. |
| `odin_get_item_details` | read | `projectId`; `itemIds` (up to 25) and/or `continue` (up to 25 tokens); optional `commentLimit` (1-100, default 20), `historyLimit` (1-100, default 10) | For each item: what the feed leaves out (description, estimates, hours, dates, ticket fields), its `status`, `boardColumn` and `column`, and what `odin_apply_item_changes` checks: `version`, `changeSeq` (the newest change log entry about the item, its comments or its links) and `workflow` (`workflowId`, `version`). Assignee, sprint, priority, parent and comment counts come from the feed and aren't repeated. `comments` (each with its parent, so replies can be rebuilt) and `history` (change log entries with actor, `via`, fields and any agent `note`) are the newest page of each, listed oldest first; `more: true` and a `next` token mean older ones exist, and passing `next` in `continue` returns the page before, in `pages`. A comment past 10,000 characters is marked `truncated`; past 400,000 characters of comment text in one response, a thread's older comments are left for `next`. Ids not on the project, deleted or not visible come back in `missing`. Comments and changes for all named items come from one windowed query each; links and dependencies, from one each. 400 `invalid_continue_token`, `nothing_requested` or `too_many_items`. Each item also lists `files`: those uploaded to it and those linked to it (`linked`), with `id`, `fileName`, `version` and `updatedAt`. |
| `odin_apply_item_changes` | write | `projectId`; `changes` (1-25), each with `idempotencyKey` (8-128 of letters, digits, `.`, `:`, `_`, `-`), `itemId`, `expected` (`version`; optional `changeSeq`, `workflowVersion`), `patch` (the item fields `odin_update_items` takes, exact values) and/or `comment` (Markdown), `reason` and optional `evidence` (up to 10 `{ ref, note }`); optional `basedOn` (a feed cursor) | Changes run in order and each stands alone. One is `stale`, and nothing is saved, when the card version differs, when the item, its comments or its links changed after `changeSeq` or `basedOn`, when the workflow version differs, or when the item was deleted; the result gives the item now (`item`) and what changed since (`changesSince`). `refused` gives Odin's reason: workflow rules and permissions apply as for people, a comment or description that would mention (and email) someone is refused (`mentions_not_allowed`), and a second change to the same item in a batch is `duplicate_item`. `applied` gives the item, `saved.fields` as Odin saved them, `saved.comment`, and `audit`: the item's change log entries the change wrote, each carrying `note` (`key`, `reason`, `evidence`). `failed` with `partial: true` means the patch saved but the comment didn't. A retry with the same key and change returns the first result with `replayed: true`; the same key with a different change is `refused` (`idempotency_key_reused`); a key still being applied is `in_progress`. A key claimed by a request that died is recovered after 2 minutes: if the change log shows its change landed, the result says `recovered: true` and nothing is written again. Keys last 30 days. For people without admin or manager rights, a batch whose items would pass the item limit is refused whole before it is sent, and the items it changed count toward the limit (in the assistant, for the rest of the turn). There is no `dryRun`: a stale or refused change already saves nothing. |

### Shared files and signatures

Seven tools share files with a project's stakeholders and ask stakeholders to sign (`signing-tools.js`). Every file is `internal` (the team only) until someone marks it `external`; stakeholders see external files in their client portal. A signature request is an `acceptance` of one or more documents, or a `signoff` of the project or a milestone with optional supporting documents. Odin freezes the exact file versions (SHA-256) and emails each signer a portal link. Signers are project stakeholders with an email, and they sign in the portal with a one-time code emailed to them, so no tool can sign. Anyone who can change files sets the audience; sending, cancelling, removing a signer and reminding need decision rights (project or workspace admin or manager). The in-app assistant asks before it shares a file or does anything that emails signers.

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_set_file_audience` | write | `projectId`, `fileId`, `audience` (`internal` or `external`); optional `dryRun` | The file with its new audience and `changed`. Files on tickets cannot be shared (400 `ticket_file`). A file in a pending or completed request stays external (409 `file_under_signature`). |
| `odin_list_signing_requests` | read | `projectId`; optional `fileId`, `status` (`pending`, `completed`, `declined`, `cancelled`), `limit`, `cursor` | Requests newest first, each with `kind`, `title`, `status`, `subject`, `progress`, `documents` (file, version, hash) and `signers` (name, email, status, when they signed and as whom, and `emailProblem` when the request email was not sent). Local snapshot pages. |
| `odin_get_signing_request` | read | `projectId`, `requestId` | One request in full: the statement, message, package and manifest hashes, each signer's evidence summary (`sealValid`, how they verified, the address the code went to, their IP) and the audit trail. |
| `odin_request_signatures` | write | `projectId`, `kind`, `stakeholderIds`, `title`; `documents` (`fileId`, optional `version`; at least one for `acceptance`); optional `milestoneId` (a sign-off of one milestone), `statement`, `message`, `dryRun` | Creates the request, shares its documents, and emails every signer. A dry run lists the recipients and sends nothing. 400 `invalid_request` for a signer who is not a stakeholder or has no email, a ticket file, or a milestone outside the project; 409 `stakeholder_link_revoked`; 503 `signing_not_configured` when the server has no seal key. Not idempotent. |
| `odin_cancel_signing_request` | write | `projectId`, `requestId`; optional `reason`, `dryRun` | Withdraws a pending request and emails signers who have not signed. 409 `not_pending` when it already ended. |
| `odin_remove_signer` | write | `projectId`, `requestId`, `signerId`; optional `reason`, `dryRun` | Removes a signer who has not signed. At least one signer must remain. When everyone left has signed, the request completes. 409 `not_pending` otherwise. |
| `odin_remind_signers` | write | `projectId`, `requestId`; optional `signerId`, `dryRun` | Emails a reminder to each pending signer, or one. Returns `reminded`. Odin never reminds on its own. |

### Area route allowlist

Besides its own list, `route-access.js` admits the routes each area lists in `backend/src/mcp/access/` (`billing.js`, `changes.js`, `files.js`, `resources.js`, `signing.js`, `tickets.js`, `workflow.js` and `workspace.js`), and no neighbouring ones. Each entry says where the request names its project: in the path, in the `projectId` query parameter, in the body's `projectId`, or nowhere. A grant limited to some projects reaches an area route only when the request names one of them, so it gets 404 from every route marked none. Where a route is on both lists, the list in `route-access.js` wins and its body checks apply. Every write needs `projects.write`. The three requirements routes in `files.js` are in the [requirements allowlist](#requirements-tools).

| Method | Path | Project | Used by |
| --- | --- | --- | --- |
| GET | `/api/projects/:projectId/billing`, `/billing/milestones` | path | a project's billing, and each story's SOW milestone |
| PUT | `/api/projects/:projectId/billing/milestones` | path | set story milestones |
| GET | `/api/projects/:projectId/changes`, `/item-details` | path | project changes since a cursor, item details |
| POST | `/api/projects/:projectId/item-changes` | path | a batch of checked changes |
| GET | `/api/projects/:projectId/files`, `/files/:fileId/text` | path | list and read files |
| POST | `/api/projects/:projectId/files` (known fields only; a project, epic, story, task or topic target; an allowed `fileType`) | path | upload |
| GET | `/api/projects/:projectId/files/:fileId/download`, `/files/:fileId/versions` | path | a file's link or bytes, and its versions |
| POST | `/api/projects/:projectId/files/:fileId/versions` (known fields only; an allowed `fileType`) | path | new version |
| POST | `/api/projects/:projectId/files/:fileId/versions/:version/restore` (`expectedVersion` only) | path | restore a version |
| POST | `/api/projects/:projectId/files/:fileId/links` (`targetId`, and a `targetType` of epic, story, task or ticket) | path | link to a work item |
| DELETE | `/api/projects/:projectId/files/:fileId/links/:linkId` | path | unlink |
| DELETE | `/api/projects/:projectId/files/:fileId` | path | delete file |
| PATCH | `/api/projects/:projectId/files/:fileId/audience` (`audience` of `internal` or `external` only) | path | share a file or make it internal |
| GET | `/api/projects/:projectId/signing-requests`, `/signing-requests/:requestId` | path | list and read signature requests |
| POST | `/api/projects/:projectId/signing-requests` (known fields only) | path | request signatures |
| POST | `/api/projects/:projectId/signing-requests/:requestId/cancel`, `/signers/:signerId/remove` (`reason` only), `/remind` (`signerId` only) | path | cancel, remove a signer, remind |
| GET | `/api/resource-planning/projects/:projectId/team` | path | project team |
| POST | `/api/resource-planning/projects/:projectId/resources`, `/allocations`, `/allocations/:allocationId/level` | path | add resource, add allocation, move hours |
| PATCH | `/api/resource-planning/projects/:projectId/resources/:resourceId` | path | change a profile without a login |
| GET, PUT | `/api/resource-planning/projects/:projectId/task-access`, `/task-access/:resourceId` | path | read, set task access |
| POST | `/api/resource-planning/projects/:projectId/task-access/:resourceId/link` | path | email the access link; the body must ask for `delivery: "email"`, so no grant obtains a link to copy |
| PATCH, DELETE | `/api/resource-planning/projects/:projectId/allocations/:allocationId` | path | update, remove allocation |
| GET | `/api/resource-planning/time-entries` | query | list time |
| POST | `/api/resource-planning/projects/:projectId/time-entries` | path | log time |
| PATCH, DELETE | `/api/resource-planning/projects/:projectId/time-entries/:timeEntryId` | path | update, delete time |
| GET, POST | `/api/resource-planning/calendar-entries` | none | list, add time off |
| DELETE | `/api/resource-planning/calendar-entries/:calendarEntryId` | none | delete time off |
| PUT | `/api/projects/:projectId/sprints/:sprintId/staffing` | path | sprint capacity |
| GET | `/api/projects/:projectId/ticket-config`, `/mentionables`, `/tickets/awaiting-review` | path | ticket options, mentionable people, awaiting review |
| POST | `/api/projects/:projectId/items/:itemId/review` (only `state` `validated` or `rejected`, `expectedVersion`, and `agentCheck` absent or `true`) | path | triage |
| POST | `/api/workflows/approvals` | body | request approval |
| POST | `/api/workflows/approvals/:approvalId/decision` (body must name `projectId`) | body | decide approval |
| PUT | `/api/workflows/custom-values` | body | set field |
| DELETE | `/api/workflows/custom-values/:valueId` (body must name `projectId`) | body | clear field |
| GET | `/api/workflows/templates` | none | templates |
| POST | `/api/projects/:projectId/items/:itemId/restore`, `/stories/:storyId/split` | path | restore revision, split story |
| GET | `/api/projects/:projectId/items/:itemId/revisions` | path | revisions |
| GET | `/api/projects/:projectId/tickets` | path | list and update tickets |
| GET | `/api/projects/tickets` | none | tickets across projects |
| GET | `/api/projects/:projectId/insights` | path | timeline, Insights |
| POST | `/api/projects/:projectId/sprints/assign-items` | path | sprint assignment |
| GET | `/api/projects/:projectId/governance`, `/governance/schedule-analysis` | path | governance reads |
| POST | `/api/projects/:projectId/governance/items`, `/milestones`, `/dependencies`, `/schedule-baselines` | path | create records, baseline |
| PATCH, DELETE | `/api/projects/:projectId/governance/items/:id`, `/milestones/:id`, `/dependencies/:id` | path | update, delete records |
| PUT | `/api/projects/:projectId/governance/working-calendar` | path | working calendar |
| GET | `/api/home` | none | my work |
| GET | `/api/reporting/search` | query | search |

An approval decision and a custom-value delete name only their record in the path, so the tools put the project in the body, and Odin refuses a record that belongs to another project. Ticket create, delete, comment and link requests use the items, comments and relations routes in `route-access.js`. The memory and goal routes behind the in-app assistant's memory and monitor tools refuse MCP credentials.

### Requirements tools

Five tools let a developer's coding agent work the review loop for one Requirements track, `experience` or `architecture`. They read context, feedback and the signed-in user's own Requirements work, and upload review package drafts, adding a new draft or replacing an unpublished one. The [topic tools](#requirements-topic-tools) below administer topics and record topic decisions, and the [round tools](#review-rounds-and-reviewers) publish drafts as rounds and change their reviewers. No tool, and no route an MCP credential can reach, closes or reviews a round, edits a recorded decision, accepts a preference, drafts or approves a plan, or proposes work.

| Tool | Scope | Arguments | Result |
| --- | --- | --- | --- |
| `odin_get_requirements_context` | `projects.read` | `projectId`, `track`; optional `topicLimit` (1-50, default 10), `topicCursor` | Schema `odin.requirements-context/v1`. `brief`: citable lines with `ref` (such as `brief:requirements:0`) and how many topics cite each. `topics`: prompt, state, the active decision with its D-label, and the current Odin summary with supporter names and source refs. `decisions` and `preferences`: active ones, newest first, with D-labels. `latestRound`: number, status, due date, reviewer progress, verdict grid, direction tallies, per-screen verdict tallies, annotation counts and summaries, the round summary, and open annotations with snapshot URLs and trimmed threads. `packages`: the latest version and `nextVersion`. `plan`: the latest approved plan's acceptance criteria with D-labels. Also `truncated` and `nextSteps`. |
| `odin_get_round_feedback` | `projects.read` | `projectId`, `roundId`; optional `limit` (1-200, default 50), `cursor` | The round's feedback in the `odin.round-feedback/v1` shape from [package-spec.md section 8](requirements-gathering/package-spec.md#8-feedback-returned), plus `ok`. Annotations are paged; every page repeats the round, reviewers, directions, verdicts, answers and summaries. Pass `page.nextCursor` until it is `null`. |
| `odin_create_package_upload` | `projects.write` | `projectId`; optional `replacesPackageId`, `dryRun` (a `track` is accepted and ignored: review is project-wide) | `uploadId`, `url`, `expiresAt`, `track`, `replaces` (`packageId`, `version`) when replacing, and `upload`: method `PUT`, `Content-Type: application/zip`, single use, 10 minutes, a ready-to-run `curl` command, and what each response status means. Annotated destructive, because a replacement withdraws a draft. |
| `odin_get_package_status` | `projects.read` | `projectId`, `uploadId` | `state`: `pending`, `accepted`, `rejected` or `expired`, plus `replacesPackageId` for a replacement upload. Accepted adds `package` (version, status, uploader, and which screens changed since the last published version) and `warnings`. Rejected adds `errors` and `warnings` in the [section 7](requirements-gathering/package-spec.md#7-validation-results) shape. Every state includes `nextStep`. |
| `odin_get_my_requirements_work` | `projects.read` | `projectId` | What My items shows the signed-in user: `decide` (topics ready for them to decide and proposed preferences to accept, with decision rights), `answer` (topics they are assigned to answer), `review` (open rounds they have not submitted, with due dates) and `drafts` (their own unpublished packages). Each is `{ total, items }` with at most 25 items. Also `canDecide`, `counts` and `truncated`. Preferences are accepted and rounds reviewed in Odin. |

D-labels (`D-01`, `D-02`, ...) number every decision in the track by decision time, the same labels the Requirements tab and track plans use. `latestRound.id` is the value for a new manifest's `basedOnRoundId`, and topic ids are the values for a question's `topicId`.

**Size and markers.** The context is built for an agent's context window. The end-to-end fixture (five topics, one round with two reviewers) returns about 8 KB. With every field at Odin's own limits, the default page measured 83 KB, and the documented bound is 110 KB. Topics come 10 per page; each topic takes at most about 3.5 KB, so `topicLimit: 50` adds up to about 140 KB more. Everything cut is marked:

- clipped text ends with `…[+N chars]`;
- name and source-ref lists end with `+N more`;
- a list returned as `{ total, items }` was cut, by count or by its size budget, when `total` is larger than `items.length`;
- a summary over its size budget sets `detail` to `statements-only` (no names or refs) or `counts-only`, and `omitted` counts entries left out;
- a trimmed annotation thread keeps the opening comment and the latest two, and reports `threadTotal`;
- `truncated: true` means at least one of these happened.

Screen summaries in the context carry statements only, or counts only when a screen's summary is large. Full summaries with actor refs are in `odin_get_round_feedback`. For open annotations, the digest reads feedback 100 annotations at a time until it has ten open ones, the pages run out, or it has scanned 500. `openAnnotations.total` comes from the round's counts either way, and `openAnnotations.note` says when the scan stopped short or a page was too large to read. If topic summaries are too large to read in one request, the topics come back with only their proposed answers and `topics.note` says so.

To read more topics, pass `topics.nextCursor` as `topicCursor`. Those pages return only the topics section. Topic cursors follow the snapshot rules below: changed topics, track or project produce `stale_cursor`.

**Snapshot URLs** point at the Requirements API and open for a signed-in Odin user. MCP credentials cannot fetch them: the snapshot route is outside the MCP allowlist.

**Permissions.** Scopes never widen Odin roles. Reading needs project read access (viewer and up). Creating an upload URL needs member access (`project.collaborate`) as well as `projects.write`; without it the tool returns 404 with a hint. A `projects.read` grant gets `insufficient_scope` from `odin_create_package_upload`, including its dry run. An upload URL is bound to the user who requested it; if that user loses member access before the PUT, the PUT returns 404.

**Errors.** Besides the shared codes: `round_not_found` (unknown or inaccessible round), `invalid_cursor` (a feedback or topic cursor that does not decode), `response_too_large` from `odin_get_round_feedback` (call again with a smaller `limit`; annotations with long pen strokes are large), `upload_not_found` (unknown upload id in this project), and, from `odin_create_package_upload` with `replacesPackageId`, `package_not_draft` (the package was published, withdrawn or replaced, or a round uses it) and `package_track_mismatch` (an old `architecture`-track draft, which can no longer be replaced).

**Route allowlist.** `backend/src/mcp/route-access.js` and `backend/src/mcp/access/files.js` admit these requirements routes for MCP credentials and no others:

| Method | Path under `/api/projects/:projectId/requirements` | Used by |
| --- | --- | --- |
| GET | The base path itself (track overview with brief lines) | context |
| GET | `/tracks/:track/topics`, `/tracks/:track/decisions` | context |
| GET | `/rounds`, `/rounds/:roundId/results` | context |
| GET | `/rounds/:roundId/feedback` | context, feedback |
| GET | `/packages`, `/plans` | context |
| POST | `/packages/upload-urls` (needs `projects.write`) | create upload |
| GET | `/packages/uploads/:uploadId` | package status |
| POST | `/tracks/:track/topics` (no `assignments`) | create topic |
| GET, PATCH | `/topics/:topicId` (PATCH body rules under [topic tools](#requirements-topic-tools)) | clarification and topic tools |
| DELETE | `/topics/:topicId` | delete topic |
| POST | `/topics/:topicId/move` | move topic |
| POST | `/topics/:topicId/comments` (no stakeholder tags) | comment |
| PATCH | `/topics/:topicId/comments/:commentId` (`body` only, no stakeholder tags) | edit own comment |
| DELETE | `/topics/:topicId/comments/:commentId` | delete own comment |
| GET | `/my-items` | `odin_get_my_requirements_work` |
| GET | `/topics/:topicId/summary/history` | summary history |
| POST | `/decisions` (`outcome` `agreed`, `decided` or `deferred`) | record decision |
| POST | `/rounds` (no `closePrevious`) | publish round |
| GET, PATCH | `/rounds/:roundId` | round reviewer preview and update |

Every write needs `projects.write`. `backend/test/mcp-requirements-route-access.test.js` lists the denied routes and bodies, and the end-to-end tests send publish, close, decision-edit, accept, plan and link requests through the MCP dispatcher path and get 403 for each.

### Requirements topic tools

Eleven tools administer Requirements topics, the questions on a track's register. A topic is what the clarification tools call a clarification, so `topicId` is the same id as `clarificationId`. Read a topic's comments and its current Odin summary with `odin_get_clarification`.

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_create_requirement_topic` | write | `projectId`, `track`, `prompt`; optional `rationale`, `settles`, `sourceRef`, `suggestedOwnerRole`, `dryRun` | The new topic, open and with nobody assigned. Assign people afterwards with `odin_assign_clarification`, which confirms stakeholder invitation emails. |
| `odin_update_requirement_topic` | write | `projectId`, `topicId`, and any of `prompt`, `rationale`, `settles`, `suggestedOwnerRole` | The edited topic. Omitted fields stay unchanged. No version precondition. |
| `odin_dismiss_requirement_topic` | write | `projectId`, `topicId` | Dismisses an open topic without a decision. A decided or already dismissed topic returns 409 `topic_state`. |
| `odin_reopen_requirement_topic` | write | `projectId`, `topicId` | Reopens a dismissed topic. Any other state returns 409 `topic_state`. |
| `odin_delete_requirement_topic` | write | `projectId`, `topicId` | Deletes a topic with no comments, review round answers, decisions, stakeholder assignments or files. Otherwise 409 `topic_has_activity`: dismiss it instead. A topic asked only in a round nobody has answered can be deleted; reviewers then see that question as removed. |
| `odin_move_requirement_topic` | write | `projectId`, `topicId`, `track` | Moves the topic, with its discussion, people, summaries and decisions, to the other track. `moved: false` when it is already there. |
| `odin_add_requirement_topic_comment` | write | `projectId`, `topicId`, `body`; optional `parentCommentId` | Adds a comment or reply. Odin notifies as in the app: the author of the comment replied to gets it in their digest, and tagged users (`@[Name](user:<userId>)`) get a mention. A dismissed topic returns 409 `comments_closed`. |
| `odin_update_requirement_topic_comment` | write | `projectId`, `topicId`, `commentId`, `body` | Replaces the text of the signed-in user's own comment; Odin refuses anyone else's. Newly tagged users get a mention; stakeholders cannot be tagged. No version precondition. |
| `odin_delete_requirement_topic_comment` | write | `projectId`, `topicId`, `commentId` | Deletes the signed-in user's own comment. One with replies leaves a removed placeholder so the replies keep their place. |
| `odin_list_requirement_topic_summaries` | read | `projectId`, `topicId`; optional `limit` (1-50, default 10) | Odin summary runs, newest first, with status, failure reason, output and source descriptions; `current` marks the one Odin shows. |
| `odin_record_requirement_decision` | write | `projectId`, `topicId`, `outcome` (`agreed`, `decided`, `deferred`); optional `statement`, `supersedesDecisionId` | Records the decision as **Record a decision** does. An omitted `statement` takes the current summary's proposed answer, as the form prefills it (`statementSource: summary-proposed-answer`); without one, 400 `statement_required`. The current summary's id and source refs are attached. `warnings` repeat the form's notes, such as blocking items still open. |

**Permissions.** Creating, editing, moving, deleting and commenting need member access. Dismissing, reopening, recording a decision, and moving a topic that has a decision need decision rights (a project or workspace admin or manager). Without them the tools return 404 `topic_not_found` with a hint, as Odin hides the route.

**Decisions.** A topic holds one active decision. Recording another needs `supersedesDecisionId` set to the current one; without it the tool returns 409 `decision_exists` with `details.activeDecision` and records nothing. That is how a deferral later becomes agreed. `agreed` and `decided` resolve the topic; `deferred` keeps it open. The topic's discussion stays open after a decision.

**What stays closed.** The route allowlist accepts a topic save in exactly one of three forms: `assignments` with `expectedInvitationRecipients`, `status` set to `dismissed` or `open`, or text fields. A topic cannot be resolved without a decision. A new topic from a grant carries no `assignments`, and a comment cannot tag a stakeholder, because tagging a stakeholder who cannot see the topic invites them by email. Involve stakeholders with `odin_assign_clarification` instead. A grant can edit or delete only the signed-in user's own comments, and an edit cannot tag a stakeholder either. It cannot mark a decision `superseded` directly, edit a recorded decision, vote on comments, or refresh a summary.

### Review rounds and reviewers

Four tools publish a draft package as a round and manage who reviews it. A reviewer is `{ actorType, actorId }`: a project member with member access or above (`user`, `userId` from `odin_list_project_members`) or a project stakeholder (`stakeholder`, id from `odin_list_stakeholders`). Odin emails each new reviewer an invitation as it saves; a stakeholder's carries their Requirements portal link. Each write therefore follows a preview and saves only when `confirmInvitationEmails` lists exactly the reviewers that save emails, as refs such as `stakeholder:<id>` or `user:<id>`. Otherwise it returns 409 `invitation_confirmation_required` with the recipients in `error.details` and saves and sends nothing.

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_preview_round_publish` | read | `projectId`, `packageId`, `reviewers` (each with optional `required`); optional `dueAt`, `reminderDaysBefore`, `note` | The package, `problems` (unknown stakeholder or user, a package that is not a draft, or a round still open in the project) and `invitationEmails`: every reviewer. Writes nothing. |
| `odin_publish_round` | write | Same, plus `confirmInvitationEmails` | Publishes the draft as the track's next round, as **Publish** does in Odin: emails every reviewer, creates topics for package questions that have none, and carries open annotations forward. Returns the round with its reviewers. |
| `odin_preview_round_reviewers` | read | `projectId`, `roundId`, and any of `addReviewers`, `removeReviewers`, `setRequired`, `dueAt` (or `null`), `reminderDaysBefore` (or `null`), `note` | The round's current reviewers, `problems`, `invitationEmails` (added people who are not already reviewing) and `alreadyReviewing`. Writes nothing. |
| `odin_update_round_reviewers` | write | Same, plus `confirmInvitationEmails` | Saves the change, as **Edit round** does. A removed reviewer keeps the feedback they gave; adding them back invites them again. |

Review is project-wide: one round is open at a time across the project, and a round's questions may settle topics from either track. Publishing needs member access, and no other round may be open. Closing a round records a round decision and stays in Odin, so `odin_publish_round` cannot close the open round, and the allowlist refuses a publish that carries `closePrevious`. Each publish or added reviewer sends email at once: after `outcomeUnknown`, read `odin_get_requirements_context` before trying again.

## Uploading a review package

The zip never passes through MCP, so the 1 MB MCP request limit does not apply. The upload URL takes the raw zip, up to `REVIEW_PACKAGE_MAX_BYTES` (50 MB by default).

1. Call `odin_create_package_upload` with `projectId`. The URL is under `BACKEND_PUBLIC_URL`, at `/api/public/requirements-uploads/<token>`. The token is the only credential: treat the URL as a secret.
2. Within 10 minutes, PUT the zip to that URL:

   ```sh
   curl --fail-with-body -X PUT -H "Content-Type: application/zip" --data-binary @package.zip "<url>"
   ```

   In Windows PowerShell 5.1, run `curl.exe`. `application/x-zip-compressed` and `application/octet-stream` are also accepted.
3. Read the response, or call `odin_get_package_status` with the `uploadId`:

   | PUT status | Meaning | Next step |
   | --- | --- | --- |
   | 201 | Accepted and stored as the next draft version. | A person previews and publishes it. |
   | 422 | Rejected. The body lists `errors` and `warnings`; nothing was stored. | Fix the package and request a new URL. |
   | 404 | The URL expired or was already used. | Request a new URL. |
   | 409 | Replacement URLs only: the draft was published, withdrawn or replaced before the zip arrived. Nothing was stored; `odin_get_package_status` reports `rejected` with `package_not_draft`. | Read the context again before uploading. |
   | 415 | Wrong `Content-Type`. | PUT again with `application/zip` (the URL is still unused). |
   | 429 | Rate limited. | Wait for `Retry-After`. |

Once Odin starts validating a zip, the URL is spent, whether the package is accepted or rejected, so the next attempt needs a new URL. A wrong `Content-Type` (415) or a body over the size limit (422 with one `zip_limit` error) is answered before that point. The agent needs a way to make an HTTP PUT, such as a shell or an HTTP tool; a chat-only client without one can read context and feedback but cannot upload.

**Replacing a draft.** To correct a draft before anyone publishes it, call `odin_create_package_upload` with `replacesPackageId`: the draft's id, which is `packages.latest.id` in the context when its status is `draft`, or `package.id` from `odin_get_package_status`. The draft must be unpublished and not used by a round; otherwise the call returns 409 or 400 and no URL is issued. When the zip is accepted, it becomes the next draft version, and the replaced draft becomes `withdrawn` in the same database transaction; its files are deleted and its record stays. A rejected zip leaves the draft as it was. Odin checks the draft again when the zip arrives: if someone published, withdrew or replaced it in the meantime, the PUT returns 409 and stores nothing. Published packages and their rounds are never replaced. Members can do the same in the app with **Replace** on a draft's page.

## Closing the review loop

A walkthrough for one Experience round. The same steps apply to the Functional track (`architecture`).

1. **Read the track.** Call `odin_get_requirements_context` with `{ "projectId": "<project>", "track": "experience" }`. `latestRound` and `packages` are the project's, whichever track you read. Note `latestRound.id`, the open annotations, the screen and round summaries, the decisions and preferences with their D-labels, and `packages.nextVersion`.
2. **Build the package.** Follow the [agent guide](requirements-gathering/agent-guide.md) and [package-spec.md](requirements-gathering/package-spec.md). An agent outside this repo gets both, the examples, and the validator in the package kit, which a person downloads from the project's Review tab ("Download package kit"); "Copy agent instructions" there gives the project's ids and topics in one block. Keep a screen's `id` when it is the same screen: open annotations on an unchanged screen carry forward, and those on a changed screen are marked outdated for their authors to review. Set `basedOnRoundId` to `latestRound.id`, and link questions to topics with `topicId`.
3. **Validate it locally.** In the package kit, run `npm install`, then `node validate.mjs package.zip --track experience` (in this repo: `node tools/review-package/validate.mjs ...`). Exit code 0 means Odin would accept it, except for the topic lookups and malware scan that need the project. The kit's validator also skips Mermaid, which Odin checks at upload.
4. **Create an upload URL.** Call `odin_create_package_upload` with the project.
5. **PUT the zip** to the returned `url` with the `curl` command from the result.
6. **Check the status.** Call `odin_get_package_status` with the `uploadId`. `accepted` shows the new draft version and which screens changed. `rejected` lists per-file errors: fix them and go back to step 3 with a new URL. To correct an accepted draft before it is published, upload the fix with `replacesPackageId` set to the draft's id, so it replaces the draft instead of sitting beside it.
7. **Publish.** Someone on the team previews the draft in Odin's Requirements tab and publishes it as a round, choosing reviewers and a due date. An agent can do the same with `odin_preview_round_publish` and `odin_publish_round`, confirming the reviewers it emails. A person with decision rights closes the previous round first.
8. **Read the feedback.** As reviewers respond, call `odin_get_round_feedback` with the round id, following `page.nextCursor`, or read the digest again with `odin_get_requirements_context`. Admins and managers record decisions in Odin or with `odin_record_requirement_decision`, and accept preferences in Odin; the next context read shows them with D-labels. Start the next version at step 1.

## Clarifications, stakeholders and project members

Fourteen tools cover the people side of the Requirements workflow: who owns each clarification, which stakeholders are involved and invited, and who belongs to the project. They call the routes behind Odin's Assign people dialog, Project stakeholders panel, Stakeholder links page and Permissions dialog, with those routes' own permission checks. Clarifications are Requirements topics: a topic's single **owner** is its primary assignment and its **also involve** people are collaborator assignments. Each person is `{ actorType, actorId }`, where `actorType` is `user` (a workspace user, `userId` from the member list) or `stakeholder` (a project contact).

| Tool | Scope | Arguments | Result and rules |
| --- | --- | --- | --- |
| `odin_list_clarifications` | read | `projectId`, `track`; optional `view` (`all`, `needs-decision`, `open`, `decided`, `dismissed`), `search`, `limit`, `cursor` | Topics with `owner`, `alsoInvolve` (stakeholders add `invitationStatus`), status and state, active decision and Odin's proposed answer. Local snapshot pages. |
| `odin_get_clarification` | read | `projectId`, `clarificationId` | One topic with the same fields plus its comment thread (comments and email replies, with ids for replies), decisions, attached file names and current Odin summary. |
| `odin_preview_clarification_assignment` | read | `projectId`, `clarificationId`, `owner` and/or `alsoInvolve` | Current and proposed people, `changes`, `problems`, `invitationEmails` (who the save adds to their invitation digest, each with `digest.sendsAfter` and `digest.otherWaitingTopics`) and `delivery`. Writes nothing; write permission is not checked. |
| `odin_assign_clarification` | write | Same as preview, plus `confirmInvitationEmails` | Saves the owner and also-involve list and puts newly invited stakeholders into their digests. An omitted field keeps its current value; `owner: null` and `alsoInvolve: []` clear. The owner never also appears as involved. Unchanged lists are not saved again. |
| `odin_list_stakeholders` | read | `projectId`; optional `search`, `limit`, `cursor` | Contacts (`id`, `name`, `email`, `roleTitle`) with each clarification they are assigned to, their role there, and the invitation status (`scheduled`, `pending`, `sent` or `failed`) and times, plus `pendingDigest` (waiting topics and `sendsAfter`), `reviews` (each review round they review: track, number, title, round status, due date, required, invitation status and `submittedAt`) and the project's `invitationDigest.quietMinutes`. |
| `odin_add_stakeholder` | write | `projectId`, `input`: `name`, `email`, optional `roleTitle` | Adds a contact. Odin keys contacts by email, so an existing email keeps its id and takes the new name and title (`updatedExisting`, `previous`). Sends no email. |
| `odin_update_stakeholder` | write | `projectId`, `stakeholderId`, and any of `name`, `email`, `roleTitle` | Edits the contact and returns it with `previous`. A new name also replaces the name shown on their topic assignments and comments. A new email takes effect for the next email Odin sends them; links and reply addresses already sent keep working. An email another contact on the project uses returns 409 `stakeholder_email_taken`. Sends no email. Needs plan-edit permission and a workspace admin or manager role. |
| `odin_list_stakeholder_links` | read | `projectId`; optional `limit`, `cursor` | Each stakeholder's Requirements portal link: status, issue, expiry, extension and last-use times, pending "request a new link" time and token metadata. |
| `odin_preview_stakeholder_invitation` | read | `projectId`, `stakeholderId` | Recipient, current link and outcome: `create-link`, `issue-additional-token` (earlier tokens keep working) or `reactivate-link`, plus the stakeholder's `pendingDigest`, which the link email does not affect. Writes nothing. |
| `odin_send_stakeholder_invitation` | write | `projectId`, `stakeholderId`, `confirmRecipientEmail` | Emails the stakeholder a portal link now, without sending, cancelling or delaying a pending clarification digest. Returns the email result, outcome, token id and link metadata. |
| `odin_revoke_stakeholder_link` | write | `projectId`, `linkId` | Revokes the link and its tokens. A later invitation reactivates it with a new token. |
| `odin_extend_stakeholder_link` | write | `projectId`, `linkId`, `until` (ISO 8601 with offset) | Keeps the link open until a future time at most 365 days ahead. Revoked links cannot be extended. Sends no email. |
| `odin_list_project_members` | read | `projectId`; optional `search`, `limit`, `cursor` | Members (`userId`, name, email, project role, workspace role), workspace users who could be added (paged), and the assignable roles with their capabilities and decision rights. |
| `odin_update_project_members` | write | `projectId`, `input`: `upsert` (`userId`, `role`) and/or `remove` (`userId`s) | Adds users with a role, changes members' roles, removes members. |

**Invitation emails.** Saving a topic's assignments invites each newly assigned stakeholder through a digest: Odin collects a stakeholder's new assignments in one project and emails one message once more than 20 minutes pass without another new assignment for them there. Every new assignment pushes the digest back, with no maximum wait; the UI and MCP saves behave the same way. A digest lists every clarification the stakeholder was assigned and not yet emailed about, each once, with a fresh Requirements portal link. One clarification reads like the earlier single invitation, and replying reaches it; with several, each shows its own reply address and the email has no Reply-To. Delivery re-checks each clarification, so removed assignments, closed or dismissed clarifications, revoked links and missing email addresses are left out; if the address, the link or a clarification changes while the email is being prepared, that attempt is cancelled before sending and the next run uses the current state. The quiet period is `CLARIFICATION_DIGEST_QUIET_MINUTES` (20 by default; 0 sends at the next mail run) and is reported as `invitationDigest.quietMinutes` and in the preview's `delivery`. If the mail job stops while a digest is being handed to the mail server, Odin cannot tell whether it was accepted and sends it again later, so a stakeholder may rarely get the same digest twice; a digest is not silently dropped.

The preview lists the stakeholders a save invites in `invitationEmails`, with reason `new-invitation`, or `unsent-invitation` for an invitation Odin created earlier but never scheduled or sent, and with `digest.sendsAfter`, the earliest time the digest can go out if nothing else arrives. A stakeholder already waiting in a digest for that clarification, or already emailed about it, is not invited again and does not push the digest back. `odin_assign_clarification` saves only when `confirmInvitationEmails` lists exactly those stakeholder ids (empty when nobody new is invited). Otherwise it returns 409 `invitation_confirmation_required`, saves nothing, and puts the recipients in `error.details`. Odin enforces the confirmation itself: the save carries the confirmed ids as `expectedInvitationRecipients`, Odin checks them against the clarification's invitations in the same atomic step as the save (on locked invitation rows in MySQL), and it schedules only those stakeholders. If the clarification changed after the tool's reads so that the recipients differ, the save also returns 409 `invitation_confirmation_required` and nothing is saved or scheduled; preview again. `expectedInvitationRecipients` is an optional field of Odin's topic save, accepted only alongside `assignments`; the Assign people dialog does not send it.

**Stakeholder links.** `odin_send_stakeholder_invitation` is the deliberate immediate send: it emails the portal link at once and leaves any pending digest as it is, so the digest's clarifications are still emailed once, on their own schedule. It sends only when `confirmRecipientEmail` matches the stakeholder's current email (409 `recipient_mismatch` otherwise). Each call issues another token and sends another email, so never retry it blindly; after `outcomeUnknown`, look for a new invitation token in `odin_list_stakeholder_links` first. No tool returns a portal URL or token, and an MCP grant cannot create a link without Odin emailing it. If Odin issued the token but could not queue the email, the result says `email.sent: false` and a person can copy a fresh link in Odin or revoke it.

**Members.** Odin's member save replaces the whole list. `odin_update_project_members` reads the current list, applies the requested changes and sends every other member back unchanged, including allocation and bill rate, which the member tools never return. Nothing is saved, with 400 `invalid_member_change`, when an added user is not in the workspace or a removed user is not a member. It also refuses, with 409 `members_need_explicit_change`, when the save would change a member the request did not mention: a stored role the save does not accept (older memberships can hold `viewer`, for example) or a member who has left the workspace, whom the MySQL save drops. Name those members in `upsert` or `remove`. Assignable roles are `admin`, `manager` and `user`; workspace admins and managers reach every project without membership. Removing yourself or your own admin role can end your access.

| Operation | Odin rule |
| --- | --- |
| Read clarifications, preview an assignment, list stakeholders | Project read (viewer and up) |
| Save an assignment | Member access (`project.collaborate`) |
| Add a stakeholder | Plan edit and a workspace admin or manager role (403 otherwise) |
| List, preview, send, extend or revoke stakeholder links | Decision rights: a project or workspace admin or manager |
| List members | Plan edit |
| Change members | Project admin |

Callers without access get Odin's usual 404. Hosted grants also need `projects.write` for writes, and project-restricted grants reach only their projects, including the `/api/assistant/projects/:projectId` routes.

**Concurrency.** Apart from the recipient check, Odin has no version precondition for assignments, contacts, links or members. The assignment and member tools read and then replace, so concurrent edits that email nobody new are last-writer-wins. Writes are never retried.

**Tokens.** Odin's stakeholder read carries portal, invitation and reply tokens. These tools build every result from an explicit list of fields; no result contains a token or portal URL.

**Errors.** Besides the shared codes: `clarification_not_found`, `invalid_assignment` (unknown stakeholder, or a user outside the workspace), `invitation_confirmation_required`, `stakeholder_not_found`, `recipient_mismatch`, `link_not_found`, `link_revoked`, `invalid_extension`, `invalid_member_change` and `members_need_explicit_change`. Where it helps, `error.details` lists the people involved.

**Route allowlist additions.** MCP grants reach these routes and no neighbouring ones:

| Method | Path | Used by |
| --- | --- | --- |
| GET, PATCH | `/api/projects/:projectId/requirements/topics/:topicId` | get, preview and assign, and the [topic tools](#requirements-topic-tools). A PATCH that saves people must contain exactly `assignments` and `expectedInvitationRecipients`, so a grant cannot save people without Odin's recipient check. |
| GET | `/api/assistant/projects/:projectId/clarifications` | stakeholder reads and previews |
| POST | `/api/assistant/projects/:projectId/stakeholder-contacts` | add stakeholder |
| PATCH | `/api/assistant/projects/:projectId/stakeholder-contacts/:stakeholderId` | update stakeholder |
| GET, POST | `/api/projects/:projectId/requirements/links` | list links, preview and send. POST requires `send: true`. |
| POST | `/api/projects/:projectId/requirements/links/:linkId/revoke`, `/extend` | revoke, extend |
| GET | `/api/projects/:projectId/valid-users` | list members, update members |
| PUT | `/api/projects/:projectId/permissions` | update members |

Not exposed: drafting clarification questions with Odin's AI, deleting stakeholder contacts (Odin has no route for it), sending a pending digest early, workspace invitations and workspace roles. Creating, editing, moving, dismissing and deleting topics are in the [topic tools](#requirements-topic-tools).

## Dry runs, conflicts and pagination

Most dry runs validate **input structure only**. They make zero API calls and return the parsed request, including defaults, with `validation: "schema_only"` and `authorizationChecked: false`. They do not check authentication, resource existence, hierarchy, assignees, dates against application state, workflow transitions, versions, legal holds or notifications. A structurally valid preview may fail when applied. Invalid date strings that match Odin's date pattern may also pass its input schema. Dry runs do not establish application acceptance.

The dry runs of the bulk planning tools, `odin_update_ticket` and the governance tools return `dryRun: true` and the request, without those two fields. Most of them read current state first, to find versions, parents, assignees and linked items, so they can fail on a missing record or a duplicate dependency; they still write nothing. Only `odin_create_governance_item`, `odin_create_schedule_baseline`, and `odin_create_milestone` without a `workItemId` make no calls. `odin_preview_clarification_assignment`, `odin_preview_stakeholder_invitation`, `odin_preview_round_publish` and `odin_preview_round_reviewers` are different again: they are read tools that read current state, show who would be emailed and write nothing.

The hosted transport still authenticates the client and enforces its read/write scopes before calling any tool, including a preview. `authorizationChecked: false` describes resource and application authorization; it does not mean an unauthenticated client can call the hosted endpoint. A schema-only preview makes zero REST calls, while the transport's credential checks still read the authentication repositories.

Read `updatedAt` immediately before replacing project metadata. Read an item's `version` immediately before update/delete. Stale preconditions return 409. Project timestamps advance monotonically, including on MySQL schemas with second precision; the timestamp serves as a concurrency token and may run ahead of wall time during rapid writes. Tools that read a version for you (bulk updates, tickets, governance, approvals, custom fields and revision restores) send the version they just read, so they catch only a change made between that read and their write; `odin_update_items` retries such a 409 once. Comments, Kanban config and board order, sprints, sprint assignment and capacity, story splits, clarification assignments, stakeholder contacts and links, and project members have no API revision precondition. Concurrent saves remain last-writer-wins; MCP does not invent atomic guarantees for them.

Project, item, comment, board, sprint, file, approval and custom-field-value REST collections are fetched in full and sliced locally. Cursors bind an offset to a hash of the returned collection and query scope. Changed content or filters produce `stale_cursor`; malformed cursors produce `invalid_cursor`. Permission changes invalidate a cursor when they change the returned snapshot; they can instead deny the read. Restart pagination after a stale cursor. Workflow discovery uses the API's offset pagination and does not promise a stable snapshot. Pagination bounds MCP result counts, not the upstream REST query; very large projects can hit the response limit. Comment threads remain whole and may be large.

Errors return `isError: true` and structured JSON with a safe code/message. Raw upstream error text, details, HTML and stacks are suppressed. For a timeout, broken response, redirect or server failure during a write, `outcomeUnknown: true` means the write may have applied. Read current state before deciding what to do. The adapter never retries a write whose outcome is unknown (only `odin_update_items` retries, after a definite 409), and the API offers no general idempotency key. Successful Odin descriptions/comments are user content, not instructions for the client.

## Local validation

```powershell
npm run test:mcp
node --test --test-concurrency=1 --test-timeout=30000 backend/test/mcp*.test.js backend/test/projects-status-bridge.test.js
npm run test:pr
```

The MCP tests use SDK clients, linked transports, disposable loopback HTTP servers and a child stdio process against the real Odin application routes with in-memory repositories. They log in through Odin, discover all 151 tools, check workflow and version conflicts, target-scoped comments, authorization, foreign tenants, revoked sessions, pagination and schema-only previews. HTTP servers and child processes are closed and checked during cleanup. They do not read application `.env` files or production records.

The requirements tests cover the review-loop tools. `mcp-requirements-e2e.test.js` runs AC-14 over HTTP with an OAuth test client against the in-process app: a read grant gets context and feedback, a write grant creates an upload URL, PUTs the template package built by `tools/review-package/build-examples.mjs`, and sees draft version 2, an expired URL returns 404, and publish and decide requests through the MCP path get 403. `mcp-requirements-tools.test.js` checks request composition, result shapes, truncation markers, the measured size bound, cursors and error mapping against a fake API. `mcp-requirements-route-access.test.js` checks the allowlist. `mcp-requirements-topics-e2e.test.js` covers topic administration and decisions, and `mcp-file-e2e.test.js` and `mcp-file-requirements.test.js` cover `odin_get_my_requirements_work` and editing or deleting only one's own topic comments.

The clarification, stakeholder and member tests use the same disposable setup. `mcp-collaboration-e2e.test.js` signs in OAuth clients as workspace and project roles, changes members while preserving allocation and bill rate, adds contacts, previews and saves owners and also-involve lists, sends, extends and revokes links, and checks Odin's permission rules, the confirmation refusals, the dispatcher-path denials and that no result carries a token. Mail goes only to an in-memory queue, which the test inspects; the app under test has no mail transport. It also interposes a native save between a tool's reads and its save, and checks that the save is refused without emailing anyone. `mcp-collaboration-invitation-precondition.test.js` checks the recipient rule, the native schema, the in-memory and MySQL save preconditions (a SQL double for the locked read and rollback) and the mail filter. `mcp-collaboration-tools.test.js` checks request composition, recipient computation, token stripping, member read-modify-write and error mapping against a fake API, and `mcp-collaboration-route-access.test.js` checks the allowlist and body guards.

The area tools follow the same pattern. `mcp-ticket-e2e.test.js`, `mcp-workflow-e2e.test.js`, `mcp-file-e2e.test.js`, `mcp-resource-e2e.test.js` and `mcp-workspace-e2e.test.js` sign OAuth clients in against the in-process app and use each area's tools through Odin's routes and role rules, including grants limited to one project. The matching `mcp-*-tools.test.js` files check request composition and error mapping against a fake API, and the `mcp-*-route-access.test.js` files check each area's allowlist and body rules. `mcp-d027-hidden-tickets.test.js`, `mcp-d027-insights.test.js` and `mcp-r3-governance-visibility.test.js` check that a ticket from outside the team that nobody has validated stays out of files, revisions, Home, Insights and governance answers. `mcp-comment-mentions.test.js` covers mentions, `mcp-change-scope.test.js` the project-wide rule and item limit, `mcp-file-api.test.js` and `mcp-file-documents.test.js` reading text, PDFs and Word documents, and `mcp-r3-resource-grant.test.js` what a grant limited to one project sees of the team. The memory and monitor tests cover tools only the in-app assistant has.

The hosted SDK tests discover OAuth metadata, complete PKCE authorization, request write scopes explicitly, force access-token expiry, refresh automatically and perform a write afterward. Consent and administration browser tests use synthetic authorized data on desktop Chromium, portrait-mobile Chromium and WebKit. No deployed HTTPS endpoint, reverse proxy or live identity provider was tested.

The project-version and OAuth transaction regressions use SQL test doubles. Real MySQL persistence/concurrency checks require the repository's isolated database profile and an explicitly supplied local `odinpmp_test_{runId}` URL. OAuth's integration test additionally rejects non-loopback database hosts. Expiry is enforced during authentication, but no background cleanup of expired OAuth records was installed. See [the test runner instructions](../tools/test/README.md).
