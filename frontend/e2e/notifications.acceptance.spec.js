import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { settleForAxe } from './fixtures/axe-settle.js';
import { installNotificationsApi, sampleNotification } from './fixtures/notifications-api.js';
import { authenticateSyntheticUser, installSyntheticApi, syntheticProject } from './fixtures/synthetic-api.js';

// The bell in Odin proper's top bar (docs/odin-chat/plan.md, Delivery; AC-N03 with a simulated
// stream event): the unread count on the bell and in the tab title, the list newest first under
// by project or engagement with collapsible groups, opening one, marking all read, and the settings link. Screenshots of the
// open bell are attached for desktop and phone.

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21aa'];
const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString();

async function expectNoSeriousAxe(page, testInfo, name) {
  await settleForAxe(page);
  const results = await new AxeBuilder({ page }).include('.notification-bell').withTags(wcagTags).analyze();
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.violations.filter(({ impact }) => ['critical', 'serious'].includes(impact))).toEqual([]);
}

test('the bell counts unread notifications live, groups them by project, opens one and marks all read', async ({ page }, testInfo) => {
  const api = await installSyntheticApi(page);
  const bellApi = await installNotificationsApi(page, {
    notifications: [
      sampleNotification({ count: 3, excerpt: 'Mo Member: Agenda for Friday', id: 'n-watched', kind: 'channel_post', title: '3 new posts in #General' }),
      sampleNotification({ createdAt: yesterday, excerpt: 'Draft the SOW', id: 'n-task', kind: 'task_assigned', path: `/projects/${syntheticProject.id}`, projectId: 'project-northwind', projectName: 'Northwind rollout', readAt: yesterday, title: 'Lena Lead assigned you an epic', updatedAt: yesterday }),
      sampleNotification({ channelId: null, createdAt: yesterday, excerpt: 'Odin is updated', id: 'n-system', kind: 'system', projectId: null, projectName: '', readAt: yesterday, title: 'Odin was updated', updatedAt: yesterday }),
    ],
  });
  await authenticateSyntheticUser(page);

  const bell = page.getByRole('button', { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName('Notifications, 1 unread');
  await expect(page).toHaveTitle('(1) OdinPMP');

  // A mention arrives on the live stream: the count and the title follow without a reload.
  bellApi.add(sampleNotification({ id: 'n-mention' }));
  await expect(bell).toHaveAccessibleName('Notifications, 2 unread', { timeout: 5000 });
  await expect(page).toHaveTitle('(2) OdinPMP');

  await bell.click();
  const menu = page.locator('.notification-bell__menu');
  await expect(menu).toBeVisible();
  // One group per project or engagement, newest first; anything without a project under System, last.
  await expect(menu.getByRole('heading', { level: 3 })).toHaveText(['Synthetic Project2 unread', 'Northwind rollout', 'System']);
  const synthetic = menu.getByRole('region', { name: /^Synthetic Project/ });
  const syntheticItems = synthetic.getByRole('listitem').getByRole('button');
  await expect(syntheticItems).toHaveCount(2);
  await expect(syntheticItems.first()).toContainText('Lena Lead mentioned you in #General');
  await expect(syntheticItems.first()).toContainText('unread');
  await expect(menu.getByRole('region', { name: 'Northwind rollout' })).toContainText('Lena Lead assigned you an epic');

  // A group collapses, keeps its unread count in view, and stays collapsed after the menu reopens.
  const syntheticToggle = synthetic.getByRole('button', { name: /^Synthetic Project/ });
  await syntheticToggle.click();
  await expect(syntheticToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(syntheticItems.first()).toBeHidden();
  await expect(syntheticToggle).toContainText('2');
  await bell.click();
  await bell.click();
  await expect(menu.getByRole('button', { name: /^Synthetic Project/ })).toHaveAttribute('aria-expanded', 'false');
  await menu.getByRole('button', { name: /^Synthetic Project/ }).click();
  await expect(syntheticItems.first()).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Notification settings' })).toHaveAttribute('href', '/app/user?tab=notifications');
  await expect(menu.getByRole('button', { name: /on this device/ })).toHaveCount(0, { timeout: 1000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  await expectNoSeriousAxe(page, testInfo, 'bell-light');
  await page.screenshot({ path: testInfo.outputPath('bell-open.png') });
  await testInfo.attach('bell-open.png', { contentType: 'image/png', path: testInfo.outputPath('bell-open.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expectNoSeriousAxe(page, testInfo, 'bell-dark');
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  // Opening the task reads nothing new (it was read) and goes to its project.
  await menu.getByRole('region', { name: 'Northwind rollout' }).getByRole('listitem').getByRole('button').click();
  await expect(page).toHaveURL(new RegExp(`/app/projects/${syntheticProject.id}$`));
  await expect(menu).toBeHidden();
  expect(bellApi.state.reads).toEqual([]);

  // Mark all read clears the count, the title and every unread mark.
  await bell.click();
  await menu.getByRole('button', { name: 'Mark all read' }).click();
  await expect(bell).toHaveAccessibleName('Notifications');
  await expect(page).toHaveTitle('OdinPMP');
  await expect(menu.getByText('unread')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  expect(bellApi.state.reads).toEqual([{ all: true }]);

  // Escape closes the menu and returns to the bell.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  api.assertNoUnexpectedRequests();
});

test('opening an unread notification reads it', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const bellApi = await installNotificationsApi(page, { notifications: [sampleNotification({ id: 'n-one', path: `/projects/${syntheticProject.id}` })] });
  await authenticateSyntheticUser(page);
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await bell.click();
  await page.locator('.notification-bell__menu').getByRole('button', { name: /mentioned you/ }).click();
  await expect(page).toHaveURL(new RegExp(`/app/projects/${syntheticProject.id}$`));
  await expect(bell).toHaveAccessibleName('Notifications');
  expect(bellApi.state.reads).toEqual([{ ids: ['n-one'] }]);
  api.assertNoUnexpectedRequests();
});
