# Building an Odin review package

This guide is for a coding agent, or a developer, building a review package for an Odin project. A review package is one zip of screens, prototypes, diagrams, and questions. Odin shows it to the project's team and stakeholders as a review round and returns their feedback.

The full contract is `package-spec.md`, and `review-package.schema.json` is the manifest schema. This guide covers what you need to build a package that Odin accepts on the first upload. Where they differ, the spec wins.

## What you need from the project

Ask the person who gave you the task for these. The "Agent instructions" button on the project's Review tab in Odin puts all of them except the feedback in one block.

Review is project-wide: one round is open at a time, and a round is for screens, prototypes and flows that people see and use. Its questions may settle topics from either track.

| Value | Where it goes |
| --- | --- |
| Project id | Upload and MCP calls. |
| Track: always `experience` | `manifest.track`. Review packages are project-wide and use this value; any other value rejects the package. |
| Latest round id, if there is one | `manifest.basedOnRoundId`. |
| Topic ids, from either track | `topicId` on questions, so answers land in the right discussion. A topic id that doesn't exist rejects the package. |
| The feedback from the latest round | What to change. Keep screen ids for screens you are revising (see "Versions" below). |

With the Odin MCP server connected, `odin_get_requirements_context` returns all of this for the track you name, and `odin_get_round_feedback` returns the full feedback. The context lists one track's topics, so call it for both tracks to see every topic id.

## The zip

```text
manifest.json                       required, at the root of the zip
screens/<screen-id>.png             image screens
prototypes/<name>/index.html        one folder per clickable prototype, with its own css/js/images
assets/                             files several prototypes share (no html or js)
```

Only the paths named in the manifest matter, but keep this layout. Limits: 50 MB zip, 200 MB unzipped, 1,000 zip entries, 100:1 compression per entry, paths up to 240 characters, and a `manifest.json` of at most 512 KB.

**Allowed file types:** `html`, `js`, `mjs`, `css`, `json`, `png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`, `woff`, `woff2`, `txt`, `md`. HTML and JavaScript only inside a prototype's folder. Any other extension, or a file with no extension, rejects the package.

## manifest.json

```json
{
  "schema": "odin.review-package/v1",
  "track": "experience",
  "title": "Client booking: price and booking flow",
  "summary": "What changed since the last round and what reviewers should look at.",
  "basedOnRoundId": "<latest round id, or leave this field out>",
  "sections": [ ... ]
}
```

`sections` holds 1-7 sections, each type at most once, and at least one of `screens`, `directions`, `flows`, or `questions`. Every `id` is lowercase letters, digits, and single hyphens (`booking-home`), up to 64 characters, unique within its kind.

| Section | Holds | Key rules |
| --- | --- | --- |
| `context` | `body`: what the team heard and why this round exists | Markdown, up to 8,000 characters. |
| `references` | 1-30 outside examples: `title`, `url`, `inspected`, `pattern` | `https:` URLs only. `inspected: true` only if you opened the page. |
| `directions` | 2-6 alternative approaches: `id`, `title`, `summary`, optional `tradeoffs` and `screenIds` | Reviewers mark each preferred, acceptable, or rejected. |
| `screens` | 1-40 screens | See below. |
| `flows` | 1-20 Mermaid diagrams: `id`, `title`, `mermaid` | A diagram that doesn't parse rejects the package. |
| `questions` | 1-20 questions: `id`, `prompt`, `kind` | `single` and `multi` need 2-12 `options` of `{ id, label }`; `scale` needs `{ min, max }`, each from -10 to 10, with `min` below `max` and a range of at most 10; `text` needs nothing more. Add `topicId` to post answers to an existing topic. Without one, publishing reuses the topic an earlier round made for the same question id, or creates a new one. |
| `boundaries` | `body`: what this round does not cover | Markdown, up to 4,000 characters. |

A screen is either an image or a prototype:

```json
{ "id": "booking-home", "title": "Booking home", "kind": "image", "src": "screens/booking-home.png",
  "width": 1280, "height": 800, "alt": "What the screen shows, for screen readers." }

{ "id": "booking-flow", "title": "Booking flow", "kind": "prototype", "src": "prototypes/booking/index.html",
  "viewport": { "width": 1280, "height": 800 }, "alt": "Clickable booking flow.",
  "states": [ { "key": "pick-time", "label": "Pick a time" } ] }
```

An image `src` is a `png`, `jpg`, `jpeg`, `webp`, `gif`, or `svg` file, and a prototype `src` is an `.html` file. `width` and `height` (200-8,000) should be the image's real pixel size; a mismatch is a `size_mismatch` warning. `viewport` sides are 320-3,840. Optional on both kinds: `directionId`, `rationale` ("why this screen"), and `changeNote` (what changed since the last round).

Unknown fields inside a section are errors, so a typo such as `screenID` fails instead of being ignored. Unknown top-level fields are dropped with a warning.

Optional top-level fields: `generator` (`tool`, `model`, `notes`, kept for the audit trail) and `feedbackDimensions` (what reviewers rate per screen; the defaults suit screens and prototypes).

## Prototypes

A prototype is static HTML that runs in a locked-down frame. Build it so it works with no network at all.

- **Do:** use relative paths to files in the package, inline scripts and styles, and `data:` URLs. Keep state in memory.
- **Don't:** load anything from the network (CDN scripts, Google Fonts, analytics, API calls). A network URL in HTML, SVG, or CSS rejects the package with `external_url`, and the frame blocks any that slip through in JavaScript. Don't use `eval`, `new Function`, cookies, `localStorage`, or `sessionStorage`; none of them work. Don't reference another prototype's files; put shared files in `assets/`. Don't use root-relative paths such as `/logo.png`; they leave the package and return 404.
- **States:** for every `states` key in the manifest, show that state when `location.hash` is `#<key>`, and call `window.OdinReview?.setState('<key>')` from your `hashchange` handler. Odin adds `window.OdinReview` itself; don't include a bridge script.
- **Comment targets:** put `data-odin-id="<id>"` on elements reviewers will comment on, such as buttons, cards, and form fields.

The example in `examples/fieldwork-round-2/prototypes/booking/` does all of this.

## Versions

Odin numbers versions itself. Screen and question ids are what connect versions:

- Same id, same content: open comments carry forward.
- Same id, changed content: open comments are marked outdated for their authors to check.
- Id gone: its comments stay on the old version, marked superseded.
- Same question id: each reviewer sees their earlier answer, and answers again for it to count.

So keep an id when you revise the same screen or question, and use a new id for something new. A change to any shared file, such as anything in `assets/`, marks every prototype changed.

## Check, then upload

1. **Validate locally.** From the package kit: `npm install`, then `node validate.mjs <your-package.zip or folder> --track experience`. Exit code 0 means Odin would accept it, apart from topic ids and the malware scan, which need the project, and (in the kit) Mermaid, which Odin checks at upload. Add `--json` for machine-readable output.
2. **Upload.** Either:
   - **MCP:** `odin_create_package_upload` with the project id returns a single-use URL. Then `curl --fail-with-body -X PUT -H "Content-Type: application/zip" --data-binary @package.zip "<url>"`, and `odin_get_package_status` with the `uploadId`. To fix a draft that nobody has published yet, also pass `replacesPackageId` with the draft's id: the new zip becomes the next draft version and the old draft is withdrawn.
   - **Upload URL from a person:** they create it on the Review tab ("Upload URL for a coding agent") and give it to you. Send the same `curl` PUT.
   - **By hand:** a person uploads the zip on the Review tab.
3. **Read the result.** `201` means the package is stored as a draft. Uploading never publishes: a person publishes the draft in Odin, or an agent does with `odin_publish_round`. `422` lists `errors` and `warnings`, each with a `code`, the `file`, and a JSON Pointer `path` into the manifest. Nothing is stored on a rejection, and the URL is spent: fix the package and get a new URL. The one exception is a zip over the size limit, which is refused before the URL is used, so that URL still works. `415` means the `Content-Type` was wrong; the URL still works. `404` means the URL expired or was already used. `429` means too many requests: wait the `Retry-After` seconds.

Upload URLs work once and expire after 10 minutes. Treat one as a password.

A replacement upload changes nothing if the zip is rejected. If the draft was published, withdrawn or replaced before your zip arrived, the PUT returns `409` and nothing is stored: read the project's packages again before uploading. Published packages are never replaced.

## Common rejections

| Code | Usual cause |
| --- | --- |
| `manifest_missing` | The zip has a top-level folder. Zip the package's contents, not the folder. |
| `manifest_invalid` | A misspelled or missing field, an id with capitals or underscores, or a value over its limit. The message names the field. |
| `missing_file` | A `src` path doesn't match a file. Paths are case-sensitive. |
| `type_not_allowed` | A file type outside the list, or HTML/JS outside a prototype folder. |
| `duplicate_id` | The same id twice within one kind, such as two screens, two options of one question, or two state keys of one screen. |
| `external_url` | A CDN link, web font, or other network URL in an HTML, SVG, or CSS file. |
| `reference_out_of_scope` | A prototype loads another prototype's file, an image screen's file, or `manifest.json`. Move shared files to `assets/`. |
| `reference_invalid` | A `topicId` that doesn't exist, or a `directionId`/`screenIds` entry that doesn't match. |
| `track_mismatch` | `manifest.track` is not `experience`. |
| `mermaid_invalid` | A flow diagram doesn't parse. |

## Examples

In the package kit, the example is a ready-to-zip folder. In the Odin repo, the manifests are in `docs/requirements-gathering/examples/` and their files in `tools/review-package/examples/`.

- `examples/fieldwork-round-2/`: an Experience package with two image screens, a prototype with states, directions, a flow, and four questions (single choice, text, and scale). Its two `topicId` values (`topic-exp-01`, `topic-exp-03`) only exist in Odin's tests. Replace them with real topic ids from the project, or remove them, or Odin rejects the upload with `reference_invalid`.
