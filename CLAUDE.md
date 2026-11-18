# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

`backend/` (Express API, jobs, MCP server), `frontend/` (Vue 3 app served under `/app`) and `marketing/` (Astro site) are independent Node projects, each with its own `package.json` and `node_modules`. The root `package.json` only orchestrates them. `marketing-classic/` is the earlier marketing site, kept buildable but not deployed. `tools/` holds the test runner, the review package validator, an SES inbound-mail Lambda and Prometheus rules (see `tools/README.md`).

Setup, every environment variable and the local database steps are in `README.md`. It needs Node 22+, MySQL 8+, and the `mysql` client for `npm run db-reset`.

## Commands

From the root:

- `npm run bootstrap`: install every project's dependencies.
- `npm run dev`: backend (port 3001), frontend (5173) and marketing (2281) together.
- `npm run build`: syntax-checks the backend (`node --check`) and builds the frontend and marketing. There is no linter.
- `npm run db-reset -- --yes`: rebuild the local database (base schema plus every migration). It refuses production-like databases.
- `npm test`: the `pr` profile of `tools/test/run.mjs`. `npm run test:changed` runs only the tests affected by the working tree's changes. Profiles are in `tools/test/README.md`.

Single tests (Node's built-in runner, `node:test`, no framework):

- Backend: `cd backend && node --test test/channels.test.js`. `npm test` there runs the whole suite serially (`--test-concurrency=1`).
- Frontend unit tests (logic in `src/lib`): `cd frontend && node --test test/search-suggestions.test.js`.
- Browser tests: `cd frontend && ODIN_PLAYWRIGHT_PORT=5291 npx playwright test e2e/channels.acceptance.spec.js --project=chromium-desktop`.
  - Projects: `chromium-desktop`, `chromium-mobile` and `webkit`.
  - Playwright starts its own Vite dev server on `ODIN_PLAYWRIGHT_PORT`. `ODIN_PLAYWRIGHT_OUTPUT_DIR` moves its output.
  - Specs never reach a backend. `e2e/fixtures/` (for example `installSyntheticApi`, `installChannelsApi`) answer the API with `page.route`, and `api.assertNoUnexpectedRequests()` fails a spec that calls an unmocked route.
  - Running all three projects in parallel on one machine can time out at random. Run one project at a time to confirm a failure.
- MySQL integration tests (`*.integration.test.js`, `*mysql*.test.js`) skip unless `ODIN_TEST_DATABASE_URL` points at a scratch MySQL server whose user can create databases.

## Backend architecture

- **Composition.** `src/server.js` builds the MySQL repositories, storage, mail, AI providers and background workers, then passes them to `createApp(deps)` in `src/app.js`, which mounts every module's routes. Every dependency `createApp` doesn't receive falls back to an in-memory version. Most API tests build the app this way with no database (see `test/helpers/`).
- **Modules.** Each feature in `src/modules/<name>/` follows the same split:
  - `*.routes.js`: Zod request schemas, then a call into the service.
  - `*.service.js`: permission checks and business rules. Errors are `HttpError`s with a `details.code`.
  - `*.repository.js`: storage. Usually both `createInMemory…Repository` and `createMysql…Repository`, with the same methods.
  - Some modules add their methods to another module's repository by spreading them in (search, for example).
- **Schema.** Schema is created and changed only by the registered migrations in `src/jobs/bootstrap-schema.lib.js` (`mysqlMigrationDefinitions`). Request code assumes every migration has run.
  - The runner checksums each migration and refuses one that changed after it ran. Never edit a registered migration: add a new one at the end, and register it in the migration-order test (`test/bootstrap-schema.lib.test.js`).
  - A migration runs while the previous release is still serving, so it must work with that release's code.
  - `npm --prefix backend run job:bootstrap-schema` applies pending migrations.
- **Configuration.** `src/config/env.js` parses and validates every environment variable with Zod. A new setting goes there first.
  - The built-in JWT secret works only when `NODE_ENV` is `development` or `test`. Anywhere else the backend won't start without a real one.
  - Production (`NODE_ENV=production`) also fails fast on other unsafe values: a non-HTTPS URL, a missing virus scanner, local file storage.
  - The demo login is created only with `SEED_DEMO_USER=true`, and never in production.
- **Jobs.** `src/jobs/*.js`, run as `npm run job:*` from cron: the mail queue every minute, review reminders every 15 minutes, session cleanup hourly. Other background work runs inside the server process, for example the file scan worker, the search index refresh and the assistant's turn queue.
- **Live updates.** Changes publish to an event bus (`src/lib/events/`) that the frontend reads over server-sent events. The domain event outbox carries the changes that webhooks and the change feed need.
- **Assistant and MCP call the REST API.** The AI Workspace assistant (`src/modules/assistant/`) and the MCP tools (`src/mcp/`, hosted at `/mcp` with OAuth, or `npm run mcp` over stdio) act by calling Odin's own REST routes as the signed-in user. Permissions, versions and notifications are therefore the same as in the UI. A new capability for agents is a REST route first, then a tool. `docs/mcp.md` and `docs/assistant.md` describe both.
- **AI prompts.** Every prompt the code sends is listed in `docs/ai-prompts-inventory.md`, and tests check that the list matches the code. Update it when a prompt changes.
- **Files.** File bytes go to object storage (`src/lib/files/file-storage.js`): local disk in development, S3 in production. Large uploads go in parts, which the browser sends straight to signed URLs. Every new file is scanned by ClamAV before anyone can download it.
- **Review origin.** Review packages (stakeholder-facing screens and prototypes) are served from a separate host and port (`src/review-origin/`), so their HTML never runs on the app's origin. The package contract is in `docs/requirements-gathering/`. The backend builds the downloadable package kit from those files and `tools/review-package/`.

## Frontend architecture

- `src/views` are routed pages (`src/router`). `src/components` are grouped by feature. `src/lib/<feature>` holds the logic, kept out of components so `node --test` can cover it.
- API calls go through `src/lib/api/client.js`. Live updates come from `src/lib/live/`.
- Rich text uses one Tiptap editor, `components/rich-content/RichContentEditor.vue`:
  - Comments and channel posts store Markdown with inline mention tokens, written as `@[Name](user:<id>)` (`lib/rich-content/comment-markdown.js`).
  - Descriptions store sanitized HTML.
- The service worker (`public/sw.js`) handles Web Push and opens notifications in an existing tab.
