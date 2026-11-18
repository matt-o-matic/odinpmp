# Autonomous local test runner

Run affected deterministic tests with:

```bash
npm run test:changed
```

Run a broader profile with:

```bash
npm run test:autonomous -- --profile pr
```

Without `--profile` the runner uses `changed`. Each profile also has its own root script: `npm run test:pr`, `test:integration`, `test:coverage`, `test:nightly`, `test:weekly`, `test:release` and `test:postdeploy` (`npm test` runs `test:pr`). Other options: `--base <git-ref>` sets the diff base for `changed` (default `HEAD`), `--output <directory>` moves the artifacts, and `--dry-run` lists the gates without running them.

Browser acceptance uses port 4173 by default. Set `ODIN_PLAYWRIGHT_PORT` to a free local port when it is occupied; the suite never reuses an existing server. Set `ODIN_PLAYWRIGHT_WORKERS` (1 to 32) to limit concurrency and `PLAYWRIGHT_BROWSERS_PATH` when using a repository-local browser installation.

The installed profiles are:

- `changed`: a whitespace check on the diff, syntax checks on changed backend and `tools/` scripts, and the deterministic tests that import a changed file, directly or transitively. Changes are the diff against `--base` plus untracked files.
- `pr`: all deterministic tests (including the deploy, AWS and Lambda tool packages), backend and frontend builds, the offline agent eval, and browser/Axe acceptance.
- `integration`: all deterministic tests and builds against a disposable local MySQL schema.
- `coverage`: native Node backend coverage with enforced line, branch, and function ratchets.
- `nightly`: PR plus worker-chaos recovery, readiness-aware two-instance HTTP failover, and visual regression.
- `weekly`: nightly plus security and abuse tests, the performance smoke, the four-instance large-tenant contention check (only when a database template is given), and native coverage ratchets.
- `release`: every local gate: weekly plus full backup/restore, binary-log point-in-time recovery, and the assembled-app post-deploy smoke.
- `postdeploy`: builds and boots the app against a disposable local MySQL schema, then probes backend liveness/readiness/API, frontend shell/assets, and graceful shutdown.

Gates run in order, and the first failure stops the run; the remaining gates are recorded as skipped.

Every run writes `manifest.json`, `junit.xml`, `report.html`, `cleanup.json`, and per-gate logs beneath `.test-results/<run-id>/`. The manifest records the seed, runtime versions, selected files, timings, and status. Set `ODIN_TEST_SEED` to repeat a seed. Coverage profiles also write raw V8 JSON beneath `.test-results/<run-id>/coverage/v8`; browser traces, screenshots, videos, Axe attachments, HTML, and JUnit stay beneath `output/playwright/<run-id>/`; the eval gates write `results.json` to `eval-offline/` and `eval-live/` in the run directory.

`npm run test:eval` (`eval.mjs`) runs those gates on its own. The offline suite checks the scenario corpus and its scoring (`backend/test/agent-eval-scenarios.test.js`). The live suite asks the assistant's models two things: whether the turn triage reads seven requests correctly (a change or not, simple or not), and whether instructions planted in a work item the assistant reads make it try any change. It never calls Odin, refuses to start when its worst case would pass `--budget-usd`, and records each case's probabilities or tool calls with the token use and cost. `ODIN_EVAL_CONTROLLER_MODEL`, `ODIN_EVAL_CONTROLLER_REASONING` and `ODIN_EVAL_DECISIONS_MODEL` override the models (defaults `gpt-6.1-sol` at low effort, and `gpt-6-luna`). A live run costs about $0.07.

The runner is offline and hermetic by default: it removes credential-like environment variables (names ending in `_API_KEY`, `_ACCESS_KEY`, `_ACCESS_KEY_ID`, `_PASS`, `_PASSWORD`, `_SECRET`, `_TOKEN` or `DATABASE_URL`), disables SMTP/OAuth/OpenAI/ClamAV configuration, sets `NODE_ENV=test`, and sets `ODIN_TEST_EXTERNAL_WRITES=disabled` in child processes. Live-model tests require `--allow-live-model`, a positive `--live-model-budget-usd <n>` ceiling, and a `nightly`, `weekly`, or `release` profile. That path adds the `*.live.test.js` files and, in profiles with evals, the live agent eval. On that explicit path only, the runner reuses `OPENAI_API_KEY` from the process or `backend/.env`; it never writes the value to artifacts.

The `integration`, `release` and `postdeploy` profiles require a local, run-isolated schema URL via `--database-url-template` or `ODIN_TEST_DATABASE_URL_TEMPLATE`; other profiles accept one. The value must use MySQL on `localhost`, `127.0.0.1`, or `::1`, keep the `{runId}` placeholder, and name a schema that starts with `odinpmp_test_` and holds only letters, digits and underscores, such as `odinpmp_test_{runId}`. The runner creates that schema before the gates and drops it afterwards. It rejects remote and shared database targets. Dry runs never provision or drop a database. The backup/restore and point-in-time recovery drills also need the `mysql`, `mysqldump` and `mysqlbinlog` clients on `PATH`, and the recovery drill needs ROW-format binary logging on the server.

Native Node coverage is enforced at the current ratchet floor of 75% lines, 64% branches, and 81% functions. Raise these thresholds as low-coverage modules improve; do not lower them to accommodate a regression.

The `pr`, `nightly`, `weekly`, and `release` profiles also run the repo-local Playwright browser acceptance suite. Browser traces, screenshots, videos, HTML, and JUnit output are isolated beneath `output/playwright/<run-id>/`. The browser suite uses intercepted synthetic API fixtures and never connects to the local backend or database.

Nightly, weekly, and release profiles compare the committed desktop Chromium, Pixel 7 Chromium, and WebKit visual baselines. Regenerate snapshots only after intentional UI review:

```bash
npm --prefix frontend run test:e2e -- --grep @visual --update-snapshots
```

Run the isolated assembled-app smoke directly with:

```bash
npm run test:postdeploy -- --database-url-template 'mysql://USER:PASSWORD@127.0.0.1:3306/odinpmp_test_{runId}'
```

## Requirements real-stack exercise

`tools/test/requirements-local-e2e.mjs` drives the Requirements journeys through the real UI against a stack already running on this machine. No test profile runs it: it needs that stack and writes test data to the dev database. It refuses any URL or database host that is not loopback.

Start the stack from `backend/` and `frontend/` (each in its own terminal):

```sh
# backend/ (backend/.env supplies DATABASE_URL; nothing here is a secret)
FRONTEND_APP_URL=http://127.0.0.1:5401/app CORS_ALLOWED_ORIGINS=http://127.0.0.1:5401 \
BACKEND_PUBLIC_URL=http://127.0.0.1:3001 MCP_PUBLIC_URL=http://127.0.0.1:3001/mcp \
REVIEW_PUBLIC_URL=http://127.0.0.1:3002 REVIEW_PORT=3002 REQUIREMENTS_AI_PROVIDER=local-fixture PORT=3001 \
node src/server.js

# frontend/
VITE_API_BASE_URL=http://127.0.0.1:3001 npx vite --host 127.0.0.1 --port 5401 --strictPort
```

Then run `node tools/test/requirements-local-e2e.mjs` from the repository root. Each run seeds a new project in the `Requirements Local E2E` tenant, with users and stakeholders whose addresses end in `odin.local`. Screenshots and `evidence.json` go to `output/playwright/requirements-local/`. `--only J5,J12 --resume` reruns journeys against the previous run's project. A resumed journey that creates something, such as an upload, is not idempotent. `--headed` shows the browser. Override the defaults with `ODIN_E2E_API_URL`, `ODIN_E2E_APP_URL`, `ODIN_E2E_REVIEW_URL`, `ODIN_E2E_DATABASE_URL` (default: `DATABASE_URL` from `backend/.env`) and `ODIN_E2E_OUTPUT_DIR`. The summaries come from the deterministic local fixture, not a live model.
