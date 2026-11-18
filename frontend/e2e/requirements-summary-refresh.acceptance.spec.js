import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { defaultRequirementsScenario, installRequirementsApi } from './fixtures/requirements-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';
import { settleForAxe } from './fixtures/axe-settle.js';

// Odin summary freshness and Refresh on the topic page and the register's quick view.
// Synthetic API only.
const base = `projects/${syntheticProject.id}/requirements`;

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

async function openTopic(page, topicId, adjust = () => {}) {
  const scenario = defaultRequirementsScenario();
  adjust(scenario);
  const api = await installSyntheticApi(page);
  const requirements = await installRequirementsApi(page, scenario);
  await authenticateSyntheticUser(page);
  await page.goto(`${base}/topics/${topicId}`);
  await expect(page.locator('#rq-topic-title')).not.toHaveText('Loading topic…');
  return { api, requirements, summary: page.getByRole('region', { name: 'Odin summary' }) };
}

test.describe('Requirements Odin summary: freshness and refresh', () => {
  test('shows when the summary was last updated, and Refresh updates it', async ({ page }) => {
    const { api, requirements, summary } = await openTopic(page, 'topic-price');
    await expect(summary.getByText('Last updated 6 min ago')).toBeVisible();
    await expect(summary.getByText(/refresh failed/)).toHaveCount(0);

    await summary.getByRole('button', { name: 'Refresh the Odin summary' }).click();
    await expect(summary.getByRole('status')).toHaveText('Odin summary updated.');
    await expect(summary.getByText('Last updated just now')).toBeVisible();
    expect(requirements.calls.filter((call) => call.path === '/topics/topic-price/summary/refresh' && call.method === 'POST')).toHaveLength(1);
    api.assertNoUnexpectedRequests();
  });

  test('a failed refresh keeps the previous summary and says the refresh failed', async ({ page }, testInfo) => {
    const { api, summary } = await openTopic(page, 'topic-price', (scenario) => { scenario.summaryRefreshMode = 'failed'; });
    await summary.getByRole('button', { name: 'Refresh the Odin summary' }).click();
    await expect(summary.getByRole('alert')).toContainText('Odin couldn’t refresh the summary. The previous summary is still shown');
    await expect(summary.getByText('Last updated 6 min ago')).toBeVisible();
    await expect(summary.getByText('refresh failed just now')).toBeVisible();
    await expect(summary.getByText('Clients should never be surprised by the final price.')).toBeVisible();

    await settleForAxe(page);
    const results = await new AxeBuilder({ page }).include('#rq-summary').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    await testInfo.attach('axe-summary-failed.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
    expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact)).map((violation) => violation.id)).toEqual([]);
    api.assertNoUnexpectedRequests();
  });

  test('a stored failed attempt shows on the topic', async ({ page }) => {
    const { api, summary } = await openTopic(page, 'topic-price', (scenario) => {
      const topic = scenario.topics.find((entry) => entry.id === 'topic-price');
      topic.summaryStatus = { lastAttemptAt: minutesAgo(3), lastAttemptStatus: 'failed', refreshPending: false };
    });
    await expect(summary.getByText('Last updated 6 min ago')).toBeVisible();
    await expect(summary.getByText('refresh failed 3 min ago')).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('with nothing to summarize, Refresh says there is not enough input yet', async ({ page }) => {
    const { api, summary } = await openTopic(page, 'topic-notes', (scenario) => { scenario.summaryRefreshMode = 'no-input'; });
    await expect(summary.getByText('No summary yet.', { exact: false })).toBeVisible();
    await summary.getByRole('button', { name: 'Refresh the Odin summary' }).click();
    await expect(summary.getByRole('status')).toContainText('Not enough input yet.');
    api.assertNoUnexpectedRequests();
  });

  test('without an AI provider, Refresh explains that summaries are not set up', async ({ page }) => {
    const { api, summary } = await openTopic(page, 'topic-price', (scenario) => { scenario.summaryRefreshMode = 'ai_not_configured'; });
    await summary.getByRole('button', { name: 'Refresh the Odin summary' }).click();
    await expect(summary.getByRole('alert')).toContainText('no AI provider is set up for this workspace');
    await expect(summary.getByRole('button', { name: 'Refresh the Odin summary' })).toBeEnabled();
    api.assertNoUnexpectedRequests();
  });

  test('viewers see freshness but no Refresh', async ({ page }) => {
    const { api, summary } = await openTopic(page, 'topic-price', (scenario) => { scenario.projectRole = 'viewer'; scenario.canDecide = false; });
    await expect(summary.getByText('Last updated 6 min ago')).toBeVisible();
    await expect(summary.getByRole('button', { name: /Refresh/ })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
  });

  test('people in the summary use the names the API sends', async ({ page }) => {
    const { api, summary } = await openTopic(page, 'topic-price', (scenario) => {
      const topic = scenario.topics.find((entry) => entry.id === 'topic-price');
      topic.fullSummary.output.aligned[0].supporterNames = ['Jamie O.', 'Ravi S.', 'Alex K.'];
      topic.fullSummary.output.divergent[0].positions[1].actorNames = ['Ravi from Finance'];
    });
    await expect(summary.getByRole('img', { name: 'Jamie O.' })).toBeVisible();
    await expect(summary.getByRole('img', { name: 'Ravi from Finance' })).toBeVisible();
    api.assertNoUnexpectedRequests();
  });

  test('a summary update from elsewhere shows without reloading', async ({ page }) => {
    const { api, requirements, summary } = await openTopic(page, 'topic-price', (scenario) => { scenario.liveEvents = true; });
    await expect(summary.getByText('Clients should never be surprised by the final price.')).toBeVisible();
    const topic = requirements.state.topics.find((entry) => entry.id === 'topic-price');
    topic.fullSummary = {
      ...topic.fullSummary,
      createdAt: new Date().toISOString(),
      id: 'summary-price-live',
      output: { ...topic.fullSummary.output, aligned: [{ ...topic.fullSummary.output.aligned[0], statement: 'Everyone wants the price before payment.' }] },
    };
    requirements.pushEvent({ data: { scopeId: 'topic-price', scopeType: 'topic', status: 'ok', summaryId: 'summary-price-live', track: 'experience' }, type: 'requirements.summary.updated' });
    await expect(summary.getByText('Everyone wants the price before payment.')).toBeVisible();
    await expect(summary.getByText('Last updated just now')).toBeVisible();
    api.assertNoUnexpectedRequests();
  });
});
