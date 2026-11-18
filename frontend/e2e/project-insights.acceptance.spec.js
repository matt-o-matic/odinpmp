import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { DEFAULT_CARDS, installInsightsApi, insightsPayload, stateCards } from './fixtures/insights-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa'];
const PROJECT = syntheticProject.id;
const DEFAULT_TITLES = [
  'Headline numbers', 'Burnup and forecast', 'Sprint 14 burndown', 'Velocity', 'Cumulative flow', 'Ticket flow',
  'Open tickets by severity', 'Milestones against baseline', 'Earned value', 'Throughput by person', 'Saved reports for this project',
];

async function openInsights(page, { admin = true, insights = {} } = {}) {
  const api = await installSyntheticApi(page, { admin });
  const insightsApi = await installInsightsApi(page, insights);
  await authenticateSyntheticUser(page);
  await page.goto(`projects/${PROJECT}/insights`);
  await expect(page.getByRole('heading', { level: 2, name: 'Insights' })).toBeVisible();
  await expect(page.locator('.insights-card__placeholder')).toHaveCount(0);
  return { api, insightsApi };
}

async function expectNoAxeViolations(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.insights').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.violations).toEqual([]);
}

async function expectLightAndDark(page, testInfo, name) {
  await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${name}-light.png`) });
  await expectNoAxeViolations(page, testInfo, `${name}-light`);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${name}-dark.png`) });
  await expectNoAxeViolations(page, testInfo, `${name}-dark`);
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
}

async function expectNoHorizontalOverflow(page) {
  const viewport = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
}

function cardTitles(page) {
  return page.locator('.insights-card__title').allTextContents();
}

test.describe('project Insights', () => {
  test('the default layout shows design A cards with a rule-based At risk headline and evidence links', async ({ page }, testInfo) => {
    const { api, insightsApi } = await openInsights(page);

    await expect(page.getByRole('link', { name: 'Insights', exact: true })).toHaveAttribute('aria-current', 'page');
    expect((await cardTitles(page)).map((title) => title.trim())).toEqual(DEFAULT_TITLES);
    expect(insightsApi.calls.insights[0]).toEqual({ days: '90', unit: 'points' });

    const banner = page.locator('.insights-health');
    await expect(banner.locator('.insights-health__headline')).toHaveText('At risk: Payments integration due Oct 20 forecasts 3 working days late (and 1 other signal)');
    await expect(banner.getByRole('link', { name: 'Payments integration due Oct 20 forecasts 3 working days late' })).toHaveAttribute('href', `/app/projects/${PROJECT}/governance`);
    await expect(banner.getByRole('link', { name: '6 working days of 10 gone (60%); 15 points of 33 done (45%)' })).toHaveAttribute('href', `/app/projects/${PROJECT}/sprints`);
    await expect(banner.getByRole('link', { name: 'Validate rollout is overdue (due Aug 28)' })).toHaveAttribute('href', `/app/projects/${PROJECT}?item=task-synthetic`);
    await expect(banner).not.toContainText('not written by AI');

    const tiles = page.locator('.insights-tile');
    await expect(tiles.filter({ hasText: 'Forecast finish' })).toContainText('Dec 7');
    await expect(tiles.filter({ hasText: 'Forecast finish' })).toContainText('At risk · target Dec 4');
    await expect(tiles.filter({ hasText: 'Cost performance' })).toContainText('0.94 CPI');
    await expect(page.getByRole('img', { name: /^Burnup: 186 pts done of 300 pts scope; likely Dec 7, target Dec 4\.$/ })).toBeVisible();
    await expect(page.locator('#insights-card-throughput')).toContainText('Ada Lovelace');
    await expect(page.getByRole('button', { name: /^Run$/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'How Velocity is calculated' }).click();
    await expect(page.getByText('Committed counts a sprint\'s items on its first day')).toBeVisible();
    await page.getByRole('button', { name: 'Show Burnup and forecast as a table' }).click();
    await expect(page.getByRole('region', { name: 'Burnup data' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Burnup data' })).toContainText('Oct 9, 2026');
    await page.getByRole('button', { name: 'Show Burnup and forecast as a table' }).click();

    const burnupChart = page.getByRole('img', { name: /^Burnup:/ });
    await burnupChart.focus();
    await page.keyboard.press('End');
    const tooltip = page.locator('#insights-card-burnup .insights-chart__tooltip');
    await expect(tooltip).toContainText('Dec 14, 2026');
    await expect(tooltip).toContainText('Scope 300 pts');
    await page.keyboard.press('ArrowLeft');
    await expect(tooltip).toContainText('Forecast 300 pts');
    await page.keyboard.press('ArrowLeft');
    await expect(tooltip).toContainText('Done 186 pts');
    await page.keyboard.press('Tab');

    // Every filter reloads the whole page of cards from one request.
    await page.locator('label[for="insights-unit-items"]').click();
    await expect.poll(() => insightsApi.calls.insights.at(-1)?.unit).toBe('items');
    await expect(page.locator('.insights-card__refreshing')).toHaveCount(0);

    await expectNoHorizontalOverflow(page);
    await expectLightAndDark(page, testInfo, 'insights-default');
    api.assertNoUnexpectedRequests();
  });

  test('a saved report added as a card runs on its own and refreshes without a Run button', async ({ page }, testInfo) => {
    const layout = { cards: [{ type: 'headline' }, { reportId: 'report-defects', type: 'report' }, { type: 'saved-reports' }], isDefault: false, updatedAt: null, updatedBy: null, version: 3 };
    const { api, insightsApi } = await openInsights(page, {
      insights: {
        payload: () => insightsPayload({ layout }),
        reportCards: { 'report-defects': [{ cache: 'stale', refreshing: true }, { cache: 'hit', refreshing: false }] },
      },
    });

    const card = page.locator('#insights-card-report-report-defects');
    await expect(card.getByRole('heading', { name: 'Open defects by severity' })).toBeVisible();
    await expect(card.getByRole('row', { name: /S3/ })).toContainText('9');
    await expect(card.getByText('Refreshing…')).toBeVisible();
    await expect(card.getByRole('button', { name: /^Run$/ })).toHaveCount(0);
    await expect(card.getByText('Refreshing…')).toHaveCount(0, { timeout: 12_000 });
    expect(insightsApi.calls.reportCards.filter((id) => id === 'report-defects').length).toBeGreaterThanOrEqual(2);

    const list = page.locator('#insights-card-saved-reports');
    await expect(list.getByRole('row', { name: /Weekly status/ })).toContainText('Tenant');
    await expect(list.getByRole('row', { name: /Weekly status/ })).toContainText('Not run yet');
    await expect(list.getByRole('row', { name: /Open defects by severity/ })).toContainText('In app · daily');

    await expectNoHorizontalOverflow(page);
    await expectLightAndDark(page, testInfo, 'insights-report-card');
    api.assertNoUnexpectedRequests();
  });

  test('project admins and managers add, remove and reorder cards in an explicit edit mode', async ({ page }, testInfo) => {
    const { api, insightsApi } = await openInsights(page, { insights: { reportCards: { 'report-defects': [{}] } } });
    await expect(page.getByRole('heading', { name: 'Customizing this dashboard' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Move Velocity earlier' })).toHaveCount(0);

    // Cancel discards the draft.
    await page.getByRole('button', { name: 'Customize' }).click();
    await page.getByRole('button', { name: 'Remove Ticket flow' }).click();
    await expect(page.locator('#insights-card-ticket-flow')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#insights-card-ticket-flow')).toBeVisible();

    await page.getByRole('button', { name: 'Customize' }).click();
    await expect(page.getByRole('heading', { name: 'Customizing this dashboard' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Move Headline numbers earlier' })).toBeDisabled();
    await page.getByRole('button', { name: 'Move Velocity earlier' }).click();
    await page.getByRole('button', { name: 'Remove Cumulative flow' }).click();

    await page.getByRole('button', { name: 'Add card' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a card' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /Cumulative flow/ })).toBeVisible();
    await dialog.getByRole('radio', { name: /Open defects by severity/ }).check();
    await expectNoAxeViolations(page, testInfo, 'insights-add-card');
    await dialog.getByRole('button', { name: 'Add card' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#insights-card-report-report-defects').getByRole('heading', { name: 'Open defects by severity' })).toBeVisible();

    await page.screenshot({ fullPage: true, path: testInfo.outputPath('insights-editing.png') });
    await expectNoAxeViolations(page, testInfo, 'insights-editing');
    await page.getByRole('button', { name: 'Save layout' }).click();
    await expect(page.getByRole('heading', { name: 'Customizing this dashboard' })).toHaveCount(0);

    const expected = [
      { type: 'headline' }, { type: 'burnup' }, { type: 'velocity' }, { type: 'sprint-burndown' }, { type: 'ticket-flow' },
      { type: 'tickets-by-severity' }, { type: 'milestones' }, { type: 'earned-value' }, { type: 'throughput' }, { type: 'saved-reports' },
      { reportId: 'report-defects', type: 'report' },
    ];
    expect(insightsApi.calls.layoutWrites).toEqual([{ body: { cards: expected, expectedVersion: 0 }, method: 'PUT' }]);
    expect((await cardTitles(page)).map((title) => title.trim())).toEqual([
      'Headline numbers', 'Burnup and forecast', 'Velocity', 'Sprint 14 burndown', 'Ticket flow', 'Open tickets by severity',
      'Milestones against baseline', 'Earned value', 'Throughput by person', 'Saved reports for this project', 'Open defects by severity',
    ]);

    // The saved layout is what everyone sees on the next load; resetting returns to design A.
    await page.reload();
    await expect(page.locator('#insights-card-cumulative-flow')).toHaveCount(0);
    await page.getByRole('button', { name: 'Customize' }).click();
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await page.getByRole('button', { name: 'Save layout' }).click();
    await expect(page.locator('#insights-card-cumulative-flow')).toBeVisible();
    expect(insightsApi.calls.layoutWrites.at(-1)).toEqual({ body: { expectedVersion: 1 }, method: 'DELETE' });
    expect(DEFAULT_CARDS).toHaveLength(11);
    api.assertNoUnexpectedRequests();
  });

  test('each card handles thin history, empty, error, refreshing and permission states on its own', async ({ page }, testInfo) => {
    const layout = { cards: [...DEFAULT_CARDS, { reportId: 'report-gone', type: 'report' }], isDefault: false, updatedAt: null, updatedBy: null, version: 2 };
    const { api, insightsApi } = await openInsights(page, {
      admin: false,
      insights: {
        payload: () => insightsPayload({ cards: stateCards(), editor: false, finance: false, layout }),
        reportCards: { 'report-gone': [404] },
      },
    });

    // A member sees no cost and cannot change the layout.
    await expect(page.getByRole('button', { name: 'Customize' })).toHaveCount(0);
    await expect(page.getByText('Cost and earned value are visible to managers and admins.')).toBeVisible();
    await expect(page.locator('#insights-card-earned-value')).toHaveCount(0);
    await expect(page.locator('.insights-tile').filter({ hasText: 'Cost performance' })).toHaveCount(0);

    await expect(page.locator('#insights-card-burnup')).toContainText('The forecast appears after 2 weeks of history. Check back on Oct 15.');
    await expect(page.locator('#insights-card-velocity')).toContainText('The average and a suggested commitment need 3 completed sprints.');
    const burndown = page.locator('#insights-card-sprint-burndown');
    await expect(burndown).toContainText('No active sprint. The burndown appears once a sprint is started.');
    await expect(burndown.getByRole('link', { name: 'Plan a sprint' })).toHaveAttribute('href', `/app/projects/${PROJECT}/sprints`);
    await expect(page.locator('#insights-card-throughput')).toContainText('No completed work in the last 90 days.');
    await expect(page.locator('#insights-card-report-report-gone')).toContainText('This report was deleted or is not shared with you.');
    const ticketFlow = page.locator('#insights-card-ticket-flow');
    await expect(ticketFlow.getByRole('alert')).toContainText('This card could not be loaded. Other cards are unaffected.');
    await expect(page.locator('#insights-card-cumulative-flow .insights-chart')).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await expectLightAndDark(page, testInfo, 'insights-states');

    // Retry reloads while the other cards keep their charts, dimmed, until new data arrives.
    insightsApi.delayNextLoad(1500);
    const loads = insightsApi.calls.insights.length;
    await ticketFlow.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('#insights-card-cumulative-flow').getByText('Refreshing…')).toBeVisible();
    await expect(page.locator('#insights-card-cumulative-flow .insights-chart')).toBeVisible();
    await expect(page.getByText('Refreshing…')).toHaveCount(0, { timeout: 8_000 });
    expect(insightsApi.calls.insights.length).toBe(loads + 1);
    api.assertNoUnexpectedRequests();
  });

  test('Reports deep links keep the project and tab in the URL and lead back to Insights', async ({ page }) => {
    const { api } = await openInsights(page);

    await page.getByRole('link', { name: 'Open in Reports' }).click();
    await expect(page).toHaveURL(new RegExp(`/app/reports\\?projectId=${PROJECT}&tab=reports$`));
    await expect(page.getByRole('button', { exact: true, name: 'reports' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('note')).toContainText(`Showing ${syntheticProject.name}. New reports default to this project.`);
    await expect(page.locator('.reporting-filters select').first()).toHaveValue(PROJECT);

    await page.getByRole('button', { exact: true, name: 'runs' }).click();
    await expect(page).toHaveURL(new RegExp(`/app/reports\\?projectId=${PROJECT}&tab=runs$`));
    await page.getByRole('link', { name: 'Back to project Insights' }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${PROJECT}/insights$`));

    await page.goto(`reports?projectId=${PROJECT}&tab=subscriptions`);
    await expect(page.getByRole('button', { exact: true, name: 'subscriptions' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Scheduled delivery' })).toBeVisible();

    // The old project Reports and Analytics addresses land on Insights.
    await page.goto(`projects/${PROJECT}/analytics`);
    await expect(page).toHaveURL(new RegExp(`/app/projects/${PROJECT}/insights$`));

    // The right pane's Project Views card links to Insights; Analytics is gone.
    await page.goto(`projects/${PROJECT}`);
    const rightPane = page.locator('#rightPane');
    await expect(rightPane.getByRole('link', { name: 'Analytics' })).toHaveCount(0);
    await expect(rightPane.getByText('Project Stats')).toBeAttached();
    const views = rightPane.getByRole('link', { name: 'Insights and reports' });
    await expect(views).toHaveAttribute('href', `/app/projects/${PROJECT}/insights`);
    if (await views.isVisible()) {
      await views.click();
      await expect(page).toHaveURL(new RegExp(`/app/projects/${PROJECT}/insights$`));
    }
    api.assertNoUnexpectedRequests();
  });
});
