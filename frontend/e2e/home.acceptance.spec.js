import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { adminHome, managerHome, memberBehindHome, onTrackHome, syntheticHomePayload } from './fixtures/home-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

const HOME_API = 'http://localhost:3001/api/home';
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa'];

// The recovery proposal staged into an assistant chat, as the server stages it.
const stagedChat = {
  createdAt: '2026-10-12T15:00:00.000Z',
  id: 'session-recovery',
  messages: [{
    content: '**Move 2 stories (13 pts) to Sprint 15**\n\nNothing has changed yet. Apply it below, or ask me about the trade-offs first.',
    createdAt: '2026-10-12T15:00:00.000Z',
    id: 'message-recovery',
    proposal: {
      id: 'proposal-recovery',
      items: [{
        detail: 'Moves “CSV export” and “Map NetSuite cost centers” out of Sprint 14 to Sprint 15.',
        id: 'item-recovery',
        kind: 'recovery',
        label: 'Move 2 stories to Sprint 15',
        payload: { origin: { homeProposalId: 'rp_aaaaaaaaaaaaaaaa', kind: 'home-recovery', type: 'move-scope' }, type: 'sprint_items_move' },
        status: 'pending',
      }],
      rationale: 'Home recovery proposal: Move 2 stories (13 pts) to Sprint 15.',
      source: 'home-recovery',
      status: 'pending',
      title: 'Move 2 stories (13 pts) to Sprint 15',
    },
    role: 'assistant',
  }],
  pending: null,
  projectId: syntheticProject.id,
  projectName: syntheticProject.name,
  run: null,
  settings: { allowWebResearch: true },
  title: 'Move 2 stories (13 pts) to Sprint 15',
  updatedAt: '2026-10-12T15:00:00.000Z',
};

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

async function openHome(page, payloadFor, { assistantChat = null, stage = null } = {}) {
  const api = await installSyntheticApi(page, { assistantChat });
  const requests = { gets: [], lens: [], stage: [] };
  await page.route(`${HOME_API}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/home') {
      const lens = url.searchParams.get('lens');
      requests.gets.push(lens);
      const result = payloadFor(lens, requests.gets.length);
      return result.httpStatus ? json(route, result.body, result.httpStatus) : json(route, result);
    }
    if (request.method() === 'PUT' && url.pathname === '/api/home/lens') {
      requests.lens.push(request.postDataJSON().lens);
      return json(route, { lens: request.postDataJSON().lens, ok: true });
    }
    const match = url.pathname.match(/^\/api\/home\/recovery\/([^/]+)\/stage$/);
    if (request.method() === 'POST' && match) {
      requests.stage.push(match[1]);
      return stage ? stage(route) : json(route, { assistantSessionId: 'session-recovery', ok: true, reused: false });
    }
    return route.fallback();
  });
  await authenticateSyntheticUser(page);
  return { api, requests };
}

async function rootPx(page, rem) {
  return page.evaluate((value) => value * parseFloat(getComputedStyle(document.documentElement).fontSize), rem);
}

async function expectNoAxeViolations(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.home').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.violations).toEqual([]);
}

async function expectNoHorizontalOverflow(page) {
  const viewport = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
}

test.describe('home', () => {
  test('a member who is behind sees why, ways back on track, ranked focus and the rail', async ({ page, isMobile }, testInfo) => {
    const { api } = await openHome(page, () => memberBehindHome());
    await expect(page.getByRole('group', { name: 'Home view' })).toHaveCount(0);

    const behind = page.getByRole('region', { name: "You're behind in Sprint 14" });
    await expect(behind).toBeVisible();
    await expect(behind.getByRole('img', { name: 'Time elapsed 50%. Work done: 7 of 30 pts.' })).toBeVisible();
    await expect(behind.getByText("You've closed 7 of your 30 pts.")).toBeVisible();
    // Three proposals on desktop, two on a phone.
    const reviews = behind.getByRole('button', { name: /^Review in AI Workspace: / });
    await expect(reviews).toHaveCount(isMobile ? 2 : 3);
    await expect(behind.locator('.home-prop')).toHaveCount(3);

    const why = behind.getByRole('button', { name: 'Why behind?' });
    await expect(why).toHaveAttribute('aria-expanded', 'false');
    await why.click();
    await expect(behind.getByRole('button', { name: 'Hide why' })).toHaveAttribute('aria-expanded', 'true');
    await expect(behind.getByText('You closed 7 of the 30 points assigned to you; half is 15.')).toBeVisible();

    const focus = page.getByRole('region', { name: 'Focus now' });
    const tabs = focus.getByRole('tab');
    await expect(tabs).toHaveText(['Focus now 5', 'Assigned 4', 'Requirements 2', 'All 6']);
    await expect(focus.getByRole('tab', { name: 'Focus now 5' })).toHaveAttribute('aria-selected', 'true');
    const rows = focus.locator('.home-list > li');
    await expect(rows).toHaveCount(5);
    const first = rows.first().getByRole('link');
    await expect(first).toContainText('Finish SSO discovery on the login screen');
    await expect(first).toContainText('Blocks 2 people');
    await expect(first).toContainText('Overdue 2d');
    await expect(first).toContainText('Was due Wed');
    await expect(first).toHaveAttribute('href', `/app/projects/${syntheticProject.id}?item=story-sso`);
    for (const count of await focus.locator('.home-why').evaluateAll((lines) => lines.map((line) => line.querySelectorAll('b').length))) {
      expect(count).toBeLessThanOrEqual(2);
    }
    // Rows are at least 48px; phones list four with a way to see the fifth.
    const minimumRow = await rootPx(page, 3.429);
    for (const box of await focus.locator('.home-row').evaluateAll((elements) => elements.filter((element) => element.offsetParent).map((element) => element.getBoundingClientRect().height))) {
      expect(box).toBeGreaterThanOrEqual(minimumRow - 0.5);
    }
    if (isMobile) {
      await expect(rows.nth(4)).toBeHidden();
      await focus.getByRole('button', { name: 'See all 5' }).click();
    }
    await expect(rows.nth(4)).toBeVisible();

    await focus.getByRole('tab', { name: 'Focus now 5' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(focus.getByRole('tab', { name: 'Assigned 4' })).toBeFocused();
    await expect(focus.getByRole('tab', { name: 'Assigned 4' })).toHaveAttribute('aria-selected', 'true');
    await focus.getByRole('tab', { name: 'Requirements 2' }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Answer: How should refunds appear in order history?');

    const help = focus.getByRole('button', { name: 'How ranking works' });
    await help.click();
    await expect(help).toHaveAttribute('aria-expanded', 'true');
    await expect(focus.getByText('Within each group: most people blocked, then soonest due, then priority, then least schedule float.')).toBeVisible();

    const rail = page.getByRole('complementary', { name: 'Summary' });
    await expect(rail.getByRole('heading')).toHaveText(['At a glance', 'Your sprint', 'Changes', 'Top contributors']);
    await expect(rail.getByText('Your items: 1 of 6 done')).toBeVisible();
    await expect(rail.getByRole('img', { name: '21 of 34 pts done; 24 pts would be done by today on the ideal line.' })).toBeVisible();
    await expect(rail.getByText('changes · 6 yesterday')).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Full leaderboard' })).toHaveAttribute('href', '/app/leaderboard');

    // The rail is 364px beside the list on desktop and stacks under it on phones.
    const railBox = await rail.boundingBox();
    const focusBox = await focus.boundingBox();
    if (isMobile) expect(railBox.y).toBeGreaterThan(focusBox.y + focusBox.height - 1);
    else {
      expect(Math.abs(railBox.width - (await rootPx(page, 26)))).toBeLessThanOrEqual(1);
      expect(railBox.x).toBeGreaterThan(focusBox.x + focusBox.width - 1);
    }
    if (isMobile) {
      // Touch targets are 44px under a coarse pointer.
      const target = await rootPx(page, 3.15);
      for (const locator of [focus.getByRole('tab').first(), reviews.first(), behind.getByRole('button', { name: 'Hide why' }), focus.getByRole('button', { name: 'How ranking works' })]) {
        expect((await locator.boundingBox()).height).toBeGreaterThanOrEqual(target - 0.5);
      }
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: true, path: testInfo.outputPath('member-behind.png') });
    await expectNoAxeViolations(page, testInfo, 'member-behind');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expectNoAxeViolations(page, testInfo, 'member-behind-dark');
    api.assertNoUnexpectedRequests();
  });

  test('reviewing a proposal stages it and opens it in the AI Workspace, where nothing applies until approved', async ({ page }) => {
    const { api, requests } = await openHome(page, () => memberBehindHome(), { assistantChat: stagedChat });
    const behind = page.getByRole('region', { name: "You're behind in Sprint 14" });
    await behind.getByRole('button', { name: 'Review in AI Workspace: Move 2 stories (13 pts) to Sprint 15' }).click();
    await expect(page).toHaveURL(/[?&]assistant=1&assistantSessionId=session-recovery/);
    expect(requests.stage).toEqual(['rp_aaaaaaaaaaaaaaaa']);

    const workspace = page.getByRole('dialog', { name: 'AI Workspace' });
    const card = workspace.getByRole('region', { name: 'Move 2 stories (13 pts) to Sprint 15' });
    await expect(card.getByText('Recovery proposal', { exact: true })).toBeVisible();
    await expect(card.getByText('Move 2 stories to Sprint 15', { exact: true })).toBeVisible();
    await expect(workspace.getByText('Nothing has changed yet. Apply it below', { exact: false })).toBeVisible();
    await expect(page.locator('.home-opened')).toContainText('“Move 2 stories (13 pts) to Sprint 15” is waiting for your approval. Nothing has changed yet.');
    await card.getByRole('button', { name: 'Apply' }).click();
    await expect(card.getByText('1 applied')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Apply' })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('a proposal that went out of date refreshes Home instead of opening', async ({ page }) => {
    const { api, requests } = await openHome(page, () => memberBehindHome(), {
      stage: (route) => json(route, { details: { code: 'home_proposal_stale' }, error: 'This proposal is out of date.' }, 404),
    });
    await page.getByRole('button', { name: 'Review in AI Workspace: Move 2 stories (13 pts) to Sprint 15' }).click();
    await expect(page.getByRole('alert')).toHaveText('That option was out of date, so Home has been refreshed.');
    await expect.poll(() => requests.gets.length).toBe(2);
    await expect(page).not.toHaveURL(/assistant=1/);
    api.assertNoUnexpectedRequests();
  });

  test('a manager switches between the team view and their own, and the choice is saved', async ({ page }, testInfo) => {
    const { api, requests } = await openHome(page, (lens) => managerHome(lens ?? 'team'));
    const views = page.getByRole('group', { name: 'Home view' });
    await expect(views.getByRole('button', { name: 'Team' })).toHaveAttribute('aria-pressed', 'true');
    await expect(views.getByRole('button', { name: 'My work' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.home-sub')).toContainText('Manager on 4 projects');

    const behind = page.getByRole('region', { name: 'Sprint 14 is behind' });
    await expect(behind.getByText('Behind: Sam Ortiz (7 of 30 pts).', { exact: false })).toBeVisible();
    const focus = page.getByRole('region', { name: 'Focus now' });
    await expect(focus.getByRole('tab')).toHaveText(['Focus now 4', 'Decide 2', 'Team 2', 'Assigned 0', 'All 4']);
    await expect(focus.getByRole('tabpanel').getByRole('listitem').nth(1)).toContainText('Overdue 3h');
    const rail = page.getByRole('complementary', { name: 'Summary' });
    await expect(rail.getByRole('heading', { name: 'Active sprints' })).toBeVisible();
    await expect(rail.locator('.home-sprint')).toHaveCount(3);
    await expect(rail.locator('.home-ideal')).toHaveCount(3);
    await expect(rail.getByText('Synthetic Demo (you)')).toBeVisible();
    await page.screenshot({ fullPage: true, path: testInfo.outputPath('manager.png') });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.screenshot({ fullPage: true, path: testInfo.outputPath('manager-dark.png') });
    await expectNoAxeViolations(page, testInfo, 'manager-dark');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));

    await views.getByRole('button', { name: 'My work' }).click();
    await expect(views.getByRole('button', { name: 'My work' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Sprint 14 is behind' })).toHaveCount(0);
    await expect(focus.getByText('On track.')).toBeVisible();
    expect(requests.gets).toEqual([null, 'my-work']);
    await expect.poll(() => requests.lens).toEqual(['my-work']);
    await expectNoHorizontalOverflow(page);
    api.assertNoUnexpectedRequests();
  });

  test('a tenant admin sees workspace work, with behind sprints in the status line', async ({ page }, testInfo) => {
    const { api } = await openHome(page, () => adminHome());
    const views = page.getByRole('group', { name: 'Home view' });
    await expect(views.getByRole('button')).toHaveText(['My work', 'Workspace']);
    await expect(views.getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-pressed', 'true');
    const focus = page.getByRole('region', { name: 'Focus now' });
    await expect(focus.getByText('1 sprint is behind across the workspace.')).toBeVisible();
    await expect(page.getByRole('region', { name: /is behind/ })).toHaveCount(0);
    const first = focus.getByRole('tabpanel').getByRole('listitem').first();
    await expect(first).toContainText('Approve impersonation request: Alex Kim → Target User');
    await expect(first).toContainText('Expires in 4h');
    await expect(first).toContainText('Needs a second admin');
    await expect(first.getByRole('link')).toHaveAttribute('href', '/app/admin/identity');
    await expect(focus.getByRole('tabpanel').getByRole('listitem').nth(1)).toContainText('Since Oct 7');
    const rail = page.getByRole('complementary', { name: 'Summary' });
    await expect(rail.getByRole('heading', { name: 'Workspace at a glance' })).toBeVisible();
    await expect(rail.getByRole('link', { name: /Without 2FA\s*7\s*of 41 members/ })).toBeVisible();
    await expect(rail.getByRole('heading', { name: 'Sprints at risk' })).toBeVisible();
    await page.screenshot({ fullPage: true, path: testInfo.outputPath('admin.png') });
    await expectNoAxeViolations(page, testInfo, 'admin');
    api.assertNoUnexpectedRequests();
  });

  test('on track, new, partly failed and unprotected accounts each get their own state', async ({ page }) => {
    const failing = {
      ...memberBehindHome(),
      sources: [...memberBehindHome().sources.filter((source) => source.key !== 'requirements'), { failedProjectIds: ['p1', 'p2'], key: 'requirements', status: 'error' }],
      viewer: { ...memberBehindHome().viewer, projectCount: 5, twoFactorEnabled: false },
    };
    const payloads = [onTrackHome(), failing, memberBehindHome(), syntheticHomePayload({ viewer: { ...syntheticHomePayload().viewer, projectCount: 0 } })];
    const { api, requests } = await openHome(page, (_lens, call) => payloads[Math.min(call, payloads.length) - 1]);

    const focus = page.getByRole('region', { name: 'Focus now' });
    await expect(focus.getByText('On track.')).toBeVisible();
    await expect(focus.getByText('Sprint 14 is 62% done with 60% of the time gone.')).toBeVisible();
    await expect(page.getByRole('region', { name: /behind/ })).toHaveCount(0);
    await expect(page.getByText('Two-factor sign-in is off for your account.')).toHaveCount(0);

    // A second load: one source failed for two of five projects, and 2FA is off.
    await page.reload();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Requirements items could not load for 2 of 5 projects, so the ranking may be missing items.');
    await expect(page.getByRole('link', { name: 'Set up two-factor sign-in' })).toHaveAttribute('href', '/app/user?tab=security');
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(requests.gets.length).toBe(3);

    await page.reload();
    await expect(focus.getByRole('heading', { name: 'Nothing to focus on yet' })).toBeVisible();
    await expect(focus.getByRole('link', { name: 'Browse projects' })).toHaveAttribute('href', '/app/projects');
    api.assertNoUnexpectedRequests();
  });

  test('a failed load says so and retries', async ({ page }) => {
    const { api } = await openHome(page, (_lens, call) => (call === 1 ? { body: { error: 'Database unavailable.' }, httpStatus: 500 } : onTrackHome()), {});
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Home could not load.');
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('region', { name: 'Focus now' }).getByText('On track.')).toBeVisible();
    api.assertNoUnexpectedRequests();
  });
});
