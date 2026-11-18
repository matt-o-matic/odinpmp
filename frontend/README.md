# Odin app

The Vue 3 app at `odinpmp.com/app`: Home, projects, requirements, tickets, the AI Workspace and administration. Vite builds it with the base path `/app/`, and the web server serves `frontend/dist` there. Everything it shows comes from the backend's API.

## Commands

From this folder:

| Command | What it does |
| --- | --- |
| `npm install` | Installs dependencies (`npm run bootstrap` at the root does this too) |
| `npm run dev` | Starts the dev server on `localhost:5173/app` |
| `npm run build` | Builds the app to `dist/` |
| `npm run preview` | Serves the built app |
| `npm test` | Runs the unit tests in `test/` with `node --test` |
| `npm run test:e2e` | Runs the Playwright acceptance tests in `e2e/` |
| `npm run test:e2e:list` | Lists those tests without running them |

From the repo root, `npm run dev:frontend`, `npm run build:frontend`, `npm run preview:frontend` and `npm run test:e2e` do the same.

In development the app calls the API at `http://localhost:3001`. Set `VITE_API_BASE_URL` in `.env.local` to point it somewhere else. A production build calls its own origin. To sign in locally, use the demo login in the root README.

## Layout

- `src/views/`: the screens, one per route in `src/router/index.js`
- `src/components/` and `src/lib/`: components and logic (API client, stores, helpers), grouped by area
- `src/style.css`: the app's styles and theme tokens for light and dark mode
- `public/`: brand marks, the web app manifest and the service worker (`sw.js`), which only production builds register

## Browser tests

- The specs run against mocked API fixtures in `e2e/fixtures/` and never reach the backend or a database.
- Playwright starts its own Vite server on port 4173 and never reuses a running one. Set `ODIN_PLAYWRIGHT_PORT` if that port is busy, and `ODIN_PLAYWRIGHT_WORKERS` to limit workers.
- Every spec runs in desktop Chromium, Pixel 7 Chromium and desktop WebKit. Run `npx playwright install` once to download the browsers.
- Traces, screenshots, videos and the HTML report go to `output/playwright/local/` at the repo root, or to `ODIN_PLAYWRIGHT_OUTPUT_DIR`.
- `e2e/visual.acceptance.spec.js` compares screens with committed macOS baselines. A run on Windows writes its own baselines on first use, and git ignores them.

At the root, the `pr`, `nightly`, `weekly` and `release` test profiles run these specs along with the unit tests; `npm test` runs `pr`. See `tools/test/README.md`.
