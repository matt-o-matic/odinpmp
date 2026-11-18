# The Odin assistant

The AI Workspace's assistant is a tool-using agent. It answers questions and makes changes in Odin by
calling Odin's own REST routes as the signed-in user, so permissions, versions, workflow rules and
notifications are exactly what that person gets in the UI. It is tuned for gpt-6-luna: checks around
the loop help a capable but not top-tier model finish its work well without blocking answers. The
workspace chooses the model (see [Settings](#settings)).

## A turn

1. **Message.** `POST /api/assistant/chats/:chatId/messages` saves the message, starts the turn in the
   turn queue and answers 202. The turn streams over the chat's event channel
   (`GET /api/assistant/chats/:chatId/events`).
2. **Session.** The turn mints a short-lived session for the user. Tool calls use it over loopback,
   and it is revoked when the turn ends (`agent-chat.service.js`, `createAgentSessionOpener`).
3. **Triage.** One Decisions API call answers predicate questions (`agent-decisions.js`):
   - Is the message simple, does it ask for changes, does it need several steps, does it need the web?
     An answer to the assistant's question about a change it is making counts as asking for it. A
     question that needs a schedule, plan or project-wide analysis worked out is not simple: "what
     do we need to do to finish by Oct 30?" once read as a direct question and ran at `high`.
   - Which catalog operations does it probably need?

   Simple messages run at `ASSISTANT_REASONING_SIMPLE` (`max`). A message that is not simple, or
   that needs several steps, runs at `ASSISTANT_REASONING_COMPLEX` (`max`). A change right after
   such a turn carries that work on at `max`, however short it is (`run.previousTriage`): a "go
   ahead" to the assistant's proposal, or the answer to its question. If the Decisions API is
   unavailable, word rules decide instead, and keyword groups pick up to 4 operations.
4. **Context.** The turn's notes (`buildTurnContext` in `agent-prompt.js`) go in a developer message
   just before the user's message. They carry:
   - who the user is and the date;
   - the user's role and what it lets them change (see [Who decides](#who-decides));
   - the page and the item on screen;
   - a project snapshot (counts, status, owners, overdue work, the active sprint, per-epic progress);
   - triage's hints;
   - the budget;
   - the operations that look relevant, with their inputs.
5. **Loop.** The model answers or calls tools, several at once if it likes; results go back, and
   this repeats until it answers (`odin-agent.js`). Replies stream as `assistant.delta`
   (`assistant.reset` clears a reply the completion check sends back); tools stream as
   `tool.started` / `tool.completed`; the plan streams as `plan.updated`.
6. **Saved.** The reply is stored as written. A light markdown fixer only adds missing line breaks
   and drops citation markup the model writes as text, which showed as "citenone"
   (`agent-markdown.js`). A chat not tied to a project moves to the project the turn created with
   `odin_create_project`. `turn.completed` carries the chat.

## Who decides

- **Role.** Each turn's notes give the user's project and workspace roles and what they let them
  change. `projectStanding` (`lib/auth/project-standing.js`) works it out, and
  `GET /api/projects/:projectId` returns it as `permissions`. Admins and managers run their
  projects, so what they decide about one is settled.
- **Project-wide changes.** Without admin or manager rights (by project or workspace role), MCP
  tools refuse project-wide changes, and the assistant's tools are MCP tools (`mcp/change-scope.js`).
  These are the project's settings, dates and brief, its sprints, board setup, milestones,
  dependencies, working calendar and schedule baselines, and more than 10 work items in one turn.
  Bulk tools are refused whole, before their first write. Project roles `member`, `user` and
  `viewer`, without a workspace admin or manager role, cannot edit the plan at all; Odin's routes
  refuse them.
- **Asking or telling.** A message that tells the assistant to do something gets done at once. One
  that asks something (a question, what it would take to reach a goal, a report that something is
  wrong) gets an answer and, when changes would help, a proposal: the specific changes the
  assistant would make itself. It makes them once the user agrees. Before this, an admin asked what
  it would take to finish by Oct 30 and got a to-do list for themselves.

## Tools

- **Core tools** are offered every turn, always the same 9 (`CORE_TOOL_NAMES`): project overview,
  find items, read an item, create a whole branch of work, bulk updates, comments, workspace
  search, the user's own work, and the project list. The assistant's own tools come with them:
  `odin_query`, `update_plan`, `odin_operations`, `odin_describe`, `odin_run` and
  `odin_undo_turn`, plus web search when the chat has Web research on.
- **Relevant operations.** Triage scores every other operation against the request. Up to 4 scoring
  0.6 or more are described in the turn's notes, with their inputs, so the model can run them
  directly. They are not added as tools, so the tool list stays fixed.
  - Triage and search match a request against each operation's plain-language `purpose` in the
    catalog. When the Decisions API is unavailable, keyword groups in `agent-tools.js` pick
    instead; a test checks that every tool they name is in the catalog.
  - Single-item versions of the core tools are never promoted.
  - On 16 typical requests this took precision from 0.26 to 0.71 and recall from 0.60 to 0.75.
- **Queries.** `odin_query` runs one read-only SQL query (SQLite) over Odin data (`odin-query.js`).
  It's the agent's pipes: counts, totals, groupings, joins and multi-field filters come back exact
  in one call, instead of many reads followed by counting in the model's head.
  - **Tables:** projects, items, sprints, team (allocations, hours, rates when the user may see
    them), relations, dependencies, governance (risks, issues, assumptions, decisions, change
    requests), milestones and tickets.
  - **Estimates:** `estimate_hours` and `points` on an epic or story with children are their
    children's total unless set by hand, so totals are summed over `leaf = 1` rows (every task, and
    stories or epics without children).
  - **Loading:** tables load through Odin's REST API as the user (relations through
    `GET /api/projects/:projectId/relations`), and only the ones a query names. Reads are shared
    for the rest of the turn until something is written.
  - **Scope:** the chat's project by default, every visible project with `allProjects` (up to 40),
    or chosen `projectIds`.
  - **Isolation:** each query runs in a worker thread on an in-memory sql.js database, with no
    file or network access, a 5-second limit and at most 200 rows returned. Only a single `SELECT`
    or `WITH` is accepted.
- **Everything else** is reached through `odin_operations` (find), `odin_describe` (inputs) and
  `odin_run` (run). It covers every MCP tool, plus the assistant's memory and monitors.
- **Schedules.** `odin_get_timeline` reads the Insights timeline the user sees: each story's start
  and finish dates, what holds it there (its dates, its sprint, a blocker, or its person being busy),
  and the critical chain. When open stories wait for their busy owner, its result says which ones
  and that back-to-back dates bring them forward.
  - `odin_create_milestone` and `odin_update_milestone` add and move milestones such as a launch,
    linked to the item that delivers it.
  - `odin_create_dependency` adds the dependencies schedule analysis builds its critical path from.
  - These tools refuse an item id that is not in the project; the routes alone accept any id.
- **Schedule rules in the prompt.** The timeline is the plan the user sees, and one person's open
  stories run one at a time on it. After setting dates to hit a date the user named, the model
  checks `odin_get_timeline` and adjusts until the work lands, and records a named launch or
  go-live as a milestone.
- **Edits stay small.** `odin_update_items` reports no description gaps; only newly created items
  do. When the model changed a date inside a description, gap reports had it rewrite whole
  descriptions into the template.
- **One catalog.** The hosted MCP server and the assistant build from the same catalog
  (`backend/src/mcp/catalog.js`). MCP clients get 128 tools. The assistant's (`extended: true`)
  adds 4 memory tools and 3 monitor tools, 135 in all: `odin_remember` and `odin_search_memory`
  from `workspace-tools.js`, the rest from `memory-tools.js`. It also reads channels
  (`odin_list_channels`, `odin_list_channel_posts` in `channel-tools.js`) and manages their
  guests through the channel's guest routes (`odin_list_channel_guests`,
  `odin_invite_channel_guest` and `odin_remove_channel_guest`, which ask first). MCP clients don't
  get these yet. It also runs polls in channels (`odin_create_poll`, `odin_get_poll_results` in
  `poll-tools.js`). Both get the folder tools (`folder-tools.js`): `odin_list_file_folders`,
  `odin_create_folder`, `odin_rename_folder`, `odin_move_folder`, `odin_delete_folder` (asks
  first), `odin_move_file` (asks first when the move shows a file to a channel's guests) and
  `odin_rename_file`. They see a project's files as a tree: "/" is the project, each channel a
  folder in it, and people's folders inside channels.
  A test fails if any MCP tool is
  missing from the assistant. Everything about a tool is on its catalog entry: whether it writes,
  its `purpose`, and whether the assistant asks first (`confirm`).
- **Memory.** `odin_remember` records a decision, preference, outcome, meeting note or fact, on a
  project or for the user, for later chats to find with `odin_search_memory`.
  `odin_correct_memory` fixes one, and `odin_forget_memory` (which asks first) removes it. The
  header's journal icon opens "What the AI remembers" (`/ai-memory`).
- **Forgiving inputs.** Versions are read for the model, assignees may be names or emails, a
  number past a field's limit is brought within it, validation errors come back as short
  sentences, and a transient failure is retried once (`backend/src/lib/agent/agent-tools.js`).
- **Others' edits stand.** When an item changes while `odin_update_items` runs, its update goes
  ahead only if nobody changed the fields it sets. Otherwise the item is left as it is and its
  result says `changed`, with the new values, so the model can decide again.
- **Outside tickets.** A ticket submitted from outside the team stays hidden from the assistant
  until it is marked valid (`assistant-ticket-visibility.js`). Reads and queries leave it out, and
  so do relations, dependencies and milestone links to it; confirmation cards and the write check
  call it "an external ticket awaiting review". `odin_list_tickets_awaiting_review` shows Odin's
  automated check of each instead of its content. `odin_review_ticket` can validate only a ticket
  that check found safe.
- **Garbled ids.** The model sometimes copies an id with another id's tail glued on: it wrote
  `97042a21-9906-4f5a-bc9b-6bbb81a9cec2` for the story `97042a21-9906-4f14-bb17-4bfe6b213021`.
  An id that matches nothing known is read as the one known id that starts with the same 8
  characters, when exactly one does (`agent-ids.js`).
  - **Known ids:** those in the user's messages and the turn notes, those in this turn's successful
    tool results, and the items of the project, read once when an id first matches nothing.
  - **Where:** in calls, before the write check and before they run; the result tells the model
    what was corrected. In the saved reply, item links are corrected the same way.

## Checks and limits

- **Budget.** Each turn starts with `ASSISTANT_TOOL_CALLS_PER_TASK` calls (default 40). A plan
  written with `update_plan` makes the pool `per-task × steps`, shared by all steps, up to
  `ASSISTANT_MAX_TOOL_CALLS` (default 420). The model is told its usage at 50% and 80%. When the
  pool runs out, it answers from what it has.
- **Loop guard.** An identical failing call may run 3 times; the 4th is refused. An identical call
  whose result is the same 3 times in a row (with no successful write since) is refused too. Calls
  whose results change, such as status checks, keep running.
- **What judgments read.** Triage and the write check read the conversation only. The completion
  check also reads the turn's tool calls and results. From each turn's notes, a judgment keeps only
  what the user is looking at; the operation inputs, project snapshot and budget are for the model.
  Read by a judgment, they buried the request.
- **Write check.** Before each write, one Decisions call asks whether the change is part of what
  the user's latest request asks for, or something they agreed to. Bulk updates are described by
  the fields they set and how many items ("targetEndDate on 52 items"). Long text is shortened
  field by field, so every field a call sets stays in view, and the names behind its ids follow
  ("affects milestone "Launch" (target 2026-10-30)"). Shown tool results, the check held target
  dates on all 52 items of a project when the user had asked for exactly that.
  On a turn that asks for changes, a write is held only if the probability is below
  `ASSISTANT_WRITE_CHECK_THRESHOLD_CHANGE` (default 0.1, plainly unrelated). On other turns the
  limit is `ASSISTANT_WRITE_CHECK_THRESHOLD` (default 0.3). A held write is reported to the user
  with a request to confirm.
- **Confirmations.** Deletes, anything that emails people (a mention included), and changes that
  are hard to take back pause the turn with a confirmation card. Those include deciding an
  approval, triaging an outside ticket or changing a ticket's status, saving a schedule baseline,
  clearing a custom field, replacing a file, starting a monitor and creating a project from a
  template. The user confirms or cancels (`POST /chats/:chatId/confirmation`) and the turn
  resumes. A new message instead skips the waiting action.
- **Completion check.** When the model stops, a Decisions call checks:
  - Did it finish?
  - Did it claim a change no tool result shows?
  - Is there work left it could do?
  - Does the reply ask the user something it needs before going on?

  A failed check gets one specific nudge, at most twice per turn. A reply waiting on the user is
  never nudged to carry on. The check sees up to 64 tool items, so turns with many parallel reads
  are judged on all of them.
- **Cut-off steps.** A step that runs out of output tokens while reasoning, with no calls or text,
  runs again one reasoning effort lower (max → high → medium), told to act in smaller pieces; at
  most twice per turn. At max effort, a 52-item date change used the whole step thinking.
- **Guaranteed answer.** If the model ends without text, one last step runs with tools off.
- **Failed calls.** The model gets each failure's full error. The person sees a short reason in
  the tool list, and for a failed `odin_query` only "The query returned an error, so the assistant
  will retry it." Every failed call except one the user declined is logged server-side as
  `Assistant tool failed.` with the chat id, tool, error code and error, plus the SQL for a query.
- **Time limit.** `ASSISTANT_TURN_TIMEOUT_MS` (default 0, no limit) stops a longer turn with "This
  took too long and was stopped. Try a narrower request." Stop in the composer cancels a turn
  (`POST /chats/:chatId/cancel`).

## Undo

Every reply that changed something in Odin lists those changes under it ("Made 4 changes in Odin")
with an Undo button, which asks once before it runs. "Undo that" in the chat does the same through
`odin_undo_turn` (`agent-changes.js`), on the latest reply that changed anything unless the model
names another. When that reply can't be undone, the tool says why: it was already undone, an
earlier undo was partial or failed (and what that left), or nothing it changed is undoable.

- **Recording.** The turn's API client is wrapped. Before each write to a route the recorder knows,
  it reads what the write will change; after the write succeeds, it keeps the request that reverses
  it. Known routes cover:
  - creating, updating and moving items (tickets included) and sprint assignment;
  - relations and comments;
  - governance items, milestones and dependencies (added, changed or deleted) and the working
    calendar;
  - sprint edits, starting and completing sprints, and project and brief edits;
  - project members and stakeholder edits;
  - the project team and allocations, time entries and time off (added, changed or deleted);
  - a newly uploaded file, custom field values, and what the assistant remembered.

  Other writes (deleting work items, comments or files, creating a project or sprint, adding a
  stakeholder, replacing a file, approvals, comment edits, requirements, board order and settings)
  are listed as not undoable. Records survive a pause for confirmation, and a turn that fails partway
  still keeps what it changed.
- **Changed since.** When the turn ends, the recorder notes the version of everything it touched.
  Undo skips anything whose version has moved since ("Changed since, so it was left as it is"), and
  reverses the rest newest first, as the user, through the same routes.
- **After undo.** Each change shows its outcome: undone, kept, failed or not undoable. A note in the
  chat lists what was undone, so the assistant knows too. Undo can't run while a turn is running,
  or twice on the same reply.
- **Each undo on its own.** A reply's card shows only its own undo in progress; the chat's working
  indicator is for turns. Undos of different replies can run at once: the server takes undo, new
  messages and confirmations for a chat one at a time, so none overwrites another's save.
- **Undoing an undo.** An undo done from the chat is itself recorded as that reply's changes, so it
  can be undone in turn.

Route: `POST /api/assistant/chats/:chatId/messages/:messageId/undo`. The undo details stay on the
server; the chat shows each change's label and outcome.

## Prompt caching and the transcript

Each request is built so the provider can reuse what it has already processed:

- **Fixed prefix.** The system prompt and the tool list are the same for every turn, user and project
  (only web research changes them). Every user, date, page or project detail goes in the turn's
  notes instead.
- **A growing transcript.** Each finished turn is stored as the model saw it (`agent-transcript.js`):
  the notes, the user's message, the tool calls and results, and the reply.
  - Reasoning items are left out, and images become a placeholder.
  - Follow-ups can use what earlier turns read.
  - The stored form never changes, so each request starts with the previous one. Only the last
    turn's tool results, after its reasoning, are processed again.
- **Cache settings.** Requests carry `prompt_cache_key` (a hash of tenant and user) and
  `prompt_cache_retention: '24h'`. gpt-6-luna only offers 24-hour caching; a model that rejects it
  gets the request again without it. Each turn records `cachedTokens` with its usage, and logs one
  line (`Assistant turn usage.`).
- **Compaction.** When a request would pass `ASSISTANT_COMPACT_AT_TOKENS` (default 120000), older
  turns are condensed into a summary before the turn runs. The activity list shows "Condensed …".
  - The most recent turns stay whole, up to 40% of the budget.
  - Earlier turns keep only their messages, until there are 32 or they reach 60% of the budget.
  - Everything older goes into the summary. It is reused unchanged until the next compaction, so it
    is cached too.
- **Older chats.** Chats from before the transcript, and turns that failed or were superseded, join
  it as text.

## Settings

- **Model and key.** Turns run on the tenant's OpenAI API key and its "Assistant" model (Tenant
  Admin → Integrations → AI Integrations; capability `intakeDialogue`). Without them, `OPENAI_API_KEY`
  and `OPENAI_MODEL` (default gpt-6.1-sol) apply. The capability sets only the model; the
  assistant picks its reasoning effort per message.
- **Environment.** `ASSISTANT_TOOL_CALLS_PER_TASK`, `ASSISTANT_MAX_TOOL_CALLS`,
  `ASSISTANT_REASONING_SIMPLE`, `ASSISTANT_REASONING_COMPLEX`, `ASSISTANT_MAX_OUTPUT_TOKENS`,
  `ASSISTANT_DECISIONS_ENABLED`, `ASSISTANT_DECISIONS_MODEL` (default gpt-6-luna),
  `ASSISTANT_DECISIONS_TIMEOUT_MS`, `ASSISTANT_WRITE_CHECK_THRESHOLD`,
  `ASSISTANT_WRITE_CHECK_THRESHOLD_CHANGE`, `ASSISTANT_COMPACT_AT_TOKENS`,
  `ASSISTANT_TURN_TIMEOUT_MS`.
- **In code only.** Chat naming (`chatTitles`, `chatTitleModel`, `chatTitleReasoning`) and
  `promptCacheRetention` are set in `DEFAULT_AGENT_CONFIG` (`agent-chat.service.js`).

## New chats

- **From the chat list.** Each project folder has a "+" that starts a chat in that project, and so
  does "Not tied to a project". The project you are on is listed even before its first chat.
- **From the header.** "New chat" starts on the page's project (none outside a project).
- **Choosing the project.** A new chat shows a Project picker until its first message. The chat
  is created on the server with that message, so its project is fixed from then on.
- **Opening the assistant.** "AI Workspace" in the navbar opens the latest chat on the page's
  project, or elsewhere the chat that was last open. A project with nothing to resume starts a new
  chat the same way, so no empty chats are left behind. The address carries the open chat
  (`?assistant=1&assistantSessionId=…`), so a reload or a shared link reopens it.

## The chat list

- **Rows.** Each chat shows its title, "Last active …" and "Opened …" (today, yesterday or a
  date), and "Working", "N to review" or "Didn't finish" when one applies. The list follows other
  tabs through `GET /api/assistant/chats/events`.
- **Rename and delete.** On hover or focus, a pencil and a trash can show over the right of the
  row. The pencil renames the chat in place: Enter or leaving the field saves, Escape cancels. On
  touch they keep a column of their own, and the pencil shows on the open chat only. The title in
  the header renames the open chat too. Delete asks first, and leaves what the assistant changed
  in Odin as it is.
- **Names.** A chat's first message, cut to 60 characters, is its first title
  (`titleSource: 'auto'`). Once that first request has its answer (after a confirmation, if the
  first turn needed one), gpt-6-luna at low reasoning effort names the chat from the request and
  the reply, in the background (`agent-chat-title.js`). `setGeneratedTitle` replaces the title
  only while `titleSource` is still `auto`, and the chat's channel gets `chat.renamed`. A rename
  sets `titleSource: 'user'`, so a generated name never overwrites it. If naming fails, the cut
  title stays.

## Replies

- **Plan.** A reply with a plan shows "Plan · 2 of 5 done", open while the turn runs. Each step's
  icon is its bullet: done, in progress, pending or skipped.
- **Tools.** "Used 6 tools · 1 didn't work" opens the list of calls. Each line's icon (a check, a
  cross, or a spinner while it runs) is its bullet, and a failure's reason sits under its label.
  Identical reasons in a row read "same reason".
- **Working.** While a turn runs, the reply shows the tool in use, "Writing" while text streams,
  or "Thinking", with the time so far.
- **Under the text.** Web sources, a confirmation card, a proposal card, the changes card with
  Undo, and Copy reply.

## Layouts

The workspace opens as a centred window, maximized, or docked. The header buttons switch between
them, and the choice is remembered (`odin.assistant.layout` in local storage).

When docked, the assistant is a side panel (`--assistant-dock-width`, 460px):
- The page beside it makes room (`html.assistant-docked`) and stays usable.
- The panel stays open as you navigate, and item links open in the page without closing it.
- Escape only closes the panel when focus is inside it.
- The page context follows the current route, so "this item" means what is on screen.

Below 992px wide, docked fills the screen. Below 900px, the chat list slides in from the header's
"Show chats" button.

## Visuals

Replies render three kinds of fenced block (`frontend/src/lib/assistant/assistant-visuals.js`,
`AssistantVisual.vue`):

- **` ```chart `**: a small JSON spec (`type` bar, horizontal-bar, stacked-bar, line, area, pie or
  doughnut, plus `title`, `labels`, `series`, `xLabel`, `yLabel`, `unit`), drawn with Chart.js.
  - It uses the dataviz method's categorical palette, validated against Odin's light and dark
    surfaces.
  - It has a single y-axis and at most 8 series.
  - A "Show data" table gives the numbers.
- **` ```mermaid `**: flows, sequences, timelines, state changes, Gantt charts and mind maps. These
  use the same strict Mermaid renderer as Requirements.
- **` ```dot `**: Graphviz graphs for dependencies, relationships and hierarchies. The SVG output
  is stripped of scripts, links and embedded content.
- Diagrams and graphs have "Show source" for the code behind them.

Each library loads only when a reply uses it, and redraws on a theme change. Triage adds three
predicates (chart, flow diagram, network graph). The prompt then names the format that fits the
request, shows an example block, and always forbids ASCII art. A block whose content starts on
the fence line (` ```chart: {…} `) still draws.

"Enlarge" (or a click on a diagram) opens a visual in a modal `<dialog>` sized to the window:
- Charts redraw at that size. Diagrams and graphs are redrawn and fitted to the window.
- Zoom runs from 50% to 400% of fit, using the buttons, Ctrl or Cmd with the wheel, or `+`, `-`
  and `0`.
- Drag or scroll to pan.
- Escape or a click on the backdrop closes the view, and focus returns to the button that opened
  it.

## Proposals, goals and monitors

- **Requirements plans.** "Propose work" stages epics and stories as a proposal card in the
  proposer's chat (`stageWorkItems`).
- **Home recovery.** Proposals are staged the same way (`stageRecovery`).
- **Applying.** Apply selected or Dismiss (`POST /chats/:chatId/proposals`). Applying goes
  through the same item routes as everything else.
- **Agent goals.** Goal runs execute as one assistant turn in a new chat on the goal's project,
  named for the goal, with web research only when the goal allows it (`constraints.allowWebResearch`,
  the goal form's "Allow external web research" box; `runGoalTurn`). They run unattended, so they are
  read-only unless the goal's owner set `constraints.autoApply`: every write is refused before it
  runs or pauses, and the turn's API client sends only GETs (`readOnlyApi`). A monitor's runs
  stay read-only too unless the goal's owner set the monitor up last (`agent-monitors.js`).
- **Monitors.** "Tell me if the launch slips" becomes a read-only goal with one scheduled monitor
  (`odin_create_monitor`, which asks the user first). Every `everyHours` (default 24) until its
  end date (default 30 days; at most 365 days and 200 checks), a check runs as the user and
  reports in a new chat. `odin_list_monitors` and `odin_stop_monitor` list and stop them.

## Odin in channels

A channel post that tags `@odin`, in a delivery project or an engagement, gets one answer in its
thread, posted with the author "Odin" (`modules/channels/odin-channel.service.js`). A tag is another way into this assistant,
not a second agent: the same `executeTurn`, turn queue, durable worker, instructions, catalog,
checks, confirmations and Undo. Only the turn's starting notes and where its reply goes differ.

- **The tag.** It is stored as `@[Odin](odin:odin)`, a token apart from user and stakeholder
  tags, so it never sends a mention email. The mention picker offers Odin while the
  channel's "Let Odin answer when tagged" setting is on (`odinEnabled` on the channel, saved with
  `PATCH /api/projects/:projectId/channels/:channelId`; decision rights change it). With it off, every `@odin` is saved as plain text and nothing runs.
- **A member's tag** runs one ordinary assistant turn as that member (`startOriginTurn`), so it
  does what their role allows: a project manager can have it move cards, plan sprints or raise
  risks; a member without plan rights is refused by Odin's routes. The chat carries an `origin`, which
  keeps it out of the chat list and adds the channel's notes (the thread, recent posts with
  guests' posts screened, the channel's files) after the turn's own notes. Origin hooks
  (`registerOrigin`) hear when a turn starts, settles or is undone, and the channel service turns
  each reply into a post whose id is the reply's id. Confirm, Cancel and Undo on that post work
  only for the member who tagged Odin (`POST /posts/:postId/odin/confirmation` and `/odin/undo`).
- **A guest's tag** runs the same turn, read-only. Its origin hooks give it three things a
  member's turn takes from the assistant: a read-only view of the catalog (`allowedTools`, passed
  to `createAgentToolbox` as `allow`), an API in place of a session that answers only the guest's
  own reads (`odin-guest-api.js`: their channels, those channels' files, and the tasks shown to
  them), and a chat kept only for the turn (`store`), since a guest has no account and nothing waits
  for them. The guest's post is checked first for instructions aimed at an AI (`odin-screen.js`);
  a post that can't be checked isn't answered.
- **Guests' posts as data.** The channel tools ask for the agent view (`agentView=1`), in which a
  guest's post that isn't clearly free of instructions aimed at an AI comes back as a note.
- **Images.** When a turn starts, `odin-images.js` picks the images it sees: the tagging post's
  first, then the thread's, newest first, at most 4 and 20 MB together, 8 MB each. A guest's
  image is screened like a guest's text (`passesImage` in `odin-screen.js`), and one that can't be
  checked is left out. The chat's origin keeps only the file ids. The `inputImages` origin hook
  reads them for each request, and `executeTurn` adds them to the user's message as `input_image`
  parts. The notes list what Odin sees and what was left out.
- **Looking at files.** `odin_view_project_file` (route `GET /files/:fileId/view`, agent view only)
  returns an image or PDF under `media`. `agent-media.js` turns that into `input_image` or
  `input_file` parts of the tool's output for the model, and into image or embedded-resource
  content for MCP clients. The transcript, decision evidence and a paused turn's saved input keep
  `[image]` or `[file: name]` in place of the bytes.
- **Once each.** One `odin_replies` record per tagging post (migration `0101_odin_replies`);
  editing the post never runs it again. Each turn is a durable run of type `odin_channel_reply`
  with a 10-minute limit. After a restart, the durable worker runs a reply nobody started and posts
  a note for one that was cut off. A failed or timed-out turn posts a short failure note.

## Storage

- **Chats.** Each chat is one JSON document in `preferences` under the key `ac:<chatId>`
  (`agent-chats.repository.js`).
- **Transcripts.** The model-facing transcript is a separate document under `act:<chatId>`, so
  listing chats never parses it. Deleting a chat deletes both.
- **Old sessions.** From `backend/`, `npm run job:migrate-assistant-chats [-- --dry-run]` copies
  the messages and titles of the old AI Workspace sessions (`as:` and `assistant_session:` keys)
  into chats, without their drafts or review proposals. It skips chats that already exist and
  leaves the old rows in place.
