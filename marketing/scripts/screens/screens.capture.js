// Captures the Odin app for the marketing site, in light and dark mode, against the mocked
// API the acceptance specs use. See README.md for the command.

// First: pins the clock before the fixtures below read it.
import { demoNow } from './lib/pin-clock.js';
import { installSyntheticApi } from '../../../frontend/e2e/fixtures/synthetic-api.js';
import { installInsightsApi, insightsPayload } from '../../../frontend/e2e/fixtures/insights-api.js';
import { defaultRequirementsScenario, installRequirementsApi } from '../../../frontend/e2e/fixtures/requirements-api.js';
import { PORTAL_TOKENS, createReviewWorld, drawMark, installPortalApi } from '../../../frontend/e2e/fixtures/requirements-portal-api.js';
import { installRequirementsRoundsApi, roundsScenario } from '../../../frontend/e2e/fixtures/requirements-rounds-api.js';
import { installAdminScreensApi } from '../../../frontend/e2e/fixtures/admin-screens-api.js';

import {
  API_ORIGIN, THEMES, applyStoredTheme, capture, expect, guardNetwork, json, signInDemoUser, storyPage, test,
} from './lib/harness.js';
import { installHarborPineScreens } from './lib/review-origin.js';
import { demoAssistantChat, demoAssistantChatList, demoCompliance, demoMemories, demoTickets, demoWorkflow, demoWorkspaceUsers } from './lib/demo-data-more.js';
import {
  HOME_AS_OF, PEOPLE, PROJECT_ID, PROJECT_NAME, demoComments, demoGovernance, demoHome, demoLeaderboard, demoProject, demoProjectList,
  demoProjectSignals, demoScheduleAnalysis, kanbanBoard, kanbanConfig, validUsersPayload,
} from './lib/demo-data.js';

const PROJECT_API = `/api/projects/${PROJECT_ID}`;
const REQUIREMENTS = `projects/${PROJECT_ID}/requirements`;

/** The Requirements area with the rounds scenario: open round 2, verdicts, drafts. */
async function openRequirements(page, browser, theme, { scenario = roundsScenario() } = {}) {
  // The rounds scenario carries one preference that exists only to test scoping.
  scenario.proposedPreferences = scenario.proposedPreferences.filter((entry) => entry.key !== 'summary-other:0');
  const routed = await openApp(page, { clock: demoNow(), theme });
  const requirements = await installRequirementsApi(routed, scenario);
  if (scenario.roundsState) await installRequirementsRoundsApi(routed, requirements);
  await installHarborPineScreens(page, browser);
  await installDemoProject(page);
  await signInDemoUser(page, { theme });
  return requirements;
}

/** The stakeholder portal as Ravi Shah from Finance, who has a link and no account. */
async function openPortal(page, browser, theme) {
  const world = createReviewWorld({ withOutdated: false });
  world.portal.project.name = PROJECT_NAME;
  // Ava's earlier mark says the booking button should be bigger; put the pin on that button.
  Object.assign(world.annotations[0].shapes[0], { x: 196, y: 296 });
  const routed = await openApp(page, { clock: demoNow(), theme });
  await installPortalApi(routed, world, { token: PORTAL_TOKENS.ravi });
  await installHarborPineScreens(page, browser);
  await applyStoredTheme(page, theme);
  return world;
}

/** Scrolls the window so `locator` sits `gap` CSS pixels below the app's sticky header bars. */
async function scrollBelowStickyChrome(locator, gap = 12) {
  await locator.first().evaluate((element, offset) => {
    const chrome = [...document.querySelectorAll('.app-frame > .navbar, .project-detail-tabs-bar')];
    const stickyBottom = () => Math.max(0, ...chrome.map((node) => node.getBoundingClientRect().bottom));
    // The app scrolls smoothly; jump instead so each measurement sees the final position.
    const jumpBy = (delta) => window.scrollTo({ behavior: 'instant', top: Math.max(0, window.scrollY + delta) });
    jumpBy(element.getBoundingClientRect().top - 240);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const delta = element.getBoundingClientRect().top - (stickyBottom() + offset);
      if (Math.abs(delta) < 1) break;
      jumpBy(delta);
    }
    // The sticky bars are translucent. Hide whatever now sits entirely beneath them so it
    // cannot show through; nothing visible changes.
    const limit = stickyBottom() + 0.5;
    for (const node of document.body.querySelectorAll('*')) {
      if (chrome.some((bar) => bar === node || bar.contains(node) || node.contains(bar))) continue;
      const box = node.getBoundingClientRect();
      if (box.height > 0 && box.bottom <= limit) node.style.visibility = 'hidden';
    }
  }, gap);
}

/**
 * The shared mocked API with the demo user signed in and the demo project in place of the
 * fixture's one-story project. Returns the rewriting page for any further fixture installs.
 */
async function openApp(page, { admin = false, theme, clock = null, installSynthetic = {} } = {}) {
  await guardNetwork(page);
  const routed = storyPage(page);
  await installSyntheticApi(routed, { admin, ...installSynthetic });
  if (clock) await page.clock.setFixedTime(new Date(clock));
  return routed;
}

async function installDemoProject(page) {
  const project = demoProject();
  const governance = demoGovernance();
  const listed = demoProjectList().map((entry) => (entry.id === PROJECT_ID ? { ...project, updatedAt: entry.updatedAt } : entry));
  await page.route((url) => url.origin === API_ORIGIN && url.pathname.startsWith('/api/'), (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET') return route.fallback();
    if (pathname === '/api/projects') return json(route, { ok: true, projects: listed });
    if (pathname === '/api/requirements/project-signals') return json(route, { ok: true, projects: demoProjectSignals() });
    if (pathname === PROJECT_API) return json(route, { project });
    if (pathname === `${PROJECT_API}/valid-users`) return json(route, validUsersPayload());
    if (pathname === `${PROJECT_API}/governance`) return json(route, { ok: true, ...structuredClone(governance) });
    if (pathname === `${PROJECT_API}/governance/schedule-analysis`) return json(route, { analysis: demoScheduleAnalysis(governance), ok: true });
    if (pathname === `${PROJECT_API}/comments`) return json(route, { comments: demoComments() });
    return route.fallback();
  });
  return project;
}

async function installHome(page) {
  await page.route(`${API_ORIGIN}/api/home**`, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === 'GET' && pathname === '/api/home') return json(route, demoHome());
    if (request.method() === 'PUT' && pathname === '/api/home/lens') return json(route, { lens: 'team', ok: true });
    return route.fallback();
  });
}

const SCREENS = [
  {
    name: 'home',
    async open(page, theme) {
      await openApp(page, { clock: HOME_AS_OF, theme });
      await installDemoProject(page);
      await signInDemoUser(page, { theme });
      await installHome(page);
      await page.goto('');
      await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Priya$/ })).toBeVisible();
      await expect(page.getByText('Sprint 14 is behind').first()).toBeVisible();
    },
  },
  {
    name: 'workbench',
    async open(page, theme) {
      await openApp(page, { clock: HOME_AS_OF, theme });
      await installDemoProject(page);
      await signInDemoUser(page, { theme });
      await page.goto(`projects/${PROJECT_ID}?item=story-returns`);
      await expect(page.locator('button.outline-row--project')).toBeAttached();
      const navigator = page.getByRole('button', { name: 'Open structure navigator' });
      if (await navigator.isVisible()) await navigator.click();
      // Fold the finished epic and the neighbouring story so the selected story sits in view.
      await page.locator('[data-epic-id="epic-accounts"] > .outline-row-wrap > .outline-toggle').click();
      await page.locator('[data-story-id="story-history"] > .outline-row-wrap > .outline-toggle').click();
      await expect(page.locator('.outline-row--active .outline-row__title-text', { hasText: 'Start a return online' })).toBeVisible();
    },
  },
  {
    name: 'kanban',
    async open(page, theme) {
      await openApp(page, { clock: HOME_AS_OF, theme });
      const project = await installDemoProject(page);
      await page.route(`${API_ORIGIN}${PROJECT_API}/kanban/config`, (route) => json(route, kanbanConfig()));
      await page.route((url) => url.pathname === `${PROJECT_API}/kanban`, (route) => json(route, kanbanBoard(project)));
      await signInDemoUser(page, { theme });
      await page.goto(`projects/${PROJECT_ID}/kanban`);
      await expect(page.locator('[data-card-id="task-return-reasons"]')).toBeVisible();
    },
  },
  {
    name: 'insights',
    async open(page, theme) {
      const routed = await openApp(page, { admin: true, clock: '2026-10-09T17:40:00.000Z', theme });
      await installInsightsApi(routed, {
        payload: (layout) => {
          const payload = insightsPayload({ layout });
          // Priya is the delivery lead; the banner keeps the two project-level signals.
          payload.health.signals = payload.health.signals.filter((signal) => signal.scope !== 'person');
          for (const signal of payload.health.signals) {
            if (signal.scope === 'project') signal.headline = signal.headline.replace('Payments integration', 'Online returns');
            for (const entry of signal.evidence) entry.label = entry.label.replace('Payments integration', 'Online returns');
          }
          payload.health.headline = payload.health.headline.replace('Payments integration', 'Online returns');
          for (const milestone of payload.cards.milestones.data.milestones) {
            milestone.title = { 'Beta release': 'Beta for store staff', 'Payments integration': 'Online returns live', 'UAT sign-off': 'Store pilot sign-off', 'Go-live': 'Portal go-live' }[milestone.title] ?? milestone.title;
          }
          payload.cards.throughput.data.contributorCount = 5;
          payload.cards.throughput.data.rows = [
            { hoursLogged: 64, id: PEOPLE.lee.id, name: PEOPLE.lee.name, points: 58, tasksCompleted: 14 },
            { hoursLogged: 52, id: PEOPLE.dana.id, name: PEOPLE.dana.name, points: 44, tasksCompleted: 12 },
            { hoursLogged: 49.5, id: PEOPLE.sam.id, name: PEOPLE.sam.name, points: 39, tasksCompleted: 10 },
            { hoursLogged: 41.5, id: PEOPLE.marcus.id, name: PEOPLE.marcus.name, points: 31, tasksCompleted: 9 },
            { hoursLogged: 22, id: PEOPLE.priya.id, name: PEOPLE.priya.name, points: 12, tasksCompleted: 4 },
          ];
          return payload;
        },
      });
      await installDemoProject(page);
      await signInDemoUser(page, { admin: true, theme });
      await page.goto(`projects/${PROJECT_ID}/insights`);
      await expect(page.getByRole('heading', { level: 2, name: 'Insights' })).toBeVisible();
      await expect(page.locator('.insights-card__placeholder')).toHaveCount(0);
      // Start the frame at the health banner so the tiles and the first charts fill it.
      await scrollBelowStickyChrome(page.locator('.insights-health'), 12);
    },
  },
  {
    name: 'projects',
    async open(page, theme) {
      await openApp(page, { admin: true, clock: '2026-10-12T14:00:00.000Z', theme });
      await installDemoProject(page);
      await signInDemoUser(page, { admin: true, theme });
      await page.goto('projects');
      await expect(page.getByRole('table').getByRole('link', { name: 'Customer Portal Relaunch' })).toBeVisible();
    },
  },
  {
    name: 'leaderboard',
    async open(page, theme) {
      await openApp(page, { clock: HOME_AS_OF, theme });
      await installDemoProject(page);
      await page.route(`${API_ORIGIN}/api/metrics/leaderboard**`, (route) => json(route, demoLeaderboard(Number(new URL(route.request().url()).searchParams.get('days')) || 30)));
      await signInDemoUser(page, { theme });
      await page.goto('leaderboard');
      await expect(page.getByRole('heading', { level: 1, name: 'Leaderboard' })).toBeVisible();
      await expect(page.getByText('Lee Park').first()).toBeVisible();
    },
  },
  {
    name: 'requirements-items',
    async open(page, theme, { browser }) {
      await openRequirements(page, browser, theme);
      await page.goto(REQUIREMENTS);
      await expect(page.getByRole('region', { name: 'Needs your decision' })).toBeVisible();
    },
  },
  {
    name: 'requirements-topic',
    async open(page, theme, { browser }) {
      await openRequirements(page, browser, theme, { scenario: defaultRequirementsScenario() });
      await page.goto(`${REQUIREMENTS}/topics/topic-price`);
      await expect(page.getByRole('heading', { name: 'Should customers see an estimated price before they pick a time?' })).toBeVisible();
    },
  },
  {
    name: 'requirements-results',
    async open(page, theme, { browser }) {
      await openRequirements(page, browser, theme);
      await page.goto(`${REQUIREMENTS}/experience/review/rounds/round-2`);
      await expect(page.getByRole('heading', { name: /Round 2 results/ })).toBeVisible();
    },
  },
  {
    name: 'requirements-review',
    async open(page, theme, { browser }) {
      await openPortal(page, browser, theme);
      await page.goto(`requirements/${PORTAL_TOKENS.ravi}/rounds/round-2`);
      await expect(page.getByRole('heading', { name: 'Service booking — price and booking flow' })).toBeVisible();
      await page.getByRole('button', { name: /Start review/ }).click();
      await expect(page.getByRole('heading', { name: 'Compare the directions' })).toBeVisible();
      await page.getByRole('group', { name: 'Your view of Action first' }).getByRole('radio', { name: 'Preferred' }).check();
      await page.getByRole('group', { name: 'Your view of Schedule first' }).getByRole('radio', { name: 'Acceptable' }).check();
      await page.getByRole('button', { name: /^Screens/ }).first().click();
      await expect(page.locator('.annotation-canvas__image')).toBeVisible();
      await expect.poll(() => page.locator('.annotation-canvas__image').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
      await drawMark(page, 'box', [0.56, 0.47], [0.96, 0.66]);
      await page.keyboard.press('Escape');
      await drawMark(page, 'pin', [0.6, 0.48]);
      const thread = page.getByTestId('rq-annotation-thread');
      await thread.getByRole('textbox').fill('“$70–95” should say “before tax”. Most refund disputes start with the price.');
      await thread.getByRole('button', { name: 'Post comment' }).click();
      await expect(thread.getByText('should say “before tax”')).toBeVisible();
      await page.getByRole('group', { name: 'Overall, this screen' }).getByRole('radio', { name: 'Keep with changes' }).check();
      await page.getByRole('radiogroup', { name: /^Type & size/ }).getByRole('radio', { name: 'Keep' }).check();
      await page.getByRole('radiogroup', { name: /^Hierarchy/ }).getByRole('radio', { name: 'Change' }).check();
      await page.getByLabel('What should change?').fill('Put “before tax” under the price range, next to the booking button.');
      await page.getByLabel('What should change?').blur();
      await expect(page.getByTestId('rq-save-status')).toContainText('Saved');
      // The empty reply box is two lines tall and its placeholder needs three, so the text
      // spills past the border. Let the box fit its placeholder for the shot.
      await thread.getByRole('textbox').evaluate((box) => { box.style.minHeight = '4.75rem'; });
    },
  },
  {
    name: 'portal',
    async open(page, theme, { browser }) {
      await openPortal(page, browser, theme);
      await page.goto(`requirements/${PORTAL_TOKENS.ravi}`);
      await expect(page.getByTestId('rq-round-ask')).toBeVisible();
    },
  },
  {
    name: 'ai-workspace',
    async open(page, theme) {
      // The shared fixture serves the open chat; the chat list gets a few earlier chats.
      const chat = demoAssistantChat();
      await openApp(page, { clock: HOME_AS_OF, installSynthetic: { assistantChat: chat }, theme });
      await installDemoProject(page);
      await installHome(page);
      await page.route((url) => url.origin === API_ORIGIN && url.pathname === '/api/assistant/chats', (route) => (
        route.request().method() === 'GET' ? json(route, demoAssistantChatList(chat)) : route.fallback()
      ));
      await signInDemoUser(page, { theme });
      await page.goto(`?assistant=1&assistantSessionId=${chat.id}`);
      const workspace = page.getByRole('dialog', { name: 'AI Workspace' });
      await expect(workspace.getByRole('heading', { name: chat.title })).toBeVisible();
      await expect(workspace.getByRole('navigation', { name: 'Chats' }).getByText('Which stores can take drop-off returns?')).toBeVisible();
      // Open the reply's list of changes, so the shot shows what Odin changed beside Undo.
      const changes = workspace.getByRole('region', { name: 'Changes in Odin' });
      await changes.getByRole('button', { name: 'Made 2 changes in Odin' }).click();
      await expect(changes.getByText('Updated "Return reasons and prepaid labels": assignee')).toBeVisible();
      await expect(changes.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
      // Off the toggle, so it shows no hover background.
      await page.mouse.move(4, 4);
      // The comment that emails Sam waits for Priya.
      const confirmation = workspace.getByRole('region', { name: 'Confirmation' });
      await expect(confirmation.getByRole('button', { name: 'Confirm' })).toBeEnabled();
      await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    },
  },
  {
    name: 'workflows',
    async open(page, theme) {
      await openApp(page, { admin: true, clock: HOME_AS_OF, theme });
      await installDemoProject(page);
      const workflow = demoWorkflow();
      await page.route((url) => url.origin === API_ORIGIN && url.pathname.startsWith('/api/workflows'), (route) => {
        const request = route.request();
        const { pathname } = new URL(request.url());
        if (request.method() !== 'GET') return route.fallback();
        if (pathname === `/api/workflows/definitions/${workflow.id}`) return json(route, { canManage: true, value: structuredClone(workflow) });
        if (pathname === '/api/workflows') {
          return json(route, {
            approvals: [], baselines: [], bindings: [{ id: 'binding-story', itemType: 'story', projectId: PROJECT_ID, version: 1, workflowId: workflow.id }],
            canManage: true, customFields: [], customValues: [], histories: [], limit: 50, offset: 0, projects: [demoProject()], templates: [], total: 1, workflows: [structuredClone(workflow)],
          });
        }
        return route.fallback();
      });
      await signInDemoUser(page, { admin: true, theme });
      await page.goto(`workflows/definitions/${workflow.id}`);
      await page.getByRole('button', { name: 'Edit workflow' }).click();
      await expect(page.getByTestId('workflow-preview')).toBeVisible();
      await expect(page.getByTestId('workflow-validation')).toContainText('The workflow is valid.');
      await scrollBelowStickyChrome(page.locator('.wf-editor-layout'), 16);
    },
  },
  {
    name: 'tickets',
    async open(page, theme) {
      await openApp(page, { clock: HOME_AS_OF, theme });
      await installDemoProject(page);
      const tickets = demoTickets();
      await page.route((url) => url.pathname === '/api/projects/tickets', (route) => json(route, { nextCursor: null, tickets, total: tickets.length }));
      await page.route((url) => url.pathname === '/api/projects/ticket-review-queue', (route) => json(route, { tickets: tickets.filter((ticket) => ticket.externalReviewState === 'pending') }));
      await signInDemoUser(page, { theme });
      await page.goto('tickets');
      await expect(page.getByText('Return label PDF is blank on iOS Safari').first()).toBeVisible();
    },
  },
  {
    name: 'ai-memory',
    async open(page, theme) {
      await openApp(page, { admin: true, clock: HOME_AS_OF, theme });
      await installDemoProject(page);
      const memories = demoMemories();
      await page.route(`${API_ORIGIN}/api/agent-memory**`, (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'GET' || url.pathname !== '/api/agent-memory/browse') return route.fallback();
        const decorate = (memory) => ({ ...memory, canCorrect: !memory.legalHold, canForget: !memory.legalHold, projectName: memory.projectId ? PROJECT_NAME : '' });
        return json(route, { limit: 25, memories: memories.map(decorate), offset: 0, ok: true, permissions: { canGovern: true, editableProjectIds: [PROJECT_ID] }, total: memories.length });
      });
      await signInDemoUser(page, { admin: true, theme });
      await page.goto('ai-memory');
      await page.getByRole('button', { name: 'Returns launch with prepaid labels first' }).click();
      await expect(page.locator('#memory-detail-memory-returns-labels')).toBeVisible();
    },
  },
  {
    name: 'compliance',
    async open(page, theme) {
      const routed = await openApp(page, { admin: true, clock: HOME_AS_OF, theme });
      await installAdminScreensApi(routed);
      await installDemoProject(page);
      const compliance = demoCompliance();
      await page.route((url) => ['/api/compliance', '/api/tenants/existing-users'].includes(url.pathname), (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const { pathname } = new URL(route.request().url());
        return json(route, pathname === '/api/compliance' ? compliance : { ok: true, users: demoWorkspaceUsers() });
      });
      await signInDemoUser(page, { admin: true, theme });
      await page.goto('admin/compliance/legal-holds');
      await expect(page.getByRole('heading', { name: 'Compliance', exact: true })).toBeVisible();
      await expect(page.getByText('unclaimed-property audit').first()).toBeVisible();
      await page.locator('#holds-status').selectOption('all');
      await expect(page.getByText('catalog photography rights').first()).toBeVisible();
    },
  },
];

const only = process.env.ODIN_SCREENS ? new Set(process.env.ODIN_SCREENS.split(',')) : null;

for (const screen of SCREENS) {
  if (only && !only.has(screen.name)) continue;
  for (const theme of THEMES) {
    test(`${screen.name} (${theme})`, async ({ browser, page }) => {
      await screen.open(page, theme, { browser });
      if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/);
      else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
      await capture(page, screen.name, theme, screen.captureOptions);
    });
  }
}
