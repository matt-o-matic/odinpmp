# Tools

Shared utilities that sit outside the three apps.

- [test/](./test): the local test runner, its profiles, and the smoke and recovery drills. See [test/README.md](./test/README.md).
- [review-package/](./review-package): the review package validator and examples. See [review-package/README.md](./review-package/README.md).
- [clarification-inbound-lambda/](./clarification-inbound-lambda): an AWS Lambda that receives reply emails from Amazon SES and forwards them to the backend, so stakeholders can answer a clarification or a Bug Reporter thread by replying to its email.
- [observability/prometheus-rules.yml](./observability/prometheus-rules.yml): Prometheus alert rules for readiness, dependencies and SLO breaches.

## Running in production

This repository doesn't include deployment scripts. Whatever runs the app needs to do the following:

- **Backend:** run `backend/src/server.js` (`npm --prefix backend run start`) behind a reverse proxy that serves the built frontend under `/app` and forwards `/api`, `/mcp` and the `/.well-known/oauth-*` routes to the backend. [docs/mcp.md](../docs/mcp.md) lists the MCP routes.
- **Scheduled jobs:** run these from `backend/`:
  - `npm run job:mail-queue` every minute. It also sends the rolled-up digests: clarification invitations, requirements mentions and chat notifications.
  - `npm run job:clean-sessions` hourly.
  - `npm run job:requirements-reminders` every 15 minutes.
- **Migrations:** after installing a new release's dependencies, run `npm run job:bootstrap-schema` from its `backend/` before switching traffic to it.
  - It applies the migrations not yet recorded in `schema_migrations` and logs what it applied.
  - It stops if a recorded migration's code changed since it ran. If that change is safe to re-run (the ensure-schema steps only add what is missing), `npm run job:bootstrap-schema -- --reconcile` applies it again and records its new checksum.
  - Every migration must also work with the previous release, which keeps serving while the job runs.
- **File uploads on S3:** the bucket needs CORS rules that allow `PUT` and `GET` from the app's origin, because browsers send file parts straight to it.

### Rolling back past migration `0093_file_versions_and_links`

Releases from before this migration read and write a file's bytes under the file's id, and know nothing of versions. To roll back past it:

1. Stop the backend. An upload that lands after the job has handled a file puts that file's contents back where an older release won't look.
2. From the current release, run `npm run job:prepare-file-rollback` in `backend/`. Add `-- --dry-run` to see what it would move.
3. Repeat step 2 until it reports nothing to move.
4. Switch to the older release.

The job can run again, and the current release can still read everything it leaves.
