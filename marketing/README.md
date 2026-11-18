# Odin marketing site

The public site at `odinpmp.com`: the home page, the access request form (`/signup`) and the page it leads to (`/thank-you`), and the privacy and terms pages. It's an Astro site with no server code. Apache serves `marketing/dist`, and the form posts to `/api/public/waitlist` on the same host. The backend saves each request once per email address and emails the addresses in `ACCESS_REQUEST_NOTIFY_EMAILS`, set in the backend's environment.

The previous design is kept, buildable, in `marketing-classic/`.

## Commands

From this folder:

| Command | What it does |
| --- | --- |
| `npm install` | Installs dependencies |
| `npm run dev` | Starts the dev server on `localhost:2281` |
| `npm run build` | Builds the site to `dist/` |
| `npm run preview` | Serves the built site |

In dev, the form posts to `http://localhost:3001`. Set `PUBLIC_API_BASE_URL` to point it somewhere else.

## How the home page is built

- `src/components/home/`: one component per section, in page order: `Hero`, `Journey`, `Tour`, `Ravens`, `Agents`, `BugDemo`, `Platform`, `Trust`, `Closing`.
- `src/scripts/loop-scene.ts`: the hero's 3D ring (three.js). It loads after first paint, pauses off screen, shows one still frame when reduced motion is on, and falls back to an SVG ring without WebGL2.
- `src/components/demos/`: the seven hand-built screens in "Follow one project around the loop". Each is drawn at 1000×625 and scaled to fit. Their colors match the app's `frontend/src/style.css`.
- `src/scripts/timeline.ts`: plays those demos from `data-at`, `data-type`, `data-count` and `data-path` attributes in the markup, and shows the finished state when reduced motion is on.
- `src/scripts/bug-report.ts`: the "Report a bug on this page" demo. It records the visit's page trail and console and lets visitors draw on the page. It never sends anything.
- `src/styles/global.css` holds the site's tokens for both themes. `src/styles/app.css` holds the app look used by the demos.
- The theme follows the system setting until a visitor picks one. The choice is stored in `localStorage` under `odin-theme`.

## Screenshots

`public/screens/` holds real app screens, rendered from the frontend's Playwright fixtures with sample data, in both themes. The `Tour` and `Platform` sections show them. `public/screens/thumb/` holds smaller copies, five of which are textures on the hero's ring, along with the Bug Reporter and FaultLine textures rendered from this site's own demos. To regenerate them, see `scripts/screens/README.md`.

`public/og.png` is the social card: the hero at 1200×630 in dark mode.
