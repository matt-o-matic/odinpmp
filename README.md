# OdinPMP

OdinPMP is a multi-project workspace for the product app, API, and marketing site.

## What Odin does

Odin brings project planning, requirements, delivery and bug fixing into one system. The client portal and MCP server are part of Odin; Bug Reporter and FaultLine run as separate services connected to Odin's projects, sign-in and mail.

- Projects start from a structured Brief, break down into epics, stories and tasks, and run on sprints and a kanban board, with governance registers, schedule analysis, custom workflows and tickets.
- Requirements gathering takes stakeholders from questions to decisions through private links, review rounds with screenshots and prototypes, on-screen annotation, Odin summaries, and plans whose acceptance criteria cite those decisions.
- The AI Workspace drafts briefs and plans, answers questions across projects, and makes changes directly as the signed-in user, with that person's permissions. Deletes, anything that emails people and other changes that are hard to take back wait for the user to confirm, and each reply's changes can be undone.
- Portfolio planning, project ranking, resource and finance management, and reporting cover the view above individual projects.
- Bug Reporter (`bugs.odinpmp.com`) adds a bug capture widget to any website, and every report becomes an Odin ticket.
- FaultLine (`faultline.odinpmp.com`) triages bugs and production errors, verifies fixes and opens pull requests. It never merges.
- The MCP server (`odinpmp.com/mcp`) gives ChatGPT, Codex and other agents 151 tools for working in Odin projects. OAuth apps, webhooks, SCIM and connectors cover other systems.

## Repo layout

The current repo contains:

- `backend/`: Express API, auth and identity (SSO, SCIM), projects, requirements gathering, tickets, the AI Workspace assistant, MCP server, portfolio, resources and finance, governance, workflows, reporting, connectors, compliance, comments, files, ranking, metrics, mail jobs
- `frontend/`: Vue 3 app served under `/app`
- `marketing/`: Astro marketing site for the public-facing root site
- `marketing-classic/`: the marketing site before the October 2026 redesign, kept buildable but not deployed
- `docs/`: reference documentation: the MCP server, the assistant, the AI prompts, and the review package contract (index in [docs/README.md](docs/README.md))
- `tools/`: the test runner, the inbound mail Lambda, the review package starter, and alerting rules (see [tools/README.md](tools/README.md))

## Requirements

- Node.js 22+
- npm
- MySQL 8+, and the `mysql` command-line client for `npm run db-reset`

## Repo Scripts

From the repo root:

- `npm run bootstrap`: install dependencies for `backend/`, `frontend/`, `marketing/` and `tools/clarification-inbound-lambda/` (not `marketing-classic/`)
- `npm run dev`: run backend, frontend, and marketing together
- `npm run build`: build/check backend, frontend and marketing
- `npm run dev:backend`
- `npm run dev:frontend`
- `npm run dev:marketing`
- `npm run dev:marketing-classic` and `npm run build:marketing-classic`
- `npm test`: the `pr` test profile; `npm run test:changed` runs only the affected tests. Profiles are described in [tools/test/README.md](tools/test/README.md).
- `npm run test:e2e`: the frontend's Playwright suite
- `npm run db-reset -- --yes`: rebuild the local database (see below)
- `npm run mcp`: the stdio MCP bridge (see [docs/mcp.md](docs/mcp.md))

## Local Bootstrap

### 1. Install dependencies

```bash
npm run bootstrap
```

### 2. Create a MySQL database

Create an empty MySQL database for OdinPMP.

Example:

```sql
CREATE DATABASE odinpmp_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

### 3. Configure environment variables

The backend loads env from the shell and from `backend/.env` via `dotenv`.

Locally, `DATABASE_URL` and `NODE_ENV=development` are required. A typical local `backend/.env`:

```bash
NODE_ENV=development
DATABASE_URL=mysql://USER:PASSWORD@127.0.0.1:3306/odinpmp_dev
PORT=3001
SEED_DEMO_USER=true
JWT_ISSUER=odinpmp-backend
FRONTEND_APP_URL=http://localhost:5173/app
BACKEND_PUBLIC_URL=http://localhost:3001
WEBHOOK_SIGNING_MASTER_SECRET=replace-with-at-least-32-random-characters
SLO_P95_LATENCY_MS=1000
SLO_ERROR_RATE_PERCENT=1
```

Recommended AI config for local development:

```bash
OPENAI_MODEL=gpt-6-luna
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3001/api/auth/google/callback
```

Useful optional backend env:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default `gpt-6-luna`): the model each AI capability, the assistant included, uses unless the workspace sets its own key and models in Tenant Admin > Integrations
- `REQUIREMENTS_SUMMARY_MODEL` (default `gpt-6-luna`) and `REQUIREMENTS_SUMMARY_REASONING_EFFORT` (default `max`): the Odin summary on requirements topics and rounds
- `REQUIREMENTS_AI_PROVIDER` (default `openai`): `local-fixture` gives deterministic requirements AI output for local work without an OpenAI key, and is refused in production
- `ASSISTANT_TURN_TIMEOUT_MS` (optional active-worker watchdog; unset/0 disables wall-clock turn cancellation)
- `ASSISTANT_TOOL_CALLS_PER_TASK` (default 40) and `ASSISTANT_MAX_TOOL_CALLS` (default 420): the assistant's tool budget; each task in a turn's plan adds the per-task amount to one shared pool, up to the ceiling
- `ASSISTANT_REASONING_SIMPLE` (default `max`) and `ASSISTANT_REASONING_COMPLEX` (default `max`): reasoning effort for simple messages and for everything else
- `ASSISTANT_MAX_OUTPUT_TOKENS` (default 32000), `ASSISTANT_DECISIONS_ENABLED` (default `true`), `ASSISTANT_DECISIONS_MODEL` (default `gpt-6-luna`), `ASSISTANT_DECISIONS_TIMEOUT_MS` (default 4000), `ASSISTANT_WRITE_CHECK_THRESHOLD` (default 0.3, for question turns), `ASSISTANT_WRITE_CHECK_THRESHOLD_CHANGE` (default 0.1, for turns that ask for changes): the Decisions API checks around the assistant (triage, the check before each write, the check when it finishes)
- `ASSISTANT_COMPACT_AT_TOKENS` (default 120000): a chat's conversation grows until a request would pass this many tokens, then older turns are condensed into a summary
- `SEARCH_EMBEDDING_MODEL` (default `text-embedding-3-large`) and `SEARCH_EMBEDDING_DIMENSIONS` (default 1024): the embeddings of workspace search, which finds work items, comments, posts and the text of files by meaning. Changing either embeds every row again.
- `SEARCH_INDEX_INTERVAL_MS` (default 60000): how often the backend refreshes every workspace's search index; 0 turns the schedule off, and a search still refreshes an index older than 5 minutes
- `SEARCH_SEMANTIC_MIN_SIMILARITY` (default 0.3): the cosine similarity below which a row is not a semantic match
- `OPENAI_MEMORY_EMBEDDING_MODEL` (default `text-embedding-3-small`) and `OPENAI_MEMORY_EMBEDDING_DIMENSIONS` (default 256): the embeddings of the assistant's memory
- `SIGNING_SEAL_KEY` (at least 32 characters), `SIGNING_SEAL_KEY_ID` (default `seal-1`) and `SIGNING_SEAL_KEYS_PREVIOUS` (`id:key,id:key`, for records sealed before a rotation): seal signature records. Without a key, production refuses new signing requests.
- `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY` and `WEB_PUSH_SUBJECT` (a `mailto:` or `https:` URL): browser push notifications. `npm --prefix backend run job:generate-vapid-keys` makes a key pair. Without them, push is off.
- `INVOICE_GEN_BASE_URL`: the invoice-gen service that a project's billing (SOW, invoices, milestone hours) is read from, with the Consulting module on
- `JSON_BODY_LIMIT_BYTES` (default 1 MB, at most 5 MB): the JSON request body limit
- `REVIEW_PACKAGE_MAX_BYTES` (default 50 MB, at most 200 MB): the largest review package upload
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `RECAPTCHA_SITE_KEY` and `RECAPTCHA_SECRET_KEY` (reCAPTCHA v3 keys for the sign-up forms; a sign-up needs a score of 0.5 or more; without them, local sign-ups skip the CAPTCHA and production refuses sign-ups)
- `CORS_ALLOWED_ORIGINS` (comma-separated origins allowed besides the `FRONTEND_APP_URL` origin)
- `MCP_PUBLIC_URL` and `MCP_ALLOWED_ORIGINS` (the hosted MCP endpoint is off until `MCP_PUBLIC_URL` is set; see [docs/mcp.md](docs/mcp.md))
- `REVIEW_PUBLIC_URL`, `REVIEW_PORT` (default 3002) and `REVIEW_GRANT_SECRET`: the separate origin that serves review package prototypes. When `REVIEW_PUBLIC_URL` is set, the backend also listens on `REVIEW_PORT`; the origin must differ from the app's and the API's.
- `CONNECTOR_CREDENTIAL_ENCRYPTION_KEY` (required in production, at least 32 characters)
- `ACCESS_REQUEST_NOTIFY_EMAILS` (comma-separated addresses emailed about each access request from the marketing site)
- `TRUST_PROXY` (Express `trust proxy`; default trusts only a proxy on the same host)
- `VAULT_STORAGE_PATH`
- `AVATAR_STORAGE_PATH`
- `OBJECT_STORAGE_PROVIDER` (`local` for development, `s3` is required in production)
- `OBJECT_STORAGE_BUCKET`
- `OBJECT_STORAGE_REGION`
- `OBJECT_STORAGE_ENDPOINT` (optional S3-compatible endpoint)
- `OBJECT_STORAGE_FORCE_PATH_STYLE`
- `OBJECT_STORAGE_PREFIX`
- `OBJECT_STORAGE_PUBLIC_ENDPOINT` (optional: where browsers reach the bucket for signed upload and download URLs, when that differs from `OBJECT_STORAGE_ENDPOINT`)
- `FILE_UPLOAD_MAX_BYTES` (default 1073741824, 1 GB: the largest file anyone can upload)
- `FILE_TRANSFER_SECRET` (optional, at least 16 characters; signs the short-lived backend URLs that move file bytes with local storage; defaults to `JWT_SECRET`)
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_STARTTLS`
- `MAIL_FROM_ADDRESS`
- `MAIL_FROM_NAME`
- `MAIL_REPLY_DOMAIN`
- `INBOUND_MAIL_WEBHOOK_SECRET`
- `CLAMAV_ENABLED`
- `CLAMAV_HOST`
- `CLAMAV_PORT`
- `CLAMAV_SOCKET_PATH`
- `CLAMAV_TIMEOUT_MS`
- `CLAMAV_STREAM_TIMEOUT_MS` (default 15 minutes: how long the scan worker waits for ClamAV's answer once a whole file is sent)
- `PREVIEW_SOFFICE_PATH` (default `soffice`: the LibreOffice program that converts Word, Excel, PowerPoint and OpenDocument files to PDF previews; without it, those files get no preview)
- `PREVIEW_MAX_BYTES` (default 104857600, 100 MB: the largest Office file converted)
- `PREVIEW_TIMEOUT_MS` (default 120000: how long one conversion may run before it is stopped and the file gets no preview)

For clarification reply-by-email, set:

```bash
MAIL_REPLY_DOMAIN=reply.odinpmp.com
INBOUND_MAIL_WEBHOOK_SECRET=<shared-secret-used-by-the-ses-lambda>
```

Outbound clarification invitations still go through the SMTP mail queue. Inbound replies arrive through `SES -> S3 -> Lambda -> /api/public/inbound-mail`, which picks a handler from the address prefix: `clarification+`, `ticket+` or `bugreport+`. The older `/api/public/clarification-mail/inbound` and `/api/public/ticket-mail/inbound` routes still work.

Ticket reply-by-email uses the same secret. Acknowledgement and status emails to intake
reporters set Reply-To to `ticket+<replyToken>@$MAIL_REPLY_DOMAIN` (no Reply-To when
`MAIL_REPLY_DOMAIN` is empty). A Lambda still posting everything to
`/api/public/clarification-mail/inbound` keeps working: that route hands `ticket+` recipients
on the reply domain to the ticket handler. A reply is added as a comment only when it comes
from the invited reporter's address; unknown or revoked tokens and other senders are accepted
and dropped rather than creating anything.

Bug Reporter reply addresses also need `BUG_REPORTER_EMAIL_REPLIES=true`.

### Ticketing notes

- External reporters file through a project-scoped page at `<FRONTEND_APP_URL>/report/<intakeToken>`
  (API: `/api/public/ticket-intake/<intakeToken>`). The token carries the project, so a
  reporter never selects one. The page also lists the tickets filed through that link with
  their client-facing status.
- Creating an intake link in a project's Tickets > Intake links tab emails the link to the
  reporter; the tab shows each working link with a copy control.
- Intake reporters are emailed when a ticket is received and whenever its status changes.
  Bug Reporter tickets are excluded; Bug Reporter sends its own updates.
- Externally submitted tickets (intake links, and Bug Reporter reports from outside
  collaborators) wait in a review queue. Until one is validated, the AI assistant and MCP
  clients can't read it; they see only the result of an automated check (gpt-6-luna through
  the Decisions API) of whether it is genuine, aims instructions at an AI, or is harmful.
  People validate from the queue. An agent can reject any of them but validate only one the
  check calls safe, once nothing on it has changed for five minutes. Pending tickets remain
  assignable and schedulable in the meantime.
- Attachments are limited to five files of at most 10MB each and 20MB together, restricted
  to image, PDF, and text types, and scanned by ClamAV when it is configured (`CLAMAV_ENABLED`,
  `CLAMAV_HOST` or `CLAMAV_SOCKET_PATH`; production requires it). The intake route has its
  own JSON body limit (~28MB) ahead of the global one.
- Tickets stay off the sprint board unless explicitly added to a sprint.
- Deliberately not in this release: computed ticket metrics, SLA clocks, duplicate
  detection, and any release lifecycle beyond a tenant-managed identifier list.

Frontend local env, if you want to override the default API target:

```bash
VITE_API_BASE_URL=http://localhost:3001
```

Marketing local env, when the API is not same-origin:

```bash
PUBLIC_API_BASE_URL=http://localhost:3001
```

There is no checked-in `.env.example` for the apps; the variables each one reads are listed above. The runtime files are project-specific:

- `backend/.env`
- `frontend/.env.local`
- `marketing/.env`

### 4. Reset and rebuild the local database

Use the repo-root reset command after the database exists and `backend/.env` points at it:

```bash
npm run db-reset -- --yes
```

This command will:

- drop all current tables in the `DATABASE_URL` schema
- import `backend/db/base-schema.sql` (the base tables) through the `mysql` command-line client, which must be on your `PATH`
- run the backend schema bootstrap (`job:bootstrap-schema`): the newer tables and the recorded schema migrations
- recreate the local demo login, unless `--skip-demo` is passed

Without `--yes` it asks you to type the database name. It refuses to run when `NODE_ENV=production` or when the database name contains "prod". It resets the database only. It does **not** purge files under `backend/.data`, custom vault paths, or avatar storage.

## Running Locally

Run everything together:

```bash
npm run dev
```

Default local URLs:

- backend: `http://localhost:3001`
- frontend app: `http://localhost:5173/app`
- marketing site: `http://localhost:2281`
- classic marketing site (`npm run dev:marketing-classic`, not part of `npm run dev`): `http://localhost:2282`

Or run each project separately:

```bash
npm run dev:backend
npm run dev:frontend
npm run dev:marketing
```

## Demo Login

With `SEED_DEMO_USER=true`, the backend creates a demo admin at startup if it doesn't exist yet. It never does this in production. `npm run db-reset` also recreates it, unless you pass `--skip-demo`.

- email: `demo@odinpmp.local`
- password: `DemoPass123!`

The password is public, so leave `SEED_DEMO_USER` off on any server other people can reach.

## Accounts and workspaces

- A password sign-up creates a new workspace, and only after its emailed confirmation link is used. Whoever creates a workspace is its admin. Sign-ups can't join an existing workspace or choose a role.
- People join an existing workspace in three ways: an admin's invitation (the admin picks the role), a Google sign-up whose verified email is on the workspace's domain (joins as `user`), or a request to join.
- A request to join (`/app/workspace-access`, "Request workspace access" in the account menu) names the workspace exactly. Odin answers the same whether or not the name exists. The requester confirms their email through a single-use link that expires after 24 hours (the token travels in the URL fragment and is stored only as a hash); an address already confirmed on an earlier request isn't asked again. Only then do the workspace's admins see it, under Tenant Admin > User Management > Requests to Join, and get an email. The request grants nothing: an admin approves it with a role or declines it, the decision is written to the audit log, and the requester is emailed either way. A requester can have 3 requests waiting, make 5 a day, and can't ask the same workspace again for 7 days after a decline.
- Email notification settings are on the profile's Preferences tab: mentions, things that need your attention (goal alerts, requests to join a workspace you administer, stakeholder link requests) and scheduled reports. Each is on until the person turns it off. Settings saved before 2026-10 are ignored, because the old form stored every box unchecked. Emails someone needs in order to act (confirmations, invitations, stakeholder links and review rounds, ticket and Bug Reporter updates to reporters) are always sent. Odin has no in-app notifications, so the profile no longer offers in-app settings.
- In Requirements comments (topic discussions and review annotation threads), typing @ tags a team member or stakeholder. Each person gets one email per project for everything they were tagged in, sent by the mail-queue job once 20 minutes pass with no new tag for them (`CLARIFICATION_DIGEST_QUIET_MINUTES`, shared with stakeholder invitation digests). Team members can turn these off with the mentions setting.

## Build And Test

Build all projects:

```bash
npm run build
```

Run backend tests:

```bash
npm --prefix backend test
```

Run frontend unit tests:

```bash
npm --prefix frontend test
```

Run the frontend's browser acceptance tests (Playwright in desktop Chromium, Pixel 7 Chromium and WebKit, against mocked API fixtures; it starts its own Vite server on port 4173, or `ODIN_PLAYWRIGHT_PORT`):

```bash
npm run test:e2e
```

Run the standard local gate (deterministic tests, builds, evals and browser acceptance), or only what your changes affect:

```bash
npm test
npm run test:changed
```

Marketing currently exposes build/preview scripts but does not have its own test script:

```bash
npm --prefix marketing run build
```

## Runtime Defaults

Current code defaults when values are omitted:

- backend port: `3001`
- backend JWT issuer: `odinpmp-backend`
- backend JWT secret: `odinpmp-dev-secret`, accepted only when `NODE_ENV` is `development` or `test`. Anywhere else the backend refuses to start without a `JWT_SECRET` of at least 32 characters.
- frontend app URL: `http://localhost:5173/app`
- default OpenAI model: `gpt-6-luna`
- default OpenAI reasoning effort for the per-capability settings: `max`
- assistant reasoning: `max`
- default project summary model: `gpt-6-luna` with `max` reasoning
- default requirements summary model: `gpt-6-luna` with `max` reasoning
- assistant checks (Decisions API), chat titles and the outside-ticket check: `gpt-6-luna`
- default review origin port (used only when `REVIEW_PUBLIC_URL` is set): `3002`
- default object storage: `local`
- default SMTP port: `587`
- default SMTP STARTTLS: `true`
- default mail from address: `noreply@odinpmp.com`
- default mail from name: `OdinPMP`
- default ClamAV port: `3310`
- default ClamAV timeout: `30000`
- frontend API base URL fallback: `http://localhost:3001` in development, the page's own origin in a production build
- frontend Vite base path: `/app/`

## AI Notes

- project AI routes can fall back deterministically when `OPENAI_API_KEY` is unset
- assistant workspace turns do not silently fall back; they require either:
  - a tenant OpenAI key saved in the app, or
  - `OPENAI_API_KEY` in the backend env

## Local Storage Notes

Unless overridden:

- uploaded vault files are stored under `backend/.data/vault`
- user avatars are stored under `backend/.data/images/users`
- review packages are stored under `backend/.data/review-packages`

With `OBJECT_STORAGE_PROVIDER=s3`, all three go to the bucket instead.

Files up to 1 GB upload in parts. With S3 the browser sends each part to the bucket through a signed URL and downloads from it the same way, so the bucket needs CORS rules for the app origin (PUT and GET). With local storage the same API hands out signed backend URLs under `/api/file-transfers/`, which stream parts to `backend/.data/vault/.uploads` and files back out. A scan worker in the backend streams each new file to ClamAV and records its SHA-256; until it passes, the file shows "Scanning" and cannot be downloaded. Without ClamAV configured, the worker passes every file once it has read and hashed it, and the server logs a warning at start.

To test against real S3 multipart behavior, run MinIO with a KMS key (the app asks for SSE-S3 encryption) and point `backend/test/large-files-s3.integration.test.js` at it; the file's header has the commands.

## Database Notes

- backend startup requires `DATABASE_URL`
- the base schema import (`backend/db/base-schema.sql`) is still part of local bootstrap
- many newer tables are created on demand by the code that uses them, but the recorded schema migrations run only through `npm --prefix backend run job:bootstrap-schema` (which `db-reset` also runs); run it after pulling changes that add migrations

## License

Copyright 2026 Matthew Bradford. Licensed under the Apache License, Version 2.0: see [LICENSE](LICENSE). [NOTICE](NOTICE) lists third-party material and keeps the OdinPMP name and logo out of the license.
