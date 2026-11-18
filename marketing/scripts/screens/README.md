# Marketing screenshots

Real screenshots of the Odin app for the marketing site, in light and dark mode, with demo data for a fictional client.

## Regenerate

From the repository root:

```sh
node marketing/scripts/screens/run.mjs
```

This starts the frontend dev server on port 4199, captures every screen with the frontend's installed `@playwright/test` (Chromium only), then publishes WebPs from the PNGs. A full run takes about 30 seconds.

Output:

- `output/marketing-screens/<name>-light.png` and `-dark.png`: the 1440x900 viewport at 2x, so 2880x1800. `output/` is git-ignored, so the full-size PNGs never ship.
- `marketing/public/screens/<name>-light.webp` and `-dark.webp`: 1600x1000, quality 82, used by the site.
- `marketing/public/screens/thumb/<name>-light.webp` and `-dark.webp`: 1024 wide, the textures on the hero's 3D ring.

Options:

- `ODIN_SCREENS=home,kanban node marketing/scripts/screens/run.mjs` captures a subset. The WebP step still converts every PNG in `output/marketing-screens/`.
- `ODIN_PLAYWRIGHT_PORT=4210` moves the dev server if 4199 is busy.
- `node marketing/scripts/screens/run.mjs --webp-only` rebuilds the WebP files without capturing.
- `ODIN_SCREENS_DEBUG=1` also writes a full-page copy of each screen to `output/playwright/marketing-screens/debug/`, for checking what lies below the fold.
- `ODIN_SCREENS_WORKERS` sets how many screens are captured at once (default 4).
- Any other arguments go to `playwright test`.

Requirements: `npm install --prefix frontend` (Playwright and its Chromium) and `npm install --prefix marketing` (`sharp` for WebP, and `@fontsource-variable/space-grotesk`). Archivo Black and JetBrains Mono are read from the installed system fonts. On a machine without them, put `ArchivoBlack-Regular.ttf`, `JetBrainsMono-Regular.ttf` and `JetBrainsMono-Bold.ttf` in `marketing/scripts/screens/fonts/`, or the wordmark, headings and eyebrow labels fall back to another font.

## Screens

| Name | Screen |
| --- | --- |
| `home` | Home, team view: Sprint 14 behind, recovery options, the ranked Focus list, the side rail |
| `workbench` | Project outline, the "Start a return online" story in the editor, project stats |
| `kanban` | Sprint 14 board with four columns |
| `insights` | Project Insights: health banner, headline tiles, burnup and burndown charts |
| `projects` | Projects list with what is waiting on you and open reviews |
| `leaderboard` | Contributor leaderboard, 30 days |
| `requirements-items` | Requirements, My open items with the stage strip |
| `requirements-topic` | A topic with its discussion and the Odin summary |
| `requirements-results` | Round 2 results with the verdict grid |
| `requirements-review` | A stakeholder's guided review of one screen, with marks and a pinned comment |
| `portal` | The stakeholder portal inbox |
| `ai-workspace` | AI Workspace chat on Sprint 14: two changes made after Priya said yes, listed with Undo, and a comment that mentions Sam waiting for Confirm |
| `workflows` | Workflow definition editor with the state-machine preview |
| `tickets` | Tickets board |
| `ai-memory` | What the AI remembers, one memory expanded |
| `compliance` | Compliance, legal holds |

## How it works

- `playwright.config.js` and `screens.capture.js` run with the frontend's Playwright through `run.mjs`. The config does not import `@playwright/test`, and `lib/harness.js` imports it by path from `frontend/node_modules`, so the spec and the shared fixtures load the same copy. The `*.capture.js` name and this folder's own `testDir` keep it out of `npm run test:e2e`.
- The mocked API comes from the acceptance fixtures in `frontend/e2e/fixtures/`, imported, not copied. Routes registered after `installSyntheticApi` win, and the screens add richer payloads from `lib/demo-data.js` and `lib/demo-data-more.js`.
- The `ai-workspace` screen calls no model. It hands a stored chat (`demoAssistantChat()` in `lib/demo-data-more.js`) to the shared fixture's `assistantChat` option, the way the frontend's acceptance specs do, and serves a few earlier chats for the chat list. The `ai-workspace` images are also the hero's Brief texture.
- `storyPage()` in `lib/harness.js` wraps `page.route` so every fixture response passes through text rules that rename the fixture people and project and move the requirements story (a home-services booking app) to Harbor & Pine (booking a bike or ski service). Before each shot the same name rules run over the page text, and the capture fails if "synthetic", a spinner, an alert or an error message is visible.
- The review screens show `prototype/booking-home*.html`, rendered to PNG at run time and served in place of the fixture's example package images.
- `lib/pin-clock.js` shifts the worker's clock to Monday Oct 12, 2026, 9:30 PM Eastern, and each page gets a matching fixed clock, so dates and "time ago" labels come out the same on every run.
- Theme: the app adds `class="dark"` to `<html>` from the signed-in user's `preferences.darkMode`, falling back to `localStorage['odinpmp.theme.dark']`. Each screen loads fresh with both set.
- Network: the app's `index.html` loads fonts from Google Fonts. Those requests are answered from local font files, every other request off this machine is aborted, and Chromium's host resolver maps every other host to "not found", so nothing leaves the machine except calls to the local dev server.

## Demo story

Harbor & Pine Outfitters' digital team is relaunching its customer portal: accounts and sign-in, orders and returns, booking a bike or ski service at a shop, and launch readiness. Sprint 14 is behind because the online returns work slipped.

- Priya Natarajan, delivery lead (the signed-in user)
- Marcus Chen, engineering manager and workspace admin
- Sam Ortiz and Lee Park, engineers
- Dana Reyes, product designer
- Ava Lindqvist, customer care lead and requirements stakeholder
- Ravi Shah (Finance) and Noor Haddad (Operations), stakeholders reviewing through the portal

All names are fictional and every email address uses `example.com`.

## Hero textures for Bug Reporter and FaultLine

The hero's 3D ring has seven stations. Five use the app screens above. Bug Reporter and FaultLine live in other repositories, so their two stations use this site's own hand-built demos in their finished state. Start the site, then run:

```
npm --prefix marketing run dev
node marketing/scripts/screens/hero-demos.mjs http://127.0.0.1:2281/
```

It writes `marketing/public/screens/thumb/bug-reporter-*.webp` and `faultline-*.webp`.
