# Odin

Odin is one system for planning, requirements gathering, delivery and bug fixing on software projects built with clients. This glossary fixes the words for Odin's concepts. Where the code uses another name, the entry says so.

## Workspace and people

**Workspace**:
The top-level account that holds a group's projects, people and settings. In code it is a tenant (`tenants`, `tenantId`).
_Avoid_: Tenant (outside code), organization, account

**Workspace role**:
A person's role in a workspace: user, manager or admin.

**Member**:
A person on a project's team, with the project role user. The project roles are admin, manager and member (stored as `user`).
_Avoid_: Team member (for stakeholders or resources)

**Decision rights**:
The right to record requirements decisions, close review rounds, approve requirements plans and manage stakeholder links. Project and workspace admins and managers hold it.

**Stakeholder**:
A person outside the team who has a say in a project: answering topics, reviewing rounds, signing documents. A stakeholder is identified by email and has no workspace account.
_Avoid_: Client (for the person; the billing client is a different thing)

**Guest**:
A stakeholder admitted to one or more channels, signed in with an emailed code.

**Resource**:
Anyone who owns work on a project, whether or not they have a login. Allocations, time and capacity are planned against resources.

**Consulting module**:
An optional workspace module that adds engagements, pursuit and billing.

## Projects and work

**Project**:
The container for a piece of delivery work: its brief, work items, sprints, files and people.

**Engagement**:
A project of kind `engagement`: a prospective piece of work, won or lost before delivery starts, that can be converted into a delivery project.

**Pursuit**:
An engagement's pre-sale tasks, kept on their own board apart from delivery work.

**Brief**:
A project's structured definition: objective, current state, proposed solution, benefits, and lists of requirements, constraints, assumptions, dependencies and success metrics.
_Avoid_: Project charter

**Work item**:
An epic, story, task or ticket. All four are rows in the `tasks` table, told apart by `task_type`.
_Avoid_: Card (except for its tile on the board), item (alone, in prose)

**Epic**:
The top level of the planning hierarchy. It groups stories.

**Story**:
A unit of value under an epic. Stories carry points, can be split, and bill to an SOW milestone.

**Task**:
A unit of work under a story. A task always has a parent story.

**Plan**:
A project's epics, stories and tasks: how its work is broken down.
_Avoid_: Work breakdown, backlog (the backlog is only the work not in a sprint)

**Ticket**:
A work item that reports a defect, a support need, a question or a change request, with a severity from S1 to S4. Tickets stay off the sprint board unless someone adds them.
_Avoid_: Bug (for tickets in general)

**Ticket validation**:
The step where a person accepts or rejects a ticket submitted from outside the team before anyone else sees it.
_Avoid_: Review (for tickets)

**Intake link**:
A project's public page where outside reporters file tickets.

**Revision**:
A stored past state of a work item, which can be restored. The UI shows revisions as History.

**Work item relation**:
A link between two work items, for example a ticket to the story it affects.

**Sprint**:
A time box of committed work, activated and then completed, with capacity planned per person.

**Board**:
A project's Kanban board: work items as cards in status columns. "Kanban board" is fine too.

## Governance and workflows

**RAID log**:
A project's register of risks, assumptions, issues, decisions and change requests. Each entry is a governance item.

**Milestone**:
A dated project target with the status planned, at risk, achieved or missed. A project or a milestone can be signed off.
_Avoid_: Milestone (alone) for an SOW milestone

**Dependency**:
A scheduling link between two work items: finish-to-start, start-to-start, finish-to-finish or start-to-finish.

**Working calendar**:
A project's working days and holidays, which schedule analysis counts in.

**Schedule baseline**:
A frozen copy of a project's schedule that later forecasts are compared against. It can't be removed.
_Avoid_: Baseline (alone)

**Workflow**:
A set of states (grouped as backlog, active, done or cancelled) and the transitions between them, bound to projects.

**Approval**:
A sign-off that a workflow transition requires before it can happen.
_Avoid_: Sign-off (that word belongs to signing requests)

**Custom field**:
A typed field a workspace adds to work items.

## Requirements gathering

**Track**:
One of a project's two lines of requirements work: Experience, or Functional. In code the Functional track is `architecture`.
_Avoid_: Architecture track

**Topic**:
A question a project must settle, discussed by the team and stakeholders until it is resolved or dismissed. In code it is a clarification (`project_clarifications`).
_Avoid_: Clarification, question

**Owner**:
The person a topic is assigned to, stored as the assignment role `primary`. Others can be `required` or `collaborator` (shown as "Also involve").

**Decision**:
A recorded outcome of a topic, a preference or a review round, with the status agreed, decided, deferred or superseded. Decisions are numbered (D-07) so plans can cite them.
_Avoid_: Decision (alone) for a RAID decision or an assistant confirmation

**Preference**:
A stakeholder's stance on one aspect of a screen (keep, change or undecided), which can be accepted as a decision.

**Review package**:
A zip of screens, prototypes, directions and questions, described by a manifest. It is a draft until it is published as a round.

**Package kit**:
The downloadable starter for building a review package: the spec, the schema, an example and a validator.

**Review round**:
A published review package in front of its reviewers. A project has at most one open round.
_Avoid_: Review (alone)

**Direction**:
One of several alternative approaches in a round, which reviewers rate preferred, acceptable or rejected.

**Mark**:
A shape a reviewer draws on a screen, with its comment thread. In code it is an annotation.
_Avoid_: Annotation, pin

**Carry-forward**:
Moving an unresolved mark onto the next version of its screen.

**Odin summary**:
An AI summary of a topic, a screen or a round, refreshed as the discussion changes.

**Requirements plan**:
A track's objective, scope, non-goals and acceptance criteria, each criterion citing the decisions behind it. Once approved, it proposes work items for the plan.
_Avoid_: Plan (alone), which means the epics, stories and tasks

**Client portal**:
The pages a stakeholder opens from their stakeholder link: the topics waiting for them, review rounds, shared documents and signing requests. In code it is the requirements portal (`/requirements/:token`).
_Avoid_: Stakeholder portal, requirements portal

**Stakeholder link**:
A private link that opens the client portal for one stakeholder, without an account.

**Invitation digest**:
One email per stakeholder that gathers their new topic assignments, sent once a quiet period passes with no new ones.

## Collaboration

**Channel**:
A project's chat room. It also holds a folder of files (its library) and can admit guests.

**Post**:
A message in a channel or a direct message. A reply is a post in a post's thread, one level deep.
_Avoid_: Message (in code and docs)

**Direct message**:
A private conversation between workspace people, outside any channel. In code it is a direct conversation.
_Avoid_: DM (in prose)

**Odin Chat**:
The chat app at `/chat`, which shows channels and direct messages across projects.

**Odin tag**:
`@odin` in a post. It runs one assistant turn, answered in the post's thread.

## Files and signing

**File Vault**:
Every file in a project, wherever it was added: the project itself, a channel or a work item. The project menu labels it Files, and both names are fine. In code it is the vault.

**Audience**:
Whether a file is internal (the team only) or external (shared with the project's stakeholders in the client portal).

**File version**:
One stored upload of a file. Earlier versions stay until someone deletes them.

**Signing request**:
A request for stakeholders to sign: an acceptance of documents, or a sign-off of a project or a milestone. It freezes the exact file versions it covers.
_Avoid_: Signature request

**Signer**:
A stakeholder asked to sign a signing request, who signs in the client portal with an emailed code.

**Seal**:
An HMAC over a signature record under a server key. It proves the record hasn't changed.

## AI

**AI Workspace**:
The screen where people work with the assistant.

**Assistant**:
Odin's tool-using agent. It acts by calling Odin's REST API as the signed-in person, with that person's permissions.

**Turn**:
One run of the assistant in answer to one message: triage, tool calls, checks and a reply.

**Confirmation**:
A pause in a turn before an action that is hard to take back, until the person approves or declines it.

**Proposal**:
Staged work from the assistant that the person applies or dismisses.

**Undo**:
Reversing the changes a reply made.

**Agent goal**:
An outcome the assistant works toward without someone watching, checked by a verifier.

**Monitor**:
A scheduled, read-only check by the assistant that reports what needs attention.

**Memory**:
What the assistant remembers across chats: decisions, risks, preferences, outcomes and facts, each with its source.

## Portfolio, resources and finance

**Portfolio**:
A tree of portfolios and programs that groups projects, with objectives, key results and scenario plans.

**Allocation**:
Hours a resource is planned to spend on a project over a period.

**Time entry**:
Hours a person logged on a work item. A time entry on an invoice is locked.

**Time off**:
Leave, a holiday, or a working-day override for a resource.

**SOW milestone**:
A billing milestone from a project's statement of work in invoice-gen. Each story bills to at most one.
_Avoid_: Milestone (alone)

**Task access link**:
A link that lets someone without a login see and update their own tasks (or all tasks) in a workspace.

## Insights and integrations

**Health signal**:
A rule-based reading of a sprint, a person or a project: on track, watch, or at risk. In code at risk is `behind`, and a sentence may still say that a sprint or a person is behind.
_Avoid_: Behind (as the label)

**Change feed**:
A project's ordered log of changes, which agents read from a cursor to stay in step.

**MCP server**:
Odin's endpoint for outside agents (ChatGPT, Codex, Claude). Its tools call the same REST API the app uses.

**Connector**:
A configured link to an outside system that brings records in or sends changes out.

**Bug Reporter**:
A separate service that adds a bug capture widget to any website. Each report becomes an Odin ticket.

**FaultLine**:
A separate service that triages bugs and production errors, verifies fixes and opens pull requests.
