import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa'];

// Synthetic tickets: one a Bug Reporter reporter reopened twice, then two never reopened. The
// second shares the first one's board column, so it is the next card the reopen note must not cover.
const tickets = [{
  assigneeName: '', category: 'defect', externalReviewState: 'pending', id: '22222222-2222-4222-8222-222222222222',
  lastReopenedAt: '2026-10-08T15:30:00.000Z', name: 'Checkout total is wrong', priority: 2, projectId: syntheticProject.id,
  projectName: syntheticProject.name, reopenCount: 2, reporterExternalId: 'bug-reporter:stakeholder-1', severity: 'S2',
  status: 'new', updatedAt: '2026-10-08T15:30:00.000Z', version: 7,
}, {
  assigneeName: '', category: 'defect', externalReviewState: 'not_external', id: 'ticket-search',
  lastReopenedAt: null, name: 'Search ignores accents', priority: 3, projectId: syntheticProject.id,
  projectName: syntheticProject.name, reopenCount: 0, reporterExternalId: null, severity: 'S1',
  status: 'new', updatedAt: '2026-10-08T09:00:00.000Z', version: 1,
}, {
  assigneeName: 'Synthetic Demo', category: 'support', externalReviewState: 'not_external', id: 'ticket-fresh',
  lastReopenedAt: null, name: 'Logo is misaligned on the invoice page', priority: 4, projectId: syntheticProject.id,
  projectName: syntheticProject.name, reopenCount: 0, reporterExternalId: null, severity: 'S3',
  status: 'triage', updatedAt: '2026-10-07T10:00:00.000Z', version: 2,
}];

function json(route, body) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status: 200 });
}

async function installTicketApi(page) {
  const ticketQueries = [];
  const api = await installSyntheticApi(page);
  const path = (pathname) => (url) => url.pathname === pathname;
  await page.route(path('/api/projects/tickets'), (route) => {
    const url = new URL(route.request().url());
    ticketQueries.push(url.search);
    const reopenedOnly = url.searchParams.get('reopened') === 'true';
    const matched = tickets.filter((ticket) => !reopenedOnly || ticket.reopenCount > 0);
    return json(route, { nextCursor: null, tickets: matched, total: matched.length });
  });
  await page.route(path('/api/projects/ticket-review-queue'), (route) => json(route, { tickets: tickets.filter((ticket) => ticket.externalReviewState === 'pending') }));
  await page.route((url) => /^\/api\/projects\/[^/]+\/items\/[^/]+\/relations$/.test(url.pathname), (route) => json(route, { relations: [] }));
  await page.route(path(`/api/projects/${syntheticProject.id}/tickets`), (route) => json(route, { nextCursor: null, tickets, total: tickets.length }));
  await page.route(path(`/api/projects/${syntheticProject.id}/ticket-intake-invitations`), (route) => json(route, { invitations: [] }));
  await page.route(path(`/api/projects/${syntheticProject.id}/ticket-config`), (route) => json(route, { environments: [], ok: true, releases: [] }));
  return { api, ticketQueries };
}

// The badge's tap area meets the app's 2.75rem touch-target convention.
async function expectTouchTarget(locator) {
  const size = await locator.evaluate((element) => {
    const area = getComputedStyle(element, '::before');
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { height: Number.parseFloat(area.height) / rem, width: Number.parseFloat(area.width) / rem };
  });
  expect(size.height).toBeGreaterThanOrEqual(2.75);
  expect(size.width).toBeGreaterThanOrEqual(2.75);
}

async function expectNoAxeViolations(page, testInfo, name, selectors) {
  await settleForAxe(page);
  let builder = new AxeBuilder({ page }).withTags(wcagTags);
  for (const selector of selectors) builder = builder.include(selector);
  const results = await builder.analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.violations).toEqual([]);
}

// The note opens inside the badge's own card or row and pushes the next ticket down, so it never
// covers a neighbour and is never clipped by the card, the row, or a scrolling board.
async function expectNoteInFlow(note, container, next) {
  const [noteBox, containerBox, nextBox] = await Promise.all([note.boundingBox(), container.boundingBox(), next.boundingBox()]);
  expect(noteBox.x).toBeGreaterThanOrEqual(containerBox.x - 0.5);
  expect(noteBox.y).toBeGreaterThanOrEqual(containerBox.y - 0.5);
  expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(containerBox.x + containerBox.width + 0.5);
  expect(noteBox.y + noteBox.height).toBeLessThanOrEqual(containerBox.y + containerBox.height + 0.5);
  expect(nextBox.y).toBeGreaterThanOrEqual(noteBox.y + noteBox.height);
  const clipped = await note.evaluate((element) => {
    const box = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const frame = parent.getBoundingClientRect();
      if (box.left < frame.left - 0.5 || box.right > frame.right + 0.5 || box.top < frame.top - 0.5 || box.bottom > frame.bottom + 0.5) return true;
    }
    return false;
  });
  expect(clipped).toBe(false);
}

async function noteFor(page, badge) {
  const id = await badge.getAttribute('aria-controls');
  return page.locator(`[id="${id}"]`);
}

async function press(badge, testInfo) {
  if (testInfo.project.name === 'chromium-mobile') await badge.tap();
  else await badge.click();
}

test.describe('Bug Reporter reopen count', () => {
  test('the tenant board, list, and detail show how often a ticket was reopened', async ({ page }, testInfo) => {
    const { api, ticketQueries } = await installTicketApi(page);
    await authenticateSyntheticUser(page);
    await page.goto('tickets');
    await expect(page.getByRole('heading', { name: 'Tickets', exact: true })).toBeVisible();

    const board = page.getByRole('region', { name: 'Ticket board' });
    const badge = board.getByRole('button', { name: 'Reopened 2 times' });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('2');
    await expect(badge).toHaveAttribute('aria-expanded', 'false');
    await expect(board.getByRole('button', { name: /^Reopened/ })).toHaveCount(1);
    await expectTouchTarget(badge);
    const note = await noteFor(page, badge);
    await expect(note).toBeHidden();

    // Pressing or tapping the badge explains it in place, without opening the ticket.
    await press(badge, testInfo);
    await expect(badge).toHaveAttribute('aria-expanded', 'true');
    await expect(note).toBeVisible();
    await expect(note).toContainText('Reopened 2 times');
    await expect(note).toContainText('Each reopen returned it to New.');
    await expect(note).toContainText('Last reopened');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    const card = board.locator('.ticket-card-item').filter({ hasText: 'Checkout total is wrong' });
    const nextCard = board.locator('.ticket-card-item').filter({ hasText: 'Search ignores accents' });
    await expectNoteInFlow(note, card, nextCard);
    await page.screenshot({ path: testInfo.outputPath('board-note.png') });
    await expectNoAxeViolations(page, testInfo, 'board-badge', ['.ticket-board']);

    // Escape closes it from the keyboard, and Enter or Space toggles it.
    await badge.focus();
    await page.keyboard.press('Escape');
    await expect(note).toBeHidden();
    await expect(badge).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await expect(note).toBeVisible();
    await page.keyboard.press('Space');
    await expect(note).toBeHidden();

    await page.locator('.ticket-card').filter({ hasText: 'Checkout total is wrong' }).click();
    const dialog = page.locator('dialog.ticket-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('dt', { hasText: 'Reopened by reporter' })).toBeVisible();
    await expect(dialog.locator('dd', { hasText: /Reopened 2 times, last/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('detail.png') });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    await page.getByRole('navigation', { name: 'Ticket views' }).getByRole('button', { name: 'List' }).click();
    const list = page.getByRole('region', { name: 'Ticket list' });
    const reopenedRow = list.getByRole('row', { name: /Checkout total is wrong/ });
    await expect(reopenedRow.getByRole('button', { name: 'Reopened 2 times' })).toBeVisible();
    await expect(list.getByRole('row', { name: /Logo is misaligned/ }).getByRole('button', { name: /^Reopened/ })).toHaveCount(0);

    // Dark mode keeps the badge and its note readable, and the note stays inside its row.
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    const listBadge = reopenedRow.getByRole('button', { name: 'Reopened 2 times' });
    await press(listBadge, testInfo);
    const listNote = await noteFor(page, listBadge);
    await expect(listNote).toBeVisible();
    await expectNoteInFlow(listNote, reopenedRow, list.getByRole('row', { name: /Search ignores accents/ }));
    await page.screenshot({ path: testInfo.outputPath('list-dark.png') });
    await expectNoAxeViolations(page, testInfo, 'list-badge-dark', ['.ticket-name']);
    await listBadge.focus();
    await page.keyboard.press('Escape');
    await expect(listNote).toBeHidden();

    await page.locator('#ticket-reopened').selectOption({ label: 'Reopened by reporter' });
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(list.getByRole('row', { name: /Logo is misaligned/ })).toHaveCount(0);
    expect(ticketQueries.at(-1)).toContain('reopened=true');

    const viewport = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
    api.assertNoUnexpectedRequests();
  });

  test('the project Tickets tab shows the badge on cards and list rows', async ({ page }, testInfo) => {
    const { api } = await installTicketApi(page);
    await authenticateSyntheticUser(page);
    await page.goto(`projects/${syntheticProject.id}/tickets`);
    const panel = page.locator('.project-tickets');
    await expect(panel.getByRole('heading', { name: 'Tickets', exact: true })).toBeVisible();

    const card = panel.locator('.project-tickets__card').filter({ hasText: 'Checkout total is wrong' });
    const badge = card.getByRole('button', { name: 'Reopened 2 times' });
    await expect(badge).toBeVisible();
    await expect(panel.locator('.project-tickets__card').filter({ hasText: 'Logo is misaligned' }).getByRole('button', { name: /^Reopened/ })).toHaveCount(0);
    await expectTouchTarget(badge);
    await press(badge, testInfo);
    const note = await noteFor(page, badge);
    await expect(note).toContainText('Reopened 2 times');
    await expectNoteInFlow(note, card, panel.locator('.project-tickets__card').filter({ hasText: 'Search ignores accents' }));
    await page.screenshot({ path: testInfo.outputPath('project-board.png') });
    await expectNoAxeViolations(page, testInfo, 'project-card-badge', ['.project-tickets__board']);
    await press(badge, testInfo);
    await expect(note).toBeHidden();

    await panel.getByRole('navigation', { name: 'Project ticket views' }).getByRole('button', { name: 'List' }).click();
    const row = panel.getByRole('row', { name: /Checkout total is wrong/ });
    const listBadge = row.getByRole('button', { name: 'Reopened 2 times' });
    await expect(listBadge).toBeVisible();
    await press(listBadge, testInfo);
    await expectNoteInFlow(await noteFor(page, listBadge), row, panel.getByRole('row', { name: /Search ignores accents/ }));
    api.assertNoUnexpectedRequests();
  });
});

test.describe('Ticket list contrast', () => {
  for (const theme of ['light', 'dark']) {
    test(`the tenant and project ticket lists pass axe in ${theme} mode`, async ({ page }, testInfo) => {
      const { api } = await installTicketApi(page);
      await authenticateSyntheticUser(page);
      const applyTheme = () => page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');

      await page.goto('tickets');
      await expect(page.getByRole('heading', { name: 'Tickets', exact: true })).toBeVisible();
      await applyTheme();
      await expectNoAxeViolations(page, testInfo, `tickets-board-${theme}`, ['.ticket-page']);
      await page.getByRole('navigation', { name: 'Ticket views' }).getByRole('button', { name: 'List' }).click();
      await expect(page.getByRole('region', { name: 'Ticket list' }).getByRole('button', { name: 'Checkout total is wrong' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`tickets-list-${theme}.png`) });
      await expectNoAxeViolations(page, testInfo, `tickets-list-${theme}`, ['.ticket-page']);

      await page.goto(`projects/${syntheticProject.id}/tickets`);
      const panel = page.locator('.project-tickets');
      await expect(panel.getByRole('heading', { name: 'Tickets', exact: true })).toBeVisible();
      await applyTheme();
      await expectNoAxeViolations(page, testInfo, `project-tickets-board-${theme}`, ['.project-tickets']);
      await panel.getByRole('navigation', { name: 'Project ticket views' }).getByRole('button', { name: 'List' }).click();
      await expect(panel.getByRole('row', { name: /Checkout total is wrong/ })).toBeVisible();
      await expectNoAxeViolations(page, testInfo, `project-tickets-list-${theme}`, ['.project-tickets']);
      api.assertNoUnexpectedRequests();
    });
  }
});
