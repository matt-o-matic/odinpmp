# Review package specification

**Schema:** `odin.review-package/v1`

**Status:** In force. Odin enforces this contract at upload. For a shorter, task-oriented version, see the [agent guide](./agent-guide.md).

**Machine-readable form:** [`review-package.schema.json`](./review-package.schema.json) (JSON Schema 2020-12). Where this document and the schema disagree, fix whichever is wrong; do not ship with both.

This document defines what a developer, or a developer's coding agent, uploads to Odin, and what Odin returns as feedback. "Must" and "must not" are requirements Odin enforces at upload. "Should" is guidance that Odin reports as a warning.

## 1. Package file

A package is one zip file.

| Limit | Value |
| --- | --- |
| Zip size | 50 MB by default. A deployment can set `REVIEW_PACKAGE_MAX_BYTES` to any size up to 200 MB. |
| Total uncompressed size | 200 MB |
| Entries | 1,000 |
| Compression ratio per entry | 100:1 |
| Path length | 240 characters |

Odin checks the sizes a zip declares before it unpacks anything, and stops unpacking any entry that grows past its declared size.

Paths:

- must be relative, use `/`, and stay inside the package (no `..` segment, no leading `/`, no drive letter, no `\`, no empty or `.` segment, no control characters);
- must not be symlinks, directories with no files, or reserved names (`CON`, `NUL`, `AUX`, `PRN`, `COM1`-`COM9`, `LPT1`-`LPT9`, with or without an extension, such as `con.txt`);
- are case-sensitive, and must be unique when compared case-insensitively. A zip that lists the same path twice is rejected.

`manifest.json` must sit at the root of the zip, not inside a folder.

### Allowed file types

Odin decides each file's content type from its extension. Any other extension, or a file with no extension, rejects the package. Text types are served with `charset=utf-8`.

| Extension | Served as | Notes |
| --- | --- | --- |
| `html` | `text/html` | Prototypes only |
| `css` | `text/css` | |
| `js`, `mjs` | `text/javascript` | Prototypes only |
| `json` | `application/json` | |
| `png`, `jpg`, `jpeg`, `webp`, `gif` | image type | |
| `svg` | `image/svg+xml` | Served from the review origin under the same sandbox CSP |
| `woff`, `woff2` | font type | |
| `txt`, `md` | `text/plain` | |

"Prototypes only" is a rule: every `html`, `js`, and `mjs` file must sit in the directory that holds a prototype screen's `src`, or below it. That keeps every document and script inside a prototype's directory, which that prototype's content hash always covers (section 6). An HTML or JavaScript file anywhere else rejects the package with `type_not_allowed`.

### Recommended layout

```text
manifest.json
screens/<screenId>.png
prototypes/<name>/index.html        plus that prototype's own files, including its scripts
assets/                             shared images, fonts, styles (no HTML or JavaScript)
```

Apart from the rule above, layout is a convention. Only the paths named in the manifest matter. Any change to a shared file marks every prototype changed (section 6), so keep files that only one prototype uses in that prototype's directory.

## 2. Manifest

`manifest.json` is UTF-8 JSON, at most 512 KB.

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `schema` | string | yes | Exactly `odin.review-package/v1`. |
| `track` | string | yes | Always `experience`. Review is project-wide (one round open at a time, with questions from either track), so packages use this value and Odin rejects any other. |
| `title` | string | yes | 1-120 characters. Plain text. |
| `summary` | markdown | yes | 1-4,000 characters. What changed and what reviewers should focus on. |
| `basedOnRoundId` | string | no | At most 64 characters. The round this package responds to, from `odin_get_requirements_context`. Odin warns when it is not the project's latest round. |
| `generator` | object | no | `tool` (string, at most 60), `model` (string, at most 80), `notes` (string, at most 500). Stored for the audit trail. Never shown as a badge (Q-14). |
| `feedbackDimensions` | array | no | See section 4. |
| `sections` | array | yes | 1-7 sections. Each `type` may appear at most once. At least one of `screens`, `directions`, `flows`, or `questions` must be present. |

Odin ignores unknown top-level fields and reports each one as a warning, so newer generators can add metadata. Unknown fields inside a section or item are errors, so a misspelled field such as `screenID` fails loudly instead of being dropped.

### Identifiers

Every `id` in the manifest:

- matches `^[a-z0-9]+(-[a-z0-9]+)*$` and is 1-64 characters;
- is unique within its kind (screen IDs among screens, question IDs among questions, and so on).

Screen and question IDs are how feedback carries from one version to the next (section 6). Keep an ID when the thing it names is the same thing, even if it changed. Use a new ID for a different thing.

### Markdown

Fields marked markdown accept CommonMark without raw HTML. Odin shows raw HTML as plain text and renders links only when they use `https:`. A markdown image shows as its alt text; use a screen instead.

## 3. Sections

Every section has `id`, `type`, and an optional `title` (at most 120 characters). Section `type` comes from a closed set.

### `context`

What the team heard and why this round exists.

| Field | Type | Required |
| --- | --- | --- |
| `body` | markdown, at most 8,000 | yes |

### `references`

Outside examples that informed the package.

Each item:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `title` | string, at most 160 | yes | |
| `url` | string, at most 2,048 | yes | `https:` only. |
| `creator` | string, at most 120 | no | |
| `inspected` | boolean | yes | `true` only if the author opened the page, not just a search result. |
| `pattern` | string, at most 500 | yes | What to borrow. |
| `appliesTo` | string, at most 300 | no | Which screen or decision it informs. |

The section takes 1-30 items.

### `directions`

Alternative approaches reviewers compare.

Each item:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | id | yes | |
| `title` | string, at most 80 | yes | |
| `summary` | markdown, at most 1,500 | yes | |
| `tradeoffs` | markdown, at most 1,500 | no | |
| `screenIds` | array of screen ids | no | Each must exist in `screens`. |

The section takes 2-6 items. Reviewers mark each direction preferred, acceptable, or rejected, and can name elements to remix.

### `screens`

What reviewers look at and annotate.

Each item:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | id | yes | Stable across versions. |
| `title` | string, at most 80 | yes | |
| `kind` | string | yes | `image` or `prototype`. |
| `src` | path | yes | `image`: an image file. `prototype`: an `.html` file. |
| `alt` | string, at most 300 | yes | What the screen shows, for screen readers. |
| `width`, `height` | integer | `image`: yes | Pixel size of the image. Must match the file (warning if not). 200-8,000 each. |
| `viewport` | object | `prototype`: yes | `width` and `height`, 320-3,840. The frame size Odin renders. |
| `states` | array | no | `prototype` only. 1-30 items of `{ key, label }`. `key` is an id; `label` is at most 60 characters. |
| `directionId` | id | no | Must exist in `directions`. |
| `rationale` | markdown, at most 1,500 | no | Shown as "Why this screen". |
| `changeNote` | markdown, at most 1,000 | no | What changed since `basedOnRoundId`. |

The section takes 1-40 items.

### `flows`

Diagrams, such as a user flow or a sequence diagram.

Each item:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | id | yes | |
| `title` | string, at most 80 | yes | |
| `mermaid` | string, at most 20,000 | yes | Mermaid source. Odin parses it with Mermaid at upload and renders it with `securityLevel: 'strict'`. A diagram that does not parse rejects the package. |
| `description` | markdown, at most 1,500 | no | |

The section takes 1-20 items.

### `questions`

Things the package asks reviewers directly. Answers are posted to the linked topic's thread.

Each item:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | id | yes | Stable across versions. |
| `prompt` | string, at most 500 | yes | |
| `kind` | string | yes | `single`, `multi`, `text`, or `scale`. |
| `options` | array | `single` and `multi`: yes | 2-12 items of `{ id, label }`. `label` is at most 120 characters. |
| `scale` | object | `scale`: yes | `min` and `max` integers from -10 to 10 (`min` < `max`, range at most 10), plus optional `minLabel` and `maxLabel` (at most 40 each). |
| `topicId` | string, at most 64 | no | An existing topic in the project, on either track. Without one, publishing the round reuses the topic an earlier round created for the same question id, or creates an open topic from the prompt, with `help` as its rationale. Publishing fails if a linked topic no longer exists. |
| `help` | string, at most 300 | no | |

The section takes 1-20 items. No question can force an answer. A reviewer who skips one is recorded as "Not answered".

### `boundaries`

What the round is not, so reviewers don't judge things it doesn't cover.

| Field | Type | Required |
| --- | --- | --- |
| `body` | markdown, at most 4,000 | yes |

## 4. Feedback dimensions

These are the aspects reviewers can rate per screen as Keep, Change, or Undecided. Every aspect starts as Not reviewed.

`feedbackDimensions` is a list of 1-8 entries. Each entry is either a built-in key or a custom object `{ id, label, help? }`, where `label` is at most 40 characters and `help` at most 200.

Without `feedbackDimensions`, reviewers rate the six `experience` defaults below. The `architecture` defaults apply only to rounds from older Functional packages, but any package may list those keys.

Built-in keys:

| Key | Label | Default for |
| --- | --- | --- |
| `type` | Type & size | experience |
| `density` | Density & spacing | experience |
| `hierarchy` | Hierarchy & navigation | experience |
| `color` | Color | experience |
| `branding` | Branding | experience |
| `behavior` | Behavior | experience |
| `feasibility` | Feasibility | architecture |
| `risk` | Risk | architecture |
| `cost` | Cost | architecture |
| `operability` | Operability | architecture |
| `security` | Security | architecture |

## 5. Prototypes

A prototype is static HTML that runs inside a sandboxed frame on the review origin.

**What Odin enforces:**

- Prototypes reference only files inside the package, by relative path, or `data:` URLs.
- An absolute network URL in any HTML, SVG, or CSS file in the package rejects it with `external_url`. Odin looks statically in HTML and SVG `src`, `href`, `srcset`, `action`, `formaction`, `background`, `poster`, `xlink:href`, `<object data>`, `<meta http-equiv="refresh">`, and `style` attributes, and in CSS `url()`, `image-set()`, and `@import`, including `<style>` blocks. Network URLs are `http:`, `https:`, `ws:`, `wss:`, `ftp:`, and protocol-relative `//host/...`. `mailto:`, `tel:`, `javascript:`, and `#fragment` links are not flagged. A root-relative path such as `/logo.png` is not flagged either, but it leaves the package and returns 404. JavaScript is not scanned.
- The serving CSP blocks everything the scan misses: runtime `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, and images, styles, scripts, and fonts from any other host.
- Inline `<script>`, inline `<style>`, `style` attributes, and inline event handlers such as `onclick` are allowed. `eval` and `new Function` are blocked.
- Forms cannot submit anywhere. Popups and top-level navigation are blocked.
- A prototype can move between its own pages, but it cannot navigate its frame to another host: the app's pages allow frames only from the review origin (`frame-src`).
- A prototype loads only its own directory and the package's shared files: everything outside every prototype directory except image screen files and `manifest.json` (section 6). The review origin answers 404 for anything else, and a static reference to it in HTML, SVG, or CSS rejects the package with `reference_out_of_scope`.
- Package HTML and SVG open only inside Odin, as a frame, an image, or a fetch. Opening one directly as a page returns 403 ("Open this prototype from OdinPMP"), and so does a browser that sends no Fetch Metadata (`Sec-Fetch-Dest`): prototypes need Chrome or Edge 80+, Firefox 90+, or Safari 16.4+.
- Not enforced: WebRTC. No browser lets a CSP block it, so a prototype script can still reach another host that way. Odin accepts this; reviewers are told not to type real personal or payment details into a prototype.
- Cookies, `localStorage`, and `sessionStorage` are unavailable, because the frame has an opaque origin. A prototype that needs state keeps it in memory.

Every response from the review origin carries this policy, so even a document opened outside Odin runs sandboxed:

```text
Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' data: blob:; style-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; frame-ancestors <app origin>; form-action 'none'
```

**The bridge.** Odin inserts `<script src="/__odin/bridge.js"></script>` at the end of `<head>` in every served HTML document, or at the start of `<body>` when the document has no head. Prototypes do not include it themselves. It provides three things:

- **State.** By default a state's key is the document's path inside the package plus `location.hash`, for example `prototypes/booking/index.html#confirm`. A prototype can name its current state with `window.OdinReview.setState('<key>')`; the key must be an id. Keys declared in `states` appear as chips reviewers can jump between. Jumping sets `location.hash` to `#<key>`, so a prototype that declares states must handle that hash. Call `setState` from the `hashchange` handler: a navigation clears the named state until the prototype names a new one.
- **Snapshots.** When a reviewer switches to Annotate, the bridge draws the visible viewport into a PNG at one image pixel per CSS pixel, so annotation coordinates match the frame. It renders from computed styles, and fetches the package's own images, background images, and `@font-face` fonts so they appear in the snapshot. Limits:
  - canvas that cannot be read, video (other than its poster), and nested frames come out blank;
  - `position: sticky` elements may render where they sit unstuck;
  - scroll positions inside scrolled elements are approximated;
  - only open shadow roots are captured;
  - images and fonts are inlined up to 8 MB per snapshot, and anything past that comes out blank;
  - a capture that takes more than 20 seconds fails;
  - while capturing, the bridge briefly adds a hidden element to the page.

  When a capture fails, Odin falls back to a blank frame of the declared viewport with a note.
- **Element hints.** Put `data-odin-id="<id>"` on meaningful elements. A comment placed on an element records the nearest `data-odin-id`, the tag name, the first 80 characters of its text, and its box in frame coordinates.

`window.OdinReview` is a frozen object: `{ bridge: true, version: 1, setState(key) }`. `setState` returns `false` and changes nothing when the key is not an id.

**Bridge messages.** This part is for the Odin app; prototypes do not need it.

The app embeds a screen as `<iframe sandbox="allow-scripts allow-forms">` whose `src` is the screen's entry URL plus `?odin-parent=<app origin>`. The bridge posts only to an origin the review origin allows: the `odin-parent` value if it is allowed, otherwise `location.ancestorOrigins[0]` if that is allowed, otherwise the single allowed origin. The parent origin travels in the query string, not the fragment, because prototypes own the hash.

The frame has an opaque origin, so every message reaches the parent with `event.origin === 'null'`. The parent must check `event.source === iframe.contentWindow` and `data.source === 'odin-review-bridge'`, and must treat every field as untrusted: prototype code runs in the same frame and can post the same messages.

Messages from the bridge. Each one also carries `source: 'odin-review-bridge'` and `version: 1`.

| `type` | Fields | Sent |
| --- | --- | --- |
| `ready` | `state: { key, declared, path, hash }`, `viewport: { width, height, devicePixelRatio }`, `scroll: { x, y, width, height }` | Once the document is parsed, and in reply to `ping` |
| `state` | `key`, `declared`, `path`, `hash` | After a hash change, a history navigation, or `setState` |
| `scroll` | `scroll` | While the document scrolls, at most every 100 ms |
| `viewport` | `viewport`, `scroll` | After a resize |
| `capture` | `requestId`, `dataUrl` (PNG), `width`, `height`, `stateKey`, `scroll` | In reply to `capture` |
| `capture-failed` | `requestId`, `reason` | In reply to `capture`, when the capture fails or takes more than 20 seconds |
| `hint` | `requestId`, `x`, `y`, `hint: { odinId, tag, text, box: { x, y, width, height } }` or `hint: null` | In reply to `hint` |

Messages to the bridge. The bridge ignores any message whose `event.source` is not `window.parent`.

| `type` | Fields |
| --- | --- |
| `capture` | `requestId` (optional), `scale` (optional, 0.25-2, default 1) |
| `hint` | `x`, `y` in CSS pixels of the frame, `requestId` (optional) |
| `goto-state` | `key` |
| `ping` | none |

## 6. Versions and carry-forward

Odin assigns version numbers across the project. A package never states its own version.

A content hash is computed per screen:

- For an `image`, it covers the image bytes.
- For a `prototype`, it covers everything the prototype may load. The review origin serves a prototype nothing else (section 5), so its scripts cannot reach a file the hash misses:
  - Every file under the directory that contains `src`, ordered by path. Paths are taken relative to that directory, so moving the whole directory keeps the hash. A prototype at the package root leaves `manifest.json` out.
  - Every shared file: any file that is not `manifest.json`, not under a prototype screen's directory, and not an image screen's `src`. Shared files are hashed by their full package path, in a separate part of the hash from the prototype's own files. Changing, adding, or removing a shared file, such as anything in `assets/`, marks every prototype changed, whether or not it uses that file. This is deliberate. A false "changed" only makes annotations `outdated`, and their author can carry them forward; a false "unchanged" would carry them onto a layout that moved.

  Another prototype's files and image screen files are outside this prototype's scope. Changing them never changes this prototype's hash, because it cannot load them: the review origin answers 404, and a static reference to them from HTML, SVG, or CSS (where the URL scan looks, section 5) rejects the package with `reference_out_of_scope`. A reference resolves against the file that contains it; a query string or fragment is ignored, and a path ending in `/` means that directory's `index.html`. To use an image in more than one prototype, put it in `assets/`.

When a new version publishes, Odin compares each screen to the previous version by `id`:

| Previous screen | New version | Open annotations become |
| --- | --- | --- |
| Same id, same hash | unchanged | `carried` |
| Same id, different hash | changed | `outdated` (its author, or an admin or manager, carries it forward or closes it) |
| id missing | removed | `superseded` |

Question answers are matched by question `id` too. A new version shows a reviewer's previous answer, marked as given on the earlier version, as long as it is still a valid answer to the question. It counts for the new version only once the reviewer answers again.

## 7. Validation results

Upload returns either an accepted draft or a list of problems. Nothing is stored when any error exists.

An unreadable zip, or one over a size or count limit, stops the check at once. Otherwise Odin reports every problem in one response, with two exceptions: the checks that follow the schema (cross-references, scope, and Mermaid) run only on a manifest that passes it, and the malware scan runs only when nothing else failed.

```json
{
  "status": "rejected",
  "errors": [
    { "file": "manifest.json", "path": "/sections/3/items/1/src", "code": "missing_file", "message": "screens/confirm.png is not in the package." }
  ],
  "warnings": [
    { "file": "manifest.json", "path": "/theme", "code": "unknown_field", "message": "Unknown field \"theme\" was ignored." }
  ]
}
```

`path` is a JSON Pointer into the manifest, or empty for problems with the zip or with a file other than the manifest. `file` names the file the problem is in, or is empty for the zip as a whole. Warnings come back with a rejection too.

Error codes:

| Code | Meaning |
| --- | --- |
| `zip_invalid` | Not a readable zip, empty, or an entry is corrupt. |
| `zip_limit` | Size, entry count, path length, or compression ratio over the limit, or an entry that unpacks past its declared size. |
| `path_invalid` | A path escapes the package, is absolute, uses `\` or control characters, is reserved, is a symlink or an empty directory, appears twice, or collides with another path. |
| `type_not_allowed` | A file extension is not allowed, a file has no extension, or an HTML or JavaScript file sits outside a prototype's directory. |
| `scan_failed` | Malware scan flagged a file or could not run. |
| `manifest_missing` | No `manifest.json` at the root. |
| `manifest_invalid` | Not JSON, larger than 512 KB, or fails the schema. The message names the rule. Two rules the schema cannot express also report this code: a section type that appears more than once, and a `scale` whose `min` is not below `max` or whose range is more than 10. |
| `track_mismatch` | `track` is not `experience`. |
| `missing_file` | A `src` names a file that is not in the package. Paths are case-sensitive. |
| `reference_invalid` | A `directionId`, `screenIds` entry, or `topicId` does not resolve. |
| `duplicate_id` | An id repeats within its kind: sections, directions, screens, flows, questions, a question's options, a screen's state keys, or feedback dimensions. |
| `external_url` | An HTML, SVG, or CSS file references an absolute network URL (section 5). |
| `reference_out_of_scope` | A prototype file, or a shared file, statically references a package file a prototype cannot load: another prototype's file, an image screen's file, or `manifest.json` (sections 5 and 6). |
| `mermaid_invalid` | Mermaid's parser rejects a flow, or Odin could not run the check. Problems that appear only at layout time are not caught. |

Warning codes:

| Code | Meaning |
| --- | --- |
| `unknown_field` | A top-level field Odin does not know. It is removed from the stored manifest. |
| `size_mismatch` | An image screen's `width` or `height` differs from the file's header. |
| `stale_base_round` | `basedOnRoundId` is not the project's latest published round, or the project has no rounds yet. |

**Upload responses.** Members upload with `POST /api/projects/:projectId/requirements/packages/upload`, and replace an unpublished draft with `POST .../packages/:packageId/replace`. An upload URL takes `PUT /api/public/requirements-uploads/<token>`. Each takes the zip as the raw request body with `Content-Type: application/zip`; `application/x-zip-compressed` and `application/octet-stream` are also accepted.

- An accepted package returns 201 with the new draft.
- A rejected package returns 422 with `{ "ok": false, "status": "rejected", "errors": [...], "warnings": [...] }`.
- A body over the size limit is also a 422, with one `zip_limit` error, not a 413.
- Any other content type returns 415.
- A replacement whose draft was published, withdrawn, or replaced first returns 409 and stores nothing.

Uploads through an upload URL return the same shapes, plus `uploadId` and `state`. The URL is spent once Odin starts checking the zip, whatever the outcome. A wrong content type or an oversized body is refused before that, so the URL still works. A URL that is unknown, expired, already used, or whose creator lost upload access returns 404, and too many requests return 429 with `Retry-After`.

## 8. Feedback returned

`odin_get_round_feedback` and the Requirements API return a round's feedback in this shape. Fields not yet given are omitted, never guessed.

```json
{
  "schema": "odin.round-feedback/v1",
  "round": { "id": "", "number": 2, "track": "experience", "packageVersion": 2, "status": "open", "dueAt": "" },
  "reviewers": [{ "actorRef": "stakeholder:…", "name": "", "required": true, "submittedAt": null }],
  "directions": [{ "actorRef": "", "directionId": "", "stance": "preferred|acceptable|rejected", "remix": "" }],
  "verdicts": [{ "actorRef": "", "screenId": "", "overall": "keep|keep-with-changes|change|undecided", "dimensions": { "type": "keep" }, "stay": "", "change": "", "mixed": "" }],
  "annotations": [{
    "id": "", "screenId": "", "stateKey": null, "snapshotUrl": null, "actorRef": "", "category": "hierarchy",
    "status": "open|resolved|carried|outdated|superseded", "elementHint": null,
    "shapes": [{ "schemaVersion": 1, "type": "box", "x": 728, "y": 381, "w": 512, "h": 154, "style": { "color": "#c2410c", "stroke": 4 } }],
    "thread": [{ "actorRef": "", "body": "", "createdAt": "" }]
  }],
  "answers": [{ "actorRef": "", "questionId": "", "value": "range-on-home", "postedCommentId": "" }],
  "summaries": { "round": {}, "screens": { "<screenId>": {} } },
  "page": { "annotationsTotal": 1, "limit": 200, "nextCursor": null }
}
```

Large rounds page their annotations. `GET /api/projects/:projectId/requirements/rounds/:roundId/feedback` takes `limit` (1-500, default 200) and `cursor` (the previous page's `page.nextCursor`). Every page repeats the round, reviewers, directions, verdicts, answers, and summaries; `nextCursor` is null on the last page. `odin_get_round_feedback` pages the same way, with `limit` 1-200 (default 50). `snapshotUrl` points at the Requirements API, so fetching it needs the same access as the feedback.

Shape coordinates are in source pixels of the screen image or snapshot. Shape types:

| Type | Fields |
| --- | --- |
| `pin` | `x`, `y`, `number` |
| `box` | `x`, `y`, `w`, `h` |
| `arrow` | `x`, `y`, `x2`, `y2` |
| `pen` | `points` (array of `[x, y]`, simplified) |
| `highlight` | `x`, `y`, `w`, `h` |
| `text` | `x`, `y`, `w`, `h`, `text`, `fontSize` |

Every shape carries `schemaVersion` and `style` (`color` and `stroke`). Each summary is an Odin summary's structured output, with `aligned`, `divergent`, `feedbackThemes`, `underExplored`, `outstanding`, `proposedAnswer`, `proposedAnswerSources`, `proposedAnswerStatus`, `proposedPreferences`, and `insufficientInput`. `backend/src/modules/requirements/summary/summary-output.js` in the Odin repo defines it.

## 9. Example

[`examples/fieldwork-round-2.manifest.json`](./examples/fieldwork-round-2.manifest.json) (in the package kit, `examples/fieldwork-round-2/manifest.json`) is a complete manifest for the Experience round in the design review. It validates against the schema. Its two `topicId` values exist only in Odin's tests, so a real project rejects it with `reference_invalid` until they name that project's topics or are removed.
