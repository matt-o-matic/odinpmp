import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// Workspace search over channels, posts and channel files: the
// results group under their own headings, show the project (an engagement's name comes with the
// row, since engagements are not in the project list) and open the channel, the post or the file.

const API = 'http://localhost:3001';
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa'];
const ENGAGEMENT = { id: 'engagement-contoso', name: 'Contoso pilot' };
const at = '2026-11-14T12:00:00.000Z';

const records = [
  { content: 'Pricing draft for the pilot is in the library · Contoso pilot', documentType: 'post', facets: { author: 'Sal Seller', channel: '#General', project: ENGAGEMENT.name }, id: 'doc-post-1', projectId: ENGAGEMENT.id, sourceId: 'post-1', title: 'Sal Seller in #General', url: `/engagements/${ENGAGEMENT.id}/channels?channel=channel-e1&post=post-1` },
  { content: 'Pricing and contract talk · Synthetic Project', documentType: 'channel', facets: { project: syntheticProject.name }, id: 'doc-channel-1', projectId: syntheticProject.id, sourceId: 'channel-p1', title: '#Pricing', url: `/projects/${syntheticProject.id}/channels?channel=channel-p1` },
  { content: '#Pricing · Proposals · Synthetic Project', documentType: 'file', facets: { channel: '#Pricing', project: syntheticProject.name }, id: 'doc-file-1', projectId: syntheticProject.id, sourceId: 'file-1', title: 'pricing-model.xlsx', url: `/projects/${syntheticProject.id}/channels?channel=channel-p1&tab=files&file=file-1` },
].map((record) => ({ ...record, indexedAt: at, updatedAt: at }));

async function installChannelSearch(page) {
  const requests = [];
  await page.route(`${API}/api/reporting/search**`, (route) => {
    const params = Object.fromEntries(new URL(route.request().url()).searchParams.entries());
    requests.push(params);
    const types = String(params.types ?? '').split(',').filter(Boolean);
    const matches = records.filter((record) => `${record.title} ${record.content}`.toLowerCase().includes(String(params.query ?? '').toLowerCase()) && (!types.length || types.includes(record.documentType)));
    return route.fulfill({ contentType: 'application/json', json: { facetCounts: {}, indexedFreshness: at, limit: 20, offset: 0, records: matches, total: matches.length } });
  });
  return requests;
}

async function expectNoSeriousAxe(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('#main-content').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
}

test('search groups channels, posts and channel files, names the engagement, and links into the channel', async ({ page }, testInfo) => {
  const api = await installSyntheticApi(page);
  const requests = await installChannelSearch(page);
  await authenticateSyntheticUser(page);
  await page.goto('search?q=pricing');

  const main = page.getByRole('main');
  await expect(main.getByRole('status')).toHaveText('3 results for “pricing”');
  await expect(main.getByRole('heading', { level: 2 })).toHaveText([/Channels & posts/, /Files/]);

  const channelsGroup = main.getByRole('region', { name: /Channels & posts/ });
  const post = channelsGroup.getByRole('listitem').filter({ hasText: 'Sal Seller in #General' });
  await expect(post.getByRole('link', { name: 'Sal Seller in #General' })).toHaveAttribute('href', `/app/engagements/${ENGAGEMENT.id}/channels?channel=channel-e1&post=post-1`);
  await expect(post).toContainText('Post');
  await expect(post).toContainText(ENGAGEMENT.name);
  await expect(channelsGroup.getByRole('link', { name: '#Pricing' })).toHaveAttribute('href', `/app/projects/${syntheticProject.id}/channels?channel=channel-p1`);

  const file = main.getByRole('region', { name: /^Files/ }).getByRole('listitem');
  await expect(file.getByRole('link', { name: 'pricing-model.xlsx' })).toHaveAttribute('href', `/app/projects/${syntheticProject.id}/channels?channel=channel-p1&tab=files&file=file-1`);
  await expect(file).toContainText(syntheticProject.name);
  await expect(file).toContainText('Pricing');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expectNoSeriousAxe(page, testInfo, 'channel-search-light');
  await testInfo.attach('channel-search.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expectNoSeriousAxe(page, testInfo, 'channel-search-dark');
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  await main.getByLabel('Type').selectOption({ label: 'Files' });
  await expect(page).toHaveURL(/type=files/);
  await expect(main.getByRole('status')).toHaveText('1 result for “pricing”');
  expect(requests.at(-1)).toMatchObject({ query: 'pricing', types: 'file' });
  await main.getByLabel('Type').selectOption({ label: 'Channels & posts' });
  await expect(main.getByRole('status')).toHaveText('2 results for “pricing”');
  expect(requests.at(-1)).toMatchObject({ types: 'channel,post' });
  api.assertNoUnexpectedRequests();
});
