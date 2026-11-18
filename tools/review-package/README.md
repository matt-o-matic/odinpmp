# Review packages

A review package is the zip a developer, or a developer's coding agent, uploads to an Odin project's Requirements section.

| Read this | For |
| --- | --- |
| [`docs/requirements-gathering/agent-guide.md`](../../docs/requirements-gathering/agent-guide.md) | Building a package: what goes in the zip, the rules that reject it, validating, uploading. Start here, and give it to agents. |
| [`docs/requirements-gathering/package-spec.md`](../../docs/requirements-gathering/package-spec.md) | The full contract, including the prototype bridge and the feedback format. |
| [`review-package.schema.json`](../../docs/requirements-gathering/review-package.schema.json) | The manifest's JSON Schema. |

## Giving it to an agent outside this repo

In Odin, open the project's Requirements and go to the Review tab. Review is project-wide, so there is no track to choose.

- **Download package kit** gives a zip with the agent guide as `README.md`, the spec, the schema, the Experience example (`fieldwork-round-2`), and `validate.mjs` with a `package.json` and the validator files it needs. The backend builds the kit from this folder and `docs/requirements-gathering/` (`backend/src/modules/requirements/packages/package-kit.js`), so it always matches what Odin enforces.
- **Agent instructions** opens one block, with a **Copy instructions** button, holding the project id, the track, the round to build on, the next version number, up to 60 topic ids that questions can link to, and the rules and upload steps.
- **Upload URL for a coding agent** creates a single-use upload URL. Its **Copy agent instructions** button adds the URL to the same block.

## Validating

```sh
node tools/review-package/validate.mjs <package.zip | package-folder> --track experience
```

Exit code 0 means Odin would accept the package, apart from the topic id lookup and the malware scan, which need a project. Exit code 1 means it has errors, and 2 is a usage error. Without `--track`, the script uses the manifest's own track and skips the track check; Odin accepts only `experience`. `--json` prints the errors, warnings, status, and `mermaidChecked`. In this repo the script uses the backend's validator and checks Mermaid. In the package kit it runs after `npm install`, uses the copy in `validator/`, and leaves Mermaid to the upload.

## Examples

| Example | Track | What it shows |
| --- | --- | --- |
| `examples/fieldwork-round-2/` | Experience | Two image screens, a clickable prototype with declared states, directions, a flow, and four questions (single choice, text, and scale) |
| `scheduling-options` (manifest only) | Experience | A package with no screens: options as directions, sequence diagrams as flows, and custom feedback dimensions. The package kit leaves it out. |

The manifests live in `docs/requirements-gathering/examples/` so the spec and the examples cannot drift apart. Asset folders live here.

The Experience example links two questions to `topic-exp-01` and `topic-exp-03`, which exist only in Odin's test fixtures. A real project rejects it with `reference_invalid` until each `topicId` names one of that project's topics or is removed. `validate.mjs` cannot check topic ids, so it accepts the example as built.

Build both zips into `output/review-packages/`:

```sh
node tools/review-package/build-examples.mjs
```

`screens-src/` holds the HTML used to render the example screenshots. Neither the build nor the package kit includes it.

## Prototype checklist

- One directory per prototype, holding its entry `.html` file (usually `index.html`) and its own scripts. Odin hashes the whole directory, plus the package's shared files, to decide whether a screen changed between versions.
- Relative paths only. No CDN scripts, fonts, or API calls; the review origin blocks network access.
- Handle `#<state-key>` for every key declared in the manifest's `states`, and call `window.OdinReview?.setState('<key>')` when the state changes. See `examples/fieldwork-round-2/prototypes/booking/app.js`.
- Put `data-odin-id` on elements reviewers are likely to comment on, so comments record which element they point at.
- Don't rely on cookies, `localStorage`, or `sessionStorage`; the frame has an opaque origin, so none of them work.
